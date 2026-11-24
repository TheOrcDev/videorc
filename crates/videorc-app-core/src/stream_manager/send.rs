//! Sending to chat (Comments upgrade S5; `lib/chat-send.ts`,
//! `shared/comments-send-operation.ts`, `stream-manager-chat.ts`'s picker,
//! `components/comments-destination-status.tsx`'s composer line): where a
//! message goes, its explicit pending operation, and how each destination's
//! result reads back. Never silently partial: a failure always names its
//! platform.

use serde::{Deserialize, Serialize};

use crate::chat::model::LiveChatProviderState;
use crate::chat::view::platform_label;

/// `CHAT_SEND_MAX_CHARS`.
pub const CHAT_SEND_MAX_CHARS: usize = 200;

/// `CHAT_SEND_PLATFORM_MAX_CHARS`: Kick takes 500, X broadcast chat 140.
pub fn platform_max_chars(platform: &str) -> usize {
    match platform {
        "kick" => 500,
        "x" => 140,
        _ => CHAT_SEND_MAX_CHARS,
    }
}

/// `chatDraftMaxChars`: the strictest cap of the platforms a send reaches.
pub fn chat_draft_max_chars(targets: &[String]) -> usize {
    targets
        .iter()
        .map(|platform| platform_max_chars(platform))
        .fold(CHAT_SEND_MAX_CHARS, usize::min)
}

/// A draft's length as the renderer counts it (`String.length`, UTF-16).
pub fn draft_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `validateChatDraft`: the trimmed words, or none when empty or too long.
pub fn validate_chat_draft(draft: &str, max_chars: usize) -> Option<String> {
    let text = draft.trim();
    if text.is_empty() || draft_length(text) > max_chars {
        return None;
    }
    Some(text.to_string())
}

/// `DestinationDelivery`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationDelivery {
    pub destination_id: String,
    #[serde(default)]
    pub platform: String,
    /// `pending`, `sent`, `failed`, `read-only`, `unavailable`,
    /// `timed-out-unknown`.
    #[serde(default)]
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `CommentsSendOperation`: one persisted, idempotent send-to-all.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsSendOperation {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub text: String,
    /// `sending`, `sent`, `partial` or `failed`.
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub destinations: Vec<DestinationDelivery>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl CommentsSendOperation {
    /// `commentsSendOperationTerminal`.
    pub fn terminal(&self) -> bool {
        self.phase != "sending"
    }
}

fn timestamp(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|at| at.timestamp_millis())
        .unwrap_or(0)
}

/// `reconcileCommentsSendOperation`: the newest operation for a session,
/// never a terminal receipt rolled back to `sending`.
pub fn reconcile_send_operation(
    current: Option<&CommentsSendOperation>,
    candidate: CommentsSendOperation,
) -> CommentsSendOperation {
    let Some(current) = current.filter(|current| current.session_id == candidate.session_id) else {
        return candidate;
    };
    if current.id == candidate.id {
        if !current.terminal() && candidate.terminal() {
            return candidate;
        }
        if current.terminal() && !candidate.terminal() {
            return current.clone();
        }
        return if timestamp(&candidate.updated_at) < timestamp(&current.updated_at) {
            current.clone()
        } else {
            candidate
        };
    }
    let created = timestamp(&candidate.created_at) - timestamp(&current.created_at);
    if created != 0 {
        return if created > 0 {
            candidate
        } else {
            current.clone()
        };
    }
    if timestamp(&candidate.updated_at) > timestamp(&current.updated_at) {
        candidate
    } else {
        current.clone()
    }
}

/// `writableProviders`: the destinations the "Send to" picker offers.
pub fn writable_providers(providers: &[LiveChatProviderState]) -> Vec<&LiveChatProviderState> {
    providers
        .iter()
        .filter(|provider| provider.write == "ready")
        .collect()
}

/// `pickedSendProviders`: the picked ones still writable, or every writable
/// one when nothing is picked. A pick gone read-only never widens to all.
pub fn picked_send_providers<'a>(
    providers: &'a [LiveChatProviderState],
    picked: Option<&[String]>,
) -> Vec<&'a LiveChatProviderState> {
    let writable = writable_providers(providers);
    match picked {
        Some(picked) => writable
            .into_iter()
            .filter(|provider| picked.contains(&provider.id))
            .collect(),
        None => writable,
    }
}

/// The platforms a send reaches, each once.
pub fn target_platforms(targets: &[&LiveChatProviderState]) -> Vec<String> {
    let mut platforms: Vec<String> = Vec::new();
    for provider in targets {
        if !platforms.contains(&provider.platform) {
            platforms.push(provider.platform.clone());
        }
    }
    platforms
}

/// The picker's words: "All", "None", or the picked platforms.
pub fn pick_label(
    picked: Option<&[String]>,
    targets: usize,
    writable: usize,
    names: &[&str],
) -> String {
    if picked.is_none() || targets == writable {
        "All".to_string()
    } else if targets == 0 {
        "None".to_string()
    } else {
        names.join(", ")
    }
}

/// `pendingCommentsSendOperation`: the explicit pending state while the
/// backend's command runs. It never invents a sent message.
pub fn pending_send_operation(
    id: &str,
    session_id: &str,
    text: &str,
    providers: &[&LiveChatProviderState],
    now: &str,
) -> CommentsSendOperation {
    let destinations: Vec<DestinationDelivery> = providers
        .iter()
        .map(|provider| {
            let (phase, reason) = match provider.write.as_str() {
                "read-only" => (
                    "read-only",
                    Some("This destination supports receiving chat only."),
                ),
                "missing-scope" => (
                    "unavailable",
                    Some("Reconnect this account to grant chat write permission."),
                ),
                "failed" => (
                    "failed",
                    Some("This destination's chat sender is unavailable."),
                ),
                "ready" => ("pending", None),
                _ => (
                    "unavailable",
                    Some("Sending is unavailable for this destination."),
                ),
            };
            DestinationDelivery {
                destination_id: provider.id.clone(),
                platform: provider.platform.clone(),
                phase: phase.to_string(),
                provider_message_id: None,
                reason: reason.map(str::to_string),
            }
        })
        .collect();
    let sending = destinations
        .iter()
        .any(|destination| destination.phase == "pending");
    CommentsSendOperation {
        id: id.to_string(),
        session_id: session_id.to_string(),
        text: text.to_string(),
        phase: if sending { "sending" } else { "failed" }.to_string(),
        destinations,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

/// `ChatSendFailure`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSendFailure {
    pub destination_id: String,
    pub platform: String,
    pub reason: String,
}

impl ChatSendFailure {
    /// The badge's words: "Twitch: Send failed." (a transport failure names
    /// no platform: its badge is the reason alone).
    pub fn badge(&self) -> String {
        format!("{}: {}", platform_label(&self.platform), self.reason)
    }
}

/// `chatSendFailures`: failed and ambiguous destinations stay visible.
pub fn send_failures(operation: Option<&CommentsSendOperation>) -> Vec<ChatSendFailure> {
    let Some(operation) = operation else {
        return Vec::new();
    };
    operation
        .destinations
        .iter()
        .filter(|destination| matches!(destination.phase.as_str(), "failed" | "timed-out-unknown"))
        .map(|destination| ChatSendFailure {
            destination_id: destination.destination_id.clone(),
            platform: destination.platform.clone(),
            reason: destination.reason.clone().unwrap_or_else(|| {
                if destination.phase == "timed-out-unknown" {
                    "Delivery is unknown; Videorc didn't retry.".to_string()
                } else {
                    "Send failed.".to_string()
                }
            }),
        })
        .collect()
}

/// What Retry does (plan 174 S3.16a, H-26).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPlan {
    /// Only these destinations; `None` sends as before.
    pub destination_ids: Option<Vec<String>>,
    /// Nobody got it: the words come back into the composer.
    pub restore_draft: bool,
}

/// `chatSendRetryPlan`: a send that reached nobody comes back whole; a
/// partial one retries only where it failed, so nobody gets it twice.
pub fn retry_plan(
    operation: Option<&CommentsSendOperation>,
    failures: &[ChatSendFailure],
) -> Option<RetryPlan> {
    if failures.is_empty() {
        return None;
    }
    let sent = operation.is_some_and(|operation| {
        operation
            .destinations
            .iter()
            .any(|destination| destination.phase == "sent")
    });
    if !sent {
        return Some(RetryPlan {
            destination_ids: None,
            restore_draft: true,
        });
    }
    let ids = failures
        .iter()
        .map(|failure| failure.destination_id.clone())
        .filter(|id| {
            operation.is_some_and(|operation| {
                operation
                    .destinations
                    .iter()
                    .any(|destination| destination.destination_id == *id)
            })
        })
        .collect();
    Some(RetryPlan {
        destination_ids: Some(ids),
        restore_draft: false,
    })
}

/// One destination badge of the empty chat (`CommentsDestinationStatus`):
/// the platform (its mark), "YouTube · Connected" and its tone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationBadge {
    pub platform: String,
    pub text: String,
    pub tone: &'static str,
}

/// `waitingProviderMessage` (plan 094): a parked connector names its resume
/// time ("… It resumes at 9:00 AM. Your stream keeps going."); None when
/// the connector isn't waiting on a time.
pub fn waiting_provider_message(
    provider: &LiveChatProviderState,
    now: chrono::DateTime<chrono::Local>,
) -> Option<String> {
    let message = provider.message.trim();
    let retry_at = provider.retry_at.as_deref()?;
    if provider.state != "waiting" {
        return None;
    }
    let resume = format!("It resumes at {}.", format_resume_time(retry_at, now));
    let keeps_going = if provider.platform == "youtube" {
        " Your stream keeps going."
    } else {
        ""
    };
    Some(
        format!("{message} {resume}{keeps_going}")
            .trim()
            .to_string(),
    )
}

/// `chatStateLabel` (`lib/state-labels.ts`).
pub fn chat_state_label(provider: &LiveChatProviderState) -> &'static str {
    match provider.read.as_str() {
        "needs-sign-in" => return "Needs Sign in",
        "needs-videorc-sign-in" => return "Needs Videorc sign-in",
        _ => {}
    }
    match provider.state.as_str() {
        "failed" => return "Failed",
        "ended" => return "Ended",
        "disabled" => return "Off",
        "unsupported" => return "Unavailable",
        _ => {}
    }
    if provider.read == "unavailable" {
        return "Unavailable";
    }
    match provider.state.as_str() {
        "connecting" => return "Connecting…",
        "reconnecting" => return "Reconnecting…",
        "waiting" => return "Waiting…",
        _ => {}
    }
    match provider.write.as_str() {
        "ready" => "Connected",
        "missing-scope" => "Reconnect to send",
        "failed" => "Send failed",
        _ => "Read-only",
    }
}

/// `CommentsDestinationStatus` (providers mode) under the empty chat: each
/// destination's "{Platform} · {state}" badge and its tone (`success`,
/// `warning`, `destructive`, `neutral`), and the line for what a badge
/// cannot say (the account chat reads as).
pub fn destination_badges(
    providers: &[LiveChatProviderState],
) -> (Vec<DestinationBadge>, Vec<String>) {
    let badges = providers
        .iter()
        .map(|provider| {
            let tone = match provider.state.as_str() {
                "connected" => "success",
                "connecting" | "reconnecting" | "waiting" => "warning",
                "failed" => "destructive",
                _ => "neutral",
            };
            DestinationBadge {
                platform: provider.platform.clone(),
                text: format!(
                    "{} · {}",
                    platform_label(&provider.platform),
                    chat_state_label(provider)
                ),
                tone,
            }
        })
        .collect();
    // `providerBadgeTitle`: the paused connector's resume time (plan 094),
    // then the account the chat is read as.
    let details = providers
        .iter()
        .filter_map(|provider| {
            let waiting = waiting_provider_message(provider, chrono::Local::now());
            let identity = provider
                .account_label
                .as_deref()
                .map(|account| format!("Reading chat as {account}."));
            let line = match (waiting, identity) {
                (Some(message), Some(identity)) => format!("{message} · {identity}"),
                (Some(message), None) => message,
                (None, Some(identity)) => identity,
                (None, None) => return None,
            };
            Some(format!("{}: {line}", platform_label(&provider.platform)))
        })
        .collect();
    (badges, details)
}

/// `commentsDestinationNotes`: only the exceptions (plan 057, D3): "X
/// read-only", "Twitch reconnect to send"; empty when everything can send.
pub fn destination_notes(providers: &[LiveChatProviderState], send_targets: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if send_targets.is_empty() {
        parts.push("No writable destinations".to_string());
    }
    let mut described: Vec<&str> = Vec::new();
    for provider in providers {
        if described.contains(&provider.platform.as_str()) {
            continue;
        }
        described.push(&provider.platform);
        if send_targets.contains(&provider.platform) {
            continue;
        }
        let label = platform_label(&provider.platform);
        if provider.write == "missing-scope" {
            parts.push(format!("{label} reconnect to send"));
        } else if provider.write == "failed" {
            parts.push(format!("{label} send failed"));
        } else if provider.write == "read-only" || provider.state == "connected" {
            parts.push(format!("{label} read-only"));
        } else if provider.state == "failed" {
            parts.push(format!("{label} failed"));
        } else if matches!(provider.state.as_str(), "connecting" | "reconnecting") {
            parts.push(format!(
                "{label} {}",
                chat_state_label(provider).to_lowercase()
            ));
        }
    }
    parts.join(" · ")
}

/// `formatResumeTime` (`lib/youtube-quota-copy.ts`): the time, "tomorrow"
/// and the time, or the date and the time, in the system's local zone; "the
/// reset" for a time it can't read. S1.6c's `livestream::copy` (L7) shows
/// the same words on the destination cards and re-exports this one.
pub fn format_resume_time(at: &str, now: chrono::DateTime<chrono::Local>) -> String {
    let Ok(date) = chrono::DateTime::parse_from_rfc3339(at) else {
        return "the reset".to_string();
    };
    let date = date.with_timezone(&chrono::Local);
    let time = date.format("%I:%M %p").to_string();
    if date.date_naive() == now.date_naive() {
        return time;
    }
    if now.date_naive().succ_opt() == Some(date.date_naive()) {
        return format!("tomorrow {time}");
    }
    format!("{} {time}", date.format("%b %-d"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, platform: &str, write: &str, state: &str) -> LiveChatProviderState {
        LiveChatProviderState {
            id: id.into(),
            platform: platform.into(),
            read: "ready".into(),
            write: write.into(),
            state: state.into(),
            ..LiveChatProviderState::default()
        }
    }

    fn operation(
        id: &str,
        phase: &str,
        updated: &str,
        destinations: &[(&str, &str)],
    ) -> CommentsSendOperation {
        CommentsSendOperation {
            id: id.into(),
            session_id: "s".into(),
            text: "hi".into(),
            phase: phase.into(),
            destinations: destinations
                .iter()
                .map(|(id, phase)| DestinationDelivery {
                    destination_id: (*id).into(),
                    platform: "twitch".into(),
                    phase: (*phase).into(),
                    ..DestinationDelivery::default()
                })
                .collect(),
            created_at: "2026-11-11T10:00:00Z".into(),
            updated_at: updated.into(),
        }
    }

    // `chat-send.test.ts`.
    #[test]
    fn the_strictest_destination_sets_the_cap() {
        assert_eq!(chat_draft_max_chars(&["youtube".into()]), 200);
        assert_eq!(chat_draft_max_chars(&["youtube".into(), "x".into()]), 140);
        assert_eq!(chat_draft_max_chars(&["kick".into()]), 200);
        assert_eq!(chat_draft_max_chars(&[]), 200);
        assert_eq!(validate_chat_draft("  hi ", 200).as_deref(), Some("hi"));
        assert_eq!(validate_chat_draft("   ", 200), None);
        assert_eq!(validate_chat_draft(&"x".repeat(141), 140), None);
    }

    #[test]
    fn a_pending_send_names_what_each_destination_will_do() {
        let providers = [
            provider("yt", "youtube", "ready", "connected"),
            provider("x", "x", "read-only", "connected"),
        ];
        let refs: Vec<&LiveChatProviderState> = providers.iter().collect();
        let pending = pending_send_operation("op", "s", "hi", &refs, "2026-11-11T10:00:00Z");
        assert_eq!(pending.phase, "sending");
        assert_eq!(pending.destinations[1].phase, "read-only");
        let none = pending_send_operation("op", "s", "hi", &refs[1..], "2026-11-11T10:00:00Z");
        assert_eq!(none.phase, "failed");
        assert_eq!(
            destination_notes(&providers, &["youtube".into()]),
            "X read-only"
        );
        assert_eq!(
            destination_notes(&providers[1..], &[]),
            "No writable destinations · X read-only"
        );
    }

    #[test]
    fn retry_restores_a_send_nobody_got_and_retries_only_the_failed_part() {
        let failed = operation("a", "failed", "2026-11-11T10:00:01Z", &[("tw", "failed")]);
        let failures = send_failures(Some(&failed));
        assert_eq!(failures[0].reason, "Send failed.");
        assert_eq!(
            retry_plan(Some(&failed), &failures),
            Some(RetryPlan {
                destination_ids: None,
                restore_draft: true
            })
        );
        let partial = operation(
            "a",
            "partial",
            "2026-11-11T10:00:01Z",
            &[("yt", "sent"), ("tw", "timed-out-unknown")],
        );
        let failures = send_failures(Some(&partial));
        assert_eq!(
            failures[0].reason,
            "Delivery is unknown; Videorc didn't retry."
        );
        assert_eq!(
            retry_plan(Some(&partial), &failures)
                .unwrap()
                .destination_ids,
            Some(vec!["tw".to_string()])
        );
        assert_eq!(retry_plan(Some(&partial), &[]), None);
    }

    // `comments-send-operation.test.ts`.
    #[test]
    fn a_terminal_receipt_never_rolls_back_to_sending() {
        let sending = operation("a", "sending", "2026-11-11T10:00:05Z", &[]);
        let sent = operation("a", "sent", "2026-11-11T10:00:01Z", &[]);
        assert_eq!(
            reconcile_send_operation(Some(&sending), sent.clone()).phase,
            "sent"
        );
        assert_eq!(reconcile_send_operation(Some(&sent), sending).phase, "sent");
        let mut newer = operation("b", "sending", "2026-11-11T10:00:09Z", &[]);
        newer.created_at = "2026-11-11T10:00:09Z".into();
        assert_eq!(reconcile_send_operation(Some(&sent), newer).id, "b");
    }

    #[test]
    fn the_picker_never_widens_a_pick() {
        let providers = [
            provider("yt", "youtube", "ready", "connected"),
            provider("tw", "twitch", "ready", "connected"),
            provider("x", "x", "read-only", "connected"),
        ];
        assert_eq!(picked_send_providers(&providers, None).len(), 2);
        let picked = ["tw".to_string(), "x".to_string()];
        let targets = picked_send_providers(&providers, Some(&picked));
        assert_eq!(targets.len(), 1);
        assert_eq!(pick_label(Some(&picked), 1, 2, &["Twitch"]), "Twitch");
        assert_eq!(pick_label(None, 2, 2, &[]), "All");
        assert_eq!(pick_label(Some(&[]), 0, 2, &[]), "None");
    }
}
