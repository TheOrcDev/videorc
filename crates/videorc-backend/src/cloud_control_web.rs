//! Web control (plan 234 D2, D8): the second kind of control transport.
//!
//! A show whose media runs on LiveKit Cloud has no node of ours to hold a
//! socket to. Its control is HTTPS routes on videorc.com, and its `state` is a
//! long-poll that answers with the shape the runner sent, plus a `rev`
//! beside it. The wire is `docs/cloud/managed-media-wire.md`, sections 2 and
//! 3; the constants both sides hold are pinned to
//! `protocol-fixtures/cloud-managed-wire.json`.
//!
//! What lives here:
//! - `WebControl`: one show's state poll. Its timings, its backoff, and what
//!   each answer means (section 3's table).
//! - `WebIntents`: an intent as its own HTTPS call, whose answer is its ack.
//!   There is no `hello`, `ack` or `ping`.
//! - `ControlLoop::run_web`: what the show does with each answer. A state is
//!   absorbed exactly as a socket frame is, so the status, the watchdog and
//!   the renderer see no difference.
//! - Talk shows (T3): the stage, End livestream and Record are routes too
//!   (2.3, 2.5, 2.6). Overlays are not: the host's renderer sends them to
//!   the room as byte streams (`cloud_talk.rs`, wire section 6.3).
//!
//! Stream keys: a destination URL crosses this module once, in the body of
//! `PUT …/destinations`, over TLS to the configured API base URL. It is
//! never logged and never part of an error: failures are worded from the
//! status and the code, and `DestinationsBody::scrub` blanks anything a
//! misbehaving answer echoes.

use std::collections::HashMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{StreamExt as _, TryStreamExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::cloud_show::{
    AckResult, CloudApiError, CloudWebApi, ControlConnector, ControlKind, ControlLoop,
    ControlRequest, HandoverDestination, HelloFailure, LoopExit, RECONNECT_BACKOFF_SECONDS,
    RunnerState, destinations_set_frame, install_control_loop, lock, new_intent_id, until,
};

/// `control.kind` of a show on web control (section 1). A create answer
/// without a kind means the node socket; any other value is a transport this
/// build does not know.
pub(crate) const CONTROL_KIND_WEB: &str = "web";
/// After a 200 the next poll starts this much later.
const STATE_POLL_REST: Duration = Duration::from_millis(250);
/// After a failed poll: 1, 2, 4, 8, then 15 s, reset by a 200. The socket's
/// reconnect backoff, by the contract's own reference.
const STATE_POLL_BACKOFF_SECONDS: [u64; 5] = RECONNECT_BACKOFF_SECONDS;
/// From this failed poll in a row on, `current` is asked after each one.
const ASK_CURRENT_FROM_FAILURE: usize = 2;
/// Section 2: after a network error or a 5xx a route is tried once more,
/// this much later. Never after a 4xx. Every route is safe to repeat.
const RETRY_DELAY: Duration = Duration::from_secs(1);
/// Section 8.4: a leg that asks for its address again gets it at most once
/// in this long.
const LEG_RESEND_SPACING: Duration = Duration::from_secs(30);
/// While a poll waits and the feed is up, how often the loop looks at the
/// feed's clock again: a feed that drops mid-poll must start the lost
/// report's 20 s then, not when a 25 s poll returns.
const FEED_CLOCK_LOOK: Duration = Duration::from_secs(1);
const CODE_SHOW_ENDED: &str = "cloud-show-ended";
const CODE_CONTROL_MISMATCH: &str = "cloud-control-mismatch";
/// Section 2.4: the hold-image route takes a PNG of at most this many
/// bytes and this many pixels a side. A node takes up to 8 MiB; the desktop
/// fits the image before it sends it here.
pub(crate) const HOLD_IMAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const HOLD_IMAGE_MAX_SIDE: u32 = 1920;
/// Scaled below this side, the image is not worth showing: the default
/// card stays.
const HOLD_IMAGE_MIN_SIDE: u32 = 16;
/// Section 6.4: what `cloud.return.set` answers on a show on web control.
pub(crate) const RETURN_UNAVAILABLE_MESSAGE: &str =
    "The program return is not available on this show.";

pub(crate) fn state_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/state")
}

pub(crate) fn destinations_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/destinations")
}

pub(crate) fn hold_image_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/hold-image")
}

pub(crate) fn stage_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/stage")
}

pub(crate) fn legs_end_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/legs/end")
}

pub(crate) fn recording_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/recording")
}

/// The query name of the state route's last-seen `rev`.
pub(crate) const STATE_SINCE_QUERY: &str = "since";

// --- Wire -----------------------------------------------------------------------

/// `GET …/state?since=<rev>` (section 3): the runner's `state`, unchanged,
/// with the show's `rev` beside it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStateAnswer {
    pub rev: u64,
    #[serde(default)]
    pub state: RunnerState,
}

/// The body of `PUT …/destinations` (section 2.2): `{ destinations[],
/// replace? }`, field for field the `destinations.set` frame. Every `url`
/// carries a stream key, so the value lives in memory for the one request
/// and `Debug` shows ids only.
#[derive(Clone, PartialEq, Eq)]
pub struct DestinationsBody(Value);

impl DestinationsBody {
    /// From a `destinations.set` frame. `replace` rides only when true, as
    /// on the socket.
    pub(crate) fn from_frame(frame: &Value) -> Option<Self> {
        let destinations = frame.get("destinations")?.as_array()?;
        let mut body = json!({ "destinations": destinations });
        if frame.get("replace").and_then(Value::as_bool) == Some(true) {
            body["replace"] = Value::Bool(true);
        }
        Some(Self(body))
    }

    /// The body of `POST …/legs/end` (section 2.3) from a `legs.end` frame:
    /// `{ destinations: [{ id, url }] }`, the list this computer holds, so
    /// the web can take each address off an egress that also records. A
    /// frame without a list (nothing was handed over) is an empty body.
    pub(crate) fn for_legs_end(frame: &Value) -> Self {
        match frame.get("destinations").and_then(Value::as_array) {
            Some(destinations) if !destinations.is_empty() => {
                Self(json!({ "destinations": destinations }))
            }
            _ => Self(json!({})),
        }
    }

    /// The JSON to send. It holds the keys: for the request body only.
    pub fn as_json(&self) -> &Value {
        &self.0
    }

    fn entries(&self) -> &[Value] {
        self.0["destinations"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn ids(&self) -> Vec<&str> {
        self.entries()
            .iter()
            .filter_map(|entry| entry["id"].as_str())
            .collect()
    }

    /// `text` with every address of this body blanked, and every key piece
    /// (the last path segment, with its query). Nothing the web answers is
    /// trusted not to echo the request.
    fn scrub(&self, text: &str) -> String {
        let mut scrubbed = text.to_string();
        for url in self
            .entries()
            .iter()
            .filter_map(|entry| entry["url"].as_str())
        {
            if url.is_empty() {
                continue;
            }
            scrubbed = scrubbed.replace(url, "••••");
            if let Some(key) = key_piece(url) {
                scrubbed = scrubbed.replace(key, "••••");
            }
        }
        scrubbed
    }
}

impl std::fmt::Debug for DestinationsBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DestinationsBody")
            .field("destinations", &self.ids())
            .field("replace", &self.0.get("replace").is_some())
            .finish()
    }
}

/// The key piece of a destination address (section 8.1): its last path
/// segment, with the query when there is one. Too short to be a key: none.
fn key_piece(url: &str) -> Option<&str> {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let (_, key) = path.rsplit_once('/')?;
    (key.len() >= 4).then_some(key)
}

/// The `destinations` a `legs.end` frame carries on web control: each
/// handed-over destination's id and address, and nothing else of it.
pub(crate) fn legs_end_destinations(destinations: &[HandoverDestination]) -> Value {
    Value::Array(
        destinations
            .iter()
            .map(|destination| json!({ "id": destination.id, "url": destination.url }))
            .collect(),
    )
}

/// `{ ok, rev }`: what a route that changes the show answers (sections
/// 2.3, 2.5 and 2.6).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlRevAnswer {
    #[serde(default)]
    pub rev: Option<u64>,
}

/// `PUT …/destinations` took the list. `refused` names the destinations the
/// guard turned down, by id and code; the others were applied.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationsAnswer {
    #[serde(default)]
    pub rev: Option<u64>,
    #[serde(default)]
    pub refused: Vec<RefusedDestination>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedDestination {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub code: String,
}

/// `PUT …/destinations` did not take the list: the error, and on a 422
/// (`cloud-destinations-refused`) the same `refused[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationsFailure {
    pub error: CloudApiError,
    pub refused: Vec<RefusedDestination>,
}

impl DestinationsFailure {
    /// From the failure's parsed body; `refused` is read leniently from the
    /// top level or from inside `error`.
    pub(crate) fn from_body(error: CloudApiError, body: &Value) -> Self {
        let refused = body
            .get("refused")
            .or_else(|| body.pointer("/error/refused"))
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<RefusedDestination>>(value).ok())
            .unwrap_or_default();
        Self { error, refused }
    }
}

// --- Failures in words ------------------------------------------------------------

/// A network error or a 5xx: worth the one retry, and never proof of
/// anything about the show.
fn retryable(error: &CloudApiError) -> bool {
    match error {
        CloudApiError::Transport(_)
        | CloudApiError::Disabled
        | CloudApiError::Full
        | CloudApiError::NodeUnreachable
        | CloudApiError::RoomsUnavailable => true,
        CloudApiError::Other { status, .. } => *status >= 500,
        _ => false,
    }
}

/// Provider RPCs have 25 s; Reconnect has 10 s. Keep three seconds
/// for dispatch and response delivery. Both attempts spend one deadline.
pub(crate) const CONTROL_INTENT_BUDGET: Duration = Duration::from_secs(22);
const RECONNECT_INTENT_BUDGET: Duration = Duration::from_secs(7);
const MIN_USEFUL_RETRY: Duration = Duration::from_secs(2);

pub(crate) async fn with_one_retry<T, E, F, Fut>(
    deadline: tokio::time::Instant,
    mut call: F,
    retryable: impl Fn(&E) -> bool,
    timed_out: impl Fn() -> E,
) -> std::result::Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    let first = tokio::time::timeout_at(deadline, call())
        .await
        .map_err(|_| timed_out())?;
    match first {
        Err(error)
            if retryable(&error)
                && deadline.saturating_duration_since(tokio::time::Instant::now())
                    >= RETRY_DELAY + MIN_USEFUL_RETRY =>
        {
            tokio::time::sleep(RETRY_DELAY).await;
            tokio::time::timeout_at(deadline, call())
                .await
                .map_err(|_| timed_out())?
        }
        answer => answer,
    }
}

fn intent_timeout() -> CloudApiError {
    CloudApiError::Transport("The cloud request timed out. Try again.".to_string())
}

pub(crate) async fn with_one_cloud_retry<T, F, Fut>(
    call: F,
) -> std::result::Result<T, CloudApiError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, CloudApiError>>,
{
    with_one_cloud_retry_until(tokio::time::Instant::now() + CONTROL_INTENT_BUDGET, call).await
}

pub(crate) async fn with_one_cloud_retry_until<T, F, Fut>(
    deadline: tokio::time::Instant,
    call: F,
) -> std::result::Result<T, CloudApiError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, CloudApiError>>,
{
    with_one_retry(deadline, call, retryable, intent_timeout).await
}

/// A failure as one line, from its status and code. The web's own `message`
/// is left out on purpose: this line reaches logs and error strings.
fn failure_line(error: &CloudApiError) -> String {
    match error {
        CloudApiError::Other { status, code, .. } => {
            format!("videorc.com answered {status} {code}")
        }
        other => other.to_string(),
    }
}

fn destinations_problem(failure: &DestinationsFailure) -> String {
    let mut codes: Vec<&str> = failure
        .refused
        .iter()
        .map(|refused| refused.code.as_str())
        .filter(|code| !code.is_empty())
        .collect();
    codes.sort_unstable();
    codes.dedup();
    let line = failure_line(&failure.error);
    if codes.is_empty() {
        line
    } else {
        format!("{line} ({})", codes.join(", "))
    }
}

/// A refused `POST …/recording` in the node path's words: the runner acks
/// `recording.start` with its `problem`, and the desktop says "did not
/// start the recording: {problem}" (wire section 2.6).
fn recording_problem(error: &CloudApiError) -> String {
    match error {
        CloudApiError::Other {
            status: 409, code, ..
        } => match code.as_str() {
            "cloud-recording-no-target" => "no-target".to_string(),
            "cloud-recording-solo" => "the cloud recording is for talk shows".to_string(),
            "cloud-recording-on-air" => {
                "the recording shares the livestream's output; end the livestream first".to_string()
            }
            _ => failure_line(error),
        },
        _ => failure_line(error),
    }
}

/// A refused `POST …/legs/end` in the runner's words for the same case.
fn legs_end_problem(error: &CloudApiError) -> String {
    match error {
        CloudApiError::Other {
            status: 409, code, ..
        } if code == "cloud-legs-end-solo" => {
            "legs.end is for talk shows; a solo show ends with show.end".to_string()
        }
        _ => failure_line(error),
    }
}

fn refused_line(refused: &[RefusedDestination]) -> String {
    refused
        .iter()
        .map(|refused| format!("{} ({})", refused.id, refused.code))
        .collect::<Vec<_>>()
        .join(", ")
}

// --- The hold image -------------------------------------------------------------

fn hold_image_dimensions(png: &[u8]) -> Result<(u32, u32)> {
    image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png)
        .into_dimensions()
        .context("The hold image is not a readable PNG.")
}

/// The hold image as the route takes it (section 2.4). A PNG already inside
/// both limits goes as it is, byte for byte. A larger one is scaled down,
/// keeping its shape: first to the side limit, then, while its PNG is still
/// too many bytes, by the share it is over.
pub(crate) fn fit_hold_image(png: Vec<u8>, max_side: u32, max_bytes: usize) -> Result<Vec<u8>> {
    let (width, height) = hold_image_dimensions(&png)?;
    let longest = width.max(height);
    if longest <= max_side && png.len() <= max_bytes {
        return Ok(png);
    }
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .context("The hold image did not decode.")?;
    let mut side = longest.min(max_side);
    loop {
        let scaled;
        let fitted = if side < longest {
            scaled = decoded.resize(side, side, image::imageops::FilterType::CatmullRom);
            &scaled
        } else {
            &decoded
        };
        let mut out = std::io::Cursor::new(Vec::new());
        fitted
            .write_to(&mut out, image::ImageFormat::Png)
            .context("The hold image could not be re-encoded as PNG.")?;
        let encoded = out.into_inner();
        if encoded.len() <= max_bytes {
            return Ok(encoded);
        }
        // A PNG's bytes follow its pixels closely enough: aim a tenth under
        // the limit, and always shrink.
        let share = (max_bytes as f64 / encoded.len() as f64).sqrt() * 0.9;
        let next = ((f64::from(side) * share) as u32).min(side.saturating_sub(1));
        if next < HOLD_IMAGE_MIN_SIDE {
            bail!("The hold image does not fit in {max_bytes} bytes.");
        }
        side = next;
    }
}

/// `fit_hold_image` around the base64 the show holds. An image that already
/// fits is not touched; scaling one runs off the async threads.
async fn fit_hold_image_base64(png_base64: &str) -> Result<String> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;
    let png = engine
        .decode(png_base64)
        .context("The hold image is not base64.")?;
    let (width, height) = hold_image_dimensions(&png)?;
    if width.max(height) <= HOLD_IMAGE_MAX_SIDE && png.len() <= HOLD_IMAGE_MAX_BYTES {
        return Ok(png_base64.to_string());
    }
    let before = png.len();
    let fitted = tokio::task::spawn_blocking(move || {
        fit_hold_image(png, HOLD_IMAGE_MAX_SIDE, HOLD_IMAGE_MAX_BYTES)
    })
    .await
    .context("The hold image task stopped.")??;
    tracing::info!(
        "The hold image was scaled for Videorc Cloud: {width}x{height}, {before} bytes to {} bytes",
        fitted.len()
    );
    Ok(engine.encode(fitted))
}

// --- Cloud recordings (wire section 13.2) ----------------------------------------
//
// A managed talk show records as HLS segments in the show's own storage,
// and the desktop makes the MP4 (D10): it asks for the take's playlist,
// whose segment lines are presigned URLs, and remuxes it with the app's own
// FFmpeg, `-c copy`. A node recording is an MP4 already and is not handled
// here: it downloads from the account page on videorc.com, as before.
//
// A presigned URL is a secret for six hours. The playlist is written to one
// temporary file that only this user can read, is handed to FFmpeg by
// path, and is removed when the remux ends, however it ends. No URL is
// logged or put in an error: FFmpeg's own words are scrubbed first.

pub(crate) const RECORDINGS_PATH: &str = "/api/cloud/recordings";

pub(crate) fn recording_playlist_path(recording_id: &str) -> String {
    format!("/api/cloud/recordings/{recording_id}/playlist")
}

/// `format` of a recording that is segments and a playlist.
pub(crate) const RECORDING_FORMAT_SEGMENTS: &str = "segments";
/// What FFmpeg may open while it reads the playlist: the local file, and
/// HTTPS for the segments. Nothing else: no plain HTTP, no other scheme.
pub(crate) const REMUX_PROTOCOL_WHITELIST: &str = "file";

/// One item of `GET /api/cloud/recordings`, as the desktop keeps it: the
/// facts, and no URL of any kind.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingItem {
    pub id: String,
    #[serde(default)]
    pub show_id: String,
    /// `h` or `v`.
    #[serde(default)]
    pub orientation: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub seconds: f64,
    #[serde(default)]
    pub bytes: f64,
    /// `segments` (a managed recording, made into an MP4 here) or `mp4` (a
    /// node recording). Absent from a web older than the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

impl CloudRecordingItem {
    pub(crate) fn is_segments(&self) -> bool {
        self.format.as_deref() == Some(RECORDING_FORMAT_SEGMENTS)
    }

    /// The web's own name for the file (`talk-2026-11-08-1204-h.mp4`), built
    /// only from digits it can check: nothing of the answer reaches a path
    /// unchecked.
    pub(crate) fn file_name(&self) -> String {
        let orientation = if self.orientation == "v" { "v" } else { "h" };
        match file_stamp(&self.started_at) {
            Some(stamp) => format!("talk-{stamp}-{orientation}.mp4"),
            None => format!("talk-{orientation}.mp4"),
        }
    }
}

/// `2026-11-08-1204` from `2026-11-08T12:04:…`, or nothing when the instant
/// is not that shape.
fn file_stamp(started_at: &str) -> Option<String> {
    let digits = |range: std::ops::Range<usize>| -> Option<&str> {
        let text = started_at.get(range)?;
        text.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then_some(text)
    };
    let dashes = started_at.get(4..5)? == "-" && started_at.get(7..8)? == "-";
    if !dashes {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}{}",
        digits(0..4)?,
        digits(5..7)?,
        digits(8..10)?,
        digits(11..13)?,
        digits(14..16)?
    ))
}

/// `GET /api/cloud/recordings`: `{ recordings: [...] }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingsAnswer {
    #[serde(default)]
    pub recordings: Vec<CloudRecordingItem>,
}

/// `cloud.recordings.download { id, outputDirectory?, ffmpegPath? }`: the
/// folder is Output's "Where recordings go", as a session start passes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingDownloadParams {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
}

/// `cloud.recordings.download`'s immediate answer: the job to follow.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingDownload {
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRecordingDownloadParams {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingDownloadEvent {
    pub job_id: String,
    pub recording_id: String,
    pub state: DownloadState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_segments: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_segments: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(crate) type DownloadEventHook = Arc<dyn Fn(RecordingDownloadEvent) + Send + Sync>;
type DownloadProgress = Arc<dyn Fn(usize, usize) + Send + Sync>;

pub(crate) struct DownloadControl {
    pub(crate) job_id: String,
    pub(crate) cancelled: watch::Receiver<bool>,
    pub(crate) progress: DownloadProgress,
}

struct RunningDownload {
    job_id: String,
    cancel: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct DownloadJobsState {
    closing: bool,
    running: HashMap<String, RunningDownload>,
}

#[derive(Default)]
pub(crate) struct RecordingDownloadJobs(std::sync::Mutex<DownloadJobsState>);

impl RecordingDownloadJobs {
    fn start<F, Fut>(
        self: &Arc<Self>,
        recording_id: String,
        emit: DownloadEventHook,
        work: F,
    ) -> Result<CloudRecordingDownload>
    where
        F: FnOnce(DownloadControl) -> Fut + Send + 'static,
        Fut: Future<Output = Result<PathBuf>> + Send + 'static,
    {
        let mut jobs = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if jobs.closing {
            bail!("Videorc is quitting.");
        }
        if let Some(job) = jobs.running.get(&recording_id) {
            return Ok(CloudRecordingDownload {
                job_id: job.job_id.clone(),
            });
        }
        let job_id = uuid::Uuid::new_v4().to_string();
        let answer = CloudRecordingDownload {
            job_id: job_id.clone(),
        };
        let (cancel, cancelled) = watch::channel(false);
        let registry = self.clone();
        let key = recording_id.clone();
        let task_key = key.clone();
        let task = tokio::spawn(async move {
            use futures_util::FutureExt as _;
            let event = RecordingDownloadEvent {
                job_id,
                recording_id,
                state: DownloadState::Running,
                done_segments: Some(0),
                total_segments: None,
                path: None,
                error: None,
            };
            emit(event.clone());
            let progress: DownloadProgress = {
                let emit = emit.clone();
                let event = event.clone();
                let last = std::sync::Mutex::new(None::<std::time::Instant>);
                Arc::new(move |done, total| {
                    let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    let now = std::time::Instant::now();
                    if last.is_some_and(|at| now.duration_since(at) < Duration::from_millis(300)) {
                        return;
                    }
                    *last = Some(now);
                    emit(RecordingDownloadEvent {
                        done_segments: Some(done),
                        total_segments: Some(total),
                        ..event.clone()
                    });
                })
            };
            let outcome = std::panic::AssertUnwindSafe(work(DownloadControl {
                job_id: event.job_id.clone(),
                cancelled: cancelled.clone(),
                progress,
            }))
            .catch_unwind()
            .await;
            let (state, path, error) = match outcome {
                Ok(Ok(path)) => (
                    DownloadState::Done,
                    Some(path.to_string_lossy().into_owned()),
                    None,
                ),
                Ok(Err(_)) if *cancelled.borrow() => (DownloadState::Cancelled, None, None),
                Ok(Err(error)) => (
                    DownloadState::Failed,
                    None,
                    Some(error.to_string().chars().take(4096).collect()),
                ),
                Err(_) => (
                    DownloadState::Failed,
                    None,
                    Some("The recording download stopped. Try again.".to_string()),
                ),
            };
            emit(RecordingDownloadEvent {
                state,
                path,
                error,
                done_segments: None,
                total_segments: None,
                ..event
            });
            registry
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .running
                .remove(&task_key);
        });
        jobs.running.insert(
            key,
            RunningDownload {
                job_id: answer.job_id.clone(),
                cancel,
                task,
            },
        );
        Ok(answer)
    }

    pub(crate) fn cancel(&self, job_id: &str) {
        let jobs = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(job) = jobs.running.values().find(|job| job.job_id == job_id) {
            let _ = job.cancel.send(true);
        }
    }

    pub(crate) async fn shutdown(&self) {
        let jobs = {
            let mut state = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.closing = true;
            state
                .running
                .drain()
                .map(|(_, job)| job)
                .collect::<Vec<_>>()
        };
        for job in &jobs {
            let _ = job.cancel.send(true);
        }
        for job in jobs {
            let _ = job.task.await;
        }
    }
}

/// What a remux run came to.
pub(crate) struct RemuxOutcome {
    pub success: bool,
    pub stderr: String,
}

/// FFmpeg's arguments for the remux: the playlist by path (never a URL on a
/// command line), streams copied, the index moved to the front. `-y`: the
/// output is an owned part file; its MP4 format is explicit despite `.part`.
pub(crate) fn remux_args(playlist: &Path, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        REMUX_PROTOCOL_WHITELIST,
        "-i",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(crate::ffmpeg::ffmpeg_path_arg(playlist));
    args.extend(
        ["-c", "copy", "-movflags", "+faststart", "-f", "mp4"]
            .iter()
            .map(OsString::from),
    );
    args.push(crate::ffmpeg::ffmpeg_path_arg(output));
    args
}

/// The app's FFmpeg on those arguments. Killed with its future.
pub(crate) async fn run_ffmpeg_remux(
    ffmpeg: String,
    args: Vec<OsString>,
    mut cancelled: watch::Receiver<bool>,
) -> std::io::Result<RemuxOutcome> {
    use tokio::io::AsyncReadExt as _;
    let mut child = tokio::process::Command::new(ffmpeg)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let read = async move {
        let mut tail = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let n = stderr.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..n]);
            if tail.len() > 8192 {
                tail.drain(..tail.len() - 8192);
            }
        }
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&tail).into_owned())
    };
    let outcome = {
        let output = async {
            let (status, stderr) = tokio::try_join!(child.wait(), read)?;
            Ok(RemuxOutcome {
                success: status.success(),
                stderr,
            })
        };
        tokio::select! {
            outcome = output => Some(outcome),
            _ = crate::cloud_show::wait_canceled(&mut cancelled) => None,
        }
    };
    if let Some(outcome) = outcome {
        return outcome;
    }
    // Drop the pipe reader before cancelling, so a failed kill or reap can
    // never leave shutdown waiting indefinitely for a stderr EOF.
    child.start_kill()?;
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(std::io::Error::other)??;
    Err(std::io::Error::new(
        std::io::ErrorKind::Interrupted,
        "Download cancelled.",
    ))
}

/// `text` with every URL blanked: FFmpeg names what it could not open, and
/// what it could not open is a presigned URL.
pub(crate) fn scrub_urls(text: &str) -> String {
    let mut scrubbed = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        // Back to the start of the scheme, forward to the end of the URL.
        let scheme_start = rest[..at]
            .char_indices()
            .rev()
            .find(|(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
            .map_or(0, |(index, c)| index + c.len_utf8());
        let after = &rest[at + 3..];
        let end = after
            .find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>'))
            .unwrap_or(after.len());
        scrubbed.push_str(&rest[..scheme_start]);
        scrubbed.push_str("(address withheld)");
        rest = &after[end..];
    }
    scrubbed.push_str(rest);
    scrubbed
}

/// A private scratch directory. The guard also covers unwinding and cancellation.
struct TemporaryRecordingDirectory(PathBuf);

const RECORDING_TEMP_PREFIX: &str = "videorc-cloud-download-";

impl TemporaryRecordingDirectory {
    fn create() -> std::io::Result<Self> {
        Self::create_in(&std::env::temp_dir())
    }

    fn create_in(root: &Path) -> std::io::Result<Self> {
        remove_stale_recording_downloads(root, std::time::SystemTime::now());
        let path = root.join(format!("{RECORDING_TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}

impl Drop for TemporaryRecordingDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn remove_stale_recording_downloads(root: &Path, now: std::time::SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix(RECORDING_TEMP_PREFIX))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir()
            && metadata
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60))
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Deliberately carries no request or URL, including on TLS failures.
#[derive(Debug)]
pub enum SegmentFetchError {
    Network,
    Storage(std::io::Error),
}

const RECORDING_DISK_FULL: &str = "There isn't enough space to save the recording.";

fn storage_problem(error: &std::io::Error) -> &'static str {
    if error.raw_os_error() == Some(libc::ENOSPC) {
        RECORDING_DISK_FULL
    } else {
        "The recording could not be saved. Check the folder and available space."
    }
}

fn remux_problem(stderr: &str) -> String {
    if stderr
        .to_ascii_lowercase()
        .contains("no space left on device")
    {
        return RECORDING_DISK_FULL.to_string();
    }
    let said = scrub_urls(stderr.trim());
    let said = said.lines().rev().take(3).collect::<Vec<_>>();
    let said = said.into_iter().rev().collect::<Vec<_>>().join(" | ");
    format!("FFmpeg could not make the MP4: {said}")
}

/// Accept a media playlist only. Unknown URI-bearing tags (keys, maps,
/// nested playlists, etc.) never reach FFmpeg. No presigned URL goes to disk.
fn local_recording_playlist(playlist: &str) -> Result<(String, Vec<String>)> {
    if !playlist.trim_start().starts_with("#EXTM3U") {
        bail!("videorc.com did not answer with the recording's playlist.");
    }
    let mut local = String::new();
    let mut segments = Vec::new();
    for line in playlist
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.starts_with('#') {
            let tag = line.split(':').next().unwrap_or_default();
            if !matches!(
                tag,
                "#EXTM3U"
                    | "#EXT-X-VERSION"
                    | "#EXT-X-TARGETDURATION"
                    | "#EXT-X-MEDIA-SEQUENCE"
                    | "#EXTINF"
                    | "#EXT-X-ENDLIST"
                    | "#EXT-X-DISCONTINUITY"
                    | "#EXT-X-PROGRAM-DATE-TIME"
                    | "#EXT-X-INDEPENDENT-SEGMENTS"
            ) || line.contains("://")
                || line.contains("URI=")
            {
                bail!("The recording's playlist is not supported.");
            }
            local.push_str(line);
        } else {
            let valid = reqwest::Url::parse(line).ok().is_some_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            });
            if !valid {
                bail!("The recording's playlist is not supported.");
            }
            local.push_str(&segment_name(segments.len()));
            segments.push(line.to_string());
        }
        local.push('\n');
    }
    if segments.is_empty() {
        bail!("The recording's playlist has no segments.");
    }
    Ok((local, segments))
}

fn segment_name(index: usize) -> String {
    format!("segment-{index:06}.ts")
}

async fn fetch_recording_segments<W: CloudWebApi>(
    web: &W,
    segments: Vec<String>,
    folder: &Path,
    progress: &DownloadProgress,
) -> Result<()> {
    let total = segments.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    progress(0, total);
    futures_util::stream::iter(segments.into_iter().enumerate().map(|(index, url)| {
        let done = &done;
        async move {
            let path = folder.join(segment_name(index));
            for attempt in 0..3 {
                match web.recording_segment(&url, &path).await {
                    Ok(()) => {
                        progress(done.fetch_add(1, Ordering::SeqCst) + 1, total);
                        return Ok(());
                    }
                    Err(SegmentFetchError::Storage(error)) => {
                        bail!("{}", storage_problem(&error))
                    }
                    Err(SegmentFetchError::Network) if attempt < 2 => {
                        tokio::time::sleep(RETRY_DELAY).await
                    }
                    Err(SegmentFetchError::Network) => {
                        bail!("Recording segment {index} could not be downloaded.")
                    }
                }
            }
            unreachable!()
        }
    }))
    .buffer_unordered(4)
    .try_collect::<Vec<_>>()
    .await?;
    Ok(())
}

async fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt as _;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(contents).await?;
    file.flush().await
}

/// Every cleanup path owns exactly one create-new file. The final name is
/// claimed only after the remux has succeeded, under the same rule.
struct OwnedDownloadFile(Option<PathBuf>);

impl OwnedDownloadFile {
    fn create(path: PathBuf) -> std::io::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        options.open(&path)?;
        Ok(Self(Some(path)))
    }

    fn path(&self) -> &Path {
        self.0.as_deref().expect("owned file")
    }

    fn part(folder: &Path, name: &str, job_id: &str) -> std::io::Result<Self> {
        Self::create(folder.join(format!(".{name}.{job_id}.part")))
    }

    fn finish(mut self, folder: &Path, name: &str) -> std::io::Result<PathBuf> {
        let (stem, extension) = name.rsplit_once('.').unwrap_or((name, "mp4"));
        for n in 1.. {
            let candidate = if n == 1 {
                folder.join(name)
            } else {
                folder.join(format!("{stem} ({n}).{extension}"))
            };
            let mut claim = match Self::create(candidate.clone()) {
                Ok(claim) => claim,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            };
            std::fs::rename(self.path(), &candidate)?;
            self.0 = None;
            claim.0 = None;
            return Ok(candidate);
        }
        unreachable!()
    }
}

impl Drop for OwnedDownloadFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A managed recording as an MP4 in `folder`: the playlist fetched, written
/// to a private temporary file, remuxed by `remux` (the app's FFmpeg; a
/// stand-in under test), and the temporary file removed. Returns where the
/// MP4 is. A failed remux leaves no half-written MP4 behind.
async fn download_segments_recording_with_progress<W, R, Fut>(
    web: &W,
    bearer: &str,
    recording: &CloudRecordingItem,
    folder: &Path,
    control: DownloadControl,
    remux: R,
) -> Result<PathBuf>
where
    W: CloudWebApi,
    R: FnOnce(Vec<OsString>) -> Fut,
    Fut: Future<Output = std::io::Result<RemuxOutcome>>,
{
    let DownloadControl {
        job_id,
        mut cancelled,
        progress,
    } = control;
    // The route's one retry (section 2): a storage hiccup answers 503.
    let playlist = tokio::select! {
        answer = with_one_cloud_retry(|| web.recording_playlist(bearer, &recording.id)) => answer.map_err(|error| anyhow::anyhow!("{}", failure_line(&error)))?,
        _ = crate::cloud_show::wait_canceled(&mut cancelled) => bail!("Download cancelled."),
    };
    let (local_playlist, segments) = local_recording_playlist(&playlist)?;
    drop(playlist);
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|error| anyhow::anyhow!(storage_problem(&error)))?;
    let temporary = TemporaryRecordingDirectory::create()
        .map_err(|error| anyhow::anyhow!(storage_problem(&error)))?;
    tokio::select! {
        answer = fetch_recording_segments(web, segments, &temporary.0, &progress) => answer?,
        _ = crate::cloud_show::wait_canceled(&mut cancelled) => bail!("Download cancelled."),
    }
    let playlist_path = temporary.0.join("index.m3u8");
    write_private_file(&playlist_path, local_playlist.as_bytes())
        .await
        .map_err(|error| anyhow::anyhow!(storage_problem(&error)))?;
    let part = OwnedDownloadFile::part(folder, &recording.file_name(), &job_id)
        .map_err(|error| anyhow::anyhow!(storage_problem(&error)))?;
    let outcome = remux(remux_args(&playlist_path, part.path())).await;
    drop(temporary);
    match outcome {
        Ok(outcome) if outcome.success => part
            .finish(folder, &recording.file_name())
            .map_err(|error| anyhow::anyhow!(storage_problem(&error))),
        Ok(outcome) => {
            bail!("{}", remux_problem(&outcome.stderr));
        }
        Err(error) => {
            bail!("FFmpeg could not be started: {error}");
        }
    }
}

#[cfg(test)]
pub(crate) async fn download_segments_recording<W, R, Fut>(
    web: &W,
    bearer: &str,
    recording: &CloudRecordingItem,
    folder: &Path,
    remux: R,
) -> Result<PathBuf>
where
    W: CloudWebApi,
    R: FnOnce(Vec<OsString>) -> Fut,
    Fut: Future<Output = std::io::Result<RemuxOutcome>>,
{
    let (_held, cancelled) = watch::channel(false);
    download_segments_recording_with_progress(
        web,
        bearer,
        recording,
        folder,
        DownloadControl {
            job_id: uuid::Uuid::new_v4().to_string(),
            cancelled,
            progress: Arc::new(|_, _| {}),
        },
        remux,
    )
    .await
}

impl<W: CloudWebApi, C: ControlConnector> crate::cloud_show::CloudShowContext<W, C> {
    /// `cloud.recordings.list`: the account's cloud recordings.
    pub async fn cloud_recordings(
        &self,
        bearer: Option<String>,
    ) -> Result<Vec<CloudRecordingItem>> {
        let Some(bearer) = bearer else {
            bail!("Sign in to see your cloud recordings.");
        };
        self.web
            .list_recordings(&bearer)
            .await
            .map_err(anyhow::Error::new)
    }

    /// Admission does no network or remux work on the ordered command lane.
    pub(crate) fn download_cloud_recording(
        &self,
        bearer: Option<String>,
        recording_id: &str,
        ffmpeg: String,
        folder: PathBuf,
        emit: DownloadEventHook,
    ) -> Result<CloudRecordingDownload> {
        if bearer.is_none() {
            bail!("Sign in to download your cloud recordings.");
        }
        let context = self.clone();
        let jobs = lock(&self.slot).downloads.clone();
        let recording_id = recording_id.to_string();
        jobs.start(recording_id.clone(), emit, move |control| async move {
            context
                .perform_cloud_recording_download(bearer, &recording_id, ffmpeg, folder, control)
                .await
        })
    }

    /// `cloud.recordings.download`: a managed recording as an MP4 in
    /// `folder`. A node recording is an MP4 on videorc.com already.
    pub(crate) async fn perform_cloud_recording_download(
        &self,
        bearer: Option<String>,
        recording_id: &str,
        ffmpeg: String,
        folder: PathBuf,
        mut control: DownloadControl,
    ) -> Result<PathBuf> {
        let Some(bearer) = bearer else {
            bail!("Sign in to download your cloud recordings.");
        };
        let recordings = tokio::select! {
            result = self.web.list_recordings(&bearer) => result.map_err(anyhow::Error::new)?,
            _ = crate::cloud_show::wait_canceled(&mut control.cancelled) => bail!("Download cancelled."),
        };
        let Some(recording) = recordings.iter().find(|item| item.id == recording_id) else {
            bail!("That recording is not in your account any more.");
        };
        if !recording.is_segments() {
            bail!("This recording downloads from your account on videorc.com.");
        }
        let remux_cancel = control.cancelled.clone();
        download_segments_recording_with_progress(
            self.web.as_ref(),
            &bearer,
            recording,
            &folder,
            control,
            |args| run_ffmpeg_remux(ffmpeg, args, remux_cancel),
        )
        .await
    }
}

/// One show's ordering barrier. An End invalidates retained lists before
/// waiting for an already-started PUT, then sends its stop after that PUT.
#[derive(Default)]
pub(crate) struct DestinationGeneration {
    value: AtomicU64,
    stopped: AtomicBool,
    sending: tokio::sync::Mutex<()>,
}

impl DestinationGeneration {
    pub(crate) fn current(&self) -> u64 {
        self.value.load(Ordering::SeqCst)
    }
    pub(crate) fn invalidate(&self) {
        self.value.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.invalidate();
    }
    fn accepts(&self, generation: u64) -> bool {
        !self.stopped.load(Ordering::SeqCst) && self.current() == generation
    }
    pub(crate) async fn stopping(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.sending.lock().await
    }
    pub(crate) fn stamp(&self, mut frame: Value) -> Value {
        // Only an explicit destinations intent can resume after End. Poll
        // recovery must not revive a retained list while End is in flight.
        self.stopped.store(false, Ordering::SeqCst);
        frame["_destinationGeneration"] = json!(self.current());
        frame
    }
}

// --- Intents ----------------------------------------------------------------------

/// An intent's answer, on its way.
type IntentAnswer = Pin<Box<dyn Future<Output = AckResult> + Send>>;

/// An intent as a call: the socket's frame in, the route's answer out.
pub(crate) type WebIntentCall = Arc<dyn Fn(Value) -> IntentAnswer + Send + Sync>;

/// A show's intents on web control, as the slot holds them. Each one is its
/// own HTTPS call on the caller's task, so no intent waits behind the state
/// poll, and the call's own timeout is the only one.
#[derive(Clone)]
pub(crate) struct WebIntents {
    call: WebIntentCall,
    /// Never sent on. The show's poll watches the other end and stops when
    /// the slot has let go of every handle.
    _held: mpsc::UnboundedSender<ControlRequest>,
}

impl WebIntents {
    pub(crate) async fn send(&self, frame: Value) -> AckResult {
        (self.call)(frame).await
    }

    /// Test support: both lead to the same show's control.
    #[cfg(test)]
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.call, &other.call)
    }
}

/// One intent on web control (section 2): the route that replaces the
/// socket's frame, and its answer as the ack.
async fn send_web_intent<W: CloudWebApi>(
    web: &W,
    bearer: &str,
    show_id: &str,
    floor: &AtomicU64,
    destinations: &DestinationGeneration,
    frame: Value,
) -> AckResult {
    let reconnect = frame["kind"] == "destinations.set" && frame["replace"] != true;
    let budget = if reconnect {
        RECONNECT_INTENT_BUDGET
    } else {
        CONTROL_INTENT_BUDGET
    };
    let deadline = tokio::time::Instant::now() + budget;
    tokio::time::timeout_at(
        deadline,
        send_web_intent_until(web, bearer, show_id, floor, destinations, frame, deadline),
    )
    .await
    .unwrap_or_else(|_| Err(failure_line(&intent_timeout())))
}

async fn send_web_intent_until<W: CloudWebApi>(
    web: &W,
    bearer: &str,
    show_id: &str,
    floor: &AtomicU64,
    destinations: &DestinationGeneration,
    frame: Value,
    deadline: tokio::time::Instant,
) -> AckResult {
    let kind = frame
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "destinations.set" => {
            let Some(body) = DestinationsBody::from_frame(&frame) else {
                return Err("the destinations could not be read".to_string());
            };
            let expected = frame["_destinationGeneration"]
                .as_u64()
                .unwrap_or_else(|| destinations.current());
            let answer = with_one_retry(
                deadline,
                || async {
                    let _sending = destinations.sending.lock().await;
                    if !destinations.accepts(expected) {
                        return Err(DestinationsFailure {
                            error: CloudApiError::Other {
                                status: 409,
                                code: "stale-destinations".to_string(),
                                message: String::new(),
                            },
                            refused: Vec::new(),
                        });
                    }
                    web.set_destinations(bearer, show_id, &body).await
                },
                |failure: &DestinationsFailure| retryable(&failure.error),
                || DestinationsFailure {
                    error: intent_timeout(),
                    refused: Vec::new(),
                },
            )
            .await;
            match answer {
                Ok(answer) => {
                    // Before the caller hears: a state older than this
                    // answer must not be read as the show's state.
                    if let Some(rev) = answer.rev {
                        floor.fetch_max(rev, Ordering::SeqCst);
                    }
                    if !answer.refused.is_empty() {
                        tracing::warn!(
                            show = show_id,
                            "Videorc Cloud refused {} of {} destinations: {}",
                            answer.refused.len(),
                            body.entries().len(),
                            body.scrub(&refused_line(&answer.refused))
                        );
                    }
                    Ok(None)
                }
                Err(failure) => Err(body.scrub(&destinations_problem(&failure))),
            }
        }
        "hold.image.set" => {
            let Some(png) = frame.get("pngBase64").and_then(Value::as_str) else {
                return Err("the hold image could not be read".to_string());
            };
            // Best effort, as on the socket: an image that cannot be made
            // to fit leaves the default card.
            let png = match fit_hold_image_base64(png).await {
                Ok(png) => png,
                Err(error) => return Err(format!("{error:#}")),
            };
            let png = png.as_str();
            with_one_cloud_retry_until(deadline, || web.set_hold_image(bearer, show_id, png))
                .await
                .map(|()| None)
                .map_err(|error| failure_line(&error))
        }
        // `POST …/end` is this intent's route, and every sender calls it
        // itself right after the intent (`end_current_show`, a failed
        // hand-over). Nothing is sent here, and nothing is confirmed.
        "show.end" => Err("a show on web control ends through videorc.com".to_string()),
        // Talk shows (T3). Each answer names the `rev` it produced, and
        // raises the floor as the destinations do.
        "stage.set" => {
            let mut stage = frame.clone();
            if let Some(fields) = stage.as_object_mut() {
                // The frame's fields and nothing of the frame itself.
                for socket_only in ["t", "id", "kind"] {
                    fields.remove(socket_only);
                }
            }
            with_one_cloud_retry_until(deadline, || web.set_stage(bearer, show_id, &stage))
                .await
                .map(|answer| raise_floor(floor, &answer))
                .map_err(|error| failure_line(&error))
        }
        "legs.end" => {
            let _stopping = destinations.stopping().await;
            let body = DestinationsBody::for_legs_end(&frame);
            with_one_cloud_retry_until(deadline, || web.end_legs(bearer, show_id, &body))
                .await
                .map(|answer| raise_floor(floor, &answer))
                .map_err(|error| body.scrub(&legs_end_problem(&error)))
        }
        "recording.start" | "recording.stop" => {
            let on = kind == "recording.start";
            with_one_cloud_retry_until(deadline, || web.set_recording(bearer, show_id, on))
                .await
                .map(|answer| raise_floor(floor, &answer))
                .map_err(|error| recording_problem(&error))
        }
        // `return.set` never gets here (`set_return` answers before any
        // intent, wire section 6.4), and overlays go to the room from the
        // renderer (6.3). Anything else has no route.
        other => {
            tracing::warn!(
                intent = other,
                show = show_id,
                "This intent has no route on web control; nothing was sent"
            );
            Err(format!("{other} is not available on this show"))
        }
    }
}

/// An answer's `rev` raises the floor before the caller hears of it: a
/// state older than the answer is not the show's any more.
fn raise_floor(floor: &AtomicU64, answer: &ControlRevAnswer) -> Option<Value> {
    if let Some(rev) = answer.rev {
        floor.fetch_max(rev, Ordering::SeqCst);
    }
    None
}

// --- The state poll -----------------------------------------------------------------

/// What one poll's answer means (section 3's table).
#[derive(Debug)]
pub(crate) enum WebPoll {
    /// 200: the show's state, to absorb exactly as a socket frame. Boxed:
    /// the state carries the program and the room.
    State { rev: u64, state: Box<RunnerState> },
    /// 200 with `phase: "ended"`, or 409 `cloud-show-ended`: the show is
    /// over, with the reason when the answer named one.
    Ended(Option<String>),
    /// 401: this computer's sign-in was refused. Polling stops.
    Unauthorized,
    /// 404: videorc.com does not know the show's state. `current` decides.
    NotFound,
    /// 409 `cloud-control-mismatch`: the show is not on web control.
    Mismatch,
    /// A 5xx, a timeout, a network error, or anything else: unknown. Never
    /// "gone".
    Failed(String),
}

fn read_state_answer(answer: std::result::Result<ControlStateAnswer, CloudApiError>) -> WebPoll {
    match answer {
        Ok(answer) if answer.state.phase == "ended" => WebPoll::Ended(answer.state.end_reason),
        Ok(answer) => WebPoll::State {
            rev: answer.rev,
            state: Box::new(answer.state),
        },
        Err(CloudApiError::Unauthorized) => WebPoll::Unauthorized,
        Err(CloudApiError::Other { status: 404, .. }) => WebPoll::NotFound,
        Err(CloudApiError::Other {
            status: 409, code, ..
        }) if code == CODE_SHOW_ENDED => WebPoll::Ended(None),
        Err(CloudApiError::Other {
            status: 409, code, ..
        }) if code == CODE_CONTROL_MISMATCH => WebPoll::Mismatch,
        Err(error) => WebPoll::Failed(failure_line(&error)),
    }
}

/// One show's control over videorc.com: its state long-poll and the way to
/// its intents.
pub(crate) struct WebControl<W: CloudWebApi> {
    web: Arc<W>,
    bearer: String,
    show_id: String,
    /// The last answer's `rev`: the next poll's `since`. None after a
    /// failed poll.
    since: Option<u64>,
    /// Failed polls in a row.
    failures: usize,
    /// When the next poll may start: the rest after an answer, the backoff
    /// after a failure.
    next_at: tokio::time::Instant,
    /// The highest `rev` an intent's answer named. A state below it was read
    /// before that intent took effect.
    floor: Arc<AtomicU64>,
    call: WebIntentCall,
}

impl<W: CloudWebApi> WebControl<W> {
    /// Connect or resume: the first state, asked without `since`, which the
    /// web answers at once. This is the socket's `welcome`.
    pub(crate) async fn open(
        web: Arc<W>,
        bearer: &str,
        show_id: &str,
        destinations: Arc<DestinationGeneration>,
    ) -> std::result::Result<(Self, RunnerState), HelloFailure> {
        let first = with_one_cloud_retry(|| web.control_state(bearer, show_id, None)).await;
        let (rev, state) = match read_state_answer(first) {
            WebPoll::State { rev, state } => (rev, *state),
            WebPoll::Ended(_) => return Err(HelloFailure::NoSuchShow),
            // Gone only when `current` says so too; otherwise unknown.
            WebPoll::NotFound => {
                return Err(match web.current_show(bearer).await {
                    Ok(current)
                        if current
                            .show
                            .as_ref()
                            .is_none_or(|show| show.id != show_id || show.is_ended()) =>
                    {
                        HelloFailure::NoSuchShow
                    }
                    _ => HelloFailure::Transport(
                        "videorc.com does not know the show's state".to_string(),
                    ),
                });
            }
            WebPoll::Unauthorized => {
                return Err(HelloFailure::Transport(
                    "videorc.com refused this computer's sign-in".to_string(),
                ));
            }
            WebPoll::Mismatch => {
                return Err(HelloFailure::Transport(
                    "videorc.com says this show is not on web control".to_string(),
                ));
            }
            WebPoll::Failed(problem) => return Err(HelloFailure::Transport(problem)),
        };
        let floor = Arc::new(AtomicU64::new(0));
        let call = intent_call(
            web.clone(),
            bearer.to_string(),
            show_id.to_string(),
            floor.clone(),
            destinations,
        );
        Ok((
            Self {
                web,
                bearer: bearer.to_string(),
                show_id: show_id.to_string(),
                since: Some(rev),
                failures: 0,
                next_at: tokio::time::Instant::now() + STATE_POLL_REST,
                floor,
                call,
            },
            state,
        ))
    }

    /// The show's intents for the slot. `held` is the sender whose other
    /// end the poll watches.
    pub(crate) fn intents(&self, held: mpsc::UnboundedSender<ControlRequest>) -> WebIntents {
        WebIntents {
            call: self.call.clone(),
            _held: held,
        }
    }

    /// One poll: waits out the rest or the backoff, asks, and reads the
    /// answer. Dropping it mid-way loses nothing: the next call asks again
    /// with the same `since`.
    pub(crate) async fn poll(&mut self) -> WebPoll {
        tokio::time::sleep_until(self.next_at).await;
        let answer = self
            .web
            .control_state(&self.bearer, &self.show_id, self.since)
            .await;
        let poll = read_state_answer(answer);
        let now = tokio::time::Instant::now();
        match &poll {
            WebPoll::State { rev, .. } => {
                self.since = Some(*rev);
                self.failures = 0;
                self.next_at = now + STATE_POLL_REST;
            }
            WebPoll::Ended(_) | WebPoll::Unauthorized => {}
            WebPoll::NotFound | WebPoll::Mismatch | WebPoll::Failed(_) => {
                // The next poll asks without `since`, which the web answers
                // at once: a reconnect's `welcome`. With the last `rev` it
                // would wait out the long-poll before saying it is back.
                self.since = None;
                self.failures += 1;
                let step = (self.failures - 1).min(STATE_POLL_BACKOFF_SECONDS.len() - 1);
                self.next_at = now + Duration::from_secs(STATE_POLL_BACKOFF_SECONDS[step]);
            }
        }
        poll
    }

    /// The next state of a show no loop owns (the test show, section 13.1),
    /// or why there is none. A failed poll backs off and asks again; the
    /// test's own deadline bounds it. A test show is never listed by
    /// `current`, so a 404 is its end.
    pub(crate) async fn next_state(&mut self) -> std::result::Result<RunnerState, String> {
        loop {
            match self.poll().await {
                WebPoll::State { state, .. } => return Ok(*state),
                WebPoll::Ended(end_reason) => {
                    return Ok(RunnerState {
                        phase: "ended".to_string(),
                        end_reason,
                        ..RunnerState::default()
                    });
                }
                WebPoll::Unauthorized => {
                    return Err("videorc.com refused this computer's sign-in".to_string());
                }
                WebPoll::NotFound => {
                    return Err("videorc.com no longer has the show".to_string());
                }
                WebPoll::Mismatch => {
                    return Err("videorc.com says this show is not on web control".to_string());
                }
                WebPoll::Failed(problem) => {
                    tracing::debug!("Videorc Cloud state poll failed: {problem}");
                }
            }
        }
    }

    /// A state with this `rev` was read before an intent this computer has
    /// had answered.
    fn is_stale(&self, rev: u64) -> bool {
        rev < self.floor.load(Ordering::SeqCst)
    }
}

fn intent_call<W: CloudWebApi>(
    web: Arc<W>,
    bearer: String,
    show_id: String,
    floor: Arc<AtomicU64>,
    destinations: Arc<DestinationGeneration>,
) -> WebIntentCall {
    Arc::new(move |frame: Value| -> IntentAnswer {
        let web = web.clone();
        let bearer = bearer.clone();
        let show_id = show_id.clone();
        let floor = floor.clone();
        let destinations = destinations.clone();
        Box::pin(async move {
            send_web_intent(
                web.as_ref(),
                &bearer,
                &show_id,
                &floor,
                &destinations,
                frame,
            )
            .await
        })
    })
}

// --- The show on web control --------------------------------------------------------

impl<W: CloudWebApi, C: ControlConnector> ControlLoop<W, C> {
    /// Web control until the show leaves it: the state long-poll of section
    /// 3 into the same slot the socket feeds. `rx` carries nothing; it ends
    /// when the slot lets go of the show.
    ///
    /// The lost report is on its own clock, as on the socket, but here it
    /// goes whatever the last poll said (section 15): this computer's feed
    /// down 20 s is what the web is told, with `controlLost` saying whether
    /// that poll failed.
    pub(crate) async fn run_web(
        &mut self,
        mut web: WebControl<W>,
        rx: &mut mpsc::UnboundedReceiver<ControlRequest>,
    ) -> LoopExit {
        let call = web.call.clone();
        let mut sends = tokio::task::JoinSet::new();
        // When each leg last got its address again (section 8.4).
        let mut resent: HashMap<String, tokio::time::Instant> = HashMap::new();
        let mut poll_failed = false;
        // The `rev` last dropped as stale: the same one a second time is the
        // web's current state, and is taken.
        let mut dropped: Option<u64> = None;
        // The program pages that had joined when this loop began.
        let mut page_joins: u32 = lock(&self.context.slot)
            .runner
            .as_ref()
            .and_then(|runner| runner.room.as_ref())
            .and_then(|room| room.page_joins)
            .unwrap_or(0);
        loop {
            if !self.current() {
                return LoopExit::Superseded;
            }
            if let Some((destinations, generation)) = self.resend.take() {
                self.send_destinations_again_over_web(&call, &destinations, generation, &mut sends);
            }
            // Plan 224, on web control: the web reports no stage while this
            // desktop holds one. The route's answer raises the floor, so the
            // next state that is taken already has it.
            if self.resend_stage {
                self.resend_stage = false;
                self.send_stage_again_over_web(&call, &mut sends);
            }
            let answer = {
                let poll = web.poll();
                tokio::pin!(poll);
                loop {
                    let lost_due = lock(&self.context.slot).lost_report_due_at();
                    tokio::select! {
                        answer = &mut poll => break answer,
                        _ = sends.join_next(), if !sends.is_empty() => {}
                        request = rx.recv() => {
                            if request.is_none() {
                                return LoopExit::Superseded;
                            }
                        }
                        _ = until(lost_due) => {
                            if let Some(exit) = self.report_lost_show(poll_failed).await {
                                return exit;
                            }
                            if !self.current() {
                                return LoopExit::Superseded;
                            }
                        }
                        _ = tokio::time::sleep(FEED_CLOCK_LOOK), if lost_due.is_none() => {}
                    }
                }
            };
            if !self.current() {
                return LoopExit::Superseded;
            }
            match answer {
                WebPoll::State { rev, state } => {
                    poll_failed = false;
                    if dropped != Some(rev) && web.is_stale(rev) {
                        dropped = Some(rev);
                        continue;
                    }
                    let fresh = dropped == Some(rev);
                    let joins = state.room.as_ref().and_then(|room| room.page_joins);
                    if self.absorb_web_state(&web, rev, *state, fresh) {
                        dropped = None;
                        self.resend_legs_that_ask(&call, &mut resent, &mut sends);
                        // Wire section 6.3: a program page joined. Byte
                        // streams are not replayed, so what is up goes again.
                        if joins.is_some_and(|joins| joins > page_joins) {
                            self.context.resend_untimed_overlays();
                        }
                        page_joins = joins.unwrap_or(page_joins).max(page_joins);
                    } else {
                        dropped = Some(rev);
                    }
                }
                WebPoll::Ended(end_reason) => return LoopExit::Ended(end_reason),
                WebPoll::Unauthorized => return LoopExit::SignedOut,
                WebPoll::NotFound => {
                    poll_failed = true;
                    self.note_failed_poll("videorc.com does not know the show's state");
                    if self.confirm_show_gone().await == Some(true) {
                        return LoopExit::Gone;
                    }
                }
                WebPoll::Mismatch => {
                    poll_failed = true;
                    self.note_failed_poll("videorc.com says this show is not on web control");
                    if let Some(exit) = self.follow_current_control().await {
                        return exit;
                    }
                }
                WebPoll::Failed(problem) => {
                    poll_failed = true;
                    self.note_failed_poll(&problem);
                    if web.failures >= ASK_CURRENT_FROM_FAILURE
                        && self.confirm_show_gone().await == Some(true)
                    {
                        return LoopExit::Gone;
                    }
                }
            }
        }
    }

    /// A 200 into the slot, exactly as a socket frame, unless it was read
    /// before an intent this computer has had answered. False when dropped.
    ///
    /// The socket keeps frames and acks in one order; two HTTPS requests do
    /// not. Without this, a state read a moment before the hand-over's
    /// `PUT` took effect, arriving after its answer, would read as an
    /// egress that died: `destinationsSet: false` on a show that was handed
    /// over. `fresh` skips the check for a `rev` already dropped once.
    fn absorb_web_state(
        &mut self,
        web: &WebControl<W>,
        rev: u64,
        state: RunnerState,
        fresh: bool,
    ) -> bool {
        // One restart is handled once, as on a socket. Here nothing
        // reconnects to mark the next one, so the state does: the egress is
        // back, or it died again.
        if self.restart_seen_on_socket {
            let before = lock(&self.context.slot)
                .runner
                .as_ref()
                .and_then(|runner| runner.restarts);
            let died_again = matches!(
                (before, state.restarts),
                (Some(before), Some(now)) if now > before
            );
            if state.destinations_set == Some(true) || died_again {
                self.restart_seen_on_socket = false;
            }
        }
        self.absorb_state_if(state, || fresh || !web.is_stale(rev))
    }

    /// Section 8.4: a leg that reads `resend: true` and whose address this
    /// computer holds gets that one destination again, without `replace`,
    /// at most once in 30 s. The web removes and adds it, which forces a
    /// fresh connection to the platform.
    fn resend_legs_that_ask(
        &self,
        call: &WebIntentCall,
        resent: &mut HashMap<String, tokio::time::Instant>,
        sends: &mut tokio::task::JoinSet<()>,
    ) {
        let (asked, generation): (Vec<HandoverDestination>, u64) = {
            let runtime = lock(&self.context.slot);
            let (Some(show), Some(runner)) = (runtime.show.as_ref(), runtime.runner.as_ref())
            else {
                return;
            };
            (
                show.destinations
                    .iter()
                    .filter(|destination| {
                        runner
                            .legs
                            .iter()
                            .any(|leg| leg.id == destination.id && leg.resend == Some(true))
                    })
                    .cloned()
                    .collect(),
                runtime.destinations_generation.current(),
            )
        };
        let now = tokio::time::Instant::now();
        for destination in asked {
            if resent
                .get(&destination.id)
                .is_some_and(|at| now.saturating_duration_since(*at) < LEG_RESEND_SPACING)
            {
                continue;
            }
            resent.insert(destination.id.clone(), now);
            let id = new_intent_id();
            let mut frame = destinations_set_frame(&id, std::slice::from_ref(&destination), false);
            frame["_destinationGeneration"] = json!(generation);
            let call = call.clone();
            let leg = destination.id;
            sends.spawn(async move {
                if let Err(problem) = call(frame).await {
                    tracing::warn!(
                        leg = %leg,
                        "Videorc Cloud did not take one destination again: {problem}"
                    );
                }
            });
        }
    }

    /// The whole list again after the egress died (section 15): the upsert,
    /// never `replace`. Off the loop, as the socket's ack is awaited: a
    /// refusal or silence marks the restart unrecovered.
    fn send_destinations_again_over_web(
        &self,
        call: &WebIntentCall,
        destinations: &[HandoverDestination],
        destination_generation: u64,
        sends: &mut tokio::task::JoinSet<()>,
    ) {
        let id = new_intent_id();
        let mut frame = destinations_set_frame(&id, destinations, false);
        frame["_destinationGeneration"] = json!(destination_generation);
        let call = call.clone();
        let slot = self.context.slot.clone();
        let hooks = self.context.hooks.clone();
        let generation = self.generation;
        sends.spawn(async move {
            let Err(problem) = call(frame).await else {
                return;
            };
            tracing::warn!("Videorc Cloud did not take the destinations again: {problem}");
            {
                let mut runtime = lock(&slot);
                if runtime.generation != generation {
                    return;
                }
                if let Some(restart) = runtime.restart.as_mut() {
                    restart.destinations_resent = false;
                }
            }
            hooks.emit_from(&slot);
        });
    }

    /// The stage again, off the loop like the destinations. A refusal is
    /// logged; the next state that still reports no stage sends it again.
    fn send_stage_again_over_web(
        &self,
        call: &WebIntentCall,
        sends: &mut tokio::task::JoinSet<()>,
    ) {
        let stage = lock(&self.context.slot)
            .talk
            .as_ref()
            .map(|talk| talk.stage.clone());
        let Some(stage) = stage else {
            return;
        };
        let id = new_intent_id();
        let frame = stage.frame(&id);
        let call = call.clone();
        sends.spawn(async move {
            if let Err(problem) = call(frame).await {
                tracing::warn!("Videorc Cloud did not take the stage again: {problem}");
            }
        });
    }

    /// `CloudStatus.connected` is false from the first failed poll.
    fn note_failed_poll(&self, problem: &str) {
        tracing::info!("Videorc Cloud state poll failed: {problem}");
        let changed = {
            let mut runtime = lock(&self.context.slot);
            runtime.generation == self.generation
                && std::mem::replace(&mut runtime.connected, false)
        };
        if changed {
            self.context.hooks.emit_from(&self.context.slot);
        }
    }

    /// Section 3, the 409 `cloud-control-mismatch` row: ask `current` and
    /// use the control it names. `Some` ends this loop: the show is gone,
    /// or its control started over on the transport videorc.com named.
    /// `None` backs off and polls again.
    async fn follow_current_control(&mut self) -> Option<LoopExit> {
        let current = self.context.web.current_show(&self.bearer).await.ok()?;
        let Some(show) = current
            .show
            .filter(|show| show.id == self.show_id && !show.is_ended())
        else {
            return Some(LoopExit::Gone);
        };
        let control = current.control?;
        if control.transport_kind() == ControlKind::Web {
            return None;
        }
        tracing::warn!(
            show = %show.id,
            "Videorc Cloud names another control for this show; following it"
        );
        let opened = self
            .context
            .open_control(&self.bearer, &self.show_id, &control)
            .await;
        let (mut link, first) = opened.ok()?;
        let still_held = {
            let mut runtime = lock(&self.context.slot);
            let current = runtime.generation == self.generation;
            match runtime
                .show
                .as_mut()
                .filter(|active| current && active.record.id == self.show_id)
            {
                Some(active) => {
                    active.control = control.clone();
                    true
                }
                None => false,
            }
        };
        if !still_held {
            link.close().await;
            return Some(LoopExit::Superseded);
        }
        install_control_loop(
            &self.context,
            self.bearer.clone(),
            control,
            self.show_id.clone(),
            link,
            first,
        );
        Some(LoopExit::Superseded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ytkey-SECRET-0f3a9b";

    fn frame(replace: bool) -> Value {
        destinations_set_frame(
            "intent-1",
            &[HandoverDestination {
                id: "youtube-main".to_string(),
                platform: "youtube".to_string(),
                label: "YouTube".to_string(),
                orientation: "horizontal".to_string(),
                url: format!("rtmps://a.rtmp.youtube.com/live2/{KEY}"),
            }],
            replace,
        )
    }

    /// Section 2.2: the body is the frame's fields, and nothing of the frame
    /// itself (`t`, `id`, `kind`). `replace` rides only when true.
    #[test]
    fn the_destinations_body_is_the_frames_fields_and_its_debug_shows_no_key() {
        let body = DestinationsBody::from_frame(&frame(true)).unwrap();
        assert_eq!(
            body.as_json(),
            &json!({
                "destinations": [{
                    "id": "youtube-main", "platform": "youtube", "label": "YouTube",
                    "orientation": "horizontal",
                    "url": format!("rtmps://a.rtmp.youtube.com/live2/{KEY}"),
                }],
                "replace": true,
            })
        );
        let upsert = DestinationsBody::from_frame(&frame(false)).unwrap();
        assert!(upsert.as_json().get("replace").is_none());
        let printed = format!("{body:?}");
        assert!(printed.contains("youtube-main"), "{printed}");
        assert!(!printed.contains(KEY), "{printed}");
        assert!(!printed.contains("rtmps://"), "{printed}");
        assert!(DestinationsBody::from_frame(&json!({ "kind": "destinations.set" })).is_none());
    }

    /// Section 8.5 from this side: whatever an answer echoes, neither the
    /// address nor its key reaches an error string or a log line.
    #[test]
    fn an_answer_that_echoes_the_request_is_scrubbed() {
        let body = DestinationsBody::from_frame(&frame(true)).unwrap();
        let echoed = format!(
            "could not start rtmps://a.rtmp.youtube.com/live2/{KEY} (key {KEY}, code destination-no-app)"
        );
        let scrubbed = body.scrub(&echoed);
        assert!(!scrubbed.contains(KEY), "{scrubbed}");
        assert!(!scrubbed.contains("a.rtmp.youtube.com"), "{scrubbed}");
        assert!(scrubbed.contains("destination-no-app"), "{scrubbed}");
        // A failure is worded from its status and code; the web's own
        // sentence is never repeated.
        let failure = DestinationsFailure {
            error: CloudApiError::Other {
                status: 422,
                code: "cloud-destinations-refused".to_string(),
                message: format!("refused rtmps://a.rtmp.youtube.com/live2/{KEY}"),
            },
            refused: vec![
                RefusedDestination {
                    id: "youtube-main".to_string(),
                    code: "destination-trailing-slash".to_string(),
                },
                RefusedDestination {
                    id: "custom-1".to_string(),
                    code: "destination-trailing-slash".to_string(),
                },
            ],
        };
        assert_eq!(
            destinations_problem(&failure),
            "videorc.com answered 422 cloud-destinations-refused (destination-trailing-slash)"
        );
        assert_eq!(
            key_piece("rtmp://live.twitch.tv/app/live_1_abc"),
            Some("live_1_abc")
        );
        assert_eq!(
            key_piece("rtmps://host/app/key?token=1"),
            Some("key?token=1")
        );
        assert_eq!(key_piece("not a url"), None);
    }

    /// A 422's `refused[]` is read from the top level or from inside
    /// `error`, and a body without one is a plain failure.
    #[test]
    fn a_refused_list_is_read_from_the_failure_body() {
        let error = || CloudApiError::Other {
            status: 422,
            code: "cloud-destinations-refused".to_string(),
            message: String::new(),
        };
        let refused = json!([{ "id": "custom-1", "code": "destination-scheme" }]);
        for body in [
            json!({ "error": { "code": "cloud-destinations-refused" }, "refused": refused }),
            json!({ "error": { "code": "cloud-destinations-refused", "refused": refused } }),
        ] {
            let failure = DestinationsFailure::from_body(error(), &body);
            assert_eq!(failure.refused.len(), 1, "{body}");
            assert_eq!(failure.refused[0].code, "destination-scheme");
        }
        assert!(
            DestinationsFailure::from_body(error(), &Value::Null)
                .refused
                .is_empty()
        );
    }

    fn other(status: u16, code: &str) -> CloudApiError {
        CloudApiError::Other {
            status,
            code: code.to_string(),
            message: "the web's own words".to_string(),
        }
    }

    /// Section 3's table, row by row, as the poll reads an answer.
    #[test]
    fn each_state_answer_reads_as_its_row_of_the_table() {
        let answer = |state: Value| -> ControlStateAnswer {
            serde_json::from_value(json!({ "rev": 42, "state": state })).unwrap()
        };
        let live = answer(json!({
            "phase": "hold", "liveSeconds": 1234,
            "hold": { "active": true, "since": "2026-11-13T20:20:34.000Z", "reason": "feed-lost", "remainingSeconds": 1741 },
            "feeds": [{ "orientation": "horizontal", "connected": false }],
            "legs": [{ "id": "youtube-main", "platform": "youtube", "label": "YouTube",
                       "orientation": "horizontal", "state": "reconnecting", "resend": true,
                       "since": "2026-11-13T20:00:07.000Z" }],
            "destinationsSet": true, "restarts": 0, "holdImageSet": false, "desktopConnected": true,
            "program": { "audioRmsDb": -100.0, "audioSilentSeconds": 59, "blackSeconds": 0 }
        }));
        match read_state_answer(Ok(live)) {
            WebPoll::State { rev, state } => {
                assert_eq!(rev, 42);
                assert_eq!(state.phase, "hold");
                assert_eq!(state.destinations_set, Some(true));
                assert_eq!(state.legs[0].resend, Some(true));
                assert_eq!(state.hold.as_ref().unwrap().remaining_seconds, Some(1741));
            }
            other => panic!("a 200 is a state, got {other:?}"),
        }
        // The show is over: a 200 that says so, with its reason, or the 409.
        let ended = answer(json!({
            "phase": "ended", "endReason": "hold-limit", "liveSeconds": 9, "feeds": [], "legs": []
        }));
        assert!(matches!(
            read_state_answer(Ok(ended)),
            WebPoll::Ended(Some(reason)) if reason == "hold-limit"
        ));
        assert!(matches!(
            read_state_answer(Err(other(409, CODE_SHOW_ENDED))),
            WebPoll::Ended(None)
        ));
        assert!(matches!(
            read_state_answer(Err(CloudApiError::Unauthorized)),
            WebPoll::Unauthorized
        ));
        assert!(matches!(
            read_state_answer(Err(other(404, "cloud-show-not-found"))),
            WebPoll::NotFound
        ));
        assert!(matches!(
            read_state_answer(Err(other(409, CODE_CONTROL_MISMATCH))),
            WebPoll::Mismatch
        ));
        // Unknown, never "gone": a 5xx, a timeout, a body that did not
        // parse, a refusal this build has no row for.
        for unknown in [
            other(503, "cloud-media-unavailable"),
            other(500, "internal"),
            other(200, "malformed-response"),
            other(400, "invalid-request"),
            other(409, "something-new"),
            CloudApiError::Transport("timed out".to_string()),
            CloudApiError::Full,
        ] {
            match read_state_answer(Err(unknown.clone())) {
                WebPoll::Failed(problem) => {
                    assert!(!problem.contains("the web's own words"), "{problem}")
                }
                other => panic!("{unknown:?} is unknown, got {other:?}"),
            }
        }
        // Section 2: only a network error or a 5xx is tried again.
        assert!(retryable(&CloudApiError::Transport("reset".to_string())));
        assert!(retryable(&other(503, "cloud-media-unavailable")));
        assert!(retryable(&CloudApiError::Full));
        for never in [
            other(400, "invalid-request"),
            other(404, "cloud-show-not-found"),
            other(409, CODE_SHOW_ENDED),
            other(422, "cloud-destinations-refused"),
            CloudApiError::Unauthorized,
        ] {
            assert!(!retryable(&never), "{never:?}");
        }
    }

    fn png_of(image: &image::RgbaImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("a PNG encodes");
        out.into_inner()
    }

    /// Pixels a PNG cannot compress: a small generator, no two alike.
    fn noise(width: u32, height: u32) -> image::RgbaImage {
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        image::RgbaImage::from_fn(width, height, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let bytes = seed.to_le_bytes();
            image::Rgba([bytes[0], bytes[1], bytes[2], 255])
        })
    }

    fn decoded(png: &[u8]) -> image::DynamicImage {
        image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .expect("the fitted image is a PNG")
    }

    /// Section 2.4 (C4): the hold image is at most 2 MiB and 1,920 pixels a
    /// side when it leaves. The limits are parameters here so the cases stay
    /// small; the constants are pinned to the fixture below.
    #[test]
    fn the_hold_image_is_fitted_to_the_routes_limits() {
        // Inside both limits: the same bytes.
        let small = png_of(&image::RgbaImage::from_pixel(
            48,
            27,
            image::Rgba([13, 13, 15, 255]),
        ));
        assert_eq!(fit_hold_image(small.clone(), 64, 4096).unwrap(), small);

        // Too wide: scaled to the side limit, its shape kept.
        let wide = png_of(&image::RgbaImage::from_pixel(
            320,
            180,
            image::Rgba([200, 30, 30, 255]),
        ));
        let fitted = decoded(&fit_hold_image(wide, 64, 4096).unwrap());
        assert_eq!((fitted.width(), fitted.height()), (64, 36));
        assert_eq!(fitted.to_rgba8().get_pixel(10, 10).0, [200, 30, 30, 255]);
        // Too tall is the same rule on the other side.
        let tall = png_of(&image::RgbaImage::from_pixel(
            90,
            160,
            image::Rgba([0, 0, 0, 255]),
        ));
        let fitted = decoded(&fit_hold_image(tall, 64, 4096).unwrap());
        assert_eq!((fitted.width(), fitted.height()), (36, 64));

        // Inside the side limit but too many bytes: scaled down until its
        // PNG fits, still the same shape.
        let heavy = png_of(&noise(64, 32));
        assert!(heavy.len() > 4096, "{} bytes", heavy.len());
        let fitted = fit_hold_image(heavy, 64, 4096).unwrap();
        assert!(fitted.len() <= 4096, "{} bytes", fitted.len());
        let fitted = decoded(&fitted);
        assert!(fitted.width() < 64 && fitted.width() >= HOLD_IMAGE_MIN_SIDE);
        assert!(fitted.width() > fitted.height());

        // Both at once.
        let fitted = fit_hold_image(png_of(&noise(200, 100)), 64, 4096).unwrap();
        assert!(fitted.len() <= 4096);
        assert!(decoded(&fitted).width() <= 64);

        // Best effort: what cannot fit, or is no PNG, is an error the
        // caller logs, and the default card stays.
        assert!(fit_hold_image(png_of(&noise(64, 64)), 64, 200).is_err());
        assert!(fit_hold_image(b"GIF89a not a png".to_vec(), 64, 4096).is_err());
        assert!(fit_hold_image(Vec::new(), 64, 4096).is_err());
    }

    /// The same through the base64 the show holds: an image that fits is
    /// the same string, and an oversized one leaves inside the real limits.
    #[tokio::test]
    async fn the_hold_image_leaves_as_base64_inside_the_real_limits() {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::STANDARD;
        let small = engine.encode(png_of(&image::RgbaImage::from_pixel(
            640,
            360,
            image::Rgba([13, 13, 15, 255]),
        )));
        assert_eq!(fit_hold_image_base64(&small).await.unwrap(), small);

        let oversized = engine.encode(png_of(&image::RgbaImage::from_pixel(
            2560,
            1440,
            image::Rgba([13, 13, 15, 255]),
        )));
        let fitted = fit_hold_image_base64(&oversized).await.unwrap();
        let png = engine.decode(fitted).unwrap();
        assert!(png.len() <= HOLD_IMAGE_MAX_BYTES);
        let image = decoded(&png);
        assert_eq!((image.width(), image.height()), (1920, 1080));

        assert!(fit_hold_image_base64("not base64 !!").await.is_err());
        assert!(fit_hold_image_base64("aGVsbG8=").await.is_err());
    }

    /// Section 2.3: End livestream names what this computer holds by id
    /// and address, an empty hand-over is an empty body, and neither shows
    /// a key when printed.
    #[test]
    fn the_legs_end_body_names_ids_and_addresses_and_nothing_else() {
        let mut frame = json!({ "t": "intent", "id": "intent-9", "kind": "legs.end" });
        assert_eq!(DestinationsBody::for_legs_end(&frame).as_json(), &json!({}));
        frame["destinations"] = legs_end_destinations(&[HandoverDestination {
            id: "youtube-main".to_string(),
            platform: "youtube".to_string(),
            label: "YouTube".to_string(),
            orientation: "horizontal".to_string(),
            url: format!("rtmps://a.rtmp.youtube.com/live2/{KEY}"),
        }]);
        let body = DestinationsBody::for_legs_end(&frame);
        assert_eq!(
            body.as_json(),
            &json!({ "destinations": [
                { "id": "youtube-main", "url": format!("rtmps://a.rtmp.youtube.com/live2/{KEY}") }
            ] })
        );
        assert!(!format!("{body:?}").contains(KEY));
        assert!(!body.scrub(&format!("refused {KEY}")).contains(KEY));
        frame["destinations"] = json!([]);
        assert_eq!(DestinationsBody::for_legs_end(&frame).as_json(), &json!({}));
    }

    /// Section 13.2: what FFmpeg is asked, and what of its words is kept.
    /// The playlist goes by path, HTTPS is the only way out, and a URL never
    /// survives into an error.
    #[test]
    fn the_remux_reads_local_files_only_and_its_errors_carry_no_url() {
        let args = remux_args(Path::new("/tmp/p.m3u8"), Path::new("/tmp/out.mp4"));
        let args: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file",
                "-i",
                "/tmp/p.m3u8",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/tmp/out.mp4"
            ]
        );
        // Plain HTTP is not on the list: a playlist cannot send FFmpeg there.
        assert!(
            !REMUX_PROTOCOL_WHITELIST
                .split(',')
                .any(|scheme| scheme == "http")
        );

        let said = "[hls @ 0x1] Failed to open segment: https://s3.test/a/seg_1.ts?X-Amz-Signature=abc123 (403)
rtmps://h/app/key 'http://x.test/y'";
        let scrubbed = scrub_urls(said);
        for secret in ["s3.test", "abc123", "x.test", "h/app/key"] {
            assert!(!scrubbed.contains(secret), "{scrubbed}");
        }
        assert!(scrubbed.contains("Failed to open segment"), "{scrubbed}");
        assert!(scrubbed.contains("(403)"), "{scrubbed}");
        assert_eq!(scrub_urls("no address here: 12"), "no address here: 12");
        assert_eq!(
            scrub_urls("né https://é.test/x ok"),
            "né (address withheld) ok"
        );

        // The file's name is built from checked digits alone.
        let named = |started_at: &str, orientation: &str| {
            CloudRecordingItem {
                id: "rec_1".to_string(),
                started_at: started_at.to_string(),
                orientation: orientation.to_string(),
                ..CloudRecordingItem::default()
            }
            .file_name()
        };
        assert_eq!(
            named("2026-11-08T12:04:59.000Z", "h"),
            "talk-2026-11-08-1204-h.mp4"
        );
        assert_eq!(
            named("2026-11-08T12:04:59.000Z", "v"),
            "talk-2026-11-08-1204-v.mp4"
        );
        for odd in [
            "",
            "../../etc/passwd",
            "2026-11-08",
            "2026/11/08T12:04",
            "abcd-ef-ghTij:kl",
        ] {
            assert_eq!(named(odd, "../x"), "talk-h.mp4", "{odd}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_cloud_attempts_share_one_deadline_and_skip_useless_retries() {
        for first_seconds in [5, 20] {
            let attempts = std::sync::atomic::AtomicUsize::new(0);
            let start = tokio::time::Instant::now();
            let answer = with_one_cloud_retry_until(start + CONTROL_INTENT_BUDGET, || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    tokio::time::sleep(Duration::from_secs(if n == 0 {
                        first_seconds
                    } else {
                        30
                    }))
                    .await;
                    Err::<(), _>(CloudApiError::NodeUnreachable)
                }
            })
            .await;
            assert!(answer.is_err());
            assert!(start.elapsed() <= CONTROL_INTENT_BUDGET);
            assert_eq!(
                attempts.load(Ordering::SeqCst),
                if first_seconds == 20 { 1 } else { 2 }
            );
        }
    }

    #[tokio::test]
    async fn download_jobs_return_immediately_deduplicate_cancel_and_join_on_shutdown() {
        let jobs = Arc::new(RecordingDownloadJobs::default());
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let emit: DownloadEventHook = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let first = jobs
            .start(
                "rec_one".to_string(),
                emit.clone(),
                move |mut control| async move {
                    started.send(()).unwrap();
                    crate::cloud_show::wait_canceled(&mut control.cancelled).await;
                    bail!("cancelled");
                },
            )
            .unwrap();
        let duplicate = jobs
            .start("rec_one".to_string(), emit.clone(), |_| async {
                panic!("duplicate job must never start");
                #[allow(unreachable_code)]
                Ok(PathBuf::new())
            })
            .unwrap();
        assert_eq!(first, duplicate);
        ready.await.unwrap();
        jobs.cancel(&first.job_id);
        // Shutdown owns the join even if cancellation was requested by RPC.
        jobs.shutdown().await;
        assert!(jobs.0.lock().unwrap().running.is_empty());
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].state, DownloadState::Running);
        assert_eq!(events[1].state, DownloadState::Cancelled);
        let wire = serde_json::to_value(&events[1]).unwrap();
        for absent in ["path", "error", "doneSegments", "totalSegments"] {
            assert!(wire.get(absent).is_none());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_remux_kills_and_reaps_its_owned_child() {
        let (cancel, cancelled) = watch::channel(false);
        cancel.send(true).unwrap();
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            run_ffmpeg_remux(
                "/bin/sleep".to_string(),
                vec![OsString::from("60")],
                cancelled,
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            outcome.err().unwrap().kind(),
            std::io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn colliding_downloads_only_remove_their_own_parts_and_claim_distinct_names() {
        let temporary = TemporaryRecordingDirectory::create().unwrap();
        let folder = &temporary.0;
        let first =
            OwnedDownloadFile::part(folder, "take.mp4", &uuid::Uuid::new_v4().to_string()).unwrap();
        let second =
            OwnedDownloadFile::part(folder, "take.mp4", &uuid::Uuid::new_v4().to_string()).unwrap();
        assert_ne!(first.path(), second.path());
        std::fs::write(first.path(), b"complete").unwrap();
        std::fs::write(second.path(), b"incomplete").unwrap();
        let saved = first.finish(folder, "take.mp4").unwrap();
        drop(second); // a failing concurrent remux
        assert_eq!(std::fs::read(&saved).unwrap(), b"complete");
        let third =
            OwnedDownloadFile::part(folder, "take.mp4", &uuid::Uuid::new_v4().to_string()).unwrap();
        std::fs::write(third.path(), b"another").unwrap();
        assert_eq!(
            third.finish(folder, "take.mp4").unwrap(),
            folder.join("take (2).mp4")
        );
        assert_eq!(std::fs::read(saved).unwrap(), b"complete");
        assert_eq!(std::fs::read_dir(folder).unwrap().count(), 2);
    }

    #[test]
    fn private_download_folders_are_removed_on_drop_panic_and_stale_start() {
        let root =
            std::env::temp_dir().join(format!("cloud-scratch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let temporary = TemporaryRecordingDirectory::create_in(&root).unwrap();
        let path = temporary.0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::write(path.join("segment.ts"), b"media").unwrap();
        drop(temporary);
        assert!(!path.exists());
        let temporary = TemporaryRecordingDirectory::create_in(&root).unwrap();
        let path = temporary.0.clone();
        assert!(
            std::panic::catch_unwind(move || {
                let _guard = temporary;
                panic!("test unwind");
            })
            .is_err()
        );
        assert!(!path.exists());
        let stale = TemporaryRecordingDirectory::create_in(&root).unwrap();
        let unrelated = root.join("other-folder");
        std::fs::create_dir(&unrelated).unwrap();
        remove_stale_recording_downloads(
            &root,
            std::time::SystemTime::now() + Duration::from_secs(86_401),
        );
        assert!(!stale.0.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_playlists_never_give_ffmpeg_a_network_uri_or_key() {
        let (local, segments) = local_recording_playlist(
            "#EXTM3U\n#EXTINF:2,\nhttps://storage.test/a.ts?signature=example\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        assert_eq!(segments.len(), 1);
        assert!(!local.contains("://"));
        assert!(local.contains("segment-000000.ts"));
        for unsupported in [
            "http://storage.test/a.ts",
            "file:///etc/passwd",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"https://storage.test/key\"",
            "#EXT-X-MAP:URI=\"https://storage.test/init\"",
        ] {
            let error = local_recording_playlist(&format!("#EXTM3U\n{unsupported}\n")).unwrap_err();
            assert!(!error.to_string().contains("storage.test"));
        }
        assert_eq!(
            storage_problem(&std::io::Error::from_raw_os_error(libc::ENOSPC)),
            "There isn't enough space to save the recording."
        );
    }

    #[test]
    fn a_full_disk_during_remux_has_a_plain_error() {
        assert_eq!(
            remux_problem("av_interleaved_write_frame(): No space left on device"),
            RECORDING_DISK_FULL
        );
        assert_eq!(
            remux_problem("Error writing trailer: No space left on device"),
            RECORDING_DISK_FULL
        );
    }

    #[test]
    fn stopping_also_drops_recovery_collected_while_end_is_in_flight() {
        let destinations = DestinationGeneration::default();
        let first = destinations.stamp(frame(true));
        assert!(destinations.accepts(first["_destinationGeneration"].as_u64().unwrap()));
        destinations.stop();
        assert!(!destinations.accepts(first["_destinationGeneration"].as_u64().unwrap()));
        assert!(!destinations.accepts(destinations.current()));
        let next_go_live = destinations.stamp(frame(true));
        assert!(destinations.accepts(next_go_live["_destinationGeneration"].as_u64().unwrap()));
    }

    /// `protocol-fixtures/cloud-managed-wire.json` is what the web copies.
    /// The desktop's constants are pinned to it here; a value that differs
    /// is a bug in the code, never a reason to edit the fixture alone.
    #[test]
    fn cloud_managed_wire_fixture_pins_the_desktops_constants() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/cloud-managed-wire.json"
        ))
        .expect("the fixture parses");
        assert_eq!(fixture["version"], 1);
        let route = |name: &str| -> String {
            fixture["routes"][name]["path"]
                .as_str()
                .unwrap_or_else(|| panic!("the fixture names the {name} route"))
                .replace(":id", "sh_fixture")
        };
        assert_eq!(state_path("sh_fixture"), route("state"));
        assert_eq!(fixture["routes"]["state"]["method"], "GET");
        assert_eq!(fixture["routes"]["state"]["query"], STATE_SINCE_QUERY);
        assert_eq!(destinations_path("sh_fixture"), route("destinations"));
        assert_eq!(fixture["routes"]["destinations"]["method"], "PUT");
        assert_eq!(hold_image_path("sh_fixture"), route("holdImage"));
        assert_eq!(fixture["routes"]["holdImage"]["method"], "PUT");
        // The routes the desktop already had.
        assert_eq!(route("create"), "/api/cloud/shows");
        assert_eq!(route("current"), "/api/cloud/shows/current");
        assert_eq!(route("end"), "/api/cloud/shows/sh_fixture/end");
        assert_eq!(route("lost"), "/api/cloud/shows/sh_fixture/lost");

        assert_eq!(fixture["control"]["kinds"], json!([CONTROL_KIND_WEB]));
        assert_eq!(fixture["control"]["absentKindMeans"], "node");
        assert_eq!(
            fixture["control"]["unknownKindFallback"],
            serde_json::to_value(crate::cloud_show::CloudFallbackReason::CloudNodeUnreachable)
                .unwrap()
        );

        let codes = |list: &str| -> Vec<(u64, String)> {
            fixture["errors"][list]
                .as_array()
                .unwrap_or_else(|| panic!("the fixture lists {list} errors"))
                .iter()
                .map(|entry| {
                    (
                        entry["status"].as_u64().unwrap(),
                        entry["code"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        };
        // The codes this build branches on, at the status it expects them.
        let common = codes("common");
        assert!(common.contains(&(409, CODE_SHOW_ENDED.to_string())));
        assert!(common.contains(&(409, CODE_CONTROL_MISMATCH.to_string())));
        assert!(common.contains(&(404, "cloud-show-not-found".to_string())));
        assert!(common.contains(&(401, "unauthorized".to_string())));
        assert!(codes("create").contains(&(422, "cloud-quality".to_string())));
        assert_eq!(
            crate::cloud_show::classify_cloud_failure(
                422,
                "cloud-quality",
                String::new(),
                None,
                None
            )
            .fallback_reason(),
            Some(crate::cloud_show::CloudFallbackReason::CloudQuality)
        );
        assert!(codes("destinations").contains(&(422, "cloud-destinations-refused".to_string())));

        assert_eq!(fixture["retry"]["times"], 1);
        assert_eq!(
            fixture["retry"]["afterMs"].as_u64(),
            Some(RETRY_DELAY.as_millis() as u64)
        );
        let state = &fixture["state"];
        assert_eq!(state["answerFields"], json!(["rev", "state"]));
        assert_eq!(
            state["requestTimeoutMs"].as_u64(),
            Some(crate::videorc_api::CLOUD_STATE_POLL_TIMEOUT.as_millis() as u64)
        );
        // The request outlives the web's longest wait.
        assert!(
            crate::videorc_api::CLOUD_STATE_POLL_TIMEOUT.as_secs()
                > state["waitSeconds"]["calm"].as_u64().unwrap()
        );
        assert_eq!(
            state["restAfterAnswerMs"].as_u64(),
            Some(STATE_POLL_REST.as_millis() as u64)
        );
        assert_eq!(state["backoffSeconds"], json!(STATE_POLL_BACKOFF_SECONDS));
        assert_eq!(
            state["askCurrentFromFailure"].as_u64(),
            Some(ASK_CURRENT_FROM_FAILURE as u64)
        );
        assert_eq!(
            fixture["legs"]["resend"]["desktopSpacingSeconds"].as_u64(),
            Some(LEG_RESEND_SPACING.as_secs())
        );
        assert_eq!(
            fixture["timers"]["lostFeedDownSeconds"].as_u64(),
            Some(crate::cloud_show::LOST_SHOW_FEED_DOWN.as_secs())
        );
        assert_eq!(
            fixture["limits"]["holdMaxSecondsChoices"],
            json!(crate::cloud_show::HOLD_MAX_CHOICES)
        );
        assert_eq!(fixture["return"]["message"], RETURN_UNAVAILABLE_MESSAGE);
        // Talk shows and recordings (T3).
        assert_eq!(stage_path("sh_fixture"), route("stage"));
        assert_eq!(fixture["routes"]["stage"]["method"], "PUT");
        assert_eq!(legs_end_path("sh_fixture"), route("legsEnd"));
        assert_eq!(fixture["routes"]["legsEnd"]["method"], "POST");
        assert_eq!(recording_path("sh_fixture"), route("recording"));
        assert_eq!(fixture["routes"]["recording"]["method"], "POST");
        assert_eq!(RECORDINGS_PATH, route("recordings"));
        assert_eq!(
            recording_playlist_path("sh_fixture"),
            route("recordingPlaylist")
        );
        assert_eq!(
            fixture["recordings"]["formats"]["managed"],
            RECORDING_FORMAT_SEGMENTS
        );
        for (list, code) in [
            ("recording", "cloud-recording-no-target"),
            ("recording", "cloud-recording-solo"),
            ("recording", "cloud-recording-on-air"),
            ("legsEnd", "cloud-legs-end-solo"),
        ] {
            assert!(
                codes(list).contains(&(409, code.to_string())),
                "{list} {code}"
            );
        }
        assert_eq!(
            fixture["overlay"]["maxBytes"].as_u64(),
            Some(crate::cloud_talk::OVERLAY_MAX_BYTES as u64)
        );
        // The slots and orientations of the overlay hand-off are the wire's.
        for (slot, orientation) in [
            (
                crate::cloud_talk::CloudOverlaySlot::Card,
                crate::cloud_talk::CloudOverlayOrientation::H,
            ),
            (
                crate::cloud_talk::CloudOverlaySlot::Takeover,
                crate::cloud_talk::CloudOverlayOrientation::V,
            ),
            (
                crate::cloud_talk::CloudOverlaySlot::Hold,
                crate::cloud_talk::CloudOverlayOrientation::H,
            ),
        ] {
            assert!(
                fixture["overlay"]["slots"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(slot.as_str()))
            );
            assert!(
                fixture["overlay"]["orientations"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(orientation.as_str()))
            );
        }
        assert_eq!(
            fixture["limits"]["holdImageBytes"].as_u64(),
            Some(HOLD_IMAGE_MAX_BYTES as u64)
        );
        assert_eq!(
            fixture["limits"]["holdImageSidePixels"].as_u64(),
            Some(u64::from(HOLD_IMAGE_MAX_SIDE))
        );

        // Every leg state the web may send has a place in the desktop's leg
        // model; only a state this list does not hold reads as a warning.
        for state in fixture["legs"]["states"].as_array().unwrap() {
            let leg = crate::cloud_show::RunnerLeg {
                id: "leg".to_string(),
                state: state.as_str().unwrap().to_string(),
                ..Default::default()
            };
            assert_ne!(
                crate::cloud_show::runner_leg_to_runtime(&leg).state,
                crate::streaming::StreamTargetState::Warning,
                "{state}"
            );
        }
        // The closed leg messages reach the status as they are.
        for (_, message) in fixture["legs"]["messages"].as_object().unwrap() {
            let leg = crate::cloud_show::RunnerLeg {
                id: "leg".to_string(),
                state: "failed".to_string(),
                error: message.as_str().map(str::to_string),
                ..Default::default()
            };
            assert_eq!(
                crate::cloud_show::runner_leg_to_runtime(&leg)
                    .message
                    .as_deref(),
                message.as_str()
            );
        }
    }
}
