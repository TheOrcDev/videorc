//! The live destinations' facts on air, as the Studio's Session section and
//! the Destinations page read them: `lib/format-video.ts`'s
//! `formatVideoQuality`, `lib/studio-session-view.ts`'s `streamingSummary`,
//! `lib/live-session-view.ts` (`destinationStateLabel`,
//! `liveDestinationsView`, `cloudStreamReading`, `cloudDestinationProblem`,
//! `streamHealthFact`), `lib/state-labels.ts`' `cloudPhaseLabel`,
//! `lib/cloud-toasts.ts`' `formatCloudCountdown`, `lib/stream-health-attribution.ts`
//! (`classifyStreamHealthAttribution`, `liveProblemLabel`), and the one Custom RTMP destination the minimal Go
//! live sheet starts.
//!
//! Plan 260 S1.6c: `videorc-rust` kept these in `studio::inspector` and
//! `studio::transport`; they are the live area's, so the inspector reads
//! them from here.

use chrono::{DateTime, Utc};
use serde_json::Value;
use videorc_protocol::VideoPreset;
use videorc_protocol::streaming::{
    StreamAuthMode, StreamMode, StreamPlatform, StreamTargetSettings, StreamingSettings,
};

use super::watchdog::{WatchdogAlert, watchdog_chip_label};
use crate::studio::health::RecentDrops;
use crate::studio::health_page::{format_frame_rate, status_word_from_value};

/// The words these facts write.
pub mod copy {
    /// `streamingSummary` with nothing enabled.
    pub const NO_DESTINATIONS: &str = "No destinations";
    /// `liveProblemLabel`.
    pub const HEALTHY: &str = "Healthy";
    pub const CHECKING: &str = "Checking…";
    /// The minimal Go live sheet's destination.
    pub const CUSTOM_DESTINATION_LABEL: &str = "Custom RTMP";
}

use copy::CUSTOM_DESTINATION_LABEL;

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

/// `streamingSummary`: the one destination's name, a count, or "No
/// destinations", over the stream cards as the capture config holds them
/// (`captureConfig.streaming.targets`, read as JSON so a card the wire type
/// doesn't take still counts, as it does in the renderer).
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

/// The stream cards of a typed streaming config, as JSON.
pub fn stream_targets_json(streaming: &StreamingSettings) -> Vec<Value> {
    serde_json::to_value(&streaming.targets)
        .ok()
        .and_then(|targets| targets.as_array().cloned())
        .unwrap_or_default()
}

/// A destination that needs the streamer (`liveDestinationProblem`).
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
    /// Every leg on air: the summary's dot is `live`, else `warn`.
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

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `CLOUD_FEED_TARGET_PREFIX`: the upload legs to Videorc Cloud
/// (`recording.rs`).
pub const CLOUD_FEED_TARGET_PREFIX: &str = "videorc-cloud-";

/// `isCloudFeedTarget`.
pub fn is_cloud_feed_target(target_id: &str) -> bool {
    target_id.starts_with(CLOUD_FEED_TARGET_PREFIX)
}

/// `LiveDashboardCloud`: the Videorc Cloud show while it carries the
/// session (plan 184 C7), the part the on-air facts read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CloudOnAir {
    /// `CloudPhase` but `off`: `connecting`, `live`, `hold`, `resuming`,
    /// `ending` or `failed`.
    pub phase: String,
    /// While viewers see Be right back: seconds before the stream ends.
    pub hold_remaining_seconds: Option<f64>,
}

/// `cloudPhaseLabel`.
pub fn cloud_phase_label(phase: &str) -> String {
    match phase {
        "off" => "Off".to_string(),
        "connecting" => "Connecting…".to_string(),
        "live" => "On air".to_string(),
        "hold" => "Be right back".to_string(),
        "resuming" => "Resuming…".to_string(),
        "ending" => "Ending…".to_string(),
        "failed" => "Failed".to_string(),
        other => status_word_from_value(other),
    }
}

/// `formatCloudCountdown`: "27 min" or "45 s".
pub fn format_cloud_countdown(seconds: f64) -> String {
    if seconds >= 60.0 {
        format!("{} min", (seconds / 60.0).ceil())
    } else {
        format!("{} s", seconds.round().max(0.0))
    }
}

/// `cloudStreamReading`: "Be right back · 28 min left" while viewers see the
/// hold card, "Cloud resuming" while the feed comes back, else nothing.
pub fn cloud_stream_reading(cloud: Option<&CloudOnAir>) -> Option<String> {
    let cloud = cloud?;
    match cloud.phase.as_str() {
        "hold" => Some(match cloud.hold_remaining_seconds {
            Some(left) => format!("Be right back · {} left", format_cloud_countdown(left)),
            None => "Be right back".to_string(),
        }),
        "resuming" => Some("Cloud resuming".to_string()),
        _ => None,
    }
}

/// `cloudDestinationProblem`: one "Videorc Cloud" row for the feed legs,
/// only while the show is not simply on air.
pub fn cloud_destination_problem(
    cloud: &CloudOnAir,
    feed_target_id: Option<&str>,
) -> Option<DestinationProblem> {
    let row = |word: String, tone: &'static str| DestinationProblem {
        target_id: feed_target_id
            .map(str::to_string)
            .unwrap_or_else(|| CLOUD_FEED_TARGET_PREFIX.trim_end_matches('-').to_string()),
        label: "Videorc Cloud".to_string(),
        word,
        tone,
    };
    match cloud.phase.as_str() {
        "live" => None,
        // The countdown is the Stream fact's, right below (plan 222 U6).
        "hold" => Some(row("Be right back".to_string(), "warn")),
        "failed" => Some(row(cloud_phase_label(&cloud.phase), "error")),
        other => Some(row(cloud_phase_label(other), "warn")),
    }
}

fn live_destination_problem(target: &Value) -> Option<DestinationProblem> {
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
}

/// `liveDestinationsView`: nothing before the backend reported the legs.
/// Through Videorc Cloud the platforms are the runner's legs, so the count
/// is theirs; the feed legs fold into one Videorc Cloud row, first.
pub fn live_destinations_view(
    targets: &[Value],
    cloud: Option<&CloudOnAir>,
) -> Option<DestinationsView> {
    let target_id = |target: &Value| text(target, "targetId").unwrap_or_default().to_string();
    let counted: Vec<&Value> = targets
        .iter()
        .filter(|target| cloud.is_none() || !is_cloud_feed_target(&target_id(target)))
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
    let feed = targets
        .iter()
        .map(target_id)
        .find(|id| is_cloud_feed_target(id));
    let problems: Vec<DestinationProblem> = cloud
        .and_then(|cloud| cloud_destination_problem(cloud, feed.as_deref()))
        .into_iter()
        .chain(
            counted
                .iter()
                .filter_map(|target| live_destination_problem(target)),
        )
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

/// `streamHealthFact`: the top open watchdog alert first (plan 223 A5), then
/// the cloud show's hold or resume (plan 184 C7), then "Healthy" quietly, the
/// failing stage in a few words, or "Checking…" before the diagnostics said
/// anything. (label, tone)
pub fn stream_health_fact(
    attribution: StreamHealthAttribution,
    cloud: Option<&CloudOnAir>,
    alert: Option<&WatchdogAlert>,
) -> (String, &'static str) {
    if let Some(alert) = alert {
        return (watchdog_chip_label(alert), "warn");
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

/// The one destination the minimal Go live sheet starts (S2.4b): a custom
/// RTMP server and stream key, as `Livestream → Setup` would save it
/// (`manual-rtmp`, enabled, 1080p30 at 6000 kbps as the stream default). It is
/// not saved to the capture config: the Livestream page's slice owns that.
pub fn custom_rtmp_streaming(
    server_url: &str,
    stream_key: &str,
    now: DateTime<Utc>,
) -> StreamingSettings {
    let stamp = now.to_rfc3339();
    StreamingSettings {
        enabled: true,
        mode: StreamMode::Single,
        targets: vec![StreamTargetSettings {
            id: "custom".to_string(),
            platform: StreamPlatform::Custom,
            label: CUSTOM_DESTINATION_LABEL.to_string(),
            enabled: true,
            server_url: server_url.trim().to_string(),
            url_mode: None,
            stream_key: stream_key.trim().to_string(),
            stream_key_secret_ref: None,
            stream_key_present: !stream_key.trim().is_empty(),
            auth_mode: StreamAuthMode::ManualRtmp,
            account_id: None,
            account_label: None,
            platform_broadcast_id: None,
            platform_stream_id: None,
            output_preset: None,
            output_bitrate_kbps: None,
            output_orientation: None,
            status: None,
            created_at: stamp.clone(),
            updated_at: stamp,
        }],
        selected_target_id: Some("custom".to_string()),
        default_output_preset: VideoPreset::Tutorial1080p30,
        default_bitrate_kbps: 6_000,
        enabled_target_ids: vec!["custom".to_string()],
    }
}

/// The destinations a livestream goes to, by label, for the End livestream
/// question.
pub fn destination_labels(streaming: &StreamingSettings) -> Vec<String> {
    streaming
        .targets
        .iter()
        .filter(|target| target.enabled)
        .map(|target| {
            if target.label.trim().is_empty() {
                format!("{:?}", target.platform)
            } else {
                target.label.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    fn live_destinations_view_without_cloud(targets: &[Value]) -> Option<DestinationsView> {
        live_destinations_view(targets, None)
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 10, 12, 0, 0).unwrap()
    }

    #[test]
    fn video_quality_reads_one_way() {
        assert_eq!(format_video_quality(1920, 1080, 30), "1080p · 30 fps");
        assert_eq!(format_video_quality(1280, 720, 60), "720p · 60 fps");
        assert_eq!(format_video_quality(3840, 2160, 30), "4K · 30 fps");
        assert_eq!(format_video_quality(2560, 1440, 30), "1440p · 30 fps");
        assert_eq!(
            format_video_quality(1080, 1920, 30),
            "1080 × 1920 · 30 fps",
            "portrait keeps both sides"
        );
    }

    fn target(id: &str, label: &str, enabled: bool) -> StreamTargetSettings {
        let mut streaming = custom_rtmp_streaming("rtmp://127.0.0.1/live", "k", now());
        let mut target = streaming.targets.remove(0);
        target.id = id.to_string();
        target.label = label.to_string();
        target.enabled = enabled;
        target
    }

    #[test]
    fn the_livestream_row_names_the_destination_or_counts_them() {
        assert_eq!(streaming_summary(&[]), "No destinations");
        let mut streaming = custom_rtmp_streaming("rtmp://127.0.0.1/live", "k", now());
        assert_eq!(
            streaming_summary(&stream_targets_json(&streaming)),
            "Custom RTMP"
        );
        streaming.targets[0].label = String::new();
        assert_eq!(
            streaming_summary(&stream_targets_json(&streaming)),
            "custom"
        );
        streaming.targets = vec![
            target("a", "Twitch", true),
            target("b", "YouTube", true),
            target("c", "Kick", false),
        ];
        assert_eq!(
            streaming_summary(&stream_targets_json(&streaming)),
            "2 destinations"
        );
        // A card the wire type wouldn't take still counts, as the renderer's.
        assert_eq!(
            streaming_summary(&[
                json!({"enabled": true, "label": "YouTube", "platform": "youtube", "odd": 1}),
                json!({"enabled": true, "label": "", "platform": "twitch"}),
                json!({"enabled": true, "platform": "kick"}),
            ]),
            "3 destinations"
        );
        assert_eq!(
            streaming_summary(&[json!({"enabled": true, "platform": "twitch"})]),
            "twitch"
        );
        let _ = (StreamAuthMode::ManualRtmp, StreamPlatform::Custom);
    }

    #[test]
    fn the_destinations_are_quiet_when_fine_and_specific_when_not() {
        assert_eq!(live_destinations_view_without_cloud(&[]), None);
        assert_eq!(
            live_destinations_view_without_cloud(&[
                json!({"targetId": "a", "label": "X", "state": "not-configured"})
            ]),
            None,
            "a skipped destination isn't counted"
        );
        let quiet = live_destinations_view_without_cloud(&[
            json!({"targetId": "a", "label": "Twitch", "state": "live"}),
            json!({"targetId": "b", "label": "YouTube", "state": "live"}),
        ])
        .unwrap();
        assert_eq!(quiet.summary, "2 of 2 on air");
        assert!(quiet.quiet && quiet.problems.is_empty());
        let trouble = live_destinations_view_without_cloud(&[
            json!({"targetId": "a", "label": "Twitch", "state": "live"}),
            json!({"targetId": "b", "label": "YouTube", "state": "stopped"}),
            json!({"targetId": "c", "label": "Kick", "state": "reconnecting"}),
            json!({"targetId": "d", "label": "X", "state": "warning"}),
        ])
        .unwrap();
        assert_eq!(trouble.summary, "1 of 4 on air");
        assert!(!trouble.quiet);
        let words: Vec<(&str, &str, &str)> = trouble
            .problems
            .iter()
            .map(|p| (p.label.as_str(), p.word.as_str(), p.tone))
            .collect();
        assert_eq!(
            words,
            [
                ("YouTube", "Ended", "error"),
                ("Kick", "Reconnecting…", "warn"),
                ("X", "Not receiving", "warn"),
            ]
        );
        assert_eq!(destination_state_label("failed"), "Failed");
        assert_eq!(destination_state_label("odd-state"), "Odd state");
    }

    #[test]
    fn the_stream_fact_names_the_earliest_failing_stage() {
        let none = RecentDrops::default();
        let healthy = json!({"bottleneck": "none", "captureFps": 30.0, "targetFps": 30.0});
        let classify = |stats: &Value, targets: &[Value], drops: RecentDrops| {
            classify_stream_health(stats, None, targets, drops, now())
        };
        assert_eq!(
            classify(&healthy, &[], none),
            StreamHealthAttribution::Healthy
        );
        assert_eq!(
            stream_health_fact(StreamHealthAttribution::Healthy, None, None),
            ("Healthy".to_string(), "good")
        );
        assert_eq!(
            classify(&json!({}), &[], none),
            StreamHealthAttribution::Unknown,
            "nothing measured is no verdict"
        );
        assert_eq!(
            stream_health_fact(StreamHealthAttribution::Unknown, None, None),
            ("Checking…".to_string(), "neutral")
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "deviceDisconnected": true}),
                &[],
                none
            ),
            StreamHealthAttribution::Device
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "micCaptureCoverage": 0.5}),
                &[],
                none
            ),
            StreamHealthAttribution::Audio
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "capture", "streamDelivery": {"degraded": true}}),
                &[],
                none
            ),
            StreamHealthAttribution::Choppy,
            "the backend's verdict on what the stream sends ranks above capture"
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "streamDelivery": {"bitrateKbps": 3000, "chosenBitrateKbps": 6000}}),
                &[],
                none
            ),
            StreamHealthAttribution::Uplink
        );
        let recent_overflow = json!({"state": "live", "uplinkOverflows": 2, "uplinkOverflowAt": "2026-11-10T11:59:30Z"});
        let old_overflow = json!({"state": "live", "uplinkOverflows": 2, "uplinkOverflowAt": "2026-11-10T11:58:00Z"});
        assert_eq!(
            classify(&healthy, &[recent_overflow], none),
            StreamHealthAttribution::Uplink
        );
        assert_eq!(
            classify(&healthy, &[old_overflow], none),
            StreamHealthAttribution::Healthy,
            "an overflow older than a minute is over"
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "captureFps": 20.0, "targetFps": 30.0}),
                &[],
                none
            ),
            StreamHealthAttribution::Capture
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "captureFps": 30.0, "renderFps": 20.0, "targetFps": 30.0}),
                &[],
                none
            ),
            StreamHealthAttribution::Render
        );
        assert_eq!(
            classify(
                &healthy,
                &[],
                RecentDrops {
                    encoder: true,
                    ..none
                }
            ),
            StreamHealthAttribution::Encoder
        );
        assert_eq!(
            classify(
                &json!({"bottleneck": "none", "captureFps": 30.0, "encoderBridgeRequestedVideoOutput": "hevc", "encoderBridgeEffectiveVideoOutput": "h264", "encoderBridgeEncodedOutputFallbackReason": "no hevc"}),
                &[],
                none
            ),
            StreamHealthAttribution::Fallback
        );
        assert_eq!(
            classify(
                &healthy,
                &[json!({"state": "live", "message": "Reconnected after a drop"})],
                none
            ),
            StreamHealthAttribution::Network
        );
        assert_eq!(
            classify(
                &healthy,
                &[json!({"state": "live", "message": "Disconnected"})],
                none
            ),
            StreamHealthAttribution::Healthy,
            "a word that only contains reconnect's letters is no reconnect"
        );
        assert_eq!(
            classify(
                &healthy,
                &[],
                RecentDrops {
                    preview: true,
                    ..none
                }
            ),
            StreamHealthAttribution::Preview
        );
        assert_eq!(
            stream_health_fact(StreamHealthAttribution::Uplink, None, None),
            ("Connection too slow".to_string(), "warn")
        );
        // Another session's stream health is no evidence.
        assert_eq!(
            classify_stream_health(
                &json!({"bottleneck": "none", "sessionId": "s2"}),
                Some(&json!({"sessionId": "s1", "fps": 30.0})),
                &[],
                none,
                now()
            ),
            StreamHealthAttribution::Unknown
        );
        assert!(mentions_reconnect("RECONNECTING to the server"));
        assert!(!mentions_reconnect("reconnection"));
    }

    fn cloud(phase: &str, left: Option<f64>) -> CloudOnAir {
        CloudOnAir {
            phase: phase.into(),
            hold_remaining_seconds: left,
        }
    }

    #[test]
    fn through_the_cloud_the_feed_folds_into_one_videorc_cloud_row() {
        let targets = [
            json!({"targetId": "videorc-cloud-main", "label": "Feed", "state": "reconnecting"}),
            json!({"targetId": "yt", "label": "YouTube", "state": "live"}),
            json!({"targetId": "tw", "label": "Twitch", "state": "failed"}),
        ];
        let on_hold = cloud("hold", Some(1680.0));
        let view = live_destinations_view(&targets, Some(&on_hold)).unwrap();
        assert_eq!(view.summary, "1 of 2 on air", "the platforms only");
        let rows: Vec<(&str, &str, &str, &str)> = view
            .problems
            .iter()
            .map(|p| {
                (
                    p.target_id.as_str(),
                    p.label.as_str(),
                    p.word.as_str(),
                    p.tone,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "videorc-cloud-main",
                    "Videorc Cloud",
                    "Be right back",
                    "warn"
                ),
                ("tw", "Twitch", "Failed", "error"),
            ]
        );
        let live = cloud("live", None);
        let view = live_destinations_view(&targets[..2], Some(&live)).unwrap();
        assert!(view.quiet, "a live show adds no row");
        assert_eq!(view.summary, "1 of 1 on air");
        let failed = cloud("failed", None);
        let row = cloud_destination_problem(&failed, None).unwrap();
        assert_eq!(
            (row.target_id.as_str(), row.word.as_str(), row.tone),
            ("videorc-cloud", "Failed", "error")
        );
        let ending = cloud("ending", None);
        assert_eq!(
            cloud_destination_problem(&ending, None).unwrap().word,
            "Ending…"
        );
        // Without the cloud the feed is a leg like any other.
        let view = live_destinations_view(&targets, None).unwrap();
        assert_eq!(view.summary, "1 of 3 on air");
    }

    #[test]
    fn the_stream_fact_says_the_watchdog_then_the_cloud_then_the_stages() {
        let on_hold = cloud("hold", Some(1680.0));
        assert_eq!(
            stream_health_fact(StreamHealthAttribution::Healthy, Some(&on_hold), None),
            ("Be right back · 28 min left".to_string(), "warn")
        );
        let short = cloud("hold", Some(44.6));
        assert_eq!(
            cloud_stream_reading(Some(&short)).as_deref(),
            Some("Be right back · 45 s left")
        );
        assert_eq!(
            cloud_stream_reading(Some(&cloud("hold", None))).as_deref(),
            Some("Be right back")
        );
        assert_eq!(
            cloud_stream_reading(Some(&cloud("resuming", None))).as_deref(),
            Some("Cloud resuming")
        );
        assert_eq!(cloud_stream_reading(Some(&cloud("live", None))), None);
        let alert = WatchdogAlert {
            check: "program-silent".into(),
            ..WatchdogAlert::default()
        };
        assert_eq!(
            stream_health_fact(
                StreamHealthAttribution::Healthy,
                Some(&on_hold),
                Some(&alert)
            ),
            ("Viewers hear nothing".to_string(), "warn")
        );
        assert_eq!(format_cloud_countdown(60.0), "1 min");
        assert_eq!(format_cloud_countdown(61.0), "2 min");
        assert_eq!(format_cloud_countdown(-3.0), "0 s");
        assert_eq!(cloud_phase_label("odd-phase"), "Odd phase");
    }
}
