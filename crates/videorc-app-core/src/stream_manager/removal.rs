//! Chat removals (plan 140, S6; `lib/chat-removal-view.ts`,
//! `shared/chat-moderation.ts`, the manual half of
//! `lib/chat-moderation-relay.ts`): a pure derivation of the chat row and the
//! backend's `ModerationOperation`, so the row's chip, its outcome line and
//! the toasts cannot disagree. The backend owns every timer; "Remove from
//! chat" is the streamer's express consent, and it runs after a 3 s Undo
//! (plan 174 D20). Buddy's removal cards are the Buddy pane's (S3.2d).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::chat::model::{LiveChatMessage, LiveChatProviderState};
use crate::chat::view::platform_label;

/// `REMOVE_FROM_CHAT_LABEL`.
pub const REMOVE_FROM_CHAT: &str = "Remove from chat";
/// `REMOVE_UNDO_MS`: how long a manual removal waits for Undo.
pub const REMOVE_UNDO: std::time::Duration = std::time::Duration::from_millis(3_000);
/// `HIDDEN_IN_VIDEORC_DETAIL`.
pub const HIDDEN_IN_VIDEORC_DETAIL: &str = "Viewers may still see it.";
/// `MAX_RELAYED_MODERATION_OPERATIONS`.
pub const MAX_OPERATIONS: usize = 100;

/// `COMMENTS_MODERATION_TIMING_CONTRACT`: the backend's request, then a look
/// at the ledger for a lost reply.
pub const BACKEND_REQUEST: std::time::Duration = std::time::Duration::from_millis(24_000);
pub const RECONCILIATION: std::time::Duration = std::time::Duration::from_millis(2_000);

/// `REMOVED_BY_YOU_PROVIDER_TYPE` and `HIDDEN_IN_VIDEORC_PROVIDER_TYPE`.
pub const REMOVED_BY_YOU: &str = "videorc.removed";
pub const HIDDEN_IN_VIDEORC: &str = "videorc.hidden";

/// `ModerationOperation`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationOperation {
    pub operation_id: String,
    pub session_id: String,
    pub message_id: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub excerpt: String,
    /// `manual`, Buddy's voice (its saved wire name) or `agent`.
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `pending-confirm`, `cancelled`, `expired`, `executing`, `removed`,
    /// `hidden-locally`, `failed`, `delivery-unknown`.
    pub phase: String,
    #[serde(default)]
    pub confirm_mode: String,
    #[serde(default)]
    pub requires_explicit_confirm: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_code: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl ModerationOperation {
    /// `moderationOperationTerminal`: nothing changes it again.
    pub fn terminal(&self) -> bool {
        matches!(
            self.phase.as_str(),
            "cancelled" | "expired" | "removed" | "hidden-locally" | "failed" | "delivery-unknown"
        )
    }

    fn outcome_text(&self) -> Option<String> {
        self.outcome
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }
}

/// `localRemovalKind`: how the streamer removed a row, if they did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalRemoval {
    Removed,
    Hidden,
}

pub fn local_removal_kind(message: &LiveChatMessage) -> Option<LocalRemoval> {
    if !message.is_deleted {
        return None;
    }
    match message.raw_provider_type.as_deref() {
        Some(REMOVED_BY_YOU) => Some(LocalRemoval::Removed),
        Some(HIDDEN_IN_VIDEORC) => Some(LocalRemoval::Hidden),
        _ => None,
    }
}

/// `RemovalStatusKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovalKind {
    Removing,
    Removed,
    Hidden,
    Failed,
    Unknown,
}

impl RemovalKind {
    /// `REMOVAL_STATUS_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            RemovalKind::Removing => "Removing…",
            RemovalKind::Removed => "Removed",
            RemovalKind::Hidden => "Hidden in Videorc",
            RemovalKind::Failed => "Not removed",
            RemovalKind::Unknown => "Unconfirmed",
        }
    }
}

/// `RemovalStatusView`: the row's chip and the outcome sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalStatus {
    pub kind: RemovalKind,
    pub detail: Option<String>,
}

impl RemovalStatus {
    /// `removalOutcomeLine`: what a removal did when it did not simply
    /// remove, as the row's own line.
    pub fn outcome_line(&self) -> Option<String> {
        if matches!(self.kind, RemovalKind::Removing | RemovalKind::Removed) {
            return None;
        }
        self.detail
            .as_deref()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
    }
}

/// `removalStatusView`: the tombstone is the truth for a finished removal;
/// the newest operation says what is in flight or what went wrong.
pub fn removal_status(
    message: &LiveChatMessage,
    operation: Option<&ModerationOperation>,
    requesting: bool,
) -> Option<RemovalStatus> {
    let outcome = operation.and_then(ModerationOperation::outcome_text);
    let status = |kind, detail| Some(RemovalStatus { kind, detail });
    match local_removal_kind(message) {
        Some(LocalRemoval::Removed) => {
            return status(
                RemovalKind::Removed,
                operation
                    .filter(|operation| operation.phase == "removed")
                    .and(outcome),
            );
        }
        Some(LocalRemoval::Hidden) => {
            return status(
                RemovalKind::Hidden,
                operation
                    .filter(|operation| operation.phase == "hidden-locally")
                    .and(outcome)
                    .or_else(|| Some(HIDDEN_IN_VIDEORC_DETAIL.to_string())),
            );
        }
        None => {}
    }
    match operation.map(|operation| operation.phase.as_str()) {
        Some("executing") => status(RemovalKind::Removing, None),
        Some("removed") => status(RemovalKind::Removed, outcome),
        Some("hidden-locally") => status(
            RemovalKind::Hidden,
            outcome.or_else(|| Some(HIDDEN_IN_VIDEORC_DETAIL.to_string())),
        ),
        Some("failed") => status(RemovalKind::Failed, outcome),
        Some("delivery-unknown") => status(RemovalKind::Unknown, outcome),
        _ => requesting.then_some(RemovalStatus {
            kind: RemovalKind::Removing,
            detail: None,
        }),
    }
}

/// `chatMessageRemovable`: a viewer's chat or paid message that still
/// exists; never a notification, a tombstone or the streamer's own.
pub fn chat_message_removable(message: &LiveChatMessage) -> bool {
    if message.is_deleted || message.event_type == "deleted" {
        return false;
    }
    if !matches!(message.event_type.as_str(), "message" | "paid") {
        return false;
    }
    if message
        .raw_provider_type
        .as_deref()
        .is_some_and(|kind| kind.starts_with("channel.chat.notification"))
    {
        return false;
    }
    !message.author_roles.iter().any(|role| {
        let role = role.trim().to_lowercase();
        role == "owner" || role == "broadcaster"
    })
}

/// `removeFromChatAvailable`: removable, with nothing in flight.
pub fn remove_from_chat_available(
    message: &LiveChatMessage,
    operation: Option<&ModerationOperation>,
    requesting: bool,
) -> bool {
    if requesting || !chat_message_removable(message) {
        return false;
    }
    operation.is_none_or(ModerationOperation::terminal)
}

/// `removeFromChatBlockedReason` (plan 174 H-11): the account lacks the
/// permission to delete there; the item stays, disabled with the fix.
pub fn remove_from_chat_blocked_reason(
    message: &LiveChatMessage,
    providers: &[LiveChatProviderState],
) -> Option<String> {
    let same: Vec<&LiveChatProviderState> = providers
        .iter()
        .filter(|provider| provider.platform == message.platform)
        .collect();
    let provider = same
        .iter()
        .find(|candidate| message.target_id.is_some() && candidate.target_id == message.target_id)
        .or(same.first())?;
    if provider.moderate.as_deref() != Some("missing-scope") {
        return None;
    }
    Some(if message.platform == "x" {
        "Authorize X Live to remove messages".to_string()
    } else {
        format!(
            "Reconnect {} to remove messages",
            platform_label(&message.platform)
        )
    })
}

/// `removalUndoToast`: "Removing Ada's message", Undo.
pub fn undo_toast_id(message_id: &str) -> String {
    format!("chat-removal-undo:{message_id}")
}

pub fn undo_toast_title(author: &str) -> String {
    format!("Removing {author}'s message")
}

/// `REMOVAL_RESULT_FALLBACK`.
fn fallback(phase: &str) -> Option<&'static str> {
    Some(match phase {
        "cancelled" => "Canceled. Nothing was removed.",
        "expired" => "No answer. Nothing was removed.",
        "removed" => "Removed.",
        "hidden-locally" => "Hidden in Videorc. Viewers may still see it.",
        "failed" => "Not removed.",
        "delivery-unknown" => "Check chat to see whether it was removed.",
        _ => return None,
    })
}

/// A finished removal's toast type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeKind {
    Success,
    Warning,
    Error,
    Message,
}

/// `removalOutcomeToast`: hidden, unconfirmed and failed always speak; a
/// cancel is never news. The Stream Manager's row already says "Removed".
pub fn removal_outcome_toast(
    operation: &ModerationOperation,
    include_success: bool,
) -> Option<(OutcomeKind, String)> {
    let text = operation
        .outcome_text()
        .or_else(|| fallback(&operation.phase).map(str::to_string))?;
    match operation.phase.as_str() {
        "removed" => include_success.then_some((OutcomeKind::Success, text)),
        "hidden-locally" | "delivery-unknown" => Some((OutcomeKind::Warning, text)),
        "failed" => Some((OutcomeKind::Error, text)),
        "expired" => include_success.then_some((OutcomeKind::Message, text)),
        _ => None,
    }
}

/// `reconcileModerationOperation`: a terminal row never rolls back; between
/// two open ones the later `updatedAt` wins.
pub fn reconcile_operation(
    current: Option<&ModerationOperation>,
    candidate: ModerationOperation,
) -> ModerationOperation {
    let Some(current) = current.filter(|current| current.operation_id == candidate.operation_id)
    else {
        return candidate;
    };
    if current.terminal() && !candidate.terminal() {
        return current.clone();
    }
    if !current.terminal() && candidate.terminal() {
        return candidate;
    }
    if candidate.updated_at >= current.updated_at {
        candidate
    } else {
        current.clone()
    }
}

fn time_of(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|at| at.timestamp_millis())
        .unwrap_or(0)
}

/// `newestFirst`.
fn newest_first(left: &ModerationOperation, right: &ModerationOperation) -> std::cmp::Ordering {
    time_of(&right.created_at)
        .cmp(&time_of(&left.created_at))
        .then(time_of(&right.updated_at).cmp(&time_of(&left.updated_at)))
        .then(left.operation_id.cmp(&right.operation_id))
}

/// `mergeModerationOperations` then `relayedModerationOperations`: one row
/// per operation, only the session's, every open one first, then the newest
/// finished ones, at most [`MAX_OPERATIONS`].
pub fn merge_operations(
    current: &[ModerationOperation],
    incoming: Vec<ModerationOperation>,
    session_id: Option<&str>,
) -> Vec<ModerationOperation> {
    let Some(session_id) = session_id else {
        return Vec::new();
    };
    let mut by_id: Vec<ModerationOperation> = current.to_vec();
    for operation in incoming {
        match by_id
            .iter()
            .position(|held| held.operation_id == operation.operation_id)
        {
            Some(index) => {
                let merged = reconcile_operation(Some(&by_id[index]), operation);
                by_id[index] = merged;
            }
            None => by_id.push(operation),
        }
    }
    let own: Vec<ModerationOperation> = by_id
        .into_iter()
        .filter(|operation| operation.session_id == session_id)
        .collect();
    let (mut done, mut open): (Vec<_>, Vec<_>) =
        own.into_iter().partition(ModerationOperation::terminal);
    open.sort_by(newest_first);
    done.sort_by(newest_first);
    open.extend(done);
    open.truncate(MAX_OPERATIONS);
    open
}

/// `latestModerationOperationByMessage`: each message's newest removal.
pub fn latest_by_message(
    operations: &[ModerationOperation],
) -> HashMap<&str, &ModerationOperation> {
    let mut latest: HashMap<&str, &ModerationOperation> = HashMap::new();
    for operation in operations {
        match latest.get(operation.message_id.as_str()) {
            Some(current) if newest_first(operation, current) != std::cmp::Ordering::Less => {}
            _ => {
                latest.insert(operation.message_id.as_str(), operation);
            }
        }
    }
    latest
}

// --- S3.2d: Buddy's removal cards (`removalPaneView`) ----------------------

/// `REMOVAL_CARD_TITLE`, `REMOVAL_CARD_REMOVING`, `YOUTUBE_CONFIRM_NOTE`.
pub const REMOVAL_CARD_TITLE: &str = "Remove from chat?";
pub const REMOVAL_CARD_REMOVING: &str = "Removing…";
pub const YOUTUBE_CONFIRM_NOTE: &str = "YouTube asks you to confirm.";
/// How long a finished removal's line stays.
pub const REMOVAL_RESULT_VISIBLE_MS: i64 = 6_000;

/// One removal Buddy waits on: Buddy's voice or an agent asked, the
/// streamer answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalCard {
    pub operation_id: String,
    pub platform: String,
    pub platform_label: &'static str,
    pub author_name: String,
    pub excerpt: String,
    pub reason: Option<String>,
    /// `confirm` or `countdown`.
    pub mode: &'static str,
    pub title: String,
    pub timer: Option<String>,
    pub note: Option<&'static str>,
    pub busy: bool,
    /// Which answer is the card's own button: `confirm` or `cancel`.
    pub primary: &'static str,
    pub confirm_label: &'static str,
}

fn has_card(operation: &ModerationOperation) -> bool {
    // Buddy's voice keeps its saved wire name (plan 170 D22).
    operation.source == "orcle-voice" || operation.source == "agent"
}

fn epoch_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|at| at.timestamp_millis())
}

fn seconds_left(iso: Option<&str>, now_ms: i64) -> Option<i64> {
    let at = epoch_ms(iso?)?;
    Some((((at - now_ms).max(0)) as f64 / 1000.0).ceil() as i64)
}

/// `removalCardView`.
pub fn removal_card(
    operation: &ModerationOperation,
    now_ms: i64,
    answering: bool,
) -> Option<RemovalCard> {
    if !has_card(operation) {
        return None;
    }
    if operation.phase != "pending-confirm" && operation.phase != "executing" {
        return None;
    }
    let countdown = operation.confirm_mode == "countdown" && !operation.requires_explicit_confirm;
    let card = |mode, title: String, timer, busy, primary, confirm_label| RemovalCard {
        operation_id: operation.operation_id.clone(),
        platform: operation.platform.clone(),
        platform_label: platform_label(&operation.platform),
        author_name: operation.author_name.clone(),
        excerpt: operation.excerpt.trim().to_string(),
        reason: operation
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .map(str::to_string),
        mode,
        title,
        timer,
        note: (operation.platform == "youtube").then_some(YOUTUBE_CONFIRM_NOTE),
        busy,
        primary,
        confirm_label,
    };
    if operation.phase == "executing" {
        return Some(if countdown {
            card(
                "countdown",
                REMOVAL_CARD_REMOVING.into(),
                None,
                true,
                "cancel",
                "Remove now",
            )
        } else {
            card(
                "confirm",
                REMOVAL_CARD_REMOVING.into(),
                None,
                true,
                "confirm",
                "Remove",
            )
        });
    }
    if countdown {
        let left = seconds_left(operation.execute_at.as_deref(), now_ms).filter(|left| *left > 0);
        let title = match left {
            Some(left) => format!("Removing in {left}s"),
            None => REMOVAL_CARD_REMOVING.into(),
        };
        return Some(card(
            "countdown",
            title,
            None,
            answering,
            "cancel",
            "Remove now",
        ));
    }
    let timer = seconds_left(operation.confirm_by.as_deref(), now_ms).map(|left| {
        if left > 0 {
            format!("Expires in {left}s")
        } else {
            "Expiring…".to_string()
        }
    });
    Some(card(
        "confirm",
        REMOVAL_CARD_TITLE.into(),
        timer,
        answering,
        "confirm",
        "Remove",
    ))
}

/// A finished removal's line, for six seconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalResult {
    pub operation_id: String,
    pub platform: String,
    pub author_name: String,
    pub text: String,
}

/// `removalResultView`.
pub fn removal_result(operation: &ModerationOperation, now_ms: i64) -> Option<RemovalResult> {
    if !has_card(operation) || !operation.terminal() {
        return None;
    }
    let ended = epoch_ms(&operation.updated_at)?;
    if (now_ms - ended).abs() >= REMOVAL_RESULT_VISIBLE_MS {
        return None;
    }
    let text = operation
        .outcome_text()
        .or_else(|| fallback(&operation.phase).map(str::to_string))?;
    Some(RemovalResult {
        operation_id: operation.operation_id.clone(),
        platform: operation.platform.clone(),
        author_name: operation.author_name.clone(),
        text,
    })
}

/// What the Buddy pane's removal area shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemovalPane {
    pub cards: Vec<RemovalCard>,
    pub results: Vec<RemovalResult>,
}

impl RemovalPane {
    pub fn active(&self) -> bool {
        !self.cards.is_empty() || !self.results.is_empty()
    }
}

/// `removalPaneView`: oldest card first, the three newest results.
pub fn removal_pane<'a>(
    operations: impl IntoIterator<Item = &'a ModerationOperation>,
    now_ms: i64,
    answering: &[String],
) -> RemovalPane {
    let mut by_age: Vec<&ModerationOperation> = operations.into_iter().collect();
    by_age.sort_by(|left, right| {
        epoch_ms(&left.created_at)
            .cmp(&epoch_ms(&right.created_at))
            .then_with(|| left.operation_id.cmp(&right.operation_id))
    });
    let cards = by_age
        .iter()
        .filter_map(|operation| {
            removal_card(
                operation,
                now_ms,
                answering.contains(&operation.operation_id),
            )
        })
        .collect();
    let mut results: Vec<RemovalResult> = by_age
        .iter()
        .filter_map(|operation| removal_result(operation, now_ms))
        .collect();
    results.reverse();
    results.truncate(3);
    RemovalPane { cards, results }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> LiveChatMessage {
        LiveChatMessage {
            id: "m".into(),
            session_id: "s".into(),
            platform: "twitch".into(),
            author_name: "Ada".into(),
            message_text: "spam".into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        }
    }

    fn operation(id: &str, phase: &str, created: &str) -> ModerationOperation {
        ModerationOperation {
            operation_id: id.into(),
            session_id: "s".into(),
            message_id: "m".into(),
            platform: "twitch".into(),
            phase: phase.into(),
            source: "manual".into(),
            created_at: created.into(),
            updated_at: created.into(),
            ..ModerationOperation::default()
        }
    }

    // `chat-removal-view.test.ts`.
    #[test]
    fn the_row_says_what_a_removal_did() {
        let row = message();
        assert_eq!(removal_status(&row, None, false), None);
        assert_eq!(
            removal_status(&row, None, true).map(|status| status.kind),
            Some(RemovalKind::Removing)
        );
        let mut failed = operation("o", "failed", "2026-11-11T10:00:00Z");
        failed.outcome = Some("Twitch refused.".into());
        let status = removal_status(&row, Some(&failed), false).unwrap();
        assert_eq!(status.kind.label(), "Not removed");
        assert_eq!(status.outcome_line().as_deref(), Some("Twitch refused."));
        let mut hidden = message();
        hidden.is_deleted = true;
        hidden.raw_provider_type = Some(HIDDEN_IN_VIDEORC.into());
        let status = removal_status(&hidden, None, false).unwrap();
        assert_eq!(status.kind.label(), "Hidden in Videorc");
        assert_eq!(
            status.outcome_line().as_deref(),
            Some("Viewers may still see it.")
        );
        let mut removed = message();
        removed.is_deleted = true;
        removed.raw_provider_type = Some(REMOVED_BY_YOU.into());
        let status = removal_status(&removed, None, false).unwrap();
        assert_eq!(status.kind, RemovalKind::Removed);
        assert_eq!(status.outcome_line(), None);
    }

    #[test]
    fn only_a_viewers_message_with_nothing_in_flight_is_offered() {
        let row = message();
        assert!(remove_from_chat_available(&row, None, false));
        assert!(!remove_from_chat_available(&row, None, true));
        let executing = operation("o", "executing", "2026-11-11T10:00:00Z");
        assert!(!remove_from_chat_available(&row, Some(&executing), false));
        let failed = operation("o", "failed", "2026-11-11T10:00:00Z");
        assert!(remove_from_chat_available(&row, Some(&failed), false));
        let mut host = message();
        host.author_roles = vec!["Broadcaster".into()];
        assert!(!chat_message_removable(&host));
        let mut notice = message();
        notice.raw_provider_type = Some("channel.chat.notification.sub".into());
        assert!(!chat_message_removable(&notice));
        let providers = [LiveChatProviderState {
            id: "x1".into(),
            platform: "x".into(),
            moderate: Some("missing-scope".into()),
            ..LiveChatProviderState::default()
        }];
        let mut on_x = message();
        on_x.platform = "x".into();
        assert_eq!(
            remove_from_chat_blocked_reason(&on_x, &providers).as_deref(),
            Some("Authorize X Live to remove messages")
        );
        assert_eq!(remove_from_chat_blocked_reason(&row, &providers), None);
    }

    #[test]
    fn the_ledger_keeps_open_removals_first_and_never_rolls_back() {
        let open = operation("a", "executing", "2026-11-11T10:00:00Z");
        let done = operation("b", "removed", "2026-11-11T10:00:05Z");
        let merged = merge_operations(&[], vec![done.clone(), open.clone()], Some("s"));
        assert_eq!(merged[0].operation_id, "a");
        let mut late = open.clone();
        late.updated_at = "2026-11-11T10:00:09Z".into();
        let terminal = ModerationOperation {
            phase: "removed".into(),
            ..open.clone()
        };
        let merged = merge_operations(&[terminal], vec![late], Some("s"));
        assert_eq!(merged[0].phase, "removed");
        assert!(merge_operations(&merged, Vec::new(), None).is_empty());
        let both = [open.clone(), done.clone()];
        let latest = latest_by_message(&both);
        assert_eq!(latest["m"].operation_id, "b");
        assert_eq!(
            removal_outcome_toast(&done, false),
            None,
            "the row already says Removed"
        );
        let unknown = operation("c", "delivery-unknown", "2026-11-11T10:00:00Z");
        assert_eq!(
            removal_outcome_toast(&unknown, false),
            Some((
                OutcomeKind::Warning,
                "Check chat to see whether it was removed.".into()
            ))
        );
    }
}

#[cfg(test)]
mod buddy_card_tests {
    use super::*;

    fn operation(phase: &str, mode: &str) -> ModerationOperation {
        ModerationOperation {
            operation_id: "op-1".into(),
            session_id: "s".into(),
            message_id: "m".into(),
            platform: "youtube".into(),
            author_name: "Ada".into(),
            excerpt: " spam spam ".into(),
            source: "orcle-voice".into(),
            reason: Some("spam".into()),
            phase: phase.into(),
            confirm_mode: mode.into(),
            confirm_by: Some("2026-11-11T10:00:09Z".into()),
            execute_at: Some("2026-11-11T10:00:04Z".into()),
            created_at: "2026-11-11T09:59:59Z".into(),
            updated_at: "2026-11-11T10:00:00Z".into(),
            ..ModerationOperation::default()
        }
    }

    fn now() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-11-11T10:00:00Z")
            .expect("a time")
            .timestamp_millis()
    }

    #[test]
    fn buddys_removals_wait_on_a_card_and_manual_ones_never_do() {
        let card =
            removal_card(&operation("pending-confirm", "confirm"), now(), false).expect("a card");
        assert_eq!(card.title, "Remove from chat?");
        assert_eq!(card.timer.as_deref(), Some("Expires in 9s"));
        assert_eq!(card.note, Some("YouTube asks you to confirm."));
        assert_eq!((card.primary, card.confirm_label), ("confirm", "Remove"));
        assert_eq!(card.excerpt, "spam spam");
        let countdown =
            removal_card(&operation("pending-confirm", "countdown"), now(), false).expect("a card");
        assert_eq!(countdown.title, "Removing in 4s");
        assert_eq!(
            (countdown.primary, countdown.confirm_label),
            ("cancel", "Remove now")
        );
        let mut manual = operation("pending-confirm", "confirm");
        manual.source = "manual".into();
        assert_eq!(removal_card(&manual, now(), false), None);
        let done = operation("cancelled", "confirm");
        let pane = removal_pane([&done], now(), &[]);
        assert_eq!(pane.results[0].text, "Canceled. Nothing was removed.");
        assert!(pane.active());
    }
}
