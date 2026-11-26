//! Plan 220 S3.5a: the Livestream page's rules (`components/tabs/streaming-tab.tsx`
//! and `components/streaming/`), as data the app hands the window.
//!
//! - [`copy`]: the page's words, byte for byte.
//! - [`accounts`]: the platform accounts on the wire, the account's one
//!   status, the permissions row and the connect scopes.
//! - [`targets`]: the destinations in the capture config, the renderer's
//!   patch rules, readiness and the stream quality.
//! - [`setup`]: Setup as a view (the notices, each destination card, the
//!   key fields, the sign-in, Output quality) and the questions it asks.
//! - [`chat_commands`] (S3.2f): plan 226's chat commands, the editor's rules
//!   and the Stream Manager's `!` rules.
//! - [`on_air`]: the destinations' facts on air (each leg's word, the
//!   stream's health, the quality line), which the Studio's Session section
//!   reads, with Videorc Cloud's show and the stream [`watchdog`]'s top
//!   alert.
//!
//! - [`plan`]: the stream output plan (each leg's quality, the shared or
//!   separate encode) and the output check's request.
//! - [`ready`]: Ready to go live, the Go Live panel's checklist.
//! - [`details`]: Stream details' draft and its checks.
//! - [`discord`]: Destinations → Discord.
//! - [`golive`]: the Go Live dialog as data and its confirm gate, with
//!   [`go_live_copy`]'s words, [`go_live_privacy`]'s privacy step and
//!   [`captions_preflight`]'s captions rules.
//! - [`lifecycle`]: each platform's prepare, start and end steps, with
//!   [`lifecycle_copy`]'s status lines; [`platform_owner`]: who owns the
//!   cleanup; [`cloud_provider`]: the cloud's leg as Go Live and the
//!   cleanup wait for it.
//! - [`watchdog_section`]: Destinations → Watchdog, the checks and where
//!   alerts reach you.
//! - [`stream_report`]: Destinations → After the stream, the stream report
//!   email and the saved streams.
//!
//! Plan 260 S1.6c lands this area in parts, caught up with Electron: the
//! destinations; the Go Live dialog, the output plan, Ready to go live and
//! Stream details (this part); then Upcoming and the schedule, the Studio's
//! drivers, and Videorc Cloud.
//!
//! The platform accounts themselves live in the Studio
//! ([`crate::studio::Studio::platforms`]), which reads them on each
//! connection and on `platformAccounts.changed`, and runs every action
//! (connect, disconnect, the stream key through the backend's secrets).

pub mod accounts;
pub mod captions_preflight;
pub mod chat_commands;
pub mod cloud_outputs;
pub mod cloud_provider;
pub mod cloud_show;
pub mod cloud_status;
pub mod cloud_view;
pub mod copy;
pub mod details;
pub mod discord;
pub mod format;
pub mod go_live_copy;
pub mod go_live_privacy;
pub mod golive;
pub mod lifecycle;
pub mod lifecycle_copy;
pub mod on_air;
pub mod plan;
pub mod platform_owner;
pub mod ready;
pub mod scheduled;
pub mod scheduled_copy;
pub mod setup;
pub mod stream_report;
pub mod talk_show_outputs;
pub mod targets;
pub mod time_zones;
pub mod watchdog;
pub mod watchdog_notify;
pub mod watchdog_section;
pub mod x_categories;
pub mod x_live_edit;

use accounts::{
    AccountValidation, PlatformAccount, ProviderCredentials, XCapability, YouTubeChannel,
};

/// `platformAccounts.changed`: the whole list.
pub const ACCOUNTS_CHANGED_EVENT: &str = "platformAccounts.changed";
/// S3.5c: a provider sign-in's answer (`platformAccounts.oauth.callback`).
pub const OAUTH_CALLBACK_EVENT: &str = "platformAccounts.oauth.callback";
/// S3.5c: YouTube's shared quota (`youtube.quota`, plan 094).
pub const YOUTUBE_QUOTA_EVENT: &str = "youtube.quota";

/// The backend methods the page calls.
pub mod methods {
    pub const ACCOUNTS_LIST: &str = "platformAccounts.list";
    pub const ACCOUNTS_VALIDATE: &str = "platformAccounts.validate";
    pub const PROVIDER_CREDENTIALS: &str = "platformAccounts.oauth.providerCredentials";
    pub const OAUTH_START_PROVIDER: &str = "platformAccounts.oauth.startProvider";
    pub const DISCONNECT: &str = "platformAccounts.disconnect";
    pub const YOUTUBE_CHANNELS: &str = "platformAccounts.youtube.channels";
    pub const YOUTUBE_SELECT_CHANNEL: &str = "platformAccounts.youtube.selectChannel";
    pub const X_CAPABILITY: &str = "streamTargets.x.capability";
    /// X's live categories for the Stream details picker (plan 260 L2).
    pub const X_LIVE_CATEGORIES: &str = "streamTargets.x.liveCategories";
    /// Live on X: a new title or category for the broadcast on air.
    pub const X_UPDATE_BROADCAST: &str = "streamTargets.x.updateBroadcast";
    pub const X_START_LIVE_AUTHORIZATION: &str = "streamTargets.x.startLiveAuthorization";
    pub const MANUAL_KEY_STORE: &str = "streamTargets.manualKey.store";
    pub const MANUAL_KEY_RESTORE: &str = "streamTargets.manualKey.restorePrevious";
    pub const MANUAL_KEY_INSPECT: &str = "streamTargets.manualKey.inspect";
    pub const METADATA_GET: &str = "streamTargets.metadata.get";
    pub const METADATA_UPDATE: &str = "streamTargets.metadata.update";
    pub const METADATA_VALIDATE: &str = "streamTargets.metadata.validate";
    pub const TWITCH_SEARCH_CATEGORIES: &str = "streamTargets.twitch.searchCategories";
    pub const KICK_SEARCH_CATEGORIES: &str = "streamTargets.kick.searchCategories";
    pub const TOPOLOGY_PROBE: &str = "stream.output.topology.probe";
    // S3.5c: Go Live.
    pub const CONFIRMATION_VALIDATE: &str = "streamTargets.confirmation.validate";
    pub const YOUTUBE_PREPARE: &str = "streamTargets.youtube.prepare";
    pub const YOUTUBE_STREAM_STATUS: &str = "streamTargets.youtube.streamStatus";
    pub const YOUTUBE_TRANSITION: &str = "streamTargets.youtube.transition";
    pub const TWITCH_PREPARE: &str = "streamTargets.twitch.prepare";
    pub const KICK_PREPARE: &str = "streamTargets.kick.prepare";
    pub const TWITCH_APPLY_METADATA: &str = "streamTargets.twitch.applyMetadata";
    pub const KICK_APPLY_METADATA: &str = "streamTargets.kick.applyMetadata";
    pub const X_PREPARE: &str = "streamTargets.x.prepare";
    pub const X_PUBLISH: &str = "streamTargets.x.publish";
    pub const X_END: &str = "streamTargets.x.end";
    pub const SCHEDULED_GET: &str = "scheduledStreams.get";
    pub const YOUTUBE_QUOTA_STATUS: &str = "youtube.quota.status";
    pub const SCHEDULED_OPERATION: &str = "scheduledStreams.operation";
    /// S3.2f: X chat after the X broadcast goes live (`liveChat.x.start`).
    pub const X_CHAT_START: &str = "liveChat.x.start";
}

/// The platform accounts and what the cards read beside them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlatformsState {
    pub accounts: Vec<PlatformAccount>,
    pub validations: Vec<AccountValidation>,
    pub credentials: Vec<ProviderCredentials>,
    pub youtube_channels: Vec<YouTubeChannel>,
    pub youtube_channels_loading: bool,
    pub x_capability: Option<XCapability>,
    pub x_capability_loading: bool,
    /// X's live categories once X Live can go live (`loadXLiveCategories`).
    pub x_live_categories: Vec<x_categories::XLiveCategory>,
    pub x_live_categories_status: x_categories::XLiveCategoriesStatus,
    /// The list has been read on this connection.
    pub loaded: bool,
    /// The saved keys whose hint was asked for on this connection
    /// (`streamTargets.manualKey.inspect`, once each).
    pub hints_asked: Vec<String>,
    /// S3.5c: YouTube's API is paused until then (`youtube.quota`'s
    /// `pausedUntil`, plan 094).
    pub youtube_quota_paused_until: Option<String>,
}

impl PlatformsState {
    pub fn account(&self, platform: &str) -> Option<&PlatformAccount> {
        self.accounts.iter().find(|a| a.platform == platform)
    }
    pub fn validation(&self, platform: &str) -> Option<&AccountValidation> {
        self.validations.iter().find(|v| v.platform == platform)
    }
    pub fn credentials(&self, platform: &str) -> Option<&ProviderCredentials> {
        self.credentials.iter().find(|c| c.platform == platform)
    }
}

/// S3.5b: Stream details, the output check and Discord, apart from the
/// snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DetailsState {
    /// The draft as edited (the backend's until the first edit).
    pub draft: Option<details::MetadataDraft>,
    pub validation: Option<details::Validation>,
    pub save_pending: bool,
    /// The category search's results (id, name), and what was searched.
    pub category_results: Vec<(String, String)>,
    pub category_pending: bool,
    pub category_searched: Option<String>,
    /// The output check (`stream.output.topology.probe`): the request's
    /// key, and its answer or failure.
    pub topology: ready::Topology,
    pub discord: Option<discord::Snapshot>,
    pub discord_preview: Option<discord::Preview>,
    pub discord_error: Option<String>,
    /// The announcement failure already toasted (`discordFailureToastedAt`).
    pub discord_toasted_at: Option<String>,
}
