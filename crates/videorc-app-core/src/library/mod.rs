//! The Library (plan 260 S1.6f, from `videorc-rust`'s plan 220 S3.7a):
//! every recording, as `use-studio.tsx` keeps the renderer's `sessions` state
//! and the Library tab acts on it.
//!
//! - **The list** is the backend's (`sessions.list`, 50 a page, and
//!   `sessions.storage`), read again when the backend connects, when a
//!   capture starts or ends (`recording.status`: the live row shows at once,
//!   the finished one settles), after a quality event, a saved clip, and
//!   after each of the page's own changes. Deletions a crash left half-done
//!   are finished first (`sessions.delete.pending`).
//! - **Rows follow `recording.finalization`**: the export's progress, the
//!   MP4 and its size are patched in place; a finished take not loaded yet
//!   reads the list again, and the totals are read again at its end. A page
//!   that was in flight while events arrived takes them on its answer
//!   ([`view::FinalizationJournal`]).
//! - **The page's actions** are requests by name ([`LibraryBackend`]):
//!   rename, duplicate, import, the MP4 export, the quality check, its
//!   repair and restore, and the markers. These methods are the backend's
//!   but not in Electron's typed `BackendRpcMethodMap`, so they go by name.
//!   Delete is the two-phase operation main runs: the backend names the
//!   files, they move to the Trash ([`LibraryFiles`], which the GPUI app's
//!   desktop layer implements, S2.6a), and it completes.
//! - **Posters** come from the backend's loopback server
//!   (`/sessions/{id}/poster?token=`), with one `sessions.poster` backfill
//!   for an older recording that has none yet.
//!
//! Its words are [`copy`], its pure logic [`view`], the page as one value
//! [`page`] and the Markers dialog [`markers`]. The Cloud tab (Local |
//! Cloud) is [`cloud`], and noise cleanup's row control [`noise`]. The
//! player (`SessionPlayer`) waits for the playback client methods (S1.7b).

pub mod cloud;
pub mod copy;
pub mod markers;
pub mod noise;
pub mod page;
pub mod view;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
use videorc_protocol::repair::GateStatus;
use videorc_protocol::{
    RecordingFinalizationState, RecordingState, SessionListItem, SessionListPage, SessionLogEntry,
    SessionLogsPage,
};

use crate::client::{BackendClient, BackendEvent, RpcError};
use markers::SessionMarker;
use view::FinalizationJournal;

/// `SESSION_LIST_PAGE_LIMIT`.
pub const PAGE_LIMIT: usize = 50;

/// The marker events the Markers dialog follows.
pub const MARKER_CREATED_EVENT: &str = "session.marker.created";
pub const MARKER_CHANGED_EVENT: &str = "session.marker.changed";
/// A saved clip lands in the Library.
pub const REPLAY_SAVED_EVENT: &str = "replay.saved";

/// The events the Library reads beyond the Studio's (the client's include
/// list adds them).
pub const LIBRARY_EVENTS: [&str; 2] = [MARKER_CREATED_EVENT, MARKER_CHANGED_EVENT];

/// The backend, as the Library asks it: one request by name.
pub trait LibraryBackend: Send + Sync + 'static {
    fn library_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send;
}

impl LibraryBackend for BackendClient {
    async fn library_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.request(method, params).await
    }
}

/// The files half of a delete: main's `trashSessionDeletion`.
pub trait LibraryFiles: Send + Sync + 'static {
    fn trash_session_deletion(
        &self,
        operation_id: &str,
    ) -> impl Future<Output = Result<TrashOutcome, String>> + Send;
}

/// What moving a deletion's files to the Trash did (`TrashSessionDeletionResult`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrashOutcome {
    pub deleted: bool,
    pub failed_count: usize,
    /// The session the deletion was for.
    pub session_id: String,
}

/// The poster's largest picture and how long its read may take
/// (`chat/images`' loopback limits in `videorc-rust`).
const POSTER_MAX_BYTES: usize = 2 * 1024 * 1024;
const POSTER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(4);

/// What the Library holds, as the page reads it.
#[derive(Debug, Clone, Default)]
pub struct LibraryData {
    pub sessions: Vec<SessionListItem>,
    pub next_cursor: Option<String>,
    /// `sessions.storage`: the count and the bytes; `None` before the first
    /// page (they ride with it).
    pub totals: Option<(i64, i64)>,
    pub loading_more: bool,
    /// The first page arrived.
    pub loaded: bool,
    /// The backend is connected (`wsStatus === 'connected'`).
    pub online: bool,
    /// The logs of the rows that may be a refused Record (`mayBeStartFailed`).
    pub logs: BTreeMap<String, Vec<SessionLogEntry>>,
    /// The loopback server's port and the Studio's token, for posters.
    pub server: Option<(u16, String)>,
    /// A marker of this session changed (its count goes up each time).
    pub marker_changes: BTreeMap<String, u64>,
}

impl LibraryData {
    /// The facts the page view reads.
    pub fn facts(&self) -> page::DataFacts<'_> {
        page::DataFacts {
            sessions: &self.sessions,
            has_more: self.next_cursor.is_some(),
            loading_more: self.loading_more,
            loaded: self.loaded,
            online: self.online,
            totals: self.totals,
            logs: &self.logs,
        }
    }
}

/// A delete's answer for one recording (`SessionDeletionOperation`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletionOperation {
    operation_id: String,
    #[serde(default)]
    path_count: usize,
    #[serde(default)]
    blocked_path_count: usize,
}

/// Why a delete kept some recordings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteError {
    Rpc(RpcError),
    /// Some files could not move: their recordings were kept.
    FilesKept(String),
}

/// `FileAssessment`, the quality check's answer.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    #[serde(default)]
    pub issues: Vec<Value>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub repairable: bool,
    #[serde(default)]
    pub has_backup: bool,
}

impl Assessment {
    /// The first reason, or the first issue's kind.
    pub fn first_reason(&self) -> Option<String> {
        self.reasons.first().cloned().or_else(|| {
            self.issues
                .first()
                .and_then(|issue| issue.get("kind"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    }
}

#[derive(Default)]
struct Inner {
    journal: FinalizationJournal,
    /// The last recording state and session (`previousState`).
    last_state: Option<(RecordingState, Option<String>)>,
    logs_asked: BTreeSet<String>,
}

/// The Library's data and its requests.
pub struct Library<B: LibraryBackend, F: LibraryFiles> {
    backend: Arc<B>,
    files: Arc<F>,
    data: watch::Sender<LibraryData>,
    inner: Mutex<Inner>,
    /// The latest first-page read; an older answer is dropped.
    refresh_token: AtomicU64,
    /// Bumped by every first-page read: a next page begun before it is
    /// dropped.
    list_generation: AtomicU64,
    totals_read: AtomicU64,
    marker_sequence: AtomicU64,
}

fn read<T: serde::de::DeserializeOwned>(method: &str, value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value)
        .map_err(|error| RpcError::new(method, "bad-response", error.to_string()))
}

impl<B: LibraryBackend, F: LibraryFiles> Library<B, F> {
    pub fn new(backend: Arc<B>, files: Arc<F>) -> Self {
        Self {
            backend,
            files,
            data: watch::Sender::new(LibraryData::default()),
            inner: Mutex::new(Inner::default()),
            refresh_token: AtomicU64::new(0),
            list_generation: AtomicU64::new(0),
            totals_read: AtomicU64::new(0),
            marker_sequence: AtomicU64::new(0),
        }
    }

    pub fn watch(&self) -> watch::Receiver<LibraryData> {
        self.data.subscribe()
    }

    pub fn data(&self) -> LibraryData {
        self.data.borrow().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.backend.library_request(method, params).await
    }

    /// `resumePendingSessionDeletions`: a deletion a crash left half-done
    /// moves its files now; one that still fails stays for the next read.
    async fn resume_pending_deletions(&self) {
        let Ok(answer) = self.request("sessions.delete.pending", Value::Null).await else {
            return;
        };
        let operations: Vec<DeletionOperation> =
            read("sessions.delete.pending", answer).unwrap_or_default();
        for operation in operations {
            let _ = self
                .files
                .trash_session_deletion(&operation.operation_id)
                .await;
        }
    }

    /// `refreshSessions`: the first page and the totals, the newest read
    /// winning.
    pub async fn refresh(&self) -> Result<(), RpcError> {
        let token = self.refresh_token.fetch_add(1, Ordering::SeqCst) + 1;
        let checkpoint = self.lock().journal.checkpoint();
        self.list_generation.fetch_add(1, Ordering::SeqCst);
        self.data.send_if_modified(|data| {
            let was = data.loading_more;
            data.loading_more = false;
            was
        });
        self.resume_pending_deletions().await;
        let list = self.request("sessions.list", json!({ "limit": PAGE_LIMIT }));
        let totals = self.request("sessions.storage", Value::Null);
        let (list, totals) = tokio::join!(list, totals);
        let page: SessionListPage = read("sessions.list", list?)?;
        let totals: Value = totals?;
        if self.refresh_token.load(Ordering::SeqCst) != token {
            return Ok(());
        }
        self.list_generation.fetch_add(1, Ordering::SeqCst);
        let mut rows = page.items;
        self.lock().journal.reconcile(&mut rows, checkpoint);
        let totals = read_totals(&totals);
        self.data.send_modify(|data| {
            data.sessions = rows;
            data.next_cursor = page.next_cursor;
            data.totals = totals.or(data.totals);
            data.loaded = true;
            data.loading_more = false;
        });
        self.load_start_failed_logs().await;
        Ok(())
    }

    /// `loadMoreSessions`: the next page, appended once.
    pub async fn load_more(&self) -> Result<(), RpcError> {
        let (cursor, busy) = {
            let data = self.data.borrow();
            (data.next_cursor.clone(), data.loading_more)
        };
        let Some(cursor) = cursor else {
            return Ok(());
        };
        if busy {
            return Ok(());
        }
        let generation = self.list_generation.load(Ordering::SeqCst);
        let checkpoint = self.lock().journal.checkpoint();
        self.data.send_modify(|data| data.loading_more = true);
        let answer = self
            .request(
                "sessions.list",
                json!({ "cursor": cursor, "limit": PAGE_LIMIT }),
            )
            .await;
        if self.list_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        let page: SessionListPage = match answer.and_then(|value| read("sessions.list", value)) {
            Ok(page) => page,
            Err(error) => {
                self.data.send_modify(|data| data.loading_more = false);
                return Err(error);
            }
        };
        let mut rows = page.items;
        self.lock().journal.reconcile(&mut rows, checkpoint);
        self.data.send_modify(|data| {
            let seen: BTreeSet<String> = data.sessions.iter().map(|s| s.id.clone()).collect();
            data.sessions
                .extend(rows.into_iter().filter(|row| !seen.contains(&row.id)));
            data.next_cursor = page.next_cursor;
            data.loading_more = false;
        });
        self.load_start_failed_logs().await;
        Ok(())
    }

    /// A failed row with no file reads its logs once, to say whether Record
    /// was refused before anything was written.
    async fn load_start_failed_logs(&self) {
        let wanted: Vec<String> = {
            let data = self.data.borrow();
            let mut inner = self.lock();
            data.sessions
                .iter()
                .filter(|session| view::may_be_start_failed(session))
                .filter(|session| inner.logs_asked.insert(session.id.clone()))
                .map(|session| session.id.clone())
                .collect()
        };
        for session_id in wanted {
            let answer = self
                .request(
                    "sessions.logs.list",
                    json!({ "sessionId": session_id, "limit": 200 }),
                )
                .await;
            if let Ok(page) =
                answer.and_then(|value| read::<SessionLogsPage>("sessions.logs.list", value))
            {
                self.data.send_modify(|data| {
                    data.logs.insert(session_id.clone(), page.entries);
                });
            }
        }
    }

    async fn reread_totals(&self) {
        let read_id = self.totals_read.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(value) = self.request("sessions.storage", Value::Null).await
            && self.totals_read.load(Ordering::SeqCst) == read_id
            && let Some(totals) = read_totals(&value)
        {
            self.data.send_modify(|data| data.totals = Some(totals));
        }
    }

    /// `renameSession`.
    pub async fn rename(&self, session_id: &str, title: &str) -> Result<(), RpcError> {
        self.request(
            "sessions.rename",
            json!({ "sessionId": session_id, "title": title }),
        )
        .await?;
        let _ = self.refresh().await;
        Ok(())
    }

    /// `duplicateSession`: the copy's id.
    pub async fn duplicate(&self, session_id: &str) -> Result<Option<String>, RpcError> {
        let answer = self
            .request("sessions.duplicate", json!({ "sessionId": session_id }))
            .await?;
        let _ = self.refresh().await;
        Ok(session_id_of(&answer))
    }

    /// `importRecording`'s request: the picked file and, when one is chosen,
    /// the output folder; the new row's id.
    pub async fn import(
        &self,
        source_capability: &str,
        output_directory_capability: Option<&str>,
    ) -> Result<Option<String>, RpcError> {
        let mut params = json!({ "sourceCapability": source_capability });
        if let Some(output) = output_directory_capability {
            params["outputDirectoryCapability"] = json!(output);
        }
        let answer = self.request("sessions.import", params).await?;
        let _ = self.refresh().await;
        Ok(session_id_of(&answer))
    }

    /// `deleteSessions`: the backend's two-phase delete; the files go to the
    /// Trash, and a file that could not keeps its recording.
    pub async fn delete(&self, session_ids: &[String]) -> Result<(), DeleteError> {
        let answer = self
            .request("sessions.delete", json!({ "sessionIds": session_ids }))
            .await
            .map_err(DeleteError::Rpc)?;
        let operations: Vec<DeletionOperation> =
            read("sessions.delete", answer).map_err(DeleteError::Rpc)?;
        let mut failed = 0;
        for operation in operations {
            failed += match self
                .files
                .trash_session_deletion(&operation.operation_id)
                .await
            {
                Ok(outcome) => outcome.failed_count,
                Err(_) => operation.path_count + operation.blocked_path_count,
            };
        }
        let _ = self.refresh().await;
        if failed > 0 {
            return Err(DeleteError::FilesKept(copy::files_kept(failed)));
        }
        Ok(())
    }

    /// `remuxSession`: Export MP4 (and Retry export).
    pub async fn remux(&self, session_id: &str) -> Result<(), RpcError> {
        self.request("session.remux_mp4", json!({ "sessionId": session_id }))
            .await?;
        let _ = self.refresh().await;
        Ok(())
    }

    /// `assessRecording`.
    pub async fn assess(&self, session_id: &str) -> Result<Assessment, RpcError> {
        let answer = self
            .request("repair.assess_file", json!({ "sessionId": session_id }))
            .await?;
        read("repair.assess_file", answer)
    }

    /// `repairRecording`.
    pub async fn repair(&self, session_id: &str) -> Result<GateStatus, RpcError> {
        let answer = self
            .request("repair.repair_file", json!({ "sessionId": session_id }))
            .await?;
        let status = read("repair.repair_file", answer)?;
        let _ = self.refresh().await;
        Ok(status)
    }

    /// `restoreRecording`: whether a backup was there.
    pub async fn restore(&self, session_id: &str) -> Result<bool, RpcError> {
        let answer = self
            .request("repair.restore_file", json!({ "sessionId": session_id }))
            .await?;
        let _ = self.refresh().await;
        Ok(answer.as_bool().unwrap_or(false))
    }

    /// `ensureSessionPoster`: the one backfill for an older recording.
    pub async fn ensure_poster(&self, session_id: &str) -> bool {
        self.request("sessions.poster", json!({ "sessionId": session_id }))
            .await
            .ok()
            .and_then(|answer| answer.get("available").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    /// The poster's bytes from the loopback server; `None` when there is
    /// none (yet) or the backend is away.
    pub async fn poster(&self, session_id: &str, version: Option<i64>) -> Option<Vec<u8>> {
        let (port, token) = self.data.borrow().server.clone()?;
        let path = view::poster_path(session_id, &token, version);
        crate::http::get_bytes(port, &path, "image/*", POSTER_MAX_BYTES, POSTER_DEADLINE)
            .await
            .ok()
    }

    /// `session.markers.list`: one page of a recording's markers.
    pub async fn markers(
        &self,
        session_id: &str,
        cursor: Option<&str>,
    ) -> Result<(Vec<SessionMarker>, Option<String>), RpcError> {
        let mut params = json!({ "sessionId": session_id });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        let answer = self.request("session.markers.list", params).await?;
        let markers: Vec<SessionMarker> = read(
            "session.markers.list",
            answer.get("markers").cloned().unwrap_or(json!([])),
        )?;
        let cursor = answer
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok((markers, cursor))
    }

    /// `session.marker.rename`; `None` clears the title.
    pub async fn rename_marker(
        &self,
        session_id: &str,
        marker_id: &str,
        label: Option<&str>,
    ) -> Result<(), RpcError> {
        let mut params = json!({ "sessionId": session_id, "markerId": marker_id });
        if let Some(label) = label {
            params["label"] = json!(label);
        }
        self.request("session.marker.rename", params)
            .await
            .map(|_| ())
    }

    /// `session.marker.delete`.
    pub async fn delete_marker(&self, session_id: &str, marker_id: &str) -> Result<(), RpcError> {
        self.request(
            "session.marker.delete",
            json!({ "sessionId": session_id, "markerId": marker_id }),
        )
        .await
        .map(|_| ())
    }

    /// Follows the backend's events (spawn once, on its own subscription).
    pub async fn drive(self: Arc<Self>, mut events: broadcast::Receiver<BackendEvent>) {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.spawn_refresh();
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            self.on_event(event);
        }
    }

    fn spawn_refresh(self: &Arc<Self>) {
        let library = self.clone();
        tokio::spawn(async move {
            let _ = library.refresh().await;
        });
    }

    /// One event (the renderer's `nextClient.on(...)` handlers).
    pub fn on_event(self: &Arc<Self>, event: BackendEvent) {
        match event {
            BackendEvent::Ready(connection) => {
                self.data.send_modify(|data| {
                    data.online = true;
                    data.server = Some((connection.port, connection.token.clone()));
                });
                self.spawn_refresh();
            }
            BackendEvent::ConnectionClosed { .. } => {
                self.data.send_if_modified(|data| {
                    let was = data.online;
                    data.online = false;
                    data.loading_more = false;
                    was
                });
            }
            BackendEvent::RecordingStatus(status) => {
                let previous = self
                    .lock()
                    .last_state
                    .replace((status.state.clone(), status.session_id.clone()));
                let capturing = |state: &RecordingState| {
                    matches!(state, RecordingState::Recording | RecordingState::Streaming)
                };
                let ended = matches!(status.state, RecordingState::Idle | RecordingState::Failed);
                // Capture started: the live row shows at once (status ticks
                // repeat the state, so only the transition reads).
                let started = capturing(&status.state)
                    && match &previous {
                        None => true,
                        Some((state, session)) => {
                            !capturing(state)
                                || (status.session_id.is_some() && status.session_id != *session)
                        }
                    };
                let settled = ended
                    && previous.as_ref().is_none_or(|(state, _)| {
                        std::mem::discriminant(state) != std::mem::discriminant(&status.state)
                    });
                if started || settled {
                    self.spawn_refresh();
                }
            }
            BackendEvent::RecordingFinalization(event) => {
                self.lock().journal.record(&event);
                let mut needs_refresh = false;
                self.data.send_if_modified(|data| {
                    needs_refresh = view::finalization_event_needs_refresh(&data.sessions, &event);
                    view::apply_finalization_event(&mut data.sessions, &event)
                });
                if needs_refresh {
                    self.spawn_refresh();
                } else if matches!(
                    event.state,
                    RecordingFinalizationState::Finalized | RecordingFinalizationState::Failed
                ) {
                    let library = self.clone();
                    tokio::spawn(async move { library.reread_totals().await });
                }
            }
            BackendEvent::HealthEvent(event) if event.code.starts_with("recording-quality-") => {
                self.spawn_refresh();
            }
            BackendEvent::EventsLagged(_) | BackendEvent::ClientLagged { .. } => {
                self.spawn_refresh();
            }
            BackendEvent::Untyped { event, payload } => match event.as_str() {
                REPLAY_SAVED_EVENT => self.spawn_refresh(),
                MARKER_CREATED_EVENT | MARKER_CHANGED_EVENT => {
                    if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
                        let sequence = self.marker_sequence.fetch_add(1, Ordering::SeqCst) + 1;
                        self.data.send_modify(|data| {
                            data.marker_changes.insert(session_id.to_string(), sequence);
                        });
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
}

fn read_totals(value: &Value) -> Option<(i64, i64)> {
    Some((
        value.get("count")?.as_i64()?,
        value.get("totalBytes")?.as_i64()?,
    ))
}

fn session_id_of(answer: &Value) -> Option<String> {
    answer
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}
