//! Job plumbing shared by every Clean cut phase: the per-job control handle
//! a worker polls, the registry that reaches a running worker, the typed
//! failure codes, and the persist-and-emit helpers that keep the row and the
//! `cleanCut.status` event in step.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::Notify;

use crate::ffmpeg_work::MaintenanceCancelToken;
use crate::protocol::CleanCutJobState;
use crate::state::AppState;
use crate::storage::PersistedCleanCutJob;
use crate::videorc_api::VideorcApiClient;

/// Everything a worker phase needs, with cheap clones of the interrupt
/// sources so blocking tasks can poll them off the Tokio runtime.
pub struct WorkerContext<'a> {
    pub state: &'a AppState,
    pub control: Arc<JobControl>,
    /// `Some` while the maintenance slot is held: a waiting capture preempts
    /// the phase. `None` for work that needs no slot (polling the analysis).
    pub maintenance: Option<MaintenanceCancelToken>,
    pub client: &'a VideorcApiClient,
    pub token: &'a str,
}

impl<'a> WorkerContext<'a> {
    pub fn interrupts(&self) -> Interrupts<'_> {
        Interrupts {
            control: self.control.as_ref(),
            maintenance: self.maintenance.as_ref(),
        }
    }

    /// The same job without the slot: only cancel and shutdown interrupt.
    pub fn without_slot(&self) -> WorkerContext<'a> {
        WorkerContext {
            state: self.state,
            control: self.control.clone(),
            maintenance: None,
            client: self.client,
            token: self.token,
        }
    }

    /// A probe a blocking task can call between process polls.
    pub fn interrupt_probe(&self) -> impl Fn() -> bool + Send + Sync + 'static {
        let control = self.control.clone();
        let maintenance = self.maintenance.clone();
        move || {
            control.should_interrupt()
                || maintenance
                    .as_ref()
                    .is_some_and(|maintenance| maintenance.is_cancelled())
        }
    }
}

/// The job snapshot event the renderer listens to.
pub const EVENT_STATUS: &str = "cleanCut.status";

// `cleanCut.start` refusal codes. The renderer switches on these.
pub const REFUSAL_NOT_ELIGIBLE: &str = "not-eligible";
pub const REFUSAL_PREMIUM_REQUIRED: &str = "premium-required";
pub const REFUSAL_SIGNED_OUT: &str = "signed-out";
pub const REFUSAL_CONSENT_REQUIRED: &str = "consent-required";
pub const REFUSAL_UNAVAILABLE: &str = "unavailable";
pub const REFUSAL_ALREADY_RUNNING: &str = "already-running";
pub const REFUSAL_START_FAILED: &str = "start-failed";

// `cleanCut.updateEdl` refusal codes.
pub const REFUSAL_NOT_FOUND: &str = "not-found";
pub const REFUSAL_NOT_READY: &str = "not-ready";
pub const REFUSAL_EDL_REVISION_CONFLICT: &str = "edl-revision-conflict";
pub const REFUSAL_INVALID_PARAMS: &str = "invalid-params";
pub const REFUSAL_UPDATE_FAILED: &str = "update-failed";

// Job `error_code` values the desktop produces itself. Server codes from the
// contract (`clean-cut-monthly-quota-exhausted`, `clean-cut-disabled`, ...)
// are stored verbatim.
pub const ERROR_SIGNED_OUT: &str = "signed-out";
pub const ERROR_PREMIUM_REQUIRED: &str = "premium-required";
pub const ERROR_NETWORK: &str = "network";
pub const ERROR_FILE_MISSING: &str = "file-missing";
pub const ERROR_SOURCE_CHANGED: &str = "source-changed";
pub const ERROR_NO_AUDIO: &str = "no-audio";
pub const ERROR_NO_SPEECH: &str = "no-speech";
pub const ERROR_FFMPEG: &str = "ffmpeg-failed";
pub const ERROR_PROBE: &str = "probe-failed";
pub const ERROR_PROCESSING: &str = "processing-failed";
pub const ERROR_ANALYSIS: &str = "analysis-failed";
pub const ERROR_ANALYSIS_TIMEOUT: &str = "analysis-timeout";
pub const ERROR_TRANSCRIPT_TOO_LONG: &str = "transcript-too-long";

/// A typed `cleanCut.*` refusal: the code is closed on the desktop side, the
/// message is plain copy for the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanCutRefusal {
    pub code: &'static str,
    pub message: String,
}

impl CleanCutRefusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Why a job failed: a code the renderer can switch on and a plain message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobFailure {
    pub code: String,
    pub message: String,
}

impl JobFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// How a phase of the worker ended.
#[derive(Debug)]
pub enum PhaseOutcome<T> {
    Done(T),
    /// A capture wants the machine: drop the slot, re-queue, try again later.
    CapturePreempted,
    UserCancelled,
    ShutdownInterrupted,
    Failed(JobFailure),
}

#[derive(Debug, Default)]
pub struct JobControl {
    user_cancelled: AtomicBool,
    shutdown_interrupted: AtomicBool,
    pub cancelled: Notify,
    pub finished: Notify,
}

impl JobControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request_cancel(&self) {
        self.user_cancelled.store(true, Ordering::Release);
        self.cancelled.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.user_cancelled.load(Ordering::Acquire)
    }

    pub fn is_shutdown_interrupted(&self) -> bool {
        self.shutdown_interrupted.load(Ordering::Acquire)
    }

    pub fn should_interrupt(&self) -> bool {
        self.is_cancelled() || self.is_shutdown_interrupted()
    }

    pub fn request_shutdown_interrupt(&self) {
        self.shutdown_interrupted.store(true, Ordering::Release);
        self.cancelled.notify_waiters();
    }
}

/// Live workers by job id. `AppState.clean_cut` holds the one instance.
#[derive(Debug, Default)]
pub struct CleanCutRegistry {
    jobs: Mutex<HashMap<String, Arc<JobControl>>>,
}

impl CleanCutRegistry {
    pub(super) fn register(&self, job_id: &str) -> Arc<JobControl> {
        let mut jobs = self.jobs.lock().expect("Clean cut registry poisoned");
        jobs.entry(job_id.to_string())
            .or_insert_with(|| Arc::new(JobControl::new()))
            .clone()
    }

    pub(super) fn get(&self, job_id: &str) -> Option<Arc<JobControl>> {
        self.jobs
            .lock()
            .expect("Clean cut registry poisoned")
            .get(job_id)
            .cloned()
    }

    pub(super) fn finish(&self, job_id: &str) {
        if let Some(control) = self
            .jobs
            .lock()
            .expect("Clean cut registry poisoned")
            .remove(job_id)
        {
            control.finished.notify_waiters();
        }
    }

    /// Process shutdown: every worker stops at its next check and leaves the
    /// row active, so startup requeues it.
    pub fn interrupt_all_for_shutdown(&self) {
        for control in self
            .jobs
            .lock()
            .expect("Clean cut registry poisoned")
            .values()
        {
            control.request_shutdown_interrupt();
        }
    }
}

/// The interrupt sources a phase polls between steps: the user, process
/// shutdown, and (while the slot is held) a capture that wants the machine.
pub struct Interrupts<'a> {
    pub control: &'a JobControl,
    pub maintenance: Option<&'a MaintenanceCancelToken>,
}

impl Interrupts<'_> {
    /// The pending interrupt, if any. Cancel wins over shutdown, which wins
    /// over a capture.
    pub fn check<T>(&self) -> Option<PhaseOutcome<T>> {
        if self.control.is_cancelled() {
            return Some(PhaseOutcome::UserCancelled);
        }
        if self.control.is_shutdown_interrupted() {
            return Some(PhaseOutcome::ShutdownInterrupted);
        }
        if self
            .maintenance
            .is_some_and(|maintenance| maintenance.is_cancelled())
        {
            return Some(PhaseOutcome::CapturePreempted);
        }
        None
    }

    /// Resolves at the first interrupt. Pair it with a `tokio::select!` around
    /// a network call so a capture never waits for an upload to finish.
    pub async fn wait<T>(&self) -> PhaseOutcome<T> {
        loop {
            if let Some(outcome) = self.check() {
                return outcome;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Save the row, then tell the renderer. A persistence failure is logged and
/// the event is withheld: the renderer must never see a state the row does
/// not have.
pub fn persist_and_emit(state: &AppState, persisted: &mut PersistedCleanCutJob) {
    persisted.job.updated_at = Utc::now().to_rfc3339();
    if let Err(error) = state.database.save_clean_cut_job(persisted) {
        state.emit_log(
            "error",
            format!(
                "Could not persist Clean cut job {}: {error:#}",
                persisted.job.id
            ),
        );
        return;
    }
    state.emit_event(EVENT_STATUS, &persisted.job);
}

pub fn set_job_state(
    state: &AppState,
    persisted: &mut PersistedCleanCutJob,
    job_state: CleanCutJobState,
    step: Option<&str>,
    progress: f64,
) {
    persisted.job.state = job_state;
    persisted.job.step = step.map(str::to_string);
    persisted.job.progress = progress.clamp(0.0, 1.0);
    persist_and_emit(state, persisted);
}

/// A terminal state. `failure` fills the error columns; `None` clears them.
pub fn terminal_job(
    state: &AppState,
    persisted: &mut PersistedCleanCutJob,
    job_state: CleanCutJobState,
    failure: Option<JobFailure>,
) {
    match failure {
        Some(failure) => {
            persisted.job.error_code = Some(failure.code);
            persisted.job.error_message = Some(failure.message);
        }
        None => {
            persisted.job.error_code = None;
            persisted.job.error_message = None;
        }
    }
    let progress = if job_state == CleanCutJobState::Ready {
        1.0
    } else {
        persisted.job.progress
    };
    set_job_state(state, persisted, job_state, None, progress);
}

pub fn fail_job(state: &AppState, persisted: &mut PersistedCleanCutJob, failure: JobFailure) {
    terminal_job(state, persisted, CleanCutJobState::Failed, Some(failure));
}

/// Back to the queue with the error columns clear and the progress kept, so
/// the renderer shows "Waiting" instead of a stale failure.
pub fn requeue_job(state: &AppState, persisted: &mut PersistedCleanCutJob) {
    persisted.job.error_code = None;
    persisted.job.error_message = None;
    let progress = persisted.job.progress;
    set_job_state(state, persisted, CleanCutJobState::Queued, None, progress);
}
