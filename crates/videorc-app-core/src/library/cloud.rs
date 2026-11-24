//! The Library's Cloud tab (plan 260 S1.6f, from Electron's plan 234 and the
//! Local | Cloud tabs of 2026-11-19): the account's cloud recordings
//! (`cloud.recordings.list`), newest first, in the same table as the Local
//! tab. A managed one (`format: "segments"`) downloads here as a backend job
//! with its progress in the row, then opens in the Local tab; a node one
//! downloads from the account page on videorc.com.
//!
//! Electron's files, one for one:
//! - `lib/cloud-recordings-view.ts`: the pure rules ([`sort_cloud_recordings`],
//!   [`reduce_cloud_download`], [`cloud_row_view`] and the rest).
//! - `lib/cloud-recording-downloads.ts`: the window's downloads
//!   ([`CloudDownloadsStore`]), kept for the life of the window so a row finds
//!   its progress again when the Library opens next, and the requests
//!   ([`start_cloud_download`], [`cancel_cloud_download`],
//!   [`reconcile_cloud_downloads`]).
//! - `lib/cloud-recordings-watch.ts`: "a cloud recording just stopped"
//!   ([`CloudRecordingWatch`]), for the tab to wait for the take's row.
//! - `components/tabs/library-cloud-recordings.tsx`: the tab's words, the
//!   row's menu ([`cloud_row_menu`]) and its footer.
//!
//! The wire types mirror `shared/backend.ts` (and the backend's
//! `cloud_control_web.rs`); they are not in `videorc-protocol` yet.
//! Not here: the take's separate files (`library-cloud-iso.tsx`, plan 249
//! S22), the cloud program archive and the show's markers dialog.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::LibraryBackend;
use crate::client::RpcError;
use crate::format::{format_bytes, plural};

// ── The wire ─────────────────────────────────────────────────────────────

/// The job events of a cloud download.
pub const CLOUD_DOWNLOAD_EVENT: &str = "cloud.recordings.download";
/// The events the Cloud tab reads beyond the Library's.
pub const CLOUD_EVENTS: [&str; 1] = [CLOUD_DOWNLOAD_EVENT];

/// `CloudRecordingItem`: a cloud recording as `cloud.recordings.list`
/// answers it, the facts and no URL.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingItem {
    pub id: String,
    #[serde(default)]
    pub show_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_id: Option<String>,
    #[serde(default)]
    pub association_known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_interval_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_session_id: Option<String>,
    /// `h` or `v`.
    #[serde(default)]
    pub orientation: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub seconds: f64,
    #[serde(default)]
    pub bytes: f64,
    /// `segments` (made into an MP4 here) or `mp4` (from videorc.com).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// `CloudRecordingsList`.
#[derive(Debug, Clone, Default, Deserialize)]
struct CloudRecordingsList {
    #[serde(default)]
    recordings: Vec<CloudRecordingItem>,
}

/// A download job's state, as its events say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadEventState {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// `CloudRecordingDownloadEvent`: one `cloud.recordings.download` event, and
/// one item of `cloud.recordings.downloads`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingDownloadEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_session_id: Option<String>,
    pub job_id: String,
    pub recording_id: String,
    pub state: DownloadEventState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_segments: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_segments: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── The tab's words (`library-cloud-recordings.tsx`, `library-tab.tsx`) ─

pub const LOCAL_VIEW: &str = "Local";
pub const CLOUD_VIEW: &str = "Cloud";
pub const TITLE: &str = "Cloud recordings";
pub const DESCRIPTION: &str =
    "Talk shows Videorc Cloud recorded. Each one is deleted on the date shown.";
pub const REFRESH: &str = "Refresh";
pub const REFRESHING: &str = "Refreshing…";
pub const SIGN_IN_REASON: &str = "Sign in to see your cloud recordings.";
pub const TRY_AGAIN: &str = "Try again";
pub const LOADING: &str = "Loading cloud recordings…";
pub const EMPTY_TITLE: &str = "No cloud recordings yet";
pub const EMPTY_DESCRIPTION: &str = "Record a talk show with Videorc Cloud, and it shows up here.";
pub const COLUMN_NAME: &str = "Name";
pub const COLUMN_ORIENTATION: &str = "Orientation";
pub const COLUMN_DURATION: &str = "Duration";
pub const COLUMN_SIZE: &str = "Size";
pub const COLUMN_STATUS: &str = "Status";
pub const COLUMN_ACTIONS: &str = "Actions";
pub const PROCESSING_TITLE: &str = "Latest take";
pub const PROCESSING_DETAIL: &str = "Saving in the cloud…";
pub const PROCESSING_TAG: &str = "Processing";
pub const OPEN_IN_LIBRARY: &str = "Open in Library";
pub const DOWNLOAD: &str = "Download";
pub const CANCEL: &str = "Cancel";
pub const OPEN_ON_WEB: &str = "Open on videorc.com";
pub const DOWNLOAD_TO_LIBRARY: &str = "Download to Library";
pub const TRY_DOWNLOAD_AGAIN: &str = "Try the download again";
pub const CANCEL_DOWNLOAD: &str = "Cancel download";
pub const SHOW_MARKERS: &str = "Show markers";
pub const ROW_MENU_LABEL: &str = "Cloud recording actions";
pub const FOLDER_UNAVAILABLE: &str = "The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.";
pub const SEGMENT_FAILED_TEXT: &str = "Part of the recording didn't download. Try again.";

/// `cloud.recordings.list` failed: `userErrorMessage`'s context.
pub const LOAD_CONTEXT: (&str, &str) = ("load", "your cloud recordings");
/// A download failed: `userErrorMessage`'s context.
pub const DOWNLOAD_CONTEXT: (&str, &str) = ("download", "the cloud recording");

// ── Local | Cloud ────────────────────────────────────────────────────────

/// The Library's two tabs. The page reopens on the one used last, for this
/// run of the app (`lastLibraryView`); an explicit "show this recording"
/// (Clean cut's Open in Library, a cloud take's Open in Library) opens Local
/// with the search and the filter cleared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LibraryView {
    #[default]
    Local,
    Cloud,
}

impl LibraryView {
    pub const ALL: [LibraryView; 2] = [LibraryView::Local, LibraryView::Cloud];

    pub fn id(self) -> &'static str {
        match self {
            LibraryView::Local => "local",
            LibraryView::Cloud => "cloud",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            LibraryView::Local => LOCAL_VIEW,
            LibraryView::Cloud => CLOUD_VIEW,
        }
    }
}

// ── The list ─────────────────────────────────────────────────────────────

/// `Date.parse` for the backend's ISO stamps; `None` when it does not read.
fn parse_ms(stamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(stamp)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// `downloadsOnThisComputer`: a managed recording this computer makes into
/// an MP4.
pub fn downloads_on_this_computer(recording: &CloudRecordingItem) -> bool {
    recording.format.as_deref() == Some("segments")
}

/// `sortCloudRecordings`: newest first, by when the take started; an
/// unreadable time sorts last. Stable, as `Array.sort` is.
pub fn sort_cloud_recordings(recordings: &[CloudRecordingItem]) -> Vec<CloudRecordingItem> {
    let mut sorted = recordings.to_vec();
    sorted.sort_by_key(|recording| std::cmp::Reverse(parse_ms(&recording.started_at)));
    sorted
}

/// `cloudOrientationLabel`: the web's `h` and `v`, in words.
pub fn cloud_orientation_label(orientation: &str) -> &'static str {
    if orientation == "v" {
        "Vertical"
    } else {
        "Horizontal"
    }
}

/// `cloudTakeLabel`: the row's name.
pub fn cloud_take_label(recording: &CloudRecordingItem) -> String {
    match recording.live_interval_ids.as_ref().map(Vec::len) {
        Some(count) if recording.association_known => match count {
            0 => "Record-only take".into(),
            1 => "Take · 1 live interval".into(),
            count => format!("Take · {count} live intervals"),
        },
        _ => "Cloud take".into(),
    }
}

/// Where the cloud copy stands (`cloudRecordingAvailability`). No local file
/// is inferred from a completed cloud take or an old job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAvailability {
    Available,
    Expired,
    Missing,
}

pub fn cloud_recording_availability(
    recording: &CloudRecordingItem,
    now_ms: i64,
) -> CloudAvailability {
    if recording.availability.as_deref() == Some("missing") {
        return CloudAvailability::Missing;
    }
    let expired = recording.availability.as_deref() == Some("expired")
        || parse_ms(&recording.expires_at).is_some_and(|expires| expires <= now_ms);
    if expired {
        CloudAvailability::Expired
    } else {
        CloudAvailability::Available
    }
}

/// The footer: what the cloud keeps ("3 cloud recordings · 1.2 GB").
pub fn cloud_footer(recordings: &[CloudRecordingItem]) -> String {
    let bytes: f64 = recordings.iter().map(|recording| recording.bytes).sum();
    format!(
        "{} · {}",
        plural(recordings.len() as i64, "cloud recording", None),
        format_bytes(Some(bytes))
    )
}

// ── A download in its row ────────────────────────────────────────────────

/// `CloudDownloadView`: a download as the row shows it. A cancelled one is
/// gone: the row is ready again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudDownloadView {
    Starting,
    Running {
        job_id: String,
        done: Option<u64>,
        total: Option<u64>,
    },
    Done {
        job_id: String,
        local_session_id: Option<String>,
    },
    Failed {
        job_id: Option<String>,
    },
}

/// The window's downloads, by recording id.
pub type CloudDownloads = BTreeMap<String, CloudDownloadView>;

/// `reduceCloudDownload`: the downloads after one event.
pub fn reduce_cloud_download(downloads: &mut CloudDownloads, event: &CloudRecordingDownloadEvent) {
    let id = event.recording_id.clone();
    match event.state {
        DownloadEventState::Running => {
            downloads.insert(
                id,
                CloudDownloadView::Running {
                    job_id: event.job_id.clone(),
                    done: event.done_segments,
                    total: event.total_segments,
                },
            );
        }
        DownloadEventState::Done => {
            downloads.insert(
                id,
                CloudDownloadView::Done {
                    job_id: event.job_id.clone(),
                    local_session_id: event
                        .local_session_id
                        .clone()
                        .filter(|session| !session.is_empty()),
                },
            );
        }
        DownloadEventState::Failed => {
            downloads.insert(
                id,
                CloudDownloadView::Failed {
                    job_id: Some(event.job_id.clone()),
                },
            );
        }
        DownloadEventState::Cancelled => {
            downloads.remove(&id);
        }
    }
}

/// `cloudDownloadPercent`: how far a running download is, 0 to 100, or
/// `None` before its total is known.
pub fn cloud_download_percent(view: &CloudDownloadView) -> Option<u64> {
    let CloudDownloadView::Running { done, total, .. } = view else {
        return None;
    };
    let total = total.filter(|total| *total > 0)?;
    let done = done.unwrap_or(0).min(total);
    Some(done * 100 / total)
}

/// `knownCloudDownloadRefusal`: the backend's own sentence for a download
/// that failed or was refused (`cloud_control_web.rs`), which reads as copy;
/// anything else (FFmpeg's lines, a transport error) is `None` and goes to
/// the log only. A segment's number means nothing to a streamer, so that
/// one is said plainly.
pub fn known_cloud_download_refusal(raw: Option<&str>) -> Option<String> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    if text
        .strip_prefix("Recording segment ")
        .and_then(|rest| rest.strip_suffix(" could not be downloaded."))
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
    {
        return Some(SEGMENT_FAILED_TEXT.into());
    }
    const EXACT: [&str; 12] = [
        "Sign in to see your cloud recordings.",
        "Sign in to download your cloud recordings.",
        "That recording is not in your account any more.",
        "The cloud recording has expired.",
        "The recording artifact is no longer available.",
        "This recording downloads from your account on videorc.com.",
        "There isn't enough space to save the recording.",
        "The recording could not be saved. Check the folder and available space.",
        "videorc.com did not answer with the recording's playlist.",
        "The recording's playlist is not supported.",
        "The recording's playlist has no segments.",
        "The recording download stopped. Try again.",
    ];
    // `^Videorc can't save to [^\n]{1,512}\.$`: one line, up to 512 UTF-16
    // units of folder (counted here in chars).
    let cannot_save = text
        .strip_prefix("Videorc can't save to ")
        .and_then(|rest| rest.strip_suffix('.'))
        .is_some_and(|folder| {
            let count = folder.chars().count();
            (1..=512).contains(&count) && !folder.contains('\n')
        });
    (cannot_save || EXACT.contains(&text)).then(|| text.to_string())
}

// ── After Stop recording ─────────────────────────────────────────────────

/// After Stop recording, the list is asked every 5 s for up to 2 minutes.
pub const CLOUD_RECORDING_POLL_MS: i64 = 5_000;
pub const CLOUD_RECORDING_POLL_WINDOW_MS: i64 = 120_000;
/// The web's clock and this computer's may differ by this much.
const START_SLOP_MS: i64 = 60_000;

/// `CloudRecordingStop`: a cloud recording that stopped on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudRecordingStop {
    pub since_ms: i64,
    pub stopped_at_ms: i64,
}

/// `awaitingCloudRecording`: whether the list still waits for the take that
/// `stop` ended. `listed_at_stop` holds the ids the list showed when the
/// take stopped: a take from a minute before, inside the allowance and
/// listed already, is not this one.
pub fn awaiting_cloud_recording(
    stop: Option<CloudRecordingStop>,
    recordings: Option<&[CloudRecordingItem]>,
    now_ms: i64,
    listed_at_stop: Option<&BTreeSet<String>>,
) -> bool {
    let Some(stop) = stop else { return false };
    if now_ms - stop.stopped_at_ms >= CLOUD_RECORDING_POLL_WINDOW_MS {
        return false;
    }
    let Some(recordings) = recordings else {
        return true;
    };
    !recordings.iter().any(|recording| {
        if listed_at_stop.is_some_and(|listed| listed.contains(&recording.id)) {
            return false;
        }
        parse_ms(&recording.started_at)
            .is_some_and(|started| started >= stop.since_ms - START_SLOP_MS)
    })
}

/// `cloud-recordings-watch.ts`: the talk show's room host reports every
/// `cloudStatus.recording` here, and the Cloud tab reads the last stop.
#[derive(Debug, Clone, Default)]
pub struct CloudRecordingWatch {
    active_since_ms: Option<i64>,
    last_stop: Option<CloudRecordingStop>,
}

impl CloudRecordingWatch {
    /// `noteCloudRecording`: the cloud recording as `cloud.state` has it
    /// now (`active`, `since`). True when this report is a stop, which the
    /// tab is told about.
    pub fn note(&mut self, active: bool, since: Option<&str>, now_ms: i64) -> bool {
        if active {
            self.active_since_ms = since
                .and_then(parse_ms)
                .or(self.active_since_ms)
                .or(Some(now_ms));
            return false;
        }
        let Some(since_ms) = self.active_since_ms.take() else {
            return false;
        };
        self.last_stop = Some(CloudRecordingStop {
            since_ms,
            stopped_at_ms: now_ms,
        });
        true
    }

    /// The last cloud recording that stopped while this window watched.
    pub fn last_stop(&self) -> Option<CloudRecordingStop> {
        self.last_stop
    }
}

// ── A cloud recording as its row ─────────────────────────────────────────

/// `CloudRowStatus`: one state per row, in this order: a copy on this
/// computer wins, then a cloud copy that is gone, then this computer's
/// download, then where the recording downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudRowStatus {
    Downloaded {
        local_session_id: Option<String>,
        job_id: Option<String>,
    },
    Expired,
    Missing,
    Starting,
    Downloading {
        job_id: String,
        percent: Option<u64>,
    },
    Failed,
    InCloud,
    OnWeb,
}

impl CloudRowStatus {
    /// The `data-cloud-status` value.
    pub fn kind(&self) -> &'static str {
        match self {
            CloudRowStatus::Downloaded { .. } => "downloaded",
            CloudRowStatus::Expired => "expired",
            CloudRowStatus::Missing => "missing",
            CloudRowStatus::Starting => "starting",
            CloudRowStatus::Downloading { .. } => "downloading",
            CloudRowStatus::Failed => "failed",
            CloudRowStatus::InCloud => "in-cloud",
            CloudRowStatus::OnWeb => "on-web",
        }
    }

    /// The tag shows a spinner.
    pub fn working(&self) -> bool {
        matches!(
            self,
            CloudRowStatus::Starting | CloudRowStatus::Downloading { .. }
        )
    }
}

/// `CloudRowAction`: the row's one direct action, beside its ⋯ menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudRowAction {
    OpenLocal,
    Reveal,
    Download,
    Retry,
    Cancel,
    OpenWeb,
}

impl CloudRowAction {
    /// `actionLabel`: the button's words (the platform names the file
    /// manager).
    pub fn label(self) -> &'static str {
        match self {
            CloudRowAction::OpenLocal => OPEN_IN_LIBRARY,
            CloudRowAction::Reveal => super::page::reveal_in_file_manager_label(),
            CloudRowAction::Download => DOWNLOAD,
            CloudRowAction::Retry => TRY_AGAIN,
            CloudRowAction::Cancel => CANCEL,
            CloudRowAction::OpenWeb => OPEN_ON_WEB,
        }
    }

    /// The button's accessible name: Cancel says what it cancels.
    pub fn aria_label(self) -> &'static str {
        match self {
            CloudRowAction::Cancel => CANCEL_DOWNLOAD,
            other => other.label(),
        }
    }

    /// The button's tooltip: Download says where to.
    pub fn tooltip(self) -> &'static str {
        match self {
            CloudRowAction::Download => DOWNLOAD_TO_LIBRARY,
            other => other.label(),
        }
    }

    /// Offline, these are disabled: they need the backend.
    pub fn needs_backend(self) -> bool {
        matches!(
            self,
            CloudRowAction::Download | CloudRowAction::Retry | CloudRowAction::Cancel
        )
    }
}

/// `CloudRowView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudRowView {
    pub status: CloudRowStatus,
    /// The Status column's tag.
    pub status_label: String,
    /// Why, on hover, when the tag alone doesn't say.
    pub status_detail: Option<&'static str>,
    /// "Kept until 18 Dec" while the cloud still keeps it.
    pub kept_until_ms: Option<i64>,
    pub action: Option<CloudRowAction>,
}

/// `cloudRowStatus`.
pub fn cloud_row_status(
    recording: &CloudRecordingItem,
    download: Option<&CloudDownloadView>,
    now_ms: i64,
) -> CloudRowStatus {
    let done = match download {
        Some(CloudDownloadView::Done {
            job_id,
            local_session_id,
        }) => Some((job_id.clone(), local_session_id.clone())),
        _ => None,
    };
    let local = recording
        .local_session_id
        .clone()
        .filter(|session| !session.is_empty());
    let done_session = done.as_ref().and_then(|(_, session)| session.clone());
    if local.is_some() || done_session.is_some() {
        return CloudRowStatus::Downloaded {
            local_session_id: local.or(done_session),
            job_id: done.map(|(job, _)| job),
        };
    }
    if let Some((job_id, _)) = done {
        return CloudRowStatus::Downloaded {
            local_session_id: None,
            job_id: Some(job_id),
        };
    }
    match cloud_recording_availability(recording, now_ms) {
        CloudAvailability::Expired => return CloudRowStatus::Expired,
        CloudAvailability::Missing => return CloudRowStatus::Missing,
        CloudAvailability::Available => {}
    }
    if !downloads_on_this_computer(recording) {
        return CloudRowStatus::OnWeb;
    }
    match download {
        Some(CloudDownloadView::Starting) => CloudRowStatus::Starting,
        Some(view @ CloudDownloadView::Running { job_id, .. }) => CloudRowStatus::Downloading {
            job_id: job_id.clone(),
            percent: cloud_download_percent(view),
        },
        Some(CloudDownloadView::Failed { .. }) => CloudRowStatus::Failed,
        _ => CloudRowStatus::InCloud,
    }
}

/// `cloudRowView`: a cloud recording as its Library row shows it.
pub fn cloud_row_view(
    recording: &CloudRecordingItem,
    download: Option<&CloudDownloadView>,
    now_ms: i64,
) -> CloudRowView {
    let status = cloud_row_status(recording, download, now_ms);
    let kept_until_ms = match status {
        CloudRowStatus::Expired | CloudRowStatus::Missing => None,
        _ => parse_ms(&recording.expires_at),
    };
    let status_label = match &status {
        CloudRowStatus::Downloading {
            percent: Some(percent),
            ..
        } => format!("Downloading {percent}%"),
        CloudRowStatus::Downloaded { .. } => "Downloaded".into(),
        CloudRowStatus::Expired => "Expired".into(),
        CloudRowStatus::Missing => "File missing".into(),
        CloudRowStatus::Starting => "Starting…".into(),
        CloudRowStatus::Downloading { .. } => "Downloading…".into(),
        CloudRowStatus::Failed => "Download failed".into(),
        CloudRowStatus::InCloud => "In the cloud".into(),
        CloudRowStatus::OnWeb => "On videorc.com".into(),
    };
    let status_detail = match status {
        CloudRowStatus::Expired => {
            Some("The cloud copy was deleted on the date it was kept until.")
        }
        CloudRowStatus::Missing => Some("The cloud no longer has this file."),
        CloudRowStatus::Failed => Some("The download stopped. Try again."),
        CloudRowStatus::OnWeb => Some("This recording downloads from your account on videorc.com."),
        _ => None,
    };
    let action = match &status {
        CloudRowStatus::Downloaded {
            local_session_id: None,
            job_id,
        } => job_id.as_ref().map(|_| CloudRowAction::Reveal),
        CloudRowStatus::Downloaded { .. } => Some(CloudRowAction::OpenLocal),
        CloudRowStatus::Expired | CloudRowStatus::Missing | CloudRowStatus::Starting => None,
        CloudRowStatus::Downloading { .. } => Some(CloudRowAction::Cancel),
        CloudRowStatus::Failed => Some(CloudRowAction::Retry),
        CloudRowStatus::InCloud => Some(CloudRowAction::Download),
        CloudRowStatus::OnWeb => Some(CloudRowAction::OpenWeb),
    };
    CloudRowView {
        status,
        status_label,
        status_detail,
        kept_until_ms,
        action,
    }
}

/// What a row's menu item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudMenuCommand {
    Run(CloudRowAction),
    ShowMarkers,
}

/// One item of the ⋯ menu (and the right-click menu, the same list).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudMenuItem {
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub command: CloudMenuCommand,
    /// Offline: what needs the backend is disabled.
    pub disabled: bool,
}

/// The row's menu: open, then download, then the show's markers.
pub fn cloud_row_menu(view: &CloudRowView, offline: bool) -> Vec<CloudMenuItem> {
    let item = |id, group, label, command, disabled| CloudMenuItem {
        id,
        group,
        label,
        command,
        disabled,
    };
    let (local, reveal) = match &view.status {
        CloudRowStatus::Downloaded {
            local_session_id,
            job_id,
        } => (local_session_id.is_some(), job_id.is_some()),
        _ => (false, false),
    };
    let mut items = Vec::new();
    if local {
        let run = CloudMenuCommand::Run(CloudRowAction::OpenLocal);
        items.push(item("open-local", "open", OPEN_IN_LIBRARY, run, false));
    }
    if reveal {
        let run = CloudMenuCommand::Run(CloudRowAction::Reveal);
        let label = super::page::reveal_in_file_manager_label();
        items.push(item("reveal", "open", label, run, false));
    }
    let web = CloudMenuCommand::Run(CloudRowAction::OpenWeb);
    items.push(item("open-web", "open", OPEN_ON_WEB, web, false));
    match view.status {
        CloudRowStatus::InCloud | CloudRowStatus::Failed => {
            let failed = view.status == CloudRowStatus::Failed;
            let label = if failed {
                TRY_DOWNLOAD_AGAIN
            } else {
                DOWNLOAD_TO_LIBRARY
            };
            let run = CloudMenuCommand::Run(CloudRowAction::Download);
            items.push(item("download", "download", label, run, offline));
        }
        CloudRowStatus::Downloading { .. } => {
            let run = CloudMenuCommand::Run(CloudRowAction::Cancel);
            items.push(item(
                "cancel-download",
                "download",
                CANCEL_DOWNLOAD,
                run,
                offline,
            ));
        }
        _ => {}
    }
    let markers = CloudMenuCommand::ShowMarkers;
    items.push(item("markers", "show", SHOW_MARKERS, markers, offline));
    items
}

/// The row's second line: when it ran, and how long the cloud keeps it
/// (`dayLabel · Kept until Dec 14`).
pub fn cloud_row_detail(
    recording: &CloudRecordingItem,
    view: &CloudRowView,
    now: chrono::DateTime<chrono::Utc>,
) -> String {
    let day = crate::format::day_label(&recording.started_at);
    match view
        .kept_until_ms
        .and_then(chrono::DateTime::from_timestamp_millis)
    {
        Some(kept) => format!(
            "{day} · Kept until {}",
            crate::format::format_short_date(kept, now)
        ),
        None => day,
    }
}

/// The roving focus's row: the active one while it is listed, else the
/// first.
pub fn active_cloud_row<'a>(
    recordings: &'a [CloudRecordingItem],
    active: Option<&str>,
) -> Option<&'a str> {
    active
        .and_then(|active| recordings.iter().find(|row| row.id == active))
        .or(recordings.first())
        .map(|row| row.id.as_str())
}

// ── The window's downloads (`cloud-recording-downloads.ts`) ─────────────

/// What a download event asks the window to tell, beyond its row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudDownloadNotice {
    /// It failed and needs the streamer, whether or not the row is in view.
    /// `known` is the backend's own sentence; anything else is `raw`, for
    /// the log and the support ring only.
    Failed {
        recording_id: String,
        known: Option<String>,
        raw: String,
    },
    /// It finished while no Cloud tab was open: Saved, with Show in Finder
    /// for this job.
    Saved {
        recording_id: String,
        job_id: String,
    },
}

/// A reconcile in flight: the snapshot's generation and the revisions it
/// started from.
#[derive(Debug, Clone)]
pub struct ReconcileTicket {
    generation: u64,
    before: BTreeMap<String, u64>,
}

/// The downloads this window knows, for its whole life: the Cloud tab loads
/// it and it stays, so rows find their progress again when the Library
/// opens next.
#[derive(Debug, Clone, Default)]
pub struct CloudDownloadsStore {
    downloads: CloudDownloads,
    /// Each recording's change count: a snapshot that raced a newer event
    /// leaves that recording alone.
    revisions: BTreeMap<String, u64>,
    generation: u64,
    /// Open Cloud tabs: while one is open, the row is the news.
    open_views: usize,
}

impl CloudDownloadsStore {
    pub fn downloads(&self) -> &CloudDownloads {
        &self.downloads
    }

    pub fn get(&self, recording_id: &str) -> Option<&CloudDownloadView> {
        self.downloads.get(recording_id)
    }

    fn bump(&mut self, recording_id: &str) {
        *self.revisions.entry(recording_id.to_string()).or_default() += 1;
    }

    /// `holdCloudDownloadsView`: a Cloud tab is on screen.
    pub fn hold_view(&mut self) {
        self.open_views += 1;
    }

    /// The tab closed.
    pub fn release_view(&mut self) {
        self.open_views = self.open_views.saturating_sub(1);
    }

    /// One `cloud.recordings.download` event: the row moves, and what the
    /// window should say beyond it.
    pub fn apply(&mut self, event: &CloudRecordingDownloadEvent) -> Option<CloudDownloadNotice> {
        self.bump(&event.recording_id);
        reduce_cloud_download(&mut self.downloads, event);
        match event.state {
            DownloadEventState::Failed => Some(CloudDownloadNotice::Failed {
                recording_id: event.recording_id.clone(),
                known: known_cloud_download_refusal(event.error.as_deref()),
                raw: event.error.clone().unwrap_or_default(),
            }),
            DownloadEventState::Done if self.open_views == 0 => Some(CloudDownloadNotice::Saved {
                recording_id: event.recording_id.clone(),
                job_id: event.job_id.clone(),
            }),
            _ => None,
        }
    }

    /// Download pressed: the row says Starting… at once.
    pub fn begin_start(&mut self, recording_id: &str) {
        self.bump(recording_id);
        self.downloads
            .insert(recording_id.to_string(), CloudDownloadView::Starting);
    }

    /// The job started. An event may have come first (running, or already
    /// done): it wins.
    pub fn started(&mut self, recording_id: &str, job_id: &str) {
        self.bump(recording_id);
        if self.downloads.get(recording_id) == Some(&CloudDownloadView::Starting) {
            self.downloads.insert(
                recording_id.to_string(),
                CloudDownloadView::Running {
                    job_id: job_id.to_string(),
                    done: None,
                    total: None,
                },
            );
        }
    }

    /// `failCloudDownload`: the start failed (or was refused before it
    /// went out); the row offers Try again.
    pub fn start_failed(&mut self, recording_id: &str) {
        self.bump(recording_id);
        self.downloads.insert(
            recording_id.to_string(),
            CloudDownloadView::Failed { job_id: None },
        );
    }

    /// A `cloud.recordings.downloads` snapshot is about to be asked for.
    pub fn begin_reconcile(&mut self) -> ReconcileTicket {
        self.generation += 1;
        ReconcileTicket {
            generation: self.generation,
            before: self.revisions.clone(),
        }
    }

    /// The snapshot arrived. A newer snapshot wins; a recording that moved
    /// since the ask keeps its row; a running row the backend no longer
    /// runs is gone. False when the snapshot was stale and nothing changed.
    pub fn finish_reconcile(
        &mut self,
        ticket: ReconcileTicket,
        jobs: &[CloudRecordingDownloadEvent],
    ) -> bool {
        if ticket.generation != self.generation {
            return false;
        }
        let unchanged = |revisions: &BTreeMap<String, u64>, id: &str| {
            revisions.get(id).copied().unwrap_or(0) == ticket.before.get(id).copied().unwrap_or(0)
        };
        let gone: Vec<String> = self
            .downloads
            .iter()
            .filter(|(id, view)| match view {
                CloudDownloadView::Running { job_id, .. } => {
                    unchanged(&self.revisions, id)
                        && !jobs
                            .iter()
                            .any(|job| &job.recording_id == *id && &job.job_id == job_id)
                }
                _ => false,
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            self.downloads.remove(&id);
        }
        for job in jobs {
            if unchanged(&self.revisions, &job.recording_id) {
                reduce_cloud_download(&mut self.downloads, job);
            }
        }
        true
    }
}

// ── The requests ─────────────────────────────────────────────────────────

/// `cloud.recordings.list`, newest first.
pub async fn list_cloud_recordings(
    backend: &impl LibraryBackend,
) -> Result<Vec<CloudRecordingItem>, RpcError> {
    let answer = backend
        .library_request("cloud.recordings.list", Value::Null)
        .await?;
    let list: CloudRecordingsList = serde_json::from_value(answer).map_err(|error| {
        RpcError::new("cloud.recordings.list", "invalid_result", error.to_string())
    })?;
    Ok(sort_cloud_recordings(&list.recordings))
}

/// `cloud.recordings.downloads` → the store: run on attach, on
/// `backend.ready`, on `events.lagged`, and after a Cancel. A failure waits
/// for the next of those.
pub async fn reconcile_cloud_downloads(
    backend: &impl LibraryBackend,
    store: &Mutex<CloudDownloadsStore>,
) -> bool {
    let ticket = store.lock().expect("cloud downloads").begin_reconcile();
    let Ok(answer) = backend
        .library_request("cloud.recordings.downloads", Value::Null)
        .await
    else {
        return false;
    };
    let Ok(jobs) = serde_json::from_value::<Vec<CloudRecordingDownloadEvent>>(answer) else {
        return false;
    };
    store
        .lock()
        .expect("cloud downloads")
        .finish_reconcile(ticket, &jobs)
}

/// Why a Download did not start, for the toast (`cloud-download:{id}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudDownloadRefusal {
    pub recording_id: String,
    /// The backend's own sentence, or `None` for the generic next step
    /// under [`DOWNLOAD_CONTEXT`].
    pub known: Option<String>,
    pub raw: String,
}

/// `startCloudDownload`: the job starts at once and its events move the
/// row. A second press for the same recording answers the running job (the
/// backend's rule). `output_directory_capability` is Output's folder as the
/// desktop layer issued it; without it the backend saves to the default
/// folder.
pub async fn start_cloud_download(
    backend: &impl LibraryBackend,
    store: &Mutex<CloudDownloadsStore>,
    recording_id: &str,
    output_directory_capability: Option<&str>,
) -> Result<(), CloudDownloadRefusal> {
    store
        .lock()
        .expect("cloud downloads")
        .begin_start(recording_id);
    let mut params = json!({ "id": recording_id });
    if let Some(capability) = output_directory_capability.filter(|c| !c.is_empty()) {
        params["outputDirectoryCapability"] = json!(capability);
    }
    let answer = backend
        .library_request("cloud.recordings.download", params)
        .await;
    let job_id = answer.as_ref().ok().and_then(|answer| {
        answer
            .get("jobId")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    match job_id {
        Some(job_id) => {
            store
                .lock()
                .expect("cloud downloads")
                .started(recording_id, &job_id);
            Ok(())
        }
        None => {
            store
                .lock()
                .expect("cloud downloads")
                .start_failed(recording_id);
            let raw = match answer {
                Err(error) => error.message,
                Ok(other) => format!("unexpected answer: {other}"),
            };
            Err(CloudDownloadRefusal {
                recording_id: recording_id.to_string(),
                known: known_cloud_download_refusal(Some(&raw)),
                raw,
            })
        }
    }
}

/// `cancelCloudDownload`: the job's `cancelled` event takes the row back to
/// Download; the store is read again after.
pub async fn cancel_cloud_download(
    backend: &impl LibraryBackend,
    store: &Mutex<CloudDownloadsStore>,
    job_id: &str,
) -> Result<(), RpcError> {
    backend
        .library_request(
            "cloud.recordings.cancelDownload",
            json!({ "jobId": job_id }),
        )
        .await?;
    reconcile_cloud_downloads(backend, store).await;
    Ok(())
}

// ── The tab (`LibraryCloudRecordings`) ──────────────────────────────────

/// `LoadState`: the list's own read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CloudLoad {
    #[default]
    Idle,
    Loading,
    /// A failed read the streamer asked for, in words.
    Failed(String),
}

/// The Cloud tab's state while it is open: the list, its read, the stop it
/// waits for, and the row with the list's one Tab stop.
#[derive(Debug, Clone, Default)]
pub struct CloudTab {
    /// `None` until the first answer.
    pub recordings: Option<Vec<CloudRecordingItem>>,
    pub load: CloudLoad,
    pub active: Option<String>,
    /// The stop the list was last told about, and the ids it listed then: a
    /// take from a minute before, listed already, is not the stopped take.
    stop: Option<CloudRecordingStop>,
    listed_at_stop: Option<BTreeSet<String>>,
}

impl CloudTab {
    /// A read starts; a quiet one (the poll after Stop) keeps the screen.
    pub fn begin_refresh(&mut self, quiet: bool) {
        if !quiet {
            self.load = CloudLoad::Loading;
        }
    }

    /// `cloud.recordings.list` answered: newest first.
    pub fn refreshed(&mut self, recordings: &[CloudRecordingItem]) {
        self.recordings = Some(sort_cloud_recordings(recordings));
        self.load = CloudLoad::Idle;
    }

    /// The read failed. A quiet poll keeps the list it has (the next one
    /// tries again); a read the streamer asked for says why.
    pub fn refresh_failed(&mut self, quiet: bool, text: &str) {
        if !quiet {
            self.load = CloudLoad::Failed(text.to_string());
        }
    }

    /// The last stop the window watched (`lastCloudRecordingStop`). A new
    /// one remembers what the list showed when it came; a stop from before
    /// the tab opened has nothing, so any take then counts.
    pub fn note_stop(&mut self, stop: Option<CloudRecordingStop>) {
        if stop == self.stop {
            return;
        }
        self.stop = stop;
        self.listed_at_stop = self.recordings.as_ref().map(|recordings| {
            recordings
                .iter()
                .map(|recording| recording.id.clone())
                .collect()
        });
    }

    /// The take that stopped is not listed yet: a Processing row shows, and
    /// the list is read again every [`CLOUD_RECORDING_POLL_MS`].
    pub fn processing(&self, now_ms: i64) -> bool {
        awaiting_cloud_recording(
            self.stop,
            self.recordings.as_deref(),
            now_ms,
            self.listed_at_stop.as_ref(),
        )
    }

    /// Whether to read the list again quietly now (the poll after Stop).
    pub fn should_poll(&self, signed_in: bool, online: bool, now_ms: i64) -> bool {
        signed_in && online && self.processing(now_ms)
    }

    /// ↑/↓, Home and End between rows, as in the Local tab.
    pub fn move_active(&mut self, key: &str) -> Option<String> {
        let ids: Vec<String> = self
            .recordings
            .iter()
            .flatten()
            .map(|recording| recording.id.clone())
            .collect();
        if ids.is_empty() {
            return None;
        }
        let current = self
            .active
            .as_deref()
            .and_then(|active| ids.iter().position(|id| id == active))
            .unwrap_or(0);
        let next = match key {
            "ArrowDown" => (current + 1).min(ids.len() - 1),
            "ArrowUp" => current.saturating_sub(1),
            "Home" => 0,
            "End" => ids.len() - 1,
            _ => return None,
        };
        self.active = Some(ids[next].clone());
        self.active.clone()
    }
}

/// What the tab shows below its header, one state at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudBody {
    /// Signed out: the lock with Sign in.
    SignIn,
    /// The read failed: the line and Try again.
    Failed(String),
    /// Online with no answer yet.
    Loading,
    /// Offline before the first answer: nothing under the offline alert.
    Nothing,
    Empty,
    /// The table: a Processing row first while the take is saved.
    Rows {
        processing: bool,
    },
}

/// The tab as one value.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudTabView {
    /// Signed in: the header's Refresh (and the markers button for the open
    /// show).
    pub header_actions: bool,
    pub refresh_label: &'static str,
    pub refresh_enabled: bool,
    pub markers_show: Option<String>,
    /// Signed in and offline.
    pub offline_alert: bool,
    pub body: CloudBody,
    pub rows: Vec<(CloudRecordingItem, CloudRowView)>,
    pub active: Option<String>,
    pub footer: Option<String>,
    /// The local program archive, under the list while signed in.
    pub archive: bool,
}

/// `LibraryCloudRecordings`, rendered as a value.
pub fn cloud_tab_view(
    tab: &CloudTab,
    downloads: &CloudDownloads,
    signed_in: bool,
    online: bool,
    current_show_id: Option<&str>,
    now_ms: i64,
) -> CloudTabView {
    let busy = tab.load == CloudLoad::Loading;
    let processing = tab.processing(now_ms);
    let body = if !signed_in {
        CloudBody::SignIn
    } else if let CloudLoad::Failed(text) = &tab.load {
        CloudBody::Failed(text.clone())
    } else {
        match &tab.recordings {
            None if online => CloudBody::Loading,
            None => CloudBody::Nothing,
            Some(rows) if rows.is_empty() && !processing => CloudBody::Empty,
            Some(_) => CloudBody::Rows { processing },
        }
    };
    let listed = matches!(body, CloudBody::Rows { .. });
    let recordings: &[CloudRecordingItem] = match (&tab.recordings, listed) {
        (Some(rows), true) => rows,
        _ => &[],
    };
    CloudTabView {
        header_actions: signed_in,
        refresh_label: if busy { REFRESHING } else { REFRESH },
        refresh_enabled: online && !busy,
        markers_show: current_show_id.filter(|_| signed_in).map(str::to_string),
        offline_alert: signed_in && !online,
        rows: recordings
            .iter()
            .map(|recording| {
                let view = cloud_row_view(recording, downloads.get(&recording.id), now_ms);
                (recording.clone(), view)
            })
            .collect(),
        active: active_cloud_row(recordings, tab.active.as_deref()).map(str::to_string),
        footer: listed.then(|| cloud_footer(recordings)),
        archive: signed_in,
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn ms(stamp: &str) -> i64 {
        parse_ms(stamp).unwrap()
    }

    fn item(id: &str) -> CloudRecordingItem {
        CloudRecordingItem {
            id: id.into(),
            show_id: "show_1".into(),
            orientation: "h".into(),
            started_at: "2026-11-14T12:04:00Z".into(),
            expires_at: "2026-12-14T12:04:00Z".into(),
            seconds: 754.0,
            bytes: 1_000_000.0,
            ..CloudRecordingItem::default()
        }
    }

    fn with(id: &str, edit: impl FnOnce(&mut CloudRecordingItem)) -> CloudRecordingItem {
        let mut recording = item(id);
        edit(&mut recording);
        recording
    }

    fn segments(id: &str) -> CloudRecordingItem {
        with(id, |r| r.format = Some("segments".into()))
    }

    fn event(state: DownloadEventState) -> CloudRecordingDownloadEvent {
        CloudRecordingDownloadEvent {
            local_session_id: None,
            job_id: "job_1".into(),
            recording_id: "rec_1".into(),
            state,
            done_segments: None,
            total_segments: None,
            path: None,
            error: None,
        }
    }

    fn running(job: &str, done: Option<u64>, total: Option<u64>) -> CloudDownloadView {
        CloudDownloadView::Running {
            job_id: job.into(),
            done,
            total,
        }
    }

    // `cloud-recordings-view.test.ts`, case for case.

    #[test]
    fn the_newest_take_first_an_unreadable_time_last() {
        let sorted = sort_cloud_recordings(&[
            with("old", |r| r.started_at = "2026-11-01T10:00:00Z".into()),
            with("bad", |r| r.started_at = "not a time".into()),
            with("new", |r| r.started_at = "2026-11-14T10:00:00Z".into()),
        ]);
        let ids: Vec<_> = sorted.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["new", "old", "bad"]);
    }

    #[test]
    fn only_a_segments_recording_downloads_here_and_orientation_in_words() {
        assert!(downloads_on_this_computer(&segments("a")));
        assert!(!downloads_on_this_computer(
            &with("b", |r| r.format = Some("mp4".into()))
        ));
        assert!(!downloads_on_this_computer(&item("c")));
        assert_eq!(cloud_orientation_label("h"), "Horizontal");
        assert_eq!(cloud_orientation_label("v"), "Vertical");
    }

    #[test]
    fn a_download_follows_its_events_by_recording_id() {
        let mut downloads = CloudDownloads::from([("rec_1".into(), CloudDownloadView::Starting)]);
        let mut progress = event(DownloadEventState::Running);
        progress.done_segments = Some(3);
        progress.total_segments = Some(12);
        reduce_cloud_download(&mut downloads, &progress);
        assert_eq!(downloads["rec_1"], running("job_1", Some(3), Some(12)));
        assert_eq!(cloud_download_percent(&downloads["rec_1"]), Some(25));
        let mut done = event(DownloadEventState::Done);
        done.path = Some("/videos/a.mp4".into());
        reduce_cloud_download(&mut downloads, &done);
        assert_eq!(
            downloads["rec_1"],
            CloudDownloadView::Done {
                job_id: "job_1".into(),
                local_session_id: None
            }
        );
        let mut failed = event(DownloadEventState::Failed);
        failed.error = Some("x".into());
        reduce_cloud_download(&mut downloads, &failed);
        assert_eq!(
            downloads["rec_1"],
            CloudDownloadView::Failed {
                job_id: Some("job_1".into())
            }
        );
        reduce_cloud_download(&mut downloads, &event(DownloadEventState::Cancelled));
        assert!(!downloads.contains_key("rec_1"));
    }

    #[test]
    fn no_percent_before_the_total_is_known() {
        assert_eq!(cloud_download_percent(&running("j", Some(0), None)), None);
        assert_eq!(
            cloud_download_percent(&running("j", Some(9), Some(4))),
            Some(100)
        );
    }

    #[test]
    fn the_backends_own_sentences_and_nothing_else() {
        assert_eq!(
            known_cloud_download_refusal(Some("Recording segment 7 could not be downloaded."))
                .as_deref(),
            Some("Part of the recording didn't download. Try again.")
        );
        assert_eq!(
            known_cloud_download_refusal(Some("There isn't enough space to save the recording."))
                .as_deref(),
            Some("There isn't enough space to save the recording.")
        );
        assert_eq!(
            known_cloud_download_refusal(Some("  Videorc can't save to /Volumes/Show Drive.  "))
                .as_deref(),
            Some("Videorc can't save to /Volumes/Show Drive.")
        );
        assert_eq!(
            known_cloud_download_refusal(Some(
                "FFmpeg could not make the MP4: (address withheld) 403"
            )),
            None
        );
        assert_eq!(
            known_cloud_download_refusal(Some("Videorc can't save to .")),
            None
        );
        assert_eq!(
            known_cloud_download_refusal(Some("Recording segment x could not be downloaded.")),
            None
        );
        assert_eq!(known_cloud_download_refusal(None), None);
    }

    /// Every sentence the backend can refuse a download with is one the
    /// view knows (`cloud_control_web.rs`'s `refusal`/`bail!` copy).
    #[test]
    fn the_known_refusals_are_still_the_renderers() {
        let view =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/cloud-recordings-view.ts");
        let start = view.find("const KNOWN_DOWNLOAD_REFUSALS = [").unwrap();
        let block = &view[start..start + view[start..].find("\n]").unwrap()];
        let patterns = block
            .lines()
            .filter(|line| line.trim().starts_with("/^"))
            .count();
        // 11 patterns; two of them alternate (see/download, supported/no
        // segments), which this module spells out as 12 sentences plus the
        // folder one.
        assert_eq!(patterns, 11, "the refusal list changed: port it");
    }

    #[test]
    fn a_stop_is_remembered_with_when_it_started() {
        let since = ms("2026-11-14T12:00:00Z");
        let stopped_at = since + 600_000;
        let mut watch = CloudRecordingWatch::default();
        assert!(!watch.note(false, None, since - 1000));
        assert_eq!(watch.last_stop(), None);
        assert!(!watch.note(true, Some("2026-11-14T12:00:00Z"), since + 5000));
        assert!(!watch.note(true, Some("2026-11-14T12:00:00Z"), since + 9000));
        assert!(watch.note(false, None, stopped_at));
        let stop = CloudRecordingStop {
            since_ms: since,
            stopped_at_ms: stopped_at,
        };
        assert_eq!(watch.last_stop(), Some(stop));
        assert!(!watch.note(false, None, stopped_at + 1000));

        let mut watch = CloudRecordingWatch::default();
        watch.note(true, None, since);
        watch.note(true, None, since + 4000);
        watch.note(false, None, stopped_at);
        assert_eq!(watch.last_stop(), Some(stop));
    }

    #[test]
    fn the_list_waits_for_the_take_for_up_to_two_minutes() {
        let since = ms("2026-11-14T12:00:00Z");
        let stopped_at = since + 600_000;
        let stop = Some(CloudRecordingStop {
            since_ms: since,
            stopped_at_ms: stopped_at,
        });
        let older = with("older", |r| r.started_at = "2026-11-13T12:00:00Z".into());
        let take = with("take", |r| r.started_at = "2026-11-14T12:00:02Z".into());
        assert!(!awaiting_cloud_recording(None, Some(&[]), stopped_at, None));
        assert!(awaiting_cloud_recording(
            stop,
            None,
            stopped_at + 1000,
            None
        ));
        let only_older = [older.clone()];
        assert!(awaiting_cloud_recording(
            stop,
            Some(&only_older),
            stopped_at + 5000,
            None
        ));
        let both = [older, take.clone()];
        assert!(!awaiting_cloud_recording(
            stop,
            Some(&both),
            stopped_at + 10_000,
            None
        ));
        assert!(!awaiting_cloud_recording(
            stop,
            Some(&only_older),
            stopped_at + CLOUD_RECORDING_POLL_WINDOW_MS,
            None
        ));

        // Two takes inside the clock allowance: the first one's row, listed
        // when the second stopped, is not the second take's row.
        let earlier = with("earlier", |r| r.started_at = "2026-11-14T11:59:30Z".into());
        let listed = BTreeSet::from(["earlier".to_string()]);
        let just_earlier = [earlier.clone()];
        assert!(awaiting_cloud_recording(
            stop,
            Some(&just_earlier),
            stopped_at + 5000,
            Some(&listed)
        ));
        let with_take = [earlier, take];
        assert!(!awaiting_cloud_recording(
            stop,
            Some(&with_take),
            stopped_at + 10_000,
            Some(&listed)
        ));
        // Without a list from the stop (the Library opened later), any take
        // in the window counts.
        assert!(!awaiting_cloud_recording(
            stop,
            Some(&just_earlier),
            stopped_at + 5000,
            None
        ));
    }

    #[test]
    fn s20_unknown_history_record_only_intervals_and_expiry() {
        let old = with("old", |r| r.live_interval_ids = Some(vec![]));
        assert_eq!(cloud_take_label(&old), "Cloud take");
        let solo = with("solo", |r| {
            r.association_known = true;
            r.live_interval_ids = Some(vec![]);
        });
        assert_eq!(cloud_take_label(&solo), "Record-only take");
        let two = with("two", |r| {
            r.association_known = true;
            r.live_interval_ids = Some(vec!["A".into(), "B".into()]);
        });
        assert_eq!(cloud_take_label(&two), "Take · 2 live intervals");
        let one = with("one", |r| {
            r.association_known = true;
            r.live_interval_ids = Some(vec!["A".into()]);
        });
        assert_eq!(cloud_take_label(&one), "Take · 1 live interval");
        assert_eq!(
            cloud_recording_availability(&item("old"), ms("2027-01-01T00:00:00Z")),
            CloudAvailability::Expired
        );
        let missing = with("missing", |r| r.availability = Some("missing".into()));
        assert_eq!(
            cloud_recording_availability(&missing, ms("2026-11-19T00:00:00Z")),
            CloudAvailability::Missing
        );
        let mut downloads = CloudDownloads::new();
        let mut done = event(DownloadEventState::Done);
        done.recording_id = "rec".into();
        done.job_id = "job".into();
        done.local_session_id = Some("local".into());
        reduce_cloud_download(&mut downloads, &done);
        assert_eq!(
            downloads["rec"],
            CloudDownloadView::Done {
                job_id: "job".into(),
                local_session_id: Some("local".into())
            }
        );
    }

    #[test]
    fn a_managed_one_downloads_here_a_node_one_on_videorc_com() {
        let now = ms("2026-11-19T12:00:00Z");
        let kept = ms("2026-12-14T12:04:00Z");
        assert_eq!(
            cloud_row_view(&segments("a"), None, now),
            CloudRowView {
                status: CloudRowStatus::InCloud,
                status_label: "In the cloud".into(),
                status_detail: None,
                kept_until_ms: Some(kept),
                action: Some(CloudRowAction::Download),
            }
        );
        let node = cloud_row_view(&with("b", |r| r.format = Some("mp4".into())), None, now);
        assert_eq!(node.status, CloudRowStatus::OnWeb);
        assert_eq!(node.status_label, "On videorc.com");
        assert_eq!(node.kept_until_ms, Some(kept));
        assert_eq!(node.action, Some(CloudRowAction::OpenWeb));
    }

    #[test]
    fn a_download_says_starting_a_percent_cancel_then_try_again() {
        let now = ms("2026-11-19T12:00:00Z");
        let managed = segments("a");
        let starting = cloud_row_view(&managed, Some(&CloudDownloadView::Starting), now);
        assert_eq!(
            (starting.status_label.as_str(), starting.action),
            ("Starting…", None)
        );
        let quarter = cloud_row_view(&managed, Some(&running("job_1", Some(1), Some(4))), now);
        assert_eq!(
            quarter.status,
            CloudRowStatus::Downloading {
                job_id: "job_1".into(),
                percent: Some(25)
            }
        );
        assert_eq!(quarter.status_label, "Downloading 25%");
        assert_eq!(quarter.action, Some(CloudRowAction::Cancel));
        let unknown = cloud_row_view(&managed, Some(&running("job_1", None, None)), now);
        assert_eq!(unknown.status_label, "Downloading…");
        let failed = cloud_row_view(
            &managed,
            Some(&CloudDownloadView::Failed {
                job_id: Some("job_1".into()),
            }),
            now,
        );
        assert_eq!(failed.status_label, "Download failed");
        assert_eq!(failed.action, Some(CloudRowAction::Retry));
    }

    #[test]
    fn a_copy_on_this_computer_wins_even_when_the_cloud_copy_is_gone() {
        let now = ms("2026-11-19T12:00:00Z");
        let local = with("a", |r| {
            r.local_session_id = Some("sess_1".into());
            r.availability = Some("expired".into());
        });
        let view = cloud_row_view(&local, None, now);
        assert_eq!(
            view.status,
            CloudRowStatus::Downloaded {
                local_session_id: Some("sess_1".into()),
                job_id: None
            }
        );
        assert_eq!(view.status_label, "Downloaded");
        assert_eq!(view.action, Some(CloudRowAction::OpenLocal));
        let done = CloudDownloadView::Done {
            job_id: "job_2".into(),
            local_session_id: Some("sess_2".into()),
        };
        let view = cloud_row_view(&segments("b"), Some(&done), now);
        assert_eq!(
            view.status,
            CloudRowStatus::Downloaded {
                local_session_id: Some("sess_2".into()),
                job_id: Some("job_2".into())
            }
        );
        assert_eq!(view.action, Some(CloudRowAction::OpenLocal));
        // A finished download the Library hasn't listed yet shows its file.
        let done = CloudDownloadView::Done {
            job_id: "job_3".into(),
            local_session_id: None,
        };
        let view = cloud_row_view(&segments("c"), Some(&done), now);
        assert_eq!(
            view.status,
            CloudRowStatus::Downloaded {
                local_session_id: None,
                job_id: Some("job_3".into())
            }
        );
        assert_eq!(view.action, Some(CloudRowAction::Reveal));
    }

    #[test]
    fn a_gone_cloud_copy_says_so_with_no_action_and_no_date() {
        let now = ms("2026-11-19T12:00:00Z");
        let expired = with("a", |r| {
            r.format = Some("segments".into());
            r.expires_at = "2026-11-01T00:00:00Z".into();
        });
        assert_eq!(
            cloud_row_view(&expired, None, now),
            CloudRowView {
                status: CloudRowStatus::Expired,
                status_label: "Expired".into(),
                status_detail: Some("The cloud copy was deleted on the date it was kept until."),
                kept_until_ms: None,
                action: None,
            }
        );
        let missing = cloud_row_view(
            &with("b", |r| r.availability = Some("missing".into())),
            None,
            now,
        );
        assert_eq!(missing.status_label, "File missing");
        assert_eq!(missing.kept_until_ms, None);
        assert_eq!(missing.action, None);
    }

    // `library-cloud-recordings.tsx`'s row.

    #[test]
    fn the_row_menu_opens_then_downloads_then_shows_markers() {
        let now = ms("2026-11-19T12:00:00Z");
        let ids = |view: &CloudRowView, offline| {
            cloud_row_menu(view, offline)
                .into_iter()
                .map(|item| (item.id, item.label, item.disabled))
                .collect::<Vec<_>>()
        };
        let ready = cloud_row_view(&segments("a"), None, now);
        assert_eq!(
            ids(&ready, true),
            [
                ("open-web", OPEN_ON_WEB, false),
                ("download", DOWNLOAD_TO_LIBRARY, true),
                ("markers", SHOW_MARKERS, true),
            ]
        );
        let failed = cloud_row_view(
            &segments("a"),
            Some(&CloudDownloadView::Failed { job_id: None }),
            now,
        );
        assert_eq!(ids(&failed, false)[1].1, TRY_DOWNLOAD_AGAIN);
        let going = cloud_row_view(&segments("a"), Some(&running("j", None, None)), now);
        assert_eq!(
            ids(&going, false)[1],
            ("cancel-download", CANCEL_DOWNLOAD, false)
        );
        let both = cloud_row_view(
            &segments("a"),
            Some(&CloudDownloadView::Done {
                job_id: "j".into(),
                local_session_id: Some("s".into()),
            }),
            now,
        );
        let menu = cloud_row_menu(&both, false);
        let first: Vec<_> = menu.iter().map(|item| item.id).collect();
        assert_eq!(first, ["open-local", "reveal", "open-web", "markers"]);
        assert_eq!(CloudRowAction::Cancel.aria_label(), CANCEL_DOWNLOAD);
        assert_eq!(CloudRowAction::Download.tooltip(), DOWNLOAD_TO_LIBRARY);
        assert_eq!(CloudRowAction::Retry.label(), TRY_AGAIN);
    }

    #[test]
    fn the_footer_the_detail_line_and_the_roving_row() {
        let rows = [item("a"), with("b", |r| r.bytes = 2_000_000.0)];
        assert_eq!(cloud_footer(&rows), "2 cloud recordings · 2.9 MB");
        assert_eq!(cloud_footer(&rows[..1]), "1 cloud recording · 977 KB");
        let now = Utc.with_ymd_and_hms(2026, 11, 19, 12, 0, 0).unwrap();
        let view = cloud_row_view(&rows[0], None, now.timestamp_millis());
        let detail = cloud_row_detail(&rows[0], &view, now);
        assert!(detail.starts_with("Nov 1"), "{detail}");
        assert!(detail.contains(" · Kept until Dec 1"), "{detail}");
        assert_eq!(active_cloud_row(&rows, Some("b")), Some("b"));
        assert_eq!(active_cloud_row(&rows, Some("gone")), Some("a"));
        assert_eq!(active_cloud_row(&[], None), None);
        assert_eq!(LibraryView::default(), LibraryView::Local);
        assert_eq!(LibraryView::Cloud.label(), "Cloud");
    }

    // `cloud-recording-downloads.ts`.

    #[test]
    fn the_store_tells_a_failure_always_and_a_save_only_out_of_view() {
        let mut store = CloudDownloadsStore::default();
        let mut failed = event(DownloadEventState::Failed);
        failed.error = Some("Recording segment 3 could not be downloaded.".into());
        assert_eq!(
            store.apply(&failed),
            Some(CloudDownloadNotice::Failed {
                recording_id: "rec_1".into(),
                known: Some(SEGMENT_FAILED_TEXT.into()),
                raw: "Recording segment 3 could not be downloaded.".into(),
            })
        );
        store.hold_view();
        assert_eq!(store.apply(&event(DownloadEventState::Done)), None);
        store.release_view();
        assert_eq!(
            store.apply(&event(DownloadEventState::Done)),
            Some(CloudDownloadNotice::Saved {
                recording_id: "rec_1".into(),
                job_id: "job_1".into()
            })
        );
        assert_eq!(store.apply(&event(DownloadEventState::Running)), None);
    }

    #[test]
    fn a_start_runs_unless_an_event_came_first() {
        let mut store = CloudDownloadsStore::default();
        store.begin_start("rec_1");
        assert_eq!(store.get("rec_1"), Some(&CloudDownloadView::Starting));
        store.started("rec_1", "job_1");
        assert_eq!(store.get("rec_1"), Some(&running("job_1", None, None)));

        store.begin_start("rec_2");
        let mut done = event(DownloadEventState::Done);
        done.recording_id = "rec_2".into();
        store.apply(&done);
        store.started("rec_2", "job_1");
        assert!(matches!(
            store.get("rec_2"),
            Some(CloudDownloadView::Done { .. })
        ));
        store.start_failed("rec_3");
        assert_eq!(
            store.get("rec_3"),
            Some(&CloudDownloadView::Failed { job_id: None })
        );
    }

    #[test]
    fn a_snapshot_drops_finished_jobs_but_not_newer_events() {
        let mut store = CloudDownloadsStore::default();
        for (recording, job) in [("a", "ja"), ("b", "jb"), ("c", "jc")] {
            let mut run = event(DownloadEventState::Running);
            run.recording_id = recording.into();
            run.job_id = job.into();
            store.apply(&run);
        }
        let ticket = store.begin_reconcile();
        // While the snapshot is asked for, `b` moves on its own.
        let mut b = event(DownloadEventState::Running);
        b.recording_id = "b".into();
        b.job_id = "jb".into();
        b.done_segments = Some(5);
        b.total_segments = Some(10);
        store.apply(&b);
        // The backend runs only `c`, and reports `d`'s new job.
        let mut c = event(DownloadEventState::Running);
        c.recording_id = "c".into();
        c.job_id = "jc".into();
        c.done_segments = Some(1);
        c.total_segments = Some(2);
        let mut d = event(DownloadEventState::Running);
        d.recording_id = "d".into();
        d.job_id = "jd".into();
        assert!(store.finish_reconcile(ticket, &[c, d]));
        assert_eq!(store.get("a"), None, "a's job is gone");
        assert_eq!(store.get("b"), Some(&running("jb", Some(5), Some(10))));
        assert_eq!(store.get("c"), Some(&running("jc", Some(1), Some(2))));
        assert_eq!(store.get("d"), Some(&running("jd", None, None)));

        // A stale snapshot changes nothing.
        let old = store.begin_reconcile();
        let _new = store.begin_reconcile();
        assert!(!store.finish_reconcile(old, &[]));
        assert!(store.get("c").is_some());
    }

    #[test]
    fn the_wire_reads_as_the_backend_writes_it() {
        let list: CloudRecordingsList = serde_json::from_value(json!({
            "recordings": [{
                "id": "rec_1", "showId": "show_1", "takeId": "", "associationKnown": true,
                "liveIntervalIds": ["A"], "orientation": "v",
                "startedAt": "2026-11-14T12:04:00Z", "expiresAt": "2026-12-14T12:04:00Z",
                "seconds": 754.5, "bytes": 1000000, "format": "segments"
            }, { "id": "rec_2" }]
        }))
        .unwrap();
        assert_eq!(list.recordings.len(), 2);
        assert_eq!(
            cloud_take_label(&list.recordings[0]),
            "Take · 1 live interval"
        );
        assert_eq!(cloud_take_label(&list.recordings[1]), "Cloud take");
        let event: CloudRecordingDownloadEvent = serde_json::from_value(json!({
            "jobId": "j", "recordingId": "r", "state": "cancelled"
        }))
        .unwrap();
        assert_eq!(event.state, DownloadEventState::Cancelled);
    }

    /// The tab's words are still Electron's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let sources = [
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.tsx"
            ),
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/tabs/library-tab.tsx"
            ),
            include_str!("../../../../apps/desktop/src/renderer/src/lib/cloud-recordings-view.ts"),
            include_str!(
                "../../../../apps/desktop/src/renderer/src/lib/cloud-recording-downloads.ts"
            ),
        ];
        let this = include_str!("cloud.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = super::super::copy::tests::unseen_constants(this, &sources);
        assert!(
            checked > 30,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
    }

    #[test]
    fn the_tab_reads_waits_for_the_take_and_says_each_state() {
        let now = ms("2026-11-24T12:00:00Z");
        let mut tab = CloudTab::default();
        let none = CloudDownloads::new();
        let view = |tab: &CloudTab, signed_in, online| {
            cloud_tab_view(tab, &none, signed_in, online, Some("show_1"), now)
        };
        assert_eq!(view(&tab, false, true).body, CloudBody::SignIn);
        assert!(!view(&tab, false, true).archive);
        assert_eq!(view(&tab, false, true).markers_show, None);
        assert_eq!(view(&tab, true, true).body, CloudBody::Loading);
        assert_eq!(view(&tab, true, false).body, CloudBody::Nothing);
        assert!(view(&tab, true, false).offline_alert);

        tab.begin_refresh(false);
        let loading = view(&tab, true, true);
        assert_eq!(
            (loading.refresh_label, loading.refresh_enabled),
            (REFRESHING, false)
        );
        tab.refresh_failed(false, "Couldn't load your cloud recordings.");
        assert_eq!(
            view(&tab, true, true).body,
            CloudBody::Failed("Couldn't load your cloud recordings.".into())
        );
        tab.refreshed(&[]);
        assert_eq!(view(&tab, true, true).body, CloudBody::Empty);

        // A take stops while the tab shows an earlier one.
        let earlier = with("earlier", |r| r.started_at = "2026-11-24T11:59:30Z".into());
        tab.refreshed(std::slice::from_ref(&earlier));
        tab.note_stop(Some(CloudRecordingStop {
            since_ms: ms("2026-11-24T11:59:50Z"),
            stopped_at_ms: now - 1_000,
        }));
        assert!(tab.processing(now));
        assert!(tab.should_poll(true, true, now));
        assert!(!tab.should_poll(true, false, now));
        let waiting = view(&tab, true, true);
        assert_eq!(waiting.body, CloudBody::Rows { processing: true });
        assert_eq!(
            waiting.footer.as_deref(),
            Some("1 cloud recording · 977 KB")
        );
        // A quiet poll that fails keeps the list.
        tab.begin_refresh(true);
        tab.refresh_failed(true, "x");
        assert_eq!(tab.load, CloudLoad::Idle);
        let take = with("take", |r| r.started_at = "2026-11-24T12:00:00Z".into());
        tab.refreshed(&[earlier, take]);
        assert!(!tab.processing(now));
        let listed = view(&tab, true, true);
        assert_eq!(listed.body, CloudBody::Rows { processing: false });
        assert_eq!(listed.rows[0].0.id, "take");
        assert_eq!(listed.active.as_deref(), Some("take"));
        assert_eq!(listed.markers_show.as_deref(), Some("show_1"));

        assert_eq!(tab.move_active("ArrowDown").as_deref(), Some("earlier"));
        assert_eq!(tab.move_active("ArrowDown").as_deref(), Some("earlier"));
        assert_eq!(tab.move_active("Home").as_deref(), Some("take"));
        assert_eq!(tab.move_active("x"), None);
    }
}
