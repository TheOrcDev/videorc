//! The Markers dialog (plan 220 S3.7a, `session-markers-dialog.tsx`): a
//! recording's saved markers, each renamed in place or deleted with an Undo
//! that waits for its toast. The player above the list (Electron's
//! `SessionPlayer`) is S3.7c's: until then the dialog says whether the
//! recording plays, and choosing a marker selects it ([`MarkersState::select`]
//! is the seek S3.7c wires to the backend's player).

use std::collections::BTreeSet;

use videorc_protocol::{RecordingStatus, SessionListItem};

use super::copy;
use super::view::library_title;
use crate::client::RpcError;

/// A saved marker (`SessionMarker`, the backend's `session_markers.rs`): the
/// fields the dialog reads. The wire type stays in the backend (it is not in
/// `videorc-protocol`), so app-core reads it through this mirror.
#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMarker {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub at_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `typed` or `voice`.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub revision: u64,
}

/// `markerTime` (`shared/session-markers.ts`): a marker's place as the one
/// timecode.
pub fn marker_time(seconds: f64) -> String {
    crate::format::format_timecode((seconds * 1000.0) as i64, false)
}

/// The refusals whose message is already Videorc's own words.
const MARKER_REFUSAL_CODES: [&str; 2] = ["marker-not-found", "marker-deleted"];

/// How long the Undo toast for a deleted marker shows (`MARKER_DELETE_UNDO_MS`).
pub const MARKER_DELETE_UNDO_MS: u64 = 5000;

/// `markerDeleteToastId`.
pub fn marker_delete_toast_id(marker_id: &str) -> String {
    format!("marker-delete-{marker_id}")
}

/// `markerFailureDetail`: the backend's own marker refusals, else the
/// unknown-cause line.
pub fn marker_failure_detail(error: &RpcError) -> String {
    if MARKER_REFUSAL_CODES.contains(&error.code.as_str()) {
        error.message.clone()
    } else {
        copy::MARKER_FAILURE_FALLBACK.to_string()
    }
}

/// `markerName`.
pub fn marker_name(marker: &SessionMarker) -> String {
    marker
        .label
        .clone()
        .unwrap_or_else(|| copy::UNTITLED_MARKER.to_string())
}

/// `markerSourceLabel`.
pub fn marker_source_label(source: &str) -> &'static str {
    if source == "voice" {
        copy::MARKER_SOURCE_VOICE
    } else {
        copy::MARKER_SOURCE_TYPED
    }
}

/// What a failure's Retry runs again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkerRetry {
    Load { after: Option<String> },
    Rename { marker_id: String, value: String },
    Delete { marker_id: String },
}

/// A failed step, in words, and the step again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerFailure {
    pub title: &'static str,
    pub detail: String,
    pub retry: MarkerRetry,
}

/// The session the dialog was opened on, for a row that leaves the loaded
/// pages while it is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub title: String,
    pub status: String,
    pub has_file: bool,
    pub duration_ms: Option<i64>,
}

impl SessionSnapshot {
    pub fn of(session: &SessionListItem) -> Self {
        Self {
            title: session.title.clone(),
            status: session.status.clone(),
            has_file: session.mp4_path.is_some() || session.output_path.is_some(),
            duration_ms: session.duration_ms,
        }
    }
}

/// The dialog's state (its `useState`s).
#[derive(Debug, Clone, PartialEq)]
pub struct MarkersState {
    pub session_id: String,
    pub snapshot: SessionSnapshot,
    pub markers: Vec<SessionMarker>,
    pub cursor: Option<String>,
    pub loading: bool,
    pub pending: bool,
    pub failure: Option<MarkerFailure>,
    pub editing: Option<String>,
    pub draft: String,
    pub selected: Option<String>,
    /// Deletes waiting for their Undo toast to close.
    pub hidden: BTreeSet<String>,
    /// `requestGeneration`: a load answered after a newer one began is
    /// dropped.
    pub generation: u64,
}

impl MarkersState {
    pub fn open(session: &SessionListItem) -> Self {
        Self {
            session_id: session.id.clone(),
            snapshot: SessionSnapshot::of(session),
            markers: Vec::new(),
            cursor: None,
            loading: true,
            pending: false,
            failure: None,
            editing: None,
            draft: String::new(),
            selected: None,
            hidden: BTreeSet::new(),
            generation: 0,
        }
    }

    /// A load begins: its generation.
    pub fn begin_load(&mut self) -> u64 {
        self.generation += 1;
        self.loading = true;
        self.generation
    }

    /// A page arrived (the first replaces the list, a later one appends).
    pub fn loaded(
        &mut self,
        generation: u64,
        after: bool,
        markers: Vec<SessionMarker>,
        cursor: Option<String>,
    ) {
        if generation != self.generation {
            return;
        }
        let fresh: Vec<SessionMarker> = markers
            .into_iter()
            .filter(|marker| !self.hidden.contains(&marker.id))
            .collect();
        if after {
            self.markers.extend(fresh);
        } else {
            self.markers = fresh;
        }
        self.cursor = cursor;
        self.failure = None;
        self.loading = false;
    }

    /// A load failed.
    pub fn load_failed(&mut self, generation: u64, after: Option<String>, error: &RpcError) {
        if generation != self.generation {
            return;
        }
        self.failure = Some(MarkerFailure {
            title: copy::COULDNT_LOAD_MARKERS,
            detail: marker_failure_detail(error),
            retry: MarkerRetry::Load { after },
        });
        self.loading = false;
    }

    /// `select`: the marker chosen (S3.7c's player seeks to it).
    pub fn select(&mut self, marker_id: &str) -> Option<f64> {
        let marker = self.markers.iter().find(|m| m.id == marker_id)?;
        self.selected = Some(marker_id.to_string());
        Some(marker.at_seconds * 1000.0)
    }

    pub fn start_rename(&mut self, marker_id: &str) {
        if let Some(marker) = self.markers.iter().find(|m| m.id == marker_id) {
            self.editing = Some(marker_id.to_string());
            self.draft = marker.label.clone().unwrap_or_default();
        }
    }

    /// `remove`: the row goes now; the delete runs when its toast closes.
    /// False when it is already waiting.
    pub fn hide(&mut self, marker_id: &str) -> Option<SessionMarker> {
        if self.hidden.contains(marker_id) {
            return None;
        }
        let marker = self.markers.iter().find(|m| m.id == marker_id)?.clone();
        self.markers.retain(|m| m.id != marker_id);
        if self.editing.as_deref() == Some(marker_id) {
            self.editing = None;
        }
        self.hidden.insert(marker_id.to_string());
        Some(marker)
    }

    /// The view, with the live row of its recording when it is loaded.
    pub fn view(
        &self,
        sessions: &[SessionListItem],
        _recording: &RecordingStatus,
        online: bool,
    ) -> MarkersView {
        let snapshot = sessions
            .iter()
            .find(|session| session.id == self.session_id)
            .map(SessionSnapshot::of)
            .unwrap_or_else(|| self.snapshot.clone());
        let can_play = snapshot.has_file && snapshot.status != "running";
        let rows = self
            .markers
            .iter()
            .map(|marker| MarkerRowView {
                id: marker.id.clone(),
                time: marker_time(marker.at_seconds),
                name: marker_name(marker),
                context: marker_source_label(&marker.source).to_string(),
                selected: self.selected.as_deref() == Some(marker.id.as_str()),
                editing: self.editing.as_deref() == Some(marker.id.as_str()),
                rename_label: copy::rename_marker(marker.label.as_deref()),
                delete_label: copy::delete_marker(marker.label.as_deref()),
            })
            .collect::<Vec<_>>();
        let empty = rows.is_empty();
        MarkersView {
            title: copy::markers_title(&library_title(&snapshot.title)),
            // The player is S3.7c's: a playable recording says nothing here.
            line: if can_play {
                None
            } else if snapshot.status == "running" {
                Some(copy::STILL_RECORDING)
            } else {
                Some(copy::NO_VIDEO_FILE)
            },
            offline: !online,
            failure: self
                .failure
                .as_ref()
                .map(|failure| (failure.title.to_string(), failure.detail.clone())),
            rows,
            draft: self.draft.clone(),
            loading_line: empty && self.loading,
            empty: empty && !self.loading && self.failure.is_none() && online,
            load_more: self.cursor.as_ref().filter(|_| online).map(|_| {
                if self.loading {
                    copy::LOADING
                } else {
                    copy::LOAD_MORE_MARKERS
                }
            }),
            load_more_enabled: !self.loading,
            actions_enabled: !self.pending && online,
            save_enabled: !self.pending,
        }
    }
}

/// One marker row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerRowView {
    pub id: String,
    pub time: String,
    pub name: String,
    pub context: String,
    pub selected: bool,
    pub editing: bool,
    pub rename_label: String,
    pub delete_label: String,
}

/// The dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkersView {
    pub title: String,
    /// Why there is no player: still recording, or no file.
    pub line: Option<&'static str>,
    pub offline: bool,
    pub failure: Option<(String, String)>,
    pub rows: Vec<MarkerRowView>,
    pub draft: String,
    pub loading_line: bool,
    pub empty: bool,
    pub load_more: Option<&'static str>,
    pub load_more_enabled: bool,
    pub actions_enabled: bool,
    pub save_enabled: bool,
}
