//! S3.5b: the provider stream output plan (`resolveProviderStreamOutputPlan`,
//! `streamOutputVideoForTarget`, `providerSafeSharedProfile`,
//! `strictestSharedStreamProfile` in `lib/capture.ts`), mirroring the
//! backend's choice: what each destination streams at, and whether the
//! recording keeps its own encode.

use super::targets::Target;

/// A video profile (`VideoSettings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Video {
    pub preset: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

impl Video {
    pub fn preset(name: &str) -> Option<Video> {
        super::targets::preset_spec(name).map(|(w, h, fps, kbps)| Video {
            preset: name.to_string(),
            width: w,
            height: h,
            fps,
            bitrate_kbps: kbps,
        })
    }

    fn same_profile(&self, other: &Video) -> bool {
        self.width == other.width
            && self.height == other.height
            && self.fps == other.fps
            && self.bitrate_kbps == other.bitrate_kbps
    }

    /// "1080p · 30 fps · 6 Mbps" (`formatVideoQuality(video, {bitrate})`).
    pub fn quality(&self) -> String {
        format!(
            "{} · {}",
            super::targets::format_quality(self.width, self.height, self.fps),
            super::targets::format_bitrate(self.bitrate_kbps)
        )
    }

    /// `coerceVideoToOrientation(video, 'vertical')`.
    pub fn vertical(&self) -> Video {
        if self.height >= self.width {
            return self.clone();
        }
        Video {
            width: self.height,
            height: self.width,
            ..self.clone()
        }
    }
}

/// The streaming settings the plan reads.
pub struct Streaming<'a> {
    pub enabled: bool,
    pub targets: &'a [Target],
    pub default_preset: &'a str,
    pub default_bitrate_kbps: u32,
}

fn is_youtube_provider_preset(preset: &str) -> bool {
    matches!(
        preset,
        "stream-youtube-1080p30" | "stream-youtube-1080p60" | "stream-youtube-4k30"
    )
}

/// `exactProviderVideo`.
fn exact(video: Video) -> Video {
    if is_youtube_provider_preset(&video.preset) {
        Video::preset(&video.preset).unwrap_or(video)
    } else {
        video
    }
}

/// `providerSafePreset`.
fn provider_safe_preset(preset: &str) -> &str {
    match preset {
        "stream-youtube-1080p30" | "stream-youtube-4k30" => "stream-safe-1080p30",
        "stream-youtube-1080p60" => "stream-safe-1080p60",
        other => other,
    }
}

/// `streamOutputVideoSettings`.
pub fn stream_output_video(fallback: &Video, streaming: &Streaming<'_>) -> Video {
    if !streaming.enabled {
        return fallback.clone();
    }
    let mut preset = Video::preset(streaming.default_preset).unwrap_or_else(|| fallback.clone());
    preset.bitrate_kbps = streaming.default_bitrate_kbps;
    exact(preset)
}

/// `streamOutputVideoForTarget`.
pub fn video_for_target(fallback: &Video, streaming: &Streaming<'_>, target: &Target) -> Video {
    if !streaming.enabled {
        return stream_output_video(fallback, streaming);
    }
    let output = target.output_preset.clone().unwrap_or_else(|| {
        if target.platform == "youtube" {
            streaming.default_preset.to_string()
        } else {
            provider_safe_preset(streaming.default_preset).to_string()
        }
    });
    let mut preset =
        Video::preset(&output).unwrap_or_else(|| stream_output_video(fallback, streaming));
    preset.bitrate_kbps =
        target
            .output_bitrate_kbps
            .unwrap_or(if output == streaming.default_preset {
                streaming.default_bitrate_kbps
            } else {
                preset.bitrate_kbps
            });
    exact(preset)
}

/// `providerSafeSharedProfile`.
fn provider_safe_shared(video: &Video) -> Video {
    match video.preset.as_str() {
        "stream-youtube-1080p30" | "stream-youtube-4k30" => {
            Video::preset("stream-safe-1080p30").expect("a preset")
        }
        "stream-youtube-1080p60" | "stream-1080p60" => {
            Video::preset("stream-safe-1080p60").expect("a preset")
        }
        _ if video.bitrate_kbps > 6000 => Video {
            preset: "custom".into(),
            bitrate_kbps: 6000,
            ..video.clone()
        },
        _ => video.clone(),
    }
}

/// `canonicalStreamPresetForProfile`.
fn canonical_preset(video: &Video) -> String {
    for name in ["stream-safe-1080p30", "stream-safe-1080p60"] {
        if let Some(preset) = Video::preset(name)
            && preset.same_profile(video)
        {
            return name.to_string();
        }
    }
    "custom".into()
}

/// `strictestSharedStreamProfile`.
fn strictest_shared(candidates: &[Video]) -> Video {
    let first = &candidates[0];
    if candidates.iter().all(|c| c.same_profile(first)) {
        return first.clone();
    }
    let smallest = candidates
        .iter()
        .min_by_key(|c| u64::from(c.width) * u64::from(c.height))
        .expect("a candidate");
    let mut shared = Video {
        preset: "custom".into(),
        width: smallest.width,
        height: smallest.height,
        fps: candidates.iter().map(|c| c.fps).min().unwrap_or(30),
        bitrate_kbps: candidates
            .iter()
            .map(|c| c.bitrate_kbps)
            .min()
            .unwrap_or(6000),
    };
    shared.preset = canonical_preset(&shared);
    shared
}

/// `ProviderStreamOutputPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// (target id, label, vertical, video) for each enabled destination.
    pub targets: Vec<(String, String, bool, Video)>,
    pub stream_video: Video,
    pub separate_encoded_output_role: bool,
}

/// `separateProviderRolesFitBridgeEnvelope`.
fn separate_roles_fit_envelope(
    recording: &Video,
    targets: &[(String, String, bool, Video)],
) -> bool {
    let profiles: Vec<&Video> = std::iter::once(recording)
        .chain(targets.iter().map(|(.., v)| v))
        .collect();
    if profiles.iter().map(|p| p.fps).max().unwrap_or(0) <= 30 {
        return true;
    }
    profiles
        .iter()
        .all(|p| p.fps <= 60 && p.width.max(p.height) <= 1920 && p.width.min(p.height) <= 1080)
}

/// `streamTargetsFitRecordingPlusOneCompanion`.
fn fit_recording_plus_one(recording: &Video, targets: &[(String, String, bool, Video)]) -> bool {
    let mut companion: Option<&Video> = None;
    for (.., video) in targets {
        if video.same_profile(recording) {
            continue;
        }
        if companion.is_some_and(|c| !c.same_profile(video)) {
            return false;
        }
        companion = Some(video);
    }
    companion.is_some()
}

/// `compareStreamProfileStrictness`'s key.
fn strictness(video: &Video) -> (u64, u32, u32) {
    (
        u64::from(video.width) * u64::from(video.height),
        video.fps,
        video.bitrate_kbps,
    )
}

/// `resolveProviderStreamOutputPlan`: mixed profiles share the strictest
/// one, unless the separate encoded role is proven (`separate_role`) and
/// fits.
pub fn resolve(
    recording: &Video,
    streaming: &Streaming<'_>,
    record_enabled: bool,
    simulcast: bool,
    separate_role: bool,
) -> Plan {
    let separate_role = separate_role && !simulcast;
    let requested: Vec<(String, String, bool, Video)> = if streaming.enabled {
        streaming
            .targets
            .iter()
            .filter(|t| t.enabled && !(simulcast && t.vertical()))
            .map(|t| {
                (
                    t.id.clone(),
                    t.label.clone(),
                    t.vertical(),
                    video_for_target(recording, streaming, t),
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    if requested.is_empty() {
        return Plan {
            targets: Vec::new(),
            stream_video: stream_output_video(recording, streaming),
            separate_encoded_output_role: false,
        };
    }
    let first = requested[0].3.clone();
    let share = requested.iter().all(|(.., v)| v.same_profile(&first));
    if share && (!record_enabled || recording.same_profile(&first)) {
        return Plan {
            targets: requested,
            stream_video: first,
            separate_encoded_output_role: false,
        };
    }
    if record_enabled
        && separate_role
        && separate_roles_fit_envelope(recording, &requested)
        && fit_recording_plus_one(recording, &requested)
    {
        let stream_video = requested
            .iter()
            .map(|(.., v)| v)
            .max_by_key(|v| strictness(v))
            .expect("a target")
            .clone();
        return Plan {
            targets: requested,
            stream_video,
            separate_encoded_output_role: true,
        };
    }
    let youtube_only = requested.iter().all(|(id, ..)| {
        streaming
            .targets
            .iter()
            .find(|t| t.id == *id)
            .is_some_and(|t| t.platform == "youtube")
    });
    let mut candidates: Vec<Video> = requested
        .iter()
        .map(|(.., v)| {
            if youtube_only {
                v.clone()
            } else {
                provider_safe_shared(v)
            }
        })
        .collect();
    if record_enabled {
        candidates.push(provider_safe_shared(recording));
    }
    let shared = strictest_shared(&candidates);
    Plan {
        targets: requested
            .into_iter()
            .map(|(id, label, vertical, _)| (id, label, vertical, shared.clone()))
            .collect(),
        stream_video: shared,
        separate_encoded_output_role: false,
    }
}

/// `simulcastArmed` for a capture config, with `stream_enabled` standing in
/// for its `streamEnabled` (Go Live's plan always streams).
pub fn simulcast_armed(
    capture: &serde_json::Value,
    targets: &[Target],
    stream_enabled: bool,
) -> bool {
    let streaming = &capture["streaming"];
    let enabled_ids: Vec<&str> = streaming["enabledTargetIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();
    stream_enabled
        && streaming["enabled"].as_bool().unwrap_or(false)
        && !crate::studio::capture_config::layout_preset_is_vertical(
            capture["layout"]["layoutPreset"].as_str().unwrap_or(""),
        )
        && targets
            .iter()
            .any(|t| t.enabled && t.vertical() && enabled_ids.contains(&t.id.as_str()))
}

/// `simulcastStreamVideo`: the portrait leg's one encode.
pub fn simulcast_video(recording: &Video, streaming: &Streaming<'_>) -> Video {
    let vertical: Vec<&Target> = streaming
        .targets
        .iter()
        .filter(|t| t.enabled && t.vertical())
        .collect();
    let youtube_only = vertical.iter().all(|t| t.platform == "youtube");
    let profiles: Vec<Video> = vertical
        .iter()
        .map(|t| {
            let video = video_for_target(recording, streaming, t);
            if youtube_only {
                video
            } else {
                provider_safe_shared(&video)
            }
        })
        .collect();
    if profiles.is_empty() {
        stream_output_video(recording, streaming)
    } else {
        strictest_shared(&profiles)
    }
}

/// `simulcastStreamVideo` for a capture document's streaming settings.
pub fn simulcast_video_of(capture: &serde_json::Value, recording: &Video) -> Video {
    let targets = super::targets::targets(capture);
    simulcast_video(recording, &streaming_of(capture, &targets))
}

/// The saved streaming settings the plan reads.
fn streaming_of<'a>(capture: &'a serde_json::Value, targets: &'a [Target]) -> Streaming<'a> {
    let streaming = &capture["streaming"];
    Streaming {
        enabled: streaming["enabled"].as_bool().unwrap_or(false),
        targets,
        default_preset: streaming["defaultOutputPreset"]
            .as_str()
            .unwrap_or("stream-safe-1080p30"),
        default_bitrate_kbps: streaming["defaultBitrateKbps"]
            .as_u64()
            .and_then(|k| u32::try_from(k).ok())
            .unwrap_or(6000),
    }
}

/// `goLiveProviderPlan` plus the vertical leg `GoLivePanel` adds: what Go
/// Live will run, from the saved config. `separate_role`: the output check
/// proved the separate encoded role (`preflightProvesSeparateOutput`).
pub fn go_live_plan(capture: &serde_json::Value, recording: &Video, separate_role: bool) -> Plan {
    let targets = super::targets::targets(capture);
    let streaming = streaming_of(capture, &targets);
    let mut plan = resolve(
        recording,
        &streaming,
        capture["recordEnabled"].as_bool().unwrap_or(false),
        simulcast_armed(capture, &targets, true),
        separate_role,
    );
    if simulcast_armed(
        capture,
        &targets,
        capture["streamEnabled"].as_bool().unwrap_or(false),
    ) {
        let vertical = simulcast_video(recording, &streaming);
        plan.targets.extend(
            targets
                .iter()
                .filter(|t| t.enabled && t.vertical())
                .map(|t| (t.id.clone(), t.label.clone(), true, vertical.clone())),
        );
    }
    plan
}

/// `streamVideoProfileValidationReason(...) === null`.
pub fn stream_safe(video: &Video, platform: Option<&str>) -> bool {
    if video.preset != "custom" {
        match Video::preset(&video.preset) {
            Some(named) if named.same_profile(video) => {}
            _ => return false,
        }
    }
    if platform.is_some_and(|p| p != "youtube") && is_youtube_provider_preset(&video.preset) {
        return false;
    }
    if video.width >= 3840 || video.height >= 2160 {
        return video.preset == "stream-youtube-4k30"
            && video.width == 3840
            && video.height == 2160
            && video.fps == 30
            && video.bitrate_kbps == 30000;
    }
    if video.width > 1920 || video.height > 1080 {
        return false;
    }
    !(video.bitrate_kbps > 6000
        && video.preset != "stream-youtube-1080p30"
        && video.preset != "stream-youtube-1080p60")
}

/// The recording profile (`captureConfig.video`).
pub fn recording_video(capture: &serde_json::Value) -> Video {
    let video = &capture["video"];
    let number = |key: &str, fallback: u32| {
        video[key]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(fallback)
    };
    Video {
        preset: video["preset"].as_str().unwrap_or("custom").to_string(),
        width: number("width", 1920),
        height: number("height", 1080),
        fps: number("fps", 30),
        bitrate_kbps: number("bitrateKbps", 6000),
    }
}

/// `buildStreamOutputTopologyProbeParams` behind its caller's gate: `None`
/// while the talk-show room is open or until every enabled destination is
/// ready to start (`areEnabledStreamTargetsStartReady`). The plan the backend
/// may prove, with the separate role asked for.
///
/// Live captions on always burn the stream (one switch, #1593), so a
/// captioned stream beside a recording always gets its own leg; with them off
/// or skipped for the session, the leg is pre-armed only when a captioned
/// stream would fit (`forceSameProfileSplit`).
pub fn probe_params(
    capture: &serde_json::Value,
    suppress_captions_for_session: bool,
    talk_show_room_open: bool,
) -> Option<serde_json::Value> {
    if talk_show_room_open {
        return None;
    }
    let targets = super::targets::targets(capture);
    let enabled: Vec<&Target> = targets.iter().filter(|t| t.enabled).collect();
    if enabled.is_empty() || !enabled.iter().all(|t| super::lifecycle::start_ready(t)) {
        return None;
    }
    let recording = recording_video(capture);
    let plan = go_live_plan_unextended(capture, &recording, true);
    let record = capture["recordEnabled"].as_bool().unwrap_or(false);
    let streams: Vec<Video> = plan
        .targets
        .iter()
        .map(|(.., video)| video.clone())
        .collect();
    let captions_fit = super::captions_preflight::session_output_readiness(
        super::captions_preflight::BurnTarget::Stream,
        record,
        true,
        &recording,
        &streams,
    )
    .is_none();
    let captions_on = capture["captions"]["enabled"].as_bool().unwrap_or(false);
    let prearm_captions = !captions_on || suppress_captions_for_session;
    let force_split = record && (!prearm_captions || captions_fit);
    Some(super::ready::probe_params(
        &plan,
        &recording,
        record,
        force_split,
    ))
}

fn go_live_plan_unextended(
    capture: &serde_json::Value,
    recording: &Video,
    separate_role: bool,
) -> Plan {
    let targets = super::targets::targets(capture);
    resolve(
        recording,
        &streaming_of(capture, &targets),
        capture["recordEnabled"].as_bool().unwrap_or(false),
        simulcast_armed(capture, &targets, true),
        separate_role,
    )
}

/// `preflightProvesSeparateOutput`.
pub fn proves_separate_output(result: &serde_json::Value) -> bool {
    let roles: Vec<&str> = result["outputRoles"]
        .as_array()
        .map(|r| r.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();
    roles == ["recording", "stream"]
        && result["effectiveBridgeOutput"].as_str() != Some("raw-yuv420p")
        && matches!(
            result["probeState"].as_str(),
            Some("passed" | "not-required")
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mixed_destinations_share_the_strictest_profile_until_a_separate_role_is_proven() {
        let capture = json!({
            "recordEnabled": true,
            "streamEnabled": false,
            "video": { "preset": "tutorial-1080p30", "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 12000 },
            "layout": { "layoutPreset": "screen-camera" },
            "streaming": {
                "enabled": true,
                "defaultOutputPreset": "stream-youtube-1080p30",
                "defaultBitrateKbps": 9000,
                "enabledTargetIds": ["youtube", "twitch"],
                "targets": [
                    { "id": "youtube", "platform": "youtube", "label": "YouTube", "enabled": true,
                      "authMode": "manual-rtmp", "serverUrl": "rtmp://a.rtmp.youtube.com/live2", "streamKeyPresent": true },
                    { "id": "twitch", "platform": "twitch", "label": "Twitch", "enabled": true,
                      "authMode": "manual-rtmp", "serverUrl": "rtmp://live.twitch.tv/app", "streamKeyPresent": true },
                ],
            },
        });
        let recording = recording_video(&capture);
        let shared = go_live_plan(&capture, &recording, false);
        assert!(!shared.separate_encoded_output_role);
        assert_eq!(shared.stream_video.bitrate_kbps, 6000);
        assert!(
            shared
                .targets
                .iter()
                .all(|(.., v)| v.same_profile(&shared.stream_video))
        );
        let params = probe_params(&capture, false, false).expect("every destination is ready");
        assert_eq!(params["outputRoles"], json!(["recording", "stream"]));
        assert_eq!(probe_params(&capture, false, true), None);
        assert!(proves_separate_output(&json!({
            "outputRoles": ["recording", "stream"],
            "effectiveBridgeOutput": "videotoolbox-h264-mpegts",
            "probeState": "passed",
        })));
        assert!(!proves_separate_output(&json!({
            "outputRoles": ["recording", "stream"],
            "effectiveBridgeOutput": "raw-yuv420p",
            "probeState": "passed",
        })));
        assert!(stream_safe(
            &Video::preset("stream-safe-1080p30").unwrap(),
            Some("twitch")
        ));
        assert!(!stream_safe(
            &Video::preset("stream-youtube-1080p30").unwrap(),
            Some("twitch")
        ));
    }

    fn one_destination(fps: u32, captions: bool, record: bool) -> serde_json::Value {
        json!({
            "recordEnabled": record,
            "video": { "preset": "custom", "width": 1920, "height": 1080, "fps": fps, "bitrateKbps": 6000 },
            "captions": { "enabled": captions },
            "streaming": {
                "enabled": true,
                "defaultOutputPreset": "custom",
                "defaultBitrateKbps": 6000,
                "enabledTargetIds": ["custom"],
                "targets": [{
                    "id": "custom", "platform": "custom", "label": "Custom", "enabled": true,
                    "authMode": "manual-rtmp", "serverUrl": "rtmp://example.com/live",
                    "streamKey": "key", "streamKeyPresent": true,
                    "outputPreset": "custom", "width": 1920, "height": 1080, "fps": fps, "bitrateKbps": 6000
                }],
            },
        })
    }

    #[test]
    fn captions_on_split_a_recorded_stream_and_off_pre_arm_only_a_fitting_one() {
        let roles = |capture: &serde_json::Value, skip: bool| {
            probe_params(capture, skip, false).expect("ready")["outputRoles"].clone()
        };
        let split = json!(["recording", "stream"]);
        let shared = json!(["shared"]);
        // Captions on: always its own leg beside a recording, even at 60 fps.
        assert_eq!(roles(&one_destination(60, true, true), false), split);
        // Off, or skipped for the session: pre-armed only where captions fit.
        assert_eq!(roles(&one_destination(30, false, true), false), split);
        assert_eq!(roles(&one_destination(60, false, true), false), shared);
        assert_eq!(roles(&one_destination(60, true, true), true), shared);
        assert_eq!(roles(&one_destination(30, true, true), true), split);
        // Nothing to split without a recording.
        assert_eq!(roles(&one_destination(30, true, false), false), shared);
    }
}
