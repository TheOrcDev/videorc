//! Discord go-live announcement (plan 187, issue #634). Free, and automatic
//! once a webhook is set: when the first ticked destination is confirmed live,
//! one message goes to each of the streamer's Discord channels, sent under
//! their name and avatar, with a link button per live platform. It gains
//! buttons as more destinations come up and turns into "Was live · 1h 42m" at
//! the stop. Reconnects and restarts within [`machine::RESTART_WINDOW`] never
//! ping again; unlisted and private YouTube streams are never announced.
//!
//! The backend owns everything. A streamer connects up to [`MAX_WEBHOOKS`]
//! webhooks (one per server); every server gets the same post, and each
//! webhook keeps its own secret, its own last message and its own failure.
//! The webhook URLs live only in the secrets file (`discord.webhook.url.{id}`,
//! or plan 187's single `discord.webhook.url` until it is re-saved); the
//! renderer sees a masked hint. Settings and the last messages live in
//! `app_settings`. The go-live hooks only `try_send` a fact to the announcer
//! task, so Go Live never waits on Discord.

pub mod client;
pub mod links;
pub mod machine;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::task::JoinSet;

use self::client::{
    DiscordPing, LinkButton, MessageView, Mood, RetryPolicy, SendError, Sender, Thumbnail,
    WebhookUrl,
};
use self::links::{LinkPreview, LinkTarget, PostAs, PostAsIdentity};
use self::machine::{AnnounceSession, Outcome, Request};
use crate::protocol::{HealthLevel, RecordingState, RecordingStatus, ServerEvent};
use crate::state::AppState;
use crate::streaming::{
    StreamPrivacy, StreamTargetSettings, StreamTargetsSnapshot, StreamingSettings,
};

/// Plan 187's single-webhook secret. Still read for a webhook saved before
/// there were several; every save since writes [`webhook_secret_ref`].
pub const WEBHOOK_SECRET_REF: &str = "discord.webhook.url";
pub const SETTINGS_KEY: &str = "discord.announce";
pub const LAST_MESSAGE_KEY: &str = "discord.announce.lastMessage";
pub const CHANGED_EVENT: &str = "discord.announce.changed";
/// One per server is the point; ten is more servers than anyone streams to.
pub const MAX_WEBHOOKS: usize = 10;
const FACT_CHANNEL_CAPACITY: usize = 32;
const HEARTBEAT: TimeDelta = TimeDelta::seconds(60);
/// Leave startup alone before fixing a message a crash left "live".
const RECOVERY_DELAY: Duration = Duration::from_secs(30);
/// At most one still sending its "Was live" edits and the next.
const MAX_SESSIONS: usize = 2;
const MAX_TARGET_IDS: usize = 64;
const MAX_ID_LEN: usize = 128;
/// "Send test message" answers while the user waits: short retries only.
const TEST_POST_POLICY: RetryPolicy = RetryPolicy {
    steps: &[Duration::from_secs(2)],
    budget: Duration::from_secs(20),
    max_retry_after: Duration::from_secs(10),
};

// ---------------------------------------------------------------------------
// Settings and wire types
// ---------------------------------------------------------------------------

/// What Discord said about a saved webhook when it was verified, plus what
/// has happened to it since.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WebhookMeta {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    guild_id: Option<String>,
    hint: String,
    verified_at: String,
    /// Discord refused link buttons for this webhook once; links go in the
    /// embed text from then on.
    #[serde(default)]
    components_refused: bool,
    /// The last post that failed through this webhook, until one succeeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<AnnounceError>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AnnounceErrorCode {
    WebhookDeleted,
    Unreachable,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnounceError {
    pub code: AnnounceErrorCode,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default = "default_on")]
    enabled: bool,
    #[serde(default)]
    ping: DiscordPing,
    #[serde(default = "default_on")]
    branding: bool,
    #[serde(default)]
    post_as: PostAs,
    #[serde(default)]
    excluded_target_ids: Vec<String>,
    #[serde(default)]
    link_overrides: BTreeMap<String, String>,
    /// Every connected webhook, in the order they were connected.
    #[serde(default)]
    webhooks: Vec<WebhookMeta>,
    /// Plan 187 kept one webhook and its failure here. Read once, folded into
    /// `webhooks` by [`StoredSettings::fold_legacy`], and never written again.
    #[serde(default, skip_serializing)]
    webhook: Option<WebhookMeta>,
    #[serde(default, skip_serializing)]
    last_error: Option<AnnounceError>,
}

fn default_on() -> bool {
    true
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ping: DiscordPing::None,
            branding: true,
            post_as: PostAs::Automatic,
            excluded_target_ids: Vec::new(),
            link_overrides: BTreeMap::new(),
            webhooks: Vec::new(),
            webhook: None,
            last_error: None,
        }
    }
}

impl StoredSettings {
    /// A row written before there were several webhooks keeps working: its
    /// one webhook leads the list, carrying the failure that was global.
    fn fold_legacy(mut self) -> Self {
        if let Some(mut meta) = self.webhook.take()
            && !self.webhooks.iter().any(|saved| saved.id == meta.id)
        {
            meta.last_error = self.last_error.take();
            self.webhooks.insert(0, meta);
        }
        self.last_error = None;
        self
    }

    fn webhook(&self, id: &str) -> Option<&WebhookMeta> {
        self.webhooks.iter().find(|meta| meta.id == id)
    }

    fn webhook_mut(&mut self, id: &str) -> Option<&mut WebhookMeta> {
        self.webhooks.iter_mut().find(|meta| meta.id == id)
    }

    /// Adds a verified webhook. A re-paste of a saved one replaces it in
    /// place (same Discord id); a new one goes last, within the cap.
    fn upsert_webhook(&mut self, meta: WebhookMeta) -> Result<(), RpcError> {
        if let Some(saved) = self.webhook_mut(&meta.id) {
            *saved = meta;
            return Ok(());
        }
        if self.webhooks.len() >= MAX_WEBHOOKS {
            return Err(RpcError::new(
                "discord-too-many-webhooks",
                format!(
                    "You can connect up to {MAX_WEBHOOKS} webhooks. Remove one to add another."
                ),
            ));
        }
        self.webhooks.push(meta);
        Ok(())
    }

    fn remove_webhook(&mut self, id: &str) -> Option<WebhookMeta> {
        let index = self.webhooks.iter().position(|meta| meta.id == id)?;
        Some(self.webhooks.remove(index))
    }
}

/// The message posted for a webhook's latest announced session. Kept so a
/// quick restart can revive it and a crash can be tidied up at the next
/// launch. One per webhook.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LastMessage {
    webhook_id: String,
    message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    session_id: String,
    started_at: DateTime<Utc>,
    last_seen_live_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<DateTime<Utc>>,
    /// Still says "Live now" in Discord.
    live: bool,
    posted_at: DateTime<Utc>,
    title: String,
    links: Vec<LinkButton>,
    branding: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_filename: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LastPostState {
    Live,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastPost {
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_url: Option<String>,
    pub state: LastPostState,
}

/// One saved webhook as the renderer sees it. The id is Discord's snowflake
/// for the webhook, how the RPCs name it; the token never travels.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWebhookSnapshot {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `…/a1B2`: the masked tail of the token.
    pub hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_post: Option<LastPost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<AnnounceError>,
}

/// `discord.announce.get` and the `discord.announce.changed` event. Never
/// carries a webhook URL.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscordAnnounceSnapshot {
    /// The webhooks whose secret is present, in the order they were connected.
    pub webhooks: Vec<DiscordWebhookSnapshot>,
    pub enabled: bool,
    pub ping: DiscordPing,
    pub branding: bool,
    pub post_as: PostAs,
    pub excluded_target_ids: Vec<String>,
    pub link_overrides: BTreeMap<String, String>,
    pub identities: Vec<PostAsIdentity>,
}

/// One typed link change: a link sets it, none removes it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkOverrideChange {
    pub target_id: String,
    #[serde(default)]
    pub link: Option<String>,
}

/// `discord.announce.update`: every field optional.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateParams {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub ping: Option<DiscordPing>,
    #[serde(default)]
    pub branding: Option<bool>,
    #[serde(default)]
    pub post_as: Option<PostAs>,
    #[serde(default)]
    pub excluded_target_ids: Option<Vec<String>>,
    #[serde(default)]
    pub link_override: Option<LinkOverrideChange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveWebhookParams {
    pub url: String,
}

/// `discord.webhook.remove`: which saved webhook goes.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveWebhookParams {
    pub webhook_id: String,
}

/// `discord.links.preview`: the configured destinations, as the Livestream
/// page has them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetsParams {
    pub targets: Vec<LinkTarget>,
}

/// `discord.webhook.sendTest`: the destinations, and which webhook to test.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestParams {
    pub targets: Vec<LinkTarget>,
    pub webhook_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinksPreviewResult {
    pub links: Vec<LinkPreview>,
    /// Who the post would be sent as; absent = the webhook's own name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<Sender>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_url: Option<String>,
}

/// An RPC refusal: a stable code and the sentence the section shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: &'static str,
    pub message: String,
}

impl RpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_send(error: SendError) -> Self {
        match error {
            SendError::WebhookGone => Self::new(
                "discord-webhook-not-found",
                "This webhook was deleted in Discord. Paste a new one.",
            ),
            SendError::Unreachable | SendError::Cancelled => Self::new(
                "discord-unreachable",
                "Couldn't reach Discord. Check your connection and try again.",
            ),
            SendError::MessageGone | SendError::ComponentsRefused | SendError::Rejected { .. } => {
                // The status and Discord's code go to the log, never the copy.
                tracing::info!("[discord] refused: {}", error.describe());
                Self::new(
                    "discord-rejected",
                    "Discord refused it. Check the webhook in Discord, or paste a new one.",
                )
            }
        }
    }

    fn no_webhook() -> Self {
        Self::new("discord-no-webhook", "Paste a Discord webhook URL first.")
    }
}

fn settings_unavailable(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(
        "settings-unavailable",
        format!("Couldn't save the Discord settings: {error}"),
    )
}

// ---------------------------------------------------------------------------
// Runtime and hooks
// ---------------------------------------------------------------------------

/// What the go-live path tells the announcer. Sent with `try_send` only.
#[derive(Debug)]
enum HookFact {
    SessionStarted {
        session_id: String,
        started_at: DateTime<Utc>,
        targets: Vec<StreamTargetSettings>,
    },
    YouTubeLive {
        broadcast_id: String,
        privacy: Option<StreamPrivacy>,
    },
    XPublished {
        session_id: Option<String>,
        share_url: String,
    },
}

#[derive(Debug, Default)]
pub struct DiscordAnnounceRuntime {
    facts: std::sync::OnceLock<mpsc::Sender<HookFact>>,
    /// Serializes every read-modify-write of the settings row.
    settings_lock: Mutex<()>,
    /// Serializes every read-modify-write of the last-messages row: the
    /// announcer loop and the startup recovery both write it.
    messages_lock: std::sync::Mutex<()>,
}

fn send_fact(state: &AppState, fact: HookFact) {
    let Some(sender) = state.discord_announce.facts.get() else {
        return;
    };
    // Never waits: the go-live path must not block on Discord.
    if sender.try_send(fact).is_err() {
        tracing::debug!("[discord] dropped a go-live fact (announcer busy).");
    }
}

/// `session.start` answered OK. Only sessions with destinations matter.
pub fn on_session_started(
    state: &AppState,
    status: &RecordingStatus,
    streaming: Option<&StreamingSettings>,
) {
    let Some(session_id) = status.session_id.as_deref() else {
        return;
    };
    let targets: Vec<StreamTargetSettings> = streaming
        .filter(|streaming| streaming.enabled)
        .map(|streaming| {
            streaming
                .targets
                .iter()
                .filter(|target| target.enabled)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if targets.is_empty() {
        return;
    }
    let started_at = status
        .started_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map_or_else(Utc::now, |value| value.with_timezone(&Utc));
    send_fact(
        state,
        HookFact::SessionStarted {
            session_id: session_id.to_string(),
            started_at,
            targets,
        },
    );
}

/// `streamTargets.youtube.transition` to live succeeded.
pub fn on_youtube_live(state: &AppState, broadcast_id: &str, privacy: Option<StreamPrivacy>) {
    send_fact(
        state,
        HookFact::YouTubeLive {
            broadcast_id: broadcast_id.to_string(),
            privacy,
        },
    );
}

/// `streamTargets.x.publish` returned its share URL.
pub fn on_x_published(state: &AppState, session_id: Option<&str>, share_url: &str) {
    send_fact(
        state,
        HookFact::XPublished {
            session_id: session_id.map(str::to_string),
            share_url: share_url.to_string(),
        },
    );
}

/// Boot: start the announcer. Never fails the backend.
pub fn spawn(state: &AppState) {
    let (sender, receiver) = mpsc::channel(FACT_CHANNEL_CAPACITY);
    if state.discord_announce.facts.set(sender).is_err() {
        return;
    }
    let Some(client) = client::http_client() else {
        tracing::warn!("[discord] no HTTP client; go-live announcements are off.");
        return;
    };
    tokio::spawn(run_announcer(
        state.clone(),
        state.events.subscribe(),
        receiver,
        client,
    ));
}

// ---------------------------------------------------------------------------
// Settings access
// ---------------------------------------------------------------------------

fn load_settings(state: &AppState) -> StoredSettings {
    state
        .database
        .load_setting::<StoredSettings>(SETTINGS_KEY)
        .unwrap_or_else(|error| {
            tracing::warn!("[discord] settings unreadable, using defaults: {error}");
            None
        })
        .unwrap_or_default()
        .fold_legacy()
}

fn save_settings(state: &AppState, settings: &StoredSettings) -> anyhow::Result<()> {
    state.database.save_setting(SETTINGS_KEY, settings)
}

/// The last-messages row: one message per webhook. Plan 187 wrote one object
/// (and `null` after a removal); both still read.
fn parse_last_messages(value: serde_json::Value) -> Vec<LastMessage> {
    let parsed = match value {
        serde_json::Value::Array(_) => serde_json::from_value::<Vec<LastMessage>>(value),
        serde_json::Value::Object(_) => {
            serde_json::from_value::<LastMessage>(value).map(|message| vec![message])
        }
        _ => return Vec::new(),
    };
    parsed.unwrap_or_else(|error| {
        tracing::warn!("[discord] the last messages are unreadable, forgetting them: {error}");
        Vec::new()
    })
}

fn load_last_messages(state: &AppState) -> Vec<LastMessage> {
    state
        .database
        .load_setting::<serde_json::Value>(LAST_MESSAGE_KEY)
        .unwrap_or_else(|error| {
            tracing::warn!("[discord] the last messages are unreadable: {error}");
            None
        })
        .map(parse_last_messages)
        .unwrap_or_default()
}

fn save_last_messages(state: &AppState, messages: &[LastMessage]) {
    if let Err(error) = state.database.save_setting(LAST_MESSAGE_KEY, &messages) {
        tracing::warn!("[discord] could not save the last messages: {error}");
    }
}

/// Applies `change` to the last messages under their lock and saves.
fn update_last_messages(state: &AppState, change: impl FnOnce(&mut Vec<LastMessage>)) {
    let _guard = state
        .discord_announce
        .messages_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut messages = load_last_messages(state);
    change(&mut messages);
    save_last_messages(state, &messages);
}

/// Remembers `message` as its webhook's latest.
fn put_last_message(messages: &mut Vec<LastMessage>, message: LastMessage) {
    match messages
        .iter_mut()
        .find(|saved| saved.webhook_id == message.webhook_id)
    {
        Some(saved) => *saved = message,
        None => messages.push(message),
    }
}

fn forget_last_message(messages: &mut Vec<LastMessage>, webhook_id: &str) {
    messages.retain(|message| message.webhook_id != webhook_id);
}

/// Where one webhook's URL lives in the secrets file.
fn webhook_secret_ref(id: &str) -> String {
    format!("{WEBHOOK_SECRET_REF}.{id}")
}

/// A saved webhook's URL: its own secret, or plan 187's single secret while
/// that still holds this webhook. Nothing is copied or dropped on a read, so
/// an upgrade loses no webhook.
fn resolve_webhook_url(id: &str, read: impl Fn(&str) -> Option<String>) -> Option<WebhookUrl> {
    let parse = |raw: String| WebhookUrl::parse(&raw).ok().filter(|url| url.id() == id);
    read(&webhook_secret_ref(id))
        .and_then(parse)
        .or_else(|| read(WEBHOOK_SECRET_REF).and_then(parse))
}

/// What saving `webhook` writes: its own ref, and the single secret goes once
/// it held this same webhook (the URL now lives under the new ref).
fn secret_writes_for_save(
    webhook: &WebhookUrl,
    legacy_id: Option<&str>,
) -> (String, Vec<&'static str>) {
    let removals = (legacy_id == Some(webhook.id()))
        .then_some(WEBHOOK_SECRET_REF)
        .into_iter()
        .collect();
    (webhook_secret_ref(webhook.id()), removals)
}

/// What removing webhook `id` deletes: its own ref, and the single secret
/// when that is the one holding it.
fn secret_refs_for_remove(id: &str, legacy_id: Option<&str>) -> Vec<String> {
    let mut refs = vec![webhook_secret_ref(id)];
    if legacy_id == Some(id) {
        refs.push(WEBHOOK_SECRET_REF.to_string());
    }
    refs
}

fn read_secret(secret_ref: &str) -> Option<String> {
    crate::secrets::try_get_secret(secret_ref).ok().flatten()
}

fn stored_webhook(id: &str) -> Option<WebhookUrl> {
    resolve_webhook_url(id, read_secret)
}

/// Which webhook plan 187's single secret holds, if it is still there.
fn legacy_secret_id() -> Option<String> {
    read_secret(WEBHOOK_SECRET_REF)
        .and_then(|raw| WebhookUrl::parse(&raw).ok())
        .map(|url| url.id().to_string())
}

fn store_webhook_secret(webhook: &WebhookUrl) -> anyhow::Result<()> {
    let legacy_id = legacy_secret_id();
    let (secret_ref, removals) = secret_writes_for_save(webhook, legacy_id.as_deref());
    crate::secrets::update_secrets(
        &[(secret_ref.as_str(), &webhook.to_secret_string())],
        &removals,
    )
}

fn delete_webhook_secret(id: &str) -> anyhow::Result<()> {
    let legacy_id = legacy_secret_id();
    let refs = secret_refs_for_remove(id, legacy_id.as_deref());
    let refs: Vec<&str> = refs.iter().map(String::as_str).collect();
    crate::secrets::delete_secrets(&refs)
}

/// The saved webhooks whose secret is present, each with its URL.
fn saved_webhooks(settings: &StoredSettings) -> Vec<(WebhookMeta, WebhookUrl)> {
    settings
        .webhooks
        .iter()
        .filter_map(|meta| stored_webhook(&meta.id).map(|url| (meta.clone(), url)))
        .collect()
}

/// Applies `change` to the settings under the lock, saves, and announces
/// the new snapshot.
async fn modify_settings<T>(
    state: &AppState,
    change: impl FnOnce(&mut StoredSettings) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    let value = {
        let _guard = state.discord_announce.settings_lock.lock().await;
        let mut settings = load_settings(state);
        let value = change(&mut settings)?;
        save_settings(state, &settings).map_err(settings_unavailable)?;
        value
    };
    emit_snapshot(state).await;
    Ok(value)
}

/// "View in Discord": the message's link, once its server is known.
fn message_url(meta: &WebhookMeta, channel_id: Option<&str>, message_id: &str) -> Option<String> {
    let guild = meta.guild_id.as_deref()?;
    let channel = channel_id.unwrap_or(&meta.channel_id);
    Some(format!(
        "https://discord.com/channels/{guild}/{channel}/{message_id}"
    ))
}

async fn videorc_account(state: &AppState) -> Option<crate::protocol::VideorcAccountSnapshot> {
    state.account_session.lock().await.clone()
}

pub async fn snapshot(state: &AppState) -> DiscordAnnounceSnapshot {
    let settings = load_settings(state);
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let videorc = videorc_account(state).await;
    let messages = load_last_messages(state);
    let webhooks = saved_webhooks(&settings)
        .into_iter()
        .map(|(meta, _)| DiscordWebhookSnapshot {
            last_post: messages
                .iter()
                .find(|message| message.webhook_id == meta.id)
                .map(|message| LastPost {
                    at: message.posted_at.to_rfc3339(),
                    message_url: message_url(
                        &meta,
                        message.channel_id.as_deref(),
                        &message.message_id,
                    ),
                    state: if message.live {
                        LastPostState::Live
                    } else {
                        LastPostState::Ended
                    },
                }),
            id: meta.id,
            name: meta.name,
            hint: meta.hint,
            last_error: meta.last_error,
        })
        .collect();
    DiscordAnnounceSnapshot {
        webhooks,
        enabled: settings.enabled,
        ping: settings.ping,
        branding: settings.branding,
        post_as: settings.post_as,
        excluded_target_ids: settings.excluded_target_ids,
        link_overrides: settings.link_overrides,
        identities: links::identities(&accounts, videorc.as_ref()),
    }
}

async fn emit_snapshot(state: &AppState) {
    let snapshot = snapshot(state).await;
    state.emit_event(CHANGED_EVENT, snapshot);
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN
}

pub async fn update(
    state: &AppState,
    params: UpdateParams,
) -> Result<DiscordAnnounceSnapshot, RpcError> {
    if let Some(ids) = &params.excluded_target_ids
        && (ids.len() > MAX_TARGET_IDS || !ids.iter().all(|id| valid_id(id)))
    {
        return Err(RpcError::new("invalid-params", "Too many destinations."));
    }
    let typed = match &params.link_override {
        Some(change) if !valid_id(&change.target_id) => {
            return Err(RpcError::new("invalid-params", "Unknown destination."));
        }
        Some(LinkOverrideChange {
            link: Some(link), ..
        }) if !link.trim().is_empty() => Some(
            links::validate_typed_link(link)
                .map_err(|message| RpcError::new("discord-invalid-link", message))?,
        ),
        _ => None,
    };
    modify_settings(state, |settings| {
        if let Some(enabled) = params.enabled {
            settings.enabled = enabled;
        }
        if let Some(ping) = params.ping {
            settings.ping = ping;
        }
        if let Some(branding) = params.branding {
            settings.branding = branding;
        }
        if let Some(post_as) = params.post_as {
            settings.post_as = post_as;
        }
        if let Some(mut ids) = params.excluded_target_ids {
            ids.sort();
            ids.dedup();
            settings.excluded_target_ids = ids;
        }
        if let Some(change) = params.link_override {
            match typed {
                Some(link) => {
                    if settings.link_overrides.len() >= MAX_TARGET_IDS
                        && !settings.link_overrides.contains_key(&change.target_id)
                    {
                        return Err(RpcError::new("invalid-params", "Too many typed links."));
                    }
                    settings.link_overrides.insert(change.target_id, link);
                }
                None => {
                    settings.link_overrides.remove(&change.target_id);
                }
            }
        }
        Ok(())
    })
    .await?;
    Ok(snapshot(state).await)
}

/// Verifies a pasted webhook with Discord and adds it. The same webhook
/// pasted again replaces the saved one (a fresh token after a reset).
pub async fn save_webhook(
    state: &AppState,
    params: SaveWebhookParams,
) -> Result<DiscordAnnounceSnapshot, RpcError> {
    let webhook = WebhookUrl::parse(&params.url)
        .map_err(|_| RpcError::new("discord-invalid-url", "That isn't a Discord webhook URL."))?;
    let client =
        client::http_client().ok_or_else(|| RpcError::from_send(SendError::Unreachable))?;
    let info = client::verify(&client, &client::api_origin(), &webhook)
        .await
        .map_err(RpcError::from_send)?;
    let meta = WebhookMeta {
        id: webhook.id().to_string(),
        name: info
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
        channel_id: info.channel_id,
        guild_id: info.guild_id,
        hint: webhook.hint(),
        verified_at: Utc::now().to_rfc3339(),
        components_refused: false,
        last_error: None,
    };
    modify_settings(state, |settings| {
        settings.upsert_webhook(meta)?;
        // Under the settings lock, after the cap check and before the settings
        // land: a refused paste never writes a secret.
        store_webhook_secret(&webhook).map_err(settings_unavailable)
    })
    .await?;
    state.emit_log("info", "Discord webhook connected.");
    Ok(snapshot(state).await)
}

/// Removes one webhook: its secret, its settings and its remembered message.
/// The others keep posting.
pub async fn remove_webhook(
    state: &AppState,
    params: RemoveWebhookParams,
) -> Result<DiscordAnnounceSnapshot, RpcError> {
    let webhook_id = params.webhook_id;
    if !valid_id(&webhook_id) {
        return Err(RpcError::new("invalid-params", "Unknown webhook."));
    }
    modify_settings(state, |settings| {
        if settings.remove_webhook(&webhook_id).is_none() {
            return Err(RpcError::new(
                "discord-no-webhook",
                "That webhook was already removed.",
            ));
        }
        delete_webhook_secret(&webhook_id).map_err(settings_unavailable)
    })
    .await?;
    update_last_messages(state, |messages| forget_last_message(messages, &webhook_id));
    emit_snapshot(state).await;
    Ok(snapshot(state).await)
}

pub async fn preview_links(
    state: &AppState,
    params: TargetsParams,
) -> Result<LinksPreviewResult, RpcError> {
    if params.targets.len() > MAX_TARGET_IDS {
        return Err(RpcError::new("invalid-params", "Too many destinations."));
    }
    let settings = load_settings(state);
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let videorc = videorc_account(state).await;
    let previews = links::preview(
        &params.targets,
        &accounts,
        &settings.excluded_target_ids,
        &settings.link_overrides,
    );
    let first = previews.iter().find(|row| row.included).and_then(|row| {
        params
            .targets
            .iter()
            .find(|target| target.id == row.target_id)
    });
    Ok(LinksPreviewResult {
        sender: links::resolve_sender(&settings.post_as, first, &accounts, videorc.as_ref()),
        links: previews,
    })
}

/// A real link for a test post where the live one is made at Go Live: the
/// YouTube channel, the X profile.
fn test_link(
    target: &LinkTarget,
    accounts: &[crate::streaming::PlatformAccount],
) -> Option<String> {
    let account = links::account_for(target, accounts)?;
    match target.platform {
        crate::streaming::StreamPlatform::Youtube => Some(format!(
            "https://www.youtube.com/channel/{}",
            account.account_id
        )),
        crate::streaming::StreamPlatform::X => account
            .account_handle
            .as_deref()
            .map(|handle| handle.trim_start_matches('@'))
            .filter(|handle| !handle.is_empty())
            .map(|handle| format!("https://x.com/{handle}")),
        _ => None,
    }
}

/// "Send test message" to one webhook: the real title, sender, thumbnail
/// and links, a test label, and never a ping.
pub async fn send_test(state: &AppState, params: TestParams) -> Result<TestResult, RpcError> {
    let settings = load_settings(state);
    let meta = settings
        .webhook(&params.webhook_id)
        .cloned()
        .ok_or_else(RpcError::no_webhook)?;
    let webhook = stored_webhook(&meta.id).ok_or_else(RpcError::no_webhook)?;
    let targets = TargetsParams {
        targets: params.targets,
    };
    let preview = preview_links(state, targets.clone()).await?;
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let link_buttons: Vec<LinkButton> = preview
        .links
        .iter()
        .filter(|row| !settings.excluded_target_ids.contains(&row.target_id))
        .filter_map(|row| {
            let url = row.link.clone().or_else(|| {
                targets
                    .targets
                    .iter()
                    .find(|target| target.id == row.target_id)
                    .and_then(|target| test_link(target, &accounts))
            })?;
            Some(LinkButton {
                label: row.label.clone(),
                url,
            })
        })
        .collect();
    let draft = state.database.stream_metadata_draft().ok();
    let title = draft
        .as_ref()
        .map(|draft| draft.title.trim().to_string())
        .unwrap_or_default();
    let thumbnail = draft
        .as_ref()
        .and_then(|draft| load_thumbnail(state, draft.thumbnail_asset_id.as_deref()));
    let components = !meta.components_refused;
    let view = |components: bool| MessageView {
        title: &title,
        links: &link_buttons,
        mood: Mood::Test,
        ping: settings.ping,
        branding: settings.branding,
        started_at: Utc::now(),
        sender: preview.sender.as_ref(),
        image_filename: thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.filename.as_str()),
        components,
    };
    let client =
        client::http_client().ok_or_else(|| RpcError::from_send(SendError::Unreachable))?;
    let origin = client::api_origin();
    let never = Arc::new(AtomicBool::new(false));
    let policy = TEST_POST_POLICY;
    let first = client::execute(
        &client,
        &origin,
        &webhook,
        &client::message_body(&view(components), false),
        thumbnail.as_ref(),
        policy,
        &never,
    )
    .await;
    let posted = match first {
        Err(SendError::ComponentsRefused) if components => {
            mark_components_refused(state, &meta.id).await;
            client::execute(
                &client,
                &origin,
                &webhook,
                &client::message_body(&view(false), false),
                thumbnail.as_ref(),
                policy,
                &never,
            )
            .await
        }
        other => other,
    }
    .map_err(RpcError::from_send)?;
    Ok(TestResult {
        message_url: message_url(&meta, posted.channel_id.as_deref(), &posted.message_id),
    })
}

async fn mark_components_refused(state: &AppState, webhook_id: &str) {
    let _ = modify_settings(state, |settings| {
        if let Some(meta) = settings.webhook_mut(webhook_id) {
            meta.components_refused = true;
        }
        Ok(())
    })
    .await;
}

fn load_thumbnail(state: &AppState, asset_id: Option<&str>) -> Option<Thumbnail> {
    let path = state
        .resource_authority
        .resolve_managed_thumbnail(asset_id?)
        .ok()?;
    let bytes = std::fs::read(path).ok()?;
    let content_type = crate::scheduled_youtube::validate_thumbnail(&bytes).ok()?;
    let filename = if content_type == "image/png" {
        "thumbnail.png"
    } else {
        "thumbnail.jpg"
    };
    Some(Thumbnail {
        filename: filename.to_string(),
        content_type,
        bytes,
    })
}

// ---------------------------------------------------------------------------
// The announcer
// ---------------------------------------------------------------------------

/// What a session's posts say and where they go, fixed at Go Live. One per
/// webhook: every server gets the same post, through its own webhook.
#[derive(Debug, Clone)]
struct SessionContext {
    webhook: WebhookUrl,
    webhook_id: String,
    webhook_name: Option<String>,
    sender: Option<Sender>,
    ping: DiscordPing,
    branding: bool,
    title: String,
    thumbnail: Option<Thumbnail>,
    /// The attachment the message's embed shows, once there is a message.
    image_filename: Option<String>,
    channel_id: Option<String>,
    posted_at: Option<DateTime<Utc>>,
}

/// One session's announcement through one webhook: its own state machine,
/// fed the same facts as its siblings.
struct Active {
    machine: AnnounceSession,
    context: SessionContext,
    /// Set at the stop: a post still retrying gives up.
    stopped: Arc<AtomicBool>,
    last_heartbeat: DateTime<Utc>,
}

/// A request on its way to Discord: which session and webhook it serves.
#[derive(Debug, Clone)]
struct InFlight {
    session_id: String,
    webhook_id: String,
    request: Request,
}

#[derive(Debug)]
struct RequestResult {
    outcome: Result<Option<client::Posted>, SendError>,
    components_refused: bool,
}

async fn run_announcer(
    state: AppState,
    mut events: broadcast::Receiver<ServerEvent>,
    mut facts: mpsc::Receiver<HookFact>,
    client: reqwest::Client,
) {
    // One per (session, webhook); at most MAX_SESSIONS sessions.
    let mut sessions: Vec<Active> = Vec::new();
    let mut early_targets: Option<StreamTargetsSnapshot> = None;
    let mut ended_ids: Vec<String> = Vec::new();
    // At most one request per webhook at a time; webhooks run side by side.
    let mut requests: JoinSet<RequestResult> = JoinSet::new();
    let mut in_flight: HashMap<tokio::task::Id, InFlight> = HashMap::new();
    let mut recovery_at = Some(tokio::time::Instant::now() + RECOVERY_DELAY);

    loop {
        let now = Utc::now();
        start_due_requests(
            &state,
            &client,
            &mut sessions,
            &mut requests,
            &mut in_flight,
            now,
        );
        sessions.retain(|active| !active.machine.is_finished());

        let deadline = sessions
            .iter()
            .filter_map(|active| {
                let heartbeat = (active.machine.message_id().is_some()
                    && active.machine.ended_at().is_none())
                .then_some(active.last_heartbeat + HEARTBEAT);
                active
                    .machine
                    .next_deadline()
                    .into_iter()
                    .chain(heartbeat)
                    .min()
            })
            .min()
            .map(|at| tokio::time::Instant::now() + (at - Utc::now()).to_std().unwrap_or_default());
        let deadline = match (deadline, recovery_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };

        tokio::select! {
            received = events.recv() => match received {
                Ok(event) if state.performance_check.suppresses_event(&event.event) => {}
                Ok(event) => observe_event(&state, &event, &mut sessions, &mut early_targets, &mut ended_ids),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
            received = facts.recv() => {
                let Some(fact) = received else { return };
                observe_fact(&state, fact, &mut sessions, &mut early_targets, &ended_ids).await;
            }
            joined = requests.join_next_with_id(), if !requests.is_empty() => {
                let (id, result) = match joined {
                    Some(Ok((id, result))) => (id, result),
                    Some(Err(error)) => (error.id(), RequestResult {
                        outcome: Err(SendError::Unreachable),
                        components_refused: false,
                    }),
                    None => continue,
                };
                if let Some(finished) = in_flight.remove(&id) {
                    finish_request(&state, &mut sessions, finished, result).await;
                }
            }
            () = sleep_until(deadline) => {
                let now = Utc::now();
                for active in &mut sessions {
                    active.machine.tick(now);
                    if active.machine.message_id().is_some()
                        && active.machine.ended_at().is_none()
                        && now - active.last_heartbeat >= HEARTBEAT
                    {
                        active.last_heartbeat = now;
                        heartbeat(&state, &active.context.webhook_id, active.machine.session_id(), now);
                    }
                }
                if recovery_at.is_some_and(|at| at <= tokio::time::Instant::now()) {
                    recovery_at = None;
                    let live_ids: Vec<String> = sessions
                        .iter()
                        .map(|active| active.machine.session_id().to_string())
                        .collect();
                    tokio::spawn(recover_stale_messages(state.clone(), client.clone(), live_ids));
                }
            }
        }
    }
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn observe_event(
    state: &AppState,
    event: &ServerEvent,
    sessions: &mut [Active],
    early_targets: &mut Option<StreamTargetsSnapshot>,
    ended_ids: &mut Vec<String>,
) {
    let now = Utc::now();
    match event.event.as_str() {
        "stream.targets" => {
            let Ok(snapshot) = StreamTargetsSnapshot::deserialize(&event.payload) else {
                return;
            };
            let mut seen = false;
            for active in sessions
                .iter_mut()
                .filter(|active| active.machine.session_id() == snapshot.session_id)
            {
                active.machine.observe_targets(&snapshot, now);
                seen = true;
            }
            if !seen {
                *early_targets = Some(snapshot);
            }
        }
        "recording.status" => {
            let Ok(status) = RecordingStatus::deserialize(&event.payload) else {
                return;
            };
            if !matches!(status.state, RecordingState::Idle | RecordingState::Failed) {
                return;
            }
            if let Some(id) = status.session_id.as_deref() {
                ended_ids.push(id.to_string());
                if ended_ids.len() > 8 {
                    ended_ids.remove(0);
                }
            }
            for active in sessions.iter_mut().filter(|active| {
                active.machine.ended_at().is_none()
                    && status
                        .session_id
                        .as_deref()
                        .is_none_or(|id| id == active.machine.session_id())
            }) {
                active.machine.end(now);
                active.stopped.store(true, Ordering::Release);
                mark_ended(
                    state,
                    &active.context.webhook_id,
                    active.machine.session_id(),
                    now,
                );
            }
        }
        _ => {}
    }
}

/// The newest session still running, if any.
fn newest_live_session(sessions: &[Active]) -> Option<String> {
    sessions
        .iter()
        .rev()
        .find(|active| active.machine.ended_at().is_none())
        .map(|active| active.machine.session_id().to_string())
}

async fn observe_fact(
    state: &AppState,
    fact: HookFact,
    sessions: &mut Vec<Active>,
    early_targets: &mut Option<StreamTargetsSnapshot>,
    ended_ids: &[String],
) {
    let now = Utc::now();
    match fact {
        HookFact::SessionStarted {
            session_id,
            started_at,
            targets,
        } => {
            if ended_ids.contains(&session_id)
                || sessions
                    .iter()
                    .any(|active| active.machine.session_id() == session_id)
            {
                return;
            }
            let actives = begin_session(state, &session_id, started_at, &targets).await;
            if actives.is_empty() {
                return;
            }
            let early = early_targets
                .take()
                .filter(|snapshot| snapshot.session_id == session_id);
            for mut active in actives {
                if let Some(snapshot) = &early {
                    active.machine.observe_targets(snapshot, now);
                }
                sessions.push(active);
            }
            retain_newest_sessions(sessions, MAX_SESSIONS);
        }
        HookFact::YouTubeLive {
            broadcast_id,
            privacy,
        } => {
            let Some(session_id) = newest_live_session(sessions) else {
                return;
            };
            for active in sessions
                .iter_mut()
                .filter(|active| active.machine.session_id() == session_id)
            {
                active
                    .machine
                    .observe_youtube_live(&broadcast_id, privacy, now);
            }
        }
        HookFact::XPublished {
            session_id,
            share_url,
        } => {
            let Some(session_id) = session_id.or_else(|| newest_live_session(sessions)) else {
                return;
            };
            for active in sessions
                .iter_mut()
                .filter(|active| active.machine.session_id() == session_id)
            {
                active.machine.observe_x_published(&share_url, now);
            }
        }
    }
}

/// Keeps the `keep` newest sessions (every webhook's machine for each), in
/// the order they started.
fn retain_newest_sessions(sessions: &mut Vec<Active>, keep: usize) {
    let mut ids: Vec<String> = Vec::new();
    for active in sessions.iter() {
        if !ids.iter().any(|id| id == active.machine.session_id()) {
            ids.push(active.machine.session_id().to_string());
        }
    }
    if ids.len() <= keep {
        return;
    }
    let dropped: Vec<String> = ids.drain(..ids.len() - keep).collect();
    sessions.retain(|active| !dropped.iter().any(|id| id == active.machine.session_id()));
}

/// Builds a session's announcement at Go Live, one per saved webhook, or
/// nothing when it posts nothing (off, no webhook, nothing ticked and
/// linkable). The post is composed once; each webhook gets its own machine.
async fn begin_session(
    state: &AppState,
    session_id: &str,
    started_at: DateTime<Utc>,
    targets: &[StreamTargetSettings],
) -> Vec<Active> {
    let settings = load_settings(state);
    if !settings.enabled {
        return Vec::new();
    }
    let webhooks = saved_webhooks(&settings);
    if webhooks.is_empty() {
        return Vec::new();
    }
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let draft = state.database.stream_metadata_draft().ok();
    let youtube_privacy = draft
        .as_ref()
        .map(|draft| {
            draft
                .target_overrides
                .iter()
                .find(|row| row.platform == crate::streaming::StreamPlatform::Youtube)
                .filter(|row| row.customize)
                .map_or(draft.default_privacy, |row| row.privacy)
        })
        // Unknown never counts as public.
        .unwrap_or(StreamPrivacy::Private);
    let link_targets: Vec<LinkTarget> = targets.iter().map(LinkTarget::from).collect();
    let plans = links::leg_plans(
        &link_targets,
        &accounts,
        &settings.excluded_target_ids,
        &settings.link_overrides,
        youtube_privacy,
    );
    if plans.is_empty() {
        tracing::info!("[discord] nothing to announce for session {session_id}.");
        return Vec::new();
    }
    let first = plans.first().and_then(|plan| {
        link_targets
            .iter()
            .find(|target| target.id == plan.target_id)
    });
    let videorc = videorc_account(state).await;
    let sender = links::resolve_sender(&settings.post_as, first, &accounts, videorc.as_ref());
    let title = draft
        .as_ref()
        .map(|draft| draft.title.trim().to_string())
        .unwrap_or_default();
    let thumbnail = draft
        .as_ref()
        .and_then(|draft| load_thumbnail(state, draft.thumbnail_asset_id.as_deref()));
    let now = Utc::now();
    let messages = load_last_messages(state);
    webhooks
        .into_iter()
        .map(|(meta, webhook)| {
            // The restart window: this webhook's last message, if its session
            // ended moments ago, is edited back to live instead of a new post.
            let reuse = messages.iter().find(|message| {
                message.webhook_id == meta.id
                    && message.session_id != session_id
                    && message
                        .ended_at
                        .is_some_and(|ended| now - ended <= machine::RESTART_WINDOW && now >= ended)
            });
            let context = SessionContext {
                webhook,
                webhook_id: meta.id.clone(),
                webhook_name: meta.name.clone(),
                sender: sender.clone(),
                ping: settings.ping,
                branding: settings.branding,
                title: title.clone(),
                image_filename: reuse.and_then(|message| message.image_filename.clone()),
                channel_id: reuse.and_then(|message| message.channel_id.clone()),
                posted_at: reuse.map(|message| message.posted_at),
                thumbnail: thumbnail.clone(),
            };
            Active {
                machine: AnnounceSession::new(
                    session_id,
                    started_at,
                    plans.clone(),
                    reuse.map(|message| message.message_id.clone()),
                ),
                context,
                stopped: Arc::new(AtomicBool::new(false)),
                last_heartbeat: now,
            }
        })
        .collect()
}

fn current_components(state: &AppState, webhook_id: &str) -> bool {
    !load_settings(state)
        .webhook(webhook_id)
        .is_some_and(|meta| meta.components_refused)
}

/// Starts every due request whose webhook has none in flight, oldest session
/// first: an old session's "Was live" edit lands before a restart's revive
/// edit on the same webhook, while a slow server never delays another.
fn start_due_requests(
    state: &AppState,
    client: &reqwest::Client,
    sessions: &mut [Active],
    requests: &mut JoinSet<RequestResult>,
    in_flight: &mut HashMap<tokio::task::Id, InFlight>,
    now: DateTime<Utc>,
) {
    let mut busy: BTreeSet<String> = in_flight
        .values()
        .map(|entry| entry.webhook_id.clone())
        .collect();
    for active in sessions.iter_mut() {
        if busy.contains(&active.context.webhook_id) {
            continue;
        }
        let Some(request) = active.machine.next_request(now) else {
            continue;
        };
        let (id, entry) = start_request(state, client, active, request, requests);
        busy.insert(entry.webhook_id.clone());
        in_flight.insert(id, entry);
    }
}

/// Sends `request` through `active`'s webhook on its own task. Both bodies
/// are built now, so a refusal of link buttons falls back at once.
fn start_request(
    state: &AppState,
    client: &reqwest::Client,
    active: &mut Active,
    request: Request,
    requests: &mut JoinSet<RequestResult>,
) -> (tokio::task::Id, InFlight) {
    active.machine.started(&request);
    let links = active.machine.links();
    let context = active.context.clone();
    let components = current_components(state, &context.webhook_id);
    let mood = match &request {
        Request::Edit { ended: true, .. } => Mood::Ended {
            duration: active
                .machine
                .ended_at()
                .map(|ended| ended - active.machine.started_at()),
        },
        _ => Mood::Live,
    };
    let is_post = matches!(request, Request::Post);
    let image_filename = if is_post {
        context
            .thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.filename.clone())
    } else {
        context.image_filename.clone()
    };
    let body = |components: bool| {
        client::message_body(
            &MessageView {
                title: &context.title,
                links: &links,
                mood: mood.clone(),
                ping: context.ping,
                branding: context.branding,
                started_at: active.machine.started_at(),
                sender: context.sender.as_ref(),
                image_filename: image_filename.as_deref(),
                components,
            },
            !is_post,
        )
    };
    let with_buttons = body(components);
    let without_buttons = body(false);
    let stopped = if is_post {
        active.stopped.clone()
    } else {
        Arc::new(AtomicBool::new(false))
    };
    let client = client.clone();
    let origin = client::api_origin();
    let webhook = context.webhook.clone();
    let thumbnail = if is_post { context.thumbnail } else { None };
    let message_id = match &request {
        Request::Edit { message_id, .. } => Some(message_id.clone()),
        Request::Post => None,
    };
    let session_id = active.machine.session_id().to_string();
    tracing::info!(
        "[discord] {} for session {session_id} through webhook {}",
        match &request {
            Request::Post => "posting the go-live announcement",
            Request::Edit { ended: true, .. } => "marking the announcement ended",
            Request::Edit { revive: true, .. } => "reviving the previous announcement",
            Request::Edit { .. } => "adding destinations to the announcement",
        },
        webhook.hint()
    );
    let handle = requests.spawn(async move {
        let send = |body: serde_json::Value| {
            let client = client.clone();
            let origin = origin.clone();
            let webhook = webhook.clone();
            let thumbnail = thumbnail.clone();
            let message_id = message_id.clone();
            let stopped = stopped.clone();
            async move {
                match message_id {
                    None => client::execute(
                        &client,
                        &origin,
                        &webhook,
                        &body,
                        thumbnail.as_ref(),
                        RetryPolicy::DEFAULT,
                        &stopped,
                    )
                    .await
                    .map(Some),
                    Some(message_id) => client::edit(
                        &client,
                        &origin,
                        &webhook,
                        &message_id,
                        &body,
                        RetryPolicy::DEFAULT,
                        &stopped,
                    )
                    .await
                    .map(|()| None),
                }
            }
        };
        match send(with_buttons).await {
            Err(SendError::ComponentsRefused) if components => RequestResult {
                outcome: send(without_buttons).await,
                components_refused: true,
            },
            outcome => RequestResult {
                outcome,
                components_refused: false,
            },
        }
    });
    (
        handle.id(),
        InFlight {
            session_id,
            webhook_id: context.webhook_id,
            request,
        },
    )
}

/// "Discord (Stream alerts)": names the server in health copy when there are
/// several.
fn discord_label(name: Option<&str>) -> String {
    match name {
        Some(name) => format!("Discord ({name})"),
        None => "Discord".to_string(),
    }
}

async fn finish_request(
    state: &AppState,
    sessions: &mut [Active],
    finished: InFlight,
    result: RequestResult,
) {
    let now = Utc::now();
    if result.components_refused {
        mark_components_refused(state, &finished.webhook_id).await;
    }
    let Some(active) = sessions.iter_mut().find(|active| {
        active.machine.session_id() == finished.session_id
            && active.context.webhook_id == finished.webhook_id
    }) else {
        return;
    };
    let session_id = finished.session_id.clone();
    let webhook_id = finished.webhook_id.clone();
    let label = discord_label(active.context.webhook_name.as_deref());
    let outcome = match (&finished.request, result.outcome) {
        (Request::Post, Ok(Some(posted))) => {
            active.context.image_filename = active
                .context
                .thumbnail
                .as_ref()
                .map(|thumbnail| thumbnail.filename.clone());
            active.context.channel_id = posted.channel_id.clone();
            active.context.posted_at = Some(now);
            record_message(state, active, &posted.message_id, true, now);
            set_last_error(state, &webhook_id, None).await;
            health(
                state,
                &session_id,
                HealthLevel::Info,
                "discord-announce-posted",
                &format!("Posted the go-live announcement to {label}."),
            );
            Outcome::Posted {
                message_id: posted.message_id,
            }
        }
        (Request::Post, Err(SendError::Cancelled)) => Outcome::Failed,
        (Request::Post, outcome) => {
            let error = outcome.err().unwrap_or(SendError::Unreachable);
            post_failed(state, &webhook_id, &label, &session_id, error).await;
            Outcome::Failed
        }
        (
            Request::Edit {
                message_id,
                ended,
                revive,
            },
            Ok(_),
        ) => {
            if *revive {
                active.context.posted_at = Some(now);
                record_message(state, active, message_id, true, now);
                set_last_error(state, &webhook_id, None).await;
                health(
                    state,
                    &session_id,
                    HealthLevel::Info,
                    "discord-announce-revived",
                    &format!(
                        "Turned the previous {label} announcement back to live (restarted within 15 minutes)."
                    ),
                );
            } else {
                record_message(state, active, message_id, !*ended, now);
            }
            Outcome::Edited
        }
        (Request::Edit { .. }, Err(SendError::MessageGone)) => {
            update_last_messages(state, |messages| forget_last_message(messages, &webhook_id));
            emit_snapshot(state).await;
            Outcome::MessageGone
        }
        (Request::Edit { .. }, Err(error)) => {
            if error == SendError::WebhookGone {
                set_last_error(state, &webhook_id, Some(AnnounceErrorCode::WebhookDeleted)).await;
            }
            health(
                state,
                &session_id,
                HealthLevel::Warn,
                "discord-announce-edit-failed",
                &format!(
                    "Couldn't update the {label} announcement: {}.",
                    error.describe()
                ),
            );
            Outcome::Failed
        }
    };
    active.machine.finished(outcome, now);
}

/// Saves the session's message as its webhook's last one (and refreshes
/// "Last post").
fn record_message(
    state: &AppState,
    active: &Active,
    message_id: &str,
    live: bool,
    now: DateTime<Utc>,
) {
    update_last_messages(state, |messages| {
        let previous = messages.iter().find(|message| {
            message.webhook_id == active.context.webhook_id && message.message_id == message_id
        });
        let message = LastMessage {
            webhook_id: active.context.webhook_id.clone(),
            message_id: message_id.to_string(),
            channel_id: active
                .context
                .channel_id
                .clone()
                .or_else(|| previous.and_then(|message| message.channel_id.clone())),
            session_id: active.machine.session_id().to_string(),
            started_at: active.machine.started_at(),
            last_seen_live_at: now,
            ended_at: active.machine.ended_at(),
            live,
            posted_at: active
                .context
                .posted_at
                .or_else(|| previous.map(|message| message.posted_at))
                .unwrap_or(now),
            title: active.context.title.clone(),
            links: active.machine.links(),
            branding: active.context.branding,
            image_filename: active.context.image_filename.clone(),
        };
        put_last_message(messages, message);
    });
    let state = state.clone();
    tokio::spawn(async move { emit_snapshot(&state).await });
}

/// The session ended: remember when, for the restart window and recovery.
fn mark_ended(state: &AppState, webhook_id: &str, session_id: &str, now: DateTime<Utc>) {
    update_last_messages(state, |messages| {
        if let Some(message) = messages
            .iter_mut()
            .find(|message| message.webhook_id == webhook_id && message.session_id == session_id)
        {
            message.ended_at.get_or_insert(now);
        }
    });
}

fn heartbeat(state: &AppState, webhook_id: &str, session_id: &str, now: DateTime<Utc>) {
    update_last_messages(state, |messages| {
        if let Some(message) = messages.iter_mut().find(|message| {
            message.webhook_id == webhook_id && message.session_id == session_id && message.live
        }) {
            message.last_seen_live_at = now;
        }
    });
}

async fn set_last_error(state: &AppState, webhook_id: &str, code: Option<AnnounceErrorCode>) {
    let _ = modify_settings(state, |settings| {
        if let Some(meta) = settings.webhook_mut(webhook_id) {
            meta.last_error = code.map(|code| AnnounceError {
                code,
                at: Utc::now().to_rfc3339(),
            });
        }
        Ok(())
    })
    .await;
}

async fn post_failed(
    state: &AppState,
    webhook_id: &str,
    label: &str,
    session_id: &str,
    error: SendError,
) {
    let code = match error {
        SendError::WebhookGone => AnnounceErrorCode::WebhookDeleted,
        SendError::Unreachable => AnnounceErrorCode::Unreachable,
        _ => AnnounceErrorCode::Rejected,
    };
    set_last_error(state, webhook_id, Some(code)).await;
    health(
        state,
        session_id,
        HealthLevel::Warn,
        "discord-announce-failed",
        &format!("Couldn't post to {label}: {}.", error.describe()),
    );
}

fn health(state: &AppState, session_id: &str, level: HealthLevel, code: &str, message: &str) {
    if let Err(error) =
        crate::recording::emit_health_event(state, Some(session_id), level, code, message)
    {
        tracing::debug!("[discord] health event not stored: {error}");
    }
}

/// At launch: every message still "Live now" whose session is not running
/// (the app quit or crashed mid-stream) becomes "Was live", each through its
/// own webhook.
async fn recover_stale_messages(state: AppState, client: reqwest::Client, live_ids: Vec<String>) {
    let stale: Vec<LastMessage> = load_last_messages(&state)
        .into_iter()
        .filter(|message| message.live && !live_ids.contains(&message.session_id))
        .collect();
    if stale.is_empty() {
        return;
    }
    let settings = load_settings(&state);
    let mut tasks = JoinSet::new();
    for message in stale {
        let webhook = settings
            .webhook(&message.webhook_id)
            .and_then(|meta| stored_webhook(&meta.id).map(|url| (meta.clone(), url)));
        match webhook {
            Some((meta, webhook)) => {
                tasks.spawn(recover_stale_message(
                    state.clone(),
                    client.clone(),
                    meta,
                    webhook,
                    message,
                ));
            }
            // The webhook is gone from Videorc: nothing left to tidy.
            None => update_last_messages(&state, |messages| {
                forget_last_message(messages, &message.webhook_id)
            }),
        }
    }
    while tasks.join_next().await.is_some() {}
    emit_snapshot(&state).await;
}

async fn recover_stale_message(
    state: AppState,
    client: reqwest::Client,
    meta: WebhookMeta,
    webhook: WebhookUrl,
    message: LastMessage,
) {
    let ended = message.ended_at.unwrap_or(message.last_seen_live_at);
    let duration = (ended > message.started_at).then(|| ended - message.started_at);
    let body = client::message_body(
        &MessageView {
            title: &message.title,
            links: &message.links,
            mood: Mood::Ended { duration },
            ping: DiscordPing::None,
            branding: message.branding,
            started_at: message.started_at,
            sender: None,
            image_filename: message.image_filename.as_deref(),
            components: !meta.components_refused,
        },
        true,
    );
    let never = Arc::new(AtomicBool::new(false));
    // Only this message: a newer one for the same webhook may have landed
    // while the edit retried.
    let is_this = |saved: &LastMessage| {
        saved.webhook_id == message.webhook_id && saved.message_id == message.message_id
    };
    match client::edit(
        &client,
        &client::api_origin(),
        &webhook,
        &message.message_id,
        &body,
        RetryPolicy::DEFAULT,
        &never,
    )
    .await
    {
        Ok(()) => {
            update_last_messages(&state, |messages| {
                if let Some(saved) = messages.iter_mut().find(|saved| is_this(saved)) {
                    saved.live = false;
                    saved.ended_at = Some(ended);
                }
            });
            tracing::info!(
                "[discord] marked a stale go-live announcement as ended (webhook {}).",
                webhook.hint()
            );
        }
        Err(SendError::MessageGone | SendError::WebhookGone) => {
            update_last_messages(&state, |messages| messages.retain(|saved| !is_this(saved)));
        }
        Err(error) => tracing::info!(
            "[discord] could not tidy a stale announcement (webhook {}): {}",
            webhook.hint(),
            error.describe()
        ),
    }
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
