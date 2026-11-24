//! Wire types from `videorc-backend`'s `streaming` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use crate::VideoPreset;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum StreamPlatform {
    Youtube,
    Twitch,
    Kick,
    X,
    Facebook,
    Tiktok,
    Instagram,
    Custom,
}

/// Which composed leg a destination consumes in a dual-orientation session.
/// EXPLICIT per-target property (one home) — never inferred from resolution
/// equality, which ties when recording and vertical stream share 1080×1920.
/// Absent (legacy configs) means horizontal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum StreamOutputOrientation {
    #[default]
    Horizontal,
    Vertical,
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
    /// A live leg lost its connection and FFmpeg's fifo is retrying it every
    /// few seconds (plan 161). Viewers on that platform see nothing until it
    /// is back; the other destinations keep streaming.
    Reconnecting,
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
    /// Dual-orientation leg binding; absent = horizontal (legacy migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_orientation: Option<StreamOutputOrientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<StreamTargetStatus>,
    pub created_at: String,
    pub updated_at: String,
}

impl StreamTargetSettings {
    pub fn effective_output_orientation(&self) -> StreamOutputOrientation {
        self.output_orientation.unwrap_or_default()
    }
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
