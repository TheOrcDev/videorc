//! The replay buffer (plan 181): a session keeps the last N seconds of the
//! composed program as a rolling set of 2-second MPEG-TS segments, and
//! "Save replay" stream-copies the newest segments into an MP4.
//!
//! This file holds the pure half: the segment list, pruning, selection, the
//! FFmpeg argument tails and the file names. Everything here is unit-tested
//! without I/O. The runtime half (the slot on `AppState`, the prune task and
//! the save flow) lives below it, behind the same module.

use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone};

/// One segment of the ring. FFmpeg's segment muxer cuts on the keyframe at or
/// after this many seconds, and every encoder in the product keeps a 2 s GOP.
pub const SEGMENT_SECONDS: u32 = 2;
/// AAC for the ring: the file output keeps its own audio codec (PCM for a
/// record-only session), the ring is always AAC so a replay is a plain MP4.
pub const REPLAY_AUDIO_BITRATE_KBPS: u32 = 192;
/// The complete-segments list FFmpeg rewrites atomically after each cut.
pub const SEGMENT_LIST_FILE: &str = "segments.csv";
/// Segment file names: `seg-000012.ts`.
pub const SEGMENT_FILE_PREFIX: &str = "seg-";
pub const SEGMENT_FILE_SUFFIX: &str = ".ts";
/// The shortest and longest buffer a session accepts (the UI offers 15 s to
/// 5 min; the wire clamps anything else here).
pub const MIN_SECONDS: u32 = 5;
pub const MAX_SECONDS: u32 = 600;
pub const DEFAULT_SECONDS: u32 = 30;
/// A saved replay may run this much past its target length: the start is
/// keyframe-aligned (D3), so up to one segment is added, plus a little slack
/// for the muxer's own cut point.
pub const MAX_OVERSHOOT_SECONDS: f64 = 2.5;
/// How long `replay.save` waits for the segment that holds the press to
/// close before it saves what is complete.
pub const SAVE_BOUNDARY_TIMEOUT_MS: u64 = 4_000;
/// Replays go here, under the recordings folder (D7).
pub const REPLAYS_FOLDER_NAME: &str = "Replays";

/// A complete segment as `segments.csv` lists it: `filename,start,end` with
/// stream-time seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub file_name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

impl Segment {
    pub fn duration_seconds(&self) -> f64 {
        (self.end_seconds - self.start_seconds).max(0.0)
    }

    /// The ordinal in `seg-%06d.ts`, when the name is one of ours.
    pub fn index(&self) -> Option<u32> {
        segment_index(&self.file_name)
    }
}

/// The ordinal of a `seg-%06d.ts` file name; `None` for anything else, so a
/// stray file in the directory is never pruned or selected.
pub fn segment_index(file_name: &str) -> Option<u32> {
    let base = Path::new(file_name).file_name()?.to_str()?;
    let digits = base
        .strip_prefix(SEGMENT_FILE_PREFIX)?
        .strip_suffix(SEGMENT_FILE_SUFFIX)?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Parses FFmpeg's `-segment_list_type csv` file. Malformed lines are
/// skipped, never fatal: the muxer rewrites the whole file on every cut, and
/// a half-written line only means "read it again next tick".
pub fn parse_segment_list(text: &str) -> Vec<Segment> {
    let mut segments = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // The file name may itself contain a comma only if we named it so;
            // ours never do, but split from the right to be safe.
            let (rest, end) = line.rsplit_once(',')?;
            let (file_name, start) = rest.rsplit_once(',')?;
            let start_seconds: f64 = start.trim().parse().ok()?;
            let end_seconds: f64 = end.trim().parse().ok()?;
            if !start_seconds.is_finite() || !end_seconds.is_finite() || end_seconds < start_seconds
            {
                return None;
            }
            let file_name = file_name.trim();
            segment_index(file_name)?;
            Some(Segment {
                file_name: file_name.to_string(),
                start_seconds,
                end_seconds,
            })
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|segment| segment.index().unwrap_or(u32::MAX));
    segments.dedup_by_key(|segment| segment.index());
    segments
}

/// Clamp a requested length to what a session accepts.
pub fn clamp_seconds(seconds: u32) -> u32 {
    seconds.clamp(MIN_SECONDS, MAX_SECONDS)
}

/// How many complete segments the list keeps: enough to cover N seconds
/// after keyframe alignment, plus one spare so a save that lands right on a
/// cut still has its full window.
pub fn keep_count(seconds: u32) -> usize {
    let seconds = clamp_seconds(seconds);
    (seconds as usize).div_ceil(SEGMENT_SECONDS as usize) + 2
}

/// The ring's disk bound: the kept segments plus the one being written.
pub fn max_segment_files(seconds: u32) -> usize {
    keep_count(seconds) + 1
}

/// Segment files to delete now: every one of ours that is older than the
/// oldest listed segment. The newest unlisted file is the one FFmpeg is
/// writing and is never touched; with an empty list nothing is complete yet,
/// so nothing goes.
pub fn segments_to_prune(dir_file_names: &[String], listed: &[Segment]) -> Vec<String> {
    let Some(oldest_listed) = listed.iter().filter_map(Segment::index).min() else {
        return Vec::new();
    };
    let mut doomed = dir_file_names
        .iter()
        .filter(|name| segment_index(name).is_some_and(|index| index < oldest_listed))
        .cloned()
        .collect::<Vec<_>>();
    doomed.sort();
    doomed
}

/// The newest complete segments that cover `seconds`, oldest first.
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub segments: Vec<Segment>,
    /// What the segments actually hold, which is less than `seconds` while
    /// the buffer is still filling.
    pub covered_seconds: f64,
    /// False while the buffer holds less than `seconds`.
    pub complete: bool,
}

impl Selection {
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }
}

/// Walks the list from the newest segment back until `seconds` are covered
/// (D3: the start is the first keyframe at or before N seconds ago, so the
/// result runs N to N + one segment).
pub fn select_segments(listed: &[Segment], seconds: u32) -> Selection {
    let target = f64::from(clamp_seconds(seconds));
    let mut chosen = Vec::new();
    let mut covered = 0.0;
    for segment in listed.iter().rev() {
        if covered >= target {
            break;
        }
        covered += segment.duration_seconds();
        chosen.push(segment.clone());
    }
    chosen.reverse();
    Selection {
        complete: covered >= target,
        covered_seconds: covered,
        segments: chosen,
    }
}

/// The ffconcat script for a selection: absolute paths, quoted the way the
/// concat demuxer wants them (`'` becomes `'\''`).
pub fn concat_list(selection: &Selection, segment_dir: &Path) -> String {
    let mut script = String::from("ffconcat version 1.0\n");
    for segment in &selection.segments {
        let path = segment_dir.join(&segment.file_name);
        let quoted = path.display().to_string().replace('\'', "'\\''");
        script.push_str(&format!("file '{quoted}'\n"));
        script.push_str(&format!("duration {:.6}\n", segment.duration_seconds()));
    }
    script
}

/// The segment muxer tail of the ring output. The caller has already mapped
/// the streams and chosen the codecs (`-c:v copy` behind an encoded bridge,
/// the platform encoder on the raw and legacy paths, AAC audio either way).
pub fn segment_muxer_args(segment_dir: &Path, seconds: u32) -> Vec<String> {
    vec![
        "-f".to_string(),
        "segment".to_string(),
        "-segment_format".to_string(),
        "mpegts".to_string(),
        "-segment_time".to_string(),
        SEGMENT_SECONDS.to_string(),
        "-reset_timestamps".to_string(),
        "0".to_string(),
        "-segment_list".to_string(),
        segment_dir.join(SEGMENT_LIST_FILE).display().to_string(),
        "-segment_list_type".to_string(),
        "csv".to_string(),
        "-segment_list_size".to_string(),
        keep_count(seconds).to_string(),
        "-segment_list_flags".to_string(),
        "+live".to_string(),
        segment_dir
            .join(format!("{SEGMENT_FILE_PREFIX}%06d{SEGMENT_FILE_SUFFIX}"))
            .display()
            .to_string(),
    ]
}

/// The audio encoding of the ring output: the session's own audio filter
/// (gain, mute, sync offset), 48 kHz, AAC at [`REPLAY_AUDIO_BITRATE_KBPS`].
pub fn replay_audio_encoding_args(filter: Option<&str>, channels: u16) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(filter) = filter.filter(|filter| !filter.is_empty()) {
        args.extend(["-af".to_string(), filter.to_string()]);
    }
    args.extend([
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        channels.max(1).to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        format!("{REPLAY_AUDIO_BITRATE_KBPS}k"),
    ]);
    args
}

/// `ffmpeg` arguments that stream-copy a concat script into a faststart MP4.
/// The AAC ADTS frames in the segments become MP4 AAC through the
/// `aac_adtstoasc` filter the mp4 muxer inserts on its own.
pub fn save_args(concat_list_path: &Path, partial_output: &Path) -> Vec<String> {
    vec![
        "-n".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        concat_list_path.display().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        "-f".to_string(),
        "mp4".to_string(),
        partial_output.display().to_string(),
    ]
}

/// `Replay 2026-10-12 18-30-05.mp4`: the user's wall clock, no characters a
/// file system or a shell would mind (D7).
pub fn replay_file_name<Tz: TimeZone>(now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    format!("Replay {}.mp4", now.format("%Y-%m-%d %H-%M-%S"))
}

/// The Library row's title for a saved replay.
pub fn replay_title() -> &'static str {
    "Replay"
}

/// Where a replay goes: `<recordings folder>/Replays`.
pub fn replays_dir(recordings_dir: &Path) -> PathBuf {
    recordings_dir.join(REPLAYS_FOLDER_NAME)
}

/// The partial file a save writes before its rename, beside the target.
pub fn partial_path(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Replay.mp4".to_string());
    name.push_str(".partial");
    target.with_file_name(name)
}

/// Bytes per second the ring writes at this quality: the video bitrate plus
/// the ring's AAC.
pub fn bytes_per_second(video_bitrate_kbps: u32) -> u64 {
    (u64::from(video_bitrate_kbps) + u64::from(REPLAY_AUDIO_BITRATE_KBPS)) * 1000 / 8
}

/// What the ring holds on disk at most: every kept segment plus the one being
/// written, each a full segment long.
pub fn estimated_disk_bytes(seconds: u32, video_bitrate_kbps: u32) -> u64 {
    max_segment_files(seconds) as u64
        * u64::from(SEGMENT_SECONDS)
        * bytes_per_second(video_bitrate_kbps)
}

/// Arming is refused under this much free space: four buffers' worth, so a
/// save (its staging links and the MP4) always has room beside the ring.
pub fn required_free_bytes(seconds: u32, video_bitrate_kbps: u32) -> u64 {
    4 * u64::from(clamp_seconds(seconds)) * bytes_per_second(video_bitrate_kbps)
}

/// The length a saved replay must land in: `[N, N + MAX_OVERSHOOT_SECONDS]`
/// for a full buffer; a still-filling buffer is checked against what it held.
pub fn duration_window(seconds: u32) -> (f64, f64) {
    let seconds = f64::from(clamp_seconds(seconds));
    (seconds, seconds + MAX_OVERSHOOT_SECONDS)
}

/// Rewrites a complex filter graph that ends in `[v_main]` so the same
/// frames also feed `[v_replay]` on the raw and legacy encoder paths, where
/// a filter output can be mapped only once. Returns `None` when the graph
/// has no `[v_main]` pad, so a caller never sends a broken graph.
pub fn split_video_filter_for_replay(filter: &str) -> Option<String> {
    if !filter.contains("[v_main]") {
        return None;
    }
    let renamed = filter.replacen("[v_main]", "[v_replay_src]", 1);
    Some(format!("{renamed};[v_replay_src]split=2[v_main][v_replay]"))
}

// ---------------------------------------------------------------------------
// Runtime: the slot on `AppState`, ring preparation, the prune task, events.
// ---------------------------------------------------------------------------

use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use tokio::task::JoinHandle;

use crate::protocol::{
    LayoutSettings, OutputSettings, ReplayBufferState, ReplayStateEvent, SourceSelection,
    StartSessionParams,
};
use crate::state::AppState;

pub type ReplaySlot = Arc<StdMutex<ReplayRegistry>>;

pub fn new_replay_slot() -> ReplaySlot {
    Arc::new(StdMutex::new(ReplayRegistry::default()))
}

/// How many row-less session ids are remembered after they end, so a late
/// log line for one of them still skips the `sessions` foreign key.
const ROWLESS_SESSION_MEMORY: usize = 8;
/// The prune task's cadence: trim the ring and report what it holds.
const PRUNE_TICK: Duration = Duration::from_secs(1);

/// What the backend knows about the ring of the session that owns it.
#[derive(Debug)]
pub struct ReplayRuntime {
    pub session_id: String,
    pub replay_only: bool,
    pub seconds: u32,
    pub dir: PathBuf,
    /// The recordings folder the session started with; replays go under it.
    pub recordings_dir: PathBuf,
    pub ffmpeg_path: String,
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub output: OutputSettings,
    pub state: ReplayBufferState,
    pub buffered_seconds: f64,
    pub reason: Option<String>,
    prune_task: Option<JoinHandle<()>>,
    /// A save is running on its own task.
    pub save_in_progress: bool,
    /// One more save is waiting behind the running one (plan 181 S3).
    pub save_queued: bool,
}

impl Drop for ReplayRuntime {
    fn drop(&mut self) {
        if let Some(task) = self.prune_task.take() {
            task.abort();
        }
    }
}

#[derive(Debug, Default)]
pub struct ReplayRegistry {
    pub active: Option<ReplayRuntime>,
    rowless: VecDeque<String>,
    /// The last published event, so `replay.status` and a fresh socket get
    /// the same answer the renderer last saw.
    last_event: Option<ReplayStateEvent>,
}

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, ReplayRegistry> {
    state
        .replay
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The ring root: under the backend's managed app data, beside the
/// database; a temp directory for the in-memory test database.
pub fn ring_root(state: &AppState) -> PathBuf {
    let database = state.database.path();
    if database.to_string_lossy() == ":memory:" {
        return std::env::temp_dir().join(format!("videorc-replay-buffer-{}", std::process::id()));
    }
    database
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir)
        .join("replay-buffer")
}

/// The ring directory of one session.
pub fn ring_dir(state: &AppState, session_id: &str) -> PathBuf {
    let safe = session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    ring_root(state).join(safe)
}

/// Removes every ring left by a crash (plan 181 S2.4). Called once at
/// startup and once more at the end of shutdown.
pub fn clean_leftovers(state: &AppState) {
    let root = ring_root(state);
    if root.exists()
        && let Err(error) = std::fs::remove_dir_all(&root)
    {
        tracing::warn!(
            "Could not remove replay buffer leftovers at {}: {error}",
            root.display()
        );
    }
}

/// A buffer-only session has no Library row; its logs and health events
/// skip the `sessions` foreign key (plan 181 S2.3).
pub fn register_rowless_session(state: &AppState, session_id: &str) {
    let mut registry = lock(state);
    registry.rowless.push_back(session_id.to_string());
    while registry.rowless.len() > ROWLESS_SESSION_MEMORY {
        registry.rowless.pop_front();
    }
}

pub fn is_rowless_session(state: &AppState, session_id: &str) -> bool {
    lock(state).rowless.iter().any(|id| id == session_id)
}

/// The buffer-only session that is running, if any: `session.start` hands
/// over from it (plan 181 S7).
pub fn active_replay_only_session_id(state: &AppState) -> Option<String> {
    lock(state)
        .active
        .as_ref()
        .filter(|runtime| runtime.replay_only)
        .map(|runtime| runtime.session_id.clone())
}

/// Owns a freshly prepared ring until the session commits. Dropped unarmed
/// (any failed start), it removes the directory and reports the buffer off.
#[must_use]
pub struct RingGuard {
    state: AppState,
    session_id: String,
    pub dir: PathBuf,
    pub seconds: u32,
    armed: bool,
}

impl RingGuard {
    fn disarm(&mut self) {
        self.armed = true;
    }
}

impl Drop for RingGuard {
    fn drop(&mut self) {
        if self.armed {
            return;
        }
        let _ = std::fs::remove_dir_all(&self.dir);
        let mut registry = lock(&self.state);
        if registry
            .active
            .as_ref()
            .is_some_and(|runtime| runtime.session_id == self.session_id)
        {
            registry.active = None;
            let event = ReplayStateEvent {
                state: ReplayBufferState::Off,
                session_id: None,
                seconds: self.seconds,
                buffered_seconds: 0.0,
                replay_only: false,
                reason: Some("The session did not start.".to_string()),
            };
            registry.last_event = Some(event.clone());
            drop(registry);
            self.state.emit_event("replay.state", event);
        }
    }
}

/// Everything the ring needs from the session it rides.
pub struct RingRequest<'a> {
    pub session_id: &'a str,
    pub params: &'a StartSessionParams,
    pub replay_only: bool,
    pub recordings_dir: &'a Path,
    pub ffmpeg_path: &'a str,
}

/// Creates the ring directory (mode 0700) after the free-space check and
/// publishes `starting`. The guard cleans up until [`attach`] arms it.
pub fn prepare(state: &AppState, request: RingRequest<'_>) -> Result<RingGuard> {
    let seconds = request
        .params
        .replay
        .map(|replay| clamp_seconds(replay.seconds))
        .context("The session has no replay buffer request")?;
    let root = ring_root(state);
    std::fs::create_dir_all(&root)
        .with_context(|| format!("Could not create {}", root.display()))?;
    let required = required_free_bytes(seconds, request.params.output.video.bitrate_kbps);
    if let Some(available) = crate::noise_cleanup::available_space(&root)
        && available < required
    {
        bail!(
            "Not enough free space for the replay buffer: it needs about {} MB free and this disk has {} MB.",
            required.div_ceil(1_000_000),
            available / 1_000_000
        );
    }
    let dir = ring_dir(state, request.session_id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).with_context(|| format!("Could not create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let runtime = ReplayRuntime {
        session_id: request.session_id.to_string(),
        replay_only: request.replay_only,
        seconds,
        dir: dir.clone(),
        recordings_dir: request.recordings_dir.to_path_buf(),
        ffmpeg_path: request.ffmpeg_path.to_string(),
        sources: request.params.sources.clone(),
        layout: request.params.layout.clone(),
        output: request.params.output.clone(),
        state: ReplayBufferState::Starting,
        buffered_seconds: 0.0,
        reason: None,
        prune_task: None,
        save_in_progress: false,
        save_queued: false,
    };
    {
        let mut registry = lock(state);
        registry.active = Some(runtime);
    }
    emit_state(state);
    Ok(RingGuard {
        state: state.clone(),
        session_id: request.session_id.to_string(),
        dir,
        seconds,
        armed: false,
    })
}

/// The session committed: the ring is live. Starts the prune task and
/// publishes `on`.
pub fn attach(state: &AppState, mut guard: RingGuard) {
    guard.disarm();
    let session_id = guard.session_id.clone();
    let task_state = state.clone();
    let task_session_id = session_id.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(PRUNE_TICK).await;
            let (dir, seconds) = {
                let registry = lock(&task_state);
                let Some(runtime) = registry
                    .active
                    .as_ref()
                    .filter(|runtime| runtime.session_id == task_session_id)
                else {
                    return;
                };
                (runtime.dir.clone(), runtime.seconds)
            };
            let report = prune_tick(&dir, seconds);
            {
                let mut registry = lock(&task_state);
                let Some(runtime) = registry
                    .active
                    .as_mut()
                    .filter(|runtime| runtime.session_id == task_session_id)
                else {
                    return;
                };
                runtime.buffered_seconds = report.buffered_seconds;
            }
            emit_state(&task_state);
        }
    });
    {
        let mut registry = lock(state);
        if let Some(runtime) = registry
            .active
            .as_mut()
            .filter(|runtime| runtime.session_id == session_id)
        {
            runtime.state = ReplayBufferState::On;
            runtime.prune_task = Some(task);
        } else {
            task.abort();
        }
    }
    emit_state(state);
}

/// Why a ring went away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetireOutcome {
    /// The user (or the handover, or shutdown) stopped the session.
    Stopped,
    /// The session ended on its own; the buffer is off and says why.
    Failed(String),
}

/// The session's monitor retired its slot: stop pruning, delete the ring
/// and publish `off` (or `error` with the reason).
pub fn retire(state: &AppState, session_id: &str, outcome: RetireOutcome) {
    let removed = {
        let mut registry = lock(state);
        if !registry
            .active
            .as_ref()
            .is_some_and(|runtime| runtime.session_id == session_id)
        {
            return;
        }
        let runtime = registry.active.take();
        let seconds = runtime
            .as_ref()
            .map_or(DEFAULT_SECONDS, |runtime| runtime.seconds);
        let dir = runtime.as_ref().map(|runtime| runtime.dir.clone());
        drop(runtime);
        let (state_value, reason) = match outcome {
            RetireOutcome::Stopped => (ReplayBufferState::Off, None),
            RetireOutcome::Failed(reason) => (ReplayBufferState::Error, Some(reason)),
        };
        registry.last_event = Some(ReplayStateEvent {
            state: state_value,
            session_id: None,
            seconds,
            buffered_seconds: 0.0,
            replay_only: false,
            reason,
        });
        dir
    };
    if let Some(dir) = removed
        && let Err(error) = std::fs::remove_dir_all(&dir)
        && dir.exists()
    {
        tracing::warn!(
            "Could not remove the replay ring at {}: {error}",
            dir.display()
        );
    }
    emit_state(state);
}

/// The current `replay.state` payload.
pub fn snapshot(state: &AppState) -> ReplayStateEvent {
    let registry = lock(state);
    match registry.active.as_ref() {
        Some(runtime) => ReplayStateEvent {
            state: runtime.state,
            session_id: Some(runtime.session_id.clone()),
            seconds: runtime.seconds,
            buffered_seconds: runtime.buffered_seconds,
            replay_only: runtime.replay_only,
            reason: runtime.reason.clone(),
        },
        None => registry.last_event.clone().unwrap_or(ReplayStateEvent {
            state: ReplayBufferState::Off,
            session_id: None,
            seconds: DEFAULT_SECONDS,
            buffered_seconds: 0.0,
            replay_only: false,
            reason: None,
        }),
    }
}

fn emit_state(state: &AppState) {
    let event = snapshot(state);
    {
        let mut registry = lock(state);
        if registry.active.is_none() {
            registry.last_event = Some(event.clone());
        }
    }
    state.emit_event("replay.state", event);
}

/// One prune pass over a ring directory.
#[derive(Debug, Clone, PartialEq)]
pub struct PruneReport {
    /// What the complete segments hold, capped at the ring's length.
    pub buffered_seconds: f64,
    pub listed: usize,
    pub deleted: Vec<String>,
    /// Every `seg-*.ts` left in the directory after the pass.
    pub segment_files: usize,
}

/// Reads `segments.csv`, deletes every segment older than the list and
/// reports the ring's fill. Synchronous and small: the list holds at most a
/// few hundred lines and the directory a few hundred files.
pub fn prune_tick(dir: &Path, seconds: u32) -> PruneReport {
    let listed = std::fs::read_to_string(dir.join(SEGMENT_LIST_FILE))
        .map(|text| parse_segment_list(&text))
        .unwrap_or_default();
    let names = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| segment_index(name).is_some())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let doomed = segments_to_prune(&names, &listed);
    let mut deleted = Vec::new();
    for name in doomed {
        if std::fs::remove_file(dir.join(&name)).is_ok() {
            deleted.push(name);
        }
    }
    let covered: f64 = listed.iter().map(Segment::duration_seconds).sum();
    let segment_files = names.len().saturating_sub(deleted.len());
    PruneReport {
        buffered_seconds: covered.min(f64::from(clamp_seconds(seconds))),
        listed: listed.len(),
        deleted,
        segment_files,
    }
}

/// The wall-clock start of a replay that ends now and holds `covered`
/// seconds, as RFC 3339 for the Library row.
pub fn replay_started_at(covered_seconds: f64) -> String {
    let millis = (covered_seconds.max(0.0) * 1000.0) as i64;
    (Utc::now() - chrono::Duration::milliseconds(millis)).to_rfc3339()
}

#[cfg(test)]
mod runtime_tests {
    use super::*;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn write_ring(dir: &Path, indexes: std::ops::Range<u32>, listed: std::ops::Range<u32>) {
        std::fs::create_dir_all(dir).unwrap();
        for index in indexes {
            std::fs::write(dir.join(format!("seg-{index:06}.ts")), b"ts").unwrap();
        }
        let list = listed
            .map(|index| {
                format!(
                    "seg-{index:06}.ts,{:.6},{:.6}\n",
                    f64::from(index) * 2.0,
                    f64::from(index) * 2.0 + 2.0
                )
            })
            .collect::<String>();
        std::fs::write(dir.join(SEGMENT_LIST_FILE), list).unwrap();
    }

    #[test]
    fn prune_tick_trims_to_the_list_and_reports_the_fill() {
        let dir =
            std::env::temp_dir().join(format!("videorc-replay-prune-{}", uuid::Uuid::new_v4()));
        // 20 files on disk, the list holds 3..=19, 20 is being written.
        write_ring(&dir, 0..21, 3..20);
        let report = prune_tick(&dir, 30);
        assert_eq!(report.listed, 17);
        assert_eq!(
            report.deleted,
            vec!["seg-000000.ts", "seg-000001.ts", "seg-000002.ts"]
        );
        assert_eq!(report.segment_files, 18);
        assert_eq!(report.buffered_seconds, 30.0);
        assert!(!dir.join("seg-000000.ts").exists());
        assert!(dir.join("seg-000003.ts").exists());
        assert!(dir.join("seg-000020.ts").exists());
        // A second pass is a no-op.
        let again = prune_tick(&dir, 30);
        assert!(again.deleted.is_empty());
        assert_eq!(again.segment_files, 18);
        // A filling ring reports what it holds.
        write_ring(&dir, 0..3, 0..2);
        let filling = prune_tick(&dir, 30);
        assert_eq!(filling.buffered_seconds, 4.0);
        assert!(filling.deleted.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prune_tick_on_a_missing_ring_is_empty() {
        let dir =
            std::env::temp_dir().join(format!("videorc-replay-missing-{}", uuid::Uuid::new_v4()));
        let report = prune_tick(&dir, 30);
        assert_eq!(report.buffered_seconds, 0.0);
        assert_eq!(report.listed, 0);
        assert_eq!(report.segment_files, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn prepare_attach_and_retire_own_the_ring_directory_and_the_state() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let params: StartSessionParams = serde_json::from_value(serde_json::json!({
            "sources": { "screenId": null, "windowId": null, "cameraId": null, "microphoneId": null, "testPattern": true },
            "layout": { "cameraCorner": "bottom-right", "cameraSize": "medium", "cameraShape": "rectangle", "cameraMargin": 32 },
            "output": {
                "recordEnabled": false,
                "streamEnabled": false,
                "outputDirectory": null,
                "ffmpegPath": null,
                "video": { "preset": "tutorial-1080p30", "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 8000 },
                "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
            },
            "replay": { "seconds": 30 }
        }))
        .unwrap();
        assert!(params.replay_only());
        let recordings = std::env::temp_dir().join("videorc-replay-recordings-test");
        let guard = prepare(
            &state,
            RingRequest {
                session_id: "session-a",
                params: &params,
                replay_only: true,
                recordings_dir: &recordings,
                ffmpeg_path: "ffmpeg",
            },
        )
        .unwrap();
        assert!(guard.dir.is_dir());
        assert_eq!(guard.seconds, 30);
        let starting = events.recv().await.unwrap();
        assert_eq!(starting.event, "replay.state");
        assert_eq!(starting.payload["state"], "starting");
        assert_eq!(starting.payload["replayOnly"], true);
        assert_eq!(snapshot(&state).state, ReplayBufferState::Starting);
        assert_eq!(
            active_replay_only_session_id(&state).as_deref(),
            Some("session-a")
        );

        let dir = guard.dir.clone();
        attach(&state, guard);
        let on = events.recv().await.unwrap();
        assert_eq!(on.payload["state"], "on");
        assert_eq!(on.payload["sessionId"], "session-a");
        assert_eq!(on.payload["seconds"], 30);

        retire(&state, "session-a", RetireOutcome::Stopped);
        let off = events.recv().await.unwrap();
        assert_eq!(off.payload["state"], "off");
        assert!(off.payload.get("sessionId").is_none());
        assert!(!dir.exists(), "the ring is deleted when the session ends");
        assert_eq!(active_replay_only_session_id(&state), None);
        assert_eq!(snapshot(&state).state, ReplayBufferState::Off);
        // Retiring another session is a no-op.
        retire(&state, "session-b", RetireOutcome::Stopped);

        // A failed start drops the guard: the ring goes, the state says why.
        let guard = prepare(
            &state,
            RingRequest {
                session_id: "session-c",
                params: &params,
                replay_only: false,
                recordings_dir: &recordings,
                ffmpeg_path: "ffmpeg",
            },
        )
        .unwrap();
        let dir = guard.dir.clone();
        let _ = events.recv().await.unwrap();
        drop(guard);
        assert!(!dir.exists());
        let dropped = events.recv().await.unwrap();
        assert_eq!(dropped.payload["state"], "off");
        assert_eq!(dropped.payload["reason"], "The session did not start.");

        // A failure retires with the reason.
        let guard = prepare(
            &state,
            RingRequest {
                session_id: "session-d",
                params: &params,
                replay_only: true,
                recordings_dir: &recordings,
                ffmpeg_path: "ffmpeg",
            },
        )
        .unwrap();
        let _ = events.recv().await.unwrap();
        attach(&state, guard);
        let _ = events.recv().await.unwrap();
        retire(
            &state,
            "session-d",
            RetireOutcome::Failed("FFmpeg exited.".to_string()),
        );
        let failed = events.recv().await.unwrap();
        assert_eq!(failed.payload["state"], "error");
        assert_eq!(failed.payload["reason"], "FFmpeg exited.");
        clean_leftovers(&state);
        assert!(!ring_root(&state).exists());
    }

    #[test]
    fn rowless_sessions_are_remembered_briefly() {
        let state = test_state();
        for index in 0..ROWLESS_SESSION_MEMORY + 2 {
            register_rowless_session(&state, &format!("s{index}"));
        }
        assert!(!is_rowless_session(&state, "s0"));
        assert!(!is_rowless_session(&state, "s1"));
        assert!(is_rowless_session(&state, "s2"));
        assert!(is_rowless_session(
            &state,
            &format!("s{}", ROWLESS_SESSION_MEMORY + 1)
        ));
        assert!(!is_rowless_session(&state, "never"));
    }
}

#[cfg(test)]
mod pure_tests {
    use super::*;

    fn segment(index: u32, start: f64, end: f64) -> Segment {
        Segment {
            file_name: format!("seg-{index:06}.ts"),
            start_seconds: start,
            end_seconds: end,
        }
    }

    #[test]
    fn segment_index_reads_only_our_names() {
        assert_eq!(segment_index("seg-000012.ts"), Some(12));
        assert_eq!(segment_index("/tmp/ring/seg-000000.ts"), Some(0));
        assert_eq!(segment_index("seg-12.ts"), Some(12));
        assert_eq!(segment_index("seg-.ts"), None);
        assert_eq!(segment_index("segments.csv"), None);
        assert_eq!(segment_index("seg-00001a.ts"), None);
        assert_eq!(segment_index("other-000001.ts"), None);
    }

    #[test]
    fn parses_the_csv_list_and_skips_half_written_lines() {
        let text = "seg-000003.ts,6.000000,8.016667\nseg-000004.ts,8.016667,10.0\nseg-000005.ts,10.0\nnot-ours.ts,1,2\n\nseg-000002.ts,4.0,6.0\n";
        let list = parse_segment_list(text);
        assert_eq!(
            list,
            vec![
                segment(2, 4.0, 6.0),
                segment(3, 6.0, 8.016667),
                segment(4, 8.016667, 10.0),
            ]
        );
        assert!(parse_segment_list("").is_empty());
        assert!(parse_segment_list("seg-000001.ts,5.0,4.0").is_empty());
    }

    #[test]
    fn keep_count_covers_the_window_with_one_spare() {
        assert_eq!(keep_count(30), 17);
        assert_eq!(keep_count(15), 10);
        assert_eq!(keep_count(60), 32);
        assert_eq!(keep_count(300), 152);
        // Clamped: a 1 s request is a 5 s buffer.
        assert_eq!(keep_count(1), keep_count(MIN_SECONDS));
        assert_eq!(max_segment_files(30), 18);
    }

    #[test]
    fn prunes_only_segments_older_than_the_list() {
        let dir = vec![
            "seg-000000.ts".to_string(),
            "seg-000001.ts".to_string(),
            "seg-000002.ts".to_string(),
            "seg-000003.ts".to_string(),
            "seg-000004.ts".to_string(),
            "segments.csv".to_string(),
            "segments.csv.tmp".to_string(),
            "staging-abc".to_string(),
        ];
        let listed = vec![segment(2, 4.0, 6.0), segment(3, 6.0, 8.0)];
        assert_eq!(
            segments_to_prune(&dir, &listed),
            vec!["seg-000000.ts".to_string(), "seg-000001.ts".to_string()]
        );
        // The one being written (index 4) and non-segment files stay.
        assert!(segments_to_prune(&dir, &[]).is_empty());
    }

    #[test]
    fn selects_the_newest_segments_that_cover_the_window() {
        let listed = (0..17)
            .map(|index| segment(index, f64::from(index) * 2.0, f64::from(index) * 2.0 + 2.0))
            .collect::<Vec<_>>();
        let selection = select_segments(&listed, 30);
        assert!(selection.complete);
        assert_eq!(selection.segments.len(), 15);
        assert_eq!(selection.covered_seconds, 30.0);
        assert_eq!(
            selection.segments.first().map(|segment| segment.index()),
            Some(Some(2))
        );
        assert_eq!(
            selection.segments.last().map(|segment| segment.index()),
            Some(Some(16))
        );

        // Keyframe alignment: 2.017 s segments need 15 of them for 30 s and
        // the result runs long, never short.
        let uneven = (0..17)
            .map(|index| {
                segment(
                    index,
                    f64::from(index) * 2.017,
                    f64::from(index) * 2.017 + 2.017,
                )
            })
            .collect::<Vec<_>>();
        let selection = select_segments(&uneven, 30);
        assert!(selection.complete);
        assert_eq!(selection.segments.len(), 15);
        assert!(selection.covered_seconds >= 30.0);
        assert!(selection.covered_seconds <= duration_window(30).1);
    }

    #[test]
    fn a_filling_buffer_reports_what_it_holds() {
        let listed = vec![
            segment(0, 0.0, 2.0),
            segment(1, 2.0, 4.0),
            segment(2, 4.0, 6.0),
        ];
        let selection = select_segments(&listed, 30);
        assert!(!selection.complete);
        assert_eq!(selection.segments.len(), 3);
        assert_eq!(selection.covered_seconds, 6.0);
        let empty = select_segments(&[], 30);
        assert!(empty.is_empty());
        assert!(!empty.complete);
    }

    #[test]
    fn concat_list_quotes_paths_and_carries_durations() {
        let selection = select_segments(&[segment(7, 14.0, 16.0), segment(8, 16.0, 18.0)], 4);
        let script = concat_list(&selection, Path::new("/tmp/it's a ring"));
        assert_eq!(
            script,
            "ffconcat version 1.0\nfile '/tmp/it'\\''s a ring/seg-000007.ts'\nduration 2.000000\nfile '/tmp/it'\\''s a ring/seg-000008.ts'\nduration 2.000000\n"
        );
    }

    #[test]
    fn segment_muxer_args_describe_a_live_csv_ring() {
        let args = segment_muxer_args(Path::new("/ring"), 30);
        let joined = args.join(" ");
        assert!(
            joined.starts_with(
                "-f segment -segment_format mpegts -segment_time 2 -reset_timestamps 0"
            )
        );
        assert!(joined.contains("-segment_list /ring/segments.csv -segment_list_type csv -segment_list_size 17 -segment_list_flags +live"));
        assert_eq!(args.last().map(String::as_str), Some("/ring/seg-%06d.ts"));
    }

    #[test]
    fn replay_audio_is_aac_192k_with_the_session_filter() {
        assert_eq!(
            replay_audio_encoding_args(Some("volume=1.0"), 2),
            vec![
                "-af",
                "volume=1.0",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-c:a",
                "aac",
                "-b:a",
                "192k"
            ]
        );
        assert_eq!(
            replay_audio_encoding_args(None, 0),
            vec!["-ar", "48000", "-ac", "1", "-c:a", "aac", "-b:a", "192k"]
        );
    }

    #[test]
    fn save_args_stream_copy_into_a_faststart_mp4() {
        let args = save_args(
            Path::new("/ring/list.txt"),
            Path::new("/out/Replay.mp4.partial"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-f concat -safe 0 -i /ring/list.txt"));
        assert!(joined.contains(
            "-map 0:v:0 -map 0:a? -c copy -movflags +faststart -f mp4 /out/Replay.mp4.partial"
        ));
        assert!(joined.starts_with("-n -hide_banner"));
    }

    #[test]
    fn file_names_and_folders_follow_d7() {
        let at = chrono::FixedOffset::east_opt(2 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 10, 12, 18, 30, 5)
            .unwrap();
        assert_eq!(replay_file_name(&at), "Replay 2026-10-12 18-30-05.mp4");
        assert_eq!(
            replays_dir(Path::new("/Users/me/Movies")),
            PathBuf::from("/Users/me/Movies/Replays")
        );
        assert_eq!(
            partial_path(Path::new(
                "/Users/me/Movies/Replays/Replay 2026-10-12 18-30-05.mp4"
            )),
            PathBuf::from("/Users/me/Movies/Replays/Replay 2026-10-12 18-30-05.mp4.partial")
        );
        assert_eq!(replay_title(), "Replay");
    }

    #[test]
    fn disk_math_is_bounded_by_the_ring() {
        // 8 Mbps video + 192 kbps audio = 1 024 000 bytes/s.
        assert_eq!(bytes_per_second(8000), 1_024_000);
        assert_eq!(estimated_disk_bytes(30, 8000), 18 * 2 * 1_024_000);
        assert_eq!(required_free_bytes(30, 8000), 4 * 30 * 1_024_000);
        assert_eq!(duration_window(30), (30.0, 32.5));
        assert_eq!(clamp_seconds(1), MIN_SECONDS);
        assert_eq!(clamp_seconds(10_000), MAX_SECONDS);
        assert_eq!(clamp_seconds(45), 45);
    }

    #[test]
    fn split_video_filter_feeds_both_outputs_from_one_encode_graph() {
        assert_eq!(
            split_video_filter_for_replay("[0:v]setpts=PTS-STARTPTS,fps=30[v_main]").as_deref(),
            Some(
                "[0:v]setpts=PTS-STARTPTS,fps=30[v_replay_src];[v_replay_src]split=2[v_main][v_replay]"
            )
        );
        // The legacy graph keeps its preview branch after `[v_main]`.
        assert_eq!(
            split_video_filter_for_replay("[v]split=2[v_main_rgb][v_preview];[v_main_rgb]format=yuv420p[v_main];[v_preview]scale=320:-2[preview]").as_deref(),
            Some("[v]split=2[v_main_rgb][v_preview];[v_main_rgb]format=yuv420p[v_replay_src];[v_preview]scale=320:-2[preview];[v_replay_src]split=2[v_main][v_replay]")
        );
        assert_eq!(split_video_filter_for_replay("[0:v]null[out]"), None);
    }
}
