//! Live captions' Go Live rules (`lib/captions-preflight.ts`): the two output
//! rules a captioned livestream has (plan 174 S3.4, D-9), the session's
//! captions readiness the Go Live dialog shows, and the session skip. The
//! Captions page reads the same rules; it re-exports these when it lands.

use serde_json::Value;

use super::plan::Video;

/// `CaptionOutputRule`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputRule {
    FrameRate,
    OneStreamQuality,
}

impl OutputRule {
    /// `CAPTION_OUTPUT_RULE_LABELS`: the short words, for a checklist row.
    pub fn label(self) -> &'static str {
        match self {
            OutputRule::FrameRate => "Need 30 fps or less",
            OutputRule::OneStreamQuality => "Need one stream quality",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            OutputRule::FrameRate => {
                "Captions on a livestream work up to 30 fps. Choose a 30 fps quality in Output, or go live without captions this time."
            }
            OutputRule::OneStreamQuality => {
                "Captions on a livestream you also record need one stream quality for every destination. Give your destinations the same quality in Destinations, or go live without captions this time."
            }
        }
    }
}

/// `CaptionBurnTarget`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BurnTarget {
    Off,
    Recording,
    Stream,
    Both,
}

/// `captionSessionOutputReadiness`: `None` is ready, else the rule broken.
pub fn session_output_readiness(
    burn_target: BurnTarget,
    record_enabled: bool,
    stream_enabled: bool,
    recording: &Video,
    streams: &[Video],
) -> Option<OutputRule> {
    let burns_stream = matches!(burn_target, BurnTarget::Stream | BurnTarget::Both);
    if !burns_stream || !stream_enabled {
        return None;
    }
    let streams = if streams.is_empty() {
        std::slice::from_ref(recording)
    } else {
        streams
    };
    if recording.fps > 30 || streams.iter().any(|video| video.fps > 30) {
        return Some(OutputRule::FrameRate);
    }
    if record_enabled && unique_profiles(streams) > 1 {
        return Some(OutputRule::OneStreamQuality);
    }
    None
}

fn same_profile(left: &Video, right: &Video) -> bool {
    left.width == right.width
        && left.height == right.height
        && left.fps == right.fps
        && left.bitrate_kbps == right.bitrate_kbps
}

fn unique_profiles(profiles: &[Video]) -> usize {
    profiles
        .iter()
        .enumerate()
        .filter(|(index, profile)| {
            profiles
                .iter()
                .position(|candidate| same_profile(candidate, profile))
                == Some(*index)
        })
        .count()
}

/// `livestreamCaptionsBlocker`: the rule a livestream would break with
/// today's setup, asked before Go Live so the dialog is never the first place
/// it shows. `None` when captions are off or the output fits.
pub fn livestream_blocker(
    captions_enabled: bool,
    burn_target: BurnTarget,
    record_enabled: bool,
    recording: &Video,
    streams: &[Video],
) -> Option<OutputRule> {
    if !captions_enabled {
        return None;
    }
    session_output_readiness(burn_target, record_enabled, true, recording, streams)
}

/// `captionRuntimeStartBlocked`.
pub fn runtime_start_blocked(capture_active: bool, output: Option<OutputRule>) -> bool {
    capture_active && output.is_some()
}

pub const LINUX_TITLE: &str = "Live captions aren't available on Linux yet";
pub const LINUX_DETAIL: &str = "Videorc can't pass the microphone to captions here. Recordings and livestreams start without them, and your setting is kept.";

/// `captionsPlatformUnavailableReason`: Linux feeds its microphone straight
/// to FFmpeg, so it can't caption at all.
pub fn platform_unavailable_reason(platform: &str) -> Option<String> {
    (platform == "linux").then(|| format!("{LINUX_TITLE}. {LINUX_DETAIL}"))
}

/// `suppressCaptionsForSession` (`use-studio.tsx`): the streamer's "go live
/// without captions", or a platform that can't caption.
pub fn suppress_for_session(choice: bool, platform_unavailable: bool) -> bool {
    choice || platform_unavailable
}

/// `captionsEnabledForSession`.
pub fn enabled_for_session(persisted_enabled: bool, suppress_for_session: bool) -> bool {
    persisted_enabled && !suppress_for_session
}

/// `captionsSuppressedForSession`: an explicit skip, or captions off on an
/// output that can't pre-arm their leg for a mid-session opt-in.
pub fn suppressed_for_session(
    persisted_enabled: bool,
    explicit_suppression: bool,
    output: Option<OutputRule>,
) -> bool {
    explicit_suppression || (!persisted_enabled && output.is_some())
}

/// `GoLiveCaptionsReadiness['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadinessKind {
    Disabled,
    Ready,
    Blocked,
    Skipped,
}

/// `GoLiveCaptionsReadiness`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Readiness {
    pub kind: ReadinessKind,
    pub blocks_start: bool,
    pub title: &'static str,
    pub description: String,
    /// `CaptionTransport`: `"realtime"` or the chunked fallback.
    pub transport: Option<String>,
}

pub const CAPTIONS_UNAVAILABLE: &str = "Captions unavailable";

/// `decideGoLiveCaptionsReadiness`. `capabilities` is the backend's
/// `AiCapabilities` (`None` until it answered).
pub fn go_live_readiness(
    persisted_enabled: bool,
    suppress_for_session: bool,
    capabilities: Option<&Value>,
    output: Option<OutputRule>,
    platform_unavailable: Option<&str>,
) -> Readiness {
    if !persisted_enabled {
        return Readiness {
            kind: ReadinessKind::Disabled,
            blocks_start: false,
            title: "Captions off",
            description: "Live captions aren't enabled for this session.".into(),
            transport: None,
        };
    }
    if let Some(reason) = platform_unavailable.filter(|reason| !reason.is_empty()) {
        return Readiness {
            kind: ReadinessKind::Skipped,
            blocks_start: false,
            title: CAPTIONS_UNAVAILABLE,
            description: reason.to_string(),
            transport: None,
        };
    }
    if suppress_for_session {
        return Readiness {
            kind: ReadinessKind::Skipped,
            blocks_start: false,
            title: "Captions skipped",
            description:
                "This livestream will start without captions. Your saved setting is unchanged."
                    .into(),
            transport: None,
        };
    }
    if let Some(rule) = output {
        return blocked(rule.description());
    }
    let Some(captions) = capabilities
        .map(|capabilities| &capabilities["captions"])
        .filter(|captions| captions.is_object())
    else {
        return blocked(
            "Videorc couldn't verify live-caption readiness for this deployment. Try again, or continue this session without captions.",
        );
    };
    let transport = captions["preferredTransport"]
        .as_str()
        .filter(|transport| !transport.is_empty());
    let (true, Some(transport)) = (captions["available"].as_bool() == Some(true), transport) else {
        return blocked(unavailable_reason(captions["reasonCode"].as_str()));
    };
    Readiness {
        kind: ReadinessKind::Ready,
        blocks_start: false,
        title: "Captions ready",
        description: if transport == "realtime" {
            "Live microphone transcription is ready.".into()
        } else {
            "Caption transcription is ready in 3-second chunks, a few seconds behind.".into()
        },
        transport: Some(transport.to_string()),
    }
}

fn blocked(description: &str) -> Readiness {
    Readiness {
        kind: ReadinessKind::Blocked,
        blocks_start: true,
        title: CAPTIONS_UNAVAILABLE,
        description: description.to_string(),
        transport: None,
    }
}

fn unavailable_reason(reason_code: Option<&str>) -> &'static str {
    match reason_code {
        Some("cloud-ai-premium-required") => {
            "Live captions aren't available for this account. Continue without captions or review your plan."
        }
        Some("ai-user-disabled") => {
            "Live captions are disabled for this account. Continue without captions or contact support."
        }
        Some("captions-monthly-quota-exhausted") => {
            "Your monthly live-caption allowance is exhausted. Continue this session without captions."
        }
        Some("ai-disabled" | "captions-disabled") => {
            "Live captions are temporarily disabled on this Videorc deployment."
        }
        Some("captions-invalid-config" | "captions-not-configured") => {
            "Live captions aren't configured correctly on this Videorc deployment."
        }
        _ => "Live captions aren't ready on this Videorc deployment.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn video(width: u32, height: u32, fps: u32, kbps: u32) -> Video {
        Video {
            preset: "custom".into(),
            width,
            height,
            fps,
            bitrate_kbps: kbps,
        }
    }

    #[test]
    fn a_captioned_stream_needs_30_fps_and_one_quality_beside_a_recording() {
        let hd30 = video(1920, 1080, 30, 6000);
        let hd60 = video(1920, 1080, 60, 9000);
        let sd30 = video(1280, 720, 30, 4500);
        assert_eq!(
            session_output_readiness(
                BurnTarget::Off,
                true,
                true,
                &hd60,
                std::slice::from_ref(&hd60)
            ),
            None
        );
        assert_eq!(
            session_output_readiness(BurnTarget::Stream, true, false, &hd60, &[]),
            None
        );
        // No stream profiles: the recording's stands in.
        assert_eq!(
            session_output_readiness(BurnTarget::Stream, false, true, &hd60, &[]),
            Some(OutputRule::FrameRate)
        );
        assert_eq!(
            session_output_readiness(
                BurnTarget::Both,
                false,
                true,
                &hd30,
                std::slice::from_ref(&hd60)
            ),
            Some(OutputRule::FrameRate)
        );
        assert_eq!(
            session_output_readiness(
                BurnTarget::Stream,
                true,
                true,
                &hd30,
                &[hd30.clone(), sd30.clone()]
            ),
            Some(OutputRule::OneStreamQuality)
        );
        assert_eq!(
            session_output_readiness(
                BurnTarget::Stream,
                false,
                true,
                &hd30,
                &[hd30.clone(), sd30.clone()]
            ),
            None
        );
        assert_eq!(
            session_output_readiness(
                BurnTarget::Stream,
                true,
                true,
                &hd30,
                &[sd30.clone(), sd30.clone()]
            ),
            None
        );
        assert_eq!(OutputRule::FrameRate.label(), "Need 30 fps or less");
        assert!(
            OutputRule::OneStreamQuality
                .description()
                .contains("in Destinations,")
        );
    }

    #[test]
    fn the_blocker_is_asked_only_with_captions_on() {
        let hd60 = video(1920, 1080, 60, 9000);
        assert_eq!(
            livestream_blocker(false, BurnTarget::Stream, true, &hd60, &[]),
            None
        );
        assert_eq!(
            livestream_blocker(true, BurnTarget::Stream, true, &hd60, &[]),
            Some(OutputRule::FrameRate)
        );
        assert!(runtime_start_blocked(true, Some(OutputRule::FrameRate)));
        assert!(!runtime_start_blocked(false, Some(OutputRule::FrameRate)));
    }

    #[test]
    fn linux_skips_captions_for_every_session() {
        let reason = platform_unavailable_reason("linux").unwrap();
        assert_eq!(
            reason,
            "Live captions aren't available on Linux yet. Videorc can't pass the microphone to captions here. Recordings and livestreams start without them, and your setting is kept."
        );
        assert_eq!(platform_unavailable_reason("darwin"), None);
        assert!(suppress_for_session(false, true));
        assert!(!enabled_for_session(true, true));
        assert!(enabled_for_session(true, false));
        assert!(suppressed_for_session(
            false,
            false,
            Some(OutputRule::FrameRate)
        ));
        assert!(!suppressed_for_session(
            true,
            false,
            Some(OutputRule::FrameRate)
        ));
        assert!(suppressed_for_session(true, true, None));
    }

    #[test]
    fn go_live_readiness_reads_the_setting_skip_output_then_capabilities() {
        let ready = json!({ "captions": { "available": true, "preferredTransport": "realtime" } });
        let off = go_live_readiness(false, true, Some(&ready), None, None);
        assert_eq!(
            (off.kind, off.title),
            (ReadinessKind::Disabled, "Captions off")
        );

        let linux = go_live_readiness(true, true, Some(&ready), None, Some("Linux reason"));
        assert_eq!(
            (
                linux.kind,
                linux.title,
                linux.description.as_str(),
                linux.blocks_start
            ),
            (
                ReadinessKind::Skipped,
                "Captions unavailable",
                "Linux reason",
                false
            )
        );

        let skipped =
            go_live_readiness(true, true, Some(&ready), Some(OutputRule::FrameRate), None);
        assert_eq!(
            (skipped.kind, skipped.title),
            (ReadinessKind::Skipped, "Captions skipped")
        );

        let output =
            go_live_readiness(true, false, Some(&ready), Some(OutputRule::FrameRate), None);
        assert_eq!(output.kind, ReadinessKind::Blocked);
        assert!(output.blocks_start);
        assert_eq!(output.description, OutputRule::FrameRate.description());

        let unknown = go_live_readiness(true, false, None, None, None);
        assert!(unknown.description.starts_with("Videorc couldn't verify"));

        let quota = json!({ "captions": { "available": false, "reasonCode": "captions-monthly-quota-exhausted" } });
        assert!(
            go_live_readiness(true, false, Some(&quota), None, None)
                .description
                .starts_with("Your monthly live-caption allowance")
        );

        let live = go_live_readiness(true, false, Some(&ready), None, None);
        assert_eq!(
            (live.kind, live.title, live.transport.as_deref()),
            (ReadinessKind::Ready, "Captions ready", Some("realtime"))
        );
        let chunked = json!({ "captions": { "available": true, "preferredTransport": "chunked" } });
        assert_eq!(
            go_live_readiness(true, false, Some(&chunked), None, None).description,
            "Caption transcription is ready in 3-second chunks, a few seconds behind."
        );
    }
}
