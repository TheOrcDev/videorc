//! The Studio inspector's top (plan 260 S1.6a part 6a, from `videorc-rust`'s
//! plan 220 S3.1a): why a start waits and where it is fixed, and the
//! Session section's facts and notices, as plain data the UI copies. A port
//! of `lib/start-blocked-copy.ts`, `use-studio.tsx`'s `startBlockedReasonFor`
//! and `visibleStartBlockedReason`, the Studio tab's `studioBlocker`,
//! `lib/studio-session-view.ts`'s Session summaries, `lib/session-output-video.ts`,
//! `lib/format-video.ts`, `lib/live-session-view.ts`,
//! `lib/stream-health-attribution.ts`, `lib/agents-view.ts`'s Session line,
//! `lib/session-runtime-notice.ts` and `components/studio/session-panel.tsx`'s
//! `SessionPanel`, caught up with today's Electron:
//!
//! - `5873f4569` (plan 235 B): the Go Live jumps open Destinations.
//! - `f8fa7c460` (plan 235 A): the mic sliver is gone (the Audio section's
//!   meter shows the level), and so is the section's title.
//! - `f0cf7afd9`, `9cde02bee` (plan 223 A5): the top watchdog alert
//!   outranks the Stream fact.
//! - `6b887f13c` (plan 184 C7): through Videorc Cloud the feed legs fold
//!   into one "Videorc Cloud" row, and a hold or resume is the Stream fact.
//! - `73fd1126d`, `ae2678eda`: Buddy's row is Sidekick's.
//! - `3a2b68dda` (#1665): a microphone notice opens Audio.
//! - Release test 146: on air, the Output row says what the session encodes.
//! - The start-block table's checks app-core doesn't hold yet (the
//!   entitlement gates, the profile compatibility, a destination's
//!   readiness, the stream topology verdict) are inputs: [`StartGates`].
//!
//! Electron never blocks or warns Record on captions; a Go Live's captions
//! readiness is [`super::captions_readiness`]. Nothing here knows the UI
//! framework.

use std::time::Instant;

use chrono::{DateTime, Utc};
use serde_json::Value;
use videorc_protocol::{RecordingState, VideoSettings};

use super::health::{HealthTelemetry, RecentDrops};
use super::health_page::{OPEN_HEALTH_LABEL, format_frame_rate, status_word_from_value};
use super::session::{SESSION_START_FAILED_TOAST_TITLE, SessionStartIntent, session_is_live};
use super::source_selection::{scene_source_off_blocked_reason, scene_sources_turned_off};
use super::transport::OPEN_DESTINATIONS_LABEL;
use super::{StudioSnapshot, connection_blocked_reason, start_blocked_copy};
use crate::livestream::cloud_status::CloudStatus;
use crate::livestream::on_air::{cloud_phase_label, format_cloud_countdown};
use crate::nav::PageId;
use crate::notices::{MicrophoneNotice, MicrophonePhase, microphone_notice_title};
use crate::scenes::model::using_visual_sources;
use crate::scenes::window::{AppWindowFailure, SceneAppState, app_window_failure_copy};
use crate::stream_manager::dashboard::CLOUD_PHASES;

/// The inspector's words that depend on the session.
pub mod copy {
    pub const LIVESTREAM_ROW: &str = "Livestream";
    pub const OUTPUT_ROW: &str = "Output";
    pub const DESTINATIONS_ROW: &str = "Destinations";
    pub const STREAM_ROW: &str = "Stream";
    pub const SIDEKICK_ROW: &str = "Sidekick";
    /// `streamingSummary` with nothing enabled.
    pub const NO_DESTINATIONS: &str = "No destinations";
    /// `cameraCaptureNotice`'s words for the Clips ring and a livestream (a
    /// recording's are the backend's status message).
    pub const CAMERA_SHARED_CLIPS: &str =
        "Preview and Clips both have the camera open. Another app may not be able to use it.";
    pub const CAMERA_SHARED_LIVE: &str = "Preview and your livestream both have the camera open. Another app may not be able to use it.";
    /// The camera notice's title.
    pub const CAMERA_SHARED_TITLE: &str = "Camera opened twice";
    /// `liveProblemLabel`.
    pub const HEALTHY: &str = "Healthy";
    pub const CHECKING: &str = "Checking…";
    /// Release test 146: a recording that took the stream's profile.
    pub const MATCHES_THE_STREAM: &str = "matches the stream";
    /// `cloudDestinationProblem`'s row and `cloudStreamReading`'s words.
    pub const VIDEORC_CLOUD: &str = "Videorc Cloud";
    pub const BE_RIGHT_BACK: &str = "Be right back";
    pub const CLOUD_RESUMING: &str = "Cloud resuming";
    /// `OPEN_AUDIO_LABEL` (`lib/section-doors.ts`).
    pub const OPEN_AUDIO: &str = "Open Audio";
    pub const OPEN_LIBRARY: &str = "Open Library";
    pub const RETRY: &str = "Retry";
    pub const DISMISS: &str = "Dismiss";
}

// ── Why a start waits ────────────────────────────────────────────────────

/// The start-block table's checks whose facts app-core doesn't hold yet,
/// as the app works them out (each `None` / `false` lets the start through).
/// Wired through `account::entitlements` once #1814 lands, and through the
/// Go Live preflight's destinations and topology with S1.6c.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartGates {
    /// `videoProfileEntitlementGate({ kind: 'recording', video })`'s reason:
    /// a start that records.
    pub recording_profile: Option<String>,
    /// `resolvedStreamingProfileEntitlementGate`'s reason: a start that
    /// streams.
    pub streaming_profile: Option<String>,
    /// `videoProfileCompatibility(config, platform).blockingReason` for a
    /// Record start (#1062: Windows' encoder envelope, which depends on the
    /// start's record and stream flags).
    pub record_compatibility: Option<String>,
    /// The same for a Go Live start.
    pub live_compatibility: Option<String>,
    /// `entitlementDisabledReason(entitlements, 'livestreaming')`.
    pub livestreaming: Option<String>,
    /// `goLiveEntitlementGate`'s reason over the saved destinations.
    pub go_live: Option<String>,
    /// A destination that is on is not ready to start
    /// (`isStreamTargetStartReady` false for one of the enabled targets).
    pub destination_not_ready: bool,
    /// `streamOutputTopologyBlockReason` of a finished topology check for
    /// today's request ("This computer can't encode the recording and the
    /// livestream separately…").
    pub stream_split: Option<String>,
}

impl StartGates {
    /// The gates the saved settings alone decide, which the app can always
    /// fill in: a destination that is on but not ready to start. The
    /// entitlement and topology gates stay off until their inputs land
    /// (S1.6c, #1814).
    pub fn of_snapshot(snapshot: &StudioSnapshot) -> Self {
        Self {
            destination_not_ready: destination_not_ready(snapshot),
            ..Self::default()
        }
    }

    fn compatibility(&self, intent: SessionStartIntent) -> Option<&String> {
        if intent.stream {
            self.live_compatibility.as_ref()
        } else {
            self.record_compatibility.as_ref()
        }
    }
}

/// `!areEnabledStreamTargetsStartReady` with a destination on: one that is
/// on is not ready to start (`isStreamTargetStartReady`: a stream key and a
/// valid server, or an account that can sign in). With none on, the gate is
/// off: "no destination" is its own reason.
pub fn destination_not_ready(snapshot: &StudioSnapshot) -> bool {
    let Some(streaming) = snapshot.settings.capture.streaming.as_ref() else {
        return false;
    };
    let Ok(streaming) = serde_json::to_value(streaming) else {
        return false;
    };
    crate::livestream::lifecycle::typed_targets(&streaming)
        .iter()
        .any(|target| target.enabled && !crate::livestream::lifecycle::start_ready(target))
}

/// A destination is turned on in the saved config.
fn any_destination_on(snapshot: &StudioSnapshot) -> bool {
    snapshot
        .settings
        .capture
        .streaming
        .as_ref()
        .is_some_and(|streaming| streaming.targets.iter().any(|target| target.enabled))
}

/// `areEnabledStreamTargetsStartReady`: one on, and every one on ready.
fn destinations_start_ready(snapshot: &StudioSnapshot, gates: &StartGates) -> bool {
    any_destination_on(snapshot) && !gates.destination_not_ready
}

/// `startBlockedReasonFor(intent)`, in the renderer's order: the
/// connection, a session that owns the transport, nothing to start, a
/// scene source turned off (or its app's window missing), the entitlement
/// and profile gates, a destination not on or not ready, the recorder, and
/// a stream topology this computer can't encode. A talk show's room
/// (plan 224) has no part here.
pub fn start_blocked_reason_for(
    snapshot: &StudioSnapshot,
    gates: &StartGates,
    intent: SessionStartIntent,
) -> Option<String> {
    if let Some(reason) = connection_blocked_reason(&snapshot.connection) {
        return Some(reason.to_string());
    }
    let session = &snapshot.session;
    // `transportSessionActive`: `sessionOwnsTransport`, a start or a stop
    // in flight.
    if (session.phase.is_active() && !session.status.replay_only)
        || session.start_pending
        || session.stop_pending
    {
        return Some(start_blocked_copy::SESSION_RUNNING.to_string());
    }
    if !intent.record && !intent.stream {
        return Some(start_blocked_copy::NO_OUTPUT.to_string());
    }
    if let Some(reason) = source_off_blocked_reason(snapshot) {
        return Some(reason);
    }
    let gate = |applies: bool, reason: &Option<String>| reason.clone().filter(|_| applies);
    if let Some(reason) = gate(intent.record, &gates.recording_profile)
        .or_else(|| gate(intent.stream, &gates.streaming_profile))
        .or_else(|| gates.compatibility(intent).cloned())
        .or_else(|| gate(intent.stream, &gates.livestreaming))
        .or_else(|| gate(intent.stream, &gates.go_live))
    {
        return Some(reason);
    }
    if intent.stream && !destinations_start_ready(snapshot, gates) {
        return Some(if any_destination_on(snapshot) {
            start_blocked_copy::DESTINATION_SETUP.to_string()
        } else {
            start_blocked_copy::NO_DESTINATION.to_string()
        });
    }
    match &snapshot.health.backend {
        None => return Some(start_blocked_copy::CHECKING_RECORDER.to_string()),
        Some(health) if !health.ffmpeg.available => {
            return Some(start_blocked_copy::RECORDER_MISSING.to_string());
        }
        Some(_) => {}
    }
    // Only a finished verdict blocks here; a check still running is settled
    // when Go Live is pressed.
    gate(intent.stream, &gates.stream_split)
}

/// `sceneSourcesTurnedOff` over the capture config's sources in use, then
/// `sceneSourceOffBlockedReason`; a scene made for an app whose window
/// isn't there says why in S2's words (plan 210 D1), never "Screen is set
/// to None".
fn source_off_blocked_reason(snapshot: &StudioSnapshot) -> Option<String> {
    let capture = &snapshot.settings.capture_doc;
    let visual = serde_json::json!({
        "layout": capture.get("layout"),
        "sources": using_visual_sources(capture.get("sources").unwrap_or(&Value::Null)),
        "background": Value::Null,
    });
    let (screen, camera) = scene_sources_turned_off(&visual, &snapshot.sources.devices.devices);
    let scenes = &snapshot.scenes;
    let active = scenes
        .on_stream_id
        .as_deref()
        .and_then(|id| scenes.scenes.iter().find(|scene| scene.id == id));
    if screen
        && let Some(active) = active
        && let Some(name) = active
            .visual
            .get("sources")
            .and_then(|sources| sources.get("app"))
            .and_then(|app| app.get("name"))
            .and_then(Value::as_str)
    {
        // `app-${state && state !== 'ready' ? state : 'not-running'}`.
        let failure = match scenes.app_states.get(&active.id) {
            Some(SceneAppState::Failed(failure)) => *failure,
            _ => AppWindowFailure::NotRunning,
        };
        return Some(app_window_failure_copy(name, failure));
    }
    scene_source_off_blocked_reason(screen, camera).map(str::to_string)
}

/// Why Record waits (`recordBlockedReason`).
pub fn record_blocked_reason(snapshot: &StudioSnapshot, gates: &StartGates) -> Option<String> {
    start_blocked_reason_for(snapshot, gates, SessionStartIntent::RECORD)
}

/// Why Go Live waits (`liveStreamBlockedReason`): a livestream that records
/// when the Output page says so.
pub fn live_stream_blocked_reason(snapshot: &StudioSnapshot, gates: &StartGates) -> Option<String> {
    start_blocked_reason_for(
        snapshot,
        gates,
        SessionStartIntent::livestream(snapshot.settings.capture.record_enabled),
    )
}

/// `visibleStartBlockedReason`: the one line under the buttons, Record's
/// reason first, while nothing runs or is on its way.
pub fn visible_start_blocked_reason(
    snapshot: &StudioSnapshot,
    gates: &StartGates,
) -> Option<String> {
    let session = &snapshot.session;
    let active = matches!(
        session.status.state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    );
    if active || session.start_pending || session.stop_pending {
        return None;
    }
    record_blocked_reason(snapshot, gates).or_else(|| live_stream_blocked_reason(snapshot, gates))
}

/// The jump beside the blocked line: where the reason is fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockedJump {
    pub label: &'static str,
    pub page: PageId,
}

/// `studioBlocker`'s jump: a recorder that isn't there opens Health; with
/// Record free, a Go Live past the plan's destinations or a destination to
/// finish opens Destinations. Nothing while the engine is away.
pub fn blocked_jump(snapshot: &StudioSnapshot, gates: &StartGates) -> Option<BlockedJump> {
    if connection_blocked_reason(&snapshot.connection).is_some() {
        return None;
    }
    if record_blocked_reason(snapshot, gates).is_some() {
        let ffmpeg_missing = snapshot
            .health
            .backend
            .as_ref()
            .is_some_and(|health| !health.ffmpeg.available);
        return ffmpeg_missing.then_some(BlockedJump {
            label: OPEN_HEALTH_LABEL,
            page: PageId::Diagnostics,
        });
    }
    (gates.go_live.is_some() || !destinations_start_ready(snapshot, gates)).then_some(BlockedJump {
        label: OPEN_DESTINATIONS_LABEL,
        page: PageId::Live,
    })
}

// ── The Session section's facts ──────────────────────────────────────────

/// `resolutionName`: "4K" at 2160, else the short edge ("1080p").
pub fn resolution_name(width: u32, height: u32) -> String {
    let short = width.min(height);
    if short == 2160 {
        "4K".to_string()
    } else {
        format!("{short}p")
    }
}

/// `formatVideoQuality(video)`, the short form: "1080p · 30 fps", or both
/// sides for a portrait canvas ("1080 × 1920 · 30 fps").
pub fn format_video_quality(width: u32, height: u32, fps: u32) -> String {
    let size = if height > width {
        format!("{width} × {height}")
    } else {
        resolution_name(width, height)
    };
    format!("{size} · {}", format_frame_rate(f64::from(fps)))
}

fn quality(video: &VideoSettings) -> String {
    format_video_quality(video.width, video.height, video.fps)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `streamingSummary`: the one destination's name, a count, or "No
/// destinations", over the stream cards as the capture config holds them
/// (read as JSON, so a card the wire type doesn't take still counts).
pub fn streaming_summary(targets: &[Value]) -> String {
    let enabled: Vec<&Value> = targets
        .iter()
        .filter(|target| target.get("enabled").and_then(Value::as_bool) == Some(true))
        .collect();
    match enabled.as_slice() {
        [] => copy::NO_DESTINATIONS.to_string(),
        [one] => text(one, "label")
            .filter(|label| !label.is_empty())
            .or_else(|| text(one, "platform"))
            .unwrap_or_default()
            .to_string(),
        many => format!("{} destinations", many.len()),
    }
}

/// What the session encodes on air (release test 146), which the Go Live
/// output plan knows (S1.6c): the shared-encode fallback (this computer
/// can't run a separate recording encode, so the recording takes the
/// stream's profile) and the first destination's stream video.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveOutput {
    pub shared_fallback: Option<VideoSettings>,
    pub stream_video: Option<VideoSettings>,
}

/// `sessionOutputSummary`: off air, the saved recording quality; on air
/// with a recording, the shared fallback "· matches the stream" or the
/// saved quality; a stream-only session, the fallback, else the stream's,
/// else the saved quality.
pub fn session_output_summary(
    snapshot: &StudioSnapshot,
    live: bool,
    output: &LiveOutput,
) -> String {
    let saved = &snapshot.settings.capture.video;
    if !live {
        return quality(saved);
    }
    if snapshot.settings.capture.record_enabled {
        return match &output.shared_fallback {
            Some(shared) => format!("{} · {}", quality(shared), copy::MATCHES_THE_STREAM),
            None => quality(saved),
        };
    }
    quality(
        output
            .shared_fallback
            .as_ref()
            .or(output.stream_video.as_ref())
            .unwrap_or(saved),
    )
}

/// A destination that needs the streamer (`LiveDestinationProblem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationProblem {
    pub target_id: String,
    pub label: String,
    pub word: String,
    /// `warn` or `error`.
    pub tone: &'static str,
}

/// `liveDestinationsView`: "3 of 3 on air", and one row per problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationsView {
    pub summary: String,
    /// Every leg on air (`kind: 'quiet'`): the summary's dot is `live`, else
    /// `warn`.
    pub quiet: bool,
    pub problems: Vec<DestinationProblem>,
}

/// `destinationStateLabel`.
pub fn destination_state_label(state: &str) -> String {
    match state {
        "not-configured" => "Skipped".to_string(),
        "ready" => "Ready".to_string(),
        "connecting" => "Connecting…".to_string(),
        "live" => "On air".to_string(),
        "warning" => "Not receiving".to_string(),
        "reconnecting" => "Reconnecting…".to_string(),
        "failed" => "Failed".to_string(),
        "stopped" => "Ended".to_string(),
        other => status_word_from_value(other),
    }
}

/// The upload legs to Videorc Cloud (`CLOUD_FEED_TARGET_PREFIX`).
pub const CLOUD_FEED_TARGET_PREFIX: &str = "videorc-cloud-";

/// The Videorc Cloud show carrying this session (`LiveDashboardCloud`,
/// plan 184 C7), as the cloud's status reads it: the cloud lane works out
/// `cloudPhaseLabel` and `formatCloudCountdown`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudShow {
    /// `live`, `hold`, `resuming`, `failed`, …
    pub phase: String,
    /// `cloudPhaseLabel(phase)`.
    pub phase_label: String,
    /// `formatCloudCountdown(holdRemainingSeconds)` while it holds.
    pub hold_countdown: Option<String>,
}

/// `cloudStreamReading`: "Be right back · 28 min left" while viewers see
/// the hold card, "Cloud resuming" while the feed comes back.
pub fn cloud_stream_reading(cloud: Option<&CloudShow>) -> Option<String> {
    let cloud = cloud?;
    match cloud.phase.as_str() {
        "hold" => Some(match &cloud.hold_countdown {
            Some(left) => format!("{} · {left} left", copy::BE_RIGHT_BACK),
            None => copy::BE_RIGHT_BACK.to_string(),
        }),
        "resuming" => Some(copy::CLOUD_RESUMING.to_string()),
        _ => None,
    }
}

/// `useSessionCloud` (`session-panel.tsx:501`): the show while it carries
/// this session, through `dashboardCloudFromStatus`
/// (`shared/live-dashboard.ts:302`). None for another session's show, an
/// off show, or no session. The labels are `cloudPhaseLabel` and
/// `formatCloudCountdown` of an active hold's seconds.
pub fn session_cloud_show(
    status: Option<&CloudStatus>,
    session_id: Option<&str>,
) -> Option<CloudShow> {
    let status = status?;
    let session_id = session_id?;
    if status.session_id.as_deref() != Some(session_id)
        || !CLOUD_PHASES.contains(&status.phase.as_str())
    {
        return None;
    }
    let hold_countdown = status
        .hold
        .as_ref()
        .filter(|hold| hold.active)
        .and_then(|hold| hold.remaining_seconds)
        .map(|seconds| format_cloud_countdown(seconds as f64));
    Some(CloudShow {
        phase: status.phase.clone(),
        phase_label: cloud_phase_label(&status.phase),
        hold_countdown,
    })
}

/// `cloudDestinationProblem`: one "Videorc Cloud" row for the feed legs,
/// while the show is not simply on air.
fn cloud_destination_problem(
    cloud: &CloudShow,
    feed: Option<&Value>,
) -> Option<DestinationProblem> {
    let (word, tone) = match cloud.phase.as_str() {
        "live" => return None,
        "hold" => (copy::BE_RIGHT_BACK.to_string(), "warn"),
        "failed" => (cloud.phase_label.clone(), "error"),
        _ => (cloud.phase_label.clone(), "warn"),
    };
    Some(DestinationProblem {
        target_id: feed
            .and_then(|feed| text(feed, "targetId"))
            .unwrap_or(CLOUD_FEED_TARGET_PREFIX.trim_end_matches('-'))
            .to_string(),
        label: copy::VIDEORC_CLOUD.to_string(),
        word,
        tone,
    })
}

fn is_cloud_feed(target: &Value) -> bool {
    text(target, "targetId").is_some_and(|id| id.starts_with(CLOUD_FEED_TARGET_PREFIX))
}

/// `liveDestinationsView`: nothing before the backend reported the legs.
/// Through the cloud the feed legs fold into one Videorc Cloud row, first.
pub fn live_destinations_view(
    targets: &[Value],
    cloud: Option<&CloudShow>,
) -> Option<DestinationsView> {
    let counted: Vec<&Value> = targets
        .iter()
        .filter(|target| cloud.is_none() || !is_cloud_feed(target))
        .filter(|target| text(target, "state") != Some("not-configured"))
        .collect();
    if counted.is_empty() {
        return None;
    }
    let on_air = counted
        .iter()
        .filter(|target| text(target, "state") == Some("live"))
        .count();
    let summary = format!("{on_air} of {} on air", counted.len());
    let cloud_problem = cloud.and_then(|cloud| {
        cloud_destination_problem(cloud, targets.iter().find(|target| is_cloud_feed(target)))
    });
    let problems: Vec<DestinationProblem> = cloud_problem
        .into_iter()
        .chain(counted.iter().filter_map(|target| {
            let state = text(target, "state").unwrap_or_default();
            let tone = match state {
                "failed" | "stopped" => "error",
                "reconnecting" | "warning" => "warn",
                _ => return None,
            };
            Some(DestinationProblem {
                target_id: text(target, "targetId").unwrap_or_default().to_string(),
                label: text(target, "label").unwrap_or_default().to_string(),
                word: destination_state_label(state),
                tone,
            })
        }))
        .collect();
    Some(DestinationsView {
        summary,
        quiet: problems.is_empty(),
        problems,
    })
}

/// `StreamHealthAttribution`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamHealthAttribution {
    Device,
    Audio,
    Choppy,
    Uplink,
    Capture,
    Render,
    Encoder,
    Fallback,
    Network,
    Preview,
    Healthy,
    Unknown,
}

/// `liveProblemLabel`.
pub fn live_problem_label(attribution: StreamHealthAttribution) -> &'static str {
    match attribution {
        StreamHealthAttribution::Device => "Capture device lost",
        StreamHealthAttribution::Audio => "Audio dropping",
        StreamHealthAttribution::Choppy => "Stream skipping frames",
        StreamHealthAttribution::Uplink => "Connection too slow",
        StreamHealthAttribution::Capture => "Capture running slow",
        StreamHealthAttribution::Render => "Rendering slow",
        StreamHealthAttribution::Encoder => "Encoder dropping frames",
        StreamHealthAttribution::Fallback => "Encoder fallback",
        StreamHealthAttribution::Network => "Delivery degraded",
        StreamHealthAttribution::Preview => "Preview degraded",
        StreamHealthAttribution::Healthy => copy::HEALTHY,
        StreamHealthAttribution::Unknown => copy::CHECKING,
    }
}

const MIN_MEDIA_FPS_RATIO: f64 = 0.9;
const MIN_ENCODER_SPEED: f64 = 0.98;
const MIN_AUDIO_CAPTURE_COVERAGE: f64 = 0.95;
/// `RECENT_UPLINK_OVERFLOW_WINDOW_MS`.
const RECENT_UPLINK_OVERFLOW_WINDOW_MS: i64 = 60_000;

fn number(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

fn trimmed<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    text(value, key).map(str::trim).filter(|s| !s.is_empty())
}

/// `healthForDiagnosticSession`: another session's stream health is none.
fn health_for_session<'a>(stats: &Value, health: Option<&'a Value>) -> Option<&'a Value> {
    let health = health?;
    match (text(stats, "sessionId"), text(health, "sessionId")) {
        (Some(stats_id), other) if Some(stats_id) != other => None,
        _ => Some(health),
    }
}

fn below_target_fps(actual: Option<f64>, target: Option<f64>) -> bool {
    matches!((actual, target), (Some(actual), Some(target)) if actual < target * MIN_MEDIA_FPS_RATIO)
}

/// `classifyStreamHealthAttribution`: the earliest failing stage.
pub fn classify_stream_health(
    stats: &Value,
    stream_health: Option<&Value>,
    targets: &[Value],
    drops: RecentDrops,
    now: DateTime<Utc>,
) -> StreamHealthAttribution {
    let health = health_for_session(stats, stream_health);
    let target_fps = number(stats, "targetFps")
        .or_else(|| number(stats, "streamOutputFps"))
        .filter(|fps| *fps > 0.0);
    let bottleneck = text(stats, "bottleneck");

    if stats.get("deviceDisconnected").and_then(Value::as_bool) == Some(true)
        || bottleneck == Some("device")
    {
        return StreamHealthAttribution::Device;
    }
    if bottleneck == Some("audio")
        || drops.audio
        || number(stats, "micCaptureCoverage")
            .is_some_and(|coverage| coverage < MIN_AUDIO_CAPTURE_COVERAGE)
    {
        return StreamHealthAttribution::Audio;
    }
    let delivery = stats.get("streamDelivery");
    if delivery
        .and_then(|delivery| delivery.get("degraded"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return StreamHealthAttribution::Choppy;
    }
    if uplink_shortfall(delivery, targets, now) {
        return StreamHealthAttribution::Uplink;
    }
    if bottleneck == Some("capture") || below_target_fps(number(stats, "captureFps"), target_fps) {
        return StreamHealthAttribution::Capture;
    }
    if bottleneck == Some("render") || below_target_fps(number(stats, "renderFps"), target_fps) {
        return StreamHealthAttribution::Render;
    }
    if bottleneck == Some("encoder")
        || number(stats, "encoderSpeed").is_some_and(|speed| speed < MIN_ENCODER_SPEED)
        || drops.encoder
        || trimmed(stats, "encoderBridgeError").is_some()
    {
        return StreamHealthAttribution::Encoder;
    }
    if let (Some(requested), Some(effective), Some(_)) = (
        trimmed(stats, "encoderBridgeRequestedVideoOutput"),
        trimmed(stats, "encoderBridgeEffectiveVideoOutput"),
        trimmed(stats, "encoderBridgeEncodedOutputFallbackReason"),
    ) && requested != effective
    {
        return StreamHealthAttribution::Fallback;
    }
    let media_healthy = healthy_media_evidence(stats, health);
    if media_healthy && target_network_problem(targets) {
        return StreamHealthAttribution::Network;
    }
    if bottleneck == Some("preview") || drops.preview {
        return StreamHealthAttribution::Preview;
    }
    if media_healthy {
        StreamHealthAttribution::Healthy
    } else {
        StreamHealthAttribution::Unknown
    }
}

fn uplink_shortfall(delivery: Option<&Value>, targets: &[Value], now: DateTime<Utc>) -> bool {
    if let Some(delivery) = delivery {
        if delivery.get("atFloor").and_then(Value::as_bool) == Some(true) {
            return true;
        }
        if let (Some(bitrate), Some(chosen)) = (
            number(delivery, "bitrateKbps"),
            number(delivery, "chosenBitrateKbps"),
        ) && bitrate < chosen
        {
            return true;
        }
    }
    targets.iter().any(|target| {
        let overflows = number(target, "uplinkOverflows").is_some_and(|count| count != 0.0);
        let at =
            text(target, "uplinkOverflowAt").and_then(|at| DateTime::parse_from_rfc3339(at).ok());
        overflows
            && at.is_some_and(|at| {
                (now - at.with_timezone(&Utc)).num_milliseconds()
                    <= RECENT_UPLINK_OVERFLOW_WINDOW_MS
            })
    })
}

fn target_network_problem(targets: &[Value]) -> bool {
    targets.iter().any(|target| {
        matches!(
            text(target, "state"),
            Some("failed" | "warning" | "reconnecting")
        ) || text(target, "message").is_some_and(mentions_reconnect)
    })
}

/// `/\breconnect(?:ed|ing)?\b/i`.
fn mentions_reconnect(message: &str) -> bool {
    let lower = message.to_lowercase();
    let bytes = lower.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut from = 0;
    while let Some(found) = lower[from..].find("reconnect") {
        let start = from + found;
        let before_ok = start == 0 || !word(bytes[start - 1]);
        let mut end = start + "reconnect".len();
        for suffix in ["ed", "ing"] {
            if lower[end..].starts_with(suffix) {
                end += suffix.len();
                break;
            }
        }
        let after_ok = end == bytes.len() || !word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn healthy_media_evidence(stats: &Value, health: Option<&Value>) -> bool {
    if !matches!(text(stats, "bottleneck"), Some("none" | "preview")) {
        return false;
    }
    [
        "captureFps",
        "renderFps",
        "encoderSpeed",
        "encoderBridgeInputFps",
        "encoderBridgeStreamInputFps",
        "streamMeasuredBitrateKbps",
    ]
    .iter()
    .any(|key| number(stats, key).is_some())
        || health.is_some_and(|health| {
            [
                "fps",
                "speed",
                "bitrateKbps",
                "droppedFrames",
                "totalBytes",
                "duplicatedFrames",
            ]
            .iter()
            .any(|key| number(health, key).is_some())
        })
}

/// `streamHealthFact`: the top watchdog alert first (plan 223 A5, its chip
/// words), then the cloud show's hold or resume (plan 184 C7), then
/// "Healthy" quietly, the failing stage in a few words, "Checking…" before
/// the diagnostics said anything. Returns the label and the dot's tone.
pub fn stream_health_fact(
    attribution: StreamHealthAttribution,
    cloud: Option<&CloudShow>,
    watchdog_chip: Option<&str>,
) -> (String, &'static str) {
    if let Some(chip) = watchdog_chip {
        return (chip.to_string(), "warn");
    }
    if let Some(reading) = cloud_stream_reading(cloud) {
        return (reading, "warn");
    }
    let tone = match attribution {
        StreamHealthAttribution::Healthy => "good",
        StreamHealthAttribution::Unknown => "neutral",
        _ => "warn",
    };
    (live_problem_label(attribution).to_string(), tone)
}

/// `cameraCaptureNotice`: the camera opened by the preview and the session
/// at once, for the running session only.
pub fn camera_capture_notice(snapshot: &StudioSnapshot, stats: Option<&Value>) -> Option<String> {
    let status = &snapshot.session.status;
    let session_id = status.session_id.as_deref()?;
    let stats = stats?;
    if text(stats, "sessionId") != Some(session_id)
        || !matches!(
            status.state,
            RecordingState::Recording | RecordingState::Streaming
        )
    {
        return None;
    }
    let camera_shared = stats
        .get("duplicateCaptureSources")
        .and_then(Value::as_array)
        .is_some_and(|sources| {
            sources
                .iter()
                .filter_map(Value::as_str)
                .any(|source| source.starts_with("camera:"))
        });
    if !camera_shared {
        return None;
    }
    if status.replay_only {
        return Some(copy::CAMERA_SHARED_CLIPS.to_string());
    }
    if matches!(status.state, RecordingState::Streaming) {
        return Some(copy::CAMERA_SHARED_LIVE.to_string());
    }
    status.message.clone()
}

/// The agents the backend reports (`agents.status`), as the Session line
/// reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentsState {
    pub enabled: bool,
    /// The connected agents' names, in the backend's order.
    pub connected: Vec<String>,
}

impl AgentsState {
    /// `agents.status`'s answer or event, read as the renderer reads it.
    pub fn read(status: &Value) -> Self {
        let enabled = status.get("enabled").and_then(Value::as_bool) == Some(true);
        let connected = status
            .get("agents")
            .and_then(Value::as_array)
            .map(|agents| {
                agents
                    .iter()
                    .filter(|agent| agent.get("connected").and_then(Value::as_bool) == Some(true))
                    .map(|agent| text(agent, "name").unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        Self { enabled, connected }
    }

    /// `agentsSessionLine`: "Claude Desktop connected", "2 agents
    /// connected", or nothing.
    pub fn session_line(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        match self.connected.as_slice() {
            [] => None,
            [one] => Some(format!("{one} connected")),
            many => Some(format!("{} agents connected", many.len())),
        }
    }
}

/// `SessionRuntimeAlert`'s notice: the failure outranks the microphone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeAlertView {
    pub title: String,
    pub message: String,
    /// `recording-failed`: the destructive tone; else the warning.
    pub failed: bool,
    /// #1665: Open Audio, first (`sessionRuntimeNoticeOpensAudio`).
    pub open_audio: bool,
    /// Open Library: a failed take that saved a file.
    pub open_library: bool,
    /// Show in Finder: a failed take that saved a file, with its path.
    pub reveal_session_id: Option<String>,
    /// The saved file Show in Finder reveals (`notice.outputPath`): a
    /// failed take that saved one.
    pub reveal_path: Option<String>,
}

/// `sessionRuntimeNoticeOpensAudio`: a microphone notice that hasn't ended,
/// about the microphone (or about nothing named).
pub fn microphone_notice_opens_audio(notice: &MicrophoneNotice) -> bool {
    notice.phase != MicrophonePhase::Ended
        && (notice.audio_issues.is_empty()
            || notice
                .audio_issues
                .iter()
                .any(|issue| issue.code.starts_with("microphone-")))
}

/// The runtime notice as the Session section shows it.
pub fn runtime_alert(snapshot: &StudioSnapshot) -> Option<RuntimeAlertView> {
    if let Some(notice) = &snapshot.session.notice {
        // `activitySavesRecording`: a livestream alone (or the Clips ring,
        // which raises no such notice) saved no file.
        let saved_file = notice.activity.saves_recording();
        let reveal = (saved_file && notice.output_path.is_some())
            .then(|| notice.session_id.clone())
            .flatten();
        // `savedFile && notice.outputPath` (`session-runtime-alert.tsx:64`).
        let reveal_path = saved_file.then(|| notice.output_path.clone()).flatten();
        return Some(RuntimeAlertView {
            title: notice.title().to_string(),
            message: notice.message.clone(),
            failed: true,
            open_audio: false,
            open_library: saved_file,
            reveal_session_id: reveal,
            reveal_path,
        });
    }
    snapshot
        .session
        .microphone_notice
        .as_ref()
        .map(|notice| RuntimeAlertView {
            title: microphone_notice_title(notice),
            message: notice.message.clone(),
            failed: false,
            open_audio: microphone_notice_opens_audio(notice),
            open_library: false,
            reveal_session_id: None,
            reveal_path: None,
        })
}

/// One fact row of the Session section (`NavigableRow`): its value, the
/// status dot's tone when the value is a status, and the page it opens
/// (none for a row that opens a window).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactRow {
    pub id: &'static str,
    pub label: String,
    pub value: String,
    /// `live`, `good`, `warn`, `error`, `neutral`; empty for a plain value.
    pub tone: &'static str,
    /// Indented under the Destinations row (`pl-9.5`): one destination.
    pub nested: bool,
    pub opens: Option<PageId>,
}

impl FactRow {
    fn new(id: &'static str, label: &str, value: String, page: PageId) -> Self {
        Self {
            id,
            label: label.to_string(),
            value,
            tone: "",
            nested: false,
            opens: Some(page),
        }
    }
}

/// The start failure's inline alert ("Couldn't start", the reason, Retry,
/// Dismiss), shown while nothing runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartFailureAlert {
    pub title: &'static str,
    pub message: String,
    /// Retry waits while a start is in flight.
    pub retry_enabled: bool,
}

/// Sidekick's row on air (`CohostSessionRow`): a viewers' alert in the
/// warning tone, else the presence dot and its label, as the Stream
/// Manager's lane works them out. The row opens the Stream Manager window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidekickFact {
    pub value: String,
    pub tone: &'static str,
}

/// What the Session section reads beyond the snapshot: the telemetry, and
/// the facts other areas own (each `None` leaves its row or reading out).
#[derive(Debug, Clone, Default)]
pub struct SessionInputs {
    /// `agents.status`, for the Session line.
    pub agents: AgentsState,
    /// Plan 223 A5: `watchdogChipLabel(topWatchdogAlert(watchdogAlerts))`.
    pub watchdog_chip: Option<String>,
    /// Plan 184 C7: the cloud show carrying this session.
    pub cloud: Option<CloudShow>,
    /// Presence W3: Sidekick's row while on air.
    pub sidekick: Option<SidekickFact>,
    /// Release test 146: what the session encodes on air.
    pub live_output: LiveOutput,
}

/// The Session section (`SessionPanel`): the facts, then the notices. The
/// watchdog's cards and a talk show's Guests row are their lanes'.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSectionView {
    pub rows: Vec<FactRow>,
    /// The agents line and its Stop (plan 209 D12), when any is connected.
    pub agents_line: Option<String>,
    pub start_failure: Option<StartFailureAlert>,
    pub camera_notice: Option<String>,
    pub runtime_alert: Option<RuntimeAlertView>,
}

impl SessionSectionView {
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        telemetry: &HealthTelemetry,
        inputs: &SessionInputs,
        now: DateTime<Utc>,
        at: Instant,
    ) -> Self {
        let session = &snapshot.session;
        let live = session_is_live(&session.status);
        let active = super::transport::transport_active(session);
        let cloud = inputs.cloud.as_ref();
        // The saved destinations (`captureConfig.streaming.targets`).
        let saved_targets = snapshot.settings.capture_doc["streaming"]["targets"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut rows = vec![
            FactRow::new(
                "livestream",
                copy::LIVESTREAM_ROW,
                streaming_summary(&saved_targets),
                PageId::Live,
            ),
            FactRow::new(
                "output",
                copy::OUTPUT_ROW,
                session_output_summary(snapshot, live, &inputs.live_output),
                PageId::Recording,
            ),
        ];
        if live {
            if let Some(view) = live_destinations_view(&telemetry.stream_targets, cloud) {
                rows.push(FactRow {
                    tone: if view.quiet { "live" } else { "warn" },
                    ..FactRow::new(
                        "destinations",
                        copy::DESTINATIONS_ROW,
                        view.summary,
                        PageId::Live,
                    )
                });
                for problem in view.problems {
                    rows.push(FactRow {
                        tone: problem.tone,
                        nested: true,
                        ..FactRow::new("destination", &problem.label, problem.word, PageId::Live)
                    });
                }
            }
            let attribution = classify_stream_health(
                telemetry.diagnostics.as_ref().unwrap_or(&Value::Null),
                telemetry.stream_health.as_ref(),
                &telemetry.stream_targets,
                telemetry.recent_drops(at),
                now,
            );
            let (label, tone) =
                stream_health_fact(attribution, cloud, inputs.watchdog_chip.as_deref());
            rows.push(FactRow {
                tone,
                ..FactRow::new("stream", copy::STREAM_ROW, label, PageId::Diagnostics)
            });
            if let Some(sidekick) = &inputs.sidekick {
                rows.push(FactRow {
                    id: "sidekick",
                    label: copy::SIDEKICK_ROW.to_string(),
                    value: sidekick.value.clone(),
                    tone: sidekick.tone,
                    nested: false,
                    opens: None,
                });
            }
        }
        let start_failure = (!active)
            .then_some(session.start_failure.as_ref())
            .flatten()
            .map(|failure| StartFailureAlert {
                title: SESSION_START_FAILED_TOAST_TITLE,
                message: failure.message.clone(),
                retry_enabled: !session.start_pending,
            });
        Self {
            rows,
            agents_line: inputs.agents.session_line(),
            start_failure,
            camera_notice: camera_capture_notice(snapshot, telemetry.diagnostics.as_ref()),
            runtime_alert: runtime_alert(snapshot),
        }
    }
}

#[cfg(test)]
#[path = "inspector_tests.rs"]
mod tests;
