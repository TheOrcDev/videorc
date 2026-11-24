//! The Stream Manager's History view (plan 260 S1.5a): one session's saved
//! chat and its saved stats in one call, `sessions.comments.history`. Until
//! now Electron main and the Studio each paged `sessions.comments.list` and
//! asked for the stats one RPC at a time, and main kept the result in
//! `comments-history-cache.ts`.
//!
//! The transcript (the newest 2,000 messages, trimmed oldest-first a quarter
//! at a time until its JSON fits 8 MB) stays in a process-lifetime LRU bounded
//! like main's: 8 sessions, 2,000 messages and 8 MB in all, and the session
//! just read is never evicted by its own insertion. SQLite stays the truth: a
//! session whose live chat is running is read fresh and never cached, a
//! deleted session leaves the cache, and the parts that can still change after
//! a stream (the latest send operation, the viewer samples, the audience and
//! the chat totals) are read fresh on every call.

use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};

use crate::audience::AudienceSnapshot;
use crate::live_chat::{CommentsSendOperation, LiveChatMessage};
use crate::state::AppState;
use crate::storage::{Database, SessionChatTotals};
use crate::viewer_stats::ViewerSample;

pub(crate) const MAX_SESSIONS: usize = 8;
pub(crate) const MAX_MESSAGES: usize = 2_000;
pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommentsHistoryParams {
    pub session_id: String,
}

/// What the History view shows. `audience` and `chatTotals` are null when the
/// session has none (a session recorded before the Stream Manager).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommentsHistory {
    pub session_id: String,
    pub messages: Vec<LiveChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_send_operation: Option<CommentsSendOperation>,
    pub viewers: Vec<ViewerSample>,
    pub audience: Option<AudienceSnapshot>,
    pub chat_totals: Option<SessionChatTotals>,
}

struct Transcript {
    session_id: String,
    messages: Arc<Vec<LiveChatMessage>>,
    bytes: usize,
}

/// Least recently read first.
#[derive(Default)]
pub(crate) struct CommentsHistoryCache {
    entries: StdMutex<Vec<Transcript>>,
}

impl CommentsHistoryCache {
    fn get(&self, session_id: &str) -> Option<Arc<Vec<LiveChatMessage>>> {
        let mut entries = self.lock();
        let index = entries
            .iter()
            .position(|entry| entry.session_id == session_id)?;
        let entry = entries.remove(index);
        let messages = entry.messages.clone();
        entries.push(entry);
        Some(messages)
    }

    fn put(&self, session_id: &str, messages: Arc<Vec<LiveChatMessage>>, bytes: usize) {
        let mut entries = self.lock();
        entries.retain(|entry| entry.session_id != session_id);
        entries.push(Transcript {
            session_id: session_id.to_string(),
            messages,
            bytes,
        });
        while over_capacity(&entries) {
            let Some(index) = entries
                .iter()
                .position(|entry| entry.session_id != session_id)
            else {
                break;
            };
            entries.remove(index);
        }
    }

    pub(crate) fn remove(&self, session_id: &str) {
        self.lock().retain(|entry| entry.session_id != session_id);
    }

    /// Sessions, messages and transcript bytes held.
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (usize, usize, usize) {
        let entries = self.lock();
        (
            entries.len(),
            entries.iter().map(|entry| entry.messages.len()).sum(),
            entries.iter().map(|entry| entry.bytes).sum(),
        )
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Transcript>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn over_capacity(entries: &[Transcript]) -> bool {
    entries.len() > MAX_SESSIONS
        || entries
            .iter()
            .map(|entry| entry.messages.len())
            .sum::<usize>()
            > MAX_MESSAGES
        || entries.iter().map(|entry| entry.bytes).sum::<usize>() > MAX_BYTES
}

/// The newest `MAX_MESSAGES`, then the oldest quarter dropped until the JSON
/// fits `MAX_BYTES`: main's `boundView`. Returns the messages and their bytes.
pub(crate) fn bound_transcript(
    mut messages: Vec<LiveChatMessage>,
    max_messages: usize,
    max_bytes: usize,
) -> (Vec<LiveChatMessage>, usize) {
    if messages.len() > max_messages {
        messages.drain(..messages.len() - max_messages);
    }
    let mut bytes = json_bytes(&messages);
    while bytes > max_bytes && !messages.is_empty() {
        let remove = messages.len().div_ceil(4).max(1);
        messages.drain(..remove);
        bytes = json_bytes(&messages);
    }
    (messages, bytes)
}

fn json_bytes(messages: &[LiveChatMessage]) -> usize {
    serde_json::to_vec(messages).map_or(usize::MAX, |json| json.len())
}

fn totals_session_id(totals: &SessionChatTotals) -> &str {
    match totals {
        SessionChatTotals::Available { session_id, .. }
        | SessionChatTotals::LegacyUnavailable { session_id } => session_id,
    }
}

/// The transcript part of the view, from the cache or from SQLite.
fn transcript(
    cache: &CommentsHistoryCache,
    database: &Database,
    session_id: &str,
    live: bool,
) -> anyhow::Result<Arc<Vec<LiveChatMessage>>> {
    if !live && let Some(messages) = cache.get(session_id) {
        return Ok(messages);
    }
    let recent = database.list_live_chat_messages_recent(session_id, MAX_MESSAGES)?;
    let (messages, bytes) = bound_transcript(recent, MAX_MESSAGES, MAX_BYTES);
    let messages = Arc::new(messages);
    if !live {
        cache.put(session_id, messages.clone(), bytes);
    }
    Ok(messages)
}

/// Assemble one session's History view. A stats read that fails leaves that
/// part empty, as main's loader did; only the transcript read is an error.
pub(crate) fn history(
    cache: &CommentsHistoryCache,
    database: &Database,
    session_id: &str,
    live: bool,
) -> anyhow::Result<CommentsHistory> {
    let messages = transcript(cache, database, session_id, live)?;
    let latest_send_operation = database
        .latest_chat_send_operation(session_id)
        .unwrap_or_default();
    let viewers =
        crate::viewer_stats::session_viewer_history(database, session_id).unwrap_or_default();
    let audience = crate::audience::session_audience(database, session_id).unwrap_or_default();
    let chat_totals = database
        .session_chat_totals(session_id)
        .unwrap_or_default()
        .filter(|totals| totals_session_id(totals) == session_id);
    Ok(CommentsHistory {
        session_id: session_id.to_string(),
        messages: messages.as_ref().clone(),
        latest_send_operation,
        viewers,
        audience,
        chat_totals,
    })
}

/// `sessions.comments.history`.
pub(crate) async fn load(state: &AppState, session_id: &str) -> anyhow::Result<CommentsHistory> {
    if session_id.is_empty() || session_id.encode_utf16().count() > 4096 {
        anyhow::bail!("A chat history needs a session id of 1 to 4096 characters.");
    }
    let live = state.live_chat.lock().await.session_id() == Some(session_id);
    history(&state.comments_history, &state.database, session_id, live)
}

#[cfg(test)]
mod tests;
