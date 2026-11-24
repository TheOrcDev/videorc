//! Clips (plans 181 and 199; plan 260 S1.6a part 5, moved to L5): the ring
//! that keeps the last minute whenever Videorc is open, and the clip a key
//! saves from it. From `videorc-rust`'s `studio/clips.rs` (plan 220 S3.6a),
//! caught up with today's Electron:
//!
//! - `lib/replay-buffer.ts` (the words, the disk estimate, the buffer-only
//!   start) and `lib/replay-buffer-reconcile.ts` (the one decision, with the
//!   talk show room's hold, plan 224 D6);
//! - `lib/replay-buffer-grants.ts` (what the ring waits for: a grant, a
//!   chosen screen, Linux's portal share, a preview's first frame);
//! - `lib/replay-buffer-camera-wait.ts` (#1683, #1687: a camera that says
//!   live and sends nothing backs the ring off, then waits for its frame);
//! - `shared/clip-lengths.ts` and `lib/studio-actions/clips.ts` (the two
//!   lengths and the clip action's gate).
//!
//! The controller over these rules is [`super::clips_ring`]. The notices the
//! ring raises (Clip saved, Clips stopped, Clips couldn't start, Nothing to
//! clip yet) are `crate::notices`' (L7); the Output page's view is here.
//!
//! Words: a **clip** is the saved video, **Clip** / **Save clip** the one
//! action, **Clips** the Output section. Never "replay" in copy.

use std::time::Duration;

use serde_json::Value;
use videorc_protocol::{
    ArrangementMode, LayoutPreset, RecordingState, ReplayBufferState, ReplayParams,
    StartSessionParams,
};

use super::preview_scene::layout_preset_needs_screen;
use crate::desktop::permissions::{MediaAccessSnapshot, MediaAccessStatus};

/// `REPLAY_RING_SECONDS`: the ring always keeps the minute (plan 199).
pub const REPLAY_RING_SECONDS: u32 = 60;
/// `REPLAY_SEGMENT_SECONDS`: a clip runs N to N + 2 s.
pub const REPLAY_SEGMENT_SECONDS: u32 = 2;
/// The ring's AAC audio beside the video bitrate, in the disk estimate.
const REPLAY_AUDIO_KBPS: f64 = 192.0;
/// `REPLAY_START_RETRY_LIMIT`: failed starts in a row before the ring gives up.
pub const RETRY_LIMIT: u32 = 3;
/// `REPLAY_SILENT_CAMERA_RETRY_LIMIT`.
pub const SILENT_CAMERA_RETRY_LIMIT: u32 = 5;
/// The backend's refusals a buffer-only start can meet (no strike, no toast):
/// `replay_buffer::SOFTWARE_ENCODER_REFUSAL_CODE` and `SOURCES_NOT_READY_CODE`.
pub const SOFTWARE_ENCODER_REFUSAL: &str = "replay-software-encoder";
pub const SOURCES_NOT_READY: &str = "replay-sources-not-ready";

/// Linux's desktop-portal placeholders (`lib/capture.ts`): a kind of
/// source, not a screen anyone picked.
pub const PORTAL_MONITOR_SOURCE_ID: &str = "screen:portal:monitor";
pub const PORTAL_WINDOW_SOURCE_ID: &str = "window:portal:window";

/// The words, Electron's exactly.
pub mod copy {
    pub const CLIPS: &str = "Clips";
    pub const SAVE_CLIP: &str = "Save clip";
    pub const CLIP_BUTTON: &str = "Clip";
    pub const KEEP_LAST_SECONDS: &str = "Keep the last seconds";
    pub const SECTION_DESCRIPTION: &str = "Videorc keeps the last minute of your screen and microphone while it is open, so one key saves the last 30 seconds or the whole minute as a clip. While you record, the moment is also marked in the recording.";
    pub const OFF: &str = "Off. A clip can only be marked while you record.";
    pub const RUNNING: &str = "The newest seconds are on disk, ready to save, and deleted as they age. Nothing is kept for longer.";
    pub const NOT_RUNNING: &str =
        "Not running right now. It tries again after the next recording or source change.";
    pub const DISK_USE: &str = "Disk use";
    pub const WHERE_CLIPS_GO: &str = "Where clips go";
    pub const WHERE_CLIPS_GO_DESCRIPTION: &str =
        "A Clips folder inside your recordings folder. Every clip is listed in Library.";
    // What the ring waits for (`lib/replay-buffer-grants.ts`).
    pub const WAITS_FOR_PERMISSIONS: &str = "Waiting for the permission state.";
    pub const SCREEN_NOT_ALLOWED: &str = "Screen Recording has not been allowed yet.";
    pub const CAMERA_NOT_ALLOWED: &str = "Camera access has not been allowed yet.";
    pub const MICROPHONE_NOT_ALLOWED: &str = "Microphone access has not been allowed yet.";
    pub const WAITS_FOR_SCREEN: &str =
        "No screen is chosen. Choose one in Sources to use this scene.";
    pub const WAITS_FOR_PORTAL_SHARE: &str =
        "No screen is shared yet. Choose one in Sources to use this scene.";
    pub const WAITS_FOR_PREVIEW: &str = "Waiting for the screen preview to start.";
    pub const WAITS_FOR_SHARE_DIALOG: &str =
        "Waiting for you to choose a screen in the share dialog.";
    pub const WAITS_FOR_CAMERA_PREVIEW: &str = "Waiting for the camera preview.";
    pub const WAITS_FOR_SCREEN_PREVIEW: &str = "Waiting for the screen preview.";
    /// The bell's detail when the ring stops asking a camera that sends nothing.
    pub const CAMERA_SENDS_NO_PICTURE: &str =
        "The camera is on but sends no picture. Clips start by themselves once it does.";
    /// A clip action with no ring, no recording and no open room
    /// (`REMOTE_INTENT_COPY.clipsOff`).
    pub const CLIPS_OFF_INTENT: &str = "Clips are off, and you're not recording or live.";
}

/// `SCREEN_SHARE_DIALOG_PENDING_MESSAGE` (`lib/source-status.ts`): the screen
/// preview's Starting message while the portal's dialog is open.
pub const SCREEN_SHARE_DIALOG_PENDING_MESSAGE: &str = copy::WAITS_FOR_SHARE_DIALOG;
/// The backend's Starting message once the portal grants a share
/// (`ScreenStartupPhase::AwaitingFirstFrame` in `preview_screen.rs`).
pub const SCREEN_SHARE_GRANTED_MESSAGE: &str = "Screen share granted. Waiting for its first frame.";

// --- The two lengths (plan 199) -------------------------------------------

/// A press that names no length saves 30 s (`DEFAULT_CLIP_SECONDS`).
pub const DEFAULT_CLIP_SECONDS: u32 = 30;
/// The 1-minute clip (`LONG_CLIP_SECONDS`).
pub const LONG_CLIP_SECONDS: u32 = 60;
/// `CLIP_LENGTHS`: mirrors `replay_buffer::CLIP_LENGTHS`.
pub const CLIP_LENGTHS: [u32; 2] = [DEFAULT_CLIP_SECONDS, LONG_CLIP_SECONDS];
/// `INVALID_CLIP_LENGTH_CODE` and `INVALID_CLIP_LENGTH_MESSAGE`.
pub const INVALID_CLIP_LENGTH_CODE: &str = "invalid-clip-length";
pub const INVALID_CLIP_LENGTH_MESSAGE: &str = "A clip is 30 seconds or 1 minute.";

pub fn is_clip_length(seconds: u32) -> bool {
    CLIP_LENGTHS.contains(&seconds)
}

/// `parseClipLength`: a length that rode a relay or a remote intent. Absent
/// (or null) is no length, today's 30 s; anything but 30 or 60 is refused
/// with the backend's own sentence.
pub fn parse_clip_length(value: Option<&Value>) -> Result<Option<u32>, &'static str> {
    match value {
        None | Some(Value::Null) => Ok(None),
        // JavaScript's `=== 30`: a number, so 30.0 counts and "30" does not.
        Some(value) => value
            .as_f64()
            .and_then(|seconds| {
                CLIP_LENGTHS
                    .into_iter()
                    .find(|length| f64::from(*length) == seconds)
            })
            .map(Some)
            .ok_or(INVALID_CLIP_LENGTH_MESSAGE),
    }
}

/// `clipLengthWords`: "30 seconds", "1 minute", "2 minutes", "1.5 minutes".
pub fn clip_length_words(seconds: Option<u32>) -> String {
    let Some(seconds) = seconds.filter(|seconds| *seconds > 0) else {
        return "seconds".to_string();
    };
    if seconds < 60 {
        return format!("{seconds} seconds");
    }
    let plural = if seconds == 60 { "" } else { "s" };
    if seconds % 60 == 0 {
        format!("{} minute{plural}", seconds / 60)
    } else {
        format!("{:.1} minute{plural}", f64::from(seconds) / 60.0)
    }
}

/// `clipLastWords`: what follows "the last" ("Save the last minute as a
/// clip", never "the last 1 minute").
pub fn clip_last_words(seconds: Option<u32>) -> String {
    if seconds == Some(60) {
        "minute".to_string()
    } else {
        clip_length_words(seconds)
    }
}

/// `clipLengthLabel`: a length on a button, "30 s", "1 min" (plan 199 D4).
pub fn clip_length_label(seconds: u32) -> String {
    if seconds < 60 {
        format!("{seconds} s")
    } else if seconds % 60 == 0 {
        format!("{} min", seconds / 60)
    } else {
        format!("{} min", f64::from(seconds) / 60.0)
    }
}

/// `clipSavingToast`: the Stream Manager's toast for a press the ring took
/// (its window never hears `replay.saved`, the main window's "Clip saved").
/// `seconds` is the length the press asked for; `saved` says a recording
/// kept the mark. Returns the title and the description.
pub fn clip_saving_toast(saved: bool, seconds: Option<u32>) -> (String, &'static str) {
    let last = match seconds {
        Some(seconds) => format!("the last {}", format_timecode(f64::from(seconds))),
        None => "the last seconds".to_string(),
    };
    (
        format!("Saving {last} as a clip"),
        if saved {
            "It's in Library, and this moment is marked in your recording."
        } else {
            "It's in Library in a moment."
        },
    )
}

/// `markClip`'s precondition: the ring holds frames, a session records or
/// streams, or a talk show's room is open. Without one, the Studio says
/// "Nothing to clip yet" (L7's notice) and sends nothing.
pub fn clip_has_target(
    ring: ReplayBufferState,
    recording: &RecordingState,
    room_open: bool,
) -> bool {
    room_open || ring == ReplayBufferState::On || active(recording)
}

/// The clip action's gate for remote, deck, chat and agents
/// (`studio-actions/clips.ts`): the length, then something to clip.
pub fn clip_action_refusal(
    seconds: Option<u32>,
    session_active: bool,
    replay_on: bool,
    cloud_room_open: bool,
) -> Option<&'static str> {
    if seconds.is_some_and(|seconds| !is_clip_length(seconds)) {
        return Some(INVALID_CLIP_LENGTH_MESSAGE);
    }
    (!session_active && !replay_on && !cloud_room_open).then_some(copy::CLIPS_OFF_INTENT)
}

// --- The decision (`lib/replay-buffer-reconcile.ts`) ----------------------

/// `replayStartRetryDelayMs`: 500 ms, doubling, at most 4 s.
pub fn retry_delay(failed_starts: u32) -> Duration {
    let exponent = failed_starts.saturating_sub(1).min(16);
    Duration::from_millis((500u64 << exponent).min(4000))
}

/// `replaySilentCameraRetryDelayMs`: 1, 2, 4, 8 s, so the last refusal lands
/// about 15 s after the first.
pub fn silent_camera_retry_delay(refusals: u32) -> Duration {
    let exponent = refusals.saturating_sub(1).min(16);
    Duration::from_millis((1000u64 << exponent).min(8000))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    Start,
    Stop,
    GiveUp,
}

/// `ReplayReconcileInput`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReconcileInput {
    /// The switch in the Studio: what the streamer wants.
    pub armed: bool,
    pub replay_state: ReplayBufferState,
    /// The backend's ring belongs to a buffer-only session.
    pub replay_only_buffer: bool,
    pub recording_state: RecordingState,
    pub recording_replay_only: bool,
    /// A Record or Go Live is in flight: the backend hands over itself.
    pub start_pending: bool,
    pub stop_pending: bool,
    /// The ring's own start has not answered, or something holds the ring:
    /// a scene change awaiting its proof (#1640), a scene reload, an
    /// orientation change's stop, a performance check.
    pub start_in_flight: bool,
    pub failed_starts: u32,
    /// The backend refused the last start as `replay-sources-not-ready`.
    pub waiting_for_camera: bool,
    /// Plan 224 D6: a talk show's room holds the camera from Open the room
    /// until it has closed; the buffer-only ring steps aside meanwhile.
    pub room_holds_camera: bool,
}

fn active(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    )
}

/// `roomHoldsTheCamera`: any room phase but closed.
pub fn room_holds_the_camera(room_phase: Option<&str>) -> bool {
    room_phase.is_some_and(|phase| phase != "closed")
}

fn buffer_only_ring_stoppable(input: &ReconcileInput) -> bool {
    matches!(
        input.replay_state,
        ReplayBufferState::On | ReplayBufferState::Starting
    ) && input.replay_only_buffer
        && input.recording_replay_only
        && active(&input.recording_state)
        && !input.start_pending
        && !input.stop_pending
        && !input.start_in_flight
}

/// `replayBufferReconcileAction`.
pub fn reconcile_action(input: &ReconcileInput) -> Option<ReconcileAction> {
    if input.room_holds_camera {
        return buffer_only_ring_stoppable(input).then_some(ReconcileAction::Stop);
    }
    if input.armed {
        // A ring that died with its session ('error') disarms the switch;
        // once something arms it again it starts like a ring that is off.
        let off = matches!(
            input.replay_state,
            ReplayBufferState::Off | ReplayBufferState::Error
        );
        let idle = matches!(
            input.recording_state,
            RecordingState::Idle | RecordingState::Failed
        );
        if off
            && idle
            && !input.start_pending
            && !input.stop_pending
            && !input.start_in_flight
            && !input.waiting_for_camera
        {
            return Some(if input.failed_starts >= RETRY_LIMIT {
                ReconcileAction::GiveUp
            } else {
                ReconcileAction::Start
            });
        }
        return None;
    }
    // A ring riding a recording ends with it; the switch only decides
    // whether it comes back afterwards.
    buffer_only_ring_stoppable(input).then_some(ReconcileAction::Stop)
}

/// `replayShouldRearmAfterError`: never past a refusal (the software
/// encoder guard keeps its own reason on the Output page).
pub fn should_rearm_after_error(
    armed: bool,
    replay_state: ReplayBufferState,
    switch_on: bool,
    blocked: bool,
) -> bool {
    !armed && replay_state == ReplayBufferState::Error && switch_on && !blocked
}

/// `replayBufferShouldRestartForSources`: a source change while only the
/// buffer-only session runs stops the ring, which re-arms with the new ones.
pub fn should_restart_for_sources(recording_replay_only: bool, state: &RecordingState) -> bool {
    recording_replay_only && active(state)
}

// --- Numbers and words ----------------------------------------------------

/// `estimatedReplayDiskBytes`: the kept segments (ceil(N/2) + 2) plus the
/// one being written, each a whole segment of video and AAC audio.
pub fn estimated_disk_bytes(seconds: u32, video_bitrate_kbps: u32) -> f64 {
    let kept = seconds.div_ceil(REPLAY_SEGMENT_SECONDS) + 2 + 1;
    let bytes_per_second = (f64::from(video_bitrate_kbps) + REPLAY_AUDIO_KBPS) * 1000.0 / 8.0;
    f64::from(kept * REPLAY_SEGMENT_SECONDS) * bytes_per_second
}

/// `formatBytes`: "120 MB", "1.2 GB".
pub fn format_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 MB".to_string();
    }
    let gb = bytes / 1_000_000_000.0;
    if gb >= 1.0 {
        return if gb >= 10.0 {
            format!("{gb:.0} GB")
        } else {
            format!("{gb:.1} GB")
        };
    }
    format!("{} MB", ((bytes / 1_000_000.0).round() as i64).max(1))
}

/// `formatTimecode(ms)`: "0:30", "5:00", "1:02:03".
pub fn format_timecode(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 {
        seconds.floor() as u64
    } else {
        0
    };
    let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

/// The Output page's Disk use row: "about 51 MB", always the minute (plan
/// 199 D2). `quality` is the Output quality in words (`formatVideoQuality`).
pub fn disk_use(video_bitrate_kbps: u32, quality: &str) -> (String, String) {
    (
        format!(
            "about {}",
            format_bytes(estimated_disk_bytes(
                REPLAY_RING_SECONDS,
                video_bitrate_kbps
            ))
        ),
        format!("At {quality}, however long it runs."),
    )
}

/// The Clips switch's line (Output → Clips → Keep the last seconds).
/// `running` is the ring on or starting; `wait` is the record block or the
/// ring's wait, in that order.
pub fn switch_description(
    blocked: Option<&str>,
    on: bool,
    running: bool,
    wait: Option<&str>,
) -> String {
    if let Some(blocked) = blocked {
        return format!("Off on this computer. {blocked}");
    }
    if !on {
        return copy::OFF.to_string();
    }
    if running {
        return copy::RUNNING.to_string();
    }
    match wait {
        Some(wait) => format!("Starts once a source is ready. {wait}"),
        None => copy::NOT_RUNNING.to_string(),
    }
}

// --- What a start waits for (`lib/replay-buffer-grants.ts`) ---------------

fn source_text<'a>(sources: &'a Value, key: &str) -> Option<&'a str> {
    sources
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn flag(sources: &Value, key: &str) -> bool {
    sources.get(key).and_then(Value::as_bool) == Some(true)
}

/// The capture config's chosen screen: a window wins, as Electron's
/// `windowId ?? screenId`.
fn chosen_screen(sources: &Value) -> Option<&str> {
    source_text(sources, "windowId").or_else(|| source_text(sources, "screenId"))
}

fn is_portal_source(id: &str) -> bool {
    id == PORTAL_MONITOR_SOURCE_ID || id == PORTAL_WINDOW_SOURCE_ID
}

/// A smoke's synthetic device never touches the OS (`needsGrant`).
fn needs_grant(id: Option<&str>) -> bool {
    id.is_some_and(|id| !id.contains(":synthetic"))
}

/// `replayStartWaitsForGrant`: a device the scene uses whose grant macOS
/// has not asked for yet (or no snapshot yet). A denied grant is not
/// waited for. macOS only: the caller passes no snapshot elsewhere and
/// skips this gate.
pub fn waits_for_grant(
    media: Option<&MediaAccessSnapshot>,
    sources: &Value,
    layout_preset: &LayoutPreset,
) -> Option<&'static str> {
    let uses_screen = !flag(sources, "captureOff")
        && needs_grant(
            source_text(sources, "screenId").or_else(|| source_text(sources, "windowId")),
        );
    let uses_camera = !flag(sources, "cameraOff")
        && needs_grant(source_text(sources, "cameraId"))
        && *layout_preset != LayoutPreset::ScreenOnly;
    let uses_microphone =
        !flag(sources, "microphoneOff") && needs_grant(source_text(sources, "microphoneId"));
    if !uses_screen && !uses_camera && !uses_microphone {
        return None;
    }
    let Some(media) = media else {
        return Some(copy::WAITS_FOR_PERMISSIONS);
    };
    if uses_screen && media.screen == MediaAccessStatus::NotDetermined {
        return Some(copy::SCREEN_NOT_ALLOWED);
    }
    if uses_camera && media.camera == MediaAccessStatus::NotDetermined {
        return Some(copy::CAMERA_NOT_ALLOWED);
    }
    if uses_microphone && media.microphone == MediaAccessStatus::NotDetermined {
        return Some(copy::MICROPHONE_NOT_ALLOWED);
    }
    None
}

/// A preview's status as the ring reads it (`preview.screen.status`,
/// `preview.camera.status`): the protocol's statuses, as their JSON.
fn report_text<'a>(report: Option<&'a Value>, key: &str) -> Option<&'a str> {
    report?.get(key).and_then(Value::as_str)
}

fn report_frames(report: Option<&Value>) -> u64 {
    report
        .and_then(|report| report.get("framesCaptured"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// `nextPortalShareGrant`: the portal source whose share this run granted,
/// after one screen preview status. A grant (a first frame, or the granted
/// phase) sets it; a new share dialog or a cancelled one clears it, so the
/// ring waits for the person again. Anything else keeps it: a chosen share
/// that stops producing frames is a real failure.
pub fn next_portal_share_grant(current: Option<String>, status: &Value) -> Option<String> {
    let Some(source) = status
        .get("sourceId")
        .and_then(Value::as_str)
        .filter(|id| is_portal_source(id))
    else {
        return current;
    };
    let state = status.get("state").and_then(Value::as_str);
    let message = status.get("message").and_then(Value::as_str);
    if state == Some("live")
        || report_frames(Some(status)) > 0
        || (state == Some("starting") && message == Some(SCREEN_SHARE_GRANTED_MESSAGE))
    {
        return Some(source.to_string());
    }
    if state == Some("permission-needed")
        || (state == Some("starting") && message == Some(SCREEN_SHARE_DIALOG_PENDING_MESSAGE))
    {
        return if current.as_deref() == Some(source) {
            None
        } else {
            current
        };
    }
    current
}

/// `replayStartWaitsForScreen`: a scene that shows a screen nobody chose
/// waits; on Linux the portal placeholder waits for this run's share; and a
/// chosen screen whose preview has not started for any source yet waits
/// where the app starts that preview itself.
pub fn waits_for_screen(
    sources: &Value,
    layout_preset: &LayoutPreset,
    arrangement: &ArrangementMode,
    portal_share_granted: Option<&str>,
    preview_screen: Option<&Value>,
    preview_starts: bool,
) -> Option<&'static str> {
    if *arrangement == ArrangementMode::Freeform
        || !layout_preset_needs_screen(layout_preset)
        || flag(sources, "captureOff")
        || flag(sources, "testPattern")
    {
        return None;
    }
    let Some(source) = chosen_screen(sources) else {
        return Some(copy::WAITS_FOR_SCREEN);
    };
    let state = report_text(preview_screen, "state");
    if is_portal_source(source) && portal_share_granted != Some(source) {
        let dialog_open = state == Some("starting")
            && report_text(preview_screen, "message") == Some(SCREEN_SHARE_DIALOG_PENDING_MESSAGE);
        return Some(if dialog_open {
            copy::WAITS_FOR_SHARE_DIALOG
        } else {
            copy::WAITS_FOR_PORTAL_SHARE
        });
    }
    (preview_starts
        && state == Some("source-missing")
        && report_text(preview_screen, "sourceId").is_none())
    .then_some(copy::WAITS_FOR_PREVIEW)
}

/// `previewHasNoFrameYet`: unreported, another source's, or starting.
fn preview_has_no_frame_yet(report: Option<&Value>, id_key: &str, chosen: &str) -> bool {
    if report_text(report, id_key) != Some(chosen) {
        return true;
    }
    let state = report_text(report, "state");
    if state == Some("live") || report_frames(report) > 0 {
        return false;
    }
    state == Some("starting")
}

/// `replayStartWaitsForPreview`: the previews the Studio opens itself must
/// have a frame before a start; a reported device that is missing, denied
/// or failed is not waited for.
pub fn waits_for_preview(
    auto_preview: bool,
    sources: &Value,
    layout_preset: &LayoutPreset,
    preview_camera: Option<&Value>,
    preview_screen: Option<&Value>,
) -> Option<&'static str> {
    if !auto_preview {
        return None;
    }
    if let Some(screen) = chosen_screen(sources)
        && !flag(sources, "captureOff")
        && !flag(sources, "testPattern")
        && *layout_preset != LayoutPreset::CameraOnly
        && preview_has_no_frame_yet(preview_screen, "sourceId", screen)
    {
        return Some(copy::WAITS_FOR_SCREEN_PREVIEW);
    }
    if let Some(camera) = source_text(sources, "cameraId")
        && !flag(sources, "cameraOff")
        && *layout_preset != LayoutPreset::ScreenOnly
        && preview_has_no_frame_yet(preview_camera, "cameraId", camera)
    {
        return Some(copy::WAITS_FOR_CAMERA_PREVIEW);
    }
    None
}

/// Why a start waits right now, or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipsWait {
    /// First-run setup is open: it holds the preview back (plan 203 S2).
    /// The Output page names no reason for it.
    FirstRunSetup,
    Reason(&'static str),
}

impl ClipsWait {
    /// The Output page's words for the wait, when it has some.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            ClipsWait::FirstRunSetup => None,
            ClipsWait::Reason(reason) => Some(reason),
        }
    }
}

/// Everything `replayGrantWait` reads, as the Studio holds it.
#[derive(Debug, Clone, Copy)]
pub struct WaitInput<'a> {
    pub first_run_setup_open: bool,
    /// The OS's grants (macOS only; `None` elsewhere skips the grant gate).
    pub media: Option<&'a MediaAccessSnapshot>,
    /// True on macOS, where the grant gate applies.
    pub grants_apply: bool,
    /// The capture config's `sources`.
    pub sources: &'a Value,
    pub layout_preset: &'a LayoutPreset,
    pub arrangement: &'a ArrangementMode,
    /// [`next_portal_share_grant`]'s latch.
    pub portal_share_granted: Option<&'a str>,
    pub preview_camera: Option<&'a Value>,
    pub preview_screen: Option<&'a Value>,
    /// The Studio starts the previews itself (`replayAutoPreviewStarts`:
    /// native preview on, not a preview smoke, auto-preview not disabled).
    pub auto_preview: bool,
}

/// `replayGrantWait`: setup, then a grant, then the screen, then a preview.
pub fn wait(input: &WaitInput<'_>) -> Option<ClipsWait> {
    if input.first_run_setup_open {
        return Some(ClipsWait::FirstRunSetup);
    }
    let grant = if input.grants_apply {
        waits_for_grant(input.media, input.sources, input.layout_preset)
    } else {
        None
    };
    grant
        .or_else(|| {
            waits_for_screen(
                input.sources,
                input.layout_preset,
                input.arrangement,
                input.portal_share_granted,
                input.preview_screen,
                input.auto_preview,
            )
        })
        .or_else(|| {
            waits_for_preview(
                input.auto_preview,
                input.sources,
                input.layout_preset,
                input.preview_camera,
                input.preview_screen,
            )
        })
        .map(ClipsWait::Reason)
}

// --- A camera that sends nothing (`lib/replay-buffer-camera-wait.ts`) -----

/// The camera as the Studio last heard it (`preview.camera.status`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CameraReport {
    pub state: String,
    pub camera_id: Option<String>,
    pub frames_captured: u64,
    /// The backend's verdict: live past its first-frame grace with no frame.
    pub no_video: bool,
}

impl CameraReport {
    /// From the status's JSON.
    pub fn from_status(status: &Value) -> Self {
        Self {
            state: status
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            camera_id: status
                .get("cameraId")
                .and_then(Value::as_str)
                .map(str::to_string),
            frames_captured: report_frames(Some(status)),
            no_video: status.get("noVideo").and_then(Value::as_bool) == Some(true),
        }
    }

    /// `replayCameraDelivers`: the camera sends a picture.
    pub fn delivers(&self) -> bool {
        self.state == "live" && self.frames_captured > 0 && !self.no_video
    }
}

/// `ReplayCameraWait`: a live camera's refusals so far, and whether the ring
/// stopped asking and waits for its first frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CameraWait {
    pub refusals: u32,
    pub frames: bool,
}

/// `ReplaySourcesNotReadyNext`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourcesNotReadyNext {
    /// Ask again after the delay; the refusal is counted.
    Retry(Duration),
    /// The camera is starting or being switched: its live edge starts the ring.
    WaitForLive,
    /// The camera says live and sends nothing: stop asking; its first frame
    /// starts the ring.
    WaitForFrames,
    /// The camera failed, is missing or was denied: a failed start.
    Failed,
}

/// `replayAfterSourcesNotReady`: `refusals` counts this one.
pub fn after_sources_not_ready(
    camera: &CameraReport,
    chosen_camera: Option<&str>,
    refusals: u32,
) -> SourcesNotReadyNext {
    if camera.state == "live" {
        if camera.no_video || refusals >= SILENT_CAMERA_RETRY_LIMIT {
            return SourcesNotReadyNext::WaitForFrames;
        }
        return SourcesNotReadyNext::Retry(silent_camera_retry_delay(refusals));
    }
    let reported = camera.camera_id.as_deref().filter(|id| !id.is_empty());
    if camera.state == "starting" || reported.is_none() || reported != chosen_camera {
        return SourcesNotReadyNext::WaitForLive;
    }
    SourcesNotReadyNext::Failed
}

// --- The buffer-only start ------------------------------------------------

/// `startBufferOnlySession`'s request: the Record session's params with no
/// file and no stream, the ring attached, no captions and no simulcast.
///
/// `params` must be built from the capture config and the scene the Studio
/// holds **as the request goes out** (#1697): a scene from an older state
/// commits the scene a layout change left behind. The ring is the minute,
/// or a smoke's shorter ring; `auto` unless the streamer chose the switch.
pub fn buffer_only_params(
    mut params: StartSessionParams,
    smoke_seconds: Option<u32>,
    explicit: bool,
) -> StartSessionParams {
    params.output.record_enabled = false;
    params.output.stream_enabled = false;
    params.output.separate_source_recordings = None;
    params.streaming = None;
    params.captions = None;
    params.simulcast = None;
    params.replay = Some(ReplayParams {
        seconds: smoke_seconds.unwrap_or(REPLAY_RING_SECONDS),
        auto: !explicit,
    });
    params
}

#[cfg(test)]
#[path = "clips_tests.rs"]
mod tests;
