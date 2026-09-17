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

use std::collections::HashMap;
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

#[derive(Debug, Default)]
pub struct RecordingFinalizationRegistry {
    jobs: Mutex<HashMap<String, Arc<FinalizationJobControl>>>,
    changed: Notify,
    /// Serializes the FFmpeg export step across jobs.
    export_queue: tokio::sync::Mutex<()>,
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

    /// One export at a time. The guard is held for the FFmpeg step only.
    pub async fn export_slot(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.export_queue.lock().await
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
