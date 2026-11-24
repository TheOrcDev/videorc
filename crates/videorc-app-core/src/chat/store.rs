//! The live chat the Studio holds (`lib/live-chat-view.ts`'s reducers): the
//! backend's snapshot, then its deltas, deduped, chronological and bounded,
//! and the delivery journal the lists count new messages from
//! (`shared/chat-delivery.ts`, the parts one window needs).
//!
//! - A snapshot replaces the view; its rows are hydration, never arrivals.
//! - A delta (`liveChat.message`) is new when its id is; a tombstone (the
//!   same id, deleted) replaces the row it removes; any other repeat is
//!   skipped. Only a new row is an arrival.
//! - Chronological by `receivedAt`, then the id; the newest 2,000 are kept
//!   (`MAX_LIVE_CHAT_VIEW_MESSAGES`; SQLite stays authoritative).
//! - A provider row is replaced by its destination id, or appended.
//! - `liveChat.cleared` and a new livestream restart the journal; a lag the
//!   Studio could not read through marks it incomplete.

use std::collections::VecDeque;
use std::sync::Arc;

use super::model::{LiveChatMessage, LiveChatProviderState, LiveChatSnapshotWire};

/// `MAX_LIVE_CHAT_VIEW_MESSAGES`.
pub const MAX_VIEW_MESSAGES: usize = 2_000;
/// `MAX_CHAT_DELIVERIES`: the journal's length.
pub const MAX_DELIVERIES: usize = 2_000;

/// One admitted message, as the journal remembers it: enough to say
/// whether a list counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryEntry {
    pub sequence: u64,
    pub id: String,
    /// It would show in the Studio's list (`studioChatCountsAsArrival`);
    /// a tombstone clears it ("previously observed counts stay").
    pub counts: bool,
}

/// Where a list stood in the journal (`ChatDeliveryCursor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryCursor {
    pub generation: u64,
    pub sequence: u64,
    pub loss: u64,
}

/// What arrived since a cursor (`chatDeliveryProgress`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryProgress {
    /// Arrivals the list counts.
    pub count: usize,
    /// Some arrivals could not be counted (a lag, or the journal moved past
    /// the cursor): "New chat" rather than a number.
    pub incomplete: bool,
    /// A new livestream or a clear: the count starts over.
    pub reset: bool,
}

/// The delivery journal (`ChatDelivery`): admitted messages in order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatDelivery {
    /// Moves on a clear or a new livestream.
    pub generation: u64,
    /// Admitted messages so far in this generation.
    pub sequence: u64,
    /// Moves when deliveries were lost (a lagged event stream).
    pub loss: u64,
    pub entries: VecDeque<DeliveryEntry>,
}

impl ChatDelivery {
    pub fn cursor(&self) -> DeliveryCursor {
        DeliveryCursor {
            generation: self.generation,
            sequence: self.sequence,
            loss: self.loss,
        }
    }

    fn restart(&mut self) {
        self.generation += 1;
        self.sequence = 0;
        self.entries.clear();
    }

    fn admit(&mut self, id: &str, counts: bool) {
        self.sequence += 1;
        self.entries.push_back(DeliveryEntry {
            sequence: self.sequence,
            id: id.to_string(),
            counts,
        });
        while self.entries.len() > MAX_DELIVERIES {
            self.entries.pop_front();
        }
    }

    /// A tombstone: the message no longer counts toward "{n} new".
    fn redact(&mut self, id: &str) {
        for entry in self.entries.iter_mut().filter(|entry| entry.id == id) {
            entry.counts = false;
        }
    }

    /// `chatDeliveryProgress`: arrivals since `prior` that count. A cursor
    /// from another generation (or none) resets; one the journal no longer
    /// reaches, or a loss since it, is incomplete.
    pub fn progress(&self, prior: Option<DeliveryCursor>) -> DeliveryProgress {
        let Some(prior) = prior.filter(|prior| prior.generation == self.generation) else {
            return DeliveryProgress {
                count: 0,
                incomplete: false,
                reset: true,
            };
        };
        let oldest = self
            .entries
            .front()
            .map_or(self.sequence + 1, |entry| entry.sequence);
        let overrun = prior.sequence + 1 < oldest;
        let count = self
            .entries
            .iter()
            .filter(|entry| entry.sequence > prior.sequence && entry.counts)
            .count();
        DeliveryProgress {
            count,
            incomplete: overrun || prior.loss != self.loss,
            reset: false,
        }
    }
}

/// The live chat the Studio holds (`LiveChatSnapshot` as the renderer's
/// reducers keep it).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveChat {
    /// The livestream the chat belongs to; `None` between livestreams.
    pub session_id: Option<String>,
    pub providers: Vec<LiveChatProviderState>,
    /// Chronological, oldest first, at most [`MAX_VIEW_MESSAGES`].
    pub messages: Arc<Vec<Arc<LiveChatMessage>>>,
    pub updated_at: String,
    pub delivery: Arc<ChatDelivery>,
}

/// `compareMessagesChronological`: `receivedAt`, then the id.
fn chronological(a: &LiveChatMessage, b: &LiveChatMessage) -> std::cmp::Ordering {
    a.received_at
        .cmp(&b.received_at)
        .then_with(|| a.id.cmp(&b.id))
}

fn bound(messages: &mut Vec<Arc<LiveChatMessage>>) {
    if messages.len() > MAX_VIEW_MESSAGES {
        let extra = messages.len() - MAX_VIEW_MESSAGES;
        messages.drain(..extra);
    }
}

impl LiveChat {
    /// `applyLiveChatSnapshot(snapshot, current, reset)`: the view replaced,
    /// chronological and bounded. Its rows are hydration: nothing arrives.
    /// A clear (`reset`) or another livestream restarts the journal.
    pub fn apply_snapshot(&mut self, snapshot: LiveChatSnapshotWire, reset: bool) {
        if reset || snapshot.session_id != self.session_id {
            Arc::make_mut(&mut self.delivery).restart();
        }
        let mut messages: Vec<Arc<LiveChatMessage>> =
            snapshot.messages.into_iter().map(Arc::new).collect();
        messages.sort_by(|a, b| chronological(a, b));
        bound(&mut messages);
        self.session_id = snapshot.session_id;
        self.providers = snapshot.providers;
        self.messages = Arc::new(messages);
        self.updated_at = snapshot.updated_at;
    }

    /// `hydrateChatDelivery` over a snapshot of the session on screen (a
    /// smoke's fixture pushed again): the journal stays, the messages it
    /// admitted that the snapshot lacks stay, and a row the view holds as
    /// deleted stays deleted. Another session is a fresh view.
    pub fn hydrate_snapshot(&mut self, snapshot: LiveChatSnapshotWire) {
        if snapshot.session_id != self.session_id {
            self.apply_snapshot(snapshot, true);
            return;
        }
        let admitted: std::collections::HashSet<&str> = self
            .delivery
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let mut messages: Vec<Arc<LiveChatMessage>> =
            snapshot.messages.into_iter().map(Arc::new).collect();
        let incoming: std::collections::HashSet<String> =
            messages.iter().map(|message| message.id.clone()).collect();
        for held in self.messages.iter() {
            if held.is_deleted && incoming.contains(&held.id) {
                if let Some(slot) = messages.iter_mut().find(|message| message.id == held.id) {
                    *slot = held.clone();
                }
            } else if admitted.contains(held.id.as_str()) && !incoming.contains(&held.id) {
                messages.push(held.clone());
            }
        }
        messages.sort_by(|a, b| chronological(a, b));
        bound(&mut messages);
        self.providers = snapshot.providers;
        self.messages = Arc::new(messages);
        self.updated_at = snapshot.updated_at;
    }

    /// `applyLiveChatMessage`: a new id is inserted in order (scanning back
    /// from the tail: chat arrives in order) and admitted; a tombstone
    /// replaces its row; any other repeat is skipped. True when the view
    /// changed. `counts` says whether the Studio's list would show it.
    pub fn apply_message(&mut self, message: LiveChatMessage, counts: bool) -> bool {
        let existing = self.messages.iter().rposition(|row| row.id == message.id);
        if let Some(index) = existing {
            if !message.is_deleted || self.messages[index].is_deleted {
                return false;
            }
            let id = message.id.clone();
            self.updated_at = message.received_at.clone();
            Arc::make_mut(&mut self.messages)[index] = Arc::new(message);
            Arc::make_mut(&mut self.delivery).redact(&id);
            return true;
        }
        let messages = Arc::make_mut(&mut self.messages);
        let mut at = messages.len();
        while at > 0 && chronological(&message, &messages[at - 1]).is_lt() {
            at -= 1;
        }
        let id = message.id.clone();
        self.updated_at = message.received_at.clone();
        messages.insert(at, Arc::new(message));
        bound(messages);
        Arc::make_mut(&mut self.delivery).admit(&id, counts);
        true
    }

    /// `applyLiveChatProviderStatus`: replaced by the destination's id, or
    /// appended.
    pub fn apply_provider(&mut self, provider: LiveChatProviderState) {
        match self.providers.iter_mut().find(|row| row.id == provider.id) {
            Some(row) => *row = provider,
            None => self.providers.push(provider),
        }
    }

    /// `clearLiveChatForTerminalSession`: the livestream ended; its chat
    /// goes (providers, rows and the session), and the journal restarts.
    /// False when `session_id` is not the chat's livestream.
    pub fn clear_for_terminal_session(&mut self, session_id: &str, updated_at: String) -> bool {
        if self.session_id.as_deref() != Some(session_id) {
            return false;
        }
        self.apply_snapshot(
            LiveChatSnapshotWire {
                updated_at,
                ..LiveChatSnapshotWire::default()
            },
            true,
        );
        true
    }

    /// A lagged event stream: arrivals were lost (`markChatDeliveryIncomplete`).
    pub fn mark_incomplete(&mut self) {
        Arc::make_mut(&mut self.delivery).loss += 1;
    }

    pub fn message(&self, id: &str) -> Option<&Arc<LiveChatMessage>> {
        self.messages.iter().rev().find(|message| message.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, at: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: id.into(),
            session_id: "s".into(),
            platform: "youtube".into(),
            author_name: "Ada".into(),
            received_at: at.into(),
            message_text: format!("words {id}"),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        }
    }

    fn snapshot(session: Option<&str>, messages: Vec<LiveChatMessage>) -> LiveChatSnapshotWire {
        LiveChatSnapshotWire {
            session_id: session.map(str::to_string),
            messages,
            updated_at: "2026-11-10T10:00:00Z".into(),
            ..LiveChatSnapshotWire::default()
        }
    }

    fn ids(chat: &LiveChat) -> Vec<&str> {
        chat.messages.iter().map(|m| m.id.as_str()).collect()
    }

    // `live-chat-view.test.ts`: the snapshot reducer sorts and bounds.
    #[test]
    fn a_snapshot_sorts_by_arrival_then_id_and_keeps_the_newest_2000() {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(
            snapshot(
                Some("s"),
                vec![
                    message("b", "2026-11-10T10:00:02Z"),
                    message("a", "2026-11-10T10:00:02Z"),
                    message("c", "2026-11-10T10:00:01Z"),
                ],
            ),
            false,
        );
        assert_eq!(ids(&chat), ["c", "a", "b"]);
        assert_eq!(chat.delivery.sequence, 0, "hydration is not an arrival");

        let many: Vec<_> = (0..2_005)
            .map(|i| {
                message(
                    &format!("m{i:05}"),
                    &format!("2026-11-10T10:{:02}:{:02}Z", i / 60 % 60, i % 60),
                )
            })
            .collect();
        chat.apply_snapshot(snapshot(Some("s"), many), false);
        assert_eq!(chat.messages.len(), MAX_VIEW_MESSAGES);
    }

    #[test]
    fn a_delta_dedupes_and_a_tombstone_replaces_its_row() {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(snapshot(Some("s"), vec![]), false);
        assert!(chat.apply_message(message("a", "2026-11-10T10:00:01Z"), true));
        assert!(
            !chat.apply_message(message("a", "2026-11-10T10:00:01Z"), true),
            "a repeat is skipped"
        );
        // Out of order: inserted in place.
        assert!(chat.apply_message(message("b", "2026-11-10T10:00:00Z"), true));
        assert_eq!(ids(&chat), ["b", "a"]);
        assert_eq!(chat.delivery.sequence, 2);
        let mut gone = message("a", "2026-11-10T10:00:01Z");
        gone.is_deleted = true;
        gone.event_type = "deleted".into();
        assert!(chat.apply_message(gone.clone(), true));
        assert!(chat.message("a").unwrap().is_deleted);
        // A second tombstone, or the original again, changes nothing.
        assert!(!chat.apply_message(gone, true));
        assert!(!chat.apply_message(message("a", "2026-11-10T10:00:01Z"), true));
        assert_eq!(chat.delivery.sequence, 2, "a tombstone is no arrival");
    }

    #[test]
    fn the_journal_counts_arrivals_since_a_cursor_and_resets_on_a_clear() {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(snapshot(Some("s"), vec![]), false);
        let start = chat.delivery.cursor();
        chat.apply_message(message("a", "1"), true);
        chat.apply_message(message("f", "2"), false);
        chat.apply_message(message("b", "3"), true);
        let progress = chat.delivery.progress(Some(start));
        assert_eq!(
            progress,
            DeliveryProgress {
                count: 2,
                incomplete: false,
                reset: false
            }
        );
        // A tombstone takes its count back.
        let mut gone = message("b", "3");
        gone.is_deleted = true;
        chat.apply_message(gone, false);
        assert_eq!(chat.delivery.progress(Some(start)).count, 1);
        // A lag: incomplete.
        chat.mark_incomplete();
        assert!(chat.delivery.progress(Some(start)).incomplete);
        // A clear or another livestream: the count starts over.
        chat.apply_snapshot(snapshot(Some("s"), vec![]), true);
        assert!(chat.delivery.progress(Some(start)).reset);
        let next = chat.delivery.cursor();
        chat.apply_snapshot(snapshot(Some("t"), vec![]), false);
        assert!(chat.delivery.progress(Some(next)).reset);
        assert!(chat.delivery.progress(None).reset);
    }

    #[test]
    fn the_journal_says_incomplete_once_it_moved_past_the_cursor() {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(snapshot(Some("s"), vec![]), false);
        let start = chat.delivery.cursor();
        for i in 0..(MAX_DELIVERIES + 3) {
            chat.apply_message(message(&format!("m{i:05}"), &format!("{i:05}")), true);
        }
        let progress = chat.delivery.progress(Some(start));
        assert!(progress.incomplete);
        assert_eq!(progress.count, MAX_DELIVERIES);
    }

    #[test]
    fn a_provider_row_is_replaced_by_its_destination() {
        let mut chat = LiveChat::default();
        let row = |id: &str, message: &str| LiveChatProviderState {
            id: id.into(),
            platform: "youtube".into(),
            message: message.into(),
            ..LiveChatProviderState::default()
        };
        chat.apply_provider(row("yt", "Connecting"));
        chat.apply_provider(row("tw", "Connected"));
        chat.apply_provider(row("yt", "Connected"));
        assert_eq!(chat.providers.len(), 2);
        assert_eq!(chat.providers[0].message, "Connected");
    }

    #[test]
    fn the_end_of_its_livestream_clears_the_chat() {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(snapshot(Some("s"), vec![message("a", "1")]), false);
        assert!(!chat.clear_for_terminal_session("other", "now".into()));
        assert_eq!(chat.messages.len(), 1);
        let before = chat.delivery.generation;
        assert!(chat.clear_for_terminal_session("s", "now".into()));
        assert!(chat.messages.is_empty());
        assert_eq!(chat.session_id, None);
        assert!(chat.delivery.generation > before);
    }

    #[test]
    fn a_snapshot_of_the_session_on_screen_keeps_the_arrivals_it_lacks() {
        let mut chat = LiveChat::default();
        let older = vec![
            message("a", "2026-11-10T10:00:00Z"),
            message("b", "2026-11-10T10:00:01Z"),
            message("c", "2026-11-10T10:00:02Z"),
        ];
        chat.apply_snapshot(snapshot(Some("s"), older.clone()), true);
        assert!(chat.apply_message(message("d", "2026-11-10T10:00:03Z"), true));
        let cursor = chat.delivery.cursor();
        // The older snapshot again: "d" was an arrival, so it stays; "c",
        // which only the earlier snapshot had, goes with it.
        chat.hydrate_snapshot(snapshot(Some("s"), older[..2].to_vec()));
        let ids: Vec<&str> = chat.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "d"]);
        assert_eq!(chat.delivery.cursor(), cursor, "the journal stays");
        // Another session is a fresh view.
        chat.hydrate_snapshot(snapshot(
            Some("t"),
            vec![message("x", "2026-11-10T11:00:00Z")],
        ));
        assert_eq!(chat.messages.len(), 1);
        assert!(chat.delivery.generation > cursor.generation);
    }
}
