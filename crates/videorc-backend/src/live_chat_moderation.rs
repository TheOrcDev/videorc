//! Chat moderation (plan 140, S4): remove one message from its platform on
//! the streamer's request, safely and with an audit trail, or hide it locally
//! and say why.
//!
//! This is the first place Videorc deletes content on a platform for the
//! streamer, so the rules are strict:
//!
//! - Every removal is a durable `ModerationOperation` row in
//!   `live_chat_moderation_operations`, persisted before any provider call.
//!   The `operationId` is an idempotency key: the same id returns the same row.
//! - `Manual` requests (the row menu's "Remove from chat") are express consent
//!   and run at once. `BuddyVoice` requests start in `pending-confirm` and run
//!   only when confirmed, or when an opt-in 5 s countdown passes uncancelled.
//!   YouTube targets always need an explicit confirmation (API policy §III.E),
//!   so their countdown never runs.
//! - The backend owns every timer. A timer re-reads the row under the runtime
//!   lock before acting, so an answer that landed first always wins.
//! - On restart, `pending-confirm` becomes `cancelled` (never act after a
//!   restart) and `executing` becomes `delivery-unknown`.
//! - One operation is in flight per message, and at most 10 removals are
//!   requested per minute.
//! - One bounded retry on a transient failure (5xx, 429, network, timeout). A
//!   404 means the message is already gone and counts as removed.
//! - `orcle-voice` requests need Premium (`FeatureId::LiveCohost`), checked at
//!   request and again at execution, and obey the remote kill switch
//!   (`serviceFlags.orcle.remove`). Manual removal is free for everyone.
//!
//! # Outcomes and how a renderer row tells them apart
//!
//! Both outcomes below write a tombstone over the original row through the
//! normal inbound path (`try_deliver_messages`), which persists it, redacts the
//! text, clears the on-stream card and tells Buddy. The row keeps its app id;
//! `isDeleted` is true and `eventType` is `deleted` in both cases. They differ
//! in `rawProviderType` and `messageText`:
//!
//! | Outcome | `rawProviderType` | `messageText` | Viewers |
//! | --- | --- | --- | --- |
//! | The platform deleted it | `videorc.removed` | `Removed by you` | no longer see it |
//! | The platform could not delete it | `videorc.hidden` | `Hidden in Videorc` | still see it |
//!
//! A provider's own deletion keeps its provider type (for example Twitch's
//! `channel.chat.message_delete`). The matching `ModerationOperation` carries
//! the plain `outcome` sentence and the `outcomeCode`.
//!
//! YouTube 403s: `insufficientPermissions`/`authError` hide locally with
//! `missing-scope` (reconnect fixes it); any other 403 (YouTube refusing to
//! delete that particular message) hides locally with `provider-error`. Hiding
//! is the safest option: it never acts on the platform again, and the streamer
//! still gets what they asked for on their own screen with an honest note.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::live_chat::{
    ChatSenderConfig, FakeChatDeleteBehavior, FakeChatSendBehavior, LiveChatEventType,
    LiveChatMessage,
};
use crate::protocol::FeatureId;
use crate::state::AppState;
use crate::streaming::{StreamPlatform, stream_platform_label};

/// Event name for every change of a `ModerationOperation`. Never a LAN event.
pub const MODERATION_OPERATION_EVENT: &str = "liveChat.moderationOperation";

/// How long a Buddy removal card waits for an answer in confirm mode.
#[cfg(not(test))]
pub const CONFIRM_WINDOW: Duration = Duration::from_secs(20);
#[cfg(test)]
pub const CONFIRM_WINDOW: Duration = Duration::from_millis(250);

/// The opt-in countdown before an unanswered Buddy removal runs.
#[cfg(not(test))]
pub const COUNTDOWN: Duration = Duration::from_secs(5);
#[cfg(test)]
pub const COUNTDOWN: Duration = Duration::from_millis(120);

/// Per provider attempt, like `liveChat.send`.
#[cfg(not(test))]
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(test)]
const PROVIDER_TIMEOUT: Duration = Duration::from_millis(400);

/// At most this many removals may be requested in any rolling minute.
pub const RATE_LIMIT_PER_MINUTE: usize = 10;

/// `liveChat.moderationOperations.list` returns at most this many, newest first.
pub const LIST_LIMIT: usize = 200;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Audit excerpt and reason caps (UTF-16 units, like the Buddy copy caps).
pub const EXCERPT_MAX_UNITS: usize = 140;
pub const REASON_MAX_UNITS: usize = 40;

/// Attempts per execution: one try and one bounded retry.
const MAX_ATTEMPTS: u32 = 2;

/// The longest `outcome` sentence stored or emitted (UTF-16 units). A
/// provider's error text is echoed into it, and the renderer contract caps
/// the field at 2000; 500 keeps the card readable well inside that.
pub const OUTCOME_MAX_UNITS: usize = 500;

/// Tombstone text and provider types (see the module doc).
pub const REMOVED_BY_YOU_TEXT: &str = "Removed by you";
pub const HIDDEN_IN_VIDEORC_TEXT: &str = "Hidden in Videorc";
pub const REMOVED_PROVIDER_TYPE: &str = "videorc.removed";
pub const HIDDEN_PROVIDER_TYPE: &str = "videorc.hidden";

/// The kill switch's user-facing line (contract part D).
pub const REMOVE_PAUSED_MESSAGE: &str = "Removing messages is paused by Videorc.";
pub const PREMIUM_REQUIRED_MESSAGE: &str = "Buddy requires Videorc Premium.";

/// Restart sweep outcomes (storage writes them; the renderer shows them).
pub const RESTART_CANCELLED_OUTCOME: &str =
    "Videorc restarted before you answered. Nothing was removed.";
pub const RESTART_UNKNOWN_OUTCOME: &str =
    "Videorc restarted while removing this message. Check chat to see whether it was removed.";

// --- Wire types ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModerationSource {
    Manual,
    /// The wire value stays `orcle-voice` (plan 170 D22): saved reports, the
    /// strict RPC/IPC schemas and older apps carry it.
    #[serde(rename = "orcle-voice")]
    BuddyVoice,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoveConfirmMode {
    #[default]
    Confirm,
    Countdown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModerationPhase {
    PendingConfirm,
    Cancelled,
    Expired,
    Executing,
    Removed,
    HiddenLocally,
    Failed,
    DeliveryUnknown,
}

impl ModerationPhase {
    /// Nothing changes a terminal operation again.
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::PendingConfirm | Self::Executing)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModerationOutcomeCode {
    Removed,
    MissingScope,
    Unsupported,
    QuotaPaused,
    TooOld,
    ProviderError,
    NotFound,
}

/// One audited removal (wire, camelCase). Storage keeps `provider_message_id`
/// and `attempts` in their own columns; they never reach the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModerationOperation {
    pub operation_id: String,
    pub session_id: String,
    pub message_id: String,
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip)]
    pub provider_message_id: String,
    pub author_name: String,
    pub excerpt: String,
    pub source: ModerationSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub phase: ModerationPhase,
    pub confirm_mode: RemoveConfirmMode,
    pub requires_explicit_confirm: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_code: Option<ModerationOutcomeCode>,
    #[serde(skip)]
    pub attempts: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// The engine's request shape (contract part A), used by S3 and the RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModerationRequest {
    /// UUID v4 minted by the caller: the idempotency key.
    pub operation_id: String,
    /// The app message id (`live_chat_messages.id`).
    pub message_id: String,
    pub source: ModerationSource,
    /// Audit only, at most 40 characters ("toxic", "spam").
    pub reason: Option<String>,
    /// Ignored for `Manual`, which runs at once.
    pub confirm_mode: RemoveConfirmMode,
}

/// `liveChat.moderation.request` params (wire mirror of `ModerationRequest`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationRequestParams {
    pub operation_id: String,
    pub message_id: String,
    pub source: ModerationSource,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub confirm_mode: Option<RemoveConfirmMode>,
}

impl From<ModerationRequestParams> for ModerationRequest {
    fn from(params: ModerationRequestParams) -> Self {
        Self {
            operation_id: params.operation_id,
            message_id: params.message_id,
            source: params.source,
            reason: params.reason,
            confirm_mode: params.confirm_mode.unwrap_or_default(),
        }
    }
}

/// `liveChat.moderation.confirm` and `liveChat.moderation.cancel` params.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationOperationParams {
    pub operation_id: String,
}

/// Why a request, confirm or cancel was refused. `code` is one of the closed
/// set in contract part A.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModerationRefusal {
    pub code: &'static str,
    pub message: String,
}

impl ModerationRefusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ModerationRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

/// What one provider delete attempt came back with. Providers return the
/// actionable tail of a hide reason ("Reconnect Twitch to let Buddy remove
/// messages."); the engine prefixes the "Hidden in Videorc" sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderDeleteOutcome {
    /// The platform confirmed the deletion.
    Deleted,
    /// The platform no longer has the message: it is already gone.
    NotFound,
    /// The platform cannot delete this message now; hide it locally.
    CannotDelete {
        code: ModerationOutcomeCode,
        reason: String,
    },
    /// Worth one retry (5xx, 429, network).
    Transient(String),
    /// A permanent refusal, or an invalid request that was never sent.
    Failed(String),
}

// --- Runtime slot -------------------------------------------------------------------

type PremiumCheck = Arc<dyn Fn() -> bool + Send + Sync>;

/// In-memory state next to the durable rows: the one-in-flight-per-message
/// index, the timers, the rate limiter and the Premium check (a seam for tests).
pub struct ModerationRuntime {
    /// Operation id by message id for every non-terminal operation.
    pending_by_message: HashMap<String, String>,
    /// Expiry and countdown tasks by operation id; aborted when answered.
    timers: HashMap<String, tokio::task::JoinHandle<()>>,
    /// When each accepted request arrived, for the rolling-minute limit.
    recent_requests: VecDeque<Instant>,
    premium_check: PremiumCheck,
}

pub type ModerationSlot = Arc<tokio::sync::Mutex<ModerationRuntime>>;

pub fn new_moderation_slot() -> ModerationSlot {
    Arc::new(tokio::sync::Mutex::new(ModerationRuntime {
        pending_by_message: HashMap::new(),
        timers: HashMap::new(),
        recent_requests: VecDeque::new(),
        premium_check: Arc::new(premium_entitled),
    }))
}

fn premium_entitled() -> bool {
    crate::entitlements::require_feature(
        &crate::entitlements::current_entitlements(),
        FeatureId::LiveCohost,
    )
    .is_ok()
}

impl ModerationRuntime {
    fn rate_limited(&mut self, now: Instant) -> bool {
        while let Some(oldest) = self.recent_requests.front() {
            if now.duration_since(*oldest) >= RATE_LIMIT_WINDOW {
                self.recent_requests.pop_front();
            } else {
                break;
            }
        }
        self.recent_requests.len() >= RATE_LIMIT_PER_MINUTE
    }

    fn forget(&mut self, operation: &ModerationOperation) {
        if let Some(handle) = self.timers.remove(&operation.operation_id) {
            handle.abort();
        }
        if self
            .pending_by_message
            .get(&operation.message_id)
            .is_some_and(|pending| pending == &operation.operation_id)
        {
            self.pending_by_message.remove(&operation.message_id);
        }
    }
}

/// Test seam: swap the Premium check so a Basic account can be simulated
/// without touching the process-wide entitlement hydration.
#[cfg(test)]
pub(crate) async fn set_premium_check_for_tests(state: &AppState, check: PremiumCheck) {
    state.live_chat_moderation.lock().await.premium_check = check;
}

// --- Pure rules (unit-tested) ----------------------------------------------------------

/// Only chat and paid rows that still exist, from someone other than the
/// streamer, can be removed. Notification rows never can.
pub(crate) fn eligibility(message: &LiveChatMessage) -> Result<(), ModerationRefusal> {
    if message.is_deleted || message.event_type == LiveChatEventType::Deleted {
        return Err(ModerationRefusal::new(
            "not-eligible",
            "This message is already removed.",
        ));
    }
    if !matches!(
        message.event_type,
        LiveChatEventType::Message | LiveChatEventType::Paid
    ) || message
        .raw_provider_type
        .as_deref()
        .is_some_and(|kind| kind.starts_with("channel.chat.notification"))
    {
        return Err(ModerationRefusal::new(
            "not-eligible",
            "Only chat messages can be removed.",
        ));
    }
    if message.author_roles.iter().any(|role| {
        matches!(
            role.trim().to_ascii_lowercase().as_str(),
            "owner" | "broadcaster"
        )
    }) {
        return Err(ModerationRefusal::new(
            "not-eligible",
            "Your own messages are never removed.",
        ));
    }
    Ok(())
}

/// The opening phase and timing of a new operation (contract part A).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Schedule {
    pub phase: ModerationPhase,
    pub requires_explicit_confirm: bool,
    pub confirm_by: Option<DateTime<Utc>>,
    pub execute_at: Option<DateTime<Utc>>,
}

pub(crate) fn initial_schedule(
    source: ModerationSource,
    platform: StreamPlatform,
    confirm_mode: RemoveConfirmMode,
    now: DateTime<Utc>,
) -> Schedule {
    match source {
        ModerationSource::Manual => Schedule {
            phase: ModerationPhase::Executing,
            requires_explicit_confirm: false,
            confirm_by: None,
            execute_at: None,
        },
        ModerationSource::BuddyVoice => {
            // YouTube's express-consent rule: the countdown never runs there.
            let explicit =
                confirm_mode == RemoveConfirmMode::Confirm || platform == StreamPlatform::Youtube;
            if explicit {
                Schedule {
                    phase: ModerationPhase::PendingConfirm,
                    requires_explicit_confirm: true,
                    confirm_by: Some(now + chrono_duration(CONFIRM_WINDOW)),
                    execute_at: None,
                }
            } else {
                Schedule {
                    phase: ModerationPhase::PendingConfirm,
                    requires_explicit_confirm: false,
                    confirm_by: None,
                    execute_at: Some(now + chrono_duration(COUNTDOWN)),
                }
            }
        }
    }
}

fn chrono_duration(duration: Duration) -> chrono::Duration {
    chrono::Duration::milliseconds(i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
}

/// What the tombstone says and how a row recognises it (module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalTombstoneKind {
    Removed,
    Hidden,
}

/// The same app id, author and position; the content is gone.
pub(crate) fn removal_tombstone(
    original: &LiveChatMessage,
    kind: LocalTombstoneKind,
) -> LiveChatMessage {
    let mut tombstone = original.clone();
    tombstone.message_text = match kind {
        LocalTombstoneKind::Removed => REMOVED_BY_YOU_TEXT,
        LocalTombstoneKind::Hidden => HIDDEN_IN_VIDEORC_TEXT,
    }
    .to_string();
    tombstone.fragments.clear();
    tombstone.amount_text = None;
    tombstone.event_type = LiveChatEventType::Deleted;
    tombstone.is_deleted = true;
    tombstone.raw_provider_type = Some(
        match kind {
            LocalTombstoneKind::Removed => REMOVED_PROVIDER_TYPE,
            LocalTombstoneKind::Hidden => HIDDEN_PROVIDER_TYPE,
        }
        .to_string(),
    );
    tombstone.details = None;
    tombstone.reply = None;
    tombstone.first_message = false;
    tombstone
}

fn hidden_outcome(platform: StreamPlatform, reason: &str) -> String {
    format!(
        "{HIDDEN_IN_VIDEORC_TEXT}. Viewers on {} still see it. {reason}",
        stream_platform_label(platform)
    )
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

// --- Public API (contract part A) -----------------------------------------------------

/// Start a removal. `Manual` runs at once and returns the terminal operation;
/// `BuddyVoice` returns the pending operation and the backend owns its timer.
pub async fn request(
    state: &AppState,
    req: ModerationRequest,
) -> Result<ModerationOperation, ModerationRefusal> {
    if uuid::Uuid::parse_str(req.operation_id.trim()).is_err() {
        return Err(ModerationRefusal::new(
            "invalid-params",
            "operationId must be a UUID.",
        ));
    }
    let operation_id = req.operation_id.trim().to_string();
    let message_id = req.message_id.trim().to_string();
    if message_id.is_empty() {
        return Err(ModerationRefusal::new(
            "invalid-params",
            "messageId is required.",
        ));
    }
    let reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(|reason| crate::cohost::truncate_utf16(reason, REASON_MAX_UNITS));

    // Idempotency first: the same id answers the same way, before any gate.
    if let Some(existing) = state
        .database
        .get_chat_moderation_operation(&operation_id)
        .map_err(|error| {
            ModerationRefusal::new(
                "invalid-params",
                format!("Could not read the moderation operation: {error}"),
            )
        })?
    {
        if existing.message_id != message_id {
            return Err(ModerationRefusal::new(
                "invalid-params",
                format!("operationId {operation_id} is already bound to a different message."),
            ));
        }
        return Ok(existing);
    }

    if req.source == ModerationSource::BuddyVoice {
        if !crate::service_flags::buddy_remove_enabled(state) {
            return Err(ModerationRefusal::new("disabled", REMOVE_PAUSED_MESSAGE));
        }
        let premium = state
            .live_chat_moderation
            .lock()
            .await
            .premium_check
            .clone();
        if !premium() {
            return Err(ModerationRefusal::new(
                "premium-required",
                PREMIUM_REQUIRED_MESSAGE,
            ));
        }
    }

    let (message, session_id) = find_live_message(state, &message_id).await?;
    eligibility(&message)?;

    let now = Utc::now();
    let schedule = initial_schedule(req.source, message.platform, req.confirm_mode, now);
    let now_iso = now.to_rfc3339();
    let operation = ModerationOperation {
        operation_id: operation_id.clone(),
        session_id,
        message_id: message.id.clone(),
        platform: message.platform,
        target_id: message.target_id.clone(),
        provider_message_id: message.provider_message_id.clone(),
        author_name: message.author_name.clone(),
        excerpt: crate::cohost::truncate_utf16(message.message_text.trim(), EXCERPT_MAX_UNITS),
        source: req.source,
        reason,
        phase: schedule.phase,
        confirm_mode: req.confirm_mode,
        requires_explicit_confirm: schedule.requires_explicit_confirm,
        confirm_by: schedule.confirm_by.map(|at| at.to_rfc3339()),
        execute_at: schedule.execute_at.map(|at| at.to_rfc3339()),
        outcome: None,
        outcome_code: None,
        attempts: 0,
        created_at: now_iso.clone(),
        updated_at: now_iso,
    };

    {
        let mut runtime = state.live_chat_moderation.lock().await;
        // A concurrent request with the same id may have landed meanwhile.
        if let Ok(Some(existing)) = state.database.get_chat_moderation_operation(&operation_id) {
            if existing.message_id != message_id {
                return Err(ModerationRefusal::new(
                    "invalid-params",
                    format!("operationId {operation_id} is already bound to a different message."),
                ));
            }
            return Ok(existing);
        }
        if runtime
            .pending_by_message
            .contains_key(&operation.message_id)
        {
            return Err(ModerationRefusal::new(
                "already-pending",
                "A removal for this message is already in progress.",
            ));
        }
        if runtime.rate_limited(Instant::now()) {
            return Err(ModerationRefusal::new(
                "rate-limited",
                format!("At most {RATE_LIMIT_PER_MINUTE} messages can be removed per minute."),
            ));
        }
        state
            .database
            .save_chat_moderation_operation(&operation)
            .map_err(|error| {
                ModerationRefusal::new(
                    "invalid-params",
                    format!("Could not persist the moderation operation: {error}"),
                )
            })?;
        runtime.recent_requests.push_back(Instant::now());
        runtime
            .pending_by_message
            .insert(operation.message_id.clone(), operation_id.clone());
        state.emit_event(MODERATION_OPERATION_EVENT, operation.clone());
        crate::cohost::note_moderation_operation(state, &operation);
        if operation.phase == ModerationPhase::PendingConfirm {
            let timer = if let Some(execute_at) = schedule.execute_at {
                spawn_timer(
                    state.clone(),
                    operation_id.clone(),
                    execute_at,
                    TimerAction::Run,
                )
            } else {
                let confirm_by = schedule.confirm_by.unwrap_or(now);
                spawn_timer(
                    state.clone(),
                    operation_id.clone(),
                    confirm_by,
                    TimerAction::Expire,
                )
            };
            runtime.timers.insert(operation_id.clone(), timer);
        }
    }

    if operation.phase == ModerationPhase::Executing {
        return Ok(run_execution(state, operation).await);
    }
    Ok(operation)
}

/// Confirm a pending removal and run it. Returns the terminal operation.
pub async fn confirm(
    state: &AppState,
    operation_id: &str,
) -> Result<ModerationOperation, ModerationRefusal> {
    let operation = begin_execution(state, operation_id, ExecutionCaller::Answer).await?;
    Ok(run_execution(state, operation).await)
}

/// Cancel a pending removal. Nothing is removed.
pub async fn cancel(
    state: &AppState,
    operation_id: &str,
) -> Result<ModerationOperation, ModerationRefusal> {
    let mut runtime = state.live_chat_moderation.lock().await;
    let mut operation = load(state, operation_id)?;
    if operation.phase != ModerationPhase::PendingConfirm {
        return Err(ModerationRefusal::new(
            "not-pending",
            "This removal is no longer waiting for an answer.",
        ));
    }
    operation.phase = ModerationPhase::Cancelled;
    operation.outcome = Some("Cancelled. Nothing was removed.".to_string());
    finish_locked(state, &mut runtime, &mut operation);
    Ok(operation)
}

/// The chat session ended: every removal still waiting for an answer is
/// cancelled, because nothing may act on a session that is over.
pub(crate) fn note_session_ended(state: &AppState, session_id: String) {
    let state = state.clone();
    tokio::spawn(async move {
        let mut runtime = state.live_chat_moderation.lock().await;
        let pending: Vec<String> = runtime.pending_by_message.values().cloned().collect();
        for operation_id in pending {
            let Ok(mut operation) = load(&state, &operation_id) else {
                continue;
            };
            if operation.session_id != session_id
                || operation.phase != ModerationPhase::PendingConfirm
            {
                continue;
            }
            operation.phase = ModerationPhase::Cancelled;
            operation.outcome = Some("The chat session ended. Nothing was removed.".to_string());
            finish_locked(&state, &mut runtime, &mut operation);
        }
    });
}

// --- Internals -------------------------------------------------------------------------

fn load(state: &AppState, operation_id: &str) -> Result<ModerationOperation, ModerationRefusal> {
    state
        .database
        .get_chat_moderation_operation(operation_id.trim())
        .map_err(|error| {
            ModerationRefusal::new(
                "invalid-params",
                format!("Could not read the moderation operation: {error}"),
            )
        })?
        .ok_or_else(|| ModerationRefusal::new("not-found", "No such removal operation."))
}

/// The message in the active chat session, from the buffer or SQLite, with
/// the session id it belongs to.
async fn find_live_message(
    state: &AppState,
    message_id: &str,
) -> Result<(LiveChatMessage, String), ModerationRefusal> {
    let (buffered, session_id) = {
        let coordinator = state.live_chat.lock().await;
        let Some(session_id) = coordinator.session_id() else {
            return Err(ModerationRefusal::new(
                "not-found",
                "No live chat session is running.",
            ));
        };
        (
            coordinator.message(message_id).cloned(),
            session_id.to_string(),
        )
    };
    let message = match buffered {
        Some(message) => message,
        None => state
            .database
            .get_live_chat_message(message_id)
            .map_err(|error| {
                ModerationRefusal::new("not-found", format!("Could not read the message: {error}"))
            })?
            .ok_or_else(|| ModerationRefusal::new("not-found", "This message is not in chat."))?,
    };
    if message.session_id != session_id {
        return Err(ModerationRefusal::new(
            "not-found",
            "This message is not in the live chat session.",
        ));
    }
    Ok((message, session_id))
}

/// Terminal bookkeeping under the runtime lock: persist, emit, forget.
fn finish_locked(
    state: &AppState,
    runtime: &mut ModerationRuntime,
    operation: &mut ModerationOperation,
) {
    operation.updated_at = now_iso();
    cap_outcome(operation);
    if let Err(error) = state.database.save_chat_moderation_operation(operation) {
        state.emit_log(
            "warn",
            format!(
                "Could not persist moderation operation {}: {error}",
                operation.operation_id
            ),
        );
    }
    if operation.phase.is_terminal() {
        runtime.forget(operation);
    }
    state.emit_event(MODERATION_OPERATION_EVENT, operation.clone());
    crate::cohost::note_moderation_operation(state, operation);
}

/// Cut a long `outcome` (a provider's error text can be any length) to
/// `OUTCOME_MAX_UNITS`, ending in an ellipsis.
fn cap_outcome(operation: &mut ModerationOperation) {
    let Some(outcome) = operation.outcome.as_mut() else {
        return;
    };
    if outcome.encode_utf16().count() <= OUTCOME_MAX_UNITS {
        return;
    }
    let mut capped = crate::cohost::truncate_utf16(outcome, OUTCOME_MAX_UNITS - 1);
    capped.push('\u{2026}');
    *outcome = capped;
}

/// Who moves a pending operation to `executing`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutionCaller {
    /// A confirm answer: the operation's timer is aborted.
    Answer,
    /// The countdown timer itself. Its handle is only forgotten: aborting a
    /// task's own handle cancels it at its next await, which would strand
    /// the operation in `executing` mid provider call.
    CountdownTimer,
}

/// Move a pending operation to `executing` under the lock, retiring its timer.
async fn begin_execution(
    state: &AppState,
    operation_id: &str,
    caller: ExecutionCaller,
) -> Result<ModerationOperation, ModerationRefusal> {
    let mut runtime = state.live_chat_moderation.lock().await;
    let mut operation = load(state, operation_id)?;
    if operation.phase != ModerationPhase::PendingConfirm {
        return Err(ModerationRefusal::new(
            "not-pending",
            "This removal is no longer waiting for an answer.",
        ));
    }
    if let Some(handle) = runtime.timers.remove(&operation.operation_id)
        && caller == ExecutionCaller::Answer
    {
        handle.abort();
    }
    operation.phase = ModerationPhase::Executing;
    operation.updated_at = now_iso();
    state
        .database
        .save_chat_moderation_operation(&operation)
        .map_err(|error| {
            ModerationRefusal::new(
                "invalid-params",
                format!("Could not persist the moderation operation: {error}"),
            )
        })?;
    runtime
        .pending_by_message
        .insert(operation.message_id.clone(), operation.operation_id.clone());
    state.emit_event(MODERATION_OPERATION_EVENT, operation.clone());
    crate::cohost::note_moderation_operation(state, &operation);
    Ok(operation)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimerAction {
    /// Confirm mode: nobody answered, the operation expires.
    Expire,
    /// Countdown mode: nobody cancelled, the operation runs.
    Run,
}

/// The backend-owned timer. It re-reads the row under the lock before acting,
/// so an answer that arrived first always wins.
fn spawn_timer(
    state: AppState,
    operation_id: String,
    at: DateTime<Utc>,
    action: TimerAction,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let wait = (at - Utc::now()).to_std().unwrap_or(Duration::ZERO);
        tokio::time::sleep(wait).await;
        match action {
            TimerAction::Expire => {
                let mut runtime = state.live_chat_moderation.lock().await;
                let Ok(mut operation) = load(&state, &operation_id) else {
                    return;
                };
                if operation.phase != ModerationPhase::PendingConfirm {
                    return;
                }
                // Forget this timer's own handle without aborting it (see
                // `ExecutionCaller::CountdownTimer`).
                runtime.timers.remove(&operation_id);
                operation.phase = ModerationPhase::Expired;
                operation.outcome = Some(format!(
                    "No answer in {} seconds. Nothing was removed.",
                    CONFIRM_WINDOW.as_secs().max(1)
                ));
                finish_locked(&state, &mut runtime, &mut operation);
            }
            TimerAction::Run => {
                let Ok(operation) =
                    begin_execution(&state, &operation_id, ExecutionCaller::CountdownTimer).await
                else {
                    return;
                };
                run_execution(&state, operation).await;
            }
        }
    })
}

/// Run one `executing` operation to its terminal phase: gates, the provider
/// call with its bounded retry, the local tombstone and the Buddy flag.
async fn run_execution(
    state: &AppState,
    mut operation: ModerationOperation,
) -> ModerationOperation {
    debug_assert_eq!(operation.phase, ModerationPhase::Executing);
    let label = stream_platform_label(operation.platform);

    // Voice-sourced removals re-check Premium and the kill switch at execution.
    if operation.source == ModerationSource::BuddyVoice {
        if !crate::service_flags::buddy_remove_enabled(state) {
            operation.phase = ModerationPhase::Cancelled;
            operation.outcome = Some(format!("{REMOVE_PAUSED_MESSAGE} Nothing was removed."));
            return finish(state, operation).await;
        }
        let premium = state
            .live_chat_moderation
            .lock()
            .await
            .premium_check
            .clone();
        if !premium() {
            operation.phase = ModerationPhase::Cancelled;
            operation.outcome = Some(format!("{PREMIUM_REQUIRED_MESSAGE} Nothing was removed."));
            return finish(state, operation).await;
        }
    }

    // The message and its destination's credentials, from the live session.
    let (message, sender, session_generation) = {
        let coordinator = state.live_chat.lock().await;
        if coordinator.session_id() != Some(operation.session_id.as_str()) {
            drop(coordinator);
            operation.phase = ModerationPhase::Failed;
            operation.outcome =
                Some("The chat session ended before the message could be removed.".to_string());
            return finish(state, operation).await;
        }
        let destination_id = crate::live_chat::comments_destination_id(
            operation.platform,
            operation.target_id.as_deref(),
        );
        (
            coordinator.message(&operation.message_id).cloned(),
            coordinator.sender(&destination_id),
            coordinator.session_generation(),
        )
    };
    let message = match message {
        Some(message) => Some(message),
        None => state
            .database
            .get_live_chat_message(&operation.message_id)
            .ok()
            .flatten(),
    };
    let Some(message) = message.filter(|message| message.session_id == operation.session_id) else {
        operation.phase = ModerationPhase::Failed;
        operation.outcome = Some("The message is no longer available.".to_string());
        return finish(state, operation).await;
    };
    if message.is_deleted {
        operation.phase = ModerationPhase::Removed;
        operation.outcome_code = Some(ModerationOutcomeCode::NotFound);
        operation.outcome = Some("The message was already removed.".to_string());
        return finish(state, operation).await;
    }

    // Twitch only deletes messages under six hours old: hide, never call.
    if operation.platform == StreamPlatform::Twitch
        && crate::twitch_chat::twitch_message_too_old(&message.published_at, Utc::now())
    {
        return hide_locally(
            state,
            operation,
            &message,
            ModerationOutcomeCode::TooOld,
            crate::twitch_chat::TWITCH_TOO_OLD_REASON,
        )
        .await;
    }

    let Some(sender) = sender else {
        let (code, reason) = match operation.platform {
            StreamPlatform::X => (
                ModerationOutcomeCode::Unsupported,
                "X only removes messages while the broadcast is live.".to_string(),
            ),
            StreamPlatform::Youtube | StreamPlatform::Twitch | StreamPlatform::Kick => (
                ModerationOutcomeCode::MissingScope,
                format!("Reconnect {label} to let Buddy remove messages."),
            ),
            _ => (
                ModerationOutcomeCode::Unsupported,
                format!("{label} has no way to remove messages."),
            ),
        };
        return hide_locally(state, operation, &message, code, &reason).await;
    };

    let client = reqwest::Client::new();
    let mut resolved: Option<ProviderDeleteOutcome> = None;
    // A timed-out attempt may have removed the message after all: unless a
    // later attempt gets a definite answer, the result is unknown, never a
    // plain failure.
    let mut timed_out = false;
    while operation.attempts < MAX_ATTEMPTS {
        operation.attempts += 1;
        let fresh =
            crate::live_chat::with_current_sender_token(state, &client, sender.clone()).await;
        let attempt = tokio::time::timeout(
            PROVIDER_TIMEOUT,
            delete_once(state, &client, fresh, &message),
        )
        .await;
        match attempt {
            Ok(ProviderDeleteOutcome::Transient(reason)) => {
                state.emit_log(
                    "warn",
                    format!(
                        "{label} removal attempt {} failed, {}: {reason}",
                        operation.attempts,
                        if operation.attempts < MAX_ATTEMPTS {
                            "retrying once"
                        } else {
                            "giving up"
                        }
                    ),
                );
                resolved = Some(ProviderDeleteOutcome::Transient(reason));
            }
            Ok(outcome) => {
                resolved = Some(outcome);
                break;
            }
            Err(_elapsed) => {
                state.emit_log(
                    "warn",
                    format!(
                        "{label} removal attempt {} timed out after {} ms",
                        operation.attempts,
                        PROVIDER_TIMEOUT.as_millis()
                    ),
                );
                timed_out = true;
                resolved = None;
            }
        }
    }
    let definite = matches!(
        resolved,
        Some(
            ProviderDeleteOutcome::Deleted
                | ProviderDeleteOutcome::NotFound
                | ProviderDeleteOutcome::CannotDelete { .. }
        )
    );
    if timed_out && !definite {
        resolved = None;
    }

    match resolved {
        Some(ProviderDeleteOutcome::Deleted) => {
            mark_removed(
                state,
                operation,
                &message,
                session_generation,
                ModerationOutcomeCode::Removed,
                format!("Removed from {label}."),
            )
            .await
        }
        Some(ProviderDeleteOutcome::NotFound) => {
            mark_removed(
                state,
                operation,
                &message,
                session_generation,
                ModerationOutcomeCode::NotFound,
                format!("The message was already gone on {label}."),
            )
            .await
        }
        Some(ProviderDeleteOutcome::CannotDelete { code, reason }) => {
            hide_locally(state, operation, &message, code, &reason).await
        }
        Some(ProviderDeleteOutcome::Transient(reason))
        | Some(ProviderDeleteOutcome::Failed(reason)) => {
            operation.phase = ModerationPhase::Failed;
            operation.outcome_code = Some(ModerationOutcomeCode::ProviderError);
            operation.outcome = Some(reason);
            finish(state, operation).await
        }
        None => {
            operation.phase = ModerationPhase::DeliveryUnknown;
            operation.outcome_code = Some(ModerationOutcomeCode::ProviderError);
            operation.outcome = Some(format!(
                "{label} did not answer in time. Check chat to see whether it was removed."
            ));
            finish(state, operation).await
        }
    }
}

/// The platform deleted it (or never had it): tombstone the row as
/// "Removed by you" and resolve the Buddy flag.
async fn mark_removed(
    state: &AppState,
    mut operation: ModerationOperation,
    message: &LiveChatMessage,
    session_generation: u64,
    code: ModerationOutcomeCode,
    outcome: String,
) -> ModerationOperation {
    let tombstone = removal_tombstone(message, LocalTombstoneKind::Removed);
    if let Err(error) =
        crate::live_chat::try_deliver_messages(state, session_generation, vec![tombstone]).await
    {
        // The platform did remove it; only the local row lags behind.
        state.emit_log(
            "warn",
            format!(
                "Removed {} on {} but could not update the local row: {error}",
                operation.message_id,
                stream_platform_label(operation.platform)
            ),
        );
    }
    crate::cohost::resolve_flag_for_removed_message(
        state,
        &operation.session_id,
        &operation.message_id,
    )
    .await;
    operation.phase = ModerationPhase::Removed;
    operation.outcome_code = Some(code);
    operation.outcome = Some(outcome);
    finish(state, operation).await
}

/// The platform cannot delete it: tombstone the row as "Hidden in Videorc"
/// and say plainly that viewers still see it.
async fn hide_locally(
    state: &AppState,
    mut operation: ModerationOperation,
    message: &LiveChatMessage,
    code: ModerationOutcomeCode,
    reason: &str,
) -> ModerationOperation {
    let session_generation = state.live_chat.lock().await.session_generation();
    let tombstone = removal_tombstone(message, LocalTombstoneKind::Hidden);
    match crate::live_chat::try_deliver_messages(state, session_generation, vec![tombstone]).await {
        Ok(()) => {
            crate::cohost::resolve_flag_for_removed_message(
                state,
                &operation.session_id,
                &operation.message_id,
            )
            .await;
            operation.phase = ModerationPhase::HiddenLocally;
            operation.outcome_code = Some(code);
            operation.outcome = Some(hidden_outcome(operation.platform, reason));
        }
        Err(error) => {
            operation.phase = ModerationPhase::Failed;
            operation.outcome_code = Some(code);
            operation.outcome = Some(format!(
                "Could not hide the message in Videorc: {error}. {reason}"
            ));
        }
    }
    finish(state, operation).await
}

async fn finish(state: &AppState, mut operation: ModerationOperation) -> ModerationOperation {
    let mut runtime = state.live_chat_moderation.lock().await;
    finish_locked(state, &mut runtime, &mut operation);
    operation
}

/// One provider attempt. Every real call reuses the session's send
/// credentials, refreshed by the caller through `with_current_sender_token`.
async fn delete_once(
    state: &AppState,
    client: &reqwest::Client,
    sender: ChatSenderConfig,
    message: &LiveChatMessage,
) -> ProviderDeleteOutcome {
    match sender {
        ChatSenderConfig::YouTube {
            access_token,
            api_base_url,
            ..
        } => {
            crate::youtube_chat::delete_youtube_chat_message_guarded(
                state,
                client,
                api_base_url.as_deref(),
                &access_token,
                &message.provider_message_id,
            )
            .await
        }
        ChatSenderConfig::Twitch(config) => {
            crate::twitch_chat::delete_twitch_chat_message(
                client,
                &config,
                &message.provider_message_id,
            )
            .await
        }
        ChatSenderConfig::Kick(config) => {
            crate::kick_chat::delete_kick_chat_message(
                client,
                &config,
                &message.provider_message_id,
            )
            .await
        }
        ChatSenderConfig::X { broadcast_id } => {
            let Some(credentials) = crate::x_live::x_livestream_credentials().ok().flatten() else {
                return ProviderDeleteOutcome::CannotDelete {
                    code: ModerationOutcomeCode::MissingScope,
                    reason: "Authorize X Live to let Buddy remove messages.".to_string(),
                };
            };
            crate::x_live::delete_broadcast_chat_message(
                client,
                &credentials,
                crate::x_live::DEFAULT_API_BASE_URL,
                &broadcast_id,
                &message.provider_message_id,
            )
            .await
        }
        ChatSenderConfig::Fake(behavior) => fake_delete(behavior).await,
        ChatSenderConfig::FakeModerated { delete, .. } => {
            fake_scripted_delete(delete, message.platform)
        }
        #[cfg(test)]
        ChatSenderConfig::FakeProbe { behavior, .. } => fake_delete(behavior).await,
    }
}

/// A fake destination's scripted removal outcome (plan 140 S9's smoke).
fn fake_scripted_delete(
    behavior: FakeChatDeleteBehavior,
    platform: StreamPlatform,
) -> ProviderDeleteOutcome {
    match behavior {
        FakeChatDeleteBehavior::Ok => ProviderDeleteOutcome::Deleted,
        FakeChatDeleteBehavior::NotFound => ProviderDeleteOutcome::NotFound,
        FakeChatDeleteBehavior::MissingScope => ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::MissingScope,
            reason: format!(
                "Reconnect {} to let Buddy remove messages.",
                stream_platform_label(platform)
            ),
        },
    }
}

/// The in-process fake connectors mirror their send behaviour.
async fn fake_delete(behavior: FakeChatSendBehavior) -> ProviderDeleteOutcome {
    match behavior {
        FakeChatSendBehavior::Sent => ProviderDeleteOutcome::Deleted,
        FakeChatSendBehavior::Failed => {
            ProviderDeleteOutcome::Failed("Fake provider refused the removal.".to_string())
        }
        FakeChatSendBehavior::Timeout => {
            tokio::time::sleep(PROVIDER_TIMEOUT + Duration::from_millis(100)).await;
            ProviderDeleteOutcome::Deleted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_chat::{
        CommentsReadState, CommentsWriteState, LiveChatProviderConnectionState,
        LiveChatProviderState, live_chat_message_id,
    };
    use crate::storage::Database;
    use axum::Router;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::delete;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::broadcast;

    const SESSION: &str = "mod-session";

    /// A state with a session row and Premium granted (the real check reads
    /// the process-wide hydration, which a parallel test run must not share).
    fn test_state() -> (AppState, broadcast::Receiver<crate::protocol::ServerEvent>) {
        let (events, receiver) = broadcast::channel(256);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .database
            .ensure_fake_live_chat_session(SESSION)
            .unwrap();
        state
            .live_chat_moderation
            .try_lock()
            .expect("fresh moderation slot")
            .premium_check = Arc::new(|| true);
        (state, receiver)
    }

    fn provider_row(platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            id: crate::streaming::stream_platform_id(platform).to_string(),
            platform,
            target_id: None,
            account_id: None,
            account_label: None,
            read: CommentsReadState::Ready,
            write: CommentsWriteState::Ready,
            moderate: None,
            state: LiveChatProviderConnectionState::Connected,
            message: "ready".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    fn message(platform: StreamPlatform, seq: u32) -> LiveChatMessage {
        let provider_message_id = format!("provider-{seq}");
        let now = Utc::now().to_rfc3339();
        LiveChatMessage {
            id: live_chat_message_id(SESSION, platform, None, &provider_message_id),
            provider_message_id,
            platform,
            target_id: None,
            session_id: SESSION.to_string(),
            author_id: Some(format!("author-{seq}")),
            author_name: format!("viewer_{seq}"),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_affiliation: None,
            author_verified: None,
            author_roles: Vec::new(),
            published_at: now.clone(),
            received_at: now,
            message_text: format!("message number {seq} with some words"),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("fake".to_string()),
            details: None,
            reply: None,
            first_message: false,
        }
    }

    /// A running chat session on `platform` holding `message`, with `sender`
    /// registered as its destination credentials.
    async fn seed(
        state: &AppState,
        platform: StreamPlatform,
        sender: Option<ChatSenderConfig>,
        messages: &[LiveChatMessage],
    ) {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(SESSION.to_string(), vec![provider_row(platform)]);
        if let Some(sender) = sender {
            coordinator.register_sender(
                crate::streaming::stream_platform_id(platform).to_string(),
                sender,
            );
        }
        for message in messages {
            coordinator.ingest(message.clone());
            state.database.save_live_chat_message(message).unwrap();
        }
    }

    fn request_for(message: &LiveChatMessage, source: ModerationSource) -> ModerationRequest {
        ModerationRequest {
            operation_id: uuid::Uuid::new_v4().to_string(),
            message_id: message.id.clone(),
            source,
            reason: Some("toxic".to_string()),
            confirm_mode: RemoveConfirmMode::Confirm,
        }
    }

    async fn stored_message(state: &AppState, id: &str) -> LiveChatMessage {
        state.database.get_live_chat_message(id).unwrap().unwrap()
    }

    async fn buffered_message(state: &AppState, id: &str) -> LiveChatMessage {
        state.live_chat.lock().await.message(id).cloned().unwrap()
    }

    /// A scripted status that answers only after the provider timeout.
    const HANG: u16 = 0;

    #[derive(Clone)]
    struct Script {
        statuses: Arc<Mutex<VecDeque<u16>>>,
        hits: Arc<AtomicUsize>,
        queries: Arc<Mutex<Vec<String>>>,
        /// Helix's `message` in every error body.
        message: Arc<Mutex<String>>,
    }

    async fn scripted(
        State(script): State<Script>,
        request: axum::extract::Request,
    ) -> impl IntoResponse {
        script.hits.fetch_add(1, Ordering::SeqCst);
        script
            .queries
            .lock()
            .unwrap()
            .push(request.uri().to_string());
        let mut status = script.statuses.lock().unwrap().pop_front().unwrap_or(204);
        if status == HANG {
            tokio::time::sleep(PROVIDER_TIMEOUT + Duration::from_millis(200)).await;
            status = 204;
        }
        let body = if status == 204 {
            String::new()
        } else {
            serde_json::json!({ "message": script.message.lock().unwrap().clone() }).to_string()
        };
        (StatusCode::from_u16(status).unwrap(), body)
    }

    /// A Helix mock answering `DELETE /helix/moderation/chat` from a script.
    async fn twitch_server(statuses: &[u16]) -> (String, Script) {
        let script = Script {
            statuses: Arc::new(Mutex::new(statuses.iter().copied().collect())),
            hits: Arc::new(AtomicUsize::new(0)),
            queries: Arc::new(Mutex::new(Vec::new())),
            message: Arc::new(Mutex::new("scripted".to_string())),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/helix/moderation/chat", delete(scripted))
            .with_state(script.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), script)
    }

    fn twitch_sender(base: &str) -> ChatSenderConfig {
        ChatSenderConfig::Twitch(crate::twitch_chat::TwitchChatSenderConfig {
            access_token: "token".to_string(),
            client_id: "client".to_string(),
            broadcaster_user_id: "broadcaster-1".to_string(),
            sender_user_id: "broadcaster-1".to_string(),
            api_base_url: Some(base.to_string()),
            token_source: Default::default(),
        })
    }

    fn next_event(
        receiver: &mut broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<ModerationOperation> {
        let mut operations = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            if event.event == MODERATION_OPERATION_EVENT {
                operations.push(serde_json::from_value(event.payload).unwrap());
            }
        }
        operations
    }

    // --- Pure rules ----------------------------------------------------------------

    #[test]
    fn eligibility_accepts_chat_and_paid_rows_only_from_other_people() {
        let plain = message(StreamPlatform::Twitch, 1);
        assert!(eligibility(&plain).is_ok());
        let mut paid = message(StreamPlatform::Youtube, 2);
        paid.event_type = LiveChatEventType::Paid;
        assert!(eligibility(&paid).is_ok());

        let mut deleted = message(StreamPlatform::Twitch, 3);
        deleted.is_deleted = true;
        assert_eq!(eligibility(&deleted).unwrap_err().code, "not-eligible");

        let mut owner = message(StreamPlatform::Kick, 4);
        owner.author_roles = vec!["Owner".to_string()];
        assert_eq!(eligibility(&owner).unwrap_err().code, "not-eligible");
        let mut broadcaster = message(StreamPlatform::Twitch, 5);
        broadcaster.author_roles = vec!["broadcaster".to_string()];
        assert_eq!(eligibility(&broadcaster).unwrap_err().code, "not-eligible");

        for event_type in [
            LiveChatEventType::Membership,
            LiveChatEventType::System,
            LiveChatEventType::Moderation,
            LiveChatEventType::Follow,
            LiveChatEventType::PowerUp,
            LiveChatEventType::Redemption,
        ] {
            let mut notice = message(StreamPlatform::Twitch, 6);
            notice.event_type = event_type;
            assert_eq!(eligibility(&notice).unwrap_err().code, "not-eligible");
        }
        // A Twitch notification that slipped through as a message row.
        let mut notification = message(StreamPlatform::Twitch, 7);
        notification.raw_provider_type = Some("channel.chat.notification:raid".to_string());
        assert_eq!(eligibility(&notification).unwrap_err().code, "not-eligible");
        // A moderator's message is eligible here; the platform decides.
        let mut moderator = message(StreamPlatform::Twitch, 8);
        moderator.author_roles = vec!["moderator".to_string()];
        assert!(eligibility(&moderator).is_ok());
    }

    #[test]
    fn schedule_follows_the_contract_and_youtube_is_always_explicit() {
        let now = Utc::now();
        let manual = initial_schedule(
            ModerationSource::Manual,
            StreamPlatform::Youtube,
            RemoveConfirmMode::Countdown,
            now,
        );
        assert_eq!(manual.phase, ModerationPhase::Executing);
        assert!(!manual.requires_explicit_confirm);
        assert_eq!((manual.confirm_by, manual.execute_at), (None, None));

        let confirm = initial_schedule(
            ModerationSource::BuddyVoice,
            StreamPlatform::Twitch,
            RemoveConfirmMode::Confirm,
            now,
        );
        assert_eq!(confirm.phase, ModerationPhase::PendingConfirm);
        assert!(confirm.requires_explicit_confirm);
        assert_eq!(
            confirm.confirm_by,
            Some(now + chrono_duration(CONFIRM_WINDOW))
        );
        assert_eq!(confirm.execute_at, None);

        let countdown = initial_schedule(
            ModerationSource::BuddyVoice,
            StreamPlatform::Twitch,
            RemoveConfirmMode::Countdown,
            now,
        );
        assert_eq!(countdown.phase, ModerationPhase::PendingConfirm);
        assert!(!countdown.requires_explicit_confirm);
        assert_eq!(countdown.confirm_by, None);
        assert_eq!(countdown.execute_at, Some(now + chrono_duration(COUNTDOWN)));

        // YouTube: the countdown never runs, even when asked for.
        let youtube = initial_schedule(
            ModerationSource::BuddyVoice,
            StreamPlatform::Youtube,
            RemoveConfirmMode::Countdown,
            now,
        );
        assert_eq!(youtube.phase, ModerationPhase::PendingConfirm);
        assert!(youtube.requires_explicit_confirm);
        assert!(youtube.confirm_by.is_some());
        assert_eq!(youtube.execute_at, None);
    }

    #[test]
    fn tombstones_keep_the_row_identity_and_name_their_kind() {
        let original = message(StreamPlatform::Kick, 1);
        let removed = removal_tombstone(&original, LocalTombstoneKind::Removed);
        assert_eq!(removed.id, original.id);
        assert_eq!(removed.provider_message_id, original.provider_message_id);
        assert_eq!(removed.author_name, original.author_name);
        assert_eq!(removed.received_at, original.received_at);
        assert!(removed.is_deleted);
        assert_eq!(removed.event_type, LiveChatEventType::Deleted);
        assert_eq!(removed.message_text, REMOVED_BY_YOU_TEXT);
        assert_eq!(
            removed.raw_provider_type.as_deref(),
            Some(REMOVED_PROVIDER_TYPE)
        );
        assert!(removed.fragments.is_empty());

        let hidden = removal_tombstone(&original, LocalTombstoneKind::Hidden);
        assert_eq!(hidden.message_text, HIDDEN_IN_VIDEORC_TEXT);
        assert_eq!(
            hidden.raw_provider_type.as_deref(),
            Some(HIDDEN_PROVIDER_TYPE)
        );
        assert_eq!(
            hidden_outcome(
                StreamPlatform::Twitch,
                "Reconnect Twitch to let Buddy remove messages."
            ),
            "Hidden in Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Buddy remove messages."
        );
    }

    #[test]
    fn wire_shape_is_camel_case_kebab_enums_and_omits_storage_only_fields() {
        let operation = ModerationOperation {
            operation_id: "op-1".to_string(),
            session_id: SESSION.to_string(),
            message_id: "m-1".to_string(),
            platform: StreamPlatform::Twitch,
            target_id: None,
            provider_message_id: "p-1".to_string(),
            author_name: "coders_x".to_string(),
            excerpt: "hello".to_string(),
            source: ModerationSource::BuddyVoice,
            reason: Some("toxic".to_string()),
            phase: ModerationPhase::PendingConfirm,
            confirm_mode: RemoveConfirmMode::Confirm,
            requires_explicit_confirm: true,
            confirm_by: Some("2026-10-04T12:00:20Z".to_string()),
            execute_at: None,
            outcome: None,
            outcome_code: None,
            attempts: 1,
            created_at: "2026-10-04T12:00:00Z".to_string(),
            updated_at: "2026-10-04T12:00:00Z".to_string(),
        };
        let wire = serde_json::to_value(&operation).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "operationId": "op-1",
                "sessionId": SESSION,
                "messageId": "m-1",
                "platform": "twitch",
                "authorName": "coders_x",
                "excerpt": "hello",
                "source": "orcle-voice",
                "reason": "toxic",
                "phase": "pending-confirm",
                "confirmMode": "confirm",
                "requiresExplicitConfirm": true,
                "confirmBy": "2026-10-04T12:00:20Z",
                "createdAt": "2026-10-04T12:00:00Z",
                "updatedAt": "2026-10-04T12:00:00Z"
            })
        );
        let parsed: ModerationOperation = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed.phase, ModerationPhase::PendingConfirm);
        assert_eq!(parsed.attempts, 0, "attempts never travel on the wire");
        assert_eq!(
            serde_json::to_value(ModerationOutcomeCode::QuotaPaused).unwrap(),
            "quota-paused"
        );
        assert_eq!(
            serde_json::to_value(ModerationPhase::HiddenLocally).unwrap(),
            "hidden-locally"
        );
    }

    #[test]
    fn request_params_default_the_confirm_mode() {
        let params: ModerationRequestParams = serde_json::from_value(serde_json::json!({
            "operationId": "11111111-1111-4111-8111-111111111111",
            "messageId": "m-1",
            "source": "manual"
        }))
        .unwrap();
        let request = ModerationRequest::from(params);
        assert_eq!(request.confirm_mode, RemoveConfirmMode::Confirm);
        assert_eq!(request.reason, None);
        let params: ModerationRequestParams = serde_json::from_value(serde_json::json!({
            "operationId": "x",
            "messageId": "m-1",
            "source": "orcle-voice",
            "reason": "spam",
            "confirmMode": "countdown"
        }))
        .unwrap();
        assert_eq!(params.confirm_mode, Some(RemoveConfirmMode::Countdown));
        assert!(
            serde_json::from_value::<ModerationRequestParams>(serde_json::json!({
                "operationId": "x",
                "messageId": "m-1",
                "source": "viewer"
            }))
            .is_err()
        );
    }

    #[test]
    fn shared_high_risk_contract_fixture_round_trips_moderation_shapes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .unwrap();
        let moderation = fixture
            .get("moderation")
            .expect("moderation fixture section");
        for key in ["pendingOperation", "removedOperation", "hiddenOperation"] {
            let wire = moderation.get(key).unwrap().clone();
            let operation: ModerationOperation = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(operation).unwrap(), wire, "{key}");
        }
        let params: ModerationRequestParams =
            serde_json::from_value(moderation.get("requestParams").unwrap().clone()).unwrap();
        assert_eq!(params.source, ModerationSource::BuddyVoice);
        let params: ModerationOperationParams =
            serde_json::from_value(moderation.get("confirmParams").unwrap().clone()).unwrap();
        assert!(!params.operation_id.is_empty());
        // The tombstone a removal writes, as the renderer sees it.
        let removed: LiveChatMessage =
            serde_json::from_value(moderation.get("removedMessage").unwrap().clone()).unwrap();
        assert!(removed.is_deleted);
        assert_eq!(removed.event_type, LiveChatEventType::Deleted);
        assert_eq!(removed.message_text, REMOVED_BY_YOU_TEXT);
        assert_eq!(
            removed.raw_provider_type.as_deref(),
            Some(REMOVED_PROVIDER_TYPE)
        );
    }

    // --- Engine -----------------------------------------------------------------------

    #[tokio::test]
    async fn manual_request_runs_at_once_and_tombstones_removed_by_you() {
        let (state, mut events) = test_state();
        let target = message(StreamPlatform::Youtube, 1);
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)),
            &[target.clone()],
        )
        .await;

        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Removed);
        assert_eq!(operation.outcome_code, Some(ModerationOutcomeCode::Removed));
        assert_eq!(operation.outcome.as_deref(), Some("Removed from YouTube."));
        assert_eq!(operation.source, ModerationSource::Manual);
        assert!(!operation.requires_explicit_confirm);
        assert_eq!(operation.reason.as_deref(), Some("toxic"));
        assert_eq!(operation.excerpt, target.message_text);
        assert_eq!(operation.attempts, 1);

        let row = buffered_message(&state, &target.id).await;
        assert!(row.is_deleted);
        assert_eq!(row.message_text, REMOVED_BY_YOU_TEXT);
        assert_eq!(
            row.raw_provider_type.as_deref(),
            Some(REMOVED_PROVIDER_TYPE)
        );
        assert_eq!(row.author_name, target.author_name);
        let stored = stored_message(&state, &target.id).await;
        assert!(stored.is_deleted);
        assert_eq!(
            stored.raw_provider_type.as_deref(),
            Some(REMOVED_PROVIDER_TYPE)
        );

        let persisted = state
            .database
            .get_chat_moderation_operation(&operation.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(persisted.phase, ModerationPhase::Removed);
        assert_eq!(persisted.attempts, 1);
        assert_eq!(persisted.provider_message_id, target.provider_message_id);

        let emitted = next_event(&mut events);
        assert_eq!(
            emitted.iter().map(|op| op.phase).collect::<Vec<_>>(),
            vec![ModerationPhase::Executing, ModerationPhase::Removed]
        );
        let listed = state
            .database
            .list_chat_moderation_operations(SESSION, 200)
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].operation_id, operation.operation_id);
    }

    #[tokio::test]
    async fn the_same_operation_id_returns_the_existing_operation() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Youtube, 1);
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)),
            &[target.clone()],
        )
        .await;
        let first = request_for(&target, ModerationSource::Manual);
        let operation = request(&state, first.clone()).await.unwrap();
        let again = request(&state, first.clone()).await.unwrap();
        assert_eq!(again, operation);
        // The id is bound to its message.
        let other = message(StreamPlatform::Youtube, 2);
        let rebound = request(
            &state,
            ModerationRequest {
                message_id: other.id,
                ..first
            },
        )
        .await
        .unwrap_err();
        assert_eq!(rebound.code, "invalid-params");
        // Params are validated before anything else.
        let bad = request(
            &state,
            ModerationRequest {
                operation_id: "not-a-uuid".to_string(),
                ..request_for(&target, ModerationSource::Manual)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(bad.code, "invalid-params");
    }

    #[tokio::test]
    async fn buddy_voice_waits_for_confirmation_and_confirm_runs_it() {
        let (state, mut events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;

        let pending = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap();
        assert_eq!(pending.phase, ModerationPhase::PendingConfirm);
        assert!(pending.requires_explicit_confirm);
        assert!(pending.confirm_by.is_some());
        assert_eq!(pending.execute_at, None);
        assert_eq!(
            script.hits.load(Ordering::SeqCst),
            0,
            "nothing runs before an answer"
        );
        assert!(!buffered_message(&state, &target.id).await.is_deleted);

        // A second request for the same message waits behind the first.
        let duplicate = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "already-pending");

        let done = confirm(&state, &pending.operation_id).await.unwrap();
        assert_eq!(done.phase, ModerationPhase::Removed);
        assert_eq!(done.outcome_code, Some(ModerationOutcomeCode::Removed));
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);
        let query = script.queries.lock().unwrap()[0].clone();
        assert!(query.contains("broadcaster_id=broadcaster-1"), "{query}");
        assert!(query.contains("moderator_id=broadcaster-1"), "{query}");
        assert!(
            query.contains(&format!("message_id={}", target.provider_message_id)),
            "{query}"
        );
        assert!(buffered_message(&state, &target.id).await.is_deleted);

        // Answering twice is refused; the expiry timer is gone.
        assert_eq!(
            confirm(&state, &pending.operation_id)
                .await
                .unwrap_err()
                .code,
            "not-pending"
        );
        assert_eq!(
            cancel(&state, &pending.operation_id)
                .await
                .unwrap_err()
                .code,
            "not-pending"
        );
        assert!(state.live_chat_moderation.lock().await.timers.is_empty());
        assert!(
            state
                .live_chat_moderation
                .lock()
                .await
                .pending_by_message
                .is_empty()
        );
        let phases: Vec<_> = next_event(&mut events)
            .into_iter()
            .map(|op| op.phase)
            .collect();
        assert_eq!(
            phases,
            vec![
                ModerationPhase::PendingConfirm,
                ModerationPhase::Executing,
                ModerationPhase::Removed
            ]
        );
        // The message is free for a new operation now (it is a tombstone, so
        // that one is refused on eligibility, not on pending state).
        let after = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap_err();
        assert_eq!(after.code, "not-eligible");
    }

    #[tokio::test]
    async fn cancel_keeps_the_message_and_the_platform_untouched() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let pending = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap();
        let cancelled = cancel(&state, &pending.operation_id).await.unwrap();
        assert_eq!(cancelled.phase, ModerationPhase::Cancelled);
        assert_eq!(
            cancelled.outcome.as_deref(),
            Some("Cancelled. Nothing was removed.")
        );
        tokio::time::sleep(CONFIRM_WINDOW + Duration::from_millis(100)).await;
        assert_eq!(script.hits.load(Ordering::SeqCst), 0);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);
        let stored = state
            .database
            .get_chat_moderation_operation(&pending.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::Cancelled);
        assert_eq!(
            confirm(&state, &pending.operation_id)
                .await
                .unwrap_err()
                .code,
            "not-pending"
        );
    }

    #[tokio::test]
    async fn an_unanswered_confirm_card_expires_and_removes_nothing() {
        let (state, mut events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let pending = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap();
        tokio::time::sleep(CONFIRM_WINDOW + Duration::from_millis(150)).await;
        let stored = state
            .database
            .get_chat_moderation_operation(&pending.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::Expired);
        assert!(
            stored
                .outcome
                .as_deref()
                .unwrap()
                .contains("Nothing was removed")
        );
        assert_eq!(script.hits.load(Ordering::SeqCst), 0);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);
        let phases: Vec<_> = next_event(&mut events)
            .into_iter()
            .map(|op| op.phase)
            .collect();
        assert_eq!(
            phases,
            vec![ModerationPhase::PendingConfirm, ModerationPhase::Expired]
        );
        assert_eq!(
            confirm(&state, &pending.operation_id)
                .await
                .unwrap_err()
                .code,
            "not-pending"
        );
    }

    #[tokio::test]
    async fn countdown_mode_runs_by_itself_unless_cancelled() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let pending = request(
            &state,
            ModerationRequest {
                confirm_mode: RemoveConfirmMode::Countdown,
                ..request_for(&target, ModerationSource::BuddyVoice)
            },
        )
        .await
        .unwrap();
        assert_eq!(pending.phase, ModerationPhase::PendingConfirm);
        assert!(!pending.requires_explicit_confirm);
        assert_eq!(pending.confirm_by, None);
        assert!(pending.execute_at.is_some());
        tokio::time::sleep(COUNTDOWN + Duration::from_millis(250)).await;
        let stored = state
            .database
            .get_chat_moderation_operation(&pending.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::Removed);
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);
        assert!(buffered_message(&state, &target.id).await.is_deleted);
    }

    #[tokio::test]
    async fn youtube_never_runs_a_countdown() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Youtube, 1);
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)),
            &[target.clone()],
        )
        .await;
        let pending = request(
            &state,
            ModerationRequest {
                confirm_mode: RemoveConfirmMode::Countdown,
                ..request_for(&target, ModerationSource::BuddyVoice)
            },
        )
        .await
        .unwrap();
        assert_eq!(pending.phase, ModerationPhase::PendingConfirm);
        assert!(pending.requires_explicit_confirm);
        assert_eq!(pending.execute_at, None);
        assert!(pending.confirm_by.is_some());
        tokio::time::sleep(COUNTDOWN + Duration::from_millis(100)).await;
        // Still waiting after the countdown would have fired.
        let stored = state
            .database
            .get_chat_moderation_operation(&pending.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::PendingConfirm);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);
        let done = confirm(&state, &pending.operation_id).await.unwrap();
        assert_eq!(done.phase, ModerationPhase::Removed);
    }

    #[tokio::test]
    async fn the_restart_sweep_cancels_pending_and_marks_executing_unknown() {
        let (state, _events) = test_state();
        let now = Utc::now().to_rfc3339();
        let base = ModerationOperation {
            operation_id: String::new(),
            session_id: SESSION.to_string(),
            message_id: "m".to_string(),
            platform: StreamPlatform::Twitch,
            target_id: None,
            provider_message_id: "p".to_string(),
            author_name: "viewer".to_string(),
            excerpt: "hello".to_string(),
            source: ModerationSource::BuddyVoice,
            reason: None,
            phase: ModerationPhase::PendingConfirm,
            confirm_mode: RemoveConfirmMode::Confirm,
            requires_explicit_confirm: true,
            confirm_by: Some(now.clone()),
            execute_at: None,
            outcome: None,
            outcome_code: None,
            attempts: 0,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let rows = [
            ("pending", ModerationPhase::PendingConfirm),
            ("executing", ModerationPhase::Executing),
            ("removed", ModerationPhase::Removed),
            ("cancelled", ModerationPhase::Cancelled),
        ];
        for (id, phase) in rows {
            state
                .database
                .save_chat_moderation_operation(&ModerationOperation {
                    operation_id: id.to_string(),
                    message_id: id.to_string(),
                    phase,
                    ..base.clone()
                })
                .unwrap();
        }
        let (cancelled, unknown) = state
            .database
            .reconcile_orphaned_chat_moderation_operations()
            .unwrap();
        assert_eq!((cancelled, unknown), (1, 1));
        let phase = |id: &str| {
            state
                .database
                .get_chat_moderation_operation(id)
                .unwrap()
                .unwrap()
        };
        assert_eq!(phase("pending").phase, ModerationPhase::Cancelled);
        assert_eq!(
            phase("pending").outcome.as_deref(),
            Some(RESTART_CANCELLED_OUTCOME)
        );
        assert_eq!(phase("executing").phase, ModerationPhase::DeliveryUnknown);
        assert_eq!(
            phase("executing").outcome.as_deref(),
            Some(RESTART_UNKNOWN_OUTCOME)
        );
        assert_eq!(phase("removed").phase, ModerationPhase::Removed);
        assert_eq!(phase("cancelled").phase, ModerationPhase::Cancelled);
        // Idempotent: a second sweep finds nothing.
        assert_eq!(
            state
                .database
                .reconcile_orphaned_chat_moderation_operations()
                .unwrap(),
            (0, 0)
        );
        // Newest first, capped.
        let listed = state
            .database
            .list_chat_moderation_operations(SESSION, 2)
            .unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_once_and_a_404_on_the_retry_counts_as_removed() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[503, 404]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Removed);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::NotFound)
        );
        assert_eq!(operation.attempts, 2);
        assert_eq!(script.hits.load(Ordering::SeqCst), 2);
        let row = buffered_message(&state, &target.id).await;
        assert!(row.is_deleted);
        assert_eq!(
            row.raw_provider_type.as_deref(),
            Some(REMOVED_PROVIDER_TYPE)
        );

        // Two transient failures: failed, and the row stays visible.
        let second = message(StreamPlatform::Twitch, 2);
        let (base, script) = twitch_server(&[500, 502]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[second.clone()],
        )
        .await;
        let operation = request(&state, request_for(&second, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Failed);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::ProviderError)
        );
        assert_eq!(operation.attempts, 2);
        assert_eq!(script.hits.load(Ordering::SeqCst), 2);
        assert!(!buffered_message(&state, &second.id).await.is_deleted);
    }

    #[tokio::test]
    async fn a_missing_scope_hides_the_message_locally_and_says_viewers_still_see_it() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[401]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::HiddenLocally);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::MissingScope)
        );
        assert_eq!(
            operation.outcome.as_deref(),
            Some(
                "Hidden in Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Buddy remove messages."
            )
        );
        assert_eq!(
            script.hits.load(Ordering::SeqCst),
            1,
            "a 401 is never retried"
        );
        let row = buffered_message(&state, &target.id).await;
        assert!(row.is_deleted);
        assert_eq!(row.message_text, HIDDEN_IN_VIDEORC_TEXT);
        assert_eq!(row.raw_provider_type.as_deref(), Some(HIDDEN_PROVIDER_TYPE));
        assert_eq!(
            stored_message(&state, &target.id)
                .await
                .raw_provider_type
                .as_deref(),
            Some(HIDDEN_PROVIDER_TYPE)
        );

        // No credentials at all: the same honest hide, with no request.
        let second = message(StreamPlatform::Kick, 2);
        seed(&state, StreamPlatform::Kick, None, &[second.clone()]).await;
        let operation = request(&state, request_for(&second, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::HiddenLocally);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::MissingScope)
        );
        assert!(
            operation
                .outcome
                .as_deref()
                .unwrap()
                .contains("Viewers on Kick still see it"),
            "{operation:?}"
        );
    }

    #[tokio::test]
    async fn an_old_twitch_message_is_hidden_without_a_request() {
        let (state, _events) = test_state();
        let mut target = message(StreamPlatform::Twitch, 1);
        target.published_at = (Utc::now() - chrono::Duration::hours(7)).to_rfc3339();
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::HiddenLocally);
        assert_eq!(operation.outcome_code, Some(ModerationOutcomeCode::TooOld));
        assert_eq!(script.hits.load(Ordering::SeqCst), 0);
        assert!(buffered_message(&state, &target.id).await.is_deleted);
    }

    #[tokio::test]
    async fn the_rate_limit_allows_ten_removals_a_minute() {
        let (state, _events) = test_state();
        let messages: Vec<_> = (0..12)
            .map(|seq| message(StreamPlatform::Youtube, seq))
            .collect();
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)),
            &messages,
        )
        .await;
        for target in &messages[..RATE_LIMIT_PER_MINUTE] {
            let operation = request(&state, request_for(target, ModerationSource::Manual))
                .await
                .unwrap();
            assert_eq!(operation.phase, ModerationPhase::Removed);
        }
        let refused = request(
            &state,
            request_for(&messages[RATE_LIMIT_PER_MINUTE], ModerationSource::Manual),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "rate-limited");
        assert!(
            !buffered_message(&state, &messages[RATE_LIMIT_PER_MINUTE].id)
                .await
                .is_deleted
        );
        // A refusal leaves no row behind.
        assert_eq!(
            state
                .database
                .list_chat_moderation_operations(SESSION, 200)
                .unwrap()
                .len(),
            RATE_LIMIT_PER_MINUTE
        );
        // Once the window passes, requests flow again.
        {
            let mut runtime = state.live_chat_moderation.lock().await;
            let old = Instant::now()
                .checked_sub(RATE_LIMIT_WINDOW + Duration::from_secs(1))
                .expect("test host uptime exceeds one minute");
            for stamp in runtime.recent_requests.iter_mut() {
                *stamp = old;
            }
        }
        let operation = request(
            &state,
            request_for(
                &messages[RATE_LIMIT_PER_MINUTE + 1],
                ModerationSource::Manual,
            ),
        )
        .await
        .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Removed);
    }

    #[tokio::test]
    async fn buddy_voice_needs_premium_while_manual_is_free() {
        let (state, _events) = test_state();
        let premium = Arc::new(AtomicBool::new(false));
        let check = premium.clone();
        set_premium_check_for_tests(&state, Arc::new(move || check.load(Ordering::SeqCst))).await;
        let targets = [
            message(StreamPlatform::Twitch, 1),
            message(StreamPlatform::Twitch, 2),
            message(StreamPlatform::Twitch, 3),
        ];
        let (base, script) = twitch_server(&[204, 204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &targets,
        )
        .await;

        let refused = request(
            &state,
            request_for(&targets[0], ModerationSource::BuddyVoice),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "premium-required");
        assert_eq!(refused.message, PREMIUM_REQUIRED_MESSAGE);
        assert!(
            state
                .database
                .list_chat_moderation_operations(SESSION, 200)
                .unwrap()
                .is_empty()
        );

        let manual = request(&state, request_for(&targets[0], ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(manual.phase, ModerationPhase::Removed);
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);

        // Premium lapses between the request and the confirmation: the
        // execution re-check cancels it and nothing reaches Twitch.
        premium.store(true, Ordering::SeqCst);
        let pending = request(
            &state,
            request_for(&targets[1], ModerationSource::BuddyVoice),
        )
        .await
        .unwrap();
        assert_eq!(pending.phase, ModerationPhase::PendingConfirm);
        premium.store(false, Ordering::SeqCst);
        let cancelled = confirm(&state, &pending.operation_id).await.unwrap();
        assert_eq!(cancelled.phase, ModerationPhase::Cancelled);
        assert!(
            cancelled
                .outcome
                .as_deref()
                .unwrap()
                .starts_with(PREMIUM_REQUIRED_MESSAGE)
        );
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);
        assert!(!buffered_message(&state, &targets[1].id).await.is_deleted);
    }

    #[tokio::test]
    async fn the_kill_switch_pauses_voice_removals_only() {
        let (state, _events) = test_state();
        let targets = [
            message(StreamPlatform::Twitch, 1),
            message(StreamPlatform::Twitch, 2),
        ];
        let (base, script) = twitch_server(&[204, 204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &targets,
        )
        .await;
        let flags = crate::service_flags::parse_service_flags(
            r#"{"version":1,"orcle":{"remove":false}}"#,
            Utc::now(),
        )
        .unwrap();
        crate::youtube_quota::apply_service_flags(&state, flags);
        assert!(!crate::service_flags::buddy_remove_enabled(&state));
        assert!(crate::service_flags::buddy_voice_commands_enabled(&state));

        let refused = request(
            &state,
            request_for(&targets[0], ModerationSource::BuddyVoice),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "disabled");
        assert_eq!(refused.message, REMOVE_PAUSED_MESSAGE);
        let manual = request(&state, request_for(&targets[0], ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(manual.phase, ModerationPhase::Removed);
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);

        // The switch flips while a card is open: execution refuses too.
        let enabled =
            crate::service_flags::parse_service_flags(r#"{"version":1}"#, Utc::now()).unwrap();
        crate::youtube_quota::apply_service_flags(&state, enabled);
        let pending = request(
            &state,
            request_for(&targets[1], ModerationSource::BuddyVoice),
        )
        .await
        .unwrap();
        let paused = crate::service_flags::parse_service_flags(
            r#"{"version":1,"orcle":{"remove":false}}"#,
            Utc::now(),
        )
        .unwrap();
        crate::youtube_quota::apply_service_flags(&state, paused);
        let cancelled = confirm(&state, &pending.operation_id).await.unwrap();
        assert_eq!(cancelled.phase, ModerationPhase::Cancelled);
        assert!(
            cancelled
                .outcome
                .as_deref()
                .unwrap()
                .starts_with(REMOVE_PAUSED_MESSAGE)
        );
        assert_eq!(script.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn requests_need_a_live_eligible_message() {
        let (state, _events) = test_state();
        // No session at all.
        let target = message(StreamPlatform::Twitch, 1);
        let refused = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "not-found");

        let mut owner = message(StreamPlatform::Twitch, 2);
        owner.author_roles = vec!["owner".to_string()];
        let mut tombstone = message(StreamPlatform::Twitch, 3);
        tombstone.is_deleted = true;
        tombstone.event_type = LiveChatEventType::Deleted;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)),
            &[owner.clone(), tombstone.clone()],
        )
        .await;
        assert_eq!(
            request(&state, request_for(&owner, ModerationSource::Manual))
                .await
                .unwrap_err()
                .code,
            "not-eligible"
        );
        assert_eq!(
            request(&state, request_for(&tombstone, ModerationSource::Manual))
                .await
                .unwrap_err()
                .code,
            "not-eligible"
        );
        // Unknown id.
        let unknown = request(
            &state,
            ModerationRequest {
                message_id: "nope".to_string(),
                ..request_for(&owner, ModerationSource::Manual)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.code, "not-found");
        // A message that fell out of the buffer but is still in SQLite is
        // found, as long as it belongs to the running session.
        let evicted = message(StreamPlatform::Twitch, 4);
        state.database.save_live_chat_message(&evicted).unwrap();
        let operation = request(&state, request_for(&evicted, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Removed);
        assert_eq!(
            confirm(&state, "missing").await.unwrap_err().code,
            "not-found"
        );
    }

    #[tokio::test]
    async fn a_session_end_cancels_every_open_card() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[204]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let pending = request(&state, request_for(&target, ModerationSource::BuddyVoice))
            .await
            .unwrap();
        note_session_ended(&state, SESSION.to_string());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let stored = state
                .database
                .get_chat_moderation_operation(&pending.operation_id)
                .unwrap()
                .unwrap();
            if stored.phase == ModerationPhase::Cancelled {
                assert!(stored.outcome.as_deref().unwrap().contains("session ended"));
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{stored:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(script.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_timeout_on_both_attempts_is_delivery_unknown() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Youtube, 1);
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Timeout)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::DeliveryUnknown);
        assert_eq!(operation.attempts, 2);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);
    }

    #[tokio::test]
    async fn a_timeout_then_a_server_error_is_delivery_unknown() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        // The first attempt may have removed it after all; the 503 on the
        // retry says nothing about that.
        let (base, script) = twitch_server(&[HANG, 503]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::DeliveryUnknown);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::ProviderError)
        );
        assert_eq!(operation.attempts, 2);
        assert_eq!(script.hits.load(Ordering::SeqCst), 2);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);

        // A definite answer on the retry still decides.
        let second = message(StreamPlatform::Twitch, 2);
        let (base, _script) = twitch_server(&[HANG, 404]).await;
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[second.clone()],
        )
        .await;
        let operation = request(&state, request_for(&second, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Removed);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::NotFound)
        );
    }

    #[tokio::test]
    async fn a_long_provider_message_is_cut_to_the_outcome_cap() {
        let (state, mut events) = test_state();
        let target = message(StreamPlatform::Twitch, 1);
        let (base, script) = twitch_server(&[418]).await;
        *script.message.lock().unwrap() = "x".repeat(5000);
        seed(
            &state,
            StreamPlatform::Twitch,
            Some(twitch_sender(&base)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Failed);
        let outcome = operation.outcome.clone().unwrap();
        assert_eq!(outcome.encode_utf16().count(), OUTCOME_MAX_UNITS);
        assert!(outcome.starts_with("Twitch removal failed (418)"));
        assert!(outcome.ends_with('\u{2026}'));
        let stored = state
            .database
            .get_chat_moderation_operation(&operation.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.outcome.as_deref(), Some(outcome.as_str()));
        let emitted = next_event(&mut events);
        assert_eq!(
            emitted.last().and_then(|op| op.outcome.as_deref()),
            Some(outcome.as_str())
        );
        // A short outcome is left alone.
        let mut short = operation.clone();
        short.outcome = Some("Removed from Twitch.".to_string());
        cap_outcome(&mut short);
        assert_eq!(short.outcome.as_deref(), Some("Removed from Twitch."));
    }

    #[tokio::test]
    async fn a_failing_fake_provider_fails_the_operation_and_keeps_the_row() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Youtube, 1);
        seed(
            &state,
            StreamPlatform::Youtube,
            Some(ChatSenderConfig::Fake(FakeChatSendBehavior::Failed)),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::Failed);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::ProviderError)
        );
        assert_eq!(operation.attempts, 1);
        assert!(!buffered_message(&state, &target.id).await.is_deleted);
        // The message is free for another try.
        let again = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(again.phase, ModerationPhase::Failed);
    }

    #[test]
    fn a_scripted_fake_destination_answers_removals_as_told() {
        assert_eq!(
            fake_scripted_delete(FakeChatDeleteBehavior::Ok, StreamPlatform::Kick),
            ProviderDeleteOutcome::Deleted
        );
        assert_eq!(
            fake_scripted_delete(FakeChatDeleteBehavior::NotFound, StreamPlatform::Kick),
            ProviderDeleteOutcome::NotFound
        );
        assert_eq!(
            fake_scripted_delete(FakeChatDeleteBehavior::MissingScope, StreamPlatform::Kick),
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::MissingScope,
                reason: "Reconnect Kick to let Buddy remove messages.".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn a_fake_destination_without_the_scope_hides_the_message_in_videorc() {
        let (state, _events) = test_state();
        let target = message(StreamPlatform::Kick, 1);
        seed(
            &state,
            StreamPlatform::Kick,
            Some(ChatSenderConfig::FakeModerated {
                send: FakeChatSendBehavior::Sent,
                delete: FakeChatDeleteBehavior::MissingScope,
            }),
            &[target.clone()],
        )
        .await;
        let operation = request(&state, request_for(&target, ModerationSource::Manual))
            .await
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::HiddenLocally);
        assert_eq!(
            operation.outcome_code,
            Some(ModerationOutcomeCode::MissingScope)
        );
        let row = buffered_message(&state, &target.id).await;
        assert!(row.is_deleted);
        assert_eq!(row.raw_provider_type.as_deref(), Some("videorc.hidden"));
    }
}
