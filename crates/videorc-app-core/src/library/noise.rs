//! Noise cleanup in the Library (plan 260 S1.6f, from Electron's
//! `lib/noise-cleanup-view.ts` and `noise-cleanup-jobs.ts`): a Premium
//! action on a finished local recording that makes a cleaned copy, and the
//! job's state in the row.
//!
//! The Premium gate is the entitlements' (`noiseCleanupGate`, L7's
//! account module): the page passes its answer in as
//! [`NoiseCleanupInput::premium_locked`], the reason when locked
//! ("Noise cleanup is part of Videorc Premium.") and `None` when allowed.

use std::collections::BTreeSet;

use serde_json::{Value, json};
use videorc_protocol::{NoiseCleanupJob, NoiseCleanupJobStatus, SessionListItem};

use super::LibraryBackend;
use crate::client::RpcError;

pub const REDUCE_NOISE: &str = "Reduce noise";
pub const REDUCE_NOISE_PREMIUM: &str = "Reduce noise · Premium";
pub const RETRY_CLEANUP: &str = "Retry cleanup";
pub const OPEN_CLEANED_COPY: &str = "Open cleaned copy";
pub const SHOW_SOURCE_RECORDING: &str = "Show source recording";
pub const CANCEL_CLEANUP: &str = "Cancel cleanup";
pub const QUEUED: &str = "Queued…";
pub const VALIDATING: &str = "Validating…";
pub const SOURCE_GONE: &str = "The source recording is no longer in Library.";
pub const QUEUED_DETAIL: &str =
    "Noise cleanup is queued and will start when media processing is available.";
pub const QUEUED_STATUS: &str = "Noise cleanup queued.";
pub const VALIDATING_DETAIL: &str = "Validating the cleaned copy before it appears in Library.";
pub const VALIDATING_STATUS: &str = "Validating cleaned copy.";
pub const COMPLETED_DETAIL: &str =
    "Noise cleanup completed. The original recording wasn't changed.";
pub const COMPLETED_STATUS: &str = "Noise cleanup completed.";
pub const CAPTURE_REASON: &str = "Available when the recording or livestream ends.";
pub const IMPORTED_REASON: &str = "Noise cleanup doesn't work on imported recordings yet.";
pub const MISSING_REASON: &str = "The local recording file is missing.";
pub const UNFINISHED_REASON: &str = "Noise cleanup needs a finished recording.";
pub const RETRY_DETAIL: &str = "The previous cleanup didn't finish.";
pub const RECONNECTING_REASON: &str = "Videorc is reconnecting. Try again in a moment.";

/// `NoiseCleanupAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseCleanupAction {
    Upgrade,
    Start,
    Cancel,
    OpenOutput,
    ShowSource,
}

/// `NoiseCleanupView`: the row's cleanup control.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NoiseCleanupView {
    pub direct_action: Option<NoiseCleanupAction>,
    pub menu_action: Option<NoiseCleanupAction>,
    pub direct_label: Option<String>,
    pub menu_label: Option<String>,
    pub disabled_reason: Option<&'static str>,
    pub detail: Option<String>,
    pub status_announcement: Option<String>,
    pub busy: bool,
    /// Rename, delete and the other file actions wait for it.
    pub conflicts_with_file_actions: bool,
    pub premium_locked: bool,
    /// A managed copy (cleaned, or a Clean cut copy): never cleaned again.
    pub derivative: bool,
}

/// `NoiseCleanupViewInput`.
#[derive(Debug, Clone, Copy)]
pub struct NoiseCleanupInput<'a> {
    pub session: &'a SessionListItem,
    /// The Premium gate's reason when it is closed.
    pub premium_locked: Option<&'a str>,
    pub job: Option<&'a NoiseCleanupJob>,
    /// A capture runs (the default ring excluded).
    pub capture_active: bool,
}

fn some(text: &str) -> Option<String> {
    Some(text.to_string())
}

/// A disabled "Reduce noise" with its reason.
fn disabled(reason: &'static str) -> NoiseCleanupView {
    NoiseCleanupView {
        direct_label: some(REDUCE_NOISE),
        menu_label: some(REDUCE_NOISE),
        disabled_reason: Some(reason),
        ..NoiseCleanupView::default()
    }
}

fn cancellable(direct: String, menu: String, detail: String, status: String) -> NoiseCleanupView {
    NoiseCleanupView {
        menu_action: Some(NoiseCleanupAction::Cancel),
        direct_label: Some(direct),
        menu_label: Some(menu),
        detail: Some(detail),
        status_announcement: Some(status),
        busy: true,
        conflicts_with_file_actions: true,
        ..NoiseCleanupView::default()
    }
}

/// `Math.round`: halves toward +∞.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `deriveNoiseCleanupView`: a derivative points at its source; a job in
/// flight shows its progress; then the intrinsic blockers, before Premium;
/// then start (or retry).
pub fn noise_cleanup_view(input: NoiseCleanupInput<'_>) -> NoiseCleanupView {
    let session = input.session;
    let derived_from = session
        .derived_from_session_id
        .as_deref()
        .filter(|id| !id.is_empty());
    if session.processing_kind.as_deref() == Some("noise-cleanup") || derived_from.is_some() {
        return NoiseCleanupView {
            menu_action: derived_from.map(|_| NoiseCleanupAction::ShowSource),
            menu_label: derived_from.and(some(SHOW_SOURCE_RECORDING)),
            detail: if derived_from.is_some() {
                None
            } else {
                some(SOURCE_GONE)
            },
            derivative: true,
            ..NoiseCleanupView::default()
        };
    }

    let status = input.job.map(|job| job.status);
    match (input.job, status) {
        (Some(_), Some(NoiseCleanupJobStatus::Queued)) => {
            return cancellable(
                QUEUED.into(),
                CANCEL_CLEANUP.into(),
                QUEUED_DETAIL.into(),
                QUEUED_STATUS.into(),
            );
        }
        (Some(job), Some(NoiseCleanupJobStatus::Processing)) => {
            let progress = f64::from(job.progress_percent.min(100));
            let percent = js_round(progress);
            let coarse = js_round(progress / 10.0) * 10;
            return cancellable(
                format!("Cleaning {percent}%"),
                format!("Cancel cleanup · {percent}%"),
                format!("Reducing noise: {percent}% complete."),
                format!("Reducing noise, {coarse} percent."),
            );
        }
        (Some(_), Some(NoiseCleanupJobStatus::Validating)) => {
            return cancellable(
                VALIDATING.into(),
                CANCEL_CLEANUP.into(),
                VALIDATING_DETAIL.into(),
                VALIDATING_STATUS.into(),
            );
        }
        (Some(job), Some(NoiseCleanupJobStatus::Completed))
            if job
                .output_session_id
                .as_deref()
                .is_some_and(|id| !id.is_empty()) =>
        {
            return NoiseCleanupView {
                direct_action: Some(NoiseCleanupAction::OpenOutput),
                menu_action: Some(NoiseCleanupAction::OpenOutput),
                direct_label: some(OPEN_CLEANED_COPY),
                menu_label: some(OPEN_CLEANED_COPY),
                detail: some(COMPLETED_DETAIL),
                status_announcement: some(COMPLETED_STATUS),
                ..NoiseCleanupView::default()
            };
        }
        _ => {}
    }

    if input.capture_active || session.status == "running" {
        return disabled(CAPTURE_REASON);
    }
    if session.mode == "imported" {
        return disabled(IMPORTED_REASON);
    }
    if session.mp4_path.is_none() && session.output_path.is_none() {
        return disabled(MISSING_REASON);
    }
    if session.status != "completed" {
        return disabled(UNFINISHED_REASON);
    }

    if let Some(reason) = input.premium_locked {
        return NoiseCleanupView {
            direct_action: Some(NoiseCleanupAction::Upgrade),
            menu_action: Some(NoiseCleanupAction::Upgrade),
            direct_label: some(REDUCE_NOISE),
            menu_label: some(REDUCE_NOISE_PREMIUM),
            detail: some(reason),
            premium_locked: true,
            ..NoiseCleanupView::default()
        };
    }

    let retry = matches!(
        status,
        Some(NoiseCleanupJobStatus::Failed | NoiseCleanupJobStatus::Cancelled)
    );
    let label = if retry { RETRY_CLEANUP } else { REDUCE_NOISE };
    NoiseCleanupView {
        direct_action: Some(NoiseCleanupAction::Start),
        menu_action: Some(NoiseCleanupAction::Start),
        direct_label: some(label),
        menu_label: some(label),
        detail: retry.then(|| {
            input
                .job
                .and_then(|job| job.error_message.clone())
                .unwrap_or_else(|| RETRY_DETAIL.to_string())
        }),
        ..NoiseCleanupView::default()
    }
}

/// `withNoiseCleanupConnectionState`: while reconnecting, Start is off
/// (the upgrade page and the cleaned copy still open).
pub fn with_connection_state(view: NoiseCleanupView, connected: bool) -> NoiseCleanupView {
    if connected || view.direct_action != Some(NoiseCleanupAction::Start) {
        return view;
    }
    NoiseCleanupView {
        direct_action: None,
        disabled_reason: Some(RECONNECTING_REASON),
        ..view
    }
}

/// `upsertNoiseCleanupJob`: a job event replaces its job unless it is older
/// than the one held (`updatedAt`, ISO, compared as text).
pub fn upsert_job(jobs: &mut Vec<NoiseCleanupJob>, next: NoiseCleanupJob) {
    match jobs.iter_mut().find(|job| job.id == next.id) {
        None => jobs.push(next),
        Some(held) if held.updated_at > next.updated_at => {}
        Some(held) => *held = next,
    }
}

/// `latestNoiseCleanupJobForSession`: the newest job of this recording.
pub fn latest_job_for_session<'a>(
    jobs: &'a [NoiseCleanupJob],
    session_id: &str,
) -> Option<&'a NoiseCleanupJob> {
    let mut latest: Option<&NoiseCleanupJob> = None;
    for job in jobs
        .iter()
        .filter(|job| job.source_session_id == session_id)
    {
        if latest.is_none_or(|held| job.updated_at > held.updated_at) {
            latest = Some(job);
        }
    }
    latest
}

/// `activeNoiseCleanupSourceIds`: the recordings whose file actions wait.
pub fn active_source_ids(jobs: &[NoiseCleanupJob]) -> BTreeSet<String> {
    jobs.iter()
        .filter(|job| job.status.is_active())
        .map(|job| job.source_session_id.clone())
        .collect()
}

/// `noiseCleanupCancellationNotice`: the toast after Cancel; it says
/// canceled only once the backend does. (title, description)
pub fn cancellation_notice(job: &NoiseCleanupJob) -> (&'static str, String) {
    match job.status {
        NoiseCleanupJobStatus::Cancelled => (
            "Noise cleanup canceled",
            "The original recording wasn't changed.".into(),
        ),
        status if status.is_active() => (
            "Cancellation requested",
            "Noise cleanup is still stopping. Its status will update when cancellation finishes."
                .into(),
        ),
        NoiseCleanupJobStatus::Completed => (
            "Noise cleanup already completed",
            "The cleaned copy is ready in Library.".into(),
        ),
        _ => (
            "Noise cleanup stopped",
            job.error_message
                .clone()
                .unwrap_or_else(|| "The cleanup job is no longer running.".into()),
        ),
    }
}

// ── The jobs (`use-studio.tsx`'s `noiseCleanupJobs`) ─────────────────────

/// Each job's progress and outcome, pushed by the backend.
pub const STATUS_EVENT: &str = "noiseCleanup.status";
pub const COMPLETED_TITLE: &str = "Noise cleanup complete";
pub const COMPLETED_DETAIL: &str = "A separate cleaned copy is ready. The original wasn't changed.";

/// `showNoiseCleanupCompleted`: one entry per job behind the bell, with
/// Play and Show in Finder on the cleaned copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedNotice {
    /// `noise-cleanup:<job id>`.
    pub key: String,
    pub job_id: String,
    pub output_session_id: String,
}

/// What one `noiseCleanup.status` event asks of the window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobEventOutcome {
    /// A finished cleanup made a new recording: read the sessions again.
    pub refresh_sessions: bool,
    /// Its completion, said once per job.
    pub completed: Option<CompletedNotice>,
}

/// Every noise cleanup job the window has heard.
#[derive(Debug, Clone, Default)]
pub struct NoiseJobs {
    jobs: Vec<NoiseCleanupJob>,
    announced: BTreeSet<String>,
}

impl NoiseJobs {
    pub fn jobs(&self) -> &[NoiseCleanupJob] {
        &self.jobs
    }

    /// `noiseCleanup.list` replaces the jobs outright: a change to a source
    /// can invalidate a finished copy without an event.
    pub fn replace(&mut self, jobs: Vec<NoiseCleanupJob>) {
        self.jobs = jobs;
    }

    /// A start's or a cancel's answer.
    pub fn answered(&mut self, job: NoiseCleanupJob) {
        upsert_job(&mut self.jobs, job);
    }

    /// One `noiseCleanup.status` event.
    pub fn event(&mut self, job: NoiseCleanupJob) -> JobEventOutcome {
        let completed = job.status == NoiseCleanupJobStatus::Completed;
        let notice = job
            .output_session_id
            .clone()
            .filter(|_| completed && !self.announced.contains(&job.id))
            .map(|output_session_id| CompletedNotice {
                key: format!("noise-cleanup:{}", job.id),
                job_id: job.id.clone(),
                output_session_id,
            });
        if let Some(notice) = &notice {
            self.announced.insert(notice.job_id.clone());
        }
        upsert_job(&mut self.jobs, job);
        JobEventOutcome {
            refresh_sessions: completed,
            completed: notice,
        }
    }
}

fn read_job(method: &str, answer: Value) -> Result<NoiseCleanupJob, RpcError> {
    serde_json::from_value(answer)
        .map_err(|error| RpcError::new(method, "invalid_result", error.to_string()))
}

/// `noiseCleanup.list`, on connect and after the session list's refresh.
pub async fn list_jobs(backend: &impl LibraryBackend) -> Result<Vec<NoiseCleanupJob>, RpcError> {
    let answer = backend
        .library_request("noiseCleanup.list", Value::Null)
        .await?;
    serde_json::from_value(answer)
        .map_err(|error| RpcError::new("noiseCleanup.list", "invalid_result", error.to_string()))
}

/// `noiseCleanup.start`: a cleaned copy of this recording.
pub async fn start_job(
    backend: &impl LibraryBackend,
    session_id: &str,
) -> Result<NoiseCleanupJob, RpcError> {
    let answer = backend
        .library_request("noiseCleanup.start", json!({ "sessionId": session_id }))
        .await?;
    read_job("noiseCleanup.start", answer)
}

/// `noiseCleanup.cancel`: the answer says whether it stopped yet
/// ([`cancellation_notice`]).
pub async fn cancel_job(
    backend: &impl LibraryBackend,
    job_id: &str,
) -> Result<NoiseCleanupJob, RpcError> {
    let answer = backend
        .library_request("noiseCleanup.cancel", json!({ "jobId": job_id }))
        .await?;
    read_job("noiseCleanup.cancel", answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const PREMIUM: &str = "Noise cleanup is part of Videorc Premium.";

    fn session(overrides: Value) -> SessionListItem {
        let mut base = json!({
            "id": "session-1", "title": "Weekly update",
            "startedAt": "2026-07-13T10:00:00.000Z", "status": "completed",
            "mode": "record", "outputPath": "/recordings/session-1.mkv",
            "healthEventCount": 0, "sessionLogCount": 0, "aiArtifactCount": 0,
            "commentCount": 0
        });
        for (key, value) in overrides.as_object().unwrap() {
            if value.is_null() {
                base.as_object_mut().unwrap().remove(key);
            } else {
                base[key] = value.clone();
            }
        }
        serde_json::from_value(base).unwrap()
    }

    fn job(overrides: Value) -> NoiseCleanupJob {
        let mut base = json!({
            "id": "cleanup-1", "sourceSessionId": "session-1", "status": "queued",
            "progressPercent": 0, "preset": "speech-v1",
            "createdAt": "2026-07-13T10:00:00.000Z", "updatedAt": "2026-07-13T10:00:01.000Z"
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn derive(
        session: &SessionListItem,
        locked: Option<&str>,
        job: Option<&NoiseCleanupJob>,
        capture: bool,
    ) -> NoiseCleanupView {
        noise_cleanup_view(NoiseCleanupInput {
            session,
            premium_locked: locked,
            job,
            capture_active: capture,
        })
    }

    fn plain() -> SessionListItem {
        session(json!({}))
    }

    #[test]
    fn basic_is_an_upgrade_and_premium_starts_in_one_click() {
        let locked = derive(&plain(), Some(PREMIUM), None, false);
        assert_eq!(locked.direct_action, Some(NoiseCleanupAction::Upgrade));
        assert_eq!(locked.menu_action, Some(NoiseCleanupAction::Upgrade));
        assert_eq!(locked.direct_label.as_deref(), Some("Reduce noise"));
        assert_eq!(locked.menu_label.as_deref(), Some("Reduce noise · Premium"));
        assert!(locked.premium_locked);
        assert_eq!(locked.detail.as_deref(), Some(PREMIUM));
        let start = derive(&plain(), None, None, false);
        assert_eq!(start.direct_action, Some(NoiseCleanupAction::Start));
        assert_eq!(start.direct_label.as_deref(), Some("Reduce noise"));
        assert!(!start.busy);
    }

    #[test]
    fn intrinsic_blockers_come_before_premium() {
        let cases = [
            (plain(), true, CAPTURE_REASON),
            (session(json!({"status": "running"})), false, CAPTURE_REASON),
            (session(json!({"mode": "imported"})), false, IMPORTED_REASON),
            (
                session(json!({"outputPath": null, "mp4Path": null})),
                false,
                MISSING_REASON,
            ),
            (
                session(json!({"status": "failed"})),
                false,
                UNFINISHED_REASON,
            ),
        ];
        for (row, capture, reason) in cases {
            for locked in [None, Some(PREMIUM)] {
                let view = derive(&row, locked, None, capture);
                assert_eq!(view.direct_action, None);
                assert!(!view.premium_locked);
                assert_eq!(view.disabled_reason, Some(reason));
            }
        }
    }

    #[test]
    fn a_job_in_flight_shows_its_state_with_cancel_in_the_menu() {
        let queued = derive(&plain(), None, Some(&job(json!({}))), false);
        assert_eq!(queued.direct_action, None);
        assert_eq!(queued.menu_action, Some(NoiseCleanupAction::Cancel));
        assert_eq!(queued.direct_label.as_deref(), Some("Queued…"));
        assert!(queued.busy && queued.conflicts_with_file_actions);
        let running = job(json!({"status": "processing", "progressPercent": 42}));
        let processing = derive(&plain(), None, Some(&running), false);
        assert_eq!(processing.direct_label.as_deref(), Some("Cleaning 42%"));
        assert_eq!(
            processing.menu_label.as_deref(),
            Some("Cancel cleanup · 42%")
        );
        assert_eq!(
            processing.status_announcement.as_deref(),
            Some("Reducing noise, 40 percent.")
        );
        let checking = job(json!({"status": "validating", "progressPercent": 100}));
        let validating = derive(&plain(), None, Some(&checking), false);
        assert_eq!(validating.direct_label.as_deref(), Some("Validating…"));
        assert!(validating.conflicts_with_file_actions);
        // Still visible after the entitlement is lost.
        let half = job(json!({"status": "processing", "progressPercent": 50}));
        let kept = derive(&plain(), Some(PREMIUM), Some(&half), false);
        assert_eq!(kept.direct_label.as_deref(), Some("Cleaning 50%"));
        assert!(!kept.premium_locked);
    }

    #[test]
    fn the_cleaned_copy_opens_once_it_has_a_session() {
        let done = job(json!({"status": "completed", "progressPercent": 100,
            "outputSessionId": "cleaned-session"}));
        let view = derive(&plain(), None, Some(&done), false);
        assert_eq!(view.direct_action, Some(NoiseCleanupAction::OpenOutput));
        assert_eq!(view.direct_label.as_deref(), Some("Open cleaned copy"));
        assert_eq!(view.status_announcement.as_deref(), Some(COMPLETED_STATUS));
        let no_output = job(json!({"status": "completed", "progressPercent": 100}));
        let view = derive(&plain(), None, Some(&no_output), false);
        assert_eq!(view.direct_action, Some(NoiseCleanupAction::Start));
    }

    #[test]
    fn a_derivative_shows_its_source_and_never_cleans_again() {
        let cleaned = session(json!({"id": "cleaned-session",
            "derivedFromSessionId": "session-1", "processingKind": "noise-cleanup"}));
        let view = derive(&cleaned, None, None, false);
        assert_eq!(view.direct_action, None);
        assert_eq!(view.menu_action, Some(NoiseCleanupAction::ShowSource));
        assert_eq!(view.menu_label.as_deref(), Some("Show source recording"));
        assert!(view.derivative);
        let cut = session(
            json!({"id": "cut-session", "mp4Path": "/recordings/cut.mp4",
            "derivedFromSessionId": "session-1"}),
        );
        let view = derive(&cut, None, None, false);
        assert_eq!((view.direct_label, view.derivative), (None, true));
        assert_eq!(view.menu_action, Some(NoiseCleanupAction::ShowSource));
        let orphan = session(json!({"id": "cleaned-session", "processingKind": "noise-cleanup"}));
        let view = derive(&orphan, None, None, false);
        assert_eq!((view.menu_action, view.direct_label.clone()), (None, None));
        assert_eq!(view.detail.as_deref(), Some(SOURCE_GONE));
    }

    #[test]
    fn a_failed_or_cancelled_job_retries_with_the_backends_detail() {
        let failed = job(
            json!({"status": "failed", "errorCode": "noise-cleanup-no-audio",
            "errorMessage": "This recording has no microphone audio."}),
        );
        let view = derive(&plain(), None, Some(&failed), false);
        assert_eq!(view.direct_action, Some(NoiseCleanupAction::Start));
        assert_eq!(view.direct_label.as_deref(), Some("Retry cleanup"));
        assert_eq!(
            view.detail.as_deref(),
            Some("This recording has no microphone audio.")
        );
        let cancelled = job(json!({"status": "cancelled"}));
        let view = derive(&plain(), None, Some(&cancelled), false);
        assert_eq!(view.direct_label.as_deref(), Some("Retry cleanup"));
        assert_eq!(view.detail.as_deref(), Some(RETRY_DETAIL));
    }

    #[test]
    fn the_newest_job_wins_and_only_active_ones_hold_files() {
        let queued = job(json!({}));
        let processing = job(json!({"status": "processing", "progressPercent": 20,
            "updatedAt": "2026-07-13T10:00:02.000Z"}));
        let stale = job(json!({"updatedAt": "2026-07-13T10:00:00.500Z"}));
        let other = job(json!({"id": "cleanup-2", "sourceSessionId": "session-2",
            "updatedAt": "2026-07-13T10:00:03.000Z"}));
        let mut jobs = vec![queued];
        upsert_job(&mut jobs, processing.clone());
        upsert_job(&mut jobs, stale);
        upsert_job(&mut jobs, other.clone());
        assert_eq!(
            latest_job_for_session(&jobs, "session-1"),
            Some(&processing)
        );
        assert_eq!(latest_job_for_session(&jobs, "session-2"), Some(&other));

        let statuses = [
            "queued",
            "processing",
            "validating",
            "completed",
            "failed",
            "cancelled",
        ];
        let jobs: Vec<_> = statuses
            .iter()
            .enumerate()
            .map(|(index, status)| {
                job(json!({"id": format!("cleanup-{index}"),
                    "sourceSessionId": format!("session-{}", index + 1), "status": status}))
            })
            .collect();
        let active: Vec<_> = active_source_ids(&jobs).into_iter().collect();
        assert_eq!(active, ["session-1", "session-2", "session-3"]);
    }

    #[test]
    fn cancel_is_confirmed_only_once_the_backend_says_cancelled() {
        assert_eq!(
            cancellation_notice(&job(json!({"status": "cancelled"}))),
            (
                "Noise cleanup canceled",
                "The original recording wasn't changed.".to_string()
            )
        );
        for status in ["queued", "processing", "validating"] {
            assert_eq!(
                cancellation_notice(&job(json!({"status": status}))).0,
                "Cancellation requested"
            );
        }
    }

    #[test]
    fn reconnecting_turns_off_start_only() {
        let start = derive(&plain(), None, None, false);
        let offline = with_connection_state(start.clone(), false);
        assert_eq!(offline.direct_action, None);
        assert_eq!(offline.menu_action, Some(NoiseCleanupAction::Start));
        assert_eq!(offline.direct_label.as_deref(), Some("Reduce noise"));
        assert_eq!(offline.disabled_reason, Some(RECONNECTING_REASON));
        assert_eq!(with_connection_state(start.clone(), true), start);
        let upgrade = derive(&plain(), Some(PREMIUM), None, false);
        assert_eq!(with_connection_state(upgrade.clone(), false), upgrade);
    }

    /// The words are still Electron's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let sources = [include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/noise-cleanup-view.ts"
        )];
        let this = include_str!("noise.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = super::super::copy::tests::unseen_constants(this, &sources);
        assert!(
            checked > 15,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
    }

    #[test]
    fn the_jobs_follow_events_and_say_a_completion_once() {
        let mut jobs = NoiseJobs::default();
        jobs.replace(vec![job(json!({}))]);
        let running = jobs.event(job(json!({"status": "processing", "progressPercent": 30,
            "updatedAt": "2026-07-13T10:00:02.000Z"})));
        assert_eq!(running, JobEventOutcome::default());
        assert_eq!(jobs.jobs()[0].progress_percent, 30);
        let done = job(json!({"status": "completed", "progressPercent": 100,
            "outputSessionId": "cleaned", "updatedAt": "2026-07-13T10:00:03.000Z"}));
        let outcome = jobs.event(done.clone());
        assert!(outcome.refresh_sessions);
        assert_eq!(
            outcome.completed,
            Some(CompletedNotice {
                key: "noise-cleanup:cleanup-1".into(),
                job_id: "cleanup-1".into(),
                output_session_id: "cleaned".into(),
            })
        );
        // The same completion again: the list refreshes, nothing is said.
        let again = jobs.event(done);
        assert!(again.refresh_sessions);
        assert_eq!(again.completed, None);
        // A start's answer joins the list; the list replaces everything.
        jobs.answered(job(
            json!({"id": "cleanup-2", "sourceSessionId": "session-2"}),
        ));
        assert_eq!(jobs.jobs().len(), 2);
        jobs.replace(Vec::new());
        assert!(jobs.jobs().is_empty());
    }

    #[test]
    fn the_completion_words_are_the_renderers() {
        let recovery = include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/session-runtime-recovery.ts"
        );
        assert!(recovery.contains(&format!("title: '{COMPLETED_TITLE}'")));
        assert!(recovery.contains(&format!("detail: \"{COMPLETED_DETAIL}\"")));
        assert!(recovery.contains("key: `noise-cleanup:${jobId}`"));
    }
}
