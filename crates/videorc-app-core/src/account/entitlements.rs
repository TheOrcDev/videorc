//! What Premium unlocks (plan 220 S3.0j): the renderer's
//! `lib/entitlements.ts` and `lib/entitlement-ui.ts`, with their sentences,
//! for the pages that read them (the Studio's start, the Go Live gate,
//! Sidekick, Output's quality), and `streamVideoProfileValidationReason` from
//! `lib/capture.ts`, which the streaming profile gate calls.
//!
//! The snapshot is the backend's: it verifies the account's signed token
//! (Ed25519, release builds pinned to the compiled-in key), and its
//! `VIDEORC_PREMIUM_FEATURES` can only force Basic, never unlock anything
//! (`crates/videorc-backend/src/entitlements.rs`). The app reads no switch
//! of its own: a snapshot that never came, or one it cannot read, gates as
//! Basic, so a Premium feature fails closed and a free one stays open.

use videorc_protocol::{
    EntitlementCapability, EntitlementLimits, EntitlementSource, EntitlementState, EntitlementTier,
    EntitlementsSnapshot, FeatureId, RecordingEntitlementLimits, StreamingEntitlementLimits,
    VideoSettings,
};

use crate::notices::{VIDEORC_PREMIUM_URL, is_premium_upgrade_message};
use crate::studio::capture_config::VIDEO_PRESETS;
use crate::studio::health_page::{format_bitrate, format_frame_rate};

/// The gates' words.
pub mod copy {
    /// `DEFAULT_BASIC_ENTITLEMENTS`' reasons.
    pub const CLOUD_AI_REASON: &str = "Cloud AI is a Videorc Premium feature.";
    pub const NOISE_CLEANUP_REASON: &str = "Noise cleanup is part of Videorc Premium.";
    pub const LIVE_COHOST_REASON: &str = "Sidekick requires Videorc Premium.";
    /// A capability with no reason of its own.
    pub const FEATURE_NOT_ENABLED: &str = "This Videorc feature isn't enabled.";
}

/// `STREAMING_MAX_DESTINATIONS`: one destination cap for every plan.
pub const STREAMING_MAX_DESTINATIONS: u32 = 5;

/// `STREAMING_LIMITS`: one streaming ceiling for every plan (Plan 075).
pub const STREAMING_LIMITS: StreamingEntitlementLimits = StreamingEntitlementLimits {
    max_width: 3840,
    max_height: 2160,
    max_fps: 60,
    max_bitrate_kbps: 30_000,
    max_destinations: STREAMING_MAX_DESTINATIONS,
};

/// Recording is free at full quality on every plan.
pub const RECORDING_LIMITS: RecordingEntitlementLimits = RecordingEntitlementLimits {
    max_width: 3840,
    max_height: 2160,
    max_fps: 60,
    max_bitrate_kbps: None,
};

fn capability(
    feature_id: FeatureId,
    state: EntitlementState,
    reason: Option<&str>,
) -> EntitlementCapability {
    EntitlementCapability {
        feature_id,
        state,
        reason: reason.map(str::to_string),
    }
}

/// `DEFAULT_BASIC_ENTITLEMENTS`: what a missing snapshot gates as.
pub fn default_basic_entitlements() -> EntitlementsSnapshot {
    use EntitlementState::{Disabled, Enabled};
    EntitlementsSnapshot {
        schema_version: 1,
        tier: EntitlementTier::Basic,
        plan: None,
        source: EntitlementSource::LocalDefault,
        capabilities: vec![
            capability(FeatureId::LocalRecording, Enabled, None),
            capability(FeatureId::Livestreaming, Enabled, None),
            // Free for every plan; a missing snapshot never locks it.
            capability(FeatureId::Multistreaming, Enabled, None),
            capability(FeatureId::CloudAi, Disabled, Some(copy::CLOUD_AI_REASON)),
            capability(
                FeatureId::NoiseCleanup,
                Disabled,
                Some(copy::NOISE_CLEANUP_REASON),
            ),
            capability(
                FeatureId::LiveCohost,
                Disabled,
                Some(copy::LIVE_COHOST_REASON),
            ),
        ],
        limits: EntitlementLimits {
            recording: RECORDING_LIMITS,
            streaming: STREAMING_LIMITS,
        },
        checked_at: None,
        expires_at: None,
    }
}

/// `entitlementCapability`: the snapshot's capability, else Basic's, else
/// disabled.
pub fn entitlement_capability(
    snapshot: Option<&EntitlementsSnapshot>,
    feature_id: FeatureId,
) -> EntitlementCapability {
    let find = |snapshot: &EntitlementsSnapshot| {
        snapshot
            .capabilities
            .iter()
            .find(|item| item.feature_id == feature_id)
            .cloned()
    };
    snapshot
        .and_then(find)
        .or_else(|| find(&default_basic_entitlements()))
        .unwrap_or_else(|| {
            capability(
                feature_id,
                EntitlementState::Disabled,
                Some(copy::FEATURE_NOT_ENABLED),
            )
        })
}

/// `isFeatureEntitled`: anything but disabled (a developer build's
/// override included).
pub fn is_feature_entitled(snapshot: Option<&EntitlementsSnapshot>, feature_id: FeatureId) -> bool {
    entitlement_capability(snapshot, feature_id).state != EntitlementState::Disabled
}

/// `entitlementDisabledReason`: why a feature is off, or `None` when it is
/// on.
pub fn entitlement_disabled_reason(
    snapshot: Option<&EntitlementsSnapshot>,
    feature_id: FeatureId,
) -> Option<String> {
    let capability = entitlement_capability(snapshot, feature_id);
    (capability.state == EntitlementState::Disabled).then(|| {
        capability
            .reason
            .unwrap_or_else(|| copy::FEATURE_NOT_ENABLED.to_string())
    })
}

/// `EntitlementUiGate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementGate {
    Allowed,
    Locked {
        feature_id: FeatureId,
        reason: String,
        /// View Premium's page, only when the reason sells Premium.
        upgrade_url: Option<&'static str>,
        /// The page offers the fix (lower the quality, turn a destination
        /// off) rather than Premium.
        allow_fix_action: bool,
    },
}

impl EntitlementGate {
    pub fn allowed(&self) -> bool {
        matches!(self, EntitlementGate::Allowed)
    }

    /// The locked gate's reason.
    pub fn reason(&self) -> Option<&str> {
        match self {
            EntitlementGate::Allowed => None,
            EntitlementGate::Locked { reason, .. } => Some(reason),
        }
    }
}

/// `lockedGate`: an upgrade link only for a reason that names Premium.
fn locked_gate(feature_id: FeatureId, reason: String, allow_fix_action: bool) -> EntitlementGate {
    EntitlementGate::Locked {
        upgrade_url: is_premium_upgrade_message(&reason).then_some(VIDEORC_PREMIUM_URL),
        feature_id,
        reason,
        allow_fix_action,
    }
}

/// `featureGate`.
fn feature_gate(snapshot: Option<&EntitlementsSnapshot>, feature_id: FeatureId) -> EntitlementGate {
    if is_feature_entitled(snapshot, feature_id) {
        return EntitlementGate::Allowed;
    }
    locked_gate(
        feature_id,
        entitlement_disabled_reason(snapshot, feature_id)
            .unwrap_or_else(|| copy::FEATURE_NOT_ENABLED.to_string()),
        false,
    )
}

/// `streamingMaxDestinations`.
fn streaming_max_destinations(snapshot: Option<&EntitlementsSnapshot>) -> u32 {
    snapshot
        .map(|snapshot| snapshot.limits.streaming.max_destinations)
        .unwrap_or(STREAMING_MAX_DESTINATIONS)
}

/// `destinationsLimitGate`: a shared pipeline limit, never a plan gate, so
/// its words never name Premium.
fn destinations_limit_gate(max: u32) -> EntitlementGate {
    locked_gate(
        FeatureId::Multistreaming,
        format!("You can stream to up to {max} destinations at once."),
        false,
    )
}

/// `streamingDestinationEnableGate`: whether a destination may be turned
/// on (one already on always may stay on).
pub fn streaming_destination_enable_gate(
    snapshot: Option<&EntitlementsSnapshot>,
    enabled_target_ids: &[String],
    target_id: &str,
) -> EntitlementGate {
    if enabled_target_ids.iter().any(|id| id == target_id) {
        return EntitlementGate::Allowed;
    }
    let livestreaming = feature_gate(snapshot, FeatureId::Livestreaming);
    if !livestreaming.allowed() {
        return livestreaming;
    }
    let max = streaming_max_destinations(snapshot);
    if (enabled_target_ids.len() as u64) < u64::from(max) {
        return EntitlementGate::Allowed;
    }
    destinations_limit_gate(max)
}

/// `streamingDestinationCap`: the Livestream page's rule and its one notice
/// while every allowed destination is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationCap {
    pub max: u32,
    pub at_cap: bool,
    pub rule: String,
    pub notice: Option<String>,
}

pub fn streaming_destination_cap(
    snapshot: Option<&EntitlementsSnapshot>,
    enabled_target_ids: &[String],
) -> DestinationCap {
    let max = streaming_max_destinations(snapshot);
    let at_cap = is_feature_entitled(snapshot, FeatureId::Livestreaming)
        && enabled_target_ids.len() as u64 >= u64::from(max);
    DestinationCap {
        max,
        at_cap,
        rule: format!("Stream to up to {max} at once."),
        notice: at_cap.then(|| {
            format!("{max} destinations are on, the most at once. Turn one off to add another.")
        }),
    }
}

/// `goLiveEntitlementGate`: livestreaming is on, and no more destinations
/// are on than the cap (a stale over-cap set is fixable on the page).
pub fn go_live_entitlement_gate(
    snapshot: Option<&EntitlementsSnapshot>,
    enabled_target_ids: &[String],
) -> EntitlementGate {
    let livestreaming = feature_gate(snapshot, FeatureId::Livestreaming);
    if !livestreaming.allowed() {
        return livestreaming;
    }
    let max = streaming_max_destinations(snapshot);
    if enabled_target_ids.len() as u64 <= u64::from(max) {
        return EntitlementGate::Allowed;
    }
    match destinations_limit_gate(max) {
        EntitlementGate::Locked {
            feature_id,
            reason,
            upgrade_url,
            ..
        } => EntitlementGate::Locked {
            feature_id,
            reason,
            upgrade_url,
            allow_fix_action: true,
        },
        allowed => allowed,
    }
}

/// `cloudAiUploadGate`.
pub fn cloud_ai_upload_gate(snapshot: Option<&EntitlementsSnapshot>) -> EntitlementGate {
    feature_gate(snapshot, FeatureId::CloudAi)
}

/// `noiseCleanupGate`.
pub fn noise_cleanup_gate(snapshot: Option<&EntitlementsSnapshot>) -> EntitlementGate {
    feature_gate(snapshot, FeatureId::NoiseCleanup)
}

/// `liveCohostGate`: Sidekick (Premium), fail-closed like every cloud gate.
pub fn live_cohost_gate(snapshot: Option<&EntitlementsSnapshot>) -> EntitlementGate {
    feature_gate(snapshot, FeatureId::LiveCohost)
}

/// Which limits a profile is held to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileKind {
    Recording,
    Streaming,
}

impl ProfileKind {
    fn word(self) -> &'static str {
        match self {
            ProfileKind::Recording => "recording",
            ProfileKind::Streaming => "streaming",
        }
    }
}

/// The preset's wire name (`tutorial-1080p30`, `custom`, …).
fn preset_name(video: &VideoSettings) -> String {
    serde_json::to_value(&video.preset)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// `formatVideoQuality(video, { size: 'full', bitrate })`: "1920 × 1080 ·
/// 30 fps", with " · 6 Mbps" when asked and known.
pub fn format_video_quality_full(
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: Option<u32>,
) -> String {
    let mut parts = vec![
        format!("{width} × {height}"),
        format_frame_rate(f64::from(fps)),
    ];
    if let Some(rate) = format_bitrate(bitrate_kbps.map(f64::from)) {
        parts.push(rate);
    }
    parts.join(" · ")
}

/// `streamVideoProfileValidationReason` (`lib/capture.ts`): why a profile
/// can't be streamed, or `None`. `youtube` is the destination's platform
/// when known (`Some(false)` for another platform, `None` when unknown).
pub fn stream_video_profile_validation_reason(
    video: &VideoSettings,
    youtube: Option<bool>,
) -> Option<String> {
    let preset = preset_name(video);
    let named = VIDEO_PRESETS
        .iter()
        .find(|(name, ..)| *name == preset)
        .copied();
    if preset != "custom" {
        let exact = named.is_some_and(|(_, width, height, fps, bitrate)| {
            width == video.width
                && height == video.height
                && fps == video.fps
                && bitrate == video.bitrate_kbps
        });
        if !exact {
            let (width, height, fps, bitrate) = named
                .map(|(_, width, height, fps, bitrate)| (width, height, fps, bitrate))
                .unwrap_or((video.width, video.height, video.fps, video.bitrate_kbps));
            return Some(format!(
                "{preset} must use its exact {} profile.",
                format_video_quality_full(width, height, fps, Some(bitrate))
            ));
        }
    }
    let youtube_preset = matches!(
        preset.as_str(),
        "stream-youtube-1080p30" | "stream-youtube-1080p60" | "stream-youtube-4k30"
    );
    if youtube == Some(false) && youtube_preset {
        return Some(format!(
            "{preset} is available only for YouTube destinations."
        ));
    }
    if video.width >= 3840 || video.height >= 2160 {
        let exact_4k = preset == "stream-youtube-4k30"
            && video.width == 3840
            && video.height == 2160
            && video.fps == 30
            && video.bitrate_kbps == 30_000;
        return (!exact_4k)
            .then(|| "True 4K streaming requires the exact YouTube 4K30 profile.".to_string());
    }
    if video.width > 1920 || video.height > 1080 {
        return Some(
            "Livestream output above 1080p requires the exact YouTube 4K30 profile.".to_string(),
        );
    }
    if video.bitrate_kbps > 6_000
        && preset != "stream-youtube-1080p30"
        && preset != "stream-youtube-1080p60"
    {
        return Some(format!(
            "Livestream output above {} requires an exact YouTube 1080p30 or 1080p60 profile.",
            format_bitrate(Some(6_000.0)).unwrap_or_default()
        ));
    }
    None
}

/// `videoProfileEntitlementGate`: the feature is on, and the profile fits
/// the shared ceiling (recording in either orientation, streaming on its own
/// axes) and, for a stream, is a profile Videorc streams. Over the ceiling
/// is a pipeline limit with the fix offered, never Premium.
pub fn video_profile_entitlement_gate(
    snapshot: Option<&EntitlementsSnapshot>,
    kind: ProfileKind,
    video: &VideoSettings,
) -> EntitlementGate {
    let feature_id = match kind {
        ProfileKind::Recording => FeatureId::LocalRecording,
        ProfileKind::Streaming => FeatureId::Livestreaming,
    };
    let feature = feature_gate(snapshot, feature_id);
    if !feature.allowed() {
        return feature;
    }
    let (max_width, max_height, max_fps, max_bitrate) = match kind {
        ProfileKind::Recording => {
            let limits = snapshot.map_or(RECORDING_LIMITS, |s| s.limits.recording);
            (
                limits.max_width,
                limits.max_height,
                limits.max_fps,
                limits.max_bitrate_kbps,
            )
        }
        ProfileKind::Streaming => {
            let limits = snapshot.map_or(STREAMING_LIMITS, |s| s.limits.streaming);
            (
                limits.max_width,
                limits.max_height,
                limits.max_fps,
                Some(limits.max_bitrate_kbps),
            )
        }
    };
    let over_size = match kind {
        ProfileKind::Recording => {
            video.width.max(video.height) > max_width.max(max_height)
                || video.width.min(video.height) > max_width.min(max_height)
        }
        ProfileKind::Streaming => video.width > max_width || video.height > max_height,
    };
    let over_limit = over_size
        || video.fps > max_fps
        || max_bitrate.is_some_and(|limit| video.bitrate_kbps > limit);
    if !over_limit {
        let unsupported = match kind {
            ProfileKind::Streaming => stream_video_profile_validation_reason(video, None),
            ProfileKind::Recording => None,
        };
        return match unsupported {
            Some(reason) => locked_gate(feature_id, reason, true),
            None => EntitlementGate::Allowed,
        };
    }
    let profile = format_video_quality_full(video.width, video.height, video.fps, None);
    let word = kind.word();
    // `formatLimit`.
    let limit = format!(
        "Your {word} limit is {}.",
        format_video_quality_full(max_width, max_height, max_fps, max_bitrate)
    );
    locked_gate(
        feature_id,
        format!("{profile} exceeds the {word} limit. {limit}"),
        true,
    )
}

/// The tier a snapshot names, for the account menu's badge.
pub fn tier_of(snapshot: Option<&EntitlementsSnapshot>) -> Option<EntitlementTier> {
    snapshot.map(|snapshot| snapshot.tier)
}

/// Reads an `entitlements.*` answer or event: the snapshot when it is one,
/// else `None`, which gates as Basic (never as anything more).
pub fn read_snapshot(value: &serde_json::Value) -> Option<EntitlementsSnapshot> {
    serde_json::from_value(value.clone()).ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use videorc_protocol::VideoPreset;

    use super::*;

    fn premium() -> EntitlementsSnapshot {
        use EntitlementState::Enabled;
        EntitlementsSnapshot {
            schema_version: 1,
            tier: EntitlementTier::Premium,
            plan: None,
            source: EntitlementSource::Creem,
            capabilities: vec![
                capability(FeatureId::LocalRecording, Enabled, None),
                capability(FeatureId::Livestreaming, Enabled, None),
                capability(FeatureId::Multistreaming, Enabled, None),
                capability(FeatureId::CloudAi, Enabled, None),
                capability(FeatureId::NoiseCleanup, Enabled, None),
            ],
            limits: EntitlementLimits {
                recording: RecordingEntitlementLimits {
                    max_bitrate_kbps: Some(50_000),
                    ..RECORDING_LIMITS
                },
                streaming: STREAMING_LIMITS,
            },
            checked_at: None,
            expires_at: None,
        }
    }

    fn developer() -> EntitlementsSnapshot {
        let mut snapshot = premium();
        snapshot.tier = EntitlementTier::Developer;
        snapshot.source = EntitlementSource::EnvOverride;
        for capability in &mut snapshot.capabilities {
            capability.state = EntitlementState::DeveloperOverride;
            capability.reason = Some("Enabled by Videorc debug/dev backend build.".to_string());
        }
        snapshot
    }

    fn video(preset: &str, width: u32, height: u32, fps: u32, bitrate_kbps: u32) -> VideoSettings {
        VideoSettings {
            preset: serde_json::from_value::<VideoPreset>(json!(preset)).expect(preset),
            width,
            height,
            fps,
            bitrate_kbps,
        }
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    const CAP_REASON: &str = "You can stream to up to 5 destinations at once.";
    const FIVE: [&str; 5] = ["youtube", "twitch", "x", "custom-a", "custom-b"];

    fn locked(feature_id: FeatureId, reason: &str, fix: bool) -> EntitlementGate {
        EntitlementGate::Locked {
            feature_id,
            reason: reason.to_string(),
            upgrade_url: None,
            allow_fix_action: fix,
        }
    }

    // ── entitlements.test.ts ─────────────────────────────────────────────

    #[test]
    fn keeps_local_recording_enabled_before_the_snapshot_loads() {
        assert!(is_feature_entitled(None, FeatureId::LocalRecording));
        assert_eq!(
            entitlement_disabled_reason(None, FeatureId::LocalRecording),
            None
        );
    }

    #[test]
    fn treats_a_missing_snapshot_as_basic_with_full_quality_and_free_multistreaming() {
        assert!(is_feature_entitled(None, FeatureId::Livestreaming));
        assert!(is_feature_entitled(None, FeatureId::Multistreaming));
        assert_eq!(
            entitlement_disabled_reason(None, FeatureId::Multistreaming),
            None
        );
        for (feature, reason) in [
            (FeatureId::CloudAi, copy::CLOUD_AI_REASON),
            (FeatureId::LiveCohost, copy::LIVE_COHOST_REASON),
            (FeatureId::NoiseCleanup, copy::NOISE_CLEANUP_REASON),
        ] {
            assert!(!is_feature_entitled(None, feature), "{feature:?}");
            assert_eq!(
                entitlement_disabled_reason(None, feature).as_deref(),
                Some(reason)
            );
            assert!(reason.contains("Premium"));
        }
        let basic = default_basic_entitlements();
        assert_eq!(
            (
                basic.limits.recording.max_width,
                basic.limits.recording.max_height,
                basic.limits.recording.max_fps
            ),
            (3840, 2160, 60)
        );
        assert_eq!(STREAMING_MAX_DESTINATIONS, 5);
        assert_eq!(basic.limits.streaming, STREAMING_LIMITS);
        assert_eq!(STREAMING_LIMITS.max_bitrate_kbps, 30_000);
    }

    #[test]
    fn treats_the_developer_override_as_entitled() {
        let dev = developer();
        for feature in [
            FeatureId::Livestreaming,
            FeatureId::Multistreaming,
            FeatureId::CloudAi,
            FeatureId::NoiseCleanup,
        ] {
            assert!(is_feature_entitled(Some(&dev), feature), "{feature:?}");
        }
        assert_eq!(
            entitlement_disabled_reason(Some(&dev), FeatureId::CloudAi),
            None
        );
    }

    #[test]
    fn a_thin_snapshot_falls_back_closed_for_premium_and_open_for_free() {
        let mut thin = default_basic_entitlements();
        thin.capabilities.clear();
        assert_eq!(
            entitlement_capability(Some(&thin), FeatureId::CloudAi).state,
            EntitlementState::Disabled
        );
        assert_eq!(
            entitlement_capability(Some(&thin), FeatureId::Multistreaming).state,
            EntitlementState::Enabled
        );
    }

    // ── The app never unlocks: only the backend's snapshot does ──────────

    #[test]
    fn a_snapshot_the_app_cannot_read_gates_as_basic_never_more() {
        // A forged answer (an unknown tier, a capability that isn't the
        // wire's) does not parse: the gates read Basic.
        for forged in [
            json!({"tier": "premium"}),
            json!({"schemaVersion": 1, "tier": "platinum", "source": "creem",
                   "capabilities": [], "limits": {}}),
            json!(null),
            json!("premium"),
        ] {
            let read = read_snapshot(&forged);
            assert_eq!(read, None, "{forged}");
            assert!(!live_cohost_gate(read.as_ref()).allowed());
            assert!(!noise_cleanup_gate(read.as_ref()).allowed());
            assert!(!cloud_ai_upload_gate(read.as_ref()).allowed());
            assert!(go_live_entitlement_gate(read.as_ref(), &ids(&["youtube"])).allowed());
        }
        // The backend's Premium snapshot, as the wire carries it, unlocks.
        let wire = serde_json::to_value(premium()).unwrap();
        assert_eq!(read_snapshot(&wire), Some(premium()));
        assert!(noise_cleanup_gate(read_snapshot(&wire).as_ref()).allowed());
    }

    #[test]
    fn the_app_reads_no_switch_of_its_own() {
        // The gates take the backend's snapshot and nothing else: no
        // environment variable reaches them. (The backend's own
        // VIDEORC_PREMIUM_FEATURES only forces Basic: its tests
        // `entitlement_env_is_downgrade_only` and
        // `entitlement_token_rejects_tamper_expiry_and_wrong_key`.)
        let source = include_str!("entitlements.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("std::env"), "the gates read no environment");
        assert!(!code.contains("env::var"), "the gates read no environment");
    }

    // ── entitlement-ui.test.ts ───────────────────────────────────────────

    #[test]
    fn basic_may_turn_on_any_first_destination_and_a_missing_snapshot_still_multistreams() {
        let basic = default_basic_entitlements();
        for target in ["youtube", "twitch", "x", "custom"] {
            assert_eq!(
                streaming_destination_enable_gate(Some(&basic), &[], target),
                EntitlementGate::Allowed
            );
        }
        assert!(streaming_destination_enable_gate(None, &[], "youtube").allowed());
        assert!(streaming_destination_enable_gate(None, &ids(&["youtube"]), "twitch").allowed());
        assert_eq!(
            streaming_destination_enable_gate(None, &ids(&FIVE), "custom-c"),
            locked(FeatureId::Multistreaming, CAP_REASON, false)
        );
    }

    #[test]
    fn puts_the_cap_in_the_rule_and_one_notice_only_at_the_cap() {
        let basic = default_basic_entitlements();
        assert_eq!(
            streaming_destination_cap(Some(&basic), &ids(&["youtube"])),
            DestinationCap {
                max: 5,
                at_cap: false,
                rule: "Stream to up to 5 at once.".to_string(),
                notice: None
            }
        );
        let full = streaming_destination_cap(Some(&premium()), &ids(&FIVE));
        assert!(full.at_cap);
        assert_eq!(
            full.notice.as_deref(),
            Some("5 destinations are on, the most at once. Turn one off to add another.")
        );
    }

    #[test]
    fn every_tier_turns_on_up_to_five_and_none_the_sixth_with_a_neutral_reason() {
        for snapshot in [default_basic_entitlements(), premium(), developer()] {
            for on in 0..5 {
                assert!(
                    streaming_destination_enable_gate(Some(&snapshot), &ids(&FIVE[..on]), FIVE[on])
                        .allowed()
                );
            }
            let gate = streaming_destination_enable_gate(Some(&snapshot), &ids(&FIVE), "custom-c");
            assert_eq!(gate, locked(FeatureId::Multistreaming, CAP_REASON, false));
            assert!(!CAP_REASON.to_lowercase().contains("premium"));
        }
    }

    #[test]
    fn keeps_a_stale_over_cap_set_fixable() {
        let mut six = ids(&FIVE);
        six.push("custom-c".to_string());
        let basic = default_basic_entitlements();
        for target in &six {
            assert!(streaming_destination_enable_gate(Some(&basic), &six, target).allowed());
        }
        assert_eq!(
            streaming_destination_enable_gate(Some(&basic), &six, "custom-d"),
            locked(FeatureId::Multistreaming, CAP_REASON, false)
        );
        for snapshot in [basic, premium()] {
            assert_eq!(
                go_live_entitlement_gate(Some(&snapshot), &six),
                locked(FeatureId::Multistreaming, CAP_REASON, true)
            );
        }
    }

    #[test]
    fn go_live_is_allowed_up_to_the_cap_for_every_tier() {
        let mut six = ids(&FIVE);
        six.push("custom-c".to_string());
        for snapshot in [default_basic_entitlements(), premium(), developer()] {
            assert!(go_live_entitlement_gate(Some(&snapshot), &ids(&["youtube"])).allowed());
            assert!(go_live_entitlement_gate(Some(&snapshot), &ids(&FIVE)).allowed());
            assert!(matches!(
                go_live_entitlement_gate(Some(&snapshot), &six),
                EntitlementGate::Locked {
                    feature_id: FeatureId::Multistreaming,
                    allow_fix_action: true,
                    ..
                }
            ));
        }
    }

    #[test]
    fn go_live_says_why_when_livestreaming_itself_is_off() {
        let mut off = default_basic_entitlements();
        off.capabilities[1] = capability(
            FeatureId::Livestreaming,
            EntitlementState::Disabled,
            Some("Livestreaming requires Videorc Premium."),
        );
        assert_eq!(
            go_live_entitlement_gate(Some(&off), &ids(&["youtube"])),
            EntitlementGate::Locked {
                feature_id: FeatureId::Livestreaming,
                reason: "Livestreaming requires Videorc Premium.".to_string(),
                upgrade_url: Some(VIDEORC_PREMIUM_URL),
                allow_fix_action: false,
            }
        );
    }

    #[test]
    fn the_premium_gates_link_to_premium_and_buddy_fails_closed() {
        let basic = default_basic_entitlements();
        assert_eq!(
            cloud_ai_upload_gate(Some(&basic)),
            EntitlementGate::Locked {
                feature_id: FeatureId::CloudAi,
                reason: copy::CLOUD_AI_REASON.to_string(),
                upgrade_url: Some(VIDEORC_PREMIUM_URL),
                allow_fix_action: false,
            }
        );
        assert_eq!(
            noise_cleanup_gate(None),
            EntitlementGate::Locked {
                feature_id: FeatureId::NoiseCleanup,
                reason: copy::NOISE_CLEANUP_REASON.to_string(),
                upgrade_url: Some(VIDEORC_PREMIUM_URL),
                allow_fix_action: false,
            }
        );
        assert_eq!(noise_cleanup_gate(Some(&basic)), noise_cleanup_gate(None));
        assert!(noise_cleanup_gate(Some(&premium())).allowed());
        assert_eq!(
            live_cohost_gate(None),
            EntitlementGate::Locked {
                feature_id: FeatureId::LiveCohost,
                reason: copy::LIVE_COHOST_REASON.to_string(),
                upgrade_url: Some(VIDEORC_PREMIUM_URL),
                allow_fix_action: false,
            }
        );
        // Premium without a live-cohost capability falls back to Basic's.
        assert!(!live_cohost_gate(Some(&premium())).allowed());
        let mut with_buddy = premium();
        with_buddy.capabilities.push(capability(
            FeatureId::LiveCohost,
            EntitlementState::Enabled,
            None,
        ));
        assert!(live_cohost_gate(Some(&with_buddy)).allowed());
        assert!(cloud_ai_upload_gate(Some(&developer())).allowed());
        assert!(noise_cleanup_gate(Some(&developer())).allowed());
    }

    #[test]
    fn every_supported_stream_profile_passes_on_basic() {
        let profiles = [
            video("stream-youtube-4k30", 3840, 2160, 30, 30_000),
            video("stream-youtube-1080p30", 1920, 1080, 30, 10_000),
            video("stream-youtube-1080p60", 1920, 1080, 60, 12_000),
            video("stream-safe-1080p60", 1920, 1080, 60, 6_000),
        ];
        for profile in &profiles {
            for snapshot in [
                None,
                Some(default_basic_entitlements()),
                Some(premium()),
                Some(developer()),
            ] {
                assert_eq!(
                    video_profile_entitlement_gate(
                        snapshot.as_ref(),
                        ProfileKind::Streaming,
                        profile
                    ),
                    EntitlementGate::Allowed,
                    "{profile:?}"
                );
            }
        }
    }

    #[test]
    fn rejects_unsupported_4k60_streaming_under_the_shared_ceiling() {
        let unsupported = video("custom", 3840, 2160, 60, 30_000);
        for snapshot in [default_basic_entitlements(), premium(), developer()] {
            let gate = video_profile_entitlement_gate(
                Some(&snapshot),
                ProfileKind::Streaming,
                &unsupported,
            );
            assert_eq!(
                gate,
                locked(
                    FeatureId::Livestreaming,
                    "True 4K streaming requires the exact YouTube 4K30 profile.",
                    true
                )
            );
        }
    }

    #[test]
    fn refuses_an_over_ceiling_stream_with_a_neutral_reason() {
        let over = video("custom", 1920, 1080, 30, 40_000);
        for snapshot in [
            None,
            Some(default_basic_entitlements()),
            Some(premium()),
            Some(developer()),
        ] {
            let gate =
                video_profile_entitlement_gate(snapshot.as_ref(), ProfileKind::Streaming, &over);
            assert_eq!(
                gate,
                locked(
                    FeatureId::Livestreaming,
                    "1920 × 1080 · 30 fps exceeds the streaming limit. Your streaming limit is 3840 × 2160 · 60 fps · 30 Mbps.",
                    true
                )
            );
        }
    }

    #[test]
    fn recording_is_free_at_every_preset_and_locked_past_the_shared_cap() {
        let basic = default_basic_entitlements();
        for profile in [
            video("tutorial-1080p30", 1920, 1080, 30, 6_000),
            video("record-4k30", 3840, 2160, 30, 30_000),
            video("record-4k60-experimental", 3840, 2160, 60, 50_000),
        ] {
            assert_eq!(
                video_profile_entitlement_gate(Some(&basic), ProfileKind::Recording, &profile),
                EntitlementGate::Allowed
            );
        }
        let eight_k = video("custom", 7680, 4320, 30, 80_000);
        assert_eq!(
            video_profile_entitlement_gate(Some(&basic), ProfileKind::Recording, &eight_k),
            locked(
                FeatureId::LocalRecording,
                "7680 × 4320 · 30 fps exceeds the recording limit. Your recording limit is 3840 × 2160 · 60 fps.",
                true
            )
        );
    }

    #[test]
    fn recording_takes_both_orientations_and_holds_both_sides() {
        for snapshot in [Some(default_basic_entitlements()), None] {
            for (width, height, fps, bitrate) in [
                (2560, 1440, 30, 8_000),
                (2560, 1440, 60, 16_000),
                (3840, 2160, 30, 30_000),
            ] {
                for (w, h) in [(width, height), (height, width)] {
                    assert!(
                        video_profile_entitlement_gate(
                            snapshot.as_ref(),
                            ProfileKind::Recording,
                            &video("custom", w, h, fps, bitrate)
                        )
                        .allowed()
                    );
                }
            }
        }
        let basic = default_basic_entitlements();
        for (width, height) in [(3850, 2160), (2160, 3850), (3000, 2200), (2200, 3000)] {
            assert!(matches!(
                video_profile_entitlement_gate(
                    Some(&basic),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 8_000)
                ),
                EntitlementGate::Locked {
                    feature_id: FeatureId::LocalRecording,
                    allow_fix_action: true,
                    ..
                }
            ));
        }
        for (width, height) in [(2560, 1440), (1440, 2560)] {
            assert!(
                !video_profile_entitlement_gate(
                    Some(&basic),
                    ProfileKind::Recording,
                    &video("custom", width, height, 61, 16_000)
                )
                .allowed()
            );
        }
    }

    #[test]
    fn a_disabled_recording_capability_stays_closed_with_its_own_reason() {
        let mut off = default_basic_entitlements();
        off.capabilities[0] = capability(
            FeatureId::LocalRecording,
            EntitlementState::Disabled,
            Some("Local recording is disabled."),
        );
        for (width, height) in [(2560, 1440), (1440, 2560)] {
            assert_eq!(
                video_profile_entitlement_gate(
                    Some(&off),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 8_000)
                ),
                locked(
                    FeatureId::LocalRecording,
                    "Local recording is disabled.",
                    false
                )
            );
        }
    }

    #[test]
    fn a_narrower_recording_rectangle_and_a_bitrate_cap_hold_in_both_orientations() {
        let mut narrow = default_basic_entitlements();
        narrow.limits.recording = RecordingEntitlementLimits {
            max_width: 1920,
            max_height: 1080,
            max_fps: 60,
            max_bitrate_kbps: None,
        };
        for (width, height) in [(1920, 1080), (1080, 1920)] {
            assert!(
                video_profile_entitlement_gate(
                    Some(&narrow),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 6_000)
                )
                .allowed()
            );
        }
        for (width, height) in [(1920, 1081), (1081, 1920)] {
            assert!(
                !video_profile_entitlement_gate(
                    Some(&narrow),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 6_000)
                )
                .allowed()
            );
        }
        let mut capped = default_basic_entitlements();
        capped.limits.recording.max_bitrate_kbps = Some(8_000);
        for (width, height) in [(2560, 1440), (1440, 2560)] {
            assert!(
                video_profile_entitlement_gate(
                    Some(&capped),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 7_999)
                )
                .allowed()
            );
            assert!(
                !video_profile_entitlement_gate(
                    Some(&capped),
                    ProfileKind::Recording,
                    &video("custom", width, height, 30, 8_001)
                )
                .allowed()
            );
        }
    }

    #[test]
    fn streaming_ceilings_keep_their_width_and_height_axes() {
        let mut narrow = default_basic_entitlements();
        narrow.limits.streaming.max_width = 1920;
        narrow.limits.streaming.max_height = 1080;
        assert!(
            video_profile_entitlement_gate(
                Some(&narrow),
                ProfileKind::Streaming,
                &video("custom", 1920, 1080, 30, 6_000)
            )
            .allowed()
        );
        let portrait = video_profile_entitlement_gate(
            Some(&narrow),
            ProfileKind::Streaming,
            &video("custom", 1080, 1920, 30, 6_000),
        );
        assert!(
            portrait
                .reason()
                .is_some_and(|reason| reason.contains("exceeds the streaming limit")),
            "{portrait:?}"
        );
    }

    #[test]
    fn the_stream_profile_check_names_the_exact_profile() {
        assert_eq!(
            stream_video_profile_validation_reason(
                &video("stream-youtube-1080p30", 1920, 1080, 30, 9_000),
                None
            )
            .as_deref(),
            Some(
                "stream-youtube-1080p30 must use its exact 1920 × 1080 · 30 fps · 10 Mbps profile."
            )
        );
        assert_eq!(
            stream_video_profile_validation_reason(
                &video("stream-youtube-1080p60", 1920, 1080, 60, 12_000),
                Some(false)
            )
            .as_deref(),
            Some("stream-youtube-1080p60 is available only for YouTube destinations.")
        );
        assert_eq!(
            stream_video_profile_validation_reason(&video("custom", 2560, 1440, 30, 6_000), None)
                .as_deref(),
            Some("Livestream output above 1080p requires the exact YouTube 4K30 profile.")
        );
        assert_eq!(
            stream_video_profile_validation_reason(&video("custom", 1920, 1080, 30, 8_000), None)
                .as_deref(),
            Some(
                "Livestream output above 6 Mbps requires an exact YouTube 1080p30 or 1080p60 profile."
            )
        );
        assert_eq!(
            stream_video_profile_validation_reason(
                &video("tutorial-1080p30", 1920, 1080, 30, 6_000),
                None
            ),
            None
        );
    }
}
