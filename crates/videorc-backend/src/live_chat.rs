//! In-app live chat — capability + scope audit (Slice 1 of the In-App Livestream Comments
//! plan: `2026-06-06 - Videorc In-App Livestream Comments Plan`). Reports, per streaming
//! platform, whether the connected account can read live chat, needs to reconnect for a
//! missing scope, or has no verified native chat path. The `LiveChatCoordinator` and the
//! per-platform connectors arrive in later slices; this is the capability the Studio UI
//! uses to warn the streamer before they go live.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep};

use crate::state::AppState;
use crate::streaming::{PlatformAccount, StreamPlatform, stream_platform_id};

// --- Live chat shared data model (slice 2) ---

/// Runtime connection state of one platform's chat connector.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveChatProviderConnectionState {
    Disabled,
    Connecting,
    Connected,
    Reconnecting,
    Waiting,
    Failed,
    Unsupported,
    Ended,
}

/// What kind of chat row a message is — drives special styling for monetized/system events.
// Message-level types are constructed by the platform connectors (slices 4+); this slice
// only defines the shared model + serialization.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveChatEventType {
    Message,
    Paid,
    Membership,
    System,
    Deleted,
    Moderation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatProviderState {
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub state: LiveChatProviderConnectionState,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// A rich-text fragment of a message (plain text, emote, mention, …) for faithful rendering.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LiveChatMessageFragment {
    #[serde(rename = "type")]
    pub fragment_type: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LiveChatMessage {
    /// Stable app id, `{platform}:{providerMessageId}` — the de-duplication key.
    pub id: String,
    pub provider_message_id: String,
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    pub author_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    #[serde(default)]
    pub author_badges: Vec<String>,
    #[serde(default)]
    pub author_roles: Vec<String>,
    pub published_at: String,
    pub received_at: String,
    pub message_text: String,
    #[serde(default)]
    pub fragments: Vec<LiveChatMessageFragment>,
    pub event_type: LiveChatEventType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_text: Option<String>,
    #[serde(default)]
    pub is_deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_provider_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub providers: Vec<LiveChatProviderState>,
    pub messages: Vec<LiveChatMessage>,
    pub unread_count: u64,
    pub updated_at: String,
}

/// The stable, de-dup app id for a message: `{platform}:{providerMessageId}`.
#[allow(dead_code)]
pub fn live_chat_message_id(platform: StreamPlatform, provider_message_id: &str) -> String {
    format!("{}:{}", stream_platform_id(platform), provider_message_id)
}

/// Build the initial Live Chat snapshot for setup time (no session running): one provider
/// row per native platform derived from its chat capability, with no messages yet. The
/// LiveChatCoordinator replaces this with live connector state once Go Live starts.
pub fn initial_chat_snapshot(accounts: &[PlatformAccount], updated_at: String) -> LiveChatSnapshot {
    let providers = chat_capabilities(accounts)
        .into_iter()
        .map(provider_state_from_capability)
        .collect();
    LiveChatSnapshot {
        session_id: None,
        providers,
        messages: Vec::new(),
        unread_count: 0,
        updated_at,
    }
}

/// Map a setup-time capability to a provider row. No connector is running yet, so a
/// capable/connected platform is `Disabled` (idle) and platforms with no native path are
/// `Unsupported`; the human-readable readiness lives in `message` + `capabilities`.
fn provider_state_from_capability(capability: ChatCapability) -> LiveChatProviderState {
    let state = match capability.state {
        ChatCapabilityState::Unsupported => LiveChatProviderConnectionState::Unsupported,
        ChatCapabilityState::Available
        | ChatCapabilityState::NeedsReconnect
        | ChatCapabilityState::NotConnected => LiveChatProviderConnectionState::Disabled,
    };
    LiveChatProviderState {
        platform: capability.platform,
        target_id: None,
        account_id: capability.account_id,
        account_label: capability.account_label,
        state,
        message: capability.message,
        last_connected_at: None,
        last_message_at: None,
        last_error: None,
        capabilities: vec![capability_state_tag(capability.state).to_string()],
    }
}

fn capability_state_tag(state: ChatCapabilityState) -> &'static str {
    match state {
        ChatCapabilityState::Available => "available",
        ChatCapabilityState::NeedsReconnect => "needs-reconnect",
        ChatCapabilityState::NotConnected => "not-connected",
        ChatCapabilityState::Unsupported => "unsupported",
    }
}

/// The OAuth scope each platform needs to READ live chat.
///
/// YouTube's `youtube.force-ssl` scope (already requested by Videorc) covers live chat
/// reads, so connected YouTube accounts are ready. Twitch needs `user:read:chat`, which is
/// added to the OAuth config in the Twitch connector slice — until an account is
/// reconnected with it, Twitch chat reports needs-reconnect.
pub const YOUTUBE_CHAT_SCOPE: &str = "https://www.googleapis.com/auth/youtube.force-ssl";
pub const TWITCH_CHAT_SCOPE: &str = "user:read:chat";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChatCapabilityState {
    /// A connected account holds the scope needed to read chat.
    Available,
    /// Connected, but the granted scopes are missing the chat-read scope — reconnect needed.
    NeedsReconnect,
    /// No connected account for this platform.
    NotConnected,
    /// No verified native chat-read path (X pending API access, Custom RTMP).
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatCapability {
    pub platform: StreamPlatform,
    pub state: ChatCapabilityState,
    /// True only when chat can actually be read right now.
    pub chat_read_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub message: String,
}

/// Capability to read live chat for one platform, given its connected account (if any).
pub fn chat_capability(
    platform: StreamPlatform,
    account: Option<&PlatformAccount>,
) -> ChatCapability {
    match platform {
        StreamPlatform::Youtube => scope_capability(
            platform,
            account,
            YOUTUBE_CHAT_SCOPE,
            "YouTube live comments are ready.",
            "Reconnect YouTube to enable live comments.",
            "Connect a YouTube account to read live comments.",
        ),
        StreamPlatform::Twitch => scope_capability(
            platform,
            account,
            TWITCH_CHAT_SCOPE,
            "Twitch live comments are ready.",
            "Reconnect Twitch to enable live comments.",
            "Connect a Twitch account to read live comments.",
        ),
        StreamPlatform::X => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            chat_read_available: false,
            required_scope: None,
            account_id: account.map(|account| account.account_id.clone()),
            account_label: account.map(|account| account.account_label.clone()),
            message: crate::x_chat::x_chat_message(account.is_some()).to_string(),
        },
        StreamPlatform::Custom => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            chat_read_available: false,
            required_scope: None,
            account_id: None,
            account_label: None,
            message: "Comments are not available for this destination yet.".to_string(),
        },
    }
}

fn scope_capability(
    platform: StreamPlatform,
    account: Option<&PlatformAccount>,
    required_scope: &str,
    available_message: &str,
    reconnect_message: &str,
    not_connected_message: &str,
) -> ChatCapability {
    match account {
        None => ChatCapability {
            platform,
            state: ChatCapabilityState::NotConnected,
            chat_read_available: false,
            required_scope: Some(required_scope.to_string()),
            account_id: None,
            account_label: None,
            message: not_connected_message.to_string(),
        },
        Some(account) => {
            let has_scope = account.scopes.iter().any(|scope| scope == required_scope);
            ChatCapability {
                platform,
                state: if has_scope {
                    ChatCapabilityState::Available
                } else {
                    ChatCapabilityState::NeedsReconnect
                },
                chat_read_available: has_scope,
                required_scope: Some(required_scope.to_string()),
                account_id: Some(account.account_id.clone()),
                account_label: Some(account.account_label.clone()),
                message: if has_scope {
                    available_message
                } else {
                    reconnect_message
                }
                .to_string(),
            }
        }
    }
}

/// Chat capability for every native platform (YouTube, Twitch, X), choosing the first
/// connected account per platform. Custom RTMP has no platform comments and is omitted.
pub fn chat_capabilities(accounts: &[PlatformAccount]) -> Vec<ChatCapability> {
    [
        StreamPlatform::Youtube,
        StreamPlatform::Twitch,
        StreamPlatform::X,
    ]
    .into_iter()
    .map(|platform| chat_capability(platform, accounts.iter().find(|a| a.platform == platform)))
    .collect()
}

// --- Live chat coordinator (slice 3) ---

/// Default cap on the in-memory message buffer for one active chat session.
pub const DEFAULT_MAX_CHAT_MESSAGES: usize = 5_000;

/// Shared, lockable handle to the live-chat coordinator owned by `AppState`.
pub type LiveChatSlot = Arc<tokio::sync::Mutex<LiveChatCoordinator>>;

/// Outcome of ingesting one message into the bounded, de-duplicated buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestOutcome {
    /// A new message was buffered (the caller should emit it to the renderer).
    New,
    /// The message id was already present and was skipped.
    Duplicate,
}

/// Point-in-time diagnostics for the active chat session (slice 9): per-provider connection
/// state + last error (carried on the provider rows) plus session counters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatDiagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub providers: Vec<LiveChatProviderState>,
    pub messages_received: u64,
    pub duplicates_skipped: u64,
    pub messages_trimmed: u64,
    pub reconnect_count: u64,
    pub buffered: u64,
    pub unread_count: u64,
}

/// Owns the active chat session's provider rows, a bounded + de-duplicated message buffer,
/// connector task handles, and lightweight diagnostics counters.
///
/// The coordinator is pure state: it never touches the websocket itself. The runtime
/// functions below lock it, mutate, drop the guard, and emit through `AppState`. Keeping
/// emission out of the coordinator makes the buffer/de-dup/lifecycle logic unit-testable
/// with no running backend.
pub struct LiveChatCoordinator {
    session_id: Option<String>,
    providers: Vec<LiveChatProviderState>,
    messages: VecDeque<LiveChatMessage>,
    /// Ids currently in `messages` — the de-duplication set, kept in lock-step with the
    /// buffer (trimming a message drops its id) so it stays bounded.
    seen: HashSet<String>,
    unread_count: u64,
    max_messages: usize,
    /// Diagnostics (surfaced in slice 9; counted from the start so the cap is testable now).
    trimmed_count: u64,
    duplicates_skipped: u64,
    messages_received: u64,
    reconnect_count: u64,
    /// Running connector tasks, aborted on stop/restart.
    tasks: Vec<JoinHandle<()>>,
}

impl Default for LiveChatCoordinator {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CHAT_MESSAGES)
    }
}

impl LiveChatCoordinator {
    pub fn new(max_messages: usize) -> Self {
        Self {
            session_id: None,
            providers: Vec::new(),
            messages: VecDeque::new(),
            seen: HashSet::new(),
            unread_count: 0,
            max_messages: max_messages.max(1),
            trimmed_count: 0,
            duplicates_skipped: 0,
            messages_received: 0,
            reconnect_count: 0,
            tasks: Vec::new(),
        }
    }

    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.session_id.is_some()
    }

    #[allow(dead_code)]
    pub fn trimmed_count(&self) -> u64 {
        self.trimmed_count
    }

    #[allow(dead_code)]
    pub fn duplicates_skipped(&self) -> u64 {
        self.duplicates_skipped
    }

    pub fn provider(&self, platform: StreamPlatform) -> Option<&LiveChatProviderState> {
        self.providers.iter().find(|p| p.platform == platform)
    }

    /// True once a session has been started (or left a transcript) — drives whether
    /// `current_status` returns the live view versus the setup-time capability snapshot.
    pub fn has_session_view(&self) -> bool {
        self.session_id.is_some() || !self.messages.is_empty() || !self.providers.is_empty()
    }

    /// Begin a chat session: abort any leftover tasks and reset the buffer/de-dup/counters,
    /// installing the provider rows for this session.
    pub fn start_session(&mut self, session_id: String, providers: Vec<LiveChatProviderState>) {
        self.abort_tasks();
        self.session_id = Some(session_id);
        self.providers = providers;
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
        self.trimmed_count = 0;
        self.duplicates_skipped = 0;
        self.messages_received = 0;
        self.reconnect_count = 0;
    }

    /// Abort connector tasks and mark every connected provider `ended`. The transcript is
    /// retained so the app can keep showing it until the local view is cleared.
    pub fn stop_session(&mut self) {
        self.abort_tasks();
        for provider in &mut self.providers {
            if provider.state != LiveChatProviderConnectionState::Unsupported {
                provider.state = LiveChatProviderConnectionState::Ended;
            }
        }
        self.session_id = None;
    }

    /// Clear the local message view (buffer + unread) without touching providers, the
    /// session, or platform-side messages — the `liveChat.clearLocal` semantics.
    pub fn clear_local(&mut self) {
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
    }

    /// Buffer one message, skipping duplicates by id and trimming the oldest when the cap is
    /// exceeded. Returns whether the message was new.
    pub fn ingest(&mut self, message: LiveChatMessage) -> IngestOutcome {
        if self.seen.contains(&message.id) {
            self.duplicates_skipped += 1;
            return IngestOutcome::Duplicate;
        }
        if let Some(provider) = self
            .providers
            .iter_mut()
            .find(|p| p.platform == message.platform)
        {
            provider.last_message_at = Some(message.received_at.clone());
        }
        self.seen.insert(message.id.clone());
        self.messages.push_back(message);
        self.unread_count += 1;
        self.messages_received += 1;
        while self.messages.len() > self.max_messages {
            match self.messages.pop_front() {
                Some(trimmed) => {
                    self.seen.remove(&trimmed.id);
                    self.trimmed_count += 1;
                }
                None => break,
            }
        }
        IngestOutcome::New
    }

    /// Update one provider's connection state + message (e.g. connecting → connected → ended).
    pub fn set_provider_status(
        &mut self,
        platform: StreamPlatform,
        connection: LiveChatProviderConnectionState,
        message: &str,
        now: &str,
    ) {
        if connection == LiveChatProviderConnectionState::Reconnecting {
            self.reconnect_count += 1;
        }
        if let Some(provider) = self.providers.iter_mut().find(|p| p.platform == platform) {
            provider.state = connection;
            provider.message = message.to_string();
            match connection {
                LiveChatProviderConnectionState::Connected => {
                    provider.last_connected_at = Some(now.to_string());
                    provider.last_error = None;
                }
                LiveChatProviderConnectionState::Failed
                | LiveChatProviderConnectionState::Reconnecting => {
                    provider.last_error = Some(message.to_string());
                }
                _ => {}
            }
        }
    }

    pub fn attach_task(&mut self, task: JoinHandle<()>) {
        self.tasks.push(task);
    }

    fn abort_tasks(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }

    pub fn snapshot(&self, updated_at: String) -> LiveChatSnapshot {
        LiveChatSnapshot {
            session_id: self.session_id.clone(),
            providers: self.providers.clone(),
            messages: self.messages.iter().cloned().collect(),
            unread_count: self.unread_count,
            updated_at,
        }
    }

    pub fn diagnostics(&self) -> LiveChatDiagnostics {
        LiveChatDiagnostics {
            session_id: self.session_id.clone(),
            providers: self.providers.clone(),
            messages_received: self.messages_received,
            duplicates_skipped: self.duplicates_skipped,
            messages_trimmed: self.trimmed_count,
            reconnect_count: self.reconnect_count,
            buffered: self.messages.len() as u64,
            unread_count: self.unread_count,
        }
    }
}

/// Provider rows for a starting session, derived from current chat capabilities. The
/// connectors (slices 4-5) drive each row to connecting → connected/failed; platforms with
/// no native path stay `unsupported`.
fn session_provider_rows(accounts: &[PlatformAccount]) -> Vec<LiveChatProviderState> {
    chat_capabilities(accounts)
        .into_iter()
        .map(provider_state_from_capability)
        .collect()
}

/// Parameters for `liveChat.start`. Real connectors arrive in slices 4-5; until then a
/// `fake` connector exercises the buffer + event path for tests and the live-chat smoke.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatStartParams {
    pub session_id: String,
    #[serde(default)]
    pub fake: Option<FakeChatConfig>,
    #[serde(default)]
    pub youtube: Option<crate::youtube_chat::YouTubeChatConfig>,
    #[serde(default)]
    pub twitch: Option<crate::twitch_chat::TwitchChatConfig>,
}

/// A deterministic, bounded fake chat source for tests / `smoke:live-chat-fake-providers`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChatConfig {
    #[serde(default = "default_fake_platform")]
    pub platform: StreamPlatform,
    #[serde(default = "default_fake_count")]
    pub count: u32,
    #[serde(default = "default_fake_interval_ms")]
    pub interval_ms: u64,
    /// Re-send the first message once to prove de-duplication skips it.
    #[serde(default)]
    pub include_duplicate: bool,
}

fn default_fake_platform() -> StreamPlatform {
    StreamPlatform::Youtube
}

fn default_fake_count() -> u32 {
    5
}

fn default_fake_interval_ms() -> u64 {
    200
}

/// Start a chat session: install provider rows, optionally spawn the fake connector, and
/// emit the initial snapshot. Returns the snapshot for the command response.
pub async fn start_live_chat(state: &AppState, params: LiveChatStartParams) -> LiveChatSnapshot {
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let providers = session_provider_rows(&accounts);
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(params.session_id.clone(), providers);
    }
    if let Some(fake) = params.fake.clone() {
        let handle = tokio::spawn(run_fake_connector(
            state.clone(),
            params.session_id.clone(),
            fake,
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }
    if let Some(youtube) = params.youtube.clone() {
        let handle = tokio::spawn(crate::youtube_chat::run_youtube_chat_connector(
            state.clone(),
            params.session_id.clone(),
            youtube,
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }
    if let Some(twitch) = params.twitch.clone() {
        let handle = tokio::spawn(crate::twitch_chat::run_twitch_chat_connector(
            state.clone(),
            params.session_id.clone(),
            twitch,
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    snapshot
}

/// Stop the active chat session, aborting connectors and marking providers ended.
pub async fn stop_live_chat(state: &AppState) -> LiveChatSnapshot {
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.stop_session();
    }
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    snapshot
}

/// Clear the local message view (not platform messages) and emit `liveChat.cleared`.
pub async fn clear_local_live_chat(state: &AppState) -> LiveChatSnapshot {
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.clear_local();
    }
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.cleared", snapshot.clone());
    snapshot
}

/// Current status: the live coordinator view when a session is active or has a transcript,
/// otherwise the setup-time capability snapshot.
pub async fn current_status(state: &AppState) -> LiveChatSnapshot {
    let now = chrono::Utc::now().to_rfc3339();
    let live_view = {
        let coordinator = state.live_chat.lock().await;
        if coordinator.has_session_view() {
            Some(coordinator.snapshot(now.clone()))
        } else {
            None
        }
    };
    if let Some(snapshot) = live_view {
        return snapshot;
    }
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    initial_chat_snapshot(&accounts, now)
}

/// Current live-chat diagnostics for the `liveChat.diagnostics` command.
pub async fn current_diagnostics(state: &AppState) -> LiveChatDiagnostics {
    state.live_chat.lock().await.diagnostics()
}

/// Lock the coordinator, ingest one message, and emit it to the renderer if it was new.
pub(crate) async fn deliver_message(state: &AppState, message: LiveChatMessage) {
    let outcome = {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.ingest(message.clone())
    };
    if outcome == IngestOutcome::New {
        if let Err(error) = state.database.save_live_chat_message(&message) {
            state.emit_log(
                "warn",
                format!(
                    "Could not persist live chat message {}: {error}",
                    message.id
                ),
            );
        }
        state.emit_event("liveChat.message", message);
    }
}

/// Set a provider's connection state and emit `liveChat.providerStatus`.
pub(crate) async fn set_provider_and_emit(
    state: &AppState,
    platform: StreamPlatform,
    connection: LiveChatProviderConnectionState,
    message: &str,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let provider = {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.set_provider_status(platform, connection, message, &now);
        coordinator.provider(platform).cloned()
    };
    if let Some(provider) = provider {
        state.emit_event("liveChat.providerStatus", provider);
    }
}

/// The fake connector task: marks its platform connected, delivers `count` messages at
/// `interval_ms`, optionally re-sending the first to exercise de-dup, then marks ended.
async fn run_fake_connector(state: AppState, session_id: String, config: FakeChatConfig) {
    let platform = config.platform;
    set_provider_and_emit(
        &state,
        platform,
        LiveChatProviderConnectionState::Connected,
        "Live chat connected.",
    )
    .await;
    let interval = Duration::from_millis(config.interval_ms.max(1));
    for seq in 0..config.count {
        sleep(interval).await;
        deliver_message(&state, fake_message(&session_id, platform, seq)).await;
        if config.include_duplicate && seq == 0 {
            deliver_message(&state, fake_message(&session_id, platform, 0)).await;
        }
    }
    set_provider_and_emit(
        &state,
        platform,
        LiveChatProviderConnectionState::Ended,
        "Live chat ended.",
    )
    .await;
}

/// Build one deterministic fake message. Shared by the fake connector and the unit tests.
fn fake_message(session_id: &str, platform: StreamPlatform, seq: u32) -> LiveChatMessage {
    let now = chrono::Utc::now().to_rfc3339();
    let provider_message_id = format!("fake-{seq}");
    LiveChatMessage {
        id: live_chat_message_id(platform, &provider_message_id),
        provider_message_id,
        platform,
        target_id: None,
        session_id: session_id.to_string(),
        author_id: Some(format!("fake-author-{}", seq % 3)),
        author_name: format!("Test Viewer {}", seq % 3),
        author_avatar_url: None,
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at: now.clone(),
        received_at: now,
        message_text: format!("Fake chat message #{seq}"),
        fragments: Vec::new(),
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: Some("fake".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::PlatformAccountStatus;

    fn account(platform: StreamPlatform, scopes: &[&str]) -> PlatformAccount {
        PlatformAccount {
            id: "acct".to_string(),
            platform,
            account_id: "channel-1".to_string(),
            account_label: "Test Channel".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            access_token_present: true,
            refresh_token_present: true,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-06T00:00:00Z".to_string(),
            updated_at: "2026-06-06T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        }
    }

    fn provider_row(platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            platform,
            target_id: None,
            account_id: None,
            account_label: None,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting…".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn diagnostics_report_counters_and_provider_errors() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, 0));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, 1));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, 0)); // duplicate
        coordinator.set_provider_status(
            StreamPlatform::Youtube,
            LiveChatProviderConnectionState::Reconnecting,
            "Reconnecting…",
            "now",
        );
        let diagnostics = coordinator.diagnostics();
        assert_eq!(diagnostics.messages_received, 2);
        assert_eq!(diagnostics.duplicates_skipped, 1);
        assert_eq!(diagnostics.reconnect_count, 1);
        assert_eq!(diagnostics.buffered, 2);
        assert_eq!(
            diagnostics.providers[0].last_error.as_deref(),
            Some("Reconnecting…")
        );
    }

    #[test]
    fn coordinator_caps_buffer_and_reports_trimmed_count() {
        let mut coordinator = LiveChatCoordinator::new(3);
        for seq in 0..5 {
            assert_eq!(
                coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, seq)),
                IngestOutcome::New
            );
        }
        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(coordinator.trimmed_count(), 2);
        // The two oldest were trimmed; the buffer keeps seq 2, 3, 4 in order.
        assert_eq!(
            snapshot.messages.first().unwrap().provider_message_id,
            "fake-2"
        );
        assert_eq!(
            snapshot.messages.last().unwrap().provider_message_id,
            "fake-4"
        );
    }

    #[test]
    fn coordinator_skips_duplicate_message_ids() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let message = fake_message("s1", StreamPlatform::Youtube, 0);
        assert_eq!(coordinator.ingest(message.clone()), IngestOutcome::New);
        assert_eq!(coordinator.ingest(message), IngestOutcome::Duplicate);
        assert_eq!(coordinator.duplicates_skipped(), 1);
        assert_eq!(coordinator.snapshot("now".to_string()).messages.len(), 1);
    }

    #[test]
    fn clear_local_empties_view_but_keeps_session_active() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, 0));
        coordinator.clear_local();
        let snapshot = coordinator.snapshot("now".to_string());
        assert!(coordinator.is_active());
        assert_eq!(snapshot.session_id.as_deref(), Some("s1"));
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.unread_count, 0);
        assert_eq!(snapshot.providers.len(), 1);
    }

    #[test]
    fn stop_session_marks_providers_ended_and_keeps_transcript() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, 0));
        coordinator.stop_session();
        let snapshot = coordinator.snapshot("now".to_string());
        assert!(!coordinator.is_active());
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Ended
        );
        assert_eq!(snapshot.messages.len(), 1);

        coordinator.clear_local();
        assert!(
            coordinator
                .snapshot("later".to_string())
                .messages
                .is_empty()
        );
    }

    #[test]
    fn youtube_force_ssl_account_can_read_chat() {
        let account = account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE]);
        let capability = chat_capability(StreamPlatform::Youtube, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::Available);
        assert!(capability.chat_read_available);
    }

    #[test]
    fn twitch_without_user_read_chat_needs_reconnect() {
        // The current real Twitch scope set lacks user:read:chat until the account reconnects.
        let account = account(
            StreamPlatform::Twitch,
            &["channel:manage:broadcast", "channel:read:stream_key"],
        );
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert!(!capability.chat_read_available);
        assert!(capability.message.contains("Reconnect Twitch"));
    }

    #[test]
    fn twitch_with_user_read_chat_is_available() {
        let account = account(StreamPlatform::Twitch, &[TWITCH_CHAT_SCOPE]);
        assert_eq!(
            chat_capability(StreamPlatform::Twitch, Some(&account)).state,
            ChatCapabilityState::Available
        );
    }

    #[test]
    fn x_is_unsupported_and_custom_has_no_comments() {
        assert_eq!(
            chat_capability(StreamPlatform::X, None).state,
            ChatCapabilityState::Unsupported
        );
        assert_eq!(
            chat_capability(StreamPlatform::Custom, None).state,
            ChatCapabilityState::Unsupported
        );
    }

    #[test]
    fn missing_account_reports_not_connected() {
        assert_eq!(
            chat_capability(StreamPlatform::Youtube, None).state,
            ChatCapabilityState::NotConnected
        );
    }

    #[test]
    fn capabilities_cover_every_native_platform() {
        let accounts = vec![account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE])];
        let capabilities = chat_capabilities(&accounts);
        assert_eq!(capabilities.len(), 3);
        assert_eq!(capabilities[0].platform, StreamPlatform::Youtube);
        assert_eq!(capabilities[0].state, ChatCapabilityState::Available);
        assert_eq!(capabilities[1].platform, StreamPlatform::Twitch);
        assert_eq!(capabilities[1].state, ChatCapabilityState::NotConnected);
        assert_eq!(capabilities[2].platform, StreamPlatform::X);
        assert_eq!(capabilities[2].state, ChatCapabilityState::Unsupported);
    }

    #[test]
    fn live_chat_message_round_trips_with_camel_case_and_kebab_event_type() {
        let message = LiveChatMessage {
            id: live_chat_message_id(StreamPlatform::Youtube, "abc123"),
            provider_message_id: "abc123".to_string(),
            platform: StreamPlatform::Youtube,
            target_id: Some("target-1".to_string()),
            session_id: "session-1".to_string(),
            author_id: Some("author-1".to_string()),
            author_name: "Viewer".to_string(),
            author_avatar_url: None,
            author_badges: vec!["moderator".to_string()],
            author_roles: Vec::new(),
            published_at: "2026-06-06T00:00:00Z".to_string(),
            received_at: "2026-06-06T00:00:01Z".to_string(),
            message_text: "hello".to_string(),
            fragments: vec![LiveChatMessageFragment {
                fragment_type: "text".to_string(),
                text: "hello".to_string(),
                image_url: None,
            }],
            event_type: LiveChatEventType::Paid,
            amount_text: Some("$5.00".to_string()),
            is_deleted: false,
            raw_provider_type: Some("superChatEvent".to_string()),
        };
        assert_eq!(message.id, "youtube:abc123");
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["providerMessageId"], "abc123");
        assert_eq!(json["eventType"], "paid");
        assert_eq!(json["platform"], "youtube");
        assert_eq!(json["fragments"][0]["type"], "text");
        let parsed: LiveChatMessage = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, message);
    }

    #[test]
    fn initial_snapshot_maps_capabilities_to_provider_rows() {
        let accounts = vec![account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE])];
        let snapshot = initial_chat_snapshot(&accounts, "now".to_string());
        assert_eq!(snapshot.providers.len(), 3);
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.providers[0].platform, StreamPlatform::Youtube);
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Disabled
        );
        assert_eq!(
            snapshot.providers[0].capabilities,
            vec!["available".to_string()]
        );
        assert_eq!(
            snapshot.providers[2].state,
            LiveChatProviderConnectionState::Unsupported
        );
    }
}
