//! Background recording finalization (instant-record plan, P2).
//!
//! After a stop, the terminal `recording.status` is published as soon as the
//! MKV is closed and its row is committed. Everything the user used to wait
//! for — MKV→MP4 export, caption artifacts, the final duration probe, the
//! poster — runs as a finalization job owned by this registry. The registry
//! is the single authority the Library, the quit path and the updater gate
//! consult to know whether any recording is still being finished.
//!
//! Jobs are serialized (one export at a time) so back-to-back takes never fan
//! out into parallel FFmpeg processes fighting the next recording for disk.
//! The slot serves Combined (and ordinary single-file) exports before a take's
//! separate files (plan 200 C4), with a starvation bound for the latter.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use crate::protocol::{RecordingFinalizationEvent, RecordingFinalizationState};
use crate::state::AppState;

/// Per-job control shared between the registry, the job task and cancellation.
#[derive(Debug, Default)]
pub struct FinalizationJobControl {
    cancel_requested: AtomicBool,
    /// FFmpeg export child while it runs (0 when none), so a deletion can stop
    /// the export instead of racing its publication.
    child_pid: AtomicU32,
    progress_percent: AtomicU8,
    finished: Notify,
}

impl FinalizationJobControl {
    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub fn set_child_pid(&self, pid: u32) {
        self.child_pid.store(pid, Ordering::Release);
    }

    pub fn child_pid(&self) -> Option<u32> {
        let pid = self.child_pid.load(Ordering::Acquire);
        (pid != 0).then_some(pid)
    }

    pub fn set_progress_percent(&self, percent: u8) {
        self.progress_percent
            .store(percent.min(100), Ordering::Release);
    }

    pub fn progress_percent(&self) -> u8 {
        self.progress_percent.load(Ordering::Acquire)
    }
}

/// Plan 200 C4: a separate-file export that has waited this long goes next,
/// ahead of any Combined export, so a busy day of takes never starves it.
pub const SEPARATE_FILE_EXPORT_MAX_WAIT: Duration = Duration::from_secs(60);

/// Which queue an export waits in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportClass {
    /// A Combined file or an ordinary single-file recording.
    Primary,
    /// A take's Screen or Camera file (`<take_id>-<role>` session id).
    SeparateFile { take_id: String },
}

impl ExportClass {
    /// Separate files are rows `<take_id>-screen` / `<take_id>-camera`
    /// (`source_iso::commit_finished_source_iso_roles`); every other session
    /// id is a primary export.
    pub fn for_session(session_id: &str) -> Self {
        for role in [
            crate::source_iso::RecordingRole::Screen,
            crate::source_iso::RecordingRole::Camera,
        ] {
            if let Some(take_id) = session_id
                .strip_suffix(role.as_str())
                .and_then(|rest| rest.strip_suffix('-'))
                .filter(|take_id| !take_id.is_empty())
            {
                return Self::SeparateFile {
                    take_id: take_id.to_string(),
                };
            }
        }
        Self::Primary
    }
}

#[derive(Debug, Clone)]
struct ExportWaiter {
    ticket: u64,
    class: ExportClass,
    queued_at: tokio::time::Instant,
}

#[derive(Debug, Default)]
struct ExportSlotState {
    busy: bool,
    next_ticket: u64,
    waiters: Vec<ExportWaiter>,
    /// Takes whose Combined export is on its way (registered at Stop before
    /// the take's separate files queue) and has not left the slot yet.
    pending_primary_takes: HashSet<String>,
}

/// The waiter the free slot serves next, in order:
/// 1. the oldest separate-file export that has waited `max_wait` or longer;
/// 2. the oldest Combined/single-file export;
/// 3. the oldest separate-file export whose take's Combined is not pending.
fn next_export_ticket(
    waiters: &[ExportWaiter],
    pending_primary_takes: &HashSet<String>,
    now: tokio::time::Instant,
    max_wait: Duration,
) -> Option<u64> {
    let oldest = |filter: &dyn Fn(&ExportWaiter) -> bool| {
        waiters
            .iter()
            .filter(|waiter| filter(waiter))
            .map(|waiter| waiter.ticket)
            .min()
    };
    oldest(&|waiter| {
        matches!(waiter.class, ExportClass::SeparateFile { .. })
            && now.saturating_duration_since(waiter.queued_at) >= max_wait
    })
    .or_else(|| oldest(&|waiter| waiter.class == ExportClass::Primary))
    .or_else(|| {
        oldest(&|waiter| match &waiter.class {
            ExportClass::SeparateFile { take_id } => !pending_primary_takes.contains(take_id),
            ExportClass::Primary => false,
        })
    })
}

#[derive(Debug, Default)]
pub struct RecordingFinalizationRegistry {
    jobs: Mutex<HashMap<String, Arc<FinalizationJobControl>>>,
    changed: Notify,
    /// Serializes the FFmpeg export step across jobs (plan 200 C4: by class).
    export_slot: Mutex<ExportSlotState>,
    export_changed: Notify,
}

/// Holds the one export slot; releasing it wakes the next waiter.
#[derive(Debug)]
pub struct ExportSlotGuard<'a> {
    registry: &'a RecordingFinalizationRegistry,
    session_id: String,
    class: ExportClass,
}

impl Drop for ExportSlotGuard<'_> {
    fn drop(&mut self) {
        {
            let mut slot = self.registry.lock_export_slot();
            slot.busy = false;
            if self.class == ExportClass::Primary {
                slot.pending_primary_takes.remove(&self.session_id);
            }
        }
        self.registry.export_changed.notify_waiters();
    }
}

/// Removes a waiter whose acquire future was dropped before it got the slot.
struct ExportWaiterRegistration<'a> {
    registry: &'a RecordingFinalizationRegistry,
    ticket: u64,
    waiting: bool,
}

impl Drop for ExportWaiterRegistration<'_> {
    fn drop(&mut self) {
        if !self.waiting {
            return;
        }
        self.registry
            .lock_export_slot()
            .waiters
            .retain(|waiter| waiter.ticket != self.ticket);
        self.registry.export_changed.notify_waiters();
    }
}

impl RecordingFinalizationRegistry {
    /// Registers a job for `session_id`. Must be called BEFORE the terminal
    /// `recording.status` is published so "capture idle AND registry idle" has
    /// no gap for the quit and updater gates to slip through.
    pub fn register(&self, session_id: &str) -> Arc<FinalizationJobControl> {
        let control = {
            let mut jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            jobs.entry(session_id.to_string())
                .or_insert_with(|| Arc::new(FinalizationJobControl::default()))
                .clone()
        };
        self.changed.notify_waiters();
        control
    }

    pub fn finish(&self, session_id: &str) {
        let finished = {
            let mut jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            jobs.remove(session_id)
        };
        if let Some(control) = finished {
            control.set_child_pid(0);
            control.finished.notify_waiters();
        }
        self.changed.notify_waiters();
        // A Combined job that ended before (or without) its export no longer
        // holds its take's separate files back.
        self.withdraw_primary_export(session_id);
    }

    pub fn has_active_jobs(&self) -> bool {
        !self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }

    pub fn active_for_session(&self, session_id: &str) -> Option<Arc<FinalizationJobControl>> {
        self.jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .cloned()
    }

    pub fn progress_for_session(&self, session_id: &str) -> Option<u8> {
        self.active_for_session(session_id)
            .map(|control| control.progress_percent())
    }

    /// Resolves once no job is registered. Used by the process shutdown join
    /// alongside the ffmpeg-work export permit.
    pub async fn wait_idle(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if !self.has_active_jobs() {
                return;
            }
            notified.await;
        }
    }

    /// Requests cancellation of the job for `session_id` and waits for it to
    /// finish within `grace`. Returns true when the job is gone (finished or
    /// never existed).
    pub async fn cancel_and_wait(&self, session_id: &str, grace: Duration) -> bool {
        let Some(control) = self.active_for_session(session_id) else {
            return true;
        };
        control.request_cancel();
        if let Some(pid) = control.child_pid() {
            let _ = crate::recording::signal_finalization_child(pid).await;
        }
        let deadline = tokio::time::Instant::now() + grace;
        loop {
            let notified = control.finished.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if self.active_for_session(session_id).is_none() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return self.active_for_session(session_id).is_none();
            }
        }
    }

    fn lock_export_slot(&self) -> std::sync::MutexGuard<'_, ExportSlotState> {
        self.export_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Plan 200 C4: Stop is about to queue this take's separate files ahead of
    /// its Combined job. Until the Combined export leaves the slot (or the
    /// Combined job ends without one), the take's separate files yield to it.
    pub fn expect_primary_export(&self, take_id: &str) {
        self.lock_export_slot()
            .pending_primary_takes
            .insert(take_id.to_string());
    }

    /// The Combined export of `take_id` will not run (or has run).
    pub fn withdraw_primary_export(&self, take_id: &str) {
        let removed = self
            .lock_export_slot()
            .pending_primary_takes
            .remove(take_id);
        if removed {
            self.export_changed.notify_waiters();
        }
    }

    /// One export at a time. The guard is held for the FFmpeg step only.
    /// Combined and single-file exports go before separate files; a separate
    /// file waits for its own take's pending Combined export, and never more
    /// than [`SEPARATE_FILE_EXPORT_MAX_WAIT`] behind other exports.
    pub async fn export_slot(&self, session_id: &str) -> ExportSlotGuard<'_> {
        self.export_slot_with_max_wait(session_id, SEPARATE_FILE_EXPORT_MAX_WAIT)
            .await
    }

    async fn export_slot_with_max_wait(
        &self,
        session_id: &str,
        max_wait: Duration,
    ) -> ExportSlotGuard<'_> {
        let class = ExportClass::for_session(session_id);
        let ticket = {
            let mut slot = self.lock_export_slot();
            let ticket = slot.next_ticket;
            slot.next_ticket = slot.next_ticket.wrapping_add(1);
            slot.waiters.push(ExportWaiter {
                ticket,
                class: class.clone(),
                queued_at: tokio::time::Instant::now(),
            });
            ticket
        };
        let mut registration = ExportWaiterRegistration {
            registry: self,
            ticket,
            waiting: true,
        };
        loop {
            // Register the wakeup before inspecting the slot (no lost wakeup).
            let notified = self.export_changed.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let wake_at = {
                let mut slot = self.lock_export_slot();
                let now = tokio::time::Instant::now();
                if !slot.busy
                    && next_export_ticket(&slot.waiters, &slot.pending_primary_takes, now, max_wait)
                        == Some(ticket)
                {
                    slot.busy = true;
                    slot.waiters.retain(|waiter| waiter.ticket != ticket);
                    registration.waiting = false;
                    return ExportSlotGuard {
                        registry: self,
                        session_id: session_id.to_string(),
                        class,
                    };
                }
                // The starvation bound is a deadline, not an event: wake when
                // the next separate-file waiter crosses it.
                slot.waiters
                    .iter()
                    .filter(|waiter| matches!(waiter.class, ExportClass::SeparateFile { .. }))
                    .map(|waiter| waiter.queued_at + max_wait)
                    .filter(|deadline| *deadline > now)
                    .min()
            };
            match wake_at {
                Some(deadline) => {
                    let _ = tokio::time::timeout_at(deadline, notified).await;
                }
                None => notified.await,
            }
        }
    }
}

/// Publishes a `recording.finalization` event. Options stay `None` when unknown
/// so the wire never carries `null` (serde-null contract trap).
pub fn emit_finalization_event(
    state: &AppState,
    session_id: &str,
    finalization_state: RecordingFinalizationState,
    detail: FinalizationEventDetail,
) {
    let event = RecordingFinalizationEvent {
        session_id: session_id.to_string(),
        state: finalization_state,
        progress_percent: detail.progress_percent,
        mp4_path: detail.mp4_path,
        output_path: detail.output_path,
        duration_ms: detail.duration_ms,
        file_size_bytes: detail.file_size_bytes,
        error: detail.error,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    state.emit_event("recording.finalization", event);
}

#[derive(Debug, Default, Clone)]
pub struct FinalizationEventDetail {
    pub progress_percent: Option<u8>,
    pub mp4_path: Option<String>,
    pub output_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub file_size_bytes: Option<i64>,
    pub error: Option<String>,
}

/// Maps the persisted `sessions.finalization_state` column to the wire enum.
/// `None`/unknown means a legacy row that finished inline: finalized.
pub fn finalization_state_from_column(value: Option<&str>) -> Option<RecordingFinalizationState> {
    match value {
        Some("finalizing") => Some(RecordingFinalizationState::Finalizing),
        Some("finalized") => Some(RecordingFinalizationState::Finalized),
        Some("failed") => Some(RecordingFinalizationState::Failed),
        _ => None,
    }
}

pub const FINALIZATION_STATE_FINALIZING: &str = "finalizing";
pub const FINALIZATION_STATE_FINALIZED: &str = "finalized";
pub const FINALIZATION_STATE_FAILED: &str = "failed";

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_finish_track_active_jobs() {
        let registry = RecordingFinalizationRegistry::default();
        assert!(!registry.has_active_jobs());
        let control = registry.register("s-1");
        control.set_progress_percent(42);
        assert!(registry.has_active_jobs());
        assert_eq!(registry.progress_for_session("s-1"), Some(42));
        assert_eq!(registry.progress_for_session("s-2"), None);

        registry.finish("s-1");
        assert!(!registry.has_active_jobs());
        assert_eq!(registry.progress_for_session("s-1"), None);
    }

    #[tokio::test]
    async fn wait_idle_resolves_when_the_last_job_finishes() {
        let registry = Arc::new(RecordingFinalizationRegistry::default());
        registry.register("s-1");
        let waiter = tokio::spawn({
            let registry = registry.clone();
            async move { registry.wait_idle().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "must wait while a job is registered");

        registry.finish("s-1");
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("wait_idle must resolve once the registry is empty")
            .unwrap();
    }

    #[tokio::test]
    async fn cancel_and_wait_reports_timeout_and_completion() {
        let registry = RecordingFinalizationRegistry::default();
        let control = registry.register("s-1");
        assert!(
            !registry
                .cancel_and_wait("s-1", Duration::from_millis(20))
                .await,
            "a job that never finishes reports false after the grace"
        );
        assert!(control.is_cancelled());

        registry.finish("s-1");
        assert!(
            registry
                .cancel_and_wait("s-1", Duration::from_millis(20))
                .await
        );
        assert!(registry.cancel_and_wait("absent", Duration::ZERO).await);
    }

    #[test]
    fn export_class_reads_separate_file_session_ids() {
        assert_eq!(ExportClass::for_session("take-1"), ExportClass::Primary);
        assert_eq!(
            ExportClass::for_session("take-1-screen"),
            ExportClass::SeparateFile {
                take_id: "take-1".to_string()
            }
        );
        assert_eq!(
            ExportClass::for_session("take-1-camera"),
            ExportClass::SeparateFile {
                take_id: "take-1".to_string()
            }
        );
        assert_eq!(ExportClass::for_session("-camera"), ExportClass::Primary);
        assert_eq!(ExportClass::for_session("takecamera"), ExportClass::Primary);
    }

    /// Queues `ids` in order behind a held slot, releases it, and returns the
    /// order in which they got the slot.
    async fn export_order(
        registry: Arc<RecordingFinalizationRegistry>,
        ids: &[&str],
    ) -> Vec<String> {
        let blocker = registry.export_slot("blocker").await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for id in ids {
            let registry = registry.clone();
            let order = order.clone();
            let id = id.to_string();
            tasks.push(tokio::spawn(async move {
                let _slot = registry.export_slot(&id).await;
                order.lock().unwrap().push(id);
                tokio::task::yield_now().await;
            }));
            // Queue strictly in order.
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
        }
        drop(blocker);
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("every export gets the slot")
                .unwrap();
        }
        let order = order.lock().unwrap().clone();
        order
    }

    #[tokio::test(flavor = "current_thread")]
    async fn combined_exports_before_its_separate_files_queued_earlier() {
        let registry = Arc::new(RecordingFinalizationRegistry::default());
        let order = export_order(
            registry.clone(),
            &["take-a-camera", "take-a-screen", "take-a"],
        )
        .await;
        assert_eq!(order, vec!["take-a", "take-a-camera", "take-a-screen"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_free_slot_waits_for_the_takes_expected_combined_export() {
        let registry = Arc::new(RecordingFinalizationRegistry::default());
        registry.expect_primary_export("take-b");
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for id in ["take-b-camera", "take-b-screen", "other-c-screen"] {
            let registry = registry.clone();
            let order = order.clone();
            tasks.push(tokio::spawn(async move {
                let _slot = registry.export_slot(id).await;
                order.lock().unwrap().push(id.to_string());
                tokio::task::yield_now().await;
            }));
            tokio::task::yield_now().await;
        }
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        // Another take's separate file is not held back.
        assert_eq!(*order.lock().unwrap(), vec!["other-c-screen".to_string()]);
        {
            let _combined = registry.export_slot("take-b").await;
            order.lock().unwrap().push("take-b".to_string());
        }
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            *order.lock().unwrap(),
            vec!["other-c-screen", "take-b", "take-b-camera", "take-b-screen"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_combined_job_that_ends_without_export_releases_its_separate_files() {
        let registry = Arc::new(RecordingFinalizationRegistry::default());
        registry.register("take-d");
        registry.expect_primary_export("take-d");
        let waiter = tokio::spawn({
            let registry = registry.clone();
            async move {
                let _slot = registry.export_slot("take-d-camera").await;
            }
        });
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        assert!(!waiter.is_finished());
        registry.finish("take-d");
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the separate file runs once Combined is gone")
            .unwrap();
    }

    #[test]
    fn a_separate_file_past_the_wait_bound_goes_before_combined() {
        let now = tokio::time::Instant::now();
        let waiter = |ticket, class: ExportClass, waited: u64| ExportWaiter {
            ticket,
            class,
            queued_at: now.checked_sub(Duration::from_secs(waited)).unwrap_or(now),
        };
        let separate = || ExportClass::SeparateFile {
            take_id: "take-e".to_string(),
        };
        let pending = HashSet::from(["take-e".to_string()]);
        let max_wait = Duration::from_secs(60);
        // Under the bound: Combined first, even when the separate file is older.
        let waiters = vec![
            waiter(1, separate(), 59),
            waiter(2, ExportClass::Primary, 1),
        ];
        assert_eq!(
            next_export_ticket(&waiters, &HashSet::new(), now, max_wait),
            Some(2)
        );
        // At the bound: the separate file goes next, even while its take's
        // Combined is still pending.
        let waiters = vec![
            waiter(1, separate(), 60),
            waiter(2, ExportClass::Primary, 1),
        ];
        assert_eq!(
            next_export_ticket(&waiters, &pending, now, max_wait),
            Some(1)
        );
        // Nothing to serve while only a held-back separate file waits.
        let waiters = vec![waiter(1, separate(), 1)];
        assert_eq!(next_export_ticket(&waiters, &pending, now, max_wait), None);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_held_back_separate_file_never_waits_past_the_bound() {
        let registry = Arc::new(RecordingFinalizationRegistry::default());
        // A Combined export that is expected but never arrives.
        registry.expect_primary_export("take-f");
        let started = tokio::time::Instant::now();
        let _slot = tokio::time::timeout(
            Duration::from_secs(120),
            registry.export_slot("take-f-screen"),
        )
        .await
        .expect("the starvation bound releases the separate file");
        let waited = started.elapsed();
        assert!(
            waited >= SEPARATE_FILE_EXPORT_MAX_WAIT
                && waited < SEPARATE_FILE_EXPORT_MAX_WAIT + Duration::from_secs(1),
            "waited {waited:?}"
        );
    }

    #[test]
    fn progress_is_clamped_and_column_states_map() {
        let control = FinalizationJobControl::default();
        control.set_progress_percent(250);
        assert_eq!(control.progress_percent(), 100);
        assert_eq!(control.child_pid(), None);
        control.set_child_pid(4242);
        assert_eq!(control.child_pid(), Some(4242));

        assert_eq!(
            finalization_state_from_column(Some("finalizing")),
            Some(RecordingFinalizationState::Finalizing)
        );
        assert_eq!(
            finalization_state_from_column(Some("failed")),
            Some(RecordingFinalizationState::Failed)
        );
        assert_eq!(finalization_state_from_column(None), None);
        assert_eq!(finalization_state_from_column(Some("mp4")), None);
    }
}
