//! Multi-platform streaming target model (per-target). Mirrors the renderer's
//! `StreamingSettings` and is now consumed by session start, preflight, storage,
//! renderer protocol paths, and the FFmpeg `tee` fan-out.
//!
//! The broad dead-code allowance remains temporary for provider/platform
//! metadata and future status fields that are staged ahead of full multi-target
//! live operations. Plan 010 owns narrowing or removing it after Plan 006 is
//! accepted and the final split-output engine shape is known.
#![allow(dead_code)]

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::protocol::{RtmpPreset, RtmpSettings, VideoPreset};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum StreamPlatform {
    Youtube,
    Twitch,
    X,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamUrlMode {
    ServerAndKey,
    FullUrl,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamAuthMode {
    ManualRtmp,
    Oauth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamMode {
    Single,
    Multi,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamTargetState {
    NotConfigured,
    Ready,
    Connecting,
    Live,
    Warning,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetStatus {
    pub state: StreamTargetState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped_frames: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetSettings {
    pub id: String,
    pub platform: StreamPlatform,
    pub label: String,
    pub enabled: bool,
    pub server_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_mode: Option<StreamUrlMode>,
    // Raw only while a manual key is being edited or loaded from legacy config.
    // Saved OAuth/manual keys use stream_key_secret_ref plus stream_key_present.
    pub stream_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key_secret_ref: Option<String>,
    pub stream_key_present: bool,
    pub auth_mode: StreamAuthMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_broadcast_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_stream_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preset: Option<VideoPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bitrate_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<StreamTargetStatus>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamingSettings {
    pub enabled: bool,
    pub mode: StreamMode,
    pub targets: Vec<StreamTargetSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_target_id: Option<String>,
    pub default_output_preset: VideoPreset,
    pub default_bitrate_kbps: u32,
    pub enabled_target_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreManualStreamKeyParams {
    pub target_id: String,
    pub stream_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreManualStreamKeyResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key_secret_ref: Option<String>,
    pub stream_key_present: bool,
    /// Masked tail ("••••1234") so the UI can say WHICH key is saved without
    /// ever round-tripping the secret itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key_hint: Option<String>,
    /// A replaced or cleared key is archived as the "previous key" so an
    /// accidental paste-over is recoverable with one click.
    #[serde(default)]
    pub previous_stream_key_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_stream_key_hint: Option<String>,
}

/// Params for restore/inspect requests that address a target's manual key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualStreamKeyRefParams {
    pub target_id: String,
}

pub fn manual_stream_key_secret_ref(target_id: &str) -> Result<String> {
    if target_id.trim().is_empty()
        || !target_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        bail!("Stream target id is invalid.");
    }
    Ok(format!("stream-target:{target_id}:manual-stream-key"))
}

/// The archive slot a replaced/cleared key moves into (per target, like the
/// live slot, so restoring YouTube can never touch Twitch).
pub fn manual_stream_key_previous_secret_ref(target_id: &str) -> Result<String> {
    Ok(format!(
        "{}:previous",
        manual_stream_key_secret_ref(target_id)?
    ))
}

/// Masked tail of a stored key. Short keys mask entirely instead of leaking
/// most of their characters.
pub fn stream_key_hint(key: &str) -> String {
    let trimmed = key.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() < 8 {
        return "••••".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("••••{tail}")
}

/// The next contents of the current + previous key slots after a store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualStreamKeyPlan {
    pub next_current: Option<String>,
    pub next_previous: Option<String>,
}

/// Storing a key archives the value it replaces (including clears) so the user
/// can always get one step back. Re-saving the identical key keeps the archive
/// untouched instead of destroying it with a duplicate.
pub fn plan_manual_stream_key_store(
    current: Option<&str>,
    previous: Option<&str>,
    new_key: &str,
) -> ManualStreamKeyPlan {
    let new_key = new_key.trim();
    let next_current = if new_key.is_empty() {
        None
    } else {
        Some(new_key.to_string())
    };
    let next_previous = match current {
        Some(existing) if existing != new_key => Some(existing.to_string()),
        _ => previous.map(str::to_string),
    };
    ManualStreamKeyPlan {
        next_current,
        next_previous,
    }
}

/// Restoring swaps current and previous, so restore itself is undoable by
/// restoring again. With no current key the previous simply moves back.
pub fn plan_manual_stream_key_restore(
    current: Option<&str>,
    previous: Option<&str>,
) -> Result<ManualStreamKeyPlan> {
    let Some(previous) = previous else {
        bail!("No previous stream key is saved for this target.");
    };
    Ok(ManualStreamKeyPlan {
        next_current: Some(previous.to_string()),
        next_previous: current.map(str::to_string),
    })
}

/// Builds the wire result for any manual-key operation from slot contents.
pub fn manual_stream_key_state(
    target_id: &str,
    current: Option<&str>,
    previous: Option<&str>,
) -> Result<StoreManualStreamKeyResult> {
    Ok(StoreManualStreamKeyResult {
        stream_key_secret_ref: current
            .map(|_| manual_stream_key_secret_ref(target_id))
            .transpose()?,
        stream_key_present: current.is_some(),
        stream_key_hint: current.map(stream_key_hint),
        previous_stream_key_present: previous.is_some(),
        previous_stream_key_hint: previous.map(stream_key_hint),
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformAccountStatus {
    Connected,
    NeedsReconnect,
    Disconnected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamPrivacy {
    Public,
    Unlisted,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamMetadataDraft {
    pub title: String,
    pub description: String,
    pub default_privacy: StreamPrivacy,
    pub target_overrides: Vec<StreamTargetMetadataDraft>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetMetadataDraft {
    pub platform: StreamPlatform,
    pub customize: bool,
    pub title: String,
    pub description: String,
    pub privacy: StreamPrivacy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube_made_for_kids: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_category_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twitch_language: Option<String>,
    /// X has no unlisted/private concept — the only reach lever the
    /// Livestream API exposes is suppressing the announcement post
    /// (`should_not_tweet`). None means announce (the platform default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_announce: Option<bool>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamMetadataValidation {
    pub valid: bool,
    pub issues: Vec<StreamMetadataValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamMetadataValidationIssue {
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<StreamPlatform>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAccount {
    pub id: String,
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub access_token_present: bool,
    pub refresh_token_present: bool,
    pub stream_key_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub connected_at: String,
    pub updated_at: String,
    pub status: PlatformAccountStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertPlatformAccount {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub account_handle: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub token_secret_ref: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub stream_key_secret_ref: Option<String>,
    pub expires_at: Option<String>,
    pub status: PlatformAccountStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAccountPlatformParams {
    pub platform: StreamPlatform,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformAccountValidationState {
    Valid,
    Refreshed,
    NeedsReconnect,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAccountValidation {
    pub platform: StreamPlatform,
    pub state: PlatformAccountValidationState,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSessionTargetHistory {
    pub target_id: String,
    pub platform: StreamPlatform,
    pub label: String,
    pub attempted: bool,
    pub skipped: bool,
    pub status_timeline: Vec<StreamTargetStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_url: Option<String>,
}

/// A point-in-time runtime status for one stream destination during an active
/// session. Emitted (as a list) on the `stream.targets` event in M5; distinct from
/// the persisted `StreamTargetSettings.status`. The renderer keys these by
/// `target_id` and resets them when the session returns to idle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetRuntime {
    pub target_id: String,
    pub platform: StreamPlatform,
    pub label: String,
    pub state: StreamTargetState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_url: Option<String>,
}

/// The full per-target runtime snapshot for a session, replacing the renderer's map
/// wholesale each time it is emitted (avoids partial-update ordering races).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetsSnapshot {
    pub session_id: String,
    pub targets: Vec<StreamTargetRuntime>,
}

pub(crate) fn stream_platform_id(platform: StreamPlatform) -> &'static str {
    match platform {
        StreamPlatform::Youtube => "youtube",
        StreamPlatform::Twitch => "twitch",
        StreamPlatform::X => "x",
        StreamPlatform::Custom => "custom",
    }
}

pub(crate) fn stream_platform_from_id(platform: &str) -> Option<StreamPlatform> {
    match platform {
        "youtube" => Some(StreamPlatform::Youtube),
        "twitch" => Some(StreamPlatform::Twitch),
        "x" => Some(StreamPlatform::X),
        "custom" => Some(StreamPlatform::Custom),
        _ => None,
    }
}

pub fn default_stream_metadata_draft(updated_at: String) -> StreamMetadataDraft {
    StreamMetadataDraft {
        title: String::new(),
        description: String::new(),
        default_privacy: StreamPrivacy::Private,
        target_overrides: [
            StreamPlatform::Youtube,
            StreamPlatform::Twitch,
            StreamPlatform::X,
        ]
        .into_iter()
        .map(|platform| StreamTargetMetadataDraft {
            platform,
            customize: false,
            title: String::new(),
            description: String::new(),
            privacy: StreamPrivacy::Private,
            youtube_made_for_kids: (platform == StreamPlatform::Youtube).then_some(false),
            twitch_category_id: None,
            twitch_category_name: None,
            twitch_language: (platform == StreamPlatform::Twitch).then(|| "en".to_string()),
            x_announce: (platform == StreamPlatform::X).then_some(true),
            updated_at: updated_at.clone(),
        })
        .collect(),
        updated_at,
    }
}

pub fn validate_stream_metadata_draft(draft: &StreamMetadataDraft) -> StreamMetadataValidation {
    let mut issues = Vec::new();
    if draft.title.trim().is_empty() {
        issues.push(StreamMetadataValidationIssue {
            field: "title".to_string(),
            message: "Global title is required before going live.".to_string(),
            platform: None,
        });
    }
    for target in &draft.target_overrides {
        if target.customize && target.title.trim().is_empty() {
            issues.push(StreamMetadataValidationIssue {
                field: "title".to_string(),
                message: "Customized destination title cannot be empty.".to_string(),
                platform: Some(target.platform),
            });
        }
    }
    StreamMetadataValidation {
        valid: issues.is_empty(),
        issues,
    }
}

pub(crate) fn stream_platform_label(platform: StreamPlatform) -> &'static str {
    match platform {
        StreamPlatform::Youtube => "YouTube",
        StreamPlatform::Twitch => "Twitch",
        StreamPlatform::X => "X / Twitter",
        StreamPlatform::Custom => "Custom RTMP",
    }
}

pub(crate) fn stream_platform_from_preset(preset: &RtmpPreset) -> StreamPlatform {
    match preset {
        RtmpPreset::YouTube => StreamPlatform::Youtube,
        RtmpPreset::Twitch => StreamPlatform::Twitch,
        RtmpPreset::X => StreamPlatform::X,
        RtmpPreset::Custom => StreamPlatform::Custom,
    }
}

fn default_stream_target(
    platform: StreamPlatform,
    label: &str,
    server_url: &str,
) -> StreamTargetSettings {
    StreamTargetSettings {
        id: stream_platform_id(platform).to_string(),
        platform,
        label: label.to_string(),
        enabled: false,
        server_url: server_url.to_string(),
        url_mode: Some(StreamUrlMode::ServerAndKey),
        stream_key: String::new(),
        stream_key_secret_ref: None,
        stream_key_present: false,
        auth_mode: StreamAuthMode::ManualRtmp,
        account_id: None,
        account_label: None,
        platform_broadcast_id: None,
        platform_stream_id: None,
        output_preset: None,
        output_bitrate_kbps: None,
        status: Some(StreamTargetStatus {
            state: StreamTargetState::NotConfigured,
            message: None,
            redacted_url: None,
            last_error: None,
            dropped_frames: None,
            bitrate_kbps: None,
        }),
        // The renderer owns timestamps; the backend default leaves them blank.
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// The fixed built-in destinations (YouTube, Twitch, X, Custom) in display order.
pub fn default_stream_targets() -> Vec<StreamTargetSettings> {
    vec![
        default_stream_target(
            StreamPlatform::Youtube,
            "YouTube",
            "rtmp://a.rtmp.youtube.com/live2",
        ),
        default_stream_target(
            StreamPlatform::Twitch,
            "Twitch",
            "rtmp://live.twitch.tv/app",
        ),
        default_stream_target(StreamPlatform::X, "X / Twitter", ""),
        default_stream_target(StreamPlatform::Custom, "Custom RTMP", ""),
    ]
}

/// Migrates the legacy single-RTMP config into the per-target model, placing the
/// server/key on the matching platform target only so credentials for other
/// platforms can never be overwritten.
pub fn streaming_from_legacy_rtmp(rtmp: &RtmpSettings, stream_enabled: bool) -> StreamingSettings {
    let mut targets = default_stream_targets();
    let legacy_platform = stream_platform_from_preset(&rtmp.preset);
    if let Some(target) = targets.iter_mut().find(|t| t.platform == legacy_platform) {
        let server = rtmp.server_url.trim();
        if !server.is_empty() {
            target.server_url = server.to_string();
        }
        target.stream_key = rtmp.stream_key.clone();
        target.stream_key_present = !rtmp.stream_key.is_empty();
        target.enabled = stream_enabled;
    }
    let enabled_target_ids: Vec<String> = targets
        .iter()
        .filter(|t| t.enabled)
        .map(|t| t.id.clone())
        .collect();
    StreamingSettings {
        enabled: stream_enabled,
        mode: if enabled_target_ids.len() > 1 {
            StreamMode::Multi
        } else {
            StreamMode::Single
        },
        targets,
        selected_target_id: None,
        default_output_preset: VideoPreset::Tutorial1080p30,
        default_bitrate_kbps: 6000,
        enabled_target_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rtmp(preset: RtmpPreset, server: &str, key: &str) -> RtmpSettings {
        RtmpSettings {
            preset,
            server_url: server.to_string(),
            stream_key: key.to_string(),
        }
    }

    #[test]
    fn migrates_legacy_key_into_matching_platform_only() {
        let settings = streaming_from_legacy_rtmp(
            &rtmp(
                RtmpPreset::Twitch,
                "rtmp://live.twitch.tv/app",
                "twitch-key-123",
            ),
            true,
        );

        let twitch = settings
            .targets
            .iter()
            .find(|t| t.platform == StreamPlatform::Twitch)
            .unwrap();
        assert_eq!(twitch.stream_key, "twitch-key-123");
        assert!(twitch.stream_key_present);
        assert!(twitch.enabled);

        // No other platform received the key.
        for target in settings
            .targets
            .iter()
            .filter(|t| t.platform != StreamPlatform::Twitch)
        {
            assert_eq!(target.stream_key, "");
            assert!(!target.stream_key_present);
        }
        assert!(settings.enabled);
        assert_eq!(settings.enabled_target_ids, vec!["twitch".to_string()]);
    }

    #[test]
    fn migrating_youtube_does_not_touch_twitch_or_x() {
        let settings = streaming_from_legacy_rtmp(
            &rtmp(
                RtmpPreset::YouTube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt-key",
            ),
            true,
        );
        let youtube = settings
            .targets
            .iter()
            .find(|t| t.platform == StreamPlatform::Youtube)
            .unwrap();
        assert_eq!(youtube.stream_key, "yt-key");
        for platform in [
            StreamPlatform::Twitch,
            StreamPlatform::X,
            StreamPlatform::Custom,
        ] {
            let target = settings
                .targets
                .iter()
                .find(|t| t.platform == platform)
                .unwrap();
            assert_eq!(target.stream_key, "");
        }
    }

    #[test]
    fn migration_without_key_marks_target_absent_and_disabled() {
        let settings = streaming_from_legacy_rtmp(&rtmp(RtmpPreset::X, "", ""), false);
        let x = settings
            .targets
            .iter()
            .find(|t| t.platform == StreamPlatform::X)
            .unwrap();
        assert!(!x.stream_key_present);
        assert!(!settings.enabled);
        assert!(settings.enabled_target_ids.is_empty());
        assert_eq!(settings.mode, StreamMode::Single);
    }

    #[test]
    fn streaming_settings_round_trips_through_camel_case_json() {
        let settings = streaming_from_legacy_rtmp(
            &rtmp(RtmpPreset::Custom, "rtmp://example.test/app", "custom-key"),
            true,
        );
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"enabledTargetIds\""));
        assert!(json.contains("\"streamKeyPresent\""));
        assert!(json.contains("\"platform\":\"custom\""));
        let restored: StreamingSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, settings);
    }

    #[test]
    fn stream_target_output_profile_round_trips_through_camel_case_json() {
        let mut settings = streaming_from_legacy_rtmp(
            &rtmp(
                RtmpPreset::YouTube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt-key",
            ),
            true,
        );
        let youtube = settings
            .targets
            .iter_mut()
            .find(|t| t.platform == StreamPlatform::Youtube)
            .unwrap();
        youtube.output_preset = Some(VideoPreset::StreamYoutube4k30);
        youtube.output_bitrate_kbps = Some(30_000);

        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"outputPreset\":\"stream-youtube-4k30\""));
        assert!(json.contains("\"outputBitrateKbps\":30000"));

        let restored: StreamingSettings = serde_json::from_str(&json).unwrap();
        let restored_youtube = restored
            .targets
            .iter()
            .find(|t| t.platform == StreamPlatform::Youtube)
            .unwrap();
        assert_eq!(
            restored_youtube.output_preset,
            Some(VideoPreset::StreamYoutube4k30)
        );
        assert_eq!(restored_youtube.output_bitrate_kbps, Some(30_000));
    }

    #[test]
    fn manual_stream_key_secret_refs_are_target_scoped() {
        assert_eq!(
            manual_stream_key_secret_ref("youtube").unwrap(),
            "stream-target:youtube:manual-stream-key"
        );
        assert!(manual_stream_key_secret_ref("").is_err());
        assert!(manual_stream_key_secret_ref("../youtube").is_err());
    }

    #[test]
    fn default_stream_metadata_uses_private_native_destination_drafts() {
        let draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());

        assert_eq!(draft.default_privacy, StreamPrivacy::Private);
        assert_eq!(
            draft
                .target_overrides
                .iter()
                .map(|target| target.platform)
                .collect::<Vec<_>>(),
            vec![
                StreamPlatform::Youtube,
                StreamPlatform::Twitch,
                StreamPlatform::X
            ]
        );
        assert_eq!(
            draft
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Youtube)
                .unwrap()
                .youtube_made_for_kids,
            Some(false)
        );
        assert_eq!(
            draft
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Twitch)
                .unwrap()
                .twitch_language
                .as_deref(),
            Some("en")
        );
        assert_eq!(
            draft
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::X)
                .unwrap()
                .x_announce,
            Some(true)
        );
    }

    #[test]
    fn stream_metadata_validation_requires_global_and_customized_titles() {
        let mut draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        let validation = validate_stream_metadata_draft(&draft);
        assert!(!validation.valid);
        assert_eq!(validation.issues.len(), 1);
        assert_eq!(validation.issues[0].field, "title");
        assert_eq!(validation.issues[0].platform, None);

        draft.title = "Launch stream".to_string();
        let twitch = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch.customize = true;
        twitch.title = " ".to_string();

        let validation = validate_stream_metadata_draft(&draft);
        assert!(!validation.valid);
        assert_eq!(validation.issues.len(), 1);
        assert_eq!(validation.issues[0].platform, Some(StreamPlatform::Twitch));

        draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap()
            .title = "Twitch-specific launch".to_string();
        assert!(validate_stream_metadata_draft(&draft).valid);
    }

    #[test]
    fn stream_key_hint_masks_all_but_the_tail() {
        assert_eq!(stream_key_hint("live_1234567_abcdWXYZ"), "••••WXYZ");
        assert_eq!(stream_key_hint("  spaced-key-9876  "), "••••9876");
        // Short keys mask entirely instead of leaking half their characters.
        assert_eq!(stream_key_hint("tiny"), "••••");
    }

    #[test]
    fn previous_secret_ref_is_target_scoped() {
        assert_eq!(
            manual_stream_key_previous_secret_ref("youtube").unwrap(),
            "stream-target:youtube:manual-stream-key:previous"
        );
        assert!(manual_stream_key_previous_secret_ref("bad id").is_err());
    }

    #[test]
    fn storing_over_an_existing_key_archives_it() {
        let plan = plan_manual_stream_key_store(Some("old-yt-key"), None, "new-twitch-key");
        assert_eq!(plan.next_current.as_deref(), Some("new-twitch-key"));
        assert_eq!(plan.next_previous.as_deref(), Some("old-yt-key"));
    }

    #[test]
    fn clearing_a_key_archives_it_for_restore() {
        let plan = plan_manual_stream_key_store(Some("old-key-1234"), Some("stale"), "  ");
        assert_eq!(plan.next_current, None);
        assert_eq!(plan.next_previous.as_deref(), Some("old-key-1234"));
    }

    #[test]
    fn resaving_the_same_key_keeps_the_archive() {
        let plan = plan_manual_stream_key_store(Some("same-key"), Some("older-key"), "same-key");
        assert_eq!(plan.next_current.as_deref(), Some("same-key"));
        assert_eq!(plan.next_previous.as_deref(), Some("older-key"));
    }

    #[test]
    fn first_store_keeps_previous_empty() {
        let plan = plan_manual_stream_key_store(None, None, "fresh-key-0001");
        assert_eq!(plan.next_current.as_deref(), Some("fresh-key-0001"));
        assert_eq!(plan.next_previous, None);
    }

    #[test]
    fn restore_swaps_current_and_previous() {
        let plan = plan_manual_stream_key_restore(Some("twitch-paste"), Some("yt-key")).unwrap();
        assert_eq!(plan.next_current.as_deref(), Some("yt-key"));
        assert_eq!(plan.next_previous.as_deref(), Some("twitch-paste"));
        // Restoring again undoes the restore.
        let undone = plan_manual_stream_key_restore(
            plan.next_current.as_deref(),
            plan.next_previous.as_deref(),
        )
        .unwrap();
        assert_eq!(undone.next_current.as_deref(), Some("twitch-paste"));
        assert_eq!(undone.next_previous.as_deref(), Some("yt-key"));
    }

    #[test]
    fn restore_after_clear_moves_previous_back() {
        let plan = plan_manual_stream_key_restore(None, Some("cleared-key")).unwrap();
        assert_eq!(plan.next_current.as_deref(), Some("cleared-key"));
        assert_eq!(plan.next_previous, None);
    }

    #[test]
    fn restore_without_previous_fails() {
        assert!(plan_manual_stream_key_restore(Some("anything"), None).is_err());
    }

    #[test]
    fn manual_stream_key_state_reports_hints_and_presence() {
        let state =
            manual_stream_key_state("youtube", Some("new-key-5678"), Some("old-key-1234")).unwrap();
        assert_eq!(
            state.stream_key_secret_ref.as_deref(),
            Some("stream-target:youtube:manual-stream-key")
        );
        assert!(state.stream_key_present);
        assert_eq!(state.stream_key_hint.as_deref(), Some("••••5678"));
        assert!(state.previous_stream_key_present);
        assert_eq!(state.previous_stream_key_hint.as_deref(), Some("••••1234"));

        let empty = manual_stream_key_state("youtube", None, None).unwrap();
        assert_eq!(empty.stream_key_secret_ref, None);
        assert!(!empty.stream_key_present);
        assert!(!empty.previous_stream_key_present);
    }
}
