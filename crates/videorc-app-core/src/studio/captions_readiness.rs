//! Live captions and a start (plan 260 S1.6a part 6a): the rules of
//! `lib/captions-preflight.ts`.
//!
//! Electron never blocks or warns Record on captions: `startBlockedReasonFor`
//! has no captions check. A Go Live whose captions aren't ready is held back
//! with a warning toast ("Live captions aren't ready", the readiness's
//! description) before its confirmation and before a Go Live without the
//! dialog (`runGoLiveConfirmation`, `startOnReadyDestinations`), unless a
//! talk show's room is open; and a session that runs with an output live
//! captions can't draw marks its captions blocked
//! (`captionRuntimeStartBlocked`). The Go Live confirmation that reads
//! [`decide_go_live_captions_readiness`] is S1.6c's; the captions'
//! controller is S1.6d's. Nothing here knows the UI framework.

use videorc_protocol::captions::CaptionBurnTarget;
use videorc_protocol::{
    AiCapabilitiesCaptions, AiCapabilitiesCaptionsReasonCode, AiCapabilitiesCaptionsTransport,
    VideoSettings,
};

/// The warning toast's title when a Go Live's captions aren't ready.
pub const CAPTIONS_NOT_READY_TOAST_TITLE: &str = "Live captions aren't ready";

/// `CAPTIONS_UNAVAILABLE_ON_LINUX`: Linux feeds its microphone straight to
/// FFmpeg, so the backend refuses every captioned session there.
pub const CAPTIONS_UNAVAILABLE_ON_LINUX: &str = "Live captions aren't available on Linux yet. Videorc can't pass the microphone to captions here. Recordings and livestreams start without them, and your setting is kept.";

/// `captionsPlatformUnavailableReason`: why live captions can't run on this
/// platform at all (`process.platform`'s words), or none.
pub fn captions_platform_unavailable_reason(platform: &str) -> Option<&'static str> {
    (platform == "linux").then_some(CAPTIONS_UNAVAILABLE_ON_LINUX)
}

/// One output's profile, as the caption rules compare them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionOutputProfile {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

impl From<&VideoSettings> for CaptionOutputProfile {
    fn from(video: &VideoSettings) -> Self {
        Self {
            width: video.width,
            height: video.height,
            fps: video.fps,
            bitrate_kbps: video.bitrate_kbps,
        }
    }
}

/// The two output rules livestream captions have (plan 174 S3.4, D-9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionOutputRule {
    FrameRate,
    OneStreamQuality,
}

impl CaptionOutputRule {
    /// `CAPTION_OUTPUT_RULE_LABELS`: the short words, where a sentence
    /// doesn't fit.
    pub fn label(self) -> &'static str {
        match self {
            CaptionOutputRule::FrameRate => "Need 30 fps or less",
            CaptionOutputRule::OneStreamQuality => "Need one stream quality",
        }
    }
}

/// `CaptionSessionOutputReadiness`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionOutputReadiness {
    pub ready: bool,
    pub reason: Option<CaptionOutputRule>,
    pub description: Option<&'static str>,
}

impl CaptionOutputReadiness {
    const READY: Self = Self {
        ready: true,
        reason: None,
        description: None,
    };
}

/// `captionSessionOutputReadiness`: live caption pixels need 30 fps or less
/// on every stream, and one stream profile beside a clean recording. Only a
/// session that burns the stream and streams is judged.
pub fn caption_session_output_readiness(
    burn_target: CaptionBurnTarget,
    record_enabled: bool,
    stream_enabled: bool,
    recording_video: CaptionOutputProfile,
    stream_videos: &[CaptionOutputProfile],
) -> CaptionOutputReadiness {
    if !burn_target.burns_stream() || !stream_enabled {
        return CaptionOutputReadiness::READY;
    }
    let only_recording = [recording_video];
    let streams = if stream_videos.is_empty() {
        &only_recording[..]
    } else {
        stream_videos
    };
    if recording_video.fps > 30 || streams.iter().any(|video| video.fps > 30) {
        return CaptionOutputReadiness {
            ready: false,
            reason: Some(CaptionOutputRule::FrameRate),
            description: Some(
                "Captions on a livestream work up to 30 fps. Choose a 30 fps quality in Output, or go live without captions this time.",
            ),
        };
    }
    let first = streams[0];
    if record_enabled && streams.iter().any(|video| *video != first) {
        return CaptionOutputReadiness {
            ready: false,
            reason: Some(CaptionOutputRule::OneStreamQuality),
            description: Some(
                "Captions on a livestream you also record need one stream quality for every destination. Give your destinations the same quality in Destinations, or go live without captions this time.",
            ),
        };
    }
    CaptionOutputReadiness::READY
}

/// `captionRuntimeStartBlocked`: a capture runs with an output captions
/// can't draw on.
pub fn caption_runtime_start_blocked(
    capture_active: bool,
    output: &CaptionOutputReadiness,
) -> bool {
    capture_active && !output.ready
}

/// `captionsEnabledForSession`.
pub fn captions_enabled_for_session(persisted_enabled: bool, suppress_for_session: bool) -> bool {
    persisted_enabled && !suppress_for_session
}

/// `GoLiveCaptionsReadiness['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoLiveCaptionsKind {
    Disabled,
    Ready,
    Blocked,
    Skipped,
}

/// `GoLiveCaptionsReadiness`: whether a Go Live waits on captions, and the
/// dialog's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoLiveCaptionsReadiness {
    pub kind: GoLiveCaptionsKind,
    pub blocks_start: bool,
    pub title: &'static str,
    pub description: String,
    pub transport: Option<AiCapabilitiesCaptionsTransport>,
}

/// What [`decide_go_live_captions_readiness`] reads.
#[derive(Debug, Clone, Copy)]
pub struct GoLiveCaptionsInput<'a> {
    /// `captureConfig.captions.enabled`, and no talk show's room open.
    pub persisted_enabled: bool,
    /// "Go live without captions this time".
    pub suppress_for_session: bool,
    /// `aiCapabilities?.captions`: none while unknown.
    pub capabilities: Option<&'a AiCapabilitiesCaptions>,
    /// The Go Live's output against the caption rules.
    pub output_readiness: Option<&'a CaptionOutputReadiness>,
    /// [`captions_platform_unavailable_reason`].
    pub platform_unavailable: Option<&'a str>,
}

fn blocked(description: &str) -> GoLiveCaptionsReadiness {
    GoLiveCaptionsReadiness {
        kind: GoLiveCaptionsKind::Blocked,
        blocks_start: true,
        title: "Captions unavailable",
        description: description.to_string(),
        transport: None,
    }
}

/// `unavailableReason`.
fn unavailable_reason(code: AiCapabilitiesCaptionsReasonCode) -> &'static str {
    use AiCapabilitiesCaptionsReasonCode as Code;
    match code {
        Code::CloudAiPremiumRequired => {
            "Live captions aren't available for this account. Continue without captions or review your plan."
        }
        Code::AiUserDisabled => {
            "Live captions are disabled for this account. Continue without captions or contact support."
        }
        Code::CaptionsMonthlyQuotaExhausted => {
            "Your monthly live-caption allowance is exhausted. Continue this session without captions."
        }
        Code::AiDisabled | Code::CaptionsDisabled => {
            "Live captions are temporarily disabled on this Videorc deployment."
        }
        Code::CaptionsInvalidConfig | Code::CaptionsNotConfigured => {
            "Live captions aren't configured correctly on this Videorc deployment."
        }
        Code::ReadyChunkedRealtimeDisabled
        | Code::ReadyChunkedRealtimeUnconfigured
        | Code::ReadyRealtime => "Live captions aren't ready on this Videorc deployment.",
    }
}

/// `decideGoLiveCaptionsReadiness`: off, unavailable on this platform,
/// skipped for this session, the output not fit, the deployment not
/// verified or not ready, or ready on its transport.
pub fn decide_go_live_captions_readiness(
    input: GoLiveCaptionsInput<'_>,
) -> GoLiveCaptionsReadiness {
    if !input.persisted_enabled {
        return GoLiveCaptionsReadiness {
            kind: GoLiveCaptionsKind::Disabled,
            blocks_start: false,
            title: "Captions off",
            description: "Live captions aren't enabled for this session.".to_string(),
            transport: None,
        };
    }
    if let Some(reason) = input.platform_unavailable {
        return GoLiveCaptionsReadiness {
            kind: GoLiveCaptionsKind::Skipped,
            blocks_start: false,
            title: "Captions unavailable",
            description: reason.to_string(),
            transport: None,
        };
    }
    if input.suppress_for_session {
        return GoLiveCaptionsReadiness {
            kind: GoLiveCaptionsKind::Skipped,
            blocks_start: false,
            title: "Captions skipped",
            description:
                "This livestream will start without captions. Your saved setting is unchanged."
                    .to_string(),
            transport: None,
        };
    }
    if let Some(output) = input.output_readiness
        && !output.ready
    {
        return blocked(
            output.description.unwrap_or(
                "Live captions aren't compatible with the selected output configuration.",
            ),
        );
    }
    let Some(captions) = input.capabilities else {
        return blocked(
            "Videorc couldn't verify live-caption readiness for this deployment. Try again, or continue this session without captions.",
        );
    };
    let Some(transport) = captions.preferred_transport.filter(|_| captions.available) else {
        return blocked(unavailable_reason(captions.reason_code));
    };
    GoLiveCaptionsReadiness {
        kind: GoLiveCaptionsKind::Ready,
        blocks_start: false,
        title: "Captions ready",
        description: match transport {
            AiCapabilitiesCaptionsTransport::Realtime => {
                "Live microphone transcription is ready.".to_string()
            }
            AiCapabilitiesCaptionsTransport::Chunked => {
                "Caption transcription is ready in 3-second chunks, a few seconds behind."
                    .to_string()
            }
        },
        transport: Some(transport),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(width: u32, height: u32, fps: u32, bitrate_kbps: u32) -> CaptionOutputProfile {
        CaptionOutputProfile {
            width,
            height,
            fps,
            bitrate_kbps,
        }
    }

    fn capabilities(
        available: bool,
        transport: Option<&str>,
        code: &str,
    ) -> AiCapabilitiesCaptions {
        serde_json::from_value(json!({
            "available": available,
            "chunked": {"available": true, "configured": true, "model": "m"},
            "preferredTransport": transport,
            "realtime": {"available": true, "configured": true, "disabled": false, "model": "m"},
            "reasonCode": code,
        }))
        .expect("caption capabilities")
    }

    fn input<'a>() -> GoLiveCaptionsInput<'a> {
        GoLiveCaptionsInput {
            persisted_enabled: true,
            suppress_for_session: false,
            capabilities: None,
            output_readiness: None,
            platform_unavailable: None,
        }
    }

    #[test]
    fn the_output_rules_judge_only_a_captioned_stream() {
        let p1080 = profile(1920, 1080, 30, 6_000);
        let p60 = profile(1920, 1080, 60, 6_000);
        let p720 = profile(1280, 720, 30, 3_000);
        let ready = |burn, record, stream, recording, streams: &[CaptionOutputProfile]| {
            caption_session_output_readiness(burn, record, stream, recording, streams)
        };
        assert!(ready(CaptionBurnTarget::Recording, true, true, p60, &[]).ready);
        assert!(ready(CaptionBurnTarget::Both, true, false, p60, &[]).ready);
        let fast = ready(CaptionBurnTarget::Stream, false, true, p60, &[]);
        assert_eq!(fast.reason, Some(CaptionOutputRule::FrameRate));
        assert_eq!(fast.reason.unwrap().label(), "Need 30 fps or less");
        assert!(
            !ready(CaptionBurnTarget::Both, false, true, p1080, &[p60]).ready,
            "any stream over 30 fps"
        );
        let split = ready(CaptionBurnTarget::Stream, true, true, p1080, &[p1080, p720]);
        assert_eq!(split.reason, Some(CaptionOutputRule::OneStreamQuality));
        assert!(
            ready(
                CaptionBurnTarget::Stream,
                false,
                true,
                p1080,
                &[p1080, p720]
            )
            .ready,
            "without a recording the streams may differ"
        );
        assert!(
            ready(
                CaptionBurnTarget::Stream,
                true,
                true,
                p1080,
                &[p1080, p1080]
            )
            .ready
        );
        assert!(caption_runtime_start_blocked(true, &split));
        assert!(!caption_runtime_start_blocked(false, &split));
    }

    #[test]
    fn a_go_live_waits_on_captions_only_when_they_are_on_and_not_ready() {
        let off = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            persisted_enabled: false,
            ..input()
        });
        assert_eq!(
            (off.kind, off.blocks_start, off.title),
            (GoLiveCaptionsKind::Disabled, false, "Captions off")
        );
        let linux = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            platform_unavailable: captions_platform_unavailable_reason("linux"),
            ..input()
        });
        assert_eq!(
            (linux.kind, linux.blocks_start),
            (GoLiveCaptionsKind::Skipped, false)
        );
        assert_eq!(linux.description, CAPTIONS_UNAVAILABLE_ON_LINUX);
        assert_eq!(captions_platform_unavailable_reason("darwin"), None);
        let skipped = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            suppress_for_session: true,
            ..input()
        });
        assert_eq!(skipped.title, "Captions skipped");
        assert!(!captions_enabled_for_session(true, true));

        let unfit = caption_session_output_readiness(
            CaptionBurnTarget::Stream,
            false,
            true,
            profile(1920, 1080, 60, 6_000),
            &[],
        );
        let blocked_by_output = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            output_readiness: Some(&unfit),
            ..input()
        });
        assert!(blocked_by_output.blocks_start);
        assert_eq!(blocked_by_output.title, "Captions unavailable");
        assert!(blocked_by_output.description.contains("up to 30 fps"));

        let unknown = decide_go_live_captions_readiness(input());
        assert!(unknown.blocks_start, "fail closed while unverified");
        assert!(unknown.description.starts_with("Videorc couldn't verify"));

        let quota = capabilities(false, None, "captions-monthly-quota-exhausted");
        let exhausted = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            capabilities: Some(&quota),
            ..input()
        });
        assert!(exhausted.blocks_start);
        assert_eq!(
            exhausted.description,
            "Your monthly live-caption allowance is exhausted. Continue this session without captions."
        );
        let no_transport = capabilities(true, None, "ready-realtime");
        assert_eq!(
            decide_go_live_captions_readiness(GoLiveCaptionsInput {
                capabilities: Some(&no_transport),
                ..input()
            })
            .description,
            "Live captions aren't ready on this Videorc deployment."
        );

        let realtime = capabilities(true, Some("realtime"), "ready-realtime");
        let ready = decide_go_live_captions_readiness(GoLiveCaptionsInput {
            capabilities: Some(&realtime),
            ..input()
        });
        assert_eq!(
            (ready.kind, ready.blocks_start, ready.transport),
            (
                GoLiveCaptionsKind::Ready,
                false,
                Some(AiCapabilitiesCaptionsTransport::Realtime)
            )
        );
        let chunked = capabilities(true, Some("chunked"), "ready-chunked-realtime-disabled");
        assert!(
            decide_go_live_captions_readiness(GoLiveCaptionsInput {
                capabilities: Some(&chunked),
                ..input()
            })
            .description
            .contains("3-second chunks")
        );
    }
}
