use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::live_chat::{CommentsReadState, CommentsWriteState};
use crate::streaming::{
    PlatformAccount, PlatformAccountStatus, StreamAuthMode, StreamMetadataDraft, StreamPlatform,
    StreamTargetSettings, StreamingSettings,
};
use crate::{oauth, x_live};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoLivePreflightParams {
    pub streaming: StreamingSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoLivePreflight {
    pub valid: bool,
    pub destinations: Vec<GoLiveDestinationPreflight>,
    pub issues: Vec<GoLivePreflightIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoLiveDestinationPreflight {
    pub target_id: String,
    pub platform: StreamPlatform,
    pub label: String,
    pub auth_mode: StreamAuthMode,
    pub ready: bool,
    pub title: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub message: String,
    /// Comment capability is independent of stream `ready`: chat limitations are warnings and
    /// never block a valid video destination.
    pub chat_read: CommentsReadState,
    pub chat_write: CommentsWriteState,
    pub chat_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoLivePreflightIssue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<StreamPlatform>,
    pub severity: GoLivePreflightIssueSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GoLivePreflightIssueSeverity {
    Warning,
    Error,
}

pub fn validate_go_live_preflight(
    params: GoLivePreflightParams,
    metadata: &StreamMetadataDraft,
    accounts: &[PlatformAccount],
) -> GoLivePreflight {
    let mut issues = Vec::new();
    if metadata.title.trim().is_empty() {
        issues.push(GoLivePreflightIssue {
            target_id: None,
            platform: None,
            severity: GoLivePreflightIssueSeverity::Error,
            message: "Global title is required before going live.".to_string(),
        });
    }

    let enabled_ids = params
        .streaming
        .enabled_target_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let destinations = if params.streaming.enabled {
        params
            .streaming
            .targets
            .iter()
            .filter(|target| target.enabled || enabled_ids.contains(&target.id))
            .map(|target| destination_preflight(target, metadata, accounts, &mut issues))
            .collect()
    } else {
        Vec::new()
    };

    if params.streaming.enabled && destinations.is_empty() {
        issues.push(GoLivePreflightIssue {
            target_id: None,
            platform: None,
            severity: GoLivePreflightIssueSeverity::Error,
            message: "At least one livestream destination must be enabled.".to_string(),
        });
    }

    GoLivePreflight {
        valid: issues
            .iter()
            .all(|issue| issue.severity != GoLivePreflightIssueSeverity::Error),
        destinations,
        issues,
    }
}

fn destination_preflight(
    target: &StreamTargetSettings,
    metadata: &StreamMetadataDraft,
    accounts: &[PlatformAccount],
    issues: &mut Vec<GoLivePreflightIssue>,
) -> GoLiveDestinationPreflight {
    let (title, description) = effective_metadata(target.platform, metadata);
    let mut ready = true;
    let mut message = "Ready for Go Live confirmation.".to_string();
    let mut account_id = target.account_id.clone();
    let mut account_label = target.account_label.clone();

    if title.trim().is_empty() {
        ready = false;
        let issue = "Destination title is required before going live.".to_string();
        message = issue.clone();
        issues.push(target_issue(
            target,
            GoLivePreflightIssueSeverity::Error,
            issue,
        ));
    }

    match target.auth_mode {
        StreamAuthMode::ManualRtmp => {
            let missing_credentials = if matches!(
                target.url_mode,
                Some(crate::streaming::StreamUrlMode::FullUrl)
            ) {
                target.server_url.trim().is_empty() && target.stream_key_secret_ref.is_none()
            } else {
                target.server_url.trim().is_empty() || !target_has_stream_key(target)
            };
            if missing_credentials {
                ready = false;
                let issue =
                    "Manual RTMP destination needs a server URL and stream key.".to_string();
                message = issue.clone();
                issues.push(target_issue(
                    target,
                    GoLivePreflightIssueSeverity::Error,
                    issue,
                ));
            }
        }
        StreamAuthMode::Oauth => {
            let account = account_for_target(target, accounts);
            if let Some(unavailable) = oauth::provider_oauth_unavailable_message(target.platform) {
                if let Some(account) = account {
                    account_id = Some(account.account_id.clone());
                    account_label = Some(account.account_label.clone());
                }
                ready = false;
                let issue = unavailable.to_string();
                message = issue.clone();
                issues.push(target_issue(
                    target,
                    GoLivePreflightIssueSeverity::Error,
                    issue,
                ));
            } else if target.platform == StreamPlatform::X {
                if let Some(account) = account {
                    account_id = Some(account.account_id.clone());
                    account_label = Some(account.account_label.clone());
                }
                match x_live::x_native_live_capability(account) {
                    Ok(capability) if capability.native_available => {
                        message = capability.message;
                    }
                    Ok(capability) => {
                        ready = false;
                        message = capability.message.clone();
                        issues.push(target_issue(
                            target,
                            GoLivePreflightIssueSeverity::Error,
                            capability.message,
                        ));
                    }
                    Err(error) => {
                        ready = false;
                        message = error.to_string();
                        issues.push(target_issue(
                            target,
                            GoLivePreflightIssueSeverity::Error,
                            error.to_string(),
                        ));
                    }
                }
            } else {
                match account {
                    Some(account) if account.status == PlatformAccountStatus::Connected => {
                        account_id = Some(account.account_id.clone());
                        account_label = Some(account.account_label.clone());
                    }
                    Some(account) => {
                        ready = false;
                        account_id = Some(account.account_id.clone());
                        account_label = Some(account.account_label.clone());
                        let issue =
                            "Connected account needs reconnect before going live.".to_string();
                        message = issue.clone();
                        issues.push(target_issue(
                            target,
                            GoLivePreflightIssueSeverity::Error,
                            issue,
                        ));
                    }
                    None => {
                        ready = false;
                        let issue =
                            "OAuth destination needs a connected account before going live."
                                .to_string();
                        message = issue.clone();
                        issues.push(target_issue(
                            target,
                            GoLivePreflightIssueSeverity::Error,
                            issue,
                        ));
                    }
                }
            }
        }
    }

    let (chat_read, chat_write, chat_message) = destination_chat_preflight(target, accounts);
    if ready
        && target.platform != StreamPlatform::Custom
        && (chat_read != CommentsReadState::Ready || chat_write != CommentsWriteState::Ready)
    {
        issues.push(target_issue(
            target,
            GoLivePreflightIssueSeverity::Warning,
            chat_message.clone(),
        ));
    }
    GoLiveDestinationPreflight {
        target_id: target.id.clone(),
        platform: target.platform,
        label: target.label.clone(),
        auth_mode: target.auth_mode,
        ready,
        title,
        description,
        account_id,
        account_label,
        message,
        chat_read,
        chat_write,
        chat_message,
    }
}

fn destination_chat_preflight(
    target: &StreamTargetSettings,
    accounts: &[PlatformAccount],
) -> (CommentsReadState, CommentsWriteState, String) {
    let capability =
        crate::live_chat::chat_capability(target.platform, account_for_target(target, accounts));
    if target.platform == StreamPlatform::X {
        let account = account_for_target(target, accounts);
        let account_connected =
            account.is_some_and(|account| account.status == PlatformAccountStatus::Connected);
        let (native_available, capability_message) = match x_live::x_native_live_capability(account)
        {
            Ok(capability) => (capability.native_available, capability.message),
            Err(error) => (false, error.to_string()),
        };
        return x_destination_chat_preflight(
            target.auth_mode,
            account_connected,
            native_available,
            capability_message,
        );
    }

    let message = match (target.platform, capability.read, capability.write) {
        (StreamPlatform::Twitch, CommentsReadState::Ready, CommentsWriteState::Ready) => {
            "Twitch comments are ready to read and send.".to_string()
        }
        (StreamPlatform::Twitch, CommentsReadState::Ready, CommentsWriteState::MissingScope) => {
            "Twitch comments are readable. Reconnect Twitch to send from Videorc.".to_string()
        }
        (StreamPlatform::Twitch, CommentsReadState::Unavailable, CommentsWriteState::Ready) => {
            "Reconnect Twitch to read comments; sending permission is already granted.".to_string()
        }
        (
            StreamPlatform::Twitch,
            CommentsReadState::Unavailable,
            CommentsWriteState::MissingScope,
        ) => "Reconnect Twitch to read comments and send from Videorc.".to_string(),
        _ => capability.message,
    };
    (capability.read, capability.write, message)
}

fn x_destination_chat_preflight(
    auth_mode: StreamAuthMode,
    account_connected: bool,
    native_available: bool,
    capability_message: String,
) -> (CommentsReadState, CommentsWriteState, String) {
    if auth_mode != StreamAuthMode::Oauth {
        return (
            CommentsReadState::Unavailable,
            CommentsWriteState::ReadOnly,
            "Manual RTMP has no native X broadcast context, so X live chat is receive-only and unavailable."
                .to_string(),
        );
    }
    if !account_connected || !native_available {
        return (
            CommentsReadState::Unavailable,
            CommentsWriteState::ReadOnly,
            capability_message,
        );
    }
    (
        CommentsReadState::WaitingForBroadcastContext,
        CommentsWriteState::ReadOnly,
        "X comments attach after the native broadcast is published; X live chat is receive-only."
            .to_string(),
    )
}

fn effective_metadata(
    platform: StreamPlatform,
    metadata: &StreamMetadataDraft,
) -> (String, String) {
    let override_draft = metadata
        .target_overrides
        .iter()
        .find(|target| target.platform == platform);
    if let Some(override_draft) = override_draft.filter(|target| target.customize) {
        let title = if override_draft.title.trim().is_empty() {
            metadata.title.trim()
        } else {
            override_draft.title.trim()
        };
        return (
            title.to_string(),
            override_draft.description.trim().to_string(),
        );
    }

    (
        metadata.title.trim().to_string(),
        metadata.description.trim().to_string(),
    )
}

fn account_for_target<'a>(
    target: &StreamTargetSettings,
    accounts: &'a [PlatformAccount],
) -> Option<&'a PlatformAccount> {
    accounts.iter().find(|account| {
        account.platform == target.platform
            && target
                .account_id
                .as_deref()
                .is_none_or(|target_account_id| {
                    account.account_id == target_account_id || account.id == target_account_id
                })
    })
}

fn target_has_stream_key(target: &StreamTargetSettings) -> bool {
    target.stream_key_present
        || !target.stream_key.trim().is_empty()
        || target.stream_key_secret_ref.is_some()
}

fn target_issue(
    target: &StreamTargetSettings,
    severity: GoLivePreflightIssueSeverity,
    message: String,
) -> GoLivePreflightIssue {
    GoLivePreflightIssue {
        target_id: Some(target.id.clone()),
        platform: Some(target.platform),
        severity,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::{
        PlatformAccountStatus, StreamMode, StreamPlatform, StreamPrivacy,
        default_stream_metadata_draft, default_stream_targets,
    };

    #[test]
    fn preflight_blocks_youtube_oauth_while_twitch_is_ready_and_x_is_blocked() {
        let mut targets = default_stream_targets();
        for target in &mut targets {
            match target.platform {
                StreamPlatform::Youtube | StreamPlatform::Twitch | StreamPlatform::X => {
                    target.enabled = true;
                    target.auth_mode = StreamAuthMode::Oauth;
                }
                StreamPlatform::Custom => {}
            }
        }
        let streaming = StreamingSettings {
            enabled: true,
            mode: StreamMode::Multi,
            targets,
            selected_target_id: None,
            default_output_preset: crate::protocol::VideoPreset::Stream1080p60,
            default_bitrate_kbps: 6000,
            enabled_target_ids: vec!["youtube".to_string(), "twitch".to_string(), "x".to_string()],
        };
        let mut metadata = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        metadata.title = "Launch stream".to_string();
        metadata.description = "We are live.".to_string();
        metadata.default_privacy = StreamPrivacy::Public;
        let accounts = vec![
            account(StreamPlatform::Youtube, "yt", "YouTube Channel"),
            account(StreamPlatform::Twitch, "tw", "Twitch Channel"),
            account(StreamPlatform::X, "x", "X Account"),
        ];

        let preflight =
            validate_go_live_preflight(GoLivePreflightParams { streaming }, &metadata, &accounts);

        assert!(!preflight.valid);
        assert_eq!(preflight.destinations.len(), 3);
        let youtube = preflight
            .destinations
            .iter()
            .find(|destination| destination.platform == StreamPlatform::Youtube)
            .unwrap();
        assert!(!youtube.ready);
        assert!(youtube.message.contains("Google approval"));
        assert!(
            preflight
                .destinations
                .iter()
                .find(|destination| destination.platform == StreamPlatform::Twitch)
                .unwrap()
                .ready
        );
        let x = preflight
            .destinations
            .iter()
            .find(|destination| destination.platform == StreamPlatform::X)
            .unwrap();
        assert!(!x.ready);
        assert!(x.message.contains("OAuth 1.0a"));
        assert!(
            preflight
                .issues
                .iter()
                .any(|issue| issue.platform == Some(StreamPlatform::X))
        );
        assert!(
            preflight
                .issues
                .iter()
                .any(|issue| issue.platform == Some(StreamPlatform::Youtube))
        );
        // This checkout has no release X consumer/user token, so preflight must not pretend
        // it is merely waiting for publish context.
        assert_eq!(x.chat_read, CommentsReadState::Unavailable);
        assert_eq!(x.chat_write, CommentsWriteState::ReadOnly);
        assert!(x.chat_message.contains("OAuth 1.0a"));
        assert_eq!(youtube.chat_read, CommentsReadState::Unavailable);
        assert_eq!(youtube.chat_write, CommentsWriteState::Unavailable);
        assert!(!youtube.chat_message.is_empty());
    }

    #[test]
    fn x_comments_wait_for_publish_only_after_native_oauth_setup_is_ready() {
        let waiting = x_destination_chat_preflight(
            StreamAuthMode::Oauth,
            true,
            true,
            "X native live ready.".to_string(),
        );
        assert_eq!(waiting.0, CommentsReadState::WaitingForBroadcastContext);
        assert_eq!(waiting.1, CommentsWriteState::ReadOnly);
        assert!(
            waiting
                .2
                .contains("after the native broadcast is published")
        );

        let missing_account = x_destination_chat_preflight(
            StreamAuthMode::Oauth,
            false,
            true,
            "Connect X before going live.".to_string(),
        );
        assert_eq!(missing_account.0, CommentsReadState::Unavailable);

        let manual = x_destination_chat_preflight(
            StreamAuthMode::ManualRtmp,
            true,
            true,
            "ignored".to_string(),
        );
        assert_eq!(manual.0, CommentsReadState::Unavailable);
        assert!(manual.2.contains("Manual RTMP"));
    }

    #[test]
    fn twitch_comment_read_and_write_scopes_are_independent_non_blocking_warnings() {
        let read_only = twitch_manual_preflight(&[crate::live_chat::TWITCH_CHAT_SCOPE]);
        assert!(read_only.valid, "{read_only:?}");
        assert_eq!(
            read_only.destinations[0].chat_read,
            CommentsReadState::Ready
        );
        assert_eq!(
            read_only.destinations[0].chat_write,
            CommentsWriteState::MissingScope
        );
        assert_eq!(read_only.issues.len(), 1);
        assert_eq!(
            read_only.issues[0].severity,
            GoLivePreflightIssueSeverity::Warning
        );

        let write_only = twitch_manual_preflight(&[crate::live_chat::TWITCH_CHAT_WRITE_SCOPE]);
        assert!(write_only.valid, "{write_only:?}");
        assert_eq!(
            write_only.destinations[0].chat_read,
            CommentsReadState::Unavailable
        );
        assert_eq!(
            write_only.destinations[0].chat_write,
            CommentsWriteState::Ready
        );
        assert_eq!(
            write_only.issues[0].severity,
            GoLivePreflightIssueSeverity::Warning
        );

        let both = twitch_manual_preflight(&[
            crate::live_chat::TWITCH_CHAT_SCOPE,
            crate::live_chat::TWITCH_CHAT_WRITE_SCOPE,
        ]);
        assert!(both.valid, "{both:?}");
        assert_eq!(both.destinations[0].chat_read, CommentsReadState::Ready);
        assert_eq!(both.destinations[0].chat_write, CommentsWriteState::Ready);
        assert!(both.issues.is_empty());
    }

    #[test]
    fn preflight_requires_manual_rtmp_key() {
        let mut targets = default_stream_targets();
        let custom = targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Custom)
            .unwrap();
        custom.enabled = true;
        custom.server_url = "rtmp://example/live".to_string();
        custom.stream_key.clear();
        custom.stream_key_present = false;
        let streaming = StreamingSettings {
            enabled: true,
            mode: StreamMode::Single,
            targets,
            selected_target_id: Some("custom".to_string()),
            default_output_preset: crate::protocol::VideoPreset::Stream1080p60,
            default_bitrate_kbps: 6000,
            enabled_target_ids: vec!["custom".to_string()],
        };
        let mut metadata = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        metadata.title = "Launch stream".to_string();

        let preflight =
            validate_go_live_preflight(GoLivePreflightParams { streaming }, &metadata, &[]);

        assert!(!preflight.valid);
        assert_eq!(preflight.destinations.len(), 1);
        assert!(!preflight.destinations[0].ready);
        assert!(preflight.issues[0].message.contains("stream key"));
    }

    #[test]
    fn preflight_accepts_secret_ref_for_full_url_manual_target() {
        let metadata = StreamMetadataDraft {
            title: "Launch stream".to_string(),
            ..default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string())
        };
        let mut targets = default_stream_targets();
        let custom = targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Custom)
            .unwrap();
        custom.enabled = true;
        custom.url_mode = Some(crate::streaming::StreamUrlMode::FullUrl);
        custom.server_url = "".to_string();
        custom.stream_key = "".to_string();
        custom.stream_key_secret_ref = Some("stream-target:custom:manual-stream-key".to_string());
        custom.stream_key_present = true;
        let streaming = StreamingSettings {
            enabled: true,
            mode: StreamMode::Single,
            selected_target_id: Some("custom".to_string()),
            default_output_preset: crate::protocol::VideoPreset::Stream1080p60,
            default_bitrate_kbps: 6000,
            enabled_target_ids: vec![custom.id.clone()],
            targets,
        };

        let preflight =
            validate_go_live_preflight(GoLivePreflightParams { streaming }, &metadata, &[]);

        assert!(preflight.valid, "{preflight:?}");
        assert_eq!(preflight.destinations.len(), 1);
        assert!(preflight.destinations[0].ready);
        assert!(preflight.issues.is_empty());
    }

    fn account(platform: StreamPlatform, account_id: &str, label: &str) -> PlatformAccount {
        PlatformAccount {
            id: platform_id(platform).to_string(),
            platform,
            account_id: account_id.to_string(),
            account_label: label.to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: Vec::new(),
            access_token_present: true,
            refresh_token_present: true,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-03T00:00:00Z".to_string(),
            updated_at: "2026-06-03T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        }
    }

    fn twitch_manual_preflight(scopes: &[&str]) -> GoLivePreflight {
        let mut targets = default_stream_targets();
        let twitch = targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch.enabled = true;
        twitch.auth_mode = StreamAuthMode::ManualRtmp;
        twitch.stream_key_present = true;
        twitch.stream_key_secret_ref = Some("stream-target:twitch:test-key".to_string());
        let streaming = StreamingSettings {
            enabled: true,
            mode: StreamMode::Single,
            selected_target_id: Some(twitch.id.clone()),
            default_output_preset: crate::protocol::VideoPreset::StreamSafe1080p30,
            default_bitrate_kbps: 6000,
            enabled_target_ids: vec![twitch.id.clone()],
            targets,
        };
        let metadata = StreamMetadataDraft {
            title: "Launch stream".to_string(),
            ..default_stream_metadata_draft("2026-07-10T00:00:00Z".to_string())
        };
        let mut twitch_account = account(StreamPlatform::Twitch, "tw", "Twitch Channel");
        twitch_account.scopes = scopes.iter().map(|scope| (*scope).to_string()).collect();
        validate_go_live_preflight(
            GoLivePreflightParams { streaming },
            &metadata,
            &[twitch_account],
        )
    }

    fn platform_id(platform: StreamPlatform) -> &'static str {
        match platform {
            StreamPlatform::Youtube => "youtube",
            StreamPlatform::Twitch => "twitch",
            StreamPlatform::X => "x",
            StreamPlatform::Custom => "custom",
        }
    }
}
