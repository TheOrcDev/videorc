//! The Library's pure logic (plan 260 S1.6f, from `videorc-rust`'s plan 220
//! S3.7a, caught up with Electron on 2026-11-24): `lib/library-view.ts`,
//! `lib/session-modes.ts`, `lib/session-finalization.ts` and
//! `lib/separate-source-recordings-view.ts`, ported with their tests. The
//! page as one value (the rows, menus and questions the window draws) lands
//! with the list's controller; `lib/format.ts`'s helpers are
//! [`crate::format`]'s.

use std::collections::{BTreeMap, BTreeSet};

use videorc_protocol::repair::GateStatus;
use videorc_protocol::{
    RecordingFinalizationEvent, RecordingFinalizationState, RecordingState, RecordingStatus,
    SessionListItem, SessionLogEntry,
};

use super::copy;
use crate::format::format_timecode;
pub use crate::format::{NO_VALUE, day_label, duration_ms_label, format_bytes, plural};

/// `isActiveRecordingState` (`shared/capture-state.ts`): a capture starts,
/// runs or stops.
pub fn is_active_recording_state(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    )
}

// ── lib/session-modes.ts ────────────────────────────────────────────────

/// `sessionModeRecorded`: it left a file (recorded, recorded in the cloud,
/// or imported).
pub fn session_mode_recorded(mode: &str) -> bool {
    mode == "record"
        || mode == "cloud-recording"
        || mode == "record+stream"
        || mode == "imported"
        || mode.starts_with("recording")
}

/// `sessionModeStreamed`: it went out live (a cloud show too).
pub fn session_mode_streamed(mode: &str) -> bool {
    mode == "stream"
        || mode == "cloud-stream"
        || mode == "record+stream"
        || mode.starts_with("streaming")
}

// ── lib/library-view.ts ─────────────────────────────────────────────────

/// `LibraryFilter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LibraryFilter {
    #[default]
    All,
    Recordings,
    Streams,
}

impl LibraryFilter {
    pub const ALL: [LibraryFilter; 3] = [Self::All, Self::Recordings, Self::Streams];

    /// `LIBRARY_FILTERS`' label.
    pub fn label(self) -> &'static str {
        match self {
            Self::All => copy::FILTER_ALL,
            Self::Recordings => copy::FILTER_RECORDINGS,
            Self::Streams => copy::FILTER_STREAMS,
        }
    }

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }
}

/// `LibrarySort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LibrarySort {
    #[default]
    Newest,
    Oldest,
}

impl LibrarySort {
    pub const ALL: [LibrarySort; 2] = [Self::Newest, Self::Oldest];

    pub fn label(self) -> &'static str {
        match self {
            Self::Newest => copy::SORT_NEWEST,
            Self::Oldest => copy::SORT_OLDEST,
        }
    }

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }
}

/// `libraryTitle`: the name, or the one placeholder.
pub fn library_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        copy::UNTITLED_RECORDING.to_string()
    } else {
        trimmed.to_string()
    }
}

/// `matchesLibraryFilter`: Go Live records too, so `record+stream` is in
/// both.
pub fn matches_filter(mode: &str, filter: LibraryFilter) -> bool {
    match filter {
        LibraryFilter::All => true,
        LibraryFilter::Recordings => session_mode_recorded(mode),
        LibraryFilter::Streams => session_mode_streamed(mode),
    }
}

/// `filterLibrarySessions`: the filter and the title search.
pub fn filter_sessions<'a>(
    sessions: &'a [SessionListItem],
    filter: LibraryFilter,
    query: &str,
) -> Vec<&'a SessionListItem> {
    let needle = query.trim().to_lowercase();
    sessions
        .iter()
        .filter(|session| {
            matches_filter(&session.mode, filter)
                && (needle.is_empty() || session.title.to_lowercase().contains(&needle))
        })
        .collect()
}

/// `sortLibrarySessions`: by start, oldest first, reversed for newest.
pub fn sort_sessions(
    mut sessions: Vec<&SessionListItem>,
    sort: LibrarySort,
) -> Vec<&SessionListItem> {
    sessions.sort_by(|left, right| left.started_at.cmp(&right.started_at));
    if sort == LibrarySort::Newest {
        sessions.reverse();
    }
    sessions
}

/// `hasBuddyReport`: a session that went out live.
pub fn has_buddy_report(mode: &str) -> bool {
    session_mode_streamed(mode)
}

/// `sessionFormatLabel`: a cloud show and its preset, MP4 (MOV for an
/// imported QuickTime file in the playable slot), the container, or "MKV +
/// stream" for `tee`.
pub fn session_format_label(session: &SessionListItem) -> Option<String> {
    if session.mode == "cloud-stream" || session.mode == "cloud-room" {
        return Some(match session.stream_preset.as_deref() {
            Some(preset) if !preset.is_empty() => format!("Cloud show · {preset}"),
            _ => "Cloud show".to_string(),
        });
    }
    if let Some(mp4) = &session.mp4_path {
        return Some(
            if mp4.to_lowercase().ends_with(".mov") {
                "MOV"
            } else {
                "MP4"
            }
            .to_string(),
        );
    }
    let container = session.container.as_deref()?;
    Some(if container.eq_ignore_ascii_case("tee") {
        "MKV + stream".to_string()
    } else {
        container.to_uppercase()
    })
}

/// `isLiveSession`: the row being captured right now (a stale `running`
/// row is not).
pub fn is_live_session(session: &SessionListItem, recording: &RecordingStatus) -> bool {
    session.status == "running"
        && recording.session_id.as_deref() == Some(session.id.as_str())
        && is_active_recording_state(&recording.state)
}

/// `sessionPosterUrl`'s path and query on the backend's loopback server:
/// the duration busts the cache when a repair or export replaces it.
pub fn poster_path(session_id: &str, token: &str, duration_ms: Option<i64>) -> String {
    let encode = |value: &str| -> String {
        url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
    };
    let mut path = format!(
        "/sessions/{}/poster?token={}",
        percent_path(session_id),
        encode(token)
    );
    if let Some(duration) = duration_ms {
        path.push_str(&format!("&v={duration}"));
    }
    path
}

/// `encodeURIComponent` for a path segment.
fn percent_path(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte);
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `toggleLibrarySelection`.
pub fn toggle_selection(selected: &[String], session_id: &str) -> Vec<String> {
    if selected.iter().any(|id| id == session_id) {
        selected
            .iter()
            .filter(|id| *id != session_id)
            .cloned()
            .collect()
    } else {
        let mut next = selected.to_vec();
        next.push(session_id.to_string());
        next
    }
}

/// `toggleAllLibrarySelection`: all selected clears, else selects them all.
pub fn toggle_all_selection(selected: &[String], visible: &[String]) -> Vec<String> {
    let every = !visible.is_empty() && visible.iter().all(|id| selected.contains(id));
    if every { Vec::new() } else { visible.to_vec() }
}

/// `libraryStorageLabel`: the real total and the disk's real free space.
pub fn storage_label(count: i64, total_bytes: i64, free_bytes: Option<i64>) -> String {
    let free = free_bytes
        .map(|free| format!(" · {} free", format_bytes(Some(free as f64))))
        .unwrap_or_default();
    format!(
        "{} · {}{free}",
        plural(count, "recording", None),
        format_bytes(Some(total_bytes as f64))
    )
}

/// `LibraryListState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListState {
    Rows,
    #[default]
    Loading,
    Offline,
    Empty,
}

/// `libraryListState`: "No recordings yet" only once the first page came.
pub fn list_state(count: usize, loaded: bool, online: bool) -> ListState {
    if count > 0 {
        ListState::Rows
    } else if !online {
        ListState::Offline
    } else if loaded {
        ListState::Empty
    } else {
        ListState::Loading
    }
}

/// `libraryPartialNotice`: what a narrowed view of the loaded pages says.
pub fn partial_notice(
    loaded_count: usize,
    has_more: bool,
    filter: LibraryFilter,
    query: &str,
    sort: LibrarySort,
) -> Option<String> {
    if !has_more {
        return None;
    }
    let scope = format!(
        "the {}",
        plural(
            loaded_count as i64,
            "newest recording",
            Some("newest recordings")
        )
    );
    if !query.trim().is_empty() {
        Some(format!("Searched {scope}."))
    } else if filter != LibraryFilter::All {
        Some(format!("Filtered {scope}."))
    } else if sort == LibrarySort::Oldest {
        Some(format!("Sorted {scope}."))
    } else {
        None
    }
}

/// `libraryClearLabel`: the no-results button.
pub fn clear_label(filter: LibraryFilter, query: &str) -> &'static str {
    let searching = !query.trim().is_empty();
    let filtering = filter != LibraryFilter::All;
    if searching && filtering {
        copy::CLEAR_SEARCH_AND_FILTER
    } else if filtering {
        copy::CLEAR_FILTER
    } else {
        copy::CLEAR_SEARCH
    }
}

/// `revealsFinishedCleanup`: a finished noise cleanup shows its copy only
/// when that cannot undo the streamer's own search or filter (E-19); an
/// explicit "show this recording" still clears them.
pub fn reveals_finished_cleanup(filter: LibraryFilter, query: &str) -> bool {
    filter == LibraryFilter::All && query.trim().is_empty()
}

/// `LibraryPickModifier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickModifier {
    Replace,
    Toggle,
    Range,
}

/// `libraryPickModifier`: ⇧ a range, ⌘ (Ctrl off macOS) a toggle.
pub fn pick_modifier(shift: bool, command: bool) -> PickModifier {
    if shift {
        PickModifier::Range
    } else if command {
        PickModifier::Toggle
    } else {
        PickModifier::Replace
    }
}

/// `LibrarySelection`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Selection {
    pub selected: Vec<String>,
    /// Where a ⇧ range starts.
    pub anchor: Option<String>,
}

/// `pickLibraryRow`: a plain pick selects the row alone, a toggle flips it,
/// a range selects from the anchor over the rows in view; rows that can't
/// be selected are skipped.
pub fn pick_row(
    current: &Selection,
    id: &str,
    modifier: PickModifier,
    ordered: &[String],
    selectable: &BTreeSet<String>,
) -> Selection {
    match modifier {
        PickModifier::Toggle => {
            if !selectable.contains(id) {
                return Selection {
                    selected: current.selected.clone(),
                    anchor: Some(id.to_string()),
                };
            }
            return Selection {
                selected: toggle_selection(&current.selected, id),
                anchor: Some(id.to_string()),
            };
        }
        PickModifier::Range => {
            let anchor = current.anchor.clone().unwrap_or_else(|| id.to_string());
            let from = ordered.iter().position(|row| *row == anchor);
            let to = ordered.iter().position(|row| row == id);
            if let (Some(from), Some(to)) = (from, to) {
                let (start, end) = if from <= to { (from, to) } else { (to, from) };
                return Selection {
                    selected: ordered[start..=end]
                        .iter()
                        .filter(|row| selectable.contains(*row))
                        .cloned()
                        .collect(),
                    anchor: Some(anchor),
                };
            }
        }
        PickModifier::Replace => {}
    }
    Selection {
        selected: if selectable.contains(id) {
            vec![id.to_string()]
        } else {
            Vec::new()
        },
        anchor: Some(id.to_string()),
    }
}

/// `LibraryRowMove`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowMove {
    Next,
    Previous,
    First,
    Last,
}

/// `libraryRowAfterMove`.
pub fn row_after_move(ordered: &[String], active: Option<&str>, step: RowMove) -> Option<String> {
    let last = ordered.len().checked_sub(1)?;
    match step {
        RowMove::First => return ordered.first().cloned(),
        RowMove::Last => return ordered.last().cloned(),
        _ => {}
    }
    let Some(index) = active.and_then(|active| ordered.iter().position(|row| row == active)) else {
        return ordered.first().cloned();
    };
    let next = match step {
        RowMove::Next => (index + 1).min(last),
        _ => index.saturating_sub(1),
    };
    ordered.get(next).cloned()
}

/// `LibraryKeyCommand`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCommand {
    Move { step: RowMove, extend: bool },
    Toggle,
    SelectAll,
    Clear,
    Rename,
    Delete,
}

/// `libraryKeyCommand`: ↑/↓, Home and End move (⇧ extends), Space toggles,
/// ⌘A selects every row in view, Escape clears, Return renames and ⌘⌫ (or
/// Delete) asks to delete. `key` is the DOM's name (`ArrowDown`, ` `,
/// `Enter`, `Backspace`, `Delete`, a letter).
pub fn key_command(key: &str, shift: bool, command: bool, alt: bool) -> Option<KeyCommand> {
    if alt {
        return None;
    }
    match key {
        "ArrowDown" | "ArrowUp" | "Home" | "End" => {
            if command {
                return None;
            }
            let step = match key {
                "ArrowDown" => RowMove::Next,
                "ArrowUp" => RowMove::Previous,
                "Home" => RowMove::First,
                _ => RowMove::Last,
            };
            Some(KeyCommand::Move {
                step,
                extend: shift,
            })
        }
        " " => (!command && !shift).then_some(KeyCommand::Toggle),
        "Escape" => Some(KeyCommand::Clear),
        "Enter" => (!command && !shift).then_some(KeyCommand::Rename),
        "Backspace" => (command && !shift).then_some(KeyCommand::Delete),
        "Delete" => (!shift).then_some(KeyCommand::Delete),
        other => {
            (command && !shift && other.eq_ignore_ascii_case("a")).then_some(KeyCommand::SelectAll)
        }
    }
}

/// `pruneLibrarySelection`: a hidden row is never acted on.
pub fn prune_selection(selected: &[String], in_view: &BTreeSet<String>) -> Vec<String> {
    selected
        .iter()
        .filter(|id| in_view.contains(*id))
        .cloned()
        .collect()
}

/// `librarySelectAllState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SelectAllState {
    #[default]
    None,
    Some,
    All,
}

pub fn select_all_state(selected: &[String], selectable: &[String]) -> SelectAllState {
    let count = selectable.iter().filter(|id| selected.contains(id)).count();
    if count == 0 {
        SelectAllState::None
    } else if count == selectable.len() {
        SelectAllState::All
    } else {
        SelectAllState::Some
    }
}

/// `LIBRARY_DELETE_NAMED_MAX`.
pub const DELETE_NAMED_MAX: usize = 5;

/// `libraryDeleteNames`: up to five titles, and how many more.
pub fn delete_names(titles: &[String]) -> (Vec<String>, usize) {
    let names: Vec<String> = titles
        .iter()
        .take(DELETE_NAMED_MAX)
        .map(|title| library_title(title))
        .collect();
    let more = titles.len().saturating_sub(names.len());
    (names, more)
}

/// A chip's words and its detail on hover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chip {
    pub label: String,
    pub detail: String,
}

fn chip(label: &str, detail: impl Into<String>) -> Chip {
    Chip {
        label: label.to_string(),
        detail: detail.into(),
    }
}

/// `libraryQualityChip`: problem states only.
pub fn quality_chip(status: Option<&GateStatus>) -> Option<Chip> {
    match status? {
        GateStatus::NotHundredPercent { sampled, .. } => Some(chip(
            copy::QUALITY_ISSUES,
            if *sampled {
                copy::QUALITY_SAMPLED_DETAIL
            } else {
                copy::QUALITY_DETAIL
            },
        )),
        GateStatus::Failed { .. } => Some(chip(copy::NOT_CHECKED, copy::NOT_CHECKED_DETAIL)),
        _ => None,
    }
}

/// `canExportMp4`: a finished MKV without an MP4 and not being exported.
pub fn can_export_mp4(session: &SessionListItem) -> bool {
    session.status == "completed"
        && session
            .output_path
            .as_deref()
            .is_some_and(|path| path.to_lowercase().ends_with(".mkv"))
        && session.mp4_path.is_none()
        && !is_finalizing(session)
        && separate_file_stopped(session).is_none_or(|stopped| stopped.exportable)
}

// ── lib/session-finalization.ts ─────────────────────────────────────────

pub fn is_finalizing(session: &SessionListItem) -> bool {
    session.finalization_state == Some(RecordingFinalizationState::Finalizing)
}

pub fn finalization_failed(session: &SessionListItem) -> bool {
    session.finalization_state == Some(RecordingFinalizationState::Failed)
}

/// `interruptedTakeBadge`: a take recovered after Videorc stopped mid-way.
pub fn interrupted_take_badge(session: &SessionListItem) -> Option<Chip> {
    (session.interruption_recovery.as_deref() == Some("recovered"))
        .then(|| chip(copy::RECOVERED, copy::RECOVERED_DETAIL))
}

/// `SESSION_START_FAILED_LOG_CODE`.
pub const SESSION_START_FAILED_LOG_CODE: &str = "session-start-failed";

/// `mayBeStartFailed`: a failed row with no file and some logs.
pub fn may_be_start_failed(session: &SessionListItem) -> bool {
    session.status == "failed"
        && session.mp4_path.is_none()
        && session.file_size_bytes.is_none()
        && session.session_log_count > 0
}

/// `startFailedBadge`: the row whose Record the backend refused; `None`
/// while its logs are unknown.
pub fn start_failed_badge(
    session: &SessionListItem,
    logs: Option<&[SessionLogEntry]>,
) -> Option<Chip> {
    if !may_be_start_failed(session) {
        return None;
    }
    let logs: Vec<&SessionLogEntry> = logs?
        .iter()
        .filter(|entry| entry.code == SESSION_START_FAILED_LOG_CODE)
        .collect();
    if logs.is_empty() {
        return None;
    }
    let reason = logs
        .iter()
        .find_map(|entry| start_failed_reason(&entry.message));
    Some(chip(
        copy::DIDNT_START,
        match reason {
            Some(reason) => format!("{} {reason}", copy::DIDNT_START_DETAIL),
            None => copy::DIDNT_START_DETAIL.to_string(),
        },
    ))
}

fn start_failed_reason(message: &str) -> Option<String> {
    for prefix in ["the session was marked failed:", "reason="] {
        if let Some(at) = message.find(prefix) {
            let reason = message[at + prefix.len()..].trim();
            return (!reason.is_empty()).then(|| reason.to_string());
        }
    }
    None
}

/// `finalizingBadgeLabel`.
pub fn finalizing_badge_label(percent: Option<u8>) -> String {
    match percent {
        Some(percent) if percent > 0 && percent < 100 => format!("Saving MP4 · {percent}%"),
        _ => copy::SAVING_MP4.to_string(),
    }
}

/// `FinalizationNotice`: an MP4 toast the Library rows call for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalizationNotice {
    Finalizing {
        session_id: String,
        label: String,
    },
    Ready {
        session_id: String,
    },
    Failed {
        session_id: String,
        error: Option<String>,
    },
}

/// `finalizationNoticesForRows`: "Saving MP4" restored after a relaunch,
/// and the outcome of a notice whose terminal event was missed while
/// disconnected. `active` (notices the rows opened) and `announced` (takes
/// whose "MP4 ready" was shown) are updated in place. A row that still reads
/// finalizing after its take was announced is stale and reopens nothing.
pub fn finalization_notices_for_rows(
    sessions: &[SessionListItem],
    active: &mut BTreeSet<String>,
    announced: &mut BTreeSet<String>,
) -> Vec<FinalizationNotice> {
    let mut notices = Vec::new();
    for session in sessions {
        if is_finalizing(session) {
            if announced.contains(&session.id) {
                continue;
            }
            active.insert(session.id.clone());
            notices.push(FinalizationNotice::Finalizing {
                session_id: session.id.clone(),
                label: finalizing_badge_label(session.finalization_progress_percent),
            });
        } else if active.remove(&session.id) {
            if session.finalization_state == Some(RecordingFinalizationState::Finalized)
                && !announced.contains(&session.id)
            {
                announced.insert(session.id.clone());
                notices.push(FinalizationNotice::Ready {
                    session_id: session.id.clone(),
                });
            } else if finalization_failed(session) {
                notices.push(FinalizationNotice::Failed {
                    session_id: session.id.clone(),
                    error: session.finalization_error.clone(),
                });
            }
        }
    }
    notices
}

/// `applyFinalizationEvent`: the event patched onto its row; false when no
/// row is its.
pub fn apply_finalization_event(
    sessions: &mut [SessionListItem],
    event: &RecordingFinalizationEvent,
) -> bool {
    let Some(session) = sessions.iter_mut().find(|row| row.id == event.session_id) else {
        return false;
    };
    session.finalization_state = Some(event.state.clone());
    if event.progress_percent.is_some() {
        session.finalization_progress_percent = event.progress_percent;
    } else if event.state != RecordingFinalizationState::Finalizing {
        session.finalization_progress_percent = None;
    }
    if let Some(path) = &event.mp4_path {
        session.mp4_path = Some(path.clone());
    }
    if let Some(path) = &event.output_path {
        session.output_path = Some(path.clone());
    }
    if let Some(recovery) = &event.interruption_recovery {
        session.interruption_recovery = Some(recovery.clone());
    }
    session.finalization_error = event.error.clone();
    if let Some(duration) = event.duration_ms {
        session.duration_ms = Some(duration);
    }
    if let Some(size) = event.file_size_bytes {
        session.file_size_bytes = Some(size);
    }
    true
}

/// `finalizationEventNeedsRefresh`: a finished take whose row isn't loaded.
pub fn finalization_event_needs_refresh(
    sessions: &[SessionListItem],
    event: &RecordingFinalizationEvent,
) -> bool {
    event.state == RecordingFinalizationState::Finalized
        && !sessions.iter().any(|row| row.id == event.session_id)
}

/// `FinalizationSnapshotJournal`: events received after a list request
/// began are replayed onto its answer, so a late page never turns a
/// finished MP4 back into an MKV.
#[derive(Debug, Default, Clone)]
pub struct FinalizationJournal {
    sequence: u64,
    events: BTreeMap<String, (u64, RecordingFinalizationEvent)>,
}

impl FinalizationJournal {
    pub fn checkpoint(&self) -> u64 {
        self.sequence
    }

    pub fn record(&mut self, event: &RecordingFinalizationEvent) {
        self.sequence += 1;
        self.events
            .insert(event.session_id.clone(), (self.sequence, event.clone()));
    }

    pub fn reconcile(&self, rows: &mut [SessionListItem], since: u64) {
        let mut later: Vec<&(u64, RecordingFinalizationEvent)> = self
            .events
            .values()
            .filter(|(sequence, _)| *sequence > since)
            .collect();
        later.sort_by_key(|(sequence, _)| *sequence);
        for (_, event) in later {
            apply_finalization_event(rows, event);
        }
    }
}

// ── lib/separate-source-recordings-view.ts ──────────────────────────────

/// `recordingRoleLabel`.
pub fn recording_role_label(role: &str) -> Option<&'static str> {
    match role {
        "combined" => Some(copy::ROLE_COMBINED),
        "screen" => Some(copy::ROLE_SCREEN),
        "camera" => Some(copy::ROLE_CAMERA),
        _ => None,
    }
}

/// `recordingRoleRowNote`: the audio track the file carries.
pub fn recording_role_row_note(role: &str) -> Option<&'static str> {
    match role {
        "combined" => Some(copy::ROLE_NOTE_COMBINED),
        "screen" => Some(copy::ROLE_NOTE_SCREEN),
        "camera" => Some(copy::ROLE_NOTE_CAMERA),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileFailure {
    Capture,
    Encoder,
    Writer,
    Audio,
    Short,
    Missing,
    Placement,
    Ownership,
    Interrupted,
}

fn file_failure(error: Option<&str>) -> Option<FileFailure> {
    let error = error?.to_lowercase();
    let has = |needle: &str| error.contains(needle);
    let muxer_reap = error
        .find("could not reap ")
        .is_some_and(|at| error[at..].contains("muxer"));
    if has("capture failed after source recovery") {
        Some(FileFailure::Capture)
    } else if has("encoder failed")
        || has("encoder writer could not be reaped")
        || has("encoder teardown failed")
    {
        Some(FileFailure::Encoder)
    } else if has("muxer exited")
        || has("muxer failed")
        || has("muxer exceeded")
        || muxer_reap
        || has("recording supervisor failed")
    {
        Some(FileFailure::Writer)
    } else if has("audio failed") || has("audio bus ended") || has("audio teardown failed") {
        Some(FileFailure::Audio)
    } else if has("artifact ended at") || has("artifact duration could not be verified") {
        Some(FileFailure::Short)
    } else if has("file was missing after stop") {
        Some(FileFailure::Missing)
    } else if has("could not bind") || has("could not publish") || has("could not persist") {
        Some(FileFailure::Placement)
    } else if has("separate recording ownership could not be verified") {
        Some(FileFailure::Ownership)
    } else if has("partial media is available for recovery") {
        Some(FileFailure::Interrupted)
    } else {
        None
    }
}

fn file_failure_sentence(kind: FileFailure, camera: bool) -> &'static str {
    match kind {
        FileFailure::Capture if camera => copy::FAILURE_CAMERA_CAPTURE,
        FileFailure::Capture => copy::FAILURE_SCREEN_CAPTURE,
        FileFailure::Encoder => copy::FAILURE_ENCODER,
        FileFailure::Writer => copy::FAILURE_WRITER,
        FileFailure::Audio => copy::FAILURE_AUDIO,
        FileFailure::Short => copy::FAILURE_SHORT,
        FileFailure::Missing => copy::FAILURE_MISSING,
        FileFailure::Placement => copy::FAILURE_PLACEMENT,
        FileFailure::Ownership => copy::FAILURE_OWNERSHIP,
        FileFailure::Interrupted => copy::FAILURE_INTERRUPTED,
    }
}

/// `SeparateFileStopped`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStopped {
    pub label: String,
    pub detail: String,
    pub exportable: bool,
}

/// `USABLE_PARTIAL_MS`.
const USABLE_PARTIAL_MS: i64 = 1000;

/// `separateFileStopped`: a Screen or Camera file that stopped mid-take.
pub fn separate_file_stopped(session: &SessionListItem) -> Option<FileStopped> {
    let role = session.recording_role.as_deref()?;
    if role != "screen" && role != "camera" {
        return None;
    }
    if !finalization_failed(session) || session.mp4_path.is_some() {
        return None;
    }
    let kind = file_failure(session.finalization_error.as_deref())?;
    let sentence = file_failure_sentence(kind, role == "camera");
    if matches!(kind, FileFailure::Missing | FileFailure::Ownership) {
        return Some(FileStopped {
            label: copy::NOT_SAVED.to_string(),
            detail: sentence.to_string(),
            exportable: false,
        });
    }
    if kind == FileFailure::Interrupted && session.duration_ms.is_none() {
        return Some(FileStopped {
            label: copy::STOPPED_EARLY.to_string(),
            detail: format!("{sentence} What it recorded before then is kept."),
            exportable: true,
        });
    }
    let kept = session.duration_ms.unwrap_or(0);
    let exportable = kept >= USABLE_PARTIAL_MS;
    Some(FileStopped {
        label: copy::STOPPED_EARLY.to_string(),
        detail: if exportable {
            format!(
                "{sentence} The first {} is kept.",
                format_timecode(kept, false)
            )
        } else {
            format!("{sentence} Nothing usable was recorded before it stopped.")
        },
        exportable,
    })
}

/// `takeSiblings`: the other rows of the same take, in Combined → Screen →
/// Camera order (a row with no role last).
pub fn take_siblings<'a>(
    session: &SessionListItem,
    sessions: &'a [SessionListItem],
) -> Vec<&'a SessionListItem> {
    let Some(take) = session.take_id.as_deref().filter(|take| !take.is_empty()) else {
        return Vec::new();
    };
    let rank = |row: &SessionListItem| match row.recording_role.as_deref() {
        Some("combined") => 0,
        Some("screen") => 1,
        Some("camera") => 2,
        _ => 3,
    };
    let mut siblings: Vec<_> = sessions
        .iter()
        .filter(|row| row.take_id.as_deref() == Some(take) && row.id != session.id)
        .collect();
    siblings.sort_by_key(|row| rank(row));
    siblings
}

/// `separateFileRoleFromMessage`: the role a
/// `separate-source-recordings-role-failed` message names first.
pub fn separate_file_role_from_message(message: &str) -> Option<&'static str> {
    let text = message.trim();
    ["screen", "camera"].into_iter().find(|role| {
        text.get(..role.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(role))
            && !text[role.len()..]
                .chars()
                .next()
                .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_')
    })
}

/// `separateFileFailedToast`: the Studio's toast when a Screen or Camera
/// file stops (plan 198, D1), a warning with the reason in plain words.
/// While the take runs it says the Combined recording carries on.
/// (title, description).
pub fn separate_file_failed_toast(message: &str, take_running: bool) -> (String, String) {
    let role = separate_file_role_from_message(message);
    let name = match role {
        Some("camera") => copy::CAMERA_FILE,
        Some("screen") => copy::SCREEN_FILE,
        _ => copy::SEPARATE_FILE,
    };
    let kind = file_failure(Some(message));
    let sentence = kind.map_or(copy::FILE_NOT_FINISHED, |kind| {
        file_failure_sentence(kind, role == Some("camera"))
    });
    if take_running {
        return (
            format!("{name} stopped"),
            format!("{sentence} {}", copy::COMBINED_KEEPS_GOING),
        );
    }
    let title = match kind {
        Some(FileFailure::Missing | FileFailure::Ownership) => format!("{name} wasn't saved"),
        _ => format!("{name} stopped early"),
    };
    (title, sentence.to_string())
}
