//! In-app live chat — capability + scope audit (Slice 1 of the In-App Livestream Comments
//! plan: `2026-06-06 - Videorc In-App Livestream Comments Plan`). Reports, per streaming
//! platform, whether the connected account can read live chat, needs to reconnect for a
//! missing scope, or has no verified native chat path. The `LiveChatCoordinator` and the
//! per-platform connectors arrive in later slices; this is the capability the Studio UI
//! uses to warn the streamer before they go live.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep, timeout};

use crate::live_chat_persistence::LiveChatPersistenceFailure;
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

/// Read capability for one concrete stream destination. This is intentionally
/// separate from the connector lifecycle above: a target can be readable while
/// writes are unavailable (X), or writable only after an OAuth scope refresh.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsReadState {
    Connecting,
    Ready,
    WaitingForBroadcastContext,
    Ended,
    Failed,
    Unavailable,
}

/// Write capability for one concrete stream destination.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsWriteState {
    Ready,
    MissingScope,
    ReadOnly,
    Failed,
    Unavailable,
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
    /// Stable destination identity. Never use platform alone as a registry key.
    pub id: String,
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub read: CommentsReadState,
    pub write: CommentsWriteState,
    pub state: LiveChatProviderConnectionState,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
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

/// The stable app id for a message. Provider ids are not globally unique, so
/// session and destination identity are part of the persisted de-dup key.
#[allow(dead_code)]
pub fn live_chat_message_id(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
    provider_message_id: &str,
) -> String {
    format!(
        "{}:{}:{}:{}",
        session_id,
        stream_platform_id(platform),
        target_id.unwrap_or("default"),
        provider_message_id
    )
}

fn comments_destination_id(platform: StreamPlatform, target_id: Option<&str>) -> String {
    target_id
        .map(str::to_string)
        .unwrap_or_else(|| stream_platform_id(platform).to_string())
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
        id: comments_destination_id(capability.platform, None),
        platform: capability.platform,
        target_id: None,
        account_id: capability.account_id,
        account_label: capability.account_label,
        read: capability.read,
        write: capability.write,
        state,
        message: capability.message,
        last_connected_at: None,
        last_message_at: None,
        last_error: None,
    }
}

/// The OAuth scope each platform needs to READ live chat.
///
/// YouTube's chat-read path is paused with YouTube OAuth until Google approval
/// completes. Twitch needs `user:read:chat`, which is added to the OAuth config
/// in the Twitch connector slice — until an account is reconnected with it,
/// Twitch chat reports needs-reconnect.
pub const YOUTUBE_CHAT_SCOPE: &str = "https://www.googleapis.com/auth/youtube.force-ssl";
pub const TWITCH_CHAT_SCOPE: &str = "user:read:chat";
pub const TWITCH_CHAT_WRITE_SCOPE: &str = "user:write:chat";

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
    pub read: CommentsReadState,
    pub write: CommentsWriteState,
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
        StreamPlatform::Youtube => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
            chat_read_available: false,
            required_scope: Some(YOUTUBE_CHAT_SCOPE.to_string()),
            account_id: account.map(|account| account.account_id.clone()),
            account_label: account.map(|account| account.account_label.clone()),
            message: crate::oauth::YOUTUBE_OAUTH_UNAVAILABLE_MESSAGE.to_string(),
        },
        StreamPlatform::Twitch => {
            let mut capability = scope_capability(
                platform,
                account,
                TWITCH_CHAT_SCOPE,
                "Twitch live comments are ready.",
                "Reconnect Twitch to enable live comments.",
                "Connect Twitch to read live comments.",
            );
            capability.write = match account {
                Some(account)
                    if account.status == crate::streaming::PlatformAccountStatus::Connected
                        && account
                            .scopes
                            .iter()
                            .any(|scope| scope == TWITCH_CHAT_WRITE_SCOPE) =>
                {
                    CommentsWriteState::Ready
                }
                Some(_) => CommentsWriteState::MissingScope,
                None => CommentsWriteState::Unavailable,
            };
            capability
        }
        StreamPlatform::X => {
            let x_live_ready = account.is_some_and(|account| {
                account.status == crate::streaming::PlatformAccountStatus::Connected
            }) && crate::x_live::x_livestream_credentials()
                .ok()
                .flatten()
                .is_some();
            ChatCapability {
                platform,
                state: if x_live_ready {
                    ChatCapabilityState::Available
                } else {
                    ChatCapabilityState::NotConnected
                },
                chat_read_available: x_live_ready,
                read: if x_live_ready {
                    CommentsReadState::Ready
                } else {
                    CommentsReadState::Unavailable
                },
                write: CommentsWriteState::ReadOnly,
                required_scope: None,
                account_id: account.map(|account| account.account_id.clone()),
                account_label: account.map(|account| account.account_label.clone()),
                message: crate::x_chat::x_chat_message(x_live_ready).to_string(),
            }
        }
        StreamPlatform::Custom => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
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
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
            chat_read_available: false,
            required_scope: Some(required_scope.to_string()),
            account_id: None,
            account_label: None,
            message: not_connected_message.to_string(),
        },
        Some(account) if account.status != crate::streaming::PlatformAccountStatus::Connected => {
            ChatCapability {
                platform,
                state: ChatCapabilityState::NeedsReconnect,
                read: CommentsReadState::Unavailable,
                write: CommentsWriteState::MissingScope,
                chat_read_available: false,
                required_scope: Some(required_scope.to_string()),
                account_id: Some(account.account_id.clone()),
                account_label: Some(account.account_label.clone()),
                message: reconnect_message.to_string(),
            }
        }
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
                read: if has_scope {
                    CommentsReadState::Ready
                } else {
                    CommentsReadState::Unavailable
                },
                write: CommentsWriteState::Unavailable,
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

/// Chat capability for every native platform (YouTube, Twitch, X), preferring a connected
/// account over stale saved rows. Custom RTMP has no platform comments and is omitted.
pub fn chat_capabilities(accounts: &[PlatformAccount]) -> Vec<ChatCapability> {
    [
        StreamPlatform::Youtube,
        StreamPlatform::Twitch,
        StreamPlatform::X,
    ]
    .into_iter()
    .map(|platform| {
        let account = accounts
            .iter()
            .find(|account| {
                account.platform == platform
                    && account.status == crate::streaming::PlatformAccountStatus::Connected
            })
            .or_else(|| accounts.iter().find(|account| account.platform == platform));
        chat_capability(platform, account)
    })
    .collect()
}

// --- Live chat coordinator (slice 3) ---

/// Default cap on the in-memory message buffer for one active chat session.
pub const DEFAULT_MAX_CHAT_MESSAGES: usize = 5_000;

/// Shared, lockable handle to the live-chat coordinator owned by `AppState`.
pub type LiveChatSlot = Arc<tokio::sync::Mutex<LiveChatCoordinator>>;

/// Outcome of ingesting one message into the bounded, de-duplicated buffer.
///
/// New and updated outcomes carry the authoritative buffered value so callers
/// can persist and emit it without scanning the full message deque again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    /// A new message was buffered (the caller should emit it to the renderer).
    New(LiveChatMessage),
    /// An existing message was replaced by a provider tombstone.
    Updated(LiveChatMessage),
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
/// Per-platform send credentials, captured at `liveChat.start` and dropped at
/// stop (Comments upgrade S4). YouTube's live chat id is resolved later by
/// its connector and filled in via `set_youtube_send_chat_id`.
#[derive(Debug, Clone)]
pub enum ChatSenderConfig {
    YouTube {
        access_token: String,
        api_base_url: Option<String>,
        live_chat_id: Option<String>,
    },
    Twitch(crate::twitch_chat::TwitchChatSenderConfig),
    Fake(FakeChatSendBehavior),
    #[cfg(test)]
    FakeProbe {
        behavior: FakeChatSendBehavior,
        probe: Arc<FakeSendProbe>,
        delay: Duration,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsSendParams {
    pub operation_id: String,
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsSendOperationPhase {
    Sending,
    Sent,
    Partial,
    Failed,
    DeliveryUnknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationDeliveryPhase {
    Pending,
    Sent,
    Failed,
    ReadOnly,
    Unavailable,
    TimedOutUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationDelivery {
    pub destination_id: String,
    pub platform: StreamPlatform,
    pub phase: DestinationDeliveryPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentsSendOperation {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub phase: CommentsSendOperationPhase,
    pub destinations: Vec<DestinationDelivery>,
    pub created_at: String,
    pub updated_at: String,
}

type SendOperationResult = Result<CommentsSendOperation, String>;
type SendOperationReceiver = tokio::sync::watch::Receiver<Option<SendOperationResult>>;

struct InFlightSendOperation {
    session_id: String,
    text: String,
    result: SendOperationReceiver,
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct FakeSendProbe {
    calls: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
}

#[cfg(test)]
impl FakeSendProbe {
    fn begin(self: &Arc<Self>) -> FakeSendProbeGuard {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        FakeSendProbeGuard(self.clone())
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn max_active(&self) -> usize {
        self.max_active.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
struct FakeSendProbeGuard(Arc<FakeSendProbe>);

#[cfg(test)]
impl Drop for FakeSendProbeGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl CommentsSendOperation {
    /// Crash recovery is deliberately non-retrying: a provider may have
    /// accepted an interrupted request even though Videorc never saw the ack.
    pub fn mark_interrupted_unknown(&mut self, now: String) {
        for delivery in &mut self.destinations {
            if delivery.phase == DestinationDeliveryPhase::Pending {
                delivery.phase = DestinationDeliveryPhase::TimedOutUnknown;
                delivery.reason = Some("interrupted-before-confirmation".to_string());
            }
        }
        self.phase = aggregate_send_phase(&self.destinations);
        self.updated_at = now;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSendReceipt {
    pub provider_message_id: Option<String>,
}

pub struct LiveChatCoordinator {
    session_id: Option<String>,
    /// Monotonic lifecycle ticket. Provider deliveries capture it before
    /// persistence and must still own it before emitting into the renderer.
    generation: u64,
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
    /// Send credentials per concrete destination; session-scoped.
    senders: HashMap<String, ChatSenderConfig>,
    /// Same-id callers subscribe to one backend-owned operation task. The receiver is
    /// removed after terminal persistence; SQLite remains the durable idempotency
    /// authority afterward.
    send_operations_in_flight: HashMap<String, InFlightSendOperation>,
}

struct ReversibleIngest {
    outcome: IngestOutcome,
    undo: LiveChatIngestUndo,
}

/// Constant-size undo data for one coordinator ingest. A delivery failure must
/// never clone the complete (normally 5,000-row) transcript merely to make one
/// provider message retryable.
enum LiveChatIngestUndo {
    Duplicate {
        previous_duplicates_skipped: u64,
    },
    Updated {
        index: usize,
        previous: Box<LiveChatMessage>,
        applied: Box<LiveChatMessage>,
    },
    New {
        inserted_id: String,
        inserted_received_at: String,
        trimmed: Option<Box<LiveChatMessage>>,
        provider_update: Option<(usize, Option<String>)>,
        previous_unread_count: u64,
        previous_trimmed_count: u64,
        previous_messages_received: u64,
    },
}

#[cfg(test)]
impl LiveChatIngestUndo {
    /// Regression metric for rollback space complexity. This count is bounded by
    /// the one ingest being reversed, never by the transcript capacity.
    fn retained_buffer_rows(&self) -> usize {
        match self {
            Self::Duplicate { .. } => 0,
            Self::Updated { .. } => 2,
            Self::New { trimmed, .. } => usize::from(trimmed.is_some()),
        }
    }
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
            generation: 0,
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
            senders: HashMap::new(),
            send_operations_in_flight: HashMap::new(),
        }
    }

    pub fn register_sender(&mut self, destination_id: String, sender: ChatSenderConfig) {
        self.senders.insert(destination_id, sender);
    }

    pub fn sender(&self, destination_id: &str) -> Option<ChatSenderConfig> {
        self.senders.get(destination_id).cloned()
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

    pub fn ensure_provider(&mut self, provider: LiveChatProviderState) {
        match self
            .providers
            .iter_mut()
            .find(|existing| existing.id == provider.id)
        {
            Some(existing) => {
                existing.target_id = provider.target_id;
                existing.account_id = provider.account_id;
                existing.account_label = provider.account_label;
                existing.read = provider.read;
                existing.write = provider.write;
            }
            None => self.providers.push(provider),
        }
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
        self.generation = self.generation.wrapping_add(1);
        self.session_id = Some(session_id);
        self.providers = providers;
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
        self.trimmed_count = 0;
        self.duplicates_skipped = 0;
        self.messages_received = 0;
        self.reconnect_count = 0;
        self.senders.clear();
    }

    /// Abort connector tasks and mark every connected provider `ended`. The transcript is
    /// retained so the app can keep showing it until the local view is cleared.
    pub fn stop_session(&mut self) {
        self.abort_tasks();
        self.generation = self.generation.wrapping_add(1);
        for provider in &mut self.providers {
            if provider.state != LiveChatProviderConnectionState::Unsupported {
                provider.state = LiveChatProviderConnectionState::Ended;
            }
        }
        self.session_id = None;
        self.senders.clear();
    }

    /// Clear the local message view (buffer + unread) without touching providers, the
    /// session, or platform-side messages — the `liveChat.clearLocal` semantics.
    pub fn clear_local(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
    }

    /// Buffer one message, or replace an existing row with a provider deletion tombstone.
    /// A tombstone always wins over the original, including when it arrives first.
    #[allow(dead_code)]
    pub fn ingest(&mut self, message: LiveChatMessage) -> IngestOutcome {
        self.ingest_reversible(message).outcome
    }

    fn ingest_reversible(&mut self, mut message: LiveChatMessage) -> ReversibleIngest {
        if self.seen.contains(&message.id) {
            if let Some(index) = self
                .messages
                .iter()
                .position(|existing| existing.id == message.id)
                && message.is_deleted
                && !self.messages[index].is_deleted
            {
                let existing = &mut self.messages[index];
                let previous = existing.clone();
                // Keep the original row's identity and chronological position, but
                // discard its provider-visible content. The deletion event supplies
                // the safe replacement text and raw event type.
                message.author_id = existing.author_id.clone();
                message.author_name = existing.author_name.clone();
                message.author_avatar_url = existing.author_avatar_url.clone();
                message.author_badges = existing.author_badges.clone();
                message.author_roles = existing.author_roles.clone();
                message.published_at = existing.published_at.clone();
                message.received_at = existing.received_at.clone();
                message.fragments.clear();
                message.amount_text = None;
                *existing = message.clone();
                return ReversibleIngest {
                    outcome: IngestOutcome::Updated(message.clone()),
                    undo: LiveChatIngestUndo::Updated {
                        index,
                        previous: Box::new(previous),
                        applied: Box::new(message),
                    },
                };
            }
            let previous_duplicates_skipped = self.duplicates_skipped;
            self.duplicates_skipped += 1;
            return ReversibleIngest {
                outcome: IngestOutcome::Duplicate,
                undo: LiveChatIngestUndo::Duplicate {
                    previous_duplicates_skipped,
                },
            };
        }
        let provider_update = self.providers.iter().position(|provider| {
            provider.platform == message.platform
                && provider.target_id.as_deref() == message.target_id.as_deref()
        });
        let provider_update = provider_update.map(|index| {
            let previous = self.providers[index].last_message_at.clone();
            self.providers[index].last_message_at = Some(message.received_at.clone());
            (index, previous)
        });
        let previous_unread_count = self.unread_count;
        let previous_trimmed_count = self.trimmed_count;
        let previous_messages_received = self.messages_received;
        let inserted_id = message.id.clone();
        let inserted_received_at = message.received_at.clone();
        self.seen.insert(inserted_id.clone());
        self.messages.push_back(message.clone());
        self.unread_count += 1;
        self.messages_received += 1;
        debug_assert!(self.messages.len() <= self.max_messages + 1);
        let trimmed = if self.messages.len() > self.max_messages {
            self.messages
                .pop_front()
                .inspect(|trimmed| {
                    self.seen.remove(&trimmed.id);
                    self.trimmed_count += 1;
                })
                .map(Box::new)
        } else {
            None
        };
        ReversibleIngest {
            outcome: IngestOutcome::New(message),
            undo: LiveChatIngestUndo::New {
                inserted_id,
                inserted_received_at,
                trimmed,
                provider_update,
                previous_unread_count,
                previous_trimmed_count,
                previous_messages_received,
            },
        }
    }

    fn rollback_ingest(&mut self, undo: LiveChatIngestUndo) {
        match undo {
            LiveChatIngestUndo::Duplicate {
                previous_duplicates_skipped,
            } => {
                if self.duplicates_skipped == previous_duplicates_skipped.saturating_add(1) {
                    self.duplicates_skipped = previous_duplicates_skipped;
                }
            }
            LiveChatIngestUndo::Updated {
                index,
                previous,
                applied,
            } => {
                if self.messages.get(index) == Some(applied.as_ref())
                    && let Some(message) = self.messages.get_mut(index)
                {
                    *message = *previous;
                }
            }
            LiveChatIngestUndo::New {
                inserted_id,
                inserted_received_at,
                trimmed,
                provider_update,
                previous_unread_count,
                previous_trimmed_count,
                previous_messages_received,
            } => {
                if self
                    .messages
                    .back()
                    .map(|message| (message.id.as_str(), message.received_at.as_str()))
                    != Some((inserted_id.as_str(), inserted_received_at.as_str()))
                {
                    // A lifecycle operation replaced the transcript while persistence
                    // was pending. Do not mutate that newer session to restore old data.
                    return;
                }
                self.messages.pop_back();
                self.seen.remove(&inserted_id);
                if let Some(trimmed) = trimmed {
                    self.seen.insert(trimmed.id.clone());
                    self.messages.push_front(*trimmed);
                }
                self.unread_count = previous_unread_count;
                self.trimmed_count = previous_trimmed_count;
                self.messages_received = previous_messages_received;
                if let Some((index, previous)) = provider_update
                    && self
                        .providers
                        .get(index)
                        .and_then(|provider| provider.last_message_at.as_deref())
                        == Some(inserted_received_at.as_str())
                    && let Some(provider) = self.providers.get_mut(index)
                {
                    provider.last_message_at = previous;
                }
            }
        }
    }

    /// Update one provider's connection state + message (e.g. connecting → connected → ended).
    pub fn set_provider_status(
        &mut self,
        platform: StreamPlatform,
        target_id: Option<&str>,
        connection: LiveChatProviderConnectionState,
        message: &str,
        now: &str,
    ) {
        if connection == LiveChatProviderConnectionState::Reconnecting {
            self.reconnect_count += 1;
        }
        if let Some(provider) = self.providers.iter_mut().find(|provider| {
            provider.platform == platform
                && target_id
                    .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                    .unwrap_or(true)
        }) {
            provider.state = connection;
            provider.message = message.to_string();
            provider.read = match connection {
                LiveChatProviderConnectionState::Connecting
                | LiveChatProviderConnectionState::Reconnecting => CommentsReadState::Connecting,
                LiveChatProviderConnectionState::Connected => CommentsReadState::Ready,
                LiveChatProviderConnectionState::Waiting => {
                    CommentsReadState::WaitingForBroadcastContext
                }
                LiveChatProviderConnectionState::Ended => CommentsReadState::Ended,
                LiveChatProviderConnectionState::Failed => CommentsReadState::Failed,
                LiveChatProviderConnectionState::Disabled
                | LiveChatProviderConnectionState::Unsupported => CommentsReadState::Unavailable,
            };
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
        let mut messages: Vec<_> = self.messages.iter().cloned().collect();
        messages.sort_by(|left, right| {
            left.received_at
                .cmp(&right.received_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        LiveChatSnapshot {
            session_id: self.session_id.clone(),
            providers: self.providers.clone(),
            messages,
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
fn session_provider_rows(
    accounts: &[PlatformAccount],
    platforms: &[StreamPlatform],
    destinations: &[LiveChatDestinationStart],
) -> Vec<LiveChatProviderState> {
    if !destinations.is_empty() {
        return destinations
            .iter()
            .map(|destination| {
                let capability = chat_capability(
                    destination.platform,
                    accounts
                        .iter()
                        .find(|account| account.platform == destination.platform),
                );
                let mut provider = provider_state_from_capability(capability);
                provider.id = destination.target_id.clone();
                provider.target_id = Some(destination.target_id.clone());
                if let Some(read) = destination.read {
                    provider.read = read;
                }
                if let Some(write) = destination.write {
                    provider.write = write;
                }
                if let Some(error) = destination.preparation_error.as_deref() {
                    provider.state = LiveChatProviderConnectionState::Failed;
                    if destination.read.is_none() && provider.read != CommentsReadState::Unavailable
                    {
                        provider.read = CommentsReadState::Failed;
                    }
                    if destination.write.is_none() && provider.write == CommentsWriteState::Ready {
                        provider.write = CommentsWriteState::Failed;
                    }
                    provider.message = error.to_string();
                    provider.last_error = Some(error.to_string());
                }
                provider
            })
            .collect();
    }
    let requested: HashSet<StreamPlatform> = platforms.iter().copied().collect();
    chat_capabilities(accounts)
        .into_iter()
        .filter(|capability| requested.is_empty() || requested.contains(&capability.platform))
        .map(provider_state_from_capability)
        .collect()
}

/// Parameters for `liveChat.start`. Real connectors arrive in slices 4-5; until then a
/// `fake` connector exercises the buffer + event path for tests and the live-chat smoke.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatStartParams {
    pub session_id: String,
    /// Platforms this session should show. Empty preserves the legacy full readiness surface.
    #[serde(default)]
    pub platforms: Vec<StreamPlatform>,
    #[serde(default)]
    pub destinations: Vec<LiveChatDestinationStart>,
    #[serde(default)]
    pub fake: Option<FakeChatConfig>,
    #[serde(default)]
    pub fakes: Vec<FakeChatConfig>,
    #[serde(default)]
    pub youtube: Option<crate::youtube_chat::YouTubeChatConfig>,
    #[serde(default)]
    pub twitch: Option<crate::twitch_chat::TwitchChatConfig>,
    #[serde(default)]
    pub x: Option<crate::x_chat::XChatConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatDestinationStart {
    pub target_id: String,
    pub platform: StreamPlatform,
    #[serde(default)]
    pub read: Option<CommentsReadState>,
    #[serde(default)]
    pub write: Option<CommentsWriteState>,
    #[serde(default)]
    pub preparation_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartXLiveChatParams {
    pub session_id: String,
    pub broadcast_id: String,
    pub media_key: String,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub status_base_url: Option<String>,
    #[serde(default)]
    pub access_url: Option<String>,
}

/// A deterministic, bounded fake chat source for tests / `smoke:live-chat-fake-providers`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChatConfig {
    #[serde(default = "default_fake_platform")]
    pub platform: StreamPlatform,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default = "default_fake_count")]
    pub count: u32,
    #[serde(default = "default_fake_interval_ms")]
    pub interval_ms: u64,
    /// Re-send the first message once to prove de-duplication skips it.
    #[serde(default)]
    pub include_duplicate: bool,
    /// Give the second delivered row an earlier provider timestamp so the
    /// authoritative snapshot proves chronological convergence after disorder.
    #[serde(default)]
    pub out_of_order: bool,
    /// Before this sequence number, emit reconnecting -> connected once.
    #[serde(default)]
    pub reconnect_at: Option<u32>,
    #[serde(default)]
    pub send: FakeChatSendBehavior,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FakeChatSendBehavior {
    #[default]
    Sent,
    Failed,
    Timeout,
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
    if (params.fake.is_some() || !params.fakes.is_empty())
        && let Err(error) = state
            .database
            .ensure_fake_live_chat_session(&params.session_id)
    {
        state.emit_log(
            "warn",
            format!("Could not prepare fake Comments session persistence: {error}"),
        );
    }
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let mut providers = session_provider_rows(&accounts, &params.platforms, &params.destinations);
    for provider in &mut providers {
        let configured_target_id = match provider.platform {
            StreamPlatform::Youtube => params
                .youtube
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::Twitch => params
                .twitch
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::X => params
                .x
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::Custom => None,
        };
        let configured_target_id = configured_target_id.or_else(|| {
            params
                .fakes
                .iter()
                .chain(params.fake.iter())
                .find(|fake| fake.platform == provider.platform)
                .and_then(|fake| fake.target_id.clone())
        });
        if provider.target_id.is_none() && configured_target_id.is_some() {
            provider.target_id = configured_target_id;
        }
        provider.id = comments_destination_id(provider.platform, provider.target_id.as_deref());
        if provider.platform == StreamPlatform::Youtube && params.youtube.is_some() {
            provider.write = CommentsWriteState::Ready;
        }
        if provider.platform == StreamPlatform::X
            && params.x.is_none()
            && provider.state != LiveChatProviderConnectionState::Failed
        {
            provider.state = LiveChatProviderConnectionState::Waiting;
            provider.read = CommentsReadState::WaitingForBroadcastContext;
            provider.message = "Waiting for X broadcast context.".to_string();
        }
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(params.session_id.clone(), providers);
    }
    drop(lifecycle_delivery);
    if let Some(fake) = params.fake.clone() {
        let handle = tokio::spawn(run_fake_connector(
            state.clone(),
            params.session_id.clone(),
            fake.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        let destination_id = comments_destination_id(fake.platform, fake.target_id.as_deref());
        if let Some(provider) = coordinator
            .providers
            .iter_mut()
            .find(|provider| provider.id == destination_id)
        {
            provider.write = if fake.platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            };
        }
        if fake.platform != StreamPlatform::X {
            coordinator.register_sender(destination_id, ChatSenderConfig::Fake(fake.send));
        }
        coordinator.attach_task(handle);
    }
    for fake in params.fakes.clone() {
        let handle = tokio::spawn(run_fake_connector(
            state.clone(),
            params.session_id.clone(),
            fake.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        let destination_id = comments_destination_id(fake.platform, fake.target_id.as_deref());
        if let Some(provider) = coordinator
            .providers
            .iter_mut()
            .find(|provider| provider.id == destination_id)
        {
            provider.write = if fake.platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            };
        }
        if fake.platform != StreamPlatform::X {
            coordinator.register_sender(destination_id, ChatSenderConfig::Fake(fake.send));
        }
        coordinator.attach_task(handle);
    }
    if let Some(youtube) = params.youtube.clone() {
        // Register before spawning: a zero-latency resolver may publish the
        // liveChatId immediately, and that update must always find its sender.
        let mut coordinator = state.live_chat.lock().await;
        coordinator.register_sender(
            comments_destination_id(StreamPlatform::Youtube, youtube.target_id.as_deref()),
            ChatSenderConfig::YouTube {
                access_token: youtube.access_token.clone(),
                api_base_url: youtube.api_base_url.clone(),
                live_chat_id: youtube.live_chat_id.clone(),
            },
        );
        drop(coordinator);
        let handle = tokio::spawn(crate::youtube_chat::run_youtube_chat_connector(
            state.clone(),
            params.session_id.clone(),
            youtube,
        ));
        state.live_chat.lock().await.attach_task(handle);
    }
    // Viewer sampler (plan rider V1): same session, same credentials as the
    // chat connectors, same abort-on-stop lifecycle. Polling failures are
    // missing data — never a chat or stream problem.
    {
        let youtube_viewers = params.youtube.as_ref().and_then(|config| {
            config.broadcast_id.clone().map(|broadcast_id| {
                crate::viewer_stats::YouTubeViewerConfig {
                    access_token: config.access_token.clone(),
                    broadcast_id,
                    api_base_url: config.api_base_url.clone(),
                }
            })
        });
        let twitch_viewers =
            params
                .twitch
                .as_ref()
                .map(|config| crate::viewer_stats::TwitchViewerConfig {
                    access_token: config.access_token.clone(),
                    client_id: config.client_id.clone(),
                    broadcaster_user_id: config.broadcaster_user_id.clone(),
                    api_base_url: config.api_base_url.clone(),
                });
        if youtube_viewers.is_some() || twitch_viewers.is_some() {
            let handle = tokio::spawn(crate::viewer_stats::run_viewer_sampler(
                state.clone(),
                params.session_id.clone(),
                youtube_viewers,
                twitch_viewers,
            ));
            let mut coordinator = state.live_chat.lock().await;
            coordinator.attach_task(handle);
        }
    }
    if let Some(twitch) = params.twitch.clone() {
        let handle = tokio::spawn(crate::twitch_chat::run_twitch_chat_connector(
            state.clone(),
            params.session_id.clone(),
            twitch.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
        coordinator.register_sender(
            comments_destination_id(StreamPlatform::Twitch, twitch.target_id.as_deref()),
            ChatSenderConfig::Twitch(crate::twitch_chat::TwitchChatSenderConfig {
                access_token: twitch.access_token,
                client_id: twitch.client_id,
                broadcaster_user_id: twitch.broadcaster_user_id.clone(),
                // The authorized user sends as themself.
                sender_user_id: twitch.user_id,
                api_base_url: twitch.api_base_url,
            }),
        );
    }
    if let Some(x) = params.x.clone() {
        let handle = tokio::spawn(crate::x_chat::run_x_chat_connector(
            state.clone(),
            params.session_id.clone(),
            x,
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    snapshot
}

pub async fn start_x_live_chat(
    state: &AppState,
    params: StartXLiveChatParams,
) -> Result<LiveChatSnapshot> {
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let mut provider = session_provider_rows(&accounts, &[StreamPlatform::X], &[])
        .into_iter()
        .next()
        .unwrap_or_else(|| LiveChatProviderState {
            id: comments_destination_id(StreamPlatform::X, params.target_id.as_deref()),
            platform: StreamPlatform::X,
            target_id: None,
            account_id: None,
            account_label: None,
            read: CommentsReadState::WaitingForBroadcastContext,
            write: CommentsWriteState::ReadOnly,
            state: LiveChatProviderConnectionState::Disabled,
            message: crate::x_chat::x_chat_message(false).to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
        });
    provider.target_id = params.target_id.clone();
    provider.id = comments_destination_id(StreamPlatform::X, provider.target_id.as_deref());

    {
        let mut coordinator = state.live_chat.lock().await;
        if let Some(active_session_id) = coordinator.session_id.as_deref() {
            if active_session_id != params.session_id {
                return Err(anyhow!(
                    "Live chat session {active_session_id} is active; cannot attach X chat for {}.",
                    params.session_id
                ));
            }
            coordinator.ensure_provider(provider);
        } else {
            coordinator.start_session(params.session_id.clone(), vec![provider]);
        }
    }

    let config = crate::x_chat::XChatConfig {
        broadcast_id: params.broadcast_id,
        media_key: params.media_key,
        target_id: params.target_id,
        status_base_url: params.status_base_url,
        access_url: params.access_url,
    };
    let handle = tokio::spawn(crate::x_chat::run_x_chat_connector(
        state.clone(),
        params.session_id,
        config,
    ));
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }

    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    Ok(snapshot)
}

/// The YouTube connector resolves the live chat id from the broadcast id after
/// start; fill it into the sender so sends work without a second resolve.
pub async fn set_youtube_send_chat_id(
    state: &AppState,
    target_id: Option<&str>,
    live_chat_id: &str,
) {
    let mut coordinator = state.live_chat.lock().await;
    let destination_id = comments_destination_id(StreamPlatform::Youtube, target_id);
    if let Some(ChatSenderConfig::YouTube {
        live_chat_id: slot, ..
    }) = coordinator.senders.get_mut(&destination_id)
    {
        *slot = Some(live_chat_id.to_string());
    }
}

#[cfg(not(test))]
const CHAT_SEND_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(test)]
const CHAT_SEND_TIMEOUT: Duration = Duration::from_millis(50);

/// Send once to every writable destination. The operation id is an idempotency
/// key: an existing row is returned verbatim and providers are never called a
/// second time. Provider calls run concurrently with independent deadlines.
pub async fn send_live_chat_message(
    state: &AppState,
    mut params: CommentsSendParams,
) -> Result<CommentsSendOperation, String> {
    if uuid::Uuid::parse_str(&params.operation_id).is_err() {
        return Err("operationId must be a UUID.".to_string());
    }
    let text = params.text.trim().to_string();
    if text.is_empty() || text.chars().count() > 200 {
        return Err("Chat messages must be 1-200 characters.".to_string());
    }
    params.text = text;

    if let Some(result) = {
        let coordinator = state.live_chat.lock().await;
        coordinator
            .send_operations_in_flight
            .get(&params.operation_id)
            .map(|in_flight| {
                validate_send_operation_binding(
                    &params.operation_id,
                    &params.session_id,
                    &params.text,
                    &in_flight.session_id,
                    &in_flight.text,
                )?;
                Ok::<_, String>(in_flight.result.clone())
            })
            .transpose()
    }? {
        return wait_for_send_operation(result).await;
    }

    if let Some(existing) = state
        .database
        .get_chat_send_operation(&params.operation_id)
        .map_err(|error| format!("Could not read send operation: {error}"))?
    {
        validate_send_operation_binding(
            &params.operation_id,
            &params.session_id,
            &params.text,
            &existing.session_id,
            &existing.text,
        )?;
        return Ok(existing);
    }

    let (result, operation_task) = {
        let mut coordinator = state.live_chat.lock().await;
        match coordinator
            .send_operations_in_flight
            .entry(params.operation_id.clone())
        {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let in_flight = entry.get();
                validate_send_operation_binding(
                    &params.operation_id,
                    &params.session_id,
                    &params.text,
                    &in_flight.session_id,
                    &in_flight.text,
                )?;
                (in_flight.result.clone(), None)
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                let (sender, result) = tokio::sync::watch::channel(None);
                entry.insert(InFlightSendOperation {
                    session_id: params.session_id.clone(),
                    text: params.text.clone(),
                    result: result.clone(),
                });
                (result, Some(sender))
            }
        }
    };

    if let Some(operation_task) = operation_task {
        let task_state = state.clone();
        let operation_id = params.operation_id.clone();
        tokio::spawn(async move {
            let result = execute_send_live_chat_message(&task_state, params).await;
            let _ = operation_task.send(Some(result));
            let mut coordinator = task_state.live_chat.lock().await;
            coordinator.send_operations_in_flight.remove(&operation_id);
        });
    }

    wait_for_send_operation(result).await
}

async fn wait_for_send_operation(mut result: SendOperationReceiver) -> SendOperationResult {
    loop {
        if let Some(operation) = result.borrow().clone() {
            return operation;
        }
        if result.changed().await.is_err() {
            let terminal = result.borrow().clone();
            return terminal.unwrap_or_else(|| {
                Err("The Comments send operation stopped before producing a result.".to_string())
            });
        }
    }
}

fn validate_send_operation_binding(
    operation_id: &str,
    requested_session_id: &str,
    requested_text: &str,
    stored_session_id: &str,
    stored_text: &str,
) -> Result<(), String> {
    if requested_session_id == stored_session_id && requested_text == stored_text {
        return Ok(());
    }
    Err(format!(
        "operationId {operation_id} is already bound to a different Comments session or message."
    ))
}

async fn execute_send_live_chat_message(
    state: &AppState,
    params: CommentsSendParams,
) -> Result<CommentsSendOperation, String> {
    if let Some(existing) = state
        .database
        .get_chat_send_operation(&params.operation_id)
        .map_err(|error| format!("Could not read send operation: {error}"))?
    {
        validate_send_operation_binding(
            &params.operation_id,
            &params.session_id,
            &params.text,
            &existing.session_id,
            &existing.text,
        )?;
        return Ok(existing);
    }

    let (providers, senders) = {
        let coordinator = state.live_chat.lock().await;
        if coordinator.session_id.as_deref() != Some(params.session_id.as_str()) {
            return Err("The Comments session changed before this message could send.".to_string());
        }
        let providers = coordinator.providers.clone();
        let senders = providers
            .iter()
            .map(|provider| (provider.id.clone(), coordinator.sender(&provider.id)))
            .collect::<HashMap<_, _>>();
        (providers, senders)
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut operation = CommentsSendOperation {
        id: params.operation_id,
        session_id: params.session_id,
        text: params.text,
        phase: CommentsSendOperationPhase::Sending,
        destinations: providers
            .iter()
            .map(|provider| {
                initial_delivery_for_provider(
                    provider,
                    senders.get(&provider.id).and_then(Option::as_ref).is_some(),
                )
            })
            .collect(),
        created_at: now.clone(),
        updated_at: now,
    };
    operation.phase = aggregate_send_phase(&operation.destinations);
    state
        .database
        .save_chat_send_operation(&operation)
        .map_err(|error| format!("Could not persist send operation: {error}"))?;
    state.emit_event("liveChat.sendOperation", operation.clone());

    let client = reqwest::Client::new();
    let pending = operation
        .destinations
        .iter()
        .filter(|delivery| delivery.phase == DestinationDeliveryPhase::Pending)
        .filter_map(|delivery| {
            senders
                .get(&delivery.destination_id)
                .cloned()
                .flatten()
                .map(|sender| {
                    let client = client.clone();
                    let destination_id = delivery.destination_id.clone();
                    let text = operation.text.clone();
                    async move {
                        let outcome = timeout(
                            CHAT_SEND_TIMEOUT,
                            send_to_destination(&client, sender, &text),
                        )
                        .await;
                        (destination_id, outcome)
                    }
                })
        })
        .collect::<Vec<_>>();

    for (destination_id, outcome) in futures_util::future::join_all(pending).await {
        let Some(delivery) = operation
            .destinations
            .iter_mut()
            .find(|delivery| delivery.destination_id == destination_id)
        else {
            continue;
        };
        match outcome {
            Ok(Ok(receipt)) => {
                delivery.phase = DestinationDeliveryPhase::Sent;
                delivery.provider_message_id = receipt.provider_message_id;
                delivery.reason = None;
            }
            Ok(Err(reason)) => {
                delivery.phase = DestinationDeliveryPhase::Failed;
                delivery.reason = Some(reason);
            }
            Err(_) => {
                delivery.phase = DestinationDeliveryPhase::TimedOutUnknown;
                delivery.reason = Some(
                    "Provider response timed out; delivery is unknown and was not retried."
                        .to_string(),
                );
            }
        }
    }

    operation.updated_at = chrono::Utc::now().to_rfc3339();
    operation.phase = aggregate_send_phase(&operation.destinations);
    state
        .database
        .save_chat_send_operation(&operation)
        .map_err(|error| format!("Could not persist send result: {error}"))?;
    state.emit_event("liveChat.sendOperation", operation.clone());
    Ok(operation)
}

fn initial_delivery_for_provider(
    provider: &LiveChatProviderState,
    has_sender: bool,
) -> DestinationDelivery {
    let (phase, reason) = match provider.write {
        CommentsWriteState::Ready if has_sender => (DestinationDeliveryPhase::Pending, None),
        CommentsWriteState::Ready => (
            DestinationDeliveryPhase::Unavailable,
            Some("This destination's comment sender is unavailable.".to_string()),
        ),
        CommentsWriteState::MissingScope => (
            DestinationDeliveryPhase::Unavailable,
            Some("Reconnect this account to grant chat write permission.".to_string()),
        ),
        CommentsWriteState::ReadOnly => (
            DestinationDeliveryPhase::ReadOnly,
            Some("This destination supports receiving comments only.".to_string()),
        ),
        CommentsWriteState::Failed => (
            DestinationDeliveryPhase::Failed,
            Some("This destination's comment sender is unavailable.".to_string()),
        ),
        CommentsWriteState::Unavailable => (
            DestinationDeliveryPhase::Unavailable,
            Some("Sending is unavailable for this destination.".to_string()),
        ),
    };
    DestinationDelivery {
        destination_id: provider.id.clone(),
        platform: provider.platform,
        phase,
        provider_message_id: None,
        reason,
    }
}

fn aggregate_send_phase(deliveries: &[DestinationDelivery]) -> CommentsSendOperationPhase {
    if deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Pending)
    {
        return CommentsSendOperationPhase::Sending;
    }
    let sent = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Sent);
    let failed = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Failed);
    let unknown = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::TimedOutUnknown);
    let not_sent = deliveries
        .iter()
        .any(|delivery| delivery.phase != DestinationDeliveryPhase::Sent);
    match (sent, failed, unknown, not_sent) {
        (true, _, _, true) => CommentsSendOperationPhase::Partial,
        (true, false, false, false) => CommentsSendOperationPhase::Sent,
        (false, false, true, _) => CommentsSendOperationPhase::DeliveryUnknown,
        _ => CommentsSendOperationPhase::Failed,
    }
}

async fn send_to_destination(
    client: &reqwest::Client,
    sender: ChatSenderConfig,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    match sender {
        ChatSenderConfig::YouTube {
            access_token,
            api_base_url,
            live_chat_id: Some(live_chat_id),
        } => {
            crate::youtube_chat::send_youtube_chat_message(
                client,
                api_base_url.as_deref(),
                &access_token,
                &live_chat_id,
                text,
            )
            .await
        }
        ChatSenderConfig::YouTube {
            live_chat_id: None, ..
        } => Err("YouTube live chat is not resolved yet — try again in a moment.".to_string()),
        ChatSenderConfig::Twitch(config) => {
            crate::twitch_chat::send_twitch_chat_message(client, &config, text).await
        }
        ChatSenderConfig::Fake(behavior) => match behavior {
            FakeChatSendBehavior::Sent => Ok(ProviderSendReceipt {
                provider_message_id: Some(format!("fake-sent-{}", uuid::Uuid::new_v4())),
            }),
            FakeChatSendBehavior::Failed => Err("Fake provider rejected the send.".to_string()),
            FakeChatSendBehavior::Timeout => {
                sleep(CHAT_SEND_TIMEOUT + Duration::from_millis(250)).await;
                Ok(ProviderSendReceipt {
                    provider_message_id: Some("fake-timeout-late".to_string()),
                })
            }
        },
        #[cfg(test)]
        ChatSenderConfig::FakeProbe {
            behavior,
            probe,
            delay,
        } => {
            let _active = probe.begin();
            if !delay.is_zero() {
                sleep(delay).await;
            }
            match behavior {
                FakeChatSendBehavior::Sent => Ok(ProviderSendReceipt {
                    provider_message_id: Some(format!("fake-probe-{}", uuid::Uuid::new_v4())),
                }),
                FakeChatSendBehavior::Failed => Err("Fake provider rejected the send.".to_string()),
                FakeChatSendBehavior::Timeout => {
                    sleep(CHAT_SEND_TIMEOUT + Duration::from_millis(25)).await;
                    Ok(ProviderSendReceipt {
                        provider_message_id: Some("fake-probe-timeout-late".to_string()),
                    })
                }
            }
        }
    }
}

/// Stop the active chat session, aborting connectors and marking providers ended.
pub async fn stop_live_chat(state: &AppState) -> LiveChatSnapshot {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.stop_session();
    }
    drop(lifecycle_delivery);
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    snapshot
}

/// Clear the local message view (not platform messages) and emit `liveChat.cleared`.
pub async fn clear_local_live_chat(state: &AppState) -> LiveChatSnapshot {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.clear_local();
    }
    drop(lifecycle_delivery);
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

/// Lock the coordinator, ingest one message, and emit it when it is new or tombstoned.
pub(crate) async fn deliver_message(state: &AppState, message: LiveChatMessage) -> bool {
    try_deliver_message(state, message).await.is_ok()
}

pub(crate) async fn try_deliver_message(
    state: &AppState,
    message: LiveChatMessage,
) -> std::result::Result<(), LiveChatPersistenceFailure> {
    try_deliver_messages(state, vec![message]).await
}

/// Persist and emit one sequential provider delivery as one atomic transaction. The
/// delivery guard plus constant-size per-message undo records make a terminal
/// persistence failure retryable without cloning the full transcript. Transient
/// database failures remain inside the worker and apply backpressure.
pub(crate) async fn try_deliver_messages(
    state: &AppState,
    messages: Vec<LiveChatMessage>,
) -> std::result::Result<(), LiveChatPersistenceFailure> {
    if messages.is_empty() {
        return Ok(());
    }
    let _delivery = state.live_chat_persistence.begin_delivery().await;
    let (delivery_generation, delivery_session_id, undos, authoritative_messages) = {
        let mut coordinator = state.live_chat.lock().await;
        let Some(delivery_session_id) = coordinator.session_id.clone() else {
            return Err(LiveChatPersistenceFailure::terminal(
                "Live-chat delivery arrived after its session ended.",
            ));
        };
        if messages
            .iter()
            .any(|message| message.session_id != delivery_session_id)
        {
            return Err(LiveChatPersistenceFailure::terminal(
                "Live-chat delivery belonged to a replaced session.",
            ));
        }
        let delivery_generation = coordinator.generation;
        let mut undos = Vec::with_capacity(messages.len());
        let mut authoritative_messages = Vec::with_capacity(messages.len());
        for message in messages {
            let ingested = coordinator.ingest_reversible(message);
            match ingested.outcome {
                IngestOutcome::New(message) | IngestOutcome::Updated(message) => {
                    authoritative_messages.push(message);
                }
                IngestOutcome::Duplicate => {}
            }
            undos.push(ingested.undo);
        }
        (
            delivery_generation,
            delivery_session_id,
            undos,
            authoritative_messages,
        )
    };
    if authoritative_messages.is_empty() {
        return Ok(());
    }
    if let Err(error) = state
        .live_chat_persistence
        .persist_batch(authoritative_messages.clone())
        .await
    {
        let mut coordinator = state.live_chat.lock().await;
        for undo in undos.into_iter().rev() {
            coordinator.rollback_ingest(undo);
        }
        drop(coordinator);
        state.emit_log(
            "warn",
            format!(
                "Could not persist {} live chat message(s); exact-message retry remains eligible: {error}",
                authoritative_messages.len()
            ),
        );
        return Err(error);
    }
    let delivery_still_current = {
        let coordinator = state.live_chat.lock().await;
        coordinator.generation == delivery_generation
            && coordinator.session_id.as_deref() == Some(delivery_session_id.as_str())
    };
    if !delivery_still_current {
        state.emit_log(
            "warn",
            "Persisted live-chat delivery was suppressed because its session was replaced.",
        );
        return Err(LiveChatPersistenceFailure::terminal(
            "Live-chat delivery completed after its session was replaced.",
        ));
    }
    for message in authoritative_messages {
        if message.is_deleted {
            crate::comment_highlight::clear_comment_highlight_for_message(
                state,
                &message.session_id,
                &message.id,
            )
            .await;
        }
        state.emit_event("liveChat.message", message);
    }
    Ok(())
}

/// Set a provider's connection state and emit `liveChat.providerStatus`.
pub(crate) async fn set_provider_and_emit(
    state: &AppState,
    platform: StreamPlatform,
    target_id: Option<&str>,
    connection: LiveChatProviderConnectionState,
    message: &str,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let provider = {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.set_provider_status(platform, target_id, connection, message, &now);
        coordinator
            .providers
            .iter()
            .find(|provider| {
                provider.platform == platform
                    && target_id
                        .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                        .unwrap_or(true)
            })
            .cloned()
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
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connected,
        "Live chat connected.",
    )
    .await;
    let interval = Duration::from_millis(config.interval_ms.max(1));
    for seq in 0..config.count {
        sleep(interval).await;
        if config.reconnect_at == Some(seq) {
            set_provider_and_emit(
                &state,
                platform,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Reconnecting,
                "Fake live chat reconnecting.",
            )
            .await;
            sleep(interval).await;
            set_provider_and_emit(
                &state,
                platform,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Connected,
                "Fake live chat reconnected.",
            )
            .await;
        }
        let mut message = fake_message(&session_id, platform, config.target_id.as_deref(), seq);
        if config.out_of_order && seq == 1 {
            let earlier = (chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339();
            message.published_at = earlier.clone();
            message.received_at = earlier;
        }
        deliver_message(&state, message).await;
        if config.include_duplicate && seq == 0 {
            deliver_message(
                &state,
                fake_message(&session_id, platform, config.target_id.as_deref(), 0),
            )
            .await;
        }
    }
    set_provider_and_emit(
        &state,
        platform,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Ended,
        "Live chat ended.",
    )
    .await;
}

/// Build one deterministic fake message. Shared by the fake connector and the unit tests.
fn fake_message(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
    seq: u32,
) -> LiveChatMessage {
    let now = chrono::Utc::now().to_rfc3339();
    let provider_message_id = format!("fake-{seq}");
    LiveChatMessage {
        id: live_chat_message_id(session_id, platform, target_id, &provider_message_id),
        provider_message_id,
        platform,
        target_id: target_id.map(str::to_string),
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
    use crate::storage::Database;
    use crate::streaming::PlatformAccountStatus;
    use tokio::sync::broadcast;

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
            id: comments_destination_id(platform, None),
            platform,
            target_id: None,
            account_id: None,
            account_label: None,
            read: CommentsReadState::Connecting,
            write: CommentsWriteState::Unavailable,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting…".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
        }
    }

    fn connected_provider(id: &str, platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            id: id.to_string(),
            platform,
            target_id: Some(id.to_string()),
            account_id: Some(format!("{id}-account")),
            account_label: Some(format!("{id} account")),
            read: CommentsReadState::Ready,
            write: if platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            },
            state: LiveChatProviderConnectionState::Connected,
            message: "Comments connected.".to_string(),
            last_connected_at: Some("2026-07-10T00:00:00Z".to_string()),
            last_message_at: None,
            last_error: None,
        }
    }

    async fn send_test_state(
        session_id: &str,
        providers: Vec<LiveChatProviderState>,
        senders: Vec<(String, ChatSenderConfig)>,
    ) -> AppState {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .database
            .ensure_fake_live_chat_session(session_id)
            .unwrap();
        {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(session_id.to_string(), providers);
            for (destination_id, sender) in senders {
                coordinator.register_sender(destination_id, sender);
            }
        }
        state
    }

    fn send_params(operation_id: &str, session_id: &str, text: &str) -> CommentsSendParams {
        CommentsSendParams {
            operation_id: operation_id.to_string(),
            session_id: session_id.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn diagnostics_report_counters_and_provider_errors() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 1));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0)); // duplicate
        coordinator.set_provider_status(
            StreamPlatform::Youtube,
            None,
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
            assert!(matches!(
                coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, seq)),
                IngestOutcome::New(_)
            ));
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
    fn full_buffer_reversible_ingest_keeps_constant_size_undo() {
        let mut coordinator = LiveChatCoordinator::new(DEFAULT_MAX_CHAT_MESSAGES);
        coordinator.start_session("s1".to_string(), vec![provider_row(StreamPlatform::Twitch)]);
        for sequence in 0..DEFAULT_MAX_CHAT_MESSAGES as u32 {
            coordinator.ingest(fake_message("s1", StreamPlatform::Twitch, None, sequence));
        }
        let first_id = coordinator.messages.front().unwrap().id.clone();
        let last_id = coordinator.messages.back().unwrap().id.clone();
        let diagnostics = coordinator.diagnostics();

        let ingested = coordinator.ingest_reversible(fake_message(
            "s1",
            StreamPlatform::Twitch,
            None,
            DEFAULT_MAX_CHAT_MESSAGES as u32,
        ));
        assert!(matches!(ingested.outcome, IngestOutcome::New(_)));
        assert_eq!(
            ingested.undo.retained_buffer_rows(),
            1,
            "undo space must stay one row even when the 5,000-row buffer is full"
        );
        coordinator.rollback_ingest(ingested.undo);

        assert_eq!(coordinator.messages.len(), DEFAULT_MAX_CHAT_MESSAGES);
        assert_eq!(coordinator.messages.front().unwrap().id, first_id);
        assert_eq!(coordinator.messages.back().unwrap().id, last_id);
        assert_eq!(coordinator.diagnostics(), diagnostics);
    }

    #[test]
    fn coordinator_skips_duplicate_message_ids() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let message = fake_message("s1", StreamPlatform::Youtube, None, 0);
        assert_eq!(
            coordinator.ingest(message.clone()),
            IngestOutcome::New(message.clone())
        );
        assert_eq!(coordinator.ingest(message), IngestOutcome::Duplicate);
        assert_eq!(coordinator.duplicates_skipped(), 1);
        assert_eq!(coordinator.snapshot("now".to_string()).messages.len(), 1);
    }

    fn deletion_for(mut message: LiveChatMessage, received_at: &str) -> LiveChatMessage {
        message.author_name = "Provider moderation".to_string();
        message.message_text = "A chat message was removed.".to_string();
        message.fragments.clear();
        message.event_type = LiveChatEventType::Deleted;
        message.is_deleted = true;
        message.received_at = received_at.to_string();
        message.raw_provider_type = Some("message-delete".to_string());
        message
    }

    #[test]
    fn provider_deletion_tombstones_the_original_without_creating_a_second_row() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let original = fake_message("s1", StreamPlatform::Twitch, Some("target-1"), 1);
        assert_eq!(
            coordinator.ingest(original.clone()),
            IngestOutcome::New(original.clone())
        );

        let tombstone = deletion_for(original.clone(), "2026-07-10T12:00:10Z");
        let IngestOutcome::Updated(authoritative) = coordinator.ingest(tombstone) else {
            panic!("provider deletion must update the buffered message")
        };

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(authoritative, snapshot.messages[0]);
        assert_eq!(snapshot.messages[0].id, original.id);
        assert!(snapshot.messages[0].is_deleted);
        assert_eq!(snapshot.messages[0].event_type, LiveChatEventType::Deleted);
        assert_eq!(
            snapshot.messages[0].message_text,
            "A chat message was removed."
        );
        assert!(snapshot.messages[0].fragments.is_empty());
    }

    #[test]
    fn deletion_before_original_wins_and_destination_identity_is_isolated() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let original = fake_message("s1", StreamPlatform::Youtube, Some("target-1"), 2);
        let tombstone = deletion_for(original.clone(), "2026-07-10T12:00:10Z");
        assert!(matches!(
            coordinator.ingest(tombstone),
            IngestOutcome::New(_)
        ));
        assert_eq!(coordinator.ingest(original), IngestOutcome::Duplicate);

        let other_target = fake_message("s1", StreamPlatform::Youtube, Some("target-2"), 2);
        assert!(matches!(
            coordinator.ingest(other_target),
            IngestOutcome::New(_)
        ));
        let other_session = fake_message("s2", StreamPlatform::Youtube, Some("target-1"), 2);
        assert!(matches!(
            coordinator.ingest(other_session),
            IngestOutcome::New(_)
        ));

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(
            snapshot
                .messages
                .iter()
                .filter(|row| row.is_deleted)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn provider_deletion_clears_a_matching_active_highlight() {
        let state = send_test_state("s1", Vec::new(), Vec::new()).await;
        let original = fake_message("s1", StreamPlatform::Twitch, Some("target-1"), 3);
        state.live_chat.lock().await.ingest(original.clone());
        *state.comment_highlight.lock().await = crate::comment_highlight::CommentHighlightState {
            session_id: Some("s1".to_string()),
            message_id: Some(original.id.clone()),
            generation: 4,
            phase: crate::comment_highlight::CommentHighlightPhase::Live,
            expires_at: Some("2026-07-10T12:00:10Z".to_string()),
            reason: None,
        };

        deliver_message(&state, deletion_for(original, "2026-07-10T12:00:05Z")).await;

        let highlight = crate::comment_highlight::comment_highlight_status(&state).await;
        assert_eq!(
            highlight.phase,
            crate::comment_highlight::CommentHighlightPhase::Idle
        );
        assert_eq!(highlight.reason.as_deref(), Some("message-deleted"));
    }

    #[tokio::test]
    async fn persistence_failure_restores_dedup_state_for_redelivery() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let message = fake_message("late-session", StreamPlatform::Youtube, Some("target-1"), 7);
        state
            .live_chat
            .lock()
            .await
            .start_session("late-session".to_string(), Vec::new());

        assert!(!deliver_message(&state, message.clone()).await);
        {
            let coordinator = state.live_chat.lock().await;
            assert!(coordinator.messages.is_empty());
            assert!(!coordinator.seen.contains(&message.id));
            assert_eq!(coordinator.messages_received, 0);
        }

        state
            .database
            .ensure_fake_live_chat_session("late-session")
            .unwrap();
        assert!(deliver_message(&state, message.clone()).await);
        assert_eq!(state.live_chat.lock().await.messages.len(), 1);
        assert_eq!(
            state
                .database
                .list_live_chat_messages_recent("late-session", 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn delivery_for_a_replaced_session_is_rejected_before_persistence_or_emit() {
        let (events, mut receiver) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("new-session".to_string(), Vec::new());

        let delivered = deliver_message(
            &state,
            fake_message("old-session", StreamPlatform::Youtube, None, 9),
        )
        .await;

        assert!(!delivered);
        assert!(state.live_chat.lock().await.messages.is_empty());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn session_replacement_waits_for_persistence_and_cannot_receive_the_old_message() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Condvar, Mutex};

        let (events, _) = broadcast::channel(16);
        let mut state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let writer_started = Arc::new(AtomicBool::new(false));
        let release_writer = Arc::new((Mutex::new(false), Condvar::new()));
        let writer_started_for_task = writer_started.clone();
        let release_writer_for_task = release_writer.clone();
        state.live_chat_persistence =
            crate::live_chat_persistence::LiveChatPersistence::with_writer(Arc::new(move |_| {
                writer_started_for_task.store(true, Ordering::SeqCst);
                let (released, signal) = &*release_writer_for_task;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = signal.wait(released).unwrap();
                }
                Ok(())
            }));
        state
            .live_chat
            .lock()
            .await
            .start_session("old-session".to_string(), Vec::new());

        let delivery_state = state.clone();
        let delivery = tokio::spawn(async move {
            try_deliver_message(
                &delivery_state,
                fake_message("old-session", StreamPlatform::Twitch, None, 1),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !writer_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("persistence writer did not block");

        let replacement_state = state.clone();
        let replacement = tokio::spawn(async move {
            start_live_chat(
                &replacement_state,
                LiveChatStartParams {
                    session_id: "new-session".to_string(),
                    platforms: Vec::new(),
                    destinations: Vec::new(),
                    fake: None,
                    fakes: Vec::new(),
                    youtube: None,
                    twitch: None,
                    x: None,
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !replacement.is_finished(),
            "session replacement must wait for the in-flight delivery"
        );

        {
            let (released, signal) = &*release_writer;
            *released.lock().unwrap() = true;
            signal.notify_all();
        }
        delivery.await.unwrap().unwrap();
        replacement.await.unwrap();

        let snapshot = current_status(&state).await;
        assert_eq!(snapshot.session_id.as_deref(), Some("new-session"));
        assert!(snapshot.messages.is_empty());
    }

    #[test]
    fn snapshot_is_authoritatively_chronological_under_concurrent_delivery() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let mut later = fake_message("s1", StreamPlatform::Twitch, Some("tw"), 2);
        later.received_at = "2026-07-10T12:00:02Z".to_string();
        let mut earlier = fake_message("s1", StreamPlatform::Youtube, Some("yt"), 1);
        earlier.received_at = "2026-07-10T12:00:01Z".to_string();
        coordinator.ingest(later);
        coordinator.ingest(earlier);
        let ids = coordinator
            .snapshot("now".to_string())
            .messages
            .into_iter()
            .map(|message| message.provider_message_id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["fake-1", "fake-2"]);
    }

    #[test]
    fn clear_local_empties_view_but_keeps_session_active() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
        coordinator.clear_local();
        let snapshot = coordinator.snapshot("now".to_string());
        assert!(coordinator.is_active());
        assert_eq!(snapshot.session_id.as_deref(), Some("s1"));
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.unread_count, 0);
        assert_eq!(snapshot.providers.len(), 1);
    }

    #[test]
    fn ensure_provider_adds_late_x_without_resetting_existing_rows() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );

        coordinator.ensure_provider(LiveChatProviderState {
            id: "x-target".to_string(),
            platform: StreamPlatform::X,
            target_id: Some("x-target".to_string()),
            account_id: Some("123".to_string()),
            account_label: Some("OrcDev".to_string()),
            read: CommentsReadState::Ready,
            write: CommentsWriteState::ReadOnly,
            state: LiveChatProviderConnectionState::Disabled,
            message: "X comments ready.".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
        });

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.session_id.as_deref(), Some("s1"));
        assert_eq!(snapshot.providers.len(), 2);
        assert_eq!(snapshot.providers[0].platform, StreamPlatform::Youtube);
        assert_eq!(snapshot.providers[1].platform, StreamPlatform::X);
        assert_eq!(snapshot.providers[1].target_id.as_deref(), Some("x-target"));
    }

    #[test]
    fn sender_registry_is_session_scoped() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session("s1".to_string(), Vec::new());
        coordinator.register_sender(
            "youtube".to_string(),
            ChatSenderConfig::YouTube {
                access_token: "t".to_string(),
                api_base_url: None,
                live_chat_id: None,
            },
        );
        assert!(coordinator.sender("youtube").is_some());
        assert!(coordinator.sender("twitch").is_none());
        // Stop drops send credentials with the session.
        coordinator.stop_session();
        assert!(coordinator.sender("youtube").is_none());
        // A NEW session never inherits the previous session's senders.
        coordinator.register_sender(
            "twitch".to_string(),
            ChatSenderConfig::Twitch(crate::twitch_chat::TwitchChatSenderConfig {
                access_token: "t".to_string(),
                client_id: "c".to_string(),
                broadcaster_user_id: "b".to_string(),
                sender_user_id: "u".to_string(),
                api_base_url: None,
            }),
        );
        coordinator.start_session("s2".to_string(), Vec::new());
        assert!(coordinator.sender("twitch").is_none());
    }

    #[tokio::test]
    async fn resolved_youtube_chat_id_updates_only_its_destination_sender() {
        let state = send_test_state(
            "s1",
            Vec::new(),
            ["youtube-primary", "youtube-backup"]
                .into_iter()
                .map(|target_id| {
                    (
                        target_id.to_string(),
                        ChatSenderConfig::YouTube {
                            access_token: "token".to_string(),
                            api_base_url: None,
                            live_chat_id: None,
                        },
                    )
                })
                .collect(),
        )
        .await;

        set_youtube_send_chat_id(&state, Some("youtube-backup"), "chat-backup").await;

        let coordinator = state.live_chat.lock().await;
        let resolved = |target_id: &str| match coordinator.sender(target_id).unwrap() {
            ChatSenderConfig::YouTube { live_chat_id, .. } => live_chat_id,
            _ => panic!("expected YouTube sender"),
        };
        assert_eq!(resolved("youtube-primary"), None);
        assert_eq!(resolved("youtube-backup").as_deref(), Some("chat-backup"));
    }

    #[tokio::test]
    async fn send_rejects_wrong_session_before_calling_a_provider() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;

        let error =
            send_live_chat_message(&state, send_params(&operation_id, "session-2", "hello"))
                .await
                .unwrap_err();

        assert!(error.contains("session changed"));
        assert_eq!(probe.calls(), 0);
        assert!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn send_uses_independent_writer_while_read_connector_reconnects() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let mut twitch = connected_provider("twitch-target", StreamPlatform::Twitch);
        twitch.state = LiveChatProviderConnectionState::Reconnecting;
        twitch.read = CommentsReadState::Connecting;
        twitch.message = "Twitch comments reconnecting.".to_string();
        let state = send_test_state(
            "session-1",
            vec![twitch],
            vec![(
                "twitch-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;

        let operation = send_live_chat_message(
            &state,
            send_params(&operation_id, "session-1", "send during reconnect"),
        )
        .await
        .unwrap();

        assert_eq!(operation.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(
            operation.destinations[0].phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_duplicate_operation_id_sends_exactly_once_and_returns_terminal_result() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::from_millis(20),
                },
            )],
        )
        .await;
        let params = send_params(&operation_id, "session-1", "  hello everyone  ");

        let (first, second) = tokio::join!(
            send_live_chat_message(&state, params.clone()),
            send_live_chat_message(&state, params)
        );
        let first = first.unwrap();
        let second = second.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.text, "hello everyone");
        assert_eq!(first.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(first.destinations[0].phase, DestinationDeliveryPhase::Sent);
        assert_eq!(probe.calls(), 1);
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(first)
        );
    }

    #[tokio::test]
    async fn aborting_the_first_caller_does_not_cancel_or_duplicate_the_send_operation() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::from_millis(30),
                },
            )],
        )
        .await;
        let params = send_params(&operation_id, "session-1", "keep sending");
        let first_state = state.clone();
        let first_params = params.clone();
        let first_caller =
            tokio::spawn(async move { send_live_chat_message(&first_state, first_params).await });

        tokio::time::timeout(Duration::from_millis(100), async {
            while probe.calls() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provider send did not start");
        first_caller.abort();
        assert!(first_caller.await.unwrap_err().is_cancelled());

        let terminal = send_live_chat_message(&state, params).await.unwrap();

        assert_eq!(terminal.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(
            terminal.destinations[0].phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(probe.calls(), 1);
        assert!(
            terminal
                .destinations
                .iter()
                .all(|delivery| { delivery.phase != DestinationDeliveryPhase::Pending })
        );
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(terminal)
        );
    }

    #[tokio::test]
    async fn reused_operation_id_conflicts_on_different_session_or_normalized_text() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider("twitch-target", StreamPlatform::Twitch)],
            vec![(
                "twitch-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;
        send_live_chat_message(&state, send_params(&operation_id, "session-1", "same text"))
            .await
            .unwrap();

        let text_conflict = send_live_chat_message(
            &state,
            send_params(&operation_id, "session-1", "different text"),
        )
        .await
        .unwrap_err();
        let session_conflict =
            send_live_chat_message(&state, send_params(&operation_id, "session-2", "same text"))
                .await
                .unwrap_err();

        assert!(text_conflict.contains("already bound"));
        assert!(session_conflict.contains("already bound"));
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_fanout_isolates_timeout_and_persists_every_terminal_destination() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![
                connected_provider("youtube-target", StreamPlatform::Youtube),
                connected_provider("twitch-target", StreamPlatform::Twitch),
                connected_provider("x-target", StreamPlatform::X),
            ],
            vec![
                (
                    "youtube-target".to_string(),
                    ChatSenderConfig::FakeProbe {
                        behavior: FakeChatSendBehavior::Sent,
                        probe: probe.clone(),
                        delay: Duration::from_millis(30),
                    },
                ),
                (
                    "twitch-target".to_string(),
                    ChatSenderConfig::FakeProbe {
                        behavior: FakeChatSendBehavior::Timeout,
                        probe: probe.clone(),
                        delay: Duration::ZERO,
                    },
                ),
            ],
        )
        .await;

        let operation =
            send_live_chat_message(&state, send_params(&operation_id, "session-1", "fan out"))
                .await
                .unwrap();

        assert_eq!(probe.calls(), 2);
        assert!(probe.max_active() >= 2, "provider sends did not overlap");
        assert_eq!(operation.phase, CommentsSendOperationPhase::Partial);
        assert_eq!(operation.destinations.len(), 3);
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "youtube-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "twitch-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "x-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::ReadOnly
        );
        assert!(
            operation
                .destinations
                .iter()
                .all(|delivery| { delivery.phase != DestinationDeliveryPhase::Pending })
        );
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(operation)
        );
    }

    #[tokio::test]
    async fn same_platform_fake_connectors_keep_target_state_isolated() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let params: LiveChatStartParams = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "destinations": [
                { "targetId": "youtube-a", "platform": "youtube" },
                { "targetId": "youtube-b", "platform": "youtube" }
            ],
            "fakes": [
                { "platform": "youtube", "targetId": "youtube-a", "count": 0 },
                {
                    "platform": "youtube",
                    "targetId": "youtube-b",
                    "count": 1,
                    "intervalMs": 250
                }
            ]
        }))
        .unwrap();
        start_live_chat(&state, params).await;

        tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                let snapshot = current_status(&state).await;
                let a = snapshot
                    .providers
                    .iter()
                    .find(|provider| provider.id == "youtube-a")
                    .unwrap();
                let b = snapshot
                    .providers
                    .iter()
                    .find(|provider| provider.id == "youtube-b")
                    .unwrap();
                if a.state == LiveChatProviderConnectionState::Ended
                    && b.state == LiveChatProviderConnectionState::Connected
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("same-platform fake target states did not diverge");
        stop_live_chat(&state).await;
    }

    #[test]
    fn stop_session_marks_providers_ended_and_keeps_transcript() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
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
    fn youtube_chat_is_paused_until_google_approval() {
        let account = account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE]);
        let capability = chat_capability(StreamPlatform::Youtube, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::Unsupported);
        assert!(!capability.chat_read_available);
        assert!(capability.message.contains("Google approval"));
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
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::Available);
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);
    }

    #[test]
    fn twitch_read_and_write_scopes_are_modeled_separately() {
        let account = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);
    }

    #[test]
    fn stale_twitch_account_never_reports_ready_from_old_scopes() {
        let mut stale = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        stale.status = PlatformAccountStatus::NeedsReconnect;

        let capability = chat_capability(StreamPlatform::Twitch, Some(&stale));

        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert_eq!(capability.read, CommentsReadState::Unavailable);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);
        assert!(!capability.chat_read_available);
    }

    #[test]
    fn capability_list_prefers_connected_account_over_stale_first_row() {
        let mut stale = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        stale.id = "stale".to_string();
        stale.account_id = "stale-channel".to_string();
        stale.status = PlatformAccountStatus::NeedsReconnect;
        let mut connected = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        connected.id = "connected".to_string();
        connected.account_id = "connected-channel".to_string();

        let capability = chat_capabilities(&[stale, connected])
            .into_iter()
            .find(|capability| capability.platform == StreamPlatform::Twitch)
            .unwrap();

        assert_eq!(capability.account_id.as_deref(), Some("connected-channel"));
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);
    }

    #[test]
    fn x_without_account_is_not_connected_and_custom_has_no_comments() {
        let x = chat_capability(StreamPlatform::X, None);
        assert_eq!(x.state, ChatCapabilityState::NotConnected);
        assert_eq!(x.write, CommentsWriteState::ReadOnly);
        assert_eq!(
            chat_capability(StreamPlatform::Custom, None).state,
            ChatCapabilityState::Unsupported
        );
    }

    #[test]
    fn missing_account_reports_not_connected() {
        assert_eq!(
            chat_capability(StreamPlatform::Twitch, None).state,
            ChatCapabilityState::NotConnected
        );
    }

    #[test]
    fn capabilities_cover_every_native_platform() {
        let accounts = vec![account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE])];
        let capabilities = chat_capabilities(&accounts);
        assert_eq!(capabilities.len(), 3);
        assert_eq!(capabilities[0].platform, StreamPlatform::Youtube);
        assert_eq!(capabilities[0].state, ChatCapabilityState::Unsupported);
        assert_eq!(capabilities[1].platform, StreamPlatform::Twitch);
        assert_eq!(capabilities[1].state, ChatCapabilityState::NotConnected);
        assert_eq!(capabilities[2].platform, StreamPlatform::X);
        assert_eq!(capabilities[2].state, ChatCapabilityState::NotConnected);
    }

    #[tokio::test]
    async fn manual_x_destination_stays_failed_instead_of_waiting_for_native_context() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let snapshot = start_live_chat(
            &state,
            LiveChatStartParams {
                session_id: "manual-x-session".to_string(),
                platforms: vec![StreamPlatform::X],
                destinations: vec![LiveChatDestinationStart {
                    target_id: "x-manual".to_string(),
                    platform: StreamPlatform::X,
                    read: Some(CommentsReadState::Unavailable),
                    write: Some(CommentsWriteState::ReadOnly),
                    preparation_error: Some(
                        "Manual RTMP has no native X broadcast context.".to_string(),
                    ),
                }],
                fake: None,
                fakes: Vec::new(),
                youtube: None,
                twitch: None,
                x: None,
            },
        )
        .await;

        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Failed
        );
        assert_eq!(snapshot.providers[0].read, CommentsReadState::Unavailable);
        assert_eq!(snapshot.providers[0].write, CommentsWriteState::ReadOnly);
        assert!(snapshot.providers[0].message.contains("Manual RTMP"));
    }

    #[test]
    fn unavailable_youtube_approval_state_is_not_mislabeled_as_runtime_failure() {
        let providers = session_provider_rows(
            &[],
            &[],
            &[LiveChatDestinationStart {
                target_id: "youtube".to_string(),
                platform: StreamPlatform::Youtube,
                read: Some(CommentsReadState::Unavailable),
                write: Some(CommentsWriteState::Unavailable),
                preparation_error: Some(
                    "YouTube Comments are paused pending Google approval.".to_string(),
                ),
            }],
        );

        assert_eq!(providers[0].state, LiveChatProviderConnectionState::Failed);
        assert_eq!(providers[0].read, CommentsReadState::Unavailable);
        assert_eq!(providers[0].write, CommentsWriteState::Unavailable);
    }

    #[test]
    fn live_chat_message_round_trips_with_camel_case_and_kebab_event_type() {
        let message = LiveChatMessage {
            id: live_chat_message_id(
                "session-1",
                StreamPlatform::Youtube,
                Some("target-1"),
                "abc123",
            ),
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
        assert_eq!(message.id, "session-1:youtube:target-1:abc123");
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
            LiveChatProviderConnectionState::Unsupported
        );
        assert_eq!(
            snapshot.providers[2].state,
            LiveChatProviderConnectionState::Disabled
        );
    }

    #[test]
    fn delivery_matrix_keeps_read_only_and_unknown_truth() {
        let mut writable = provider_row(StreamPlatform::Twitch);
        writable.id = "tw-target".to_string();
        writable.target_id = Some("tw-target".to_string());
        writable.state = LiveChatProviderConnectionState::Connected;
        writable.read = CommentsReadState::Ready;
        writable.write = CommentsWriteState::Ready;
        let pending = initial_delivery_for_provider(&writable, true);
        assert_eq!(pending.phase, DestinationDeliveryPhase::Pending);

        let mut x = provider_row(StreamPlatform::X);
        x.id = "x-target".to_string();
        x.write = CommentsWriteState::ReadOnly;
        let read_only = initial_delivery_for_provider(&x, false);
        assert_eq!(read_only.phase, DestinationDeliveryPhase::ReadOnly);

        let mut operation = CommentsSendOperation {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "s1".to_string(),
            text: "hello".to_string(),
            phase: CommentsSendOperationPhase::Sending,
            destinations: vec![pending, read_only],
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };
        operation.mark_interrupted_unknown("later".to_string());
        assert_eq!(
            operation.destinations[0].phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(operation.phase, CommentsSendOperationPhase::DeliveryUnknown);
    }

    #[test]
    fn aggregate_send_phase_distinguishes_partial_from_unknown() {
        let delivery = |phase| DestinationDelivery {
            destination_id: format!("{phase:?}"),
            platform: StreamPlatform::Twitch,
            phase,
            provider_message_id: None,
            reason: None,
        };
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::TimedOutUnknown),
            ]),
            CommentsSendOperationPhase::Partial
        );
        assert_eq!(
            aggregate_send_phase(&[delivery(DestinationDeliveryPhase::TimedOutUnknown)]),
            CommentsSendOperationPhase::DeliveryUnknown
        );
        assert_eq!(
            aggregate_send_phase(&[delivery(DestinationDeliveryPhase::ReadOnly)]),
            CommentsSendOperationPhase::Failed
        );
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::ReadOnly),
            ]),
            CommentsSendOperationPhase::Partial
        );
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::Unavailable),
            ]),
            CommentsSendOperationPhase::Partial
        );
    }
}
