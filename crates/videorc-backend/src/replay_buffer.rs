//! The replay buffer (plan 181): a session keeps the last N seconds of the
//! composed program as a rolling set of 2-second MPEG-TS segments, and a
//! clip (the owner's word, redesign R4: the Clip button, `/clip`, the
//! spoken "clip that") stream-copies the newest segments into an MP4.
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
/// The shortest and longest buffer a session accepts (the renderer keeps a
/// fixed 1-min ring since plan 199; the wire clamps anything else here, and
/// smokes may ask for a shorter ring).
pub const MIN_SECONDS: u32 = 5;
pub const MAX_SECONDS: u32 = 600;
/// The ring's length when no session reports one (`replay.status` while
/// off). Plan 199: the ring always keeps the longest clip.
pub const DEFAULT_SECONDS: u32 = LONG_CLIP_SECONDS;
/// A press that names no length saves this many seconds, exactly as before
/// plan 199. Mirrored in `shared/clip-marks.ts` (`DEFAULT_CLIP_SECONDS`).
pub const DEFAULT_CLIP_SECONDS: u32 = 30;
/// The 1-minute clip (plan 199). Mirrored in `shared/clip-marks.ts`
/// (`LONG_CLIP_SECONDS`).
pub const LONG_CLIP_SECONDS: u32 = 60;
/// The two lengths a clip press may ask for (plan 199): today's 30-second
/// clip and the 1-minute clip. Mirrored in `shared/clip-marks.ts`
/// (`CLIP_LENGTHS`).
pub const CLIP_LENGTHS: [u32; 2] = [DEFAULT_CLIP_SECONDS, LONG_CLIP_SECONDS];
/// The refusal code for a length that is not in [`CLIP_LENGTHS`]. Mirrored in
/// `shared/clip-marks.ts`.
pub const INVALID_CLIP_LENGTH_CODE: &str = "invalid-clip-length";
/// What the refusal says. Mirrored in `shared/clip-marks.ts`.
pub const INVALID_CLIP_LENGTH_MESSAGE: &str = "A clip is 30 seconds or 1 minute.";
/// A saved replay may run this much past its target length: the start is
/// keyframe-aligned (D3), so up to one segment is added, plus a little slack
/// for the muxer's own cut point.
pub const MAX_OVERSHOOT_SECONDS: f64 = 2.5;
/// How long `replay.save` waits for the segment that holds the press to
/// close before it saves what is complete.
pub const SAVE_BOUNDARY_TIMEOUT_MS: u64 = 4_000;
/// Clips go here, under the recordings folder (D7, renamed by the owner's
/// redesign R4).
pub const REPLAYS_FOLDER_NAME: &str = "Clips";

/// A complete segment as `segments.csv` lists it: `filename,start,end` with
/// stream-time seconds. FFmpeg's `end` is the start of the segment's last
/// frame, not the end of it, so `end - start` is one frame short of what the
/// segment holds (plan 200 B1).
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub file_name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

impl Segment {
    /// The listed span, `end - start`: one frame short of the segment.
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

/// The length a press asked for (plan 199): no length is today's 30 s, and
/// anything outside [`CLIP_LENGTHS`] is refused before any work starts.
pub fn requested_clip_seconds(requested: Option<u32>) -> Result<u32, SaveRefusal> {
    match requested {
        None => Ok(DEFAULT_CLIP_SECONDS),
        Some(seconds) if CLIP_LENGTHS.contains(&seconds) => Ok(seconds),
        Some(_) => Err(SaveRefusal::invalid_length()),
    }
}

/// How many seconds a press saves from a ring of `ring_seconds`: the
/// requested length, clamped to what the ring keeps (a smoke's 15-s ring
/// saves 15 s, and the event says so).
pub fn clip_seconds(requested: Option<u32>, ring_seconds: u32) -> Result<u32, SaveRefusal> {
    requested_clip_seconds(requested).map(|seconds| seconds.min(clamp_seconds(ring_seconds)))
}

/// How many complete segments the list keeps: enough to cover N seconds
/// after keyframe alignment, plus one spare so a save that lands right on a
/// cut still has its full window.
pub fn keep_count(seconds: u32) -> usize {
    let seconds = clamp_seconds(seconds);
    (seconds as usize).div_ceil(SEGMENT_SECONDS as usize) + 2
}

/// The ring's disk bound: the kept segments plus the one being written.
#[cfg(test)]
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

/// One frame of the ring: `1 / fps`, or, when the rate is unknown, the
/// median gap between a segment's listed end and the next segment's start
/// (the list's end is the start of the last frame, so that gap is one
/// frame). Zero when neither is known.
pub fn frame_seconds(listed: &[Segment], fps: Option<u32>) -> f64 {
    if let Some(fps) = fps.filter(|fps| *fps > 0) {
        return 1.0 / f64::from(fps);
    }
    let mut gaps = listed
        .windows(2)
        .map(|pair| pair[1].start_seconds - pair[0].end_seconds)
        .filter(|gap| gap.is_finite() && *gap >= 0.0)
        .collect::<Vec<_>>();
    if gaps.is_empty() {
        return 0.0;
    }
    gaps.sort_by(f64::total_cmp);
    gaps[gaps.len() / 2]
}

/// What `segments[index]` holds on the timeline (plan 200 B1): up to the
/// next segment's start, and for the newest its listed span plus one frame.
fn held_seconds(segments: &[Segment], index: usize, frame_seconds: f64) -> f64 {
    let segment = &segments[index];
    match segments.get(index + 1) {
        Some(next) => (next.start_seconds - segment.start_seconds).max(0.0),
        None => segment.duration_seconds() + frame_seconds,
    }
}

/// Walks the list from the newest segment back until `seconds` are covered
/// (D3: the start is the first keyframe at or before N seconds ago, so the
/// result runs N to N + one segment). Coverage counts what each segment
/// holds ([`held_seconds`]); `fps` is the ring's frame rate when known.
pub fn select_segments(listed: &[Segment], seconds: u32, fps: Option<u32>) -> Selection {
    // The list carries microseconds; a sum that lands a rounding error under
    // the target still covers it.
    const COVERAGE_TOLERANCE_SECONDS: f64 = 1.0e-6;
    let target = f64::from(clamp_seconds(seconds)) - COVERAGE_TOLERANCE_SECONDS;
    let frame = frame_seconds(listed, fps);
    let mut first = listed.len();
    let mut covered = 0.0;
    while first > 0 && covered < target {
        first -= 1;
        covered += held_seconds(listed, first, frame);
    }
    Selection {
        complete: covered >= target,
        covered_seconds: covered,
        segments: listed[first..].to_vec(),
    }
}

/// The ffconcat script for a selection: absolute paths, quoted the way the
/// concat demuxer wants them (`'` becomes `'\''`). Plan 200 B1: each
/// segment's `duration` is the gap to the next segment's start, so the next
/// file starts right after this one's last frame; the listed span (one frame
/// short) squashed that frame to one tick at every join. The last segment
/// gets no `duration`, so the demuxer reads it from the file.
pub fn concat_list(selection: &Selection, segment_dir: &Path) -> String {
    let mut script = String::from("ffconcat version 1.0\n");
    for (index, segment) in selection.segments.iter().enumerate() {
        let path = segment_dir.join(&segment.file_name);
        let quoted = path.display().to_string().replace('\'', "'\\''");
        script.push_str(&format!("file '{quoted}'\n"));
        if let Some(next) = selection.segments.get(index + 1) {
            let duration = (next.start_seconds - segment.start_seconds).max(0.0);
            script.push_str(&format!("duration {duration:.6}\n"));
        }
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

/// `Clip 2026-10-12 18-30-05.mp4`: the user's wall clock, no characters a
/// file system or a shell would mind (D7).
pub fn replay_file_name<Tz: TimeZone>(now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    format!("Clip {}.mp4", now.format("%Y-%m-%d %H-%M-%S"))
}

/// The Library row's title for a saved clip.
pub fn replay_title() -> &'static str {
    "Clip"
}

/// Where a clip goes: `<recordings folder>/Clips`.
pub fn replays_dir(recordings_dir: &Path) -> PathBuf {
    recordings_dir.join(REPLAYS_FOLDER_NAME)
}

/// The partial file a save writes before its rename, beside the target.
pub fn partial_path(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Clip.mp4".to_string());
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
#[cfg(test)]
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
#[cfg(test)]
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
    /// Segment files on disk after the last prune pass.
    pub segment_files: Option<u32>,
    prune_task: Option<JoinHandle<()>>,
    /// A save is running on its own task.
    pub save_in_progress: bool,
    /// One more save is waiting behind the running one (plan 181 S3).
    pub queued_save: Option<QueuedSave>,
}

/// The save waiting behind the running one: its accepted id, what asked for
/// it, and its length (plan 199: a press that joins it raises the length to
/// the longer of the two, so nobody loses footage).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedSave {
    pub save_id: String,
    pub source: Option<ClipMarkSource>,
    pub seconds: u32,
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
    /// A buffer-only `session.start` is between admission and its running
    /// session (see `begin_start_in_flight`).
    start_in_flight: bool,
}

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, ReplayRegistry> {
    state
        .replay
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Marks a buffer-only start in flight for the whole of its `session.start`
/// (the ring runs by default and re-arms right after every Stop, so a Record
/// pressed in that gap used to meet "A capture session is starting"). The
/// handover waits for the flag instead; dropping the guard clears it,
/// whether the start ran or failed.
pub struct StartInFlightGuard {
    state: AppState,
}

pub fn begin_start_in_flight(state: &AppState) -> StartInFlightGuard {
    lock(state).start_in_flight = true;
    StartInFlightGuard {
        state: state.clone(),
    }
}

impl Drop for StartInFlightGuard {
    fn drop(&mut self) {
        lock(&self.state).start_in_flight = false;
    }
}

pub fn start_in_flight(state: &AppState) -> bool {
    lock(state).start_in_flight
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
#[cfg(test)]
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
                segment_files: None,
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
            "Not enough free space to keep the last seconds: it needs about {} MB free and this disk has {} MB.",
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
        segment_files: None,
        prune_task: None,
        save_in_progress: false,
        queued_save: None,
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
                runtime.segment_files =
                    Some(u32::try_from(report.segment_files).unwrap_or(u32::MAX));
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
            segment_files: None,
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
            segment_files: runtime.segment_files,
        },
        None => registry.last_event.clone().unwrap_or(ReplayStateEvent {
            state: ReplayBufferState::Off,
            session_id: None,
            seconds: DEFAULT_SECONDS,
            buffered_seconds: 0.0,
            replay_only: false,
            reason: None,
            segment_files: None,
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
    let frame = frame_seconds(&listed, None);
    let covered: f64 = (0..listed.len())
        .map(|index| held_seconds(&listed, index, frame))
        .sum();
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

// ---------------------------------------------------------------------------
// Save replay (plan 181 S3).
// ---------------------------------------------------------------------------

use crate::protocol::{
    ClipMarkSource, ReplaySaveAccepted, ReplaySaveFailedEvent, ReplaySavedEvent,
};
use crate::storage::NewSession;

/// How long one save may run (boundary wait, concat, probe) before it is
/// reported failed.
const SAVE_TIMEOUT: Duration = Duration::from_secs(45);
/// The boundary poll: the list file is rewritten on every cut.
const BOUNDARY_POLL: Duration = Duration::from_millis(100);
/// A probed replay may run this much short of its selection: the muxer's
/// own cut lands a few frames either side of the list's seconds.
const DURATION_SHORTFALL_SECONDS: f64 = 0.75;

/// Why `replay.save` was refused before any work started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveRefusal {
    pub code: &'static str,
    pub message: String,
}

impl SaveRefusal {
    fn off() -> Self {
        Self {
            code: "replay-off",
            message: "Clips are off, so there is nothing to save.".to_string(),
        }
    }

    fn starting() -> Self {
        Self {
            code: "replay-starting",
            message: "Clips are still starting. Try again in a moment.".to_string(),
        }
    }

    fn invalid_length() -> Self {
        Self {
            code: INVALID_CLIP_LENGTH_CODE,
            message: INVALID_CLIP_LENGTH_MESSAGE.to_string(),
        }
    }
}

/// The `session.start` error code for a buffer-only start the renderer did
/// not choose (`ReplayParams::auto`) on a software encoder path. Mirrored in
/// the renderer, which then keeps the switch off and says why.
pub const SOFTWARE_ENCODER_REFUSAL_CODE: &str = "replay-software-encoder";

/// Why an automatic buffer-only start was refused (owner redesign, guard):
/// the ring on a raw CPU encode path is a second encode on a computer that
/// already struggles with one, so it never runs on its own there. The user
/// may still turn it on (`auto: false`).
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AutoStartRefused {
    pub message: String,
}

/// The automatic start's verdict for the encoder a session would use. `None`
/// means run.
pub fn auto_start_refusal(backend: crate::protocol::EncodeBackend) -> Option<AutoStartRefused> {
    use crate::protocol::EncodeBackend;
    let encoder = match backend {
        EncodeBackend::SoftwareOpenH264 => "OpenH264",
        EncodeBackend::SoftwareMediaFoundation => "a software Media Foundation encoder",
        EncodeBackend::SoftwareX264 => "x264",
        EncodeBackend::HardwareVideotoolbox
        | EncodeBackend::HardwareVaapi
        | EncodeBackend::HardwareMediaFoundation
        | EncodeBackend::HardwareQsv => return None,
    };
    Some(AutoStartRefused {
        message: format!(
            "This computer encodes video on its processor ({encoder}), so keeping the last seconds would run a second encode. Turn it on here if the computer keeps up."
        ),
    })
}

/// `replay.save`: answers at once. A running save takes the next press as
/// one queued save; a third press while one is queued joins it. `seconds` is
/// the press's length (plan 199): `None` is today's 30 s, anything outside
/// [`CLIP_LENGTHS`] is refused, and the result is clamped to the ring.
pub fn request_save(
    state: &AppState,
    source: Option<ClipMarkSource>,
    seconds: Option<u32>,
) -> Result<ReplaySaveAccepted, SaveRefusal> {
    // A length nobody offers is refused whatever the ring is doing.
    requested_clip_seconds(seconds)?;
    let (session_id, save_id, queued, seconds) = {
        let mut registry = lock(state);
        let Some(runtime) = registry.active.as_mut() else {
            return Err(SaveRefusal::off());
        };
        match runtime.state {
            ReplayBufferState::On => {}
            ReplayBufferState::Starting => return Err(SaveRefusal::starting()),
            ReplayBufferState::Off | ReplayBufferState::Error => return Err(SaveRefusal::off()),
        }
        let seconds = clip_seconds(seconds, runtime.seconds)?;
        let session_id = runtime.session_id.clone();
        if runtime.save_in_progress {
            let queued = join_queued_save(&mut runtime.queued_save, source, seconds);
            (session_id, queued.save_id, true, queued.seconds)
        } else {
            let save_id = uuid::Uuid::new_v4().to_string();
            runtime.save_in_progress = true;
            runtime.queued_save = None;
            let task_state = state.clone();
            let first = QueuedSave {
                save_id: save_id.clone(),
                source,
                seconds,
            };
            tokio::spawn(async move { run_saves(task_state, first).await });
            (session_id, save_id, false, seconds)
        }
    };
    Ok(ReplaySaveAccepted {
        save_id,
        session_id,
        queued,
        seconds,
    })
}

/// A press while a save runs: the first one queues a save, every later one
/// joins it and raises its length to the longer of the two. Returns the
/// queued save as it now stands (its id and length are the press's answer).
fn join_queued_save(
    queued_save: &mut Option<QueuedSave>,
    source: Option<ClipMarkSource>,
    seconds: u32,
) -> QueuedSave {
    if let Some(queued) = queued_save.as_mut() {
        queued.seconds = queued.seconds.max(seconds);
        return queued.clone();
    }
    queued_save
        .insert(QueuedSave {
            save_id: uuid::Uuid::new_v4().to_string(),
            source,
            seconds,
        })
        .clone()
}

/// One save, then the queued one if a press landed meanwhile.
async fn run_saves(state: AppState, first: QueuedSave) {
    let mut next = Some(first);
    while let Some(QueuedSave {
        save_id,
        source,
        seconds,
    }) = next.take()
    {
        let outcome = tokio::time::timeout(
            SAVE_TIMEOUT,
            perform_save(&state, &save_id, source, seconds),
        )
        .await;
        match outcome {
            Ok(Ok(event)) => state.emit_event("replay.saved", event),
            Ok(Err(failure)) => {
                tracing::warn!("Replay save {save_id} failed: {}", failure.message);
                state.emit_event("replay.saveFailed", failure);
            }
            Err(_) => state.emit_event(
                "replay.saveFailed",
                ReplaySaveFailedEvent {
                    save_id: save_id.clone(),
                    session_id: None,
                    reason: "timeout".to_string(),
                    message: "Saving the clip took too long and was stopped.".to_string(),
                },
            ),
        }
        let mut registry = lock(&state);
        if let Some(runtime) = registry.active.as_mut() {
            next = runtime.queued_save.take();
            if next.is_none() {
                runtime.save_in_progress = false;
            }
        }
    }
}

/// The ring facts a save works from, copied out of the registry so the
/// save never holds the lock across I/O.
struct SaveSnapshot {
    session_id: String,
    /// The press's length (plan 199), not the ring's: what the save selects
    /// and what `replay.saved` reports.
    seconds: u32,
    dir: PathBuf,
    recordings_dir: PathBuf,
    ffmpeg_path: String,
    sources: SourceSelection,
    layout: LayoutSettings,
    output: OutputSettings,
}

fn save_snapshot(state: &AppState, seconds: u32) -> Option<SaveSnapshot> {
    let registry = lock(state);
    let runtime = registry.active.as_ref()?;
    if runtime.state != ReplayBufferState::On {
        return None;
    }
    Some(SaveSnapshot {
        session_id: runtime.session_id.clone(),
        seconds,
        dir: runtime.dir.clone(),
        recordings_dir: runtime.recordings_dir.clone(),
        ffmpeg_path: runtime.ffmpeg_path.clone(),
        sources: runtime.sources.clone(),
        layout: runtime.layout.clone(),
        output: runtime.output.clone(),
    })
}

fn failure(
    save_id: &str,
    session_id: Option<&str>,
    reason: &str,
    message: impl Into<String>,
) -> ReplaySaveFailedEvent {
    ReplaySaveFailedEvent {
        save_id: save_id.to_string(),
        session_id: session_id.map(str::to_string),
        reason: reason.to_string(),
        message: message.into(),
    }
}

fn read_listed(dir: &Path) -> Vec<Segment> {
    std::fs::read_to_string(dir.join(SEGMENT_LIST_FILE))
        .map(|text| parse_segment_list(&text))
        .unwrap_or_default()
}

fn newest_listed_index(dir: &Path) -> Option<u32> {
    read_listed(dir).iter().filter_map(Segment::index).max()
}

/// Waits for the segment that holds the press to close: the newest listed
/// index must move past what it was at the press. After the timeout the
/// save takes what is complete.
async fn wait_for_boundary(dir: &Path) -> Vec<Segment> {
    let at_press = newest_listed_index(dir);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(SAVE_BOUNDARY_TIMEOUT_MS);
    loop {
        let listed = read_listed(dir);
        let newest = listed.iter().filter_map(Segment::index).max();
        if newest > at_press {
            return listed;
        }
        if tokio::time::Instant::now() >= deadline {
            return listed;
        }
        tokio::time::sleep(BOUNDARY_POLL).await;
    }
}

/// A target that does not exist yet: ` (2)`, ` (3)` … when the second is
/// already taken.
fn unused_target(replays: &Path, file_name: &str) -> PathBuf {
    let first = replays.join(file_name);
    if !first.exists() && !partial_path(&first).exists() {
        return first;
    }
    let stem = file_name.strip_suffix(".mp4").unwrap_or(file_name);
    (2..)
        .map(|n| replays.join(format!("{stem} ({n}).mp4")))
        .find(|path| !path.exists() && !partial_path(path).exists())
        .expect("an unused replay name")
}

/// What `ffprobe -show_format -show_streams -of json` says about a replay.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayProbe {
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub duration_seconds: Option<f64>,
}

pub fn parse_replay_probe(json: &str) -> Result<ReplayProbe, String> {
    #[derive(serde::Deserialize)]
    struct Stream {
        codec_type: Option<String>,
        codec_name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Format {
        duration: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Output {
        #[serde(default)]
        streams: Vec<Stream>,
        format: Option<Format>,
    }
    let output: Output =
        serde_json::from_str(json).map_err(|error| format!("ffprobe JSON: {error}"))?;
    let codec = |kind: &str| {
        output
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some(kind))
            .and_then(|stream| stream.codec_name.clone())
    };
    Ok(ReplayProbe {
        video_codec: codec("video"),
        audio_codec: codec("audio"),
        duration_seconds: output
            .format
            .and_then(|format| format.duration)
            .and_then(|duration| duration.parse().ok()),
    })
}

/// The check a saved replay must pass before it is renamed into place:
/// H.264 video, AAC audio, and a length that matches the selection.
pub fn check_replay_probe(probe: &ReplayProbe, covered_seconds: f64) -> Result<f64, String> {
    if probe.video_codec.as_deref() != Some("h264") {
        return Err(format!(
            "the clip has no H.264 video ({})",
            probe.video_codec.as_deref().unwrap_or("none")
        ));
    }
    if probe.audio_codec.as_deref() != Some("aac") {
        return Err(format!(
            "the clip has no AAC audio ({})",
            probe.audio_codec.as_deref().unwrap_or("none")
        ));
    }
    let Some(duration) = probe.duration_seconds.filter(|value| value.is_finite()) else {
        return Err("the clip has no duration".to_string());
    };
    let shortest = (covered_seconds - DURATION_SHORTFALL_SECONDS).max(0.0);
    let longest = covered_seconds + MAX_OVERSHOOT_SECONDS;
    if duration < shortest || duration > longest {
        return Err(format!(
            "the clip is {duration:.2} s long, expected {shortest:.2} s to {longest:.2} s"
        ));
    }
    Ok(duration)
}

async fn probe_replay(ffprobe_path: &str, path: &Path) -> Result<ReplayProbe, String> {
    let mut command = tokio::process::Command::new(ffprobe_path);
    command
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = crate::process_job::output_owned_tokio(&mut command)
        .await
        .map_err(|error| format!("could not run ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_replay_probe(&String::from_utf8_lossy(&output.stdout))
}

/// One save, start to finish. Every failure leaves the ring untouched and
/// nothing behind in the staging or Replays folders.
async fn perform_save(
    state: &AppState,
    save_id: &str,
    source: Option<ClipMarkSource>,
    seconds: u32,
) -> Result<ReplaySavedEvent, ReplaySaveFailedEvent> {
    let Some(snapshot) = save_snapshot(state, seconds) else {
        return Err(failure(save_id, None, "off", "Clips are off."));
    };
    let session_id = snapshot.session_id.clone();
    let listed = wait_for_boundary(&snapshot.dir).await;
    let selection = select_segments(&listed, snapshot.seconds, Some(snapshot.output.video.fps));
    if selection.is_empty() {
        return Err(failure(
            save_id,
            Some(&session_id),
            "empty",
            "The last seconds are still filling. Try again in a moment.",
        ));
    }
    // Staging: hard links (a copy when the file system refuses) keep the
    // selected segments alive while the ring prunes on.
    let staging = ring_root(state).join(format!("staging-{save_id}"));
    let staged = stage_selection(&snapshot.dir, &staging, &selection);
    let result = match staged {
        Err(message) => Err(failure(save_id, Some(&session_id), "io", message)),
        Ok(list_path) => {
            write_replay(state, save_id, &snapshot, &selection, &list_path, source).await
        }
    };
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn stage_selection(ring: &Path, staging: &Path, selection: &Selection) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging)
        .map_err(|error| format!("Could not create the clip staging folder: {error}"))?;
    for segment in &selection.segments {
        let from = ring.join(&segment.file_name);
        let to = staging.join(&segment.file_name);
        if std::fs::hard_link(&from, &to).is_err() {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("Could not stage {}: {error}", segment.file_name))?;
        }
    }
    let list_path = staging.join("list.txt");
    std::fs::write(&list_path, concat_list(selection, staging))
        .map_err(|error| format!("Could not write the clip list: {error}"))?;
    Ok(list_path)
}

async fn write_replay(
    state: &AppState,
    save_id: &str,
    snapshot: &SaveSnapshot,
    selection: &Selection,
    list_path: &Path,
    source: Option<ClipMarkSource>,
) -> Result<ReplaySavedEvent, ReplaySaveFailedEvent> {
    let session_id = snapshot.session_id.as_str();
    let replays = replays_dir(&snapshot.recordings_dir);
    if let Err(error) = std::fs::create_dir_all(&replays) {
        return Err(failure(
            save_id,
            Some(session_id),
            "disk",
            format!("Could not create {}: {error}", replays.display()),
        ));
    }
    let target = unused_target(&replays, &replay_file_name(&chrono::Local::now()));
    let partial = partial_path(&target);
    let mut command = tokio::process::Command::new(&snapshot.ffmpeg_path);
    command
        .args(save_args(list_path, &partial))
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = match crate::process_job::output_owned_tokio(&mut command).await {
        Ok(output) => output,
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            return Err(failure(
                save_id,
                Some(session_id),
                "ffmpeg",
                format!("Could not start FFmpeg to save the clip: {error}"),
            ));
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&partial);
        return Err(failure(
            save_id,
            Some(session_id),
            "ffmpeg",
            format!(
                "FFmpeg could not write the replay ({}): {}",
                output.status,
                stderr.lines().last().unwrap_or("no output").trim()
            ),
        ));
    }
    let probe = probe_replay(
        &crate::ffmpeg::ffprobe_path_for(&snapshot.ffmpeg_path),
        &partial,
    )
    .await;
    let duration_seconds =
        match probe.and_then(|probe| check_replay_probe(&probe, selection.covered_seconds)) {
            Ok(duration) => duration,
            Err(message) => {
                let _ = std::fs::remove_file(&partial);
                return Err(failure(
                    save_id,
                    Some(session_id),
                    "probe",
                    format!("The replay could not be checked after it was written: {message}."),
                ));
            }
        };
    if let Err(error) = std::fs::rename(&partial, &target) {
        let _ = std::fs::remove_file(&partial);
        return Err(failure(
            save_id,
            Some(session_id),
            "io",
            format!("Could not move the replay into place: {error}"),
        ));
    }
    let file_size_bytes = std::fs::metadata(&target)
        .ok()
        .and_then(|metadata| i64::try_from(metadata.len()).ok());
    let duration_ms = (duration_seconds * 1000.0).round() as i64;
    let row_id = uuid::Uuid::new_v4().to_string();
    let row = NewSession {
        id: row_id.clone(),
        title: replay_title().to_string(),
        started_at: replay_started_at(duration_seconds),
        mode: "record".to_string(),
        output_path: None,
        container: None,
        stream_preset: None,
        sources: snapshot.sources.clone(),
        layout: snapshot.layout.clone(),
        output: snapshot.output.clone(),
    };
    let target_text = target.display().to_string();
    if let Err(error) = state.database.create_completed_session(
        &row,
        &Utc::now().to_rfc3339(),
        Some(&target_text),
        Some(duration_ms),
        file_size_bytes,
    ) {
        // The file is safe on disk; say so instead of hiding it.
        return Err(failure(
            save_id,
            Some(session_id),
            "library",
            format!(
                "The replay was saved to {} but could not be added to Library: {error:#}",
                target.display()
            ),
        ));
    }
    let poster_state = state.clone();
    let poster_row = row_id.clone();
    let poster_path = target_text.clone();
    let poster_ffmpeg = snapshot.ffmpeg_path.clone();
    tokio::spawn(async move {
        crate::posters::ensure_session_poster(
            &poster_state,
            &poster_row,
            &poster_path,
            Some(duration_ms),
            &poster_ffmpeg,
        )
        .await;
    });
    Ok(ReplaySavedEvent {
        save_id: save_id.to_string(),
        session_id: session_id.to_string(),
        replay_session_id: row_id,
        path: target_text,
        seconds: snapshot.seconds,
        covered_seconds: selection.covered_seconds,
        complete: selection.complete,
        source,
    })
}

/// A buffer-only request for tests in other modules (plan 181 S8).
#[cfg(test)]
pub(crate) fn replay_only_test_params() -> StartSessionParams {
    serde_json::from_value(serde_json::json!({
        "sources": { "screenId": null, "windowId": null, "cameraId": null, "microphoneId": null, "testPattern": true },
        "layout": { "cameraCorner": "bottom-right", "cameraSize": "medium", "cameraShape": "rectangle", "cameraMargin": 32 },
        "output": {
            "recordEnabled": false,
            "streamEnabled": false,
            "outputDirectory": null,
            "ffmpegPath": null,
            "video": { "preset": "tutorial-1080p30", "width": 1280, "height": 720, "fps": 30, "bitrateKbps": 4000 },
            "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
        },
        "replay": { "seconds": 30 }
    }))
    .unwrap()
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
    fn probe_parsing_and_the_replay_check() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"30.040000"}}"#;
        let probe = parse_replay_probe(json).unwrap();
        assert_eq!(
            probe,
            ReplayProbe {
                video_codec: Some("h264".to_string()),
                audio_codec: Some("aac".to_string()),
                duration_seconds: Some(30.04),
            }
        );
        assert_eq!(check_replay_probe(&probe, 30.0), Ok(30.04));
        assert!(
            check_replay_probe(&probe, 40.0)
                .unwrap_err()
                .contains("expected 39.25 s to 42.50 s")
        );
        let silent = ReplayProbe {
            audio_codec: None,
            ..probe.clone()
        };
        assert!(
            check_replay_probe(&silent, 30.0)
                .unwrap_err()
                .contains("no AAC audio")
        );
        let no_video = ReplayProbe {
            video_codec: Some("hevc".to_string()),
            ..probe.clone()
        };
        assert!(
            check_replay_probe(&no_video, 30.0)
                .unwrap_err()
                .contains("no H.264 video")
        );
        assert!(parse_replay_probe("not json").is_err());
        assert_eq!(parse_replay_probe("{}").unwrap().duration_seconds, None);
    }

    #[test]
    fn unused_target_steps_past_taken_names() {
        let dir =
            std::env::temp_dir().join(format!("videorc-replay-target-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unused_target(&dir, "Replay 2026-10-12 18-30-05.mp4");
        assert_eq!(first, dir.join("Replay 2026-10-12 18-30-05.mp4"));
        std::fs::write(&first, b"x").unwrap();
        let second = unused_target(&dir, "Replay 2026-10-12 18-30-05.mp4");
        assert_eq!(second, dir.join("Replay 2026-10-12 18-30-05 (2).mp4"));
        // A partial in flight counts as taken too.
        std::fs::write(partial_path(&second), b"x").unwrap();
        let third = unused_target(&dir, "Replay 2026-10-12 18-30-05.mp4");
        assert_eq!(third, dir.join("Replay 2026-10-12 18-30-05 (3).mp4"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_is_refused_while_off_or_starting() {
        let state = test_state();
        let refused = request_save(&state, None, None).unwrap_err();
        assert_eq!(refused.code, "replay-off");
        let params = replay_only_params();
        let recordings = std::env::temp_dir().join("videorc-replay-recordings-test");
        let guard = prepare(
            &state,
            RingRequest {
                session_id: "session-starting",
                params: &params,
                replay_only: true,
                recordings_dir: &recordings,
                ffmpeg_path: "ffmpeg",
            },
        )
        .unwrap();
        assert_eq!(
            request_save(&state, None, None).unwrap_err().code,
            "replay-starting"
        );
        drop(guard);
        assert_eq!(
            request_save(&state, None, None).unwrap_err().code,
            "replay-off"
        );
    }

    /// Plan 199: a press names its length, a press that joins a queued save
    /// raises it to the longer of the two, and a short ring clamps it.
    #[test]
    fn a_press_chooses_its_length_and_a_joining_press_takes_the_longer() {
        let state = test_state();
        // A length nobody offers is refused whatever the ring is doing.
        assert_eq!(
            request_save(&state, None, Some(45)).unwrap_err().code,
            "invalid-clip-length"
        );
        let recordings = std::env::temp_dir().join("videorc-replay-recordings-test");
        let ring = |session_id: &'static str, seconds: u32| {
            let mut params = replay_only_params();
            params.replay = Some(crate::protocol::ReplayParams {
                seconds,
                auto: false,
            });
            let guard = prepare(
                &state,
                RingRequest {
                    session_id,
                    params: &params,
                    replay_only: true,
                    recordings_dir: &recordings,
                    ffmpeg_path: "ffmpeg",
                },
            )
            .unwrap();
            // A save already runs (its task is not spawned here), so every
            // press below queues or joins.
            let mut registry = lock(&state);
            let runtime = registry.active.as_mut().unwrap();
            runtime.state = ReplayBufferState::On;
            runtime.save_in_progress = true;
            drop(registry);
            guard
        };

        let guard = ring("session-lengths", 60);
        assert_eq!(guard.seconds, 60);
        let queued = request_save(&state, Some(ClipMarkSource::Manual), None).unwrap();
        assert!(queued.queued);
        assert_eq!(queued.seconds, 30, "no length is today's 30 s");
        let joined = request_save(&state, Some(ClipMarkSource::Voice), Some(60)).unwrap();
        assert_eq!(joined.save_id, queued.save_id);
        assert_eq!(joined.seconds, 60, "the join raises the length");
        assert_eq!(serde_json::to_value(&joined).unwrap()["seconds"], 60);
        let shorter = request_save(&state, None, Some(30)).unwrap();
        assert_eq!(shorter.save_id, queued.save_id);
        assert_eq!(shorter.seconds, 60, "a shorter join never shortens it");
        assert_eq!(
            lock(&state).active.as_ref().unwrap().queued_save,
            Some(QueuedSave {
                save_id: queued.save_id.clone(),
                source: Some(ClipMarkSource::Manual),
                seconds: 60,
            })
        );
        assert_eq!(
            request_save(&state, None, Some(45)).unwrap_err().code,
            "invalid-clip-length"
        );
        drop(guard);

        // A smoke's 15-s ring saves 15 s for either length, and says so.
        let guard = ring("session-short-ring", 15);
        assert_eq!(request_save(&state, None, None).unwrap().seconds, 15);
        assert_eq!(request_save(&state, None, Some(60)).unwrap().seconds, 15);
        drop(guard);
    }

    fn replay_only_params() -> StartSessionParams {
        replay_only_test_params()
    }

    /// Plan 181 S3: a real ring (test pattern plus a sine tone, encoded by
    /// FFmpeg into the production segment layout) saves a replay that
    /// ffprobe reports as H.264 + AAC, 30 to 32.5 s long, with a Library
    /// row that points at the MP4. The app smoke (S6) proves the same
    /// against the live pipeline; this covers the save flow on its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "spawns ffmpeg and ffprobe; run on recording-studio hosts"]
    async fn real_ffmpeg_ring_saves_a_probed_replay_with_a_library_row() {
        let ffmpeg = crate::ffmpeg::resolve_ffmpeg_path(None);
        let state = test_state();
        let mut events = state.events.subscribe();
        let params = replay_only_params();
        let recordings =
            std::env::temp_dir().join(format!("videorc-replay-save-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&recordings).unwrap();
        let guard = prepare(
            &state,
            RingRequest {
                session_id: "session-save",
                params: &params,
                replay_only: true,
                recordings_dir: &recordings,
                ffmpeg_path: &ffmpeg,
            },
        )
        .unwrap();
        let dir = guard.dir.clone();
        // 40 s of program into the ring, faster than real time, with the
        // production ring arguments (2 s keyframes, AAC, live CSV list).
        let mut args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "testsrc2=size=1280x720:rate=30:duration=40".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=880:sample_rate=48000:duration=40".to_string(),
            "-map".to_string(),
            "0:v".to_string(),
            "-map".to_string(),
            "1:a".to_string(),
            "-c:v".to_string(),
            // The bundled macOS FFmpeg is LGPL (no libx264): VideoToolbox
            // there, libx264 elsewhere.
            if cfg!(target_os = "macos") {
                "h264_videotoolbox".to_string()
            } else {
                "libx264".to_string()
            },
            "-g".to_string(),
            "60".to_string(),
            "-force_key_frames".to_string(),
            "expr:gte(t,n_forced*2)".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ];
        args.extend(replay_audio_encoding_args(None, 1));
        args.extend(segment_muxer_args(&dir, 30));
        let output = tokio::process::Command::new(&ffmpeg)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .expect("ffmpeg runs");
        assert!(
            output.status.success(),
            "ring generation failed ({}): {}\n{args:?}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let report = prune_tick(&dir, 30);
        assert_eq!(
            report.listed,
            keep_count(30),
            "the live list keeps K segments"
        );
        assert!(report.segment_files <= max_segment_files(30), "{report:?}");
        attach(&state, guard);

        let accepted = request_save(&state, None, None).unwrap();
        assert!(!accepted.queued);
        // A second press while the first runs queues one more; a third joins it.
        let queued = request_save(&state, None, None).unwrap();
        assert!(queued.queued);
        let joined = request_save(&state, None, None).unwrap();
        assert_eq!(joined.save_id, queued.save_id);

        let mut saved = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while saved.len() < 2 {
            let event = tokio::time::timeout_at(deadline, events.recv())
                .await
                .expect("saves finish in time")
                .unwrap();
            match event.event.as_str() {
                "replay.saved" => {
                    saved.push(serde_json::from_value::<ReplaySavedEvent>(event.payload).unwrap())
                }
                "replay.saveFailed" => panic!("save failed: {}", event.payload),
                _ => {}
            }
        }
        assert_eq!(saved[0].save_id, accepted.save_id);
        assert_eq!(saved[1].save_id, queued.save_id);
        for event in &saved {
            assert!(event.complete);
            assert_eq!(event.seconds, 30);
            let path = Path::new(&event.path);
            assert!(path.starts_with(replays_dir(&recordings)));
            assert!(path.exists(), "{}", event.path);
            let probe = probe_replay(&crate::ffmpeg::ffprobe_path_for(&ffmpeg), path)
                .await
                .unwrap();
            assert_eq!(probe.video_codec.as_deref(), Some("h264"));
            assert_eq!(probe.audio_codec.as_deref(), Some("aac"));
            let duration = probe.duration_seconds.unwrap();
            let (shortest, longest) = duration_window(30);
            assert!(
                (shortest - DURATION_SHORTFALL_SECONDS..=longest).contains(&duration),
                "replay runs {duration:.2} s"
            );
        }
        assert_ne!(saved[0].path, saved[1].path, "two saves, two files");
        // The ring is untouched and still bounded.
        let after = prune_tick(&dir, 30);
        assert_eq!(after.listed, keep_count(30));
        assert!(
            !ring_root(&state)
                .join(format!("staging-{}", accepted.save_id))
                .exists()
        );
        // Library rows: title Replay, playable MP4, no processing kind.
        let page = state.database.list_session_items_page(None, 10).unwrap();
        let replays: Vec<_> = page
            .items
            .iter()
            .filter(|item| item.title == replay_title())
            .collect();
        assert_eq!(replays.len(), 2);
        for item in replays {
            assert_eq!(
                item.mp4_path.as_deref(),
                Some(
                    saved
                        .iter()
                        .find(|e| e.replay_session_id == item.id)
                        .unwrap()
                        .path
                        .as_str()
                )
            );
            assert_eq!(item.status, "completed");
            assert!(item.processing_kind.is_none());
        }
        retire(&state, "session-save", RetireOutcome::Stopped);
        assert!(!dir.exists());
        std::fs::remove_dir_all(&recordings).unwrap();
    }

    /// Plan 200 B1, on real files: a 3-segment, 30 fps ring whose packets
    /// carry the bridge's one-tick durations (so `segments.csv` lists each
    /// end one frame short, as on the owner's Mac) saves into an MP4 with
    /// every frame one frame long and the frame count matching the length.
    /// The pre-fix list made the two joins' last frames one tick long.
    #[test]
    #[ignore = "spawns ffmpeg and ffprobe; run with --ignored"]
    fn real_ffmpeg_clip_keeps_every_frame_at_segment_joins() {
        let ffmpeg = crate::ffmpeg::resolve_ffmpeg_path(None);
        let ffprobe = crate::ffmpeg::ffprobe_path_for(&ffmpeg);
        let dir =
            std::env::temp_dir().join(format!("videorc-replay-joins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[String]| {
            let output = std::process::Command::new(&ffmpeg)
                .args(args)
                .stdin(std::process::Stdio::null())
                .output()
                .expect("ffmpeg runs");
            assert!(
                output.status.success(),
                "ffmpeg failed ({}): {}\n{args:?}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let strings = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        // 6 s of program: 2 s keyframes, no B-frames, AAC.
        let source = dir.join("source.ts");
        let mut args = strings(&[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=30:duration=6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=6",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            // The bundled macOS FFmpeg is LGPL (no libx264).
            if cfg!(target_os = "macos") {
                "h264_videotoolbox"
            } else {
                "libx264"
            },
            "-bf",
            "0",
            "-g",
            "60",
            "-force_key_frames",
            "expr:gte(t,n_forced*2)",
            "-pix_fmt",
            "yuv420p",
        ]);
        args.extend(replay_audio_encoding_args(None, 1));
        args.extend(strings(&["-f", "mpegts"]));
        args.push(source.display().to_string());
        run(&args);
        // The ring, stream-copied like the bridge's ring. The bridge's
        // packets reach the segment muxer with one-tick durations, so set
        // that: it is what makes the list's end the last frame's start.
        let mut args = strings(&["-hide_banner", "-loglevel", "error", "-i"]);
        args.push(source.display().to_string());
        args.extend(strings(&[
            "-map",
            "0",
            "-c",
            "copy",
            "-bsf:v",
            "setts=duration=1",
        ]));
        args.extend(segment_muxer_args(&dir, 6));
        run(&args);
        let listed = read_listed(&dir);
        assert_eq!(listed.len(), 3, "{listed:?}");
        for pair in listed.windows(2) {
            let gap = pair[1].start_seconds - pair[0].end_seconds;
            assert!(gap > 0.03, "the list's end is one frame short: {listed:?}");
        }
        let selection = select_segments(&listed, 6, Some(30));
        assert_eq!(selection.segments.len(), 3, "{selection:?}");
        let list_path = dir.join("list.txt");
        std::fs::write(&list_path, concat_list(&selection, &dir)).unwrap();
        let clip = dir.join("clip.mp4");
        run(&save_args(&list_path, &clip));

        let output = std::process::Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=time_base,nb_frames,duration:packet=duration",
                "-of",
                "json",
            ])
            .arg(&clip)
            .output()
            .expect("ffprobe runs");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let probe: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let stream = &probe["streams"][0];
        let time_base = stream["time_base"].as_str().unwrap();
        let (numerator, denominator) = time_base.split_once('/').unwrap();
        let ticks_per_second =
            denominator.parse::<f64>().unwrap() / numerator.parse::<f64>().unwrap();
        let frame_ticks = (ticks_per_second / 30.0).round() as i64;
        let frames = stream["nb_frames"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        let duration = stream["duration"].as_str().unwrap().parse::<f64>().unwrap();
        assert_eq!(frames, (duration * 30.0).round() as i64, "{probe}");
        let durations = probe["packets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|packet| packet["duration"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(durations.len() as i64, frames);
        assert!(
            durations.iter().all(|ticks| *ticks == frame_ticks),
            "every packet is one frame ({frame_ticks} ticks): {durations:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
        let selection = select_segments(&listed, 30, None);
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
        let selection = select_segments(&uneven, 30, None);
        assert!(selection.complete);
        assert_eq!(selection.segments.len(), 15);
        assert!(selection.covered_seconds >= 30.0);
        assert!(selection.covered_seconds <= duration_window(30).1);
    }

    /// Plan 199: one 1-min ring serves both clip lengths.
    #[test]
    fn a_one_minute_ring_serves_both_clip_lengths() {
        assert_eq!(keep_count(60), 32);
        assert_eq!(max_segment_files(60), 33);
        let listed = (0..32)
            .map(|index| segment(index, f64::from(index) * 2.0, f64::from(index) * 2.0 + 2.0))
            .collect::<Vec<_>>();
        let short = select_segments(&listed, 30, None);
        assert!(short.complete);
        assert_eq!(short.segments.len(), 15);
        assert_eq!(short.covered_seconds, 30.0);
        let long = select_segments(&listed, 60, None);
        assert!(long.complete);
        assert_eq!(long.segments.len(), 30);
        assert_eq!(long.covered_seconds, 60.0);
        // Both end on the newest complete segment.
        assert_eq!(
            short.segments.last().and_then(Segment::index),
            long.segments.last().and_then(Segment::index)
        );
        assert_eq!(duration_window(60), (60.0, 62.5));
        // D3: the disk bound and the arming check follow the minute.
        assert_eq!(estimated_disk_bytes(60, 8000), 33 * 2 * 1_024_000);
        assert_eq!(required_free_bytes(60, 8000), 4 * 60 * 1_024_000);
    }

    #[test]
    fn a_press_asks_for_30_or_60_seconds_clamped_to_the_ring() {
        assert_eq!(clip_seconds(None, 60), Ok(30));
        assert_eq!(clip_seconds(Some(30), 60), Ok(30));
        assert_eq!(clip_seconds(Some(60), 60), Ok(60));
        let refused = clip_seconds(Some(45), 60).unwrap_err();
        assert_eq!(refused.code, "invalid-clip-length");
        assert_eq!(refused.message, "A clip is 30 seconds or 1 minute.");
        assert!(clip_seconds(Some(0), 60).is_err());
        assert!(clip_seconds(Some(120), 600).is_err());
        // A smoke's 15-s ring clamps both lengths.
        assert_eq!(clip_seconds(None, 15), Ok(15));
        assert_eq!(clip_seconds(Some(30), 15), Ok(15));
        assert_eq!(clip_seconds(Some(60), 15), Ok(15));
        assert_eq!(requested_clip_seconds(None), Ok(DEFAULT_CLIP_SECONDS));
        // The ring's fallback length keeps the longest clip.
        assert_eq!(Some(&DEFAULT_SECONDS), CLIP_LENGTHS.iter().max());
        assert!(CLIP_LENGTHS.contains(&DEFAULT_CLIP_SECONDS));
    }

    #[test]
    fn a_filling_buffer_reports_what_it_holds() {
        let listed = vec![
            segment(0, 0.0, 2.0),
            segment(1, 2.0, 4.0),
            segment(2, 4.0, 6.0),
        ];
        let selection = select_segments(&listed, 30, None);
        assert!(!selection.complete);
        assert_eq!(selection.segments.len(), 3);
        assert_eq!(selection.covered_seconds, 6.0);
        let empty = select_segments(&[], 30, None);
        assert!(empty.is_empty());
        assert!(!empty.complete);
    }

    #[test]
    fn concat_list_quotes_paths_and_carries_durations() {
        let selection = select_segments(&[segment(7, 14.0, 16.0), segment(8, 16.0, 18.0)], 4, None);
        let dir = Path::new("/tmp/it's a ring");
        let script = concat_list(&selection, dir);
        // `join` writes the platform's separator (a backslash on Windows).
        let quoted = |name: &str| dir.join(name).display().to_string().replace('\'', "'\\''");
        assert_eq!(
            script,
            format!(
                "ffconcat version 1.0\nfile '{}'\nduration 2.000000\nfile '{}'\n",
                quoted("seg-000007.ts"),
                quoted("seg-000008.ts")
            )
        );
    }

    /// Plan 200 B1: FFmpeg lists the start of a segment's last frame (plus
    /// one tick) as its end, as in the owner's `seg-000203.ts,406.021333,
    /// 407.988011`. The listed span as `duration` squashed one frame to one
    /// tick at every join; the start gap keeps it.
    fn one_frame_short_ring() -> Vec<Segment> {
        (0..3)
            .map(|index| {
                let start = 406.021333 + 2.0 * f64::from(index);
                segment(
                    203 + index,
                    start,
                    start + 2.0 - 1.0 / 30.0 + 1.0 / 90_000.0,
                )
            })
            .collect()
    }

    #[test]
    fn concat_durations_are_the_start_gaps_and_the_last_segment_has_none() {
        let listed = one_frame_short_ring();
        let selection = select_segments(&listed, 6, Some(30));
        assert_eq!(selection.segments, listed);
        let dir = Path::new("/ring");
        let script = concat_list(&selection, dir);
        let file = |index: u32| {
            format!(
                "file '{}'",
                dir.join(format!("seg-{index:06}.ts")).display()
            )
        };
        assert_eq!(
            script.lines().collect::<Vec<_>>(),
            vec![
                "ffconcat version 1.0".to_string(),
                file(203),
                "duration 2.000000".to_string(),
                file(204),
                "duration 2.000000".to_string(),
                file(205),
            ]
        );
    }

    #[test]
    fn coverage_counts_the_frame_the_list_leaves_out() {
        // 15 segments of 2 s, each listed one frame short.
        let listed = (0..15)
            .map(|index| {
                let start = 2.0 * f64::from(index);
                segment(index, start, start + 2.0 - 1.0 / 30.0)
            })
            .collect::<Vec<_>>();
        let selection = select_segments(&listed, 30, Some(30));
        assert!(selection.complete, "{selection:?}");
        assert_eq!(selection.segments.len(), 15);
        assert!((selection.covered_seconds - 30.0).abs() < 1.0e-9);
        // Without the rate, the median end-to-next-start gap is the frame.
        let unknown_rate = select_segments(&listed, 30, None);
        assert_eq!(unknown_rate.segments.len(), 15);
        assert!((unknown_rate.covered_seconds - 30.0).abs() < 1.0e-9);
        // The old listed-span sum read 29.5 s here and pulled in a 16th
        // segment when one was there.
        let spans: f64 = listed.iter().map(Segment::duration_seconds).sum();
        assert!((spans - 29.5).abs() < 1.0e-9);
    }

    #[test]
    fn frame_seconds_prefers_the_rate_then_the_listed_gap() {
        let listed = one_frame_short_ring();
        assert!((frame_seconds(&listed, Some(60)) - 1.0 / 60.0).abs() < 1.0e-12);
        assert!((frame_seconds(&listed, Some(0)) - frame_seconds(&listed, None)).abs() < 1.0e-12);
        assert!((frame_seconds(&listed, None) - (1.0 / 30.0 - 1.0 / 90_000.0)).abs() < 1.0e-6);
        assert_eq!(frame_seconds(&listed[..1], None), 0.0);
        assert_eq!(frame_seconds(&[], None), 0.0);
    }

    #[test]
    fn segment_muxer_args_describe_a_live_csv_ring() {
        let ring = Path::new("/ring");
        let args = segment_muxer_args(ring, 30);
        let joined = args.join(" ");
        let list = ring.join("segments.csv").display().to_string();
        let pattern = ring.join("seg-%06d.ts").display().to_string();
        assert!(
            joined.starts_with(
                "-f segment -segment_format mpegts -segment_time 2 -reset_timestamps 0"
            )
        );
        assert!(joined.contains(&format!("-segment_list {list} -segment_list_type csv -segment_list_size 17 -segment_list_flags +live")));
        assert_eq!(args.last(), Some(&pattern));
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
        assert_eq!(replay_file_name(&at), "Clip 2026-10-12 18-30-05.mp4");
        assert_eq!(
            replays_dir(Path::new("/Users/me/Movies")),
            PathBuf::from("/Users/me/Movies/Clips")
        );
        assert_eq!(
            partial_path(Path::new(
                "/Users/me/Movies/Clips/Clip 2026-10-12 18-30-05.mp4"
            )),
            PathBuf::from("/Users/me/Movies/Clips/Clip 2026-10-12 18-30-05.mp4.partial")
        );
        assert_eq!(replay_title(), "Clip");
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
