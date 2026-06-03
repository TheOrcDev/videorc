//! Multi-platform streaming target model (per-target). Mirrors the renderer's
//! `StreamingSettings`. Introduced in M1; wired into session start (M3) and the
//! FFmpeg `tee` fan-out (M4), so these items are intentionally not yet consumed
//! by the rest of the backend.
#![allow(dead_code)]

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::protocol::{RtmpPreset, RtmpSettings, VideoPreset};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_visibility: Option<StreamPrivacy>,
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
            x_visibility: (platform == StreamPlatform::X).then_some(StreamPrivacy::Public),
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
                .x_visibility,
            Some(StreamPrivacy::Public)
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
}
