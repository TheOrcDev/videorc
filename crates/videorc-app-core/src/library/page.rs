//! The Library page as one value (plan 260 S1.6f, from `videorc-rust`'s
//! plan 220 S3.7a): `library-tab.tsx`, `library-table.tsx` and
//! `useSessionMenu`'s rows, menus and questions, from the list's data, the
//! page's own state and two things other slices own:
//!
//! - **The Studio's session** ([`LibrarySession`]): the capture's status and
//!   the transport's pill, which S1.6a's `SessionView` and
//!   `studio::transport::session_status` compute (L7).
//! - **Clean cut's rules** ([`CleanCutRules`]): which jobs run, which
//!   recordings it can cut and a job's status words, which S1.6e's
//!   `buddy::clean_cut` holds (L7).
//!
//! Each is a small trait, so the page lands before those slices and they
//! plug in without changing it.

use std::collections::{BTreeMap, BTreeSet};

use chrono::DateTime;
use videorc_protocol::repair::GateStatus;
use videorc_protocol::{
    CleanCutJob, CleanCutJobState, CleanCutMode, NoiseCleanupJob, RecordingState, RecordingStatus,
    SessionListItem, SessionLogEntry,
};

use super::copy;
use super::markers::{MarkersState, MarkersView};
use super::noise::{
    NoiseCleanupInput, NoiseCleanupView, active_source_ids, latest_job_for_session,
    noise_cleanup_view, with_connection_state,
};
use super::view::*;

/// `StatusTone`: the dot's and the badge's colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Good,
    Warn,
    Error,
    Live,
}

/// The Studio's session, as the Library reads it (S1.6a's `SessionView`).
pub trait LibrarySession {
    /// `session.status`: the backend's `recording.status`.
    fn status(&self) -> &RecordingStatus;
    /// `sessionStatus(session, connection)`: the transport pill's words and
    /// tone, which the live row repeats ("Recording", "On air").
    fn status_pill(&self) -> (&'static str, StatusTone);
}

/// `CleanCutCaptureContext`: what the capture is doing while a cut waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CleanCutCapture {
    pub active: bool,
    pub streaming: bool,
}

/// Clean cut's rules (S1.6e's `buddy::clean_cut`).
pub trait CleanCutRules {
    /// `isCleanCutJobActive`: queued or working.
    fn is_active(&self, job: &CleanCutJob) -> bool;
    /// `cleanCutEligibility(session).ok`: Clean cut can cut this recording.
    fn is_eligible(&self, session: &SessionListItem) -> bool;
    /// `cleanCutStatusView(job, capture).label`.
    fn status_label(&self, job: &CleanCutJob, capture: CleanCutCapture) -> String;
}

/// `revealInFileManagerLabel`: the file manager by its name.
pub fn reveal_in_file_manager_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Show in Finder"
    } else if cfg!(target_os = "windows") {
        "Show in Explorer"
    } else {
        "Show in folder"
    }
}

// ── The page's state, as the window holds it ────────────────────────────

/// The quality check's steps on one row (`RepairPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RepairPhase {
    #[default]
    Idle,
    Checking,
    Assessed,
    Repairing,
    Done,
}

/// One row's check, repair and restore state (`useSessionMenu`'s).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RowRepair {
    pub phase: RepairPhase,
    pub repairable: bool,
    pub has_backup: bool,
}

/// The rename dialog, while it is open.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RenameState {
    pub session_id: String,
    pub draft: String,
    pub error: Option<String>,
}

/// The delete question, while it waits: the recordings and their titles.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeleteState {
    pub ids: Vec<String>,
    pub titles: Vec<String>,
    pub pending: bool,
}

/// What the page remembers between frames (the component's `useState`s).
#[derive(Debug, Clone, Default)]
pub struct LibraryUi {
    pub filter: LibraryFilter,
    pub sort: LibrarySort,
    pub query: String,
    pub selection: Selection,
    pub active: Option<String>,
    /// Shown on request ("Open in Library"), for a moment.
    pub revealed: Option<String>,
    pub importing: bool,
    pub loading_all: bool,
    pub duplicating: BTreeSet<String>,
    pub repairs: BTreeMap<String, RowRepair>,
    pub rename: Option<RenameState>,
    pub delete: Option<DeleteState>,
    pub markers: Option<MarkersState>,
}

impl LibraryUi {
    /// `focusLibrarySession`: an explicit "show this recording" clears the
    /// search and the filter so the row is there.
    pub fn focus_session(&mut self, session_id: &str) {
        self.filter = LibraryFilter::All;
        self.query.clear();
        self.active = Some(session_id.to_string());
        self.revealed = Some(session_id.to_string());
    }

    /// `changeView`: a new filter or search drops the selected rows it
    /// hides.
    pub fn change_view(
        &mut self,
        sessions: &[SessionListItem],
        filter: Option<LibraryFilter>,
        query: Option<String>,
    ) {
        if let Some(filter) = filter {
            self.filter = filter;
        }
        if let Some(query) = query {
            self.query = query;
        }
        let in_view: BTreeSet<String> = filter_sessions(sessions, self.filter, &self.query)
            .into_iter()
            .map(|session| session.id.clone())
            .collect();
        self.selection.selected = prune_selection(&self.selection.selected, &in_view);
    }
}

/// What the Library's backend data holds (`LibraryData`'s view half).
#[derive(Debug, Clone, Copy)]
pub struct DataFacts<'a> {
    pub sessions: &'a [SessionListItem],
    pub has_more: bool,
    pub loading_more: bool,
    pub loaded: bool,
    pub online: bool,
    pub totals: Option<(i64, i64)>,
    pub logs: &'a BTreeMap<String, Vec<SessionLogEntry>>,
}

/// Everything the page reads.
pub struct ViewInput<'a> {
    pub data: DataFacts<'a>,
    pub session: &'a dyn LibrarySession,
    pub clean_cut: &'a dyn CleanCutRules,
    pub ui: &'a LibraryUi,
    /// The free space beside the chosen folder (`checkDirectory`), when one
    /// is chosen.
    pub free_bytes: Option<i64>,
    /// Now, for the live row's clock.
    pub now: DateTime<chrono::Utc>,
    /// S3.10c: every Clean cut job the Studio has heard.
    pub clean_cuts: &'a [CleanCutJob],
    /// Every noise cleanup job the Studio has heard.
    pub noise_jobs: &'a [NoiseCleanupJob],
    /// Noise cleanup's Premium gate: its reason while locked, `None` when
    /// allowed (the account's entitlements answer it, L6).
    pub noise_premium_locked: Option<&'a str>,
}

// ── The page as one value ───────────────────────────────────────────────

/// The live row's dot, or a finished row's poster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PosterView {
    /// The capture running now: its status dot.
    Live { tone: StatusTone, pulse: bool },
    /// The backend's poster, by this version (the duration).
    Picture { version: Option<i64> },
    /// The file glyph: running, finalizing, or offline.
    Glyph,
}

/// The Scene column's one badge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneBadge {
    pub text: String,
}

/// The File column.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum FileCell {
    #[default]
    None,
    /// The capture's status dot and its words.
    Live {
        label: String,
        tone: StatusTone,
        pulse: bool,
    },
    /// The export runs: a spinner badge.
    Finalizing(String),
    /// A destructive badge with its reason on hover and focus.
    Problem { label: String, detail: String },
    /// An outline badge with its detail (Recovered).
    Note { label: String, detail: String },
    /// The container, a tag.
    Format(String),
}

/// One menu item's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MenuId {
    Play,
    /// Buddy → Reports, on this stream's report (S3.10b).
    BuddyReport,
    /// S3.10c: Buddy → Clean cut on this recording, and its finished cut.
    CleanCut,
    ReviewCleanCut,
    Markers,
    Reveal,
    ExportMp4,
    StreamManager,
    Rename,
    Duplicate,
    Check,
    Repair,
    Restore,
    /// Reduce noise, its progress or its cleaned copy.
    NoiseCleanup,
    Delete,
}

impl MenuId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Play => "play",
            Self::BuddyReport => "buddy-report",
            Self::CleanCut => "clean-cut",
            Self::ReviewCleanCut => "review-clean-cut",
            Self::Markers => "markers",
            Self::Reveal => "reveal",
            Self::ExportMp4 => "export-mp4",
            Self::StreamManager => "stream-manager",
            Self::Rename => "rename",
            Self::Duplicate => "duplicate",
            Self::Check => "check",
            Self::Repair => "repair",
            Self::Restore => "restore",
            Self::NoiseCleanup => "noise-cleanup",
            Self::Delete => "delete",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        [
            Self::Play,
            Self::BuddyReport,
            Self::CleanCut,
            Self::ReviewCleanCut,
            Self::Markers,
            Self::Reveal,
            Self::ExportMp4,
            Self::StreamManager,
            Self::Rename,
            Self::Duplicate,
            Self::Check,
            Self::Repair,
            Self::Restore,
            Self::NoiseCleanup,
            Self::Delete,
        ]
        .into_iter()
        .find(|item| item.as_str() == id)
    }
}

/// One entry of the row's ⋯ and right-click menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
    pub id: MenuId,
    pub label: String,
    /// The icon set's name (`IconName` in the window).
    pub icon: &'static str,
    pub disabled: bool,
    /// Why it is off, read after the label.
    pub reason: Option<String>,
    pub destructive: bool,
    /// A hairline above: a new group starts.
    pub separated: bool,
    /// Its keys (an accelerator).
    pub accelerator: &'static str,
}

/// One row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowView {
    pub id: String,
    pub title: String,
    pub meta: String,
    pub quality: Option<Chip>,
    pub scene: Option<SceneBadge>,
    pub duration: String,
    pub size: String,
    pub file: FileCell,
    pub poster: PosterView,
    pub selected: bool,
    pub selectable: bool,
    /// The row that holds the list's one Tab stop.
    pub active: bool,
    pub revealed: bool,
    /// Why Play is off; `None` when it plays.
    pub play_reason: Option<&'static str>,
    pub menu: Vec<MenuItem>,
    pub menu_busy: bool,
    pub menu_disabled: bool,
    pub can_rename: bool,
    pub can_delete: bool,
    /// S3.10c: the chip while Clean cut works on the recording.
    pub clean_cut: Option<CleanCutChip>,
    /// The row's noise cleanup button (`NoiseCleanupDirectAction`), when it
    /// has words to show.
    pub noise: Option<NoiseCleanupView>,
}

/// `libraryCleanCutChip`, with its hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanCutChip {
    pub label: String,
    pub working: bool,
    pub hint: String,
}

/// The newest job working on each source recording
/// (`activeCleanCutJobsBySource`): the backend refuses the file actions on
/// these, so the Library holds them first.
pub fn active_clean_cuts<'a>(
    jobs: &'a [CleanCutJob],
    rules: &dyn CleanCutRules,
) -> BTreeMap<String, &'a CleanCutJob> {
    let mut by_source: BTreeMap<String, &CleanCutJob> = BTreeMap::new();
    for job in jobs.iter().filter(|job| rules.is_active(job)) {
        let newer = by_source
            .get(&job.source_session_id)
            .is_none_or(|held| job.created_at > held.created_at);
        if newer {
            by_source.insert(job.source_session_id.clone(), job);
        }
    }
    by_source
}

/// `libraryCleanCutReviews`: the mode of a recording's finished cut (its
/// newest finished job's, else its newest cut copy's).
pub fn clean_cut_reviews(
    jobs: &[CleanCutJob],
    sessions: &[SessionListItem],
) -> BTreeMap<String, CleanCutMode> {
    use videorc_protocol::{CleanCutJobState, CleanCutMode};
    let mut reviews: BTreeMap<String, (String, CleanCutMode)> = BTreeMap::new();
    for session in sessions {
        let Some(source) = &session.clean_cut_of_session_id else {
            continue;
        };
        let mode = if session.clean_cut_mode.as_deref() == Some("condensed") {
            CleanCutMode::Condensed
        } else {
            CleanCutMode::Clean
        };
        let newer = reviews
            .get(source)
            .is_none_or(|(at, _)| session.started_at > *at);
        if newer {
            reviews.insert(source.clone(), (session.started_at.clone(), mode));
        }
    }
    let mut out: BTreeMap<String, CleanCutMode> = reviews
        .into_iter()
        .map(|(k, (_, mode))| (k, mode))
        .collect();
    let mut finished: BTreeMap<String, &CleanCutJob> = BTreeMap::new();
    for job in jobs
        .iter()
        .filter(|job| job.state == CleanCutJobState::Completed)
    {
        let newer = finished
            .get(&job.source_session_id)
            .is_none_or(|held| job.updated_at > held.updated_at);
        if newer {
            finished.insert(job.source_session_id.clone(), job);
        }
    }
    for (source, job) in finished {
        out.insert(source, job.mode);
    }
    out
}

/// `libraryCleanCutChip`.
pub fn clean_cut_chip(
    job: &CleanCutJob,
    capture: CleanCutCapture,
    rules: &dyn CleanCutRules,
) -> CleanCutChip {
    let status_label = rules.status_label(job, capture);
    let (label, working) = if job.state == CleanCutJobState::Queued && job.progress <= 0.0 {
        (copy::CUT_QUEUED.to_string(), false)
    } else {
        let percent = (job.progress * 100.0).round().clamp(0.0, 99.0) as u32;
        (copy::cutting(percent), true)
    };
    CleanCutChip {
        label,
        working,
        hint: copy::clean_cut_hint(&status_label),
    }
}

/// The rename dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameView {
    pub draft: String,
    pub error: Option<String>,
    pub can_submit: bool,
}

/// The delete question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteView {
    pub title: String,
    pub description: String,
    pub names: Vec<String>,
    pub more: Option<String>,
    pub confirm_label: String,
    pub confirm_disabled: bool,
    pub cancel_disabled: bool,
}

/// The page.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LibraryView {
    pub filter_index: usize,
    pub sort_index: usize,
    pub query: String,
    pub importing: bool,
    pub selected_count: usize,
    pub bulk_hold: Option<&'static str>,
    pub offline_alert: bool,
    pub partial_notice: Option<String>,
    pub load_all_label: &'static str,
    pub load_all_enabled: bool,
    pub list_state: ListState,
    /// No row matches the filter or the search: the button that clears them.
    pub no_match: Option<&'static str>,
    pub select_all: SelectAllState,
    pub select_all_enabled: bool,
    pub rows: Vec<RowView>,
    pub footer: Option<String>,
    /// Load more's words while there is a next page.
    pub load_more: Option<&'static str>,
    pub load_more_enabled: bool,
    pub rename: Option<RenameView>,
    pub delete: Option<DeleteView>,
    pub markers: Option<MarkersView>,
}

/// The ids in view, in order, and the ones a bulk action may take.
pub struct VisibleRows {
    pub ordered: Vec<String>,
    pub selectable: Vec<String>,
}

/// Whether file actions wait for the capture (`sessionOwnsTransport`).
pub fn capture_protected(session: &dyn LibrarySession) -> bool {
    let status = session.status();
    is_active_recording_state(&status.state) && !status.replay_only
}

/// The rows in view and which of them can be picked: not the capture's,
/// and not one Clean cut or noise cleanup works on (`locked`).
pub fn visible_rows(
    sessions: &[SessionListItem],
    ui: &LibraryUi,
    session: &dyn LibrarySession,
    locked: &BTreeSet<String>,
) -> VisibleRows {
    let visible = sort_sessions(filter_sessions(sessions, ui.filter, &ui.query), ui.sort);
    let protected = capture_protected(session);
    VisibleRows {
        ordered: visible.iter().map(|row| row.id.clone()).collect(),
        selectable: visible
            .iter()
            .filter(|row| {
                !protected && !is_live_session(row, session.status()) && !locked.contains(&row.id)
            })
            .map(|row| row.id.clone())
            .collect(),
    }
}

fn elapsed_ms(status: &RecordingStatus, now: DateTime<chrono::Utc>) -> Option<i64> {
    status
        .started_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map(|at| {
            (now - at.with_timezone(&chrono::Utc))
                .num_milliseconds()
                .max(0)
        })
        .or(status.duration_ms)
}

/// What a row's work in flight holds: a duplicate, a Clean cut, the mode
/// of its finished cut (Review clean cut), and its noise cleanup.
#[derive(Debug, Clone, Default)]
struct RowWork {
    duplicating: bool,
    cutting: bool,
    review: Option<CleanCutMode>,
    /// Clean cut can cut this recording ([`CleanCutRules::is_eligible`]).
    cut_eligible: bool,
    cleanup: NoiseCleanupView,
}

/// A cloud stream's row has no local file: these items are not its.
const CLOUD_STREAM_HIDDEN: [MenuId; 8] = [
    MenuId::Play,
    MenuId::Reveal,
    MenuId::ExportMp4,
    MenuId::Duplicate,
    MenuId::Check,
    MenuId::Repair,
    MenuId::Restore,
    MenuId::NoiseCleanup,
];

/// `useSessionMenu`'s items for one row.
fn row_menu(
    session: &SessionListItem,
    file_path: Option<&str>,
    live: bool,
    protected: bool,
    online: bool,
    repair: RowRepair,
    work: RowWork,
) -> (Vec<MenuItem>, bool, bool) {
    let RowWork {
        duplicating,
        cutting,
        review,
        cut_eligible,
        cleanup,
    } = work;
    let busy = matches!(repair.phase, RepairPhase::Checking | RepairPhase::Repairing);
    let finalizing = is_finalizing(session);
    let stopped = separate_file_stopped(session);
    let can_export = can_export_mp4(session);
    // The backend refuses delete, duplicate, export and repair while Clean
    // cut or noise cleanup works on the recording (E-4): the menu holds them
    // first and says why.
    let file_actions_busy = busy || finalizing || cutting || cleanup.conflicts_with_file_actions;
    let hold: Option<String> = if cutting {
        Some(copy::CLEAN_CUT_HOLD_REASON.to_string())
    } else if cleanup.conflicts_with_file_actions {
        Some(copy::NOISE_CLEANUP_HOLD_REASON.to_string())
    } else {
        protected.then(|| copy::CAPTURE_HOLD_REASON.to_string())
    };
    let persisted_repaired = matches!(session.quality_status, Some(GateStatus::Repaired { .. }));
    let has_file = file_path.is_some();
    let can_rename = !busy;
    let can_delete = !file_actions_busy && !protected;
    let item = |id, label: String, icon, disabled, reason: Option<String>| MenuItem {
        id,
        label,
        icon,
        disabled,
        reason: if disabled { reason } else { None },
        destructive: false,
        separated: false,
        accelerator: "",
    };
    let mut open = vec![item(
        MenuId::Play,
        copy::MENU_PLAY.into(),
        "play",
        !has_file || live,
        None,
    )];
    // The report is saved when the stream ends (plan 119 S3).
    if has_buddy_report(&session.mode) {
        open.push(item(
            MenuId::BuddyReport,
            copy::MENU_BUDDY_REPORT.into(),
            "buddy",
            live,
            None,
        ));
    }
    // Buddy → Clean cut on this recording; its finished cut's review.
    if cut_eligible {
        open.push(item(
            MenuId::CleanCut,
            copy::MENU_CLEAN_CUT.into(),
            "clip",
            false,
            None,
        ));
    }
    if review.is_some() {
        open.push(item(
            MenuId::ReviewCleanCut,
            copy::MENU_REVIEW_CLEAN_CUT.into(),
            "clip",
            false,
            None,
        ));
    }
    open.extend([
        item(
            MenuId::Markers,
            copy::MENU_MARKERS.into(),
            "marker",
            false,
            None,
        ),
        item(
            MenuId::Reveal,
            if finalizing {
                copy::SHOW_ORIGINAL_MP4_SAVING.to_string()
            } else {
                reveal_in_file_manager_label().to_string()
            },
            "folder",
            !has_file,
            None,
        ),
    ]);
    if let Some(label) = cleanup.menu_label.clone() {
        let icon = if cleanup.premium_locked {
            "lock"
        } else {
            "waveform-muted"
        };
        open.push(item(
            MenuId::NoiseCleanup,
            label,
            icon,
            cleanup.menu_action.is_none(),
            None,
        ));
    }
    open.extend([
        item(
            MenuId::ExportMp4,
            if finalization_failed(session) && stopped.is_none() {
                copy::RETRY_MP4_EXPORT.into()
            } else {
                copy::EXPORT_MP4.into()
            },
            "video-file",
            !can_export || file_actions_busy,
            if can_export {
                hold.clone()
            } else if stopped.as_ref().is_some_and(|stopped| !stopped.exportable) {
                Some(copy::NOTHING_TO_EXPORT.to_string())
            } else {
                None
            },
        ),
        item(
            MenuId::StreamManager,
            copy::OPEN_IN_STREAM_MANAGER.into(),
            "chat",
            session.comment_count == 0 || busy || !online,
            None,
        ),
    ]);
    let mut edit = vec![
        MenuItem {
            accelerator: "Enter",
            ..item(
                MenuId::Rename,
                copy::RENAME_ELLIPSIS.into(),
                "edit",
                !can_rename,
                None,
            )
        },
        item(
            MenuId::Duplicate,
            if duplicating {
                copy::DUPLICATING.into()
            } else {
                copy::DUPLICATE.into()
            },
            "copy",
            !has_file || file_actions_busy || duplicating || live,
            if has_file && !live && !duplicating {
                hold.clone()
            } else {
                None
            },
        ),
    ];
    let mut repair_group = vec![item(
        MenuId::Check,
        if repair.phase == RepairPhase::Checking {
            copy::CHECKING.into()
        } else {
            copy::CHECK_QUALITY.into()
        },
        "success",
        !has_file || file_actions_busy || protected,
        if has_file { hold.clone() } else { None },
    )];
    if repair.repairable {
        repair_group.push(item(
            MenuId::Repair,
            if repair.phase == RepairPhase::Repairing {
                copy::REPAIRING.into()
            } else {
                copy::REPAIR_AND_FIX.into()
            },
            "repair",
            file_actions_busy || protected,
            hold.clone(),
        ));
    }
    if repair.has_backup || persisted_repaired {
        repair_group.push(item(
            MenuId::Restore,
            copy::RESTORE_ORIGINAL.into(),
            "reset",
            file_actions_busy || protected,
            hold.clone(),
        ));
    }
    let delete = MenuItem {
        destructive: true,
        accelerator: "CmdOrCtrl+Backspace",
        ..item(
            MenuId::Delete,
            copy::DELETE.into(),
            "delete",
            !can_delete,
            hold.clone(),
        )
    };
    let mut items = Vec::new();
    items.append(&mut open);
    for (index, group) in [&mut edit, &mut repair_group].into_iter().enumerate() {
        let _ = index;
        if let Some(first) = group.first_mut() {
            first.separated = true;
        }
        items.append(group);
    }
    items.push(MenuItem {
        separated: true,
        ..delete
    });
    if session.mode == "cloud-stream" {
        items.retain(|item| !CLOUD_STREAM_HIDDEN.contains(&item.id));
    }
    (items, can_rename, can_delete)
}

/// One row as the table draws it.
fn row_view(
    session: &SessionListItem,
    input: &ViewInput<'_>,
    selected: &[String],
    active: Option<&str>,
    protected: bool,
) -> RowView {
    let status = input.session.status();
    let live = is_live_session(session, status);
    let start_failed =
        start_failed_badge(session, input.data.logs.get(&session.id).map(Vec::as_slice));
    let file_path = if start_failed.is_some() {
        None
    } else {
        session
            .mp4_path
            .as_deref()
            .or(session.output_path.as_deref())
    };
    let finalizing = is_finalizing(session);
    let stopped = separate_file_stopped(session);
    let clean_cut = session.clean_cut_of_session_id.is_some();
    let title = library_title(&session.title);

    let mut meta = day_label(&session.started_at);
    if file_path.is_none() && !live {
        meta.push_str(copy::NO_LOCAL_FILE);
    }
    if session.processing_kind.as_deref() == Some("noise-cleanup")
        && let Some(source) = &session.source_title
    {
        meta.push_str(&copy::cleaned_from(source));
    }
    if clean_cut && let Some(source) = &session.source_title {
        meta.push_str(&copy::cut_from(source));
    }
    if let Some(note) = session
        .recording_role
        .as_deref()
        .and_then(recording_role_row_note)
    {
        meta.push_str(&format!(" · {note}"));
    }

    let scene = if let Some(label) = session
        .recording_role
        .as_deref()
        .and_then(recording_role_label)
    {
        Some(label.to_string())
    } else if session.processing_kind.as_deref() == Some("noise-cleanup") {
        Some(copy::NOISE_CLEANED.to_string())
    } else if clean_cut {
        Some(
            match session.clean_cut_mode.as_deref().unwrap_or("clean") {
                "condensed" => "Condensed",
                _ => "Clean cut",
            }
            .to_string(),
        )
    } else {
        session.scene_label.clone()
    }
    .map(|text| SceneBadge { text });

    let duration = if live {
        duration_ms_label(elapsed_ms(status, input.now))
    } else {
        duration_ms_label(session.duration_ms)
    };

    let file = if live {
        let (label, tone) = input.session.status_pill();
        FileCell::Live {
            label: label.to_string(),
            tone,
            pulse: matches!(label, "Recording" | "On air"),
        }
    } else if finalizing {
        FileCell::Finalizing(finalizing_badge_label(
            session.finalization_progress_percent,
        ))
    } else if let Some(stopped) = stopped {
        FileCell::Problem {
            label: stopped.label,
            detail: stopped.detail,
        }
    } else if finalization_failed(session) {
        FileCell::Problem {
            label: copy::MP4_FAILED.to_string(),
            detail: session.finalization_error.clone().unwrap_or_default(),
        }
    } else if let Some(failed) = start_failed {
        FileCell::Problem {
            label: failed.label,
            detail: failed.detail,
        }
    } else if let Some(recovered) = interrupted_take_badge(session) {
        FileCell::Note {
            label: recovered.label,
            detail: recovered.detail,
        }
    } else if let Some(format) = session_format_label(session) {
        FileCell::Format(format)
    } else {
        FileCell::None
    };

    let poster = if live {
        let (label, tone) = input.session.status_pill();
        PosterView::Live {
            tone,
            pulse: matches!(label, "Recording" | "On air"),
        }
    } else if session.status == "running" || finalizing || !input.data.online {
        PosterView::Glyph
    } else {
        PosterView::Picture {
            version: session.duration_ms,
        }
    };

    let repair = input
        .ui
        .repairs
        .get(&session.id)
        .copied()
        .unwrap_or_default();
    let busy = matches!(repair.phase, RepairPhase::Checking | RepairPhase::Repairing);
    let active_cut = active_clean_cuts(input.clean_cuts, input.clean_cut).remove(&session.id);
    let cleanup = with_connection_state(
        noise_cleanup_view(NoiseCleanupInput {
            session,
            premium_locked: input.noise_premium_locked,
            job: latest_job_for_session(input.noise_jobs, &session.id),
            capture_active: protected,
        }),
        input.data.online,
    );
    let locked = active_cut.is_some() || cleanup.busy;
    let review = clean_cut_reviews(input.clean_cuts, input.data.sessions).remove(&session.id);
    let (menu, can_rename, can_delete) = row_menu(
        session,
        file_path,
        live,
        protected,
        input.data.online,
        repair,
        RowWork {
            duplicating: input.ui.duplicating.contains(&session.id),
            cutting: active_cut.is_some(),
            review,
            cut_eligible: input.clean_cut.is_eligible(session),
            cleanup: cleanup.clone(),
        },
    );
    let capture = CleanCutCapture {
        active: protected,
        streaming: matches!(input.session.status().state, RecordingState::Streaming),
    };
    RowView {
        id: session.id.clone(),
        title,
        meta,
        quality: quality_chip(session.quality_status.as_ref()),
        scene,
        duration,
        size: format_bytes(session.file_size_bytes.map(|bytes| bytes as f64)),
        file,
        poster,
        selected: selected.contains(&session.id),
        selectable: !protected && !live && !locked,
        active: active == Some(session.id.as_str()),
        revealed: input.ui.revealed.as_deref() == Some(session.id.as_str()),
        play_reason: if live {
            Some(copy::PLAY_WAITS_FOR_END)
        } else if file_path.is_none() {
            Some(copy::NO_FILE_TO_PLAY)
        } else {
            None
        },
        menu,
        menu_busy: busy,
        menu_disabled: !input.data.online,
        can_rename,
        can_delete,
        clean_cut: active_cut.map(|job| clean_cut_chip(job, capture, input.clean_cut)),
        noise: cleanup.direct_label.is_some().then_some(cleanup),
    }
}

/// The page, from the data, the session and what the page remembers.
pub fn library_view(input: &ViewInput<'_>) -> LibraryView {
    let ui = input.ui;
    let data = input.data;
    let protected = capture_protected(input.session);
    let visible = sort_sessions(
        filter_sessions(data.sessions, ui.filter, &ui.query),
        ui.sort,
    );
    let cutting: BTreeSet<String> = active_clean_cuts(input.clean_cuts, input.clean_cut)
        .into_keys()
        .collect();
    let cleaning = active_source_ids(input.noise_jobs);
    let locked: BTreeSet<String> = cutting.union(&cleaning).cloned().collect();
    let rows_in_view = visible_rows(data.sessions, ui, input.session, &locked);
    let in_view: BTreeSet<String> = rows_in_view.ordered.iter().cloned().collect();
    let selected = prune_selection(&ui.selection.selected, &in_view);
    let active = ui
        .active
        .as_deref()
        .filter(|id| in_view.contains(*id))
        .or(rows_in_view.ordered.first().map(String::as_str));
    let list = list_state(data.sessions.len(), data.loaded, data.online);
    let partial = partial_notice(
        data.sessions.len(),
        data.has_more,
        ui.filter,
        &ui.query,
        ui.sort,
    );
    let rows: Vec<RowView> = visible
        .iter()
        .map(|session| row_view(session, input, &selected, active, protected))
        .collect();
    let rename = ui.rename.as_ref().map(|rename| RenameView {
        draft: rename.draft.clone(),
        error: rename.error.clone(),
        can_submit: !rename.draft.trim().is_empty(),
    });
    let delete = ui.delete.as_ref().filter(|d| !d.ids.is_empty()).map(|d| {
        let count = d.ids.len();
        let (names, more) = if count > 1 {
            delete_names(&d.titles)
        } else {
            (Vec::new(), 0)
        };
        DeleteView {
            title: copy::delete_title(count),
            description: copy::delete_description(count),
            names,
            more: (more > 0).then(|| copy::and_more(more)),
            confirm_label: copy::delete_confirm_label(d.pending),
            confirm_disabled: d.pending || protected,
            cancel_disabled: d.pending,
        }
    });
    LibraryView {
        filter_index: ui.filter.index(),
        sort_index: ui.sort.index(),
        query: ui.query.clone(),
        importing: ui.importing,
        selected_count: selected.len(),
        bulk_hold: if protected {
            Some(copy::CAPTURE_HOLD_REASON)
        } else if selected.iter().any(|id| cutting.contains(id)) {
            Some(copy::CLEAN_CUT_HOLD_REASON)
        } else if selected.iter().any(|id| cleaning.contains(id)) {
            Some(copy::NOISE_CLEANUP_HOLD_REASON)
        } else {
            None
        },
        offline_alert: !data.online && list != ListState::Offline,
        partial_notice: partial,
        load_all_label: if ui.loading_all {
            copy::LOADING
        } else {
            copy::LOAD_ALL
        },
        load_all_enabled: !ui.loading_all && !data.loading_more && data.online,
        list_state: list,
        no_match: (list == ListState::Rows && rows.is_empty())
            .then(|| clear_label(ui.filter, &ui.query)),
        select_all: select_all_state(&selected, &rows_in_view.selectable),
        select_all_enabled: !rows_in_view.selectable.is_empty(),
        rows,
        footer: if let Some((count, total)) = data.totals {
            Some(storage_label(count, total, input.free_bytes))
        } else if data.has_more {
            Some(format!(
                "{} loaded",
                plural(data.sessions.len() as i64, "recording", None)
            ))
        } else {
            None
        }
        .filter(|_| list == ListState::Rows),
        load_more: (data.has_more && list == ListState::Rows).then_some(if data.loading_more {
            copy::LOADING
        } else {
            copy::LOAD_MORE
        }),
        load_more_enabled: !data.loading_more,
        rename,
        delete,
        markers: ui
            .markers
            .as_ref()
            .map(|markers| markers.view(data.sessions, input.session.status(), data.online)),
    }
}
