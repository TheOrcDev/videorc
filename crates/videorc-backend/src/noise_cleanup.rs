//! Durable, local, non-destructive Noise Cleanup processing.
//!
//! Renderer requests contain only a session id. This module resolves the current
//! session-owned path, binds work to content and filesystem-object identities, and
//! publishes through the existing no-replace Library file-operation journal.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::entitlements;
use crate::ffmpeg::{default_ffmpeg_path, ffprobe_path_for};
use crate::ffmpeg_work::MaintenanceCancelToken;
use crate::process_job::{output_owned_std, spawn_owned_std};
use crate::protocol::{
    EntitlementsSnapshot, FeatureId, NoiseCleanupCancelParams, NoiseCleanupJob,
    NoiseCleanupJobStatus, NoiseCleanupStartParams,
};
use crate::repair::{MediaProbe, STRICT_AV_SKEW_HARD_FAIL_MS, probe_media_cancellable};
use crate::state::AppState;
use crate::storage::{
    NoiseCleanupSource, PersistedNoiseCleanupJob, SessionFileBoundIdentity, SessionFileOperation,
    SessionMediaPathState, capture_session_file_bound_identity,
    capture_session_file_content_identity_from_file,
    capture_session_file_object_identity_from_file, session_file_bound_identity_matches,
    session_media_path_state,
};

pub const NOISE_CLEANUP_PRESET: &str = "speech-v1";
/// Locked by the deterministic engine probe: conservative stationary-noise
/// reduction without normalization, compression, or any video processing.
pub const SPEECH_V1_FILTER: &str = "afftdn=nr=18:nf=-34:tn=1";

const ERROR_PREMIUM_REQUIRED: &str = "premium-required";
const ERROR_NO_AUDIO: &str = "no-audio";
const ERROR_MULTIPLE_AUDIO: &str = "multiple-audio-tracks";
const ERROR_LIVE: &str = "recording-live";
const ERROR_MISSING: &str = "file-missing";
const ERROR_CHANGED: &str = "source-changed";
const ERROR_IMPORTED: &str = "imported-unsupported";
const ERROR_UNSUPPORTED: &str = "unsupported-recording";
const ERROR_DISK_FULL: &str = "disk-full";
const ERROR_FFMPEG: &str = "ffmpeg-feature-unavailable";
const ERROR_DESTINATION: &str = "destination-not-writable";
const ERROR_VALIDATION: &str = "validation-failed";
const ERROR_PROCESSING: &str = "processing-failed";
const MAX_FFMPEG_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct JobControl {
    user_cancelled: AtomicBool,
    shutdown_interrupted: AtomicBool,
    child_pid: AtomicU32,
    cancelled: Notify,
    finished: Notify,
}

impl JobControl {
    fn new() -> Self {
        Self {
            user_cancelled: AtomicBool::new(false),
            shutdown_interrupted: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            cancelled: Notify::new(),
            finished: Notify::new(),
        }
    }

    fn request_cancel(&self) {
        self.user_cancelled.store(true, Ordering::Release);
        self.cancelled.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.user_cancelled.load(Ordering::Acquire)
    }

    fn is_shutdown_interrupted(&self) -> bool {
        self.shutdown_interrupted.load(Ordering::Acquire)
    }

    fn should_interrupt(&self) -> bool {
        self.is_cancelled() || self.is_shutdown_interrupted()
    }

    fn request_shutdown_interrupt(&self) {
        self.shutdown_interrupted.store(true, Ordering::Release);
        self.cancelled.notify_waiters();
    }
}

#[derive(Debug, Default)]
pub struct NoiseCleanupRegistry {
    jobs: Mutex<HashMap<String, Arc<JobControl>>>,
}

impl NoiseCleanupRegistry {
    fn register(&self, job_id: &str) -> Arc<JobControl> {
        let mut jobs = self.jobs.lock().expect("Noise Cleanup registry poisoned");
        jobs.entry(job_id.to_string())
            .or_insert_with(|| Arc::new(JobControl::new()))
            .clone()
    }

    fn get(&self, job_id: &str) -> Option<Arc<JobControl>> {
        self.jobs
            .lock()
            .expect("Noise Cleanup registry poisoned")
            .get(job_id)
            .cloned()
    }

    fn finish(&self, job_id: &str) {
        if let Some(control) = self
            .jobs
            .lock()
            .expect("Noise Cleanup registry poisoned")
            .remove(job_id)
        {
            control.child_pid.store(0, Ordering::Release);
            control.finished.notify_waiters();
        }
    }

    pub fn interrupt_all_for_shutdown(&self) {
        for control in self
            .jobs
            .lock()
            .expect("Noise Cleanup registry poisoned")
            .values()
        {
            control.request_shutdown_interrupt();
        }
    }
}

#[derive(Debug, Clone)]
struct CleanupFailure {
    code: &'static str,
    message: String,
}

impl CleanupFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerPolicy {
    Mp4,
    Mkv,
}

impl ContainerPolicy {
    fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mkv => "mkv",
        }
    }

    fn audio_codec(self) -> &'static str {
        match self {
            Self::Mp4 => "aac",
            Self::Mkv => "pcm_s16le",
        }
    }
}

#[derive(Debug)]
enum ProcessOutcome {
    Completed {
        output_session_id: String,
        output_path: String,
    },
    CapturePreempted,
    UserCancelled,
    ShutdownInterrupted,
    Failed(CleanupFailure),
}

pub async fn start(
    state: AppState,
    params: NoiseCleanupStartParams,
) -> Result<NoiseCleanupJob, String> {
    start_with_entitlements(state, params, entitlements::current_entitlements()).await
}

async fn start_with_entitlements(
    state: AppState,
    params: NoiseCleanupStartParams,
    snapshot: EntitlementsSnapshot,
) -> Result<NoiseCleanupJob, String> {
    // This is deliberately first: Basic cannot create a job row, staging file,
    // destination probe, or any other media-processing side effect.
    entitlements::require_feature(&snapshot, FeatureId::NoiseCleanup)
        .map_err(|error| error.to_string())?;
    let session_id = params.session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId is required".to_string());
    }

    let source = resolve_source(&state, session_id).map_err(|error| error.message)?;
    let work = state.ffmpeg_work.snapshot();
    if work.capture_active || work.capture_waiting > 0 || work.finalizing_active {
        return Err("Available after the live session ends.".to_string());
    }
    let path = PathBuf::from(
        source
            .media_path
            .as_deref()
            .ok_or_else(|| "The recording file is missing on disk.".to_string())?,
    );
    let identity_path = path.clone();
    let source_identity = tokio::task::spawn_blocking(move || {
        capture_session_file_bound_identity(&identity_path)?
            .context("The recording file is missing on disk.")
    })
    .await
    .map_err(|error| format!("Source identity task failed: {error}"))?
    .map_err(|error| error.to_string())?;
    let persisted = state
        .database
        .create_or_get_noise_cleanup_job(session_id, &source_identity, NOISE_CLEANUP_PRESET)
        .map_err(|error| error.to_string())?;

    if persisted.job.status.is_active() && state.noise_cleanup.get(&persisted.job.id).is_none() {
        spawn_job(state.clone(), persisted.job.id.clone());
    }
    Ok(persisted.job)
}

pub async fn list(state: &AppState) -> Result<Vec<NoiseCleanupJob>, String> {
    let database = state.database.clone();
    tokio::task::spawn_blocking(move || database.list_noise_cleanup_jobs())
        .await
        .map_err(|error| format!("Noise Cleanup list task failed: {error}"))?
        .map_err(|error| error.to_string())
}

pub async fn cancel(
    state: AppState,
    params: NoiseCleanupCancelParams,
) -> Result<NoiseCleanupJob, String> {
    let job_id = params.job_id.trim();
    if job_id.is_empty() {
        return Err("jobId is required".to_string());
    }
    let persisted = state
        .database
        .noise_cleanup_job(job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Noise Cleanup job was not found.".to_string())?;
    if !persisted.job.status.is_active() {
        return Ok(persisted.job);
    }

    if let Some(control) = state.noise_cleanup.get(job_id) {
        control.request_cancel();
        let finished = control.finished.notified();
        if state.noise_cleanup.get(job_id).is_some() {
            let _ = tokio::time::timeout(Duration::from_secs(10), finished).await;
        }
    } else {
        let mut job = persisted.job;
        terminal_job(&state, &mut job, NoiseCleanupJobStatus::Cancelled, None);
    }
    state
        .database
        .noise_cleanup_job(job_id)
        .map_err(|error| error.to_string())?
        .map(|job| job.job)
        .ok_or_else(|| "Noise Cleanup job was not found.".to_string())
}

pub fn resume_interrupted(state: &AppState) {
    match state.database.reconcile_interrupted_noise_cleanup_jobs() {
        Ok(jobs) => {
            for job in jobs {
                state.emit_event("noiseCleanup.status", &job);
                spawn_job(state.clone(), job.id);
            }
        }
        Err(error) => state.emit_log(
            "warn",
            format!("Could not reconcile interrupted Noise Cleanup jobs: {error:#}"),
        ),
    }
}

pub fn session_mutation_blocked(state: &AppState, session_id: &str) -> Result<bool> {
    Ok(state
        .database
        .active_noise_cleanup_job_for_source(session_id)?
        .is_some())
}

fn spawn_job(state: AppState, job_id: String) {
    let control = state.noise_cleanup.register(&job_id);
    tokio::spawn(async move {
        run_job(state.clone(), job_id.clone(), control).await;
        state.noise_cleanup.finish(&job_id);
    });
}

async fn run_job(state: AppState, job_id: String, control: Arc<JobControl>) {
    loop {
        let Some(mut persisted) = state.database.noise_cleanup_job(&job_id).ok().flatten() else {
            return;
        };
        if !persisted.job.status.is_active() {
            return;
        }
        if control.is_shutdown_interrupted() {
            return;
        }
        if control.is_cancelled() {
            terminal_job(
                &state,
                &mut persisted.job,
                NoiseCleanupJobStatus::Cancelled,
                None,
            );
            return;
        }
        if let Err(error) = entitlements::require_feature(
            &entitlements::current_entitlements(),
            FeatureId::NoiseCleanup,
        ) {
            fail_job(
                &state,
                &mut persisted.job,
                CleanupFailure::new(ERROR_PREMIUM_REQUIRED, error.to_string()),
            );
            return;
        }

        set_job_state(&state, &mut persisted.job, NoiseCleanupJobStatus::Queued, 0);
        let permit_future = state.ffmpeg_work.begin_maintenance_when_idle();
        tokio::pin!(permit_future);
        let permit = tokio::select! {
            permit = &mut permit_future => permit,
            _ = control.cancelled.notified() => {
                if control.is_cancelled() {
                    terminal_job(&state, &mut persisted.job, NoiseCleanupJobStatus::Cancelled, None);
                    return;
                }
                if control.is_shutdown_interrupted() {
                    return;
                }
                continue;
            }
        };
        if control.is_shutdown_interrupted() {
            drop(permit);
            return;
        }
        if control.is_cancelled() {
            drop(permit);
            terminal_job(
                &state,
                &mut persisted.job,
                NoiseCleanupJobStatus::Cancelled,
                None,
            );
            return;
        }
        if let Err(error) = entitlements::require_feature(
            &entitlements::current_entitlements(),
            FeatureId::NoiseCleanup,
        ) {
            drop(permit);
            fail_job(
                &state,
                &mut persisted.job,
                CleanupFailure::new(ERROR_PREMIUM_REQUIRED, error.to_string()),
            );
            return;
        }
        let maintenance_cancel = permit.cancel_token();
        if persisted.source_full_sha256 == "pending" {
            match prepare_job_fingerprint(&state, &persisted, &control, &maintenance_cancel).await {
                Ok(true) => {
                    drop(permit);
                    return;
                }
                Ok(false) => {
                    let Some(refreshed) = state.database.noise_cleanup_job(&job_id).ok().flatten()
                    else {
                        drop(permit);
                        return;
                    };
                    persisted = refreshed;
                }
                Err(_) if control.is_shutdown_interrupted() => {
                    drop(permit);
                    return;
                }
                Err(_) if control.is_cancelled() => {
                    drop(permit);
                    terminal_job(
                        &state,
                        &mut persisted.job,
                        NoiseCleanupJobStatus::Cancelled,
                        None,
                    );
                    return;
                }
                Err(_) if maintenance_cancel.is_cancelled() => {
                    drop(permit);
                    set_job_state(&state, &mut persisted.job, NoiseCleanupJobStatus::Queued, 0);
                    continue;
                }
                Err(error) => {
                    drop(permit);
                    fail_job(&state, &mut persisted.job, error);
                    return;
                }
            }
        }
        if let Err(error) = entitlements::require_feature(
            &entitlements::current_entitlements(),
            FeatureId::NoiseCleanup,
        ) {
            drop(permit);
            fail_job(
                &state,
                &mut persisted.job,
                CleanupFailure::new(ERROR_PREMIUM_REQUIRED, error.to_string()),
            );
            return;
        }

        set_job_state(
            &state,
            &mut persisted.job,
            NoiseCleanupJobStatus::Processing,
            1,
        );
        let process_state = state.clone();
        let process_job = persisted.clone();
        let process_control = control.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            process_job_blocking(
                &process_state,
                &process_job,
                &process_control,
                &maintenance_cancel,
            )
        })
        .await;
        drop(permit);

        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => ProcessOutcome::Failed(CleanupFailure::new(
                ERROR_PROCESSING,
                format!("Noise Cleanup worker failed: {error}"),
            )),
        };
        let Some(mut current) = state
            .database
            .noise_cleanup_job(&job_id)
            .ok()
            .flatten()
            .map(|job| job.job)
        else {
            return;
        };
        match outcome {
            ProcessOutcome::Completed {
                output_session_id,
                output_path,
            } => {
                current.output_session_id = Some(output_session_id);
                current.output_path = Some(output_path);
                terminal_job(&state, &mut current, NoiseCleanupJobStatus::Completed, None);
                return;
            }
            ProcessOutcome::CapturePreempted => {
                current.error_code = None;
                current.error_message = None;
                set_job_state(&state, &mut current, NoiseCleanupJobStatus::Queued, 0);
                continue;
            }
            ProcessOutcome::UserCancelled => {
                terminal_job(&state, &mut current, NoiseCleanupJobStatus::Cancelled, None);
                return;
            }
            ProcessOutcome::ShutdownInterrupted => {
                current.error_code = None;
                current.error_message = None;
                set_job_state(&state, &mut current, NoiseCleanupJobStatus::Queued, 0);
                return;
            }
            ProcessOutcome::Failed(error) => {
                fail_job(&state, &mut current, error);
                return;
            }
        }
    }
}

async fn prepare_job_fingerprint(
    state: &AppState,
    persisted: &PersistedNoiseCleanupJob,
    control: &Arc<JobControl>,
    maintenance_cancel: &MaintenanceCancelToken,
) -> std::result::Result<bool, CleanupFailure> {
    let source = resolve_source(state, &persisted.job.source_session_id)?;
    let path = PathBuf::from(
        source
            .media_path
            .as_deref()
            .ok_or_else(|| CleanupFailure::new(ERROR_MISSING, "The recording file is missing."))?,
    );
    let expected = persisted.source_identity.clone();
    let hash_path = path.clone();
    let hash_control = control.clone();
    let hash_maintenance_cancel = maintenance_cancel.clone();
    let full_sha256 = tokio::task::spawn_blocking(move || {
        let current = capture_session_file_bound_identity(&hash_path)?
            .context("The recording file is missing on disk.")?;
        if current != expected {
            bail!("The source recording changed before Noise Cleanup started.");
        }
        let sha256 = full_file_sha256_cancellable(&hash_path, &|| {
            hash_control.should_interrupt() || hash_maintenance_cancel.is_cancelled()
        })?;
        let after = capture_session_file_bound_identity(&hash_path)?
            .context("The recording file disappeared while it was fingerprinted.")?;
        if after != expected {
            bail!("The source recording changed while Noise Cleanup fingerprinted it.");
        }
        Ok(sha256)
    })
    .await
    .map_err(|error| {
        CleanupFailure::new(
            ERROR_PROCESSING,
            format!("Source fingerprint task failed: {error}"),
        )
    })?
    .map_err(|error| CleanupFailure::new(ERROR_CHANGED, error.to_string()))?;

    let completed = state
        .database
        .bind_noise_cleanup_source_fingerprint(&persisted.job.id, &full_sha256)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    let Some(mut completed) = completed else {
        return Ok(false);
    };
    let output_registered = completed
        .output_session_id
        .as_deref()
        .is_some_and(|session_id| {
            state
                .database
                .noise_cleanup_source(session_id)
                .ok()
                .flatten()
                .is_some()
        });
    let output_state = completed
        .output_path
        .as_deref()
        .map(|path| session_media_path_state(Path::new(path)))
        .unwrap_or(SessionMediaPathState::Missing);
    if output_registered
        && matches!(
            output_state,
            SessionMediaPathState::Present | SessionMediaPathState::Unavailable
        )
    {
        let mut current = persisted.job.clone();
        current.output_session_id = completed.output_session_id;
        current.output_path = completed.output_path;
        terminal_job(state, &mut current, NoiseCleanupJobStatus::Completed, None);
        return Ok(true);
    }

    fail_job(
        state,
        &mut completed,
        CleanupFailure::new(ERROR_MISSING, "The cleaned recording is missing on disk."),
    );
    Ok(false)
}

fn process_job_blocking(
    state: &AppState,
    persisted: &PersistedNoiseCleanupJob,
    control: &JobControl,
    maintenance_cancel: &MaintenanceCancelToken,
) -> ProcessOutcome {
    match process_job_inner(state, persisted, control, maintenance_cancel) {
        Ok(completed) => completed,
        Err(_) if control.is_cancelled() => ProcessOutcome::UserCancelled,
        Err(_) if control.is_shutdown_interrupted() => ProcessOutcome::ShutdownInterrupted,
        Err(_) if maintenance_cancel.is_cancelled() => ProcessOutcome::CapturePreempted,
        Err(error) => ProcessOutcome::Failed(error),
    }
}

fn process_job_inner(
    state: &AppState,
    persisted: &PersistedNoiseCleanupJob,
    control: &JobControl,
    maintenance_cancel: &MaintenanceCancelToken,
) -> std::result::Result<ProcessOutcome, CleanupFailure> {
    let cancelled = || control.should_interrupt() || maintenance_cancel.is_cancelled();
    let source = resolve_source(state, &persisted.job.source_session_id)?;
    let source_path = PathBuf::from(
        source
            .media_path
            .as_deref()
            .ok_or_else(|| CleanupFailure::new(ERROR_MISSING, "The recording file is missing."))?,
    );
    require_source_identity_cancellable(
        &source_path,
        &persisted.source_identity,
        &persisted.source_full_sha256,
        &cancelled,
    )?;
    let policy = container_policy(&source_path, source.container.as_deref())?;
    let ffmpeg_path = default_ffmpeg_path();
    let ffprobe_path = ffprobe_path_for(&ffmpeg_path);
    let probe = preflight_media(
        &ffmpeg_path,
        &ffprobe_path,
        &source_path,
        policy,
        &cancelled,
    )?;
    if cancelled() {
        return Ok(cancelled_outcome(control));
    }
    let duration = media_duration(&probe).ok_or_else(|| {
        CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "The recording duration is missing or invalid.",
        )
    })?;
    let destination = first_free_output_path_with(&source_path, |candidate| {
        state
            .database
            .session_media_path_registered(&candidate.display().to_string())
            .unwrap_or(true)
    })?;
    ensure_destination_ready(&destination, source_path.metadata().ok().map(|m| m.len()))?;
    let output_session_id = uuid::Uuid::new_v4().to_string();
    let staging = staging_path_for(&destination, &persisted.job.id);
    let operation = state
        .database
        .begin_session_file_operation("noise-cleanup", &output_session_id, &staging, &destination)
        .map_err(|error| CleanupFailure::new(ERROR_DESTINATION, error.to_string()))?;

    let outcome = run_cleanup_ffmpeg(
        state,
        persisted,
        &operation,
        control,
        maintenance_cancel,
        &ffmpeg_path,
        &source_path,
        &staging,
        policy,
        duration,
    );
    let expected_output = match outcome {
        Ok(identity) => identity,
        Err(outcome) => {
            bind_partial_and_cancel(state, &operation, &staging);
            return Ok(outcome);
        }
    };

    let mut validating_job = state
        .database
        .noise_cleanup_job(&persisted.job.id)
        .ok()
        .flatten()
        .map(|job| job.job)
        .unwrap_or_else(|| persisted.job.clone());
    set_job_state(
        state,
        &mut validating_job,
        NoiseCleanupJobStatus::Validating,
        99,
    );
    if let Err(error) = validate_output(
        &ffmpeg_path,
        &ffprobe_path,
        &source_path,
        &staging,
        &probe,
        policy,
        &cancelled,
    ) {
        bind_partial_and_cancel(state, &operation, &staging);
        if cancelled() {
            return Ok(cancelled_outcome(control));
        }
        return Err(error);
    }
    if let Err(error) = require_source_identity_cancellable(
        &source_path,
        &persisted.source_identity,
        &persisted.source_full_sha256,
        &cancelled,
    ) {
        bind_partial_and_cancel(state, &operation, &staging);
        return Err(error);
    }
    if cancelled() {
        bind_partial_and_cancel(state, &operation, &staging);
        return Ok(cancelled_outcome(control));
    }

    if let Err(error) = publish_identity_bound_file(&staging, &destination, &expected_output) {
        bind_partial_and_cancel(state, &operation, &staging);
        return Err(CleanupFailure::new(ERROR_DESTINATION, error.to_string()));
    }
    let output_path = destination.display().to_string();
    let output_title = format!("{} — Noise Cleaned", source.title.trim());
    let duration_ms = Some((duration * 1000.0) as i64);
    let size = match destination.metadata() {
        Ok(metadata) => metadata.len() as i64,
        Err(error) => {
            let _ = state.database.cancel_session_file_operation(&operation);
            return Err(CleanupFailure::new(ERROR_VALIDATION, error.to_string()));
        }
    };
    let inserted = match state.database.complete_noise_cleanup_derivative(
        &persisted.job.id,
        &source.id,
        &output_session_id,
        &output_title,
        &source.title,
        &output_path,
        policy.extension(),
        duration_ms,
        size,
    ) {
        Ok(inserted) => inserted,
        Err(error) => {
            let _ = state.database.cancel_session_file_operation(&operation);
            return Err(CleanupFailure::new(ERROR_PROCESSING, error.to_string()));
        }
    };
    if !inserted {
        let _ = state.database.cancel_session_file_operation(&operation);
        return Err(CleanupFailure::new(
            ERROR_CHANGED,
            "The source session disappeared before the cleaned copy was registered.",
        ));
    }
    if let Err(error) = state.database.finish_session_file_operation(&operation.id) {
        state.emit_log(
            "warn",
            format!(
                "Noise Cleanup output was committed, but operation {} remains for startup reconciliation: {error:#}",
                operation.id
            ),
        );
    }
    Ok(ProcessOutcome::Completed {
        output_session_id,
        output_path,
    })
}

fn resolve_source(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<NoiseCleanupSource, CleanupFailure> {
    let source = state
        .database
        .noise_cleanup_source(session_id)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?
        .ok_or_else(|| CleanupFailure::new(ERROR_MISSING, "Session not found."))?;
    if source.status != "completed" {
        return Err(CleanupFailure::new(
            ERROR_LIVE,
            "Noise Cleanup is available only after the recording finishes.",
        ));
    }
    if source.mode == "imported" {
        return Err(CleanupFailure::new(
            ERROR_IMPORTED,
            "Imported recordings are not supported by Noise Cleanup v1.",
        ));
    }
    if source.processing_kind.as_deref() == Some("noise-cleanup")
        || source.derived_from_session_id.is_some()
    {
        return Err(CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "A Noise Cleaned recording cannot be cleaned again.",
        ));
    }
    if !matches!(source.mode.as_str(), "record" | "record+stream") {
        return Err(CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "Only finalized Videorc recordings are supported.",
        ));
    }
    if source.sources.test_pattern {
        return Err(CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "Test-tone recordings are not supported by Noise Cleanup.",
        ));
    }
    if source.sources.microphone_id.is_none() {
        return Err(CleanupFailure::new(
            ERROR_NO_AUDIO,
            "This recording has no selected microphone to clean.",
        ));
    }
    let Some(path) = source.media_path.as_deref() else {
        return Err(CleanupFailure::new(
            ERROR_MISSING,
            "The recording file is missing on disk.",
        ));
    };
    if !Path::new(path).is_file() {
        return Err(CleanupFailure::new(
            ERROR_MISSING,
            "The recording file is missing on disk.",
        ));
    }
    Ok(source)
}

fn container_policy(
    path: &Path,
    declared_container: Option<&str>,
) -> std::result::Result<ContainerPolicy, CleanupFailure> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("mp4") if declared_container.is_none_or(|value| value == "mp4" || value == "mkv") => {
            // A Videorc MKV session may have a later managed MP4 remux; the visible
            // MP4 path is authoritative and receives the exact MP4 codec policy.
            Ok(ContainerPolicy::Mp4)
        }
        Some("mkv") if declared_container.is_none_or(|value| value == "mkv") => {
            Ok(ContainerPolicy::Mkv)
        }
        _ => Err(CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "Noise Cleanup v1 supports only finalized Videorc MP4 and MKV recordings.",
        )),
    }
}

fn preflight_media(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    source: &Path,
    policy: ContainerPolicy,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<MediaProbe, CleanupFailure> {
    require_ffmpeg_capabilities(ffmpeg_path, policy)?;
    let probe = probe_media_cancellable(ffprobe_path, &source.display().to_string(), is_cancelled)
        .map_err(|error| CleanupFailure::new(ERROR_FFMPEG, error))?;
    if probe.video.is_none() {
        return Err(CleanupFailure::new(
            ERROR_UNSUPPORTED,
            "This recording does not contain a video stream.",
        ));
    }
    match probe.audio.len() {
        0 => Err(CleanupFailure::new(
            ERROR_NO_AUDIO,
            "This recording has no audio stream to clean.",
        )),
        1 => Ok(probe),
        _ => Err(CleanupFailure::new(
            ERROR_MULTIPLE_AUDIO,
            "Recordings with multiple audio tracks are not supported by Noise Cleanup v1.",
        )),
    }
}

fn require_ffmpeg_capabilities(
    ffmpeg_path: &str,
    policy: ContainerPolicy,
) -> std::result::Result<(), CleanupFailure> {
    let mut filters_command = Command::new(ffmpeg_path);
    filters_command
        .args(["-hide_banner", "-filters"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let filters = output_owned_std(&mut filters_command)
        .map_err(|error| CleanupFailure::new(ERROR_FFMPEG, error.to_string()))?;
    let filters_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&filters.stdout),
        String::from_utf8_lossy(&filters.stderr)
    );
    if !filters.status.success() || !filters_text.lines().any(|line| line.contains(" afftdn ")) {
        return Err(CleanupFailure::new(
            ERROR_FFMPEG,
            "The bundled FFmpeg does not provide the required afftdn filter.",
        ));
    }
    let mut encoders_command = Command::new(ffmpeg_path);
    encoders_command
        .args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let encoders = output_owned_std(&mut encoders_command)
        .map_err(|error| CleanupFailure::new(ERROR_FFMPEG, error.to_string()))?;
    let encoder_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&encoders.stdout),
        String::from_utf8_lossy(&encoders.stderr)
    );
    let needle = format!(" {} ", policy.audio_codec());
    if !encoders.status.success() || !encoder_text.lines().any(|line| line.contains(&needle)) {
        return Err(CleanupFailure::new(
            ERROR_FFMPEG,
            format!(
                "The bundled FFmpeg does not provide the required {} audio encoder.",
                policy.audio_codec()
            ),
        ));
    }
    Ok(())
}

pub fn build_ffmpeg_args(
    input: &Path,
    output: &Path,
    container: &str,
) -> std::result::Result<Vec<String>, String> {
    let policy = match container {
        "mp4" => ContainerPolicy::Mp4,
        "mkv" => ContainerPolicy::Mkv,
        _ => return Err(format!("Unsupported Noise Cleanup container: {container}")),
    };
    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-n".to_string(),
        "-i".to_string(),
        input.display().to_string(),
        "-map".to_string(),
        "0".to_string(),
        "-map_metadata".to_string(),
        "0".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        policy.audio_codec().to_string(),
    ];
    if policy == ContainerPolicy::Mp4 {
        args.extend(["-b:a".to_string(), "192k".to_string()]);
    }
    args.extend([
        "-af".to_string(),
        SPEECH_V1_FILTER.to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        output.display().to_string(),
    ]);
    Ok(args)
}

#[allow(clippy::too_many_arguments)]
fn run_cleanup_ffmpeg(
    state: &AppState,
    persisted: &PersistedNoiseCleanupJob,
    operation: &SessionFileOperation,
    control: &JobControl,
    maintenance_cancel: &MaintenanceCancelToken,
    ffmpeg_path: &str,
    source: &Path,
    staging: &Path,
    policy: ContainerPolicy,
    duration_seconds: f64,
) -> std::result::Result<SessionFileBoundIdentity, ProcessOutcome> {
    let args = build_ffmpeg_args(source, staging, policy.extension()).map_err(|message| {
        ProcessOutcome::Failed(CleanupFailure::new(ERROR_PROCESSING, message))
    })?;
    let mut command = Command::new(ffmpeg_path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_std(&mut command).map_err(|error| {
        ProcessOutcome::Failed(CleanupFailure::new(ERROR_PROCESSING, error.to_string()))
    })?;
    control
        .child_pid
        .store(child.id(), std::sync::atomic::Ordering::Release);
    let stdout = child.stdout.take().expect("piped Noise Cleanup stdout");
    let stderr = child.stderr.take().expect("piped Noise Cleanup stderr");
    let (progress_tx, progress_rx) = std::sync::mpsc::channel::<String>();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = progress_tx.send(line);
        }
    });
    let stderr_reader = thread::spawn(move || read_bounded_tail(stderr, MAX_FFMPEG_STDERR_BYTES));
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_progress = 1_u8;
    let status = loop {
        if control.should_interrupt() || maintenance_cancel.is_cancelled() {
            let _ = child.kill();
            let status = child.wait().ok();
            break status;
        }
        while let Ok(line) = progress_rx.try_recv() {
            if let Some(progress) = parse_progress_line(&line, duration_seconds)
                && progress > last_progress
                && (last_emit.elapsed() >= Duration::from_millis(250) || progress >= 98)
            {
                last_progress = progress;
                last_emit = Instant::now();
                if let Some(mut job) = state
                    .database
                    .noise_cleanup_job(&persisted.job.id)
                    .ok()
                    .flatten()
                    .map(|job| job.job)
                {
                    set_job_state(state, &mut job, NoiseCleanupJobStatus::Processing, progress);
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                control.child_pid.store(0, Ordering::Release);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProcessOutcome::Failed(CleanupFailure::new(
                    ERROR_PROCESSING,
                    format!("Could not wait for FFmpeg: {error}"),
                )));
            }
        }
    };
    control.child_pid.store(0, Ordering::Release);
    let _ = stdout_reader.join();
    let stderr = stderr_reader.join().unwrap_or_default();
    if control.is_cancelled() {
        return Err(ProcessOutcome::UserCancelled);
    }
    if control.is_shutdown_interrupted() {
        return Err(ProcessOutcome::ShutdownInterrupted);
    }
    if maintenance_cancel.is_cancelled() {
        return Err(ProcessOutcome::CapturePreempted);
    }
    if !status.is_some_and(|status| status.success()) {
        return Err(ProcessOutcome::Failed(CleanupFailure::new(
            ERROR_PROCESSING,
            format!(
                "FFmpeg could not clean this recording: {}",
                String::from_utf8_lossy(&stderr).trim()
            ),
        )));
    }

    bind_completed_operation(state, operation, staging).map_err(ProcessOutcome::Failed)
}

fn read_bounded_tail(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut tail = Vec::with_capacity(limit.min(8 * 1024));
    let mut chunk = [0_u8; 8 * 1024];
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > limit {
            tail.drain(..tail.len() - limit);
        }
    }
    tail
}

fn parse_progress_line(line: &str, duration_seconds: f64) -> Option<u8> {
    let (key, value) = line.trim().split_once('=')?;
    if !matches!(key, "out_time_us" | "out_time_ms") || duration_seconds <= 0.0 {
        return None;
    }
    let micros = value.parse::<f64>().ok()?;
    let percent = ((micros / 1_000_000.0) / duration_seconds * 100.0)
        .floor()
        .clamp(1.0, 98.0);
    Some(percent as u8)
}

fn validate_output(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    source_path: &Path,
    output_path: &Path,
    source_probe: &MediaProbe,
    policy: ContainerPolicy,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<(), CleanupFailure> {
    let output = probe_media_cancellable(
        ffprobe_path,
        &output_path.display().to_string(),
        is_cancelled,
    )
    .map_err(|error| CleanupFailure::new(ERROR_VALIDATION, error))?;
    let source_video = source_probe.video.as_ref().expect("preflight video");
    let output_video = output.video.as_ref().ok_or_else(|| {
        CleanupFailure::new(ERROR_VALIDATION, "Cleaned output has no video stream.")
    })?;
    if output.audio.len() != 1 {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "Cleaned output does not contain exactly one audio stream.",
        ));
    }
    let output_audio = &output.audio[0];
    if output_audio.codec != policy.audio_codec()
        || output_audio.channels != source_probe.audio[0].channels
        || output_audio.sample_rate != source_probe.audio[0].sample_rate
    {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "Cleaned audio codec, channel count, or sample rate is incorrect.",
        ));
    }
    if source_video.codec != output_video.codec
        || source_video.width != output_video.width
        || source_video.height != output_video.height
        || source_video.nb_frames != output_video.nb_frames
        || !nearly_equal(source_video.avg_fps, output_video.avg_fps, 0.001)
    {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "The cleaned output did not preserve the source video stream shape.",
        ));
    }
    let source_duration = media_duration(source_probe).unwrap_or_default();
    let output_duration = media_duration(&output).unwrap_or_default();
    if source_duration <= 0.0
        || output_duration <= 0.0
        || (source_duration - output_duration).abs() * 1000.0 > STRICT_AV_SKEW_HARD_FAIL_MS
    {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "The cleaned output duration or A/V alignment changed beyond tolerance.",
        ));
    }
    if output_av_skew_ms(&output).is_some_and(|skew| skew > STRICT_AV_SKEW_HARD_FAIL_MS) {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "The cleaned output A/V skew exceeds the recording analyzer tolerance.",
        ));
    }
    let source_hash = video_stream_hash(ffmpeg_path, source_path, is_cancelled)?;
    let output_hash = video_stream_hash(ffmpeg_path, output_path, is_cancelled)?;
    if source_hash != output_hash {
        return Err(CleanupFailure::new(
            ERROR_VALIDATION,
            "The cleaned output video packets differ from the source.",
        ));
    }
    decode_audio(ffmpeg_path, output_path, is_cancelled)
}

fn video_stream_hash(
    ffmpeg_path: &str,
    path: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<Vec<u8>, CleanupFailure> {
    run_output_cancellable(
        Command::new(ffmpeg_path).args([
            "-v",
            "error",
            "-i",
            &path.display().to_string(),
            "-map",
            "0:v",
            "-c",
            "copy",
            "-f",
            "streamhash",
            "-hash",
            "sha256",
            "-",
        ]),
        is_cancelled,
    )
    .and_then(|output| {
        output
            .status
            .success()
            .then_some(output.stdout)
            .ok_or_else(|| {
                CleanupFailure::new(
                    ERROR_VALIDATION,
                    format!(
                        "Could not hash video packets: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ),
                )
            })
    })
}

fn decode_audio(
    ffmpeg_path: &str,
    path: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<(), CleanupFailure> {
    let output = run_output_cancellable(
        Command::new(ffmpeg_path).args([
            "-v",
            "error",
            "-i",
            &path.display().to_string(),
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
        ]),
        is_cancelled,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CleanupFailure::new(
            ERROR_VALIDATION,
            format!(
                "Cleaned audio could not be decoded: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

fn run_output_cancellable(
    command: &mut Command,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<std::process::Output, CleanupFailure> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_owned_std(command)
        .map_err(|error| CleanupFailure::new(ERROR_VALIDATION, error.to_string()))?;
    loop {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CleanupFailure::new(
                ERROR_PROCESSING,
                "Noise Cleanup was cancelled.",
            ));
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| CleanupFailure::new(ERROR_VALIDATION, error.to_string()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                let _ = child.kill();
                return Err(CleanupFailure::new(ERROR_VALIDATION, error.to_string()));
            }
        }
    }
}

#[cfg(test)]
fn require_source_identity(
    source: &Path,
    expected: &SessionFileBoundIdentity,
    expected_full_sha256: &str,
) -> std::result::Result<(), CleanupFailure> {
    require_source_identity_cancellable(source, expected, expected_full_sha256, &|| false)
}

fn require_source_identity_cancellable(
    source: &Path,
    expected: &SessionFileBoundIdentity,
    expected_full_sha256: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> std::result::Result<(), CleanupFailure> {
    if is_cancelled() {
        return Err(CleanupFailure::new(
            ERROR_PROCESSING,
            "Noise Cleanup identity validation was interrupted.",
        ));
    }
    let current = capture_session_file_bound_identity(source)
        .map_err(|error| CleanupFailure::new(ERROR_CHANGED, error.to_string()))?;
    let bound_matches = current.as_ref().is_some_and(|current| {
        session_file_bound_identity_matches(
            current,
            &expected.content_identity,
            Some(&expected.object_identity),
        )
    });
    let full_matches = bound_matches
        && full_file_sha256_cancellable(source, is_cancelled)
            .is_ok_and(|sha256| sha256 == expected_full_sha256);
    if full_matches && !is_cancelled() {
        Ok(())
    } else {
        Err(CleanupFailure::new(
            ERROR_CHANGED,
            "The source recording changed while Noise Cleanup was running.",
        ))
    }
}

#[cfg(test)]
fn full_file_sha256(path: &Path) -> Result<String> {
    full_file_sha256_cancellable(path, &|| false)
}

fn full_file_sha256_cancellable(path: &Path, is_cancelled: &dyn Fn() -> bool) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("Could not open source recording {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if is_cancelled() {
            bail!("Source fingerprinting was interrupted.");
        }
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("Could not fingerprint {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn bind_partial_and_cancel(state: &AppState, operation: &SessionFileOperation, staging: &Path) {
    if let Ok(mut file) = OpenOptions::new().read(true).write(true).open(staging) {
        if let Ok(object) = capture_session_file_object_identity_from_file(&file, staging) {
            let _ = state
                .database
                .bind_session_file_operation_object_identity(&operation.id, &object);
        }
        if let Ok(content) = capture_session_file_content_identity_from_file(&mut file, staging) {
            let _ = state
                .database
                .bind_session_file_operation_content_identity(&operation.id, &content);
        }
    }
    if let Err(error) = state.database.cancel_session_file_operation(operation) {
        state.emit_log(
            "warn",
            format!(
                "Could not reconcile cancelled Noise Cleanup staging operation {}: {error:#}",
                operation.id
            ),
        );
    }
}

fn publish_identity_bound_file(
    staging: &Path,
    destination: &Path,
    expected: &SessionFileBoundIdentity,
) -> Result<()> {
    crate::session_ops::rename_session_file_no_replace(staging, destination)?;
    crate::session_ops::sync_session_file_parent(destination)?;
    if capture_session_file_bound_identity(destination)?.is_some_and(|actual| {
        session_file_bound_identity_matches(
            &actual,
            &expected.content_identity,
            Some(&expected.object_identity),
        )
    }) {
        return Ok(());
    }
    if crate::session_ops::rename_session_file_no_replace(destination, staging).is_ok() {
        let _ = crate::session_ops::sync_session_file_parent(staging);
    }
    bail!("Noise Cleanup staging bytes changed during publication.")
}

fn bind_completed_operation(
    state: &AppState,
    operation: &SessionFileOperation,
    staging: &Path,
) -> std::result::Result<SessionFileBoundIdentity, CleanupFailure> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(staging)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    file.sync_all()
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    let object_identity = capture_session_file_object_identity_from_file(&file, staging)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    state
        .database
        .bind_session_file_operation_object_identity(&operation.id, &object_identity)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    let content_identity = capture_session_file_content_identity_from_file(&mut file, staging)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    state
        .database
        .bind_session_file_operation_content_identity(&operation.id, &content_identity)
        .map_err(|error| CleanupFailure::new(ERROR_PROCESSING, error.to_string()))?;
    Ok(SessionFileBoundIdentity {
        content_identity,
        object_identity,
    })
}

#[cfg(test)]
fn first_free_output_path(source: &Path) -> std::result::Result<PathBuf, CleanupFailure> {
    first_free_output_path_with(source, |_| false)
}

fn first_free_output_path_with(
    source: &Path,
    mut is_registered: impl FnMut(&Path) -> bool,
) -> std::result::Result<PathBuf, CleanupFailure> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Recording");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    for attempt in 0..10_000 {
        let suffix = if attempt == 0 {
            " — Noise Cleaned".to_string()
        } else {
            format!(" — Noise Cleaned {}", attempt + 1)
        };
        let candidate = source.with_file_name(format!("{stem}{suffix}.{extension}"));
        if !candidate.exists() && !is_registered(&candidate) {
            return Ok(candidate);
        }
    }
    Err(CleanupFailure::new(
        ERROR_DESTINATION,
        "Could not find a free Noise Cleaned filename.",
    ))
}

fn staging_path_for(destination: &Path, job_id: &str) -> PathBuf {
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    destination.with_file_name(format!(".{stem}.{job_id}.videorc-partial.{extension}"))
}

fn ensure_destination_ready(
    destination: &Path,
    source_size: Option<u64>,
) -> std::result::Result<(), CleanupFailure> {
    let parent = destination.parent().ok_or_else(|| {
        CleanupFailure::new(ERROR_DESTINATION, "The destination folder is invalid.")
    })?;
    let probe = parent.join(format!(
        ".videorc-noise-cleanup-write-{}",
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&probe).map_err(|error| {
        CleanupFailure::new(
            ERROR_DESTINATION,
            format!("The recording folder is not writable: {error}"),
        )
    })?;
    let _ = file.sync_all();
    drop(file);
    let _ = std::fs::remove_file(&probe);

    if let (Some(required), Some(available)) = (source_size, available_space(parent))
        && !has_cleanup_space(required, available)
    {
        return Err(CleanupFailure::new(
            ERROR_DISK_FULL,
            "There is not enough free disk space to create a cleaned copy.",
        ));
    }
    Ok(())
}

fn has_cleanup_space(source_size: u64, available: u64) -> bool {
    let required = source_size
        .saturating_add(source_size / 4)
        .saturating_add(64 * 1024 * 1024);
    available >= required
}

#[cfg(unix)]
fn available_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    let stats = unsafe { stats.assume_init() };
    Some(stats.f_bavail.saturating_mul(stats.f_frsize))
}

#[cfg(target_os = "windows")]
fn available_space(path: &Path) -> Option<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;

    let path = crate::atomic_file::windows_verbatim_path(path).ok()?;
    let mut available = 0_u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None) }.ok()?;
    Some(available)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn available_space(_path: &Path) -> Option<u64> {
    None
}

fn media_duration(probe: &MediaProbe) -> Option<f64> {
    probe
        .format_duration
        .or_else(|| probe.video.as_ref().and_then(|video| video.duration))
        .filter(|duration| duration.is_finite() && *duration > 0.0)
}

fn output_av_skew_ms(probe: &MediaProbe) -> Option<f64> {
    let video = probe.video.as_ref()?;
    let audio = probe.audio.first()?;
    let mut skew = match (video.start_time, audio.start_time) {
        (Some(video), Some(audio)) => Some((video - audio).abs() * 1000.0),
        _ => None,
    };
    if let (Some(video), Some(audio)) = (video.duration, audio.duration) {
        let delayed_audio = (video - audio).max(0.0) * 1000.0;
        skew = Some(skew.map_or(delayed_audio, |current| current.max(delayed_audio)));
    }
    skew
}

fn nearly_equal(left: Option<f64>, right: Option<f64>, tolerance: f64) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => (left - right).abs() <= tolerance,
        (None, None) => true,
        _ => false,
    }
}

fn cancelled_outcome(control: &JobControl) -> ProcessOutcome {
    if control.is_cancelled() {
        ProcessOutcome::UserCancelled
    } else if control.is_shutdown_interrupted() {
        ProcessOutcome::ShutdownInterrupted
    } else {
        ProcessOutcome::CapturePreempted
    }
}

fn set_job_state(
    state: &AppState,
    job: &mut NoiseCleanupJob,
    status: NoiseCleanupJobStatus,
    progress: u8,
) {
    job.status = status;
    job.progress_percent = progress.min(100);
    job.updated_at = Utc::now().to_rfc3339();
    if let Err(error) = state.database.save_noise_cleanup_job(job) {
        state.emit_log(
            "error",
            format!("Could not persist Noise Cleanup job {}: {error:#}", job.id),
        );
        return;
    }
    state.emit_event("noiseCleanup.status", &*job);
}

fn terminal_job(
    state: &AppState,
    job: &mut NoiseCleanupJob,
    status: NoiseCleanupJobStatus,
    failure: Option<CleanupFailure>,
) {
    if let Some(failure) = failure {
        job.error_code = Some(failure.code.to_string());
        job.error_message = Some(failure.message);
    } else {
        job.error_code = None;
        job.error_message = None;
    }
    let progress = if status == NoiseCleanupJobStatus::Completed {
        100
    } else {
        job.progress_percent
    };
    set_job_state(state, job, status, progress);
}

fn fail_job(state: &AppState, job: &mut NoiseCleanupJob, failure: CleanupFailure) {
    terminal_job(state, job, NoiseCleanupJobStatus::Failed, Some(failure));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entitlements;
    use crate::protocol::{
        OutputSettings, RtmpPreset, RtmpSettings, SourceSelection, VideoPreset, VideoSettings,
        default_layout_settings,
    };
    use crate::storage::{Database, NewSession};
    use tokio::sync::broadcast;

    #[test]
    fn speech_v1_is_locked_to_the_probed_conservative_filter() {
        assert_eq!(NOISE_CLEANUP_PRESET, "speech-v1");
        assert_eq!(SPEECH_V1_FILTER, "afftdn=nr=18:nf=-34:tn=1");
    }

    #[test]
    fn exact_container_args_copy_video_and_encode_only_audio() {
        let mp4 = build_ffmpeg_args(Path::new("in.mp4"), Path::new("out.mp4"), "mp4").unwrap();
        assert!(mp4.windows(2).any(|pair| pair == ["-c", "copy"]));
        assert!(mp4.windows(2).any(|pair| pair == ["-loglevel", "error"]));
        assert!(mp4.iter().any(|arg| arg == "-hide_banner"));
        assert!(mp4.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(mp4.windows(2).any(|pair| pair == ["-b:a", "192k"]));
        assert!(mp4.windows(2).any(|pair| pair == ["-af", SPEECH_V1_FILTER]));
        assert!(mp4.windows(2).any(|pair| pair == ["-progress", "pipe:1"]));
        assert!(
            !mp4.iter()
                .any(|arg| arg == "-vf" || arg == "-filter_complex")
        );

        let mkv = build_ffmpeg_args(Path::new("in.mkv"), Path::new("out.mkv"), "mkv").unwrap();
        assert!(mkv.windows(2).any(|pair| pair == ["-c:a", "pcm_s16le"]));
        assert!(!mkv.iter().any(|arg| arg == "192k"));
        assert!(build_ffmpeg_args(Path::new("in.mov"), Path::new("out.mov"), "mov").is_err());
        assert_eq!(
            container_policy(Path::new("legacy.mkv"), None).unwrap(),
            ContainerPolicy::Mkv
        );
    }

    #[test]
    fn progress_is_duration_based_and_capped_before_validation() {
        assert_eq!(parse_progress_line("out_time_us=5000000", 10.0), Some(50));
        assert_eq!(parse_progress_line("out_time_ms=20000000", 10.0), Some(98));
        assert_eq!(parse_progress_line("progress=continue", 10.0), None);
    }

    #[test]
    fn disk_space_policy_requires_source_plus_conservative_headroom() {
        let source = 100 * 1024 * 1024;
        let required = source + source / 4 + 64 * 1024 * 1024;
        assert!(!has_cleanup_space(source, required - 1));
        assert!(has_cleanup_space(source, required));
    }

    #[test]
    fn ffmpeg_stderr_tail_is_strictly_bounded() {
        let bytes = (0..100_000)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let tail = read_bounded_tail(std::io::Cursor::new(&bytes), 64 * 1024);
        assert_eq!(tail.len(), 64 * 1024);
        assert_eq!(tail, bytes[bytes.len() - 64 * 1024..]);
    }

    #[test]
    fn output_names_are_non_destructive_and_count_collisions() {
        let base =
            std::env::temp_dir().join(format!("videorc-cleanup-name-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let source = base.join("Recording.mp4");
        std::fs::write(&source, b"source").unwrap();
        let first = first_free_output_path(&source).unwrap();
        assert_eq!(first.file_name().unwrap(), "Recording — Noise Cleaned.mp4");
        std::fs::write(&first, b"existing").unwrap();
        let second = first_free_output_path(&source).unwrap();
        assert_eq!(
            second.file_name().unwrap(),
            "Recording — Noise Cleaned 2.mp4"
        );
        std::fs::remove_file(&first).unwrap();
        let reserved =
            first_free_output_path_with(&source, |candidate| candidate == first.as_path()).unwrap();
        assert_eq!(
            reserved, second,
            "DB-owned missing paths must remain reserved"
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        let _ = std::fs::remove_dir_all(base);
    }

    fn test_state(database: Database) -> AppState {
        let (events, _) = broadcast::channel(32);
        AppState::new("test-token".to_string(), 0, events, database)
    }

    fn completed_recording(
        id: &str,
        path: &Path,
        mode: &str,
        microphone_id: Option<String>,
    ) -> NewSession {
        NewSession {
            id: id.to_string(),
            title: "Source title".to_string(),
            started_at: Utc::now().to_rfc3339(),
            mode: mode.to_string(),
            output_path: None,
            container: Some("mp4".to_string()),
            stream_preset: None,
            sources: SourceSelection {
                screen_id: Some("screen:1".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id,
                test_pattern: false,
            },
            layout: default_layout_settings(),
            output: OutputSettings {
                keep_original_mkv: false,
                record_enabled: true,
                stream_enabled: false,
                output_directory: path.parent().map(|path| path.display().to_string()),
                ffmpeg_path: None,
                video: VideoSettings {
                    preset: VideoPreset::Tutorial1080p30,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 6000,
                },
                rtmp: RtmpSettings {
                    preset: RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        }
    }

    #[tokio::test]
    async fn basic_gate_rejects_before_creating_a_job() {
        let state = test_state(Database::open_in_memory_for_tests());
        let result = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "missing".to_string(),
            },
            entitlements::basic_entitlements(),
        )
        .await;
        assert!(result.unwrap_err().contains("Premium"));
        assert!(state.database.list_noise_cleanup_jobs().unwrap().is_empty());
    }

    #[test]
    fn durable_jobs_are_idempotent_resume_queued_and_rollback_owned_publication() {
        let base =
            std::env::temp_dir().join(format!("videorc-cleanup-durable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        let source_bytes = vec![0x51; 160 * 1024];
        std::fs::write(&source_path, &source_bytes).unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(source_bytes.len() as i64),
            )
            .unwrap();
        let identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source_path).unwrap();
        let first = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        let second = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        assert_eq!(
            first.job.id, second.job.id,
            "duplicate start must be idempotent"
        );

        let mut interrupted = first.job.clone();
        interrupted.status = NoiseCleanupJobStatus::Processing;
        interrupted.progress_percent = 47;
        interrupted.updated_at = Utc::now().to_rfc3339();
        database.save_noise_cleanup_job(&interrupted).unwrap();
        let resumed = database.reconcile_interrupted_noise_cleanup_jobs().unwrap();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].status, NoiseCleanupJobStatus::Queued);
        assert_eq!(resumed[0].progress_percent, 0);
        assert!(
            database
                .bind_noise_cleanup_source_fingerprint(&first.job.id, &full_sha256)
                .unwrap()
                .is_none()
        );

        let staging = base.join(".cleaned.partial.mp4");
        let published = base.join("cleaned.mp4");
        let operation = database
            .begin_session_file_operation("noise-cleanup", "derivative", &staging, &published)
            .unwrap();
        std::fs::write(&staging, b"owned cleaned bytes").unwrap();
        let state = test_state(database.clone());
        let ownership = bind_completed_operation(&state, &operation, &staging).unwrap();
        publish_identity_bound_file(&staging, &published, &ownership).unwrap();
        assert!(published.exists());
        database.cancel_session_file_operation(&operation).unwrap();
        assert!(
            !published.exists(),
            "row-less exact owned final must roll back"
        );
        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);

        let committed_staging = base.join(".committed.partial.mp4");
        let committed_operation = database
            .begin_session_file_operation(
                "noise-cleanup",
                "derivative",
                &committed_staging,
                &published,
            )
            .unwrap();
        std::fs::write(&committed_staging, b"validated derivative").unwrap();
        let ownership =
            bind_completed_operation(&state, &committed_operation, &committed_staging).unwrap();
        publish_identity_bound_file(&committed_staging, &published, &ownership).unwrap();
        assert!(
            database
                .complete_noise_cleanup_derivative(
                    &first.job.id,
                    "source",
                    "derivative",
                    "Source title — Noise Cleaned",
                    "Source title",
                    published.to_str().unwrap(),
                    "mp4",
                    Some(1000),
                    20,
                )
                .unwrap()
        );
        // Simulate a crash after the atomic derivative/job commit but before
        // the file-operation journal was retired. Completed work must not be
        // requeued or produce a numbered duplicate; startup retains the exact
        // row/file pair and removes only the redundant journal.
        assert!(
            database
                .reconcile_interrupted_noise_cleanup_jobs()
                .unwrap()
                .is_empty()
        );
        let reconciliation = database.reconcile_session_file_operations().unwrap();
        assert_eq!(reconciliation.published, 1);
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            database
                .noise_cleanup_job(&first.job.id)
                .unwrap()
                .unwrap()
                .job
                .status,
            NoiseCleanupJobStatus::Completed
        );
        let derivative = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .find(|session| session.id == "derivative")
            .unwrap();
        assert_eq!(
            derivative.derived_from_session_id.as_deref(),
            Some("source")
        );
        assert_eq!(derivative.source_title.as_deref(), Some("Source title"));
        assert_eq!(derivative.processing_kind.as_deref(), Some("noise-cleanup"));
        assert!(derivative.ai_artifacts.is_empty());
        assert_eq!(derivative.comment_count, 0);
        let duplicate_path = base.join("cleaned copy.mp4");
        std::fs::write(&duplicate_path, b"duplicate derivative").unwrap();
        assert!(
            database
                .clone_session_row(
                    "derivative",
                    "derivative-copy",
                    "Source title — Noise Cleaned (copy)",
                    None,
                    Some(duplicate_path.to_str().unwrap()),
                    &Utc::now().to_rfc3339(),
                    Some(20),
                )
                .unwrap()
        );
        let derivative_copy = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .find(|session| session.id == "derivative-copy")
            .unwrap();
        assert_eq!(
            derivative_copy.derived_from_session_id.as_deref(),
            Some("source")
        );
        assert_eq!(
            derivative_copy.source_title.as_deref(),
            Some("Source title")
        );
        assert_eq!(
            derivative_copy.processing_kind.as_deref(),
            Some("noise-cleanup")
        );
        let deletions = database
            .prepare_session_deletions(&["source".to_string()])
            .unwrap();
        for path in &deletions[0].paths {
            std::fs::remove_file(path).unwrap();
        }
        let completion = database
            .complete_session_deletion(&deletions[0].operation_id, &[])
            .unwrap();
        assert!(completion.deleted);
        let derivative = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .find(|session| session.id == "derivative")
            .unwrap();
        assert_eq!(derivative.derived_from_session_id, None);
        assert_eq!(derivative.source_title.as_deref(), Some("Source title"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn queued_cancel_is_terminal_and_does_not_touch_source() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-queued-cancel-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        std::fs::write(&source_path, b"source remains untouched").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(24),
            )
            .unwrap();
        let state = test_state(database);
        let maintenance = state.ffmpeg_work.try_begin_maintenance().unwrap();
        let job = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        assert!(session_mutation_blocked(&state, "source").unwrap());
        let cancelled = cancel(state.clone(), NoiseCleanupCancelParams { job_id: job.id })
            .await
            .unwrap();
        assert!(!session_mutation_blocked(&state, "source").unwrap());
        let retry = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        assert_ne!(
            retry.id, cancelled.id,
            "cancelled jobs must never block Retry"
        );
        let retry = cancel(state.clone(), NoiseCleanupCancelParams { job_id: retry.id })
            .await
            .unwrap();
        assert_eq!(retry.status, NoiseCleanupJobStatus::Cancelled);
        drop(maintenance);
        assert_eq!(cancelled.status, NoiseCleanupJobStatus::Cancelled);
        assert_eq!(
            std::fs::read(&source_path).unwrap(),
            b"source remains untouched"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn shutdown_interruption_keeps_queued_job_restart_resumable() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-shutdown-resume-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        std::fs::write(&source_path, b"durable queued source").unwrap();
        let database_path = base.join("videorc.sqlite3");
        let database = Database::open_file_for_tests(&database_path);
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(21),
            )
            .unwrap();
        let state = test_state(database.clone());
        let maintenance = state.ffmpeg_work.try_begin_maintenance().unwrap();
        let job = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        state.noise_cleanup.interrupt_all_for_shutdown();
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.noise_cleanup.get(&job.id).is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("queued worker did not stop for shutdown");
        assert_eq!(
            database
                .noise_cleanup_job(&job.id)
                .unwrap()
                .unwrap()
                .job
                .status,
            NoiseCleanupJobStatus::Queued
        );
        drop(maintenance);
        drop(state);
        drop(database);
        let reopened = Database::open_file_for_tests(&database_path);
        let resumable = reopened.reconcile_interrupted_noise_cleanup_jobs().unwrap();
        assert_eq!(resumable.len(), 1);
        assert_eq!(resumable[0].id, job.id);
        assert_eq!(resumable[0].status, NoiseCleanupJobStatus::Queued);
        assert_eq!(
            std::fs::read(&source_path).unwrap(),
            b"durable queued source"
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn missing_mp4_remux_falls_back_to_existing_managed_mkv() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-media-fallback-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mkv = base.join("source.mkv");
        let missing_mp4 = base.join("missing.mp4");
        std::fs::write(&mkv, b"existing authoritative mkv").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        let mut session =
            completed_recording("source", &mkv, "record", Some("microphone:1".to_string()));
        session.output_path = Some(mkv.display().to_string());
        session.container = Some("mkv".to_string());
        database
            .create_completed_session(
                &session,
                &now,
                Some(missing_mp4.to_str().unwrap()),
                Some(1000),
                Some(26),
            )
            .unwrap();
        let source = database.noise_cleanup_source("source").unwrap().unwrap();
        assert_eq!(source.media_path.as_deref(), mkv.to_str());
        assert_eq!(
            container_policy(&mkv, source.container.as_deref()).unwrap(),
            ContainerPolicy::Mkv
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn source_object_replacement_is_rejected_even_with_identical_bytes() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-source-identity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source = base.join("source.mp4");
        let old = base.join("old.mp4");
        let bytes = vec![0x41; 160 * 1024];
        std::fs::write(&source, &bytes).unwrap();
        let identity = capture_session_file_bound_identity(&source)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source).unwrap();
        std::fs::rename(&source, &old).unwrap();
        std::fs::write(&source, &bytes).unwrap();
        let error = require_source_identity(&source, &identity, &full_sha256).unwrap_err();
        assert_eq!(error.code, ERROR_CHANGED);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn same_inode_same_length_middle_edit_is_rejected_by_full_fingerprint() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-source-middle-edit-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source = base.join("source.mp4");
        let bytes = vec![0x41; 192 * 1024];
        std::fs::write(&source, &bytes).unwrap();
        let identity = capture_session_file_bound_identity(&source)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source).unwrap();
        let mut changed = bytes;
        changed[96 * 1024] = 0x42;
        std::fs::write(&source, changed).unwrap();
        let sampled = capture_session_file_bound_identity(&source)
            .unwrap()
            .unwrap();
        assert!(
            session_file_bound_identity_matches(
                &sampled,
                &identity.content_identity,
                Some(&identity.object_identity),
            ),
            "the job-specific full fingerprint must close the sampled-middle gap"
        );
        let error = require_source_identity(&source, &identity, &full_sha256).unwrap_err();
        assert_eq!(error.code, ERROR_CHANGED);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn deleting_derivative_invalidates_completed_job_and_allows_retry() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-delete-derivative-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        let output_path = base.join("source — Noise Cleaned.mp4");
        std::fs::write(&source_path, b"source bytes").unwrap();
        std::fs::write(&output_path, b"cleaned bytes").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(12),
            )
            .unwrap();
        let identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source_path).unwrap();
        let job = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        assert!(
            database
                .bind_noise_cleanup_source_fingerprint(&job.job.id, &full_sha256)
                .unwrap()
                .is_none()
        );
        assert!(
            database
                .complete_noise_cleanup_derivative(
                    &job.job.id,
                    "source",
                    "derivative",
                    "Source title — Noise Cleaned",
                    "Source title",
                    output_path.to_str().unwrap(),
                    "mp4",
                    Some(1000),
                    13,
                )
                .unwrap()
        );
        let old_source_path = base.join("old-source.mp4");
        std::fs::rename(&source_path, &old_source_path).unwrap();
        std::fs::write(&source_path, b"source bytes").unwrap();
        let replacement_identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        let replacement_full_sha256 = full_file_sha256(&source_path).unwrap();
        let replacement_job = database
            .create_or_get_noise_cleanup_job("source", &replacement_identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        assert!(
            database
                .bind_noise_cleanup_source_fingerprint(
                    &replacement_job.job.id,
                    &replacement_full_sha256,
                )
                .unwrap()
                .is_none(),
            "object mismatch must prevent completed-result reuse"
        );
        assert_ne!(
            replacement_job.job.id, job.job.id,
            "byte-identical filesystem-object replacement must not reuse completed output"
        );
        assert_eq!(replacement_job.job.status, NoiseCleanupJobStatus::Queued);
        let deletion = database
            .prepare_session_deletions(&["derivative".to_string()])
            .unwrap();
        for path in &deletion[0].paths {
            std::fs::remove_file(path).unwrap();
        }
        assert!(
            database
                .complete_session_deletion(&deletion[0].operation_id, &[])
                .unwrap()
                .deleted
        );
        let invalidated = database
            .noise_cleanup_job(&job.job.id)
            .unwrap()
            .unwrap()
            .job;
        assert_eq!(invalidated.status, NoiseCleanupJobStatus::Failed);
        assert_eq!(invalidated.error_code.as_deref(), Some(ERROR_MISSING));
        assert!(invalidated.output_session_id.is_none());
        assert!(invalidated.output_path.is_none());
        let retry = database
            .create_or_get_noise_cleanup_job("source", &replacement_identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        assert_eq!(retry.job.id, replacement_job.job.id);
        assert_eq!(retry.job.status, NoiseCleanupJobStatus::Queued);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn externally_missing_output_keeps_derivative_metadata_and_reserves_its_path() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-external-output-delete-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        let output_path = base.join("source — Noise Cleaned.mp4");
        std::fs::write(&source_path, b"source bytes").unwrap();
        std::fs::write(&output_path, b"first cleaned bytes").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(12),
            )
            .unwrap();
        let identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source_path).unwrap();
        let first = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        database
            .bind_noise_cleanup_source_fingerprint(&first.job.id, &full_sha256)
            .unwrap();
        database
            .complete_noise_cleanup_derivative(
                &first.job.id,
                "source",
                "first-derivative",
                "Source title — Noise Cleaned",
                "Source title",
                output_path.to_str().unwrap(),
                "mp4",
                Some(1000),
                19,
            )
            .unwrap();
        std::fs::remove_file(&output_path).unwrap();
        let jobs = database.list_noise_cleanup_jobs().unwrap();
        let invalidated = jobs.iter().find(|job| job.id == first.job.id).unwrap();
        assert_eq!(invalidated.status, NoiseCleanupJobStatus::Failed);
        assert_eq!(invalidated.error_code.as_deref(), Some(ERROR_MISSING));
        assert!(database.list_sessions(20).unwrap().iter().any(|session| {
            session.id == "first-derivative" && session.mp4_path.as_deref() == output_path.to_str()
        }));

        // A later remount or restore makes the original Library row usable
        // again; reconciliation must never destroy that durable path metadata.
        std::fs::write(&output_path, b"first cleaned bytes restored").unwrap();
        assert!(output_path.is_file());

        let retry = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        database
            .bind_noise_cleanup_source_fingerprint(&retry.job.id, &full_sha256)
            .unwrap();
        let second_path = first_free_output_path_with(&source_path, |candidate| {
            database
                .session_media_path_registered(&candidate.display().to_string())
                .unwrap()
        })
        .unwrap();
        assert_eq!(
            second_path.file_name().unwrap(),
            "source — Noise Cleaned 2.mp4"
        );
        std::fs::write(&second_path, b"second cleaned bytes").unwrap();
        database
            .complete_noise_cleanup_derivative(
                &retry.job.id,
                "source",
                "second-derivative",
                "Source title — Noise Cleaned",
                "Source title",
                second_path.to_str().unwrap(),
                "mp4",
                Some(1000),
                20,
            )
            .unwrap();
        let derivatives = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .filter(|session| session.processing_kind.as_deref() == Some("noise-cleanup"))
            .collect::<Vec<_>>();
        assert_eq!(derivatives.len(), 2);
        assert!(
            derivatives
                .iter()
                .any(|session| session.id == "first-derivative")
        );
        assert!(derivatives.iter().any(|session| {
            session.id == "second-derivative" && session.mp4_path.as_deref() == second_path.to_str()
        }));
        let stale_reserved_path = base.join("source — Noise Cleaned 3.mp4");
        database
            .clone_session_row(
                "second-derivative",
                "older-stale-derivative",
                "Older stale derivative",
                None,
                Some(stale_reserved_path.to_str().unwrap()),
                &Utc::now().to_rfc3339(),
                Some(20),
            )
            .unwrap();
        assert!(!stale_reserved_path.exists());
        let third_path = first_free_output_path_with(&source_path, |candidate| {
            database
                .session_media_path_registered(&candidate.display().to_string())
                .unwrap()
        })
        .unwrap();
        assert_eq!(
            third_path.file_name().unwrap(),
            "source — Noise Cleaned 4.mp4",
            "missing paths owned by older derivative rows must remain reserved"
        );

        let old_source = base.join("old-source.mp4");
        std::fs::rename(&source_path, &old_source).unwrap();
        std::fs::write(&source_path, b"source bytes").unwrap();
        let reconciled = database.list_noise_cleanup_jobs().unwrap();
        let changed = reconciled
            .iter()
            .find(|job| job.id == retry.job.id)
            .unwrap();
        assert_eq!(changed.status, NoiseCleanupJobStatus::Failed);
        assert_eq!(changed.error_code.as_deref(), Some(ERROR_CHANGED));
        assert!(
            database
                .list_sessions(20)
                .unwrap()
                .iter()
                .any(|session| session.id == "second-derivative")
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn unavailable_output_does_not_mutate_completed_job_or_derivative_row() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-unavailable-output-{}",
            uuid::Uuid::new_v4()
        ));
        let mounted = base.join("mounted");
        let displaced = base.join("displaced");
        std::fs::create_dir_all(&mounted).unwrap();
        let source_path = base.join("source.mp4");
        let output_path = mounted.join("source — Noise Cleaned.mp4");
        std::fs::write(&source_path, b"source bytes").unwrap();
        std::fs::write(&output_path, b"cleaned bytes").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(12),
            )
            .unwrap();
        let identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        let full_sha256 = full_file_sha256(&source_path).unwrap();
        let job = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        database
            .bind_noise_cleanup_source_fingerprint(&job.job.id, &full_sha256)
            .unwrap();
        database
            .complete_noise_cleanup_derivative(
                &job.job.id,
                "source",
                "derivative",
                "Source title — Noise Cleaned",
                "Source title",
                output_path.to_str().unwrap(),
                "mp4",
                Some(1000),
                13,
            )
            .unwrap();

        // Simulate an unavailable mount point. Opening a child below a regular
        // file fails with NotADirectory rather than a definitive NotFound.
        std::fs::rename(&mounted, &displaced).unwrap();
        std::fs::write(&mounted, b"temporarily unavailable mount").unwrap();
        assert_eq!(
            session_media_path_state(&output_path),
            SessionMediaPathState::Unavailable
        );
        let listed = database.list_noise_cleanup_jobs().unwrap();
        let completed = listed
            .iter()
            .find(|listed| listed.id == job.job.id)
            .unwrap();
        assert_eq!(completed.status, NoiseCleanupJobStatus::Completed);
        assert_eq!(completed.output_session_id.as_deref(), Some("derivative"));
        assert_eq!(completed.output_path.as_deref(), output_path.to_str());
        let repeated = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap();
        assert_eq!(repeated.job.id, job.job.id);
        assert_eq!(repeated.job.status, NoiseCleanupJobStatus::Completed);

        std::fs::remove_file(&mounted).unwrap();
        std::fs::rename(&displaced, &mounted).unwrap();
        assert!(output_path.is_file());
        let restored = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .find(|session| session.id == "derivative")
            .unwrap();
        assert_eq!(restored.mp4_path.as_deref(), output_path.to_str());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn job_list_compacts_terminal_history_and_keeps_active_work() {
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-list-bound-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source_path = base.join("source.mp4");
        std::fs::write(&source_path, b"source bytes").unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &source_path,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(source_path.to_str().unwrap()),
                Some(1000),
                Some(12),
            )
            .unwrap();
        let identity = capture_session_file_bound_identity(&source_path)
            .unwrap()
            .unwrap();
        for index in 0..1_005 {
            let mut job = database
                .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
                .unwrap()
                .job;
            job.status = NoiseCleanupJobStatus::Failed;
            job.error_code = Some("test-failure".to_string());
            job.error_message = Some(format!("failure {index}"));
            job.updated_at = Utc::now().to_rfc3339();
            database.save_noise_cleanup_job(&job).unwrap();
        }
        let active = database
            .create_or_get_noise_cleanup_job("source", &identity, NOISE_CLEANUP_PRESET)
            .unwrap()
            .job;
        let listed = database.list_noise_cleanup_jobs().unwrap();
        assert!(listed.len() <= 1_000);
        assert_eq!(
            listed
                .iter()
                .filter(|job| job.status == NoiseCleanupJobStatus::Failed)
                .count(),
            1,
            "only the latest terminal state per source should reach bootstrap"
        );
        assert!(listed.iter().any(|job| job.id == active.id));
        let _ = std::fs::remove_dir_all(base);
    }

    fn generate_test_fixture(ffmpeg: &str, path: &Path, audio_tracks: usize) -> bool {
        let mut command = Command::new(ffmpeg);
        command.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=30:duration=2",
        ]);
        for index in 0..audio_tracks {
            let frequency = 440 + index * 110;
            command.args([
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={frequency}:sample_rate=48000:duration=2"),
            ]);
        }
        command.args(["-map", "0:v:0"]);
        for index in 0..audio_tracks {
            command.args(["-map", &format!("{}:a:0", index + 1)]);
        }
        command.args(["-c:v", "mpeg4", "-q:v", "5"]);
        if audio_tracks == 0 {
            command.arg("-an");
        } else {
            let audio_codec = if path.extension().and_then(|value| value.to_str()) == Some("mkv") {
                "pcm_s16le"
            } else {
                "aac"
            };
            command.args(["-c:a", audio_codec]);
            if audio_codec == "aac" {
                command.args(["-b:a", "128k"]);
            }
            command.arg("-shortest");
        }
        command.arg(path);
        output_owned_std(&mut command).is_ok_and(|output| output.status.success())
    }

    #[tokio::test]
    async fn real_ffmpeg_engine_rejects_ambiguous_audio_and_publishes_a_valid_derivative() {
        let ffmpeg = default_ffmpeg_path();
        let mut version = Command::new(&ffmpeg);
        version
            .arg("-version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !output_owned_std(&mut version).is_ok_and(|output| output.status.success()) {
            eprintln!("Skipping real Noise Cleanup engine test: ffmpeg is unavailable");
            return;
        }
        let base = std::env::temp_dir().join(format!(
            "videorc-cleanup-real-engine-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let no_audio = base.join("no-audio.mp4");
        let one_audio = base.join("one-audio.mp4");
        let one_audio_mkv = base.join("one-audio.mkv");
        let multi_audio = base.join("multi-audio.mp4");
        assert!(generate_test_fixture(&ffmpeg, &no_audio, 0));
        assert!(generate_test_fixture(&ffmpeg, &one_audio, 1));
        assert!(generate_test_fixture(&ffmpeg, &one_audio_mkv, 1));
        assert!(generate_test_fixture(&ffmpeg, &multi_audio, 2));
        let ffprobe = ffprobe_path_for(&ffmpeg);
        let never = || false;
        assert_eq!(
            preflight_media(&ffmpeg, &ffprobe, &no_audio, ContainerPolicy::Mp4, &never)
                .unwrap_err()
                .code,
            ERROR_NO_AUDIO
        );
        assert_eq!(
            preflight_media(
                &ffmpeg,
                &ffprobe,
                &multi_audio,
                ContainerPolicy::Mp4,
                &never,
            )
            .unwrap_err()
            .code,
            ERROR_MULTIPLE_AUDIO
        );

        let source_before = capture_session_file_bound_identity(&one_audio)
            .unwrap()
            .unwrap();
        let source_bytes = std::fs::read(&one_audio).unwrap();
        let database = Database::open_in_memory_for_tests();
        let now = Utc::now().to_rfc3339();
        database
            .create_completed_session(
                &completed_recording(
                    "source",
                    &one_audio,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(one_audio.to_str().unwrap()),
                Some(2000),
                Some(source_bytes.len() as i64),
            )
            .unwrap();
        let state = test_state(database.clone());
        let started = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        assert!(session_mutation_blocked(&state, "source").unwrap());
        let fingerprint_capture = tokio::time::timeout(
            Duration::from_secs(10),
            state.ffmpeg_work.begin_capture_when_available(),
        )
        .await
        .expect("capture did not preempt queued fingerprint work");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = database
                    .noise_cleanup_job(&started.id)
                    .unwrap()
                    .unwrap()
                    .job
                    .status;
                if status == NoiseCleanupJobStatus::Queued {
                    break;
                }
                assert!(status.is_active(), "fingerprint preemption became terminal");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fingerprint preemption did not remain queued");
        drop(fingerprint_capture);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = database
                    .noise_cleanup_job(&started.id)
                    .unwrap()
                    .unwrap()
                    .job
                    .status;
                if status == NoiseCleanupJobStatus::Processing {
                    break;
                }
                assert!(status.is_active(), "cleanup terminated before preemption");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("cleanup never entered processing");
        let capture = tokio::time::timeout(
            Duration::from_secs(10),
            state.ffmpeg_work.begin_capture_when_available(),
        )
        .await
        .expect("capture did not preempt Noise Cleanup");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = database
                    .noise_cleanup_job(&started.id)
                    .unwrap()
                    .unwrap()
                    .job
                    .status;
                if status == NoiseCleanupJobStatus::Queued {
                    break;
                }
                assert!(status.is_active(), "preempted cleanup became terminal");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("preempted cleanup did not return to queued");
        drop(capture);
        let completed = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let job = database
                    .noise_cleanup_job(&started.id)
                    .unwrap()
                    .unwrap()
                    .job;
                if !job.status.is_active() {
                    return job;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("Noise Cleanup engine timed out");
        assert_eq!(
            completed.status,
            NoiseCleanupJobStatus::Completed,
            "{:?}: {:?}",
            completed.error_code,
            completed.error_message
        );
        let output = PathBuf::from(completed.output_path.as_deref().unwrap());
        assert!(output.is_file());
        assert_eq!(std::fs::read(&one_audio).unwrap(), source_bytes);
        let source_after = capture_session_file_bound_identity(&one_audio)
            .unwrap()
            .unwrap();
        assert!(session_file_bound_identity_matches(
            &source_after,
            &source_before.content_identity,
            Some(&source_before.object_identity),
        ));
        let repeated_start = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        assert_eq!(
            repeated_start.id, completed.id,
            "exact unchanged source should return its completed job immediately"
        );
        let repeated = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let job = database
                    .noise_cleanup_job(&repeated_start.id)
                    .unwrap()
                    .unwrap()
                    .job;
                if !job.status.is_active() {
                    return job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("completed-result lookup timed out");
        assert_eq!(repeated.status, NoiseCleanupJobStatus::Completed);
        assert_eq!(repeated.output_path, completed.output_path);
        assert_eq!(
            database
                .list_noise_cleanup_jobs()
                .unwrap()
                .into_iter()
                .filter(|job| job.source_session_id == "source")
                .count(),
            1
        );
        assert!(!session_mutation_blocked(&state, "source").unwrap());
        let derivative = database
            .list_sessions(20)
            .unwrap()
            .into_iter()
            .find(|session| session.id == completed.output_session_id.clone().unwrap())
            .unwrap();
        assert_eq!(
            derivative.derived_from_session_id.as_deref(),
            Some("source")
        );
        assert_eq!(derivative.processing_kind.as_deref(), Some("noise-cleanup"));

        let cancel_source = base.join("cancel-source.mp4");
        std::fs::copy(&one_audio, &cancel_source).unwrap();
        let cancel_bytes = std::fs::read(&cancel_source).unwrap();
        database
            .create_completed_session(
                &completed_recording(
                    "cancel-source",
                    &cancel_source,
                    "record",
                    Some("microphone:1".to_string()),
                ),
                &now,
                Some(cancel_source.to_str().unwrap()),
                Some(2000),
                Some(cancel_bytes.len() as i64),
            )
            .unwrap();
        let cancelling = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "cancel-source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = database
                    .noise_cleanup_job(&cancelling.id)
                    .unwrap()
                    .unwrap()
                    .job
                    .status;
                if status == NoiseCleanupJobStatus::Processing {
                    break;
                }
                assert!(status.is_active(), "cleanup terminated before Cancel");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("cleanup never became cancellable");
        let cancelled = cancel(
            state.clone(),
            NoiseCleanupCancelParams {
                job_id: cancelling.id,
            },
        )
        .await
        .unwrap();
        assert_eq!(cancelled.status, NoiseCleanupJobStatus::Cancelled);
        assert_eq!(std::fs::read(&cancel_source).unwrap(), cancel_bytes);

        let mkv_bytes = std::fs::read(&one_audio_mkv).unwrap();
        let mut mkv_session = completed_recording(
            "mkv-source",
            &one_audio_mkv,
            "record",
            Some("microphone:1".to_string()),
        );
        mkv_session.output_path = Some(one_audio_mkv.display().to_string());
        mkv_session.container = Some("mkv".to_string());
        database
            .create_completed_session(
                &mkv_session,
                &now,
                None,
                Some(2000),
                Some(mkv_bytes.len() as i64),
            )
            .unwrap();
        let mkv_job = start_with_entitlements(
            state.clone(),
            NoiseCleanupStartParams {
                session_id: "mkv-source".to_string(),
            },
            entitlements::developer_test_entitlements(),
        )
        .await
        .unwrap();
        let mkv_completed = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let job = database
                    .noise_cleanup_job(&mkv_job.id)
                    .unwrap()
                    .unwrap()
                    .job;
                if !job.status.is_active() {
                    return job;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("MKV Noise Cleanup engine timed out");
        assert_eq!(
            mkv_completed.status,
            NoiseCleanupJobStatus::Completed,
            "{:?}: {:?}",
            mkv_completed.error_code,
            mkv_completed.error_message
        );
        let mkv_output = PathBuf::from(mkv_completed.output_path.as_deref().unwrap());
        assert_eq!(
            mkv_output.extension().and_then(|value| value.to_str()),
            Some("mkv")
        );
        let mkv_probe =
            probe_media_cancellable(&ffprobe, &mkv_output.display().to_string(), &never).unwrap();
        assert_eq!(mkv_probe.audio[0].codec, "pcm_s16le");
        assert_eq!(std::fs::read(&one_audio_mkv).unwrap(), mkv_bytes);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn imported_no_mic_and_derived_sessions_are_rejected_before_media_work() {
        let database = Database::open_in_memory_for_tests();
        let state = test_state(database.clone());
        let base =
            std::env::temp_dir().join(format!("videorc-cleanup-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("recording.mp4");
        std::fs::write(&file, b"not media").unwrap();
        let now = Utc::now().to_rfc3339();
        let make = |id: &str, mode: &str, microphone_id: Option<String>| NewSession {
            id: id.to_string(),
            title: id.to_string(),
            started_at: now.clone(),
            mode: mode.to_string(),
            output_path: None,
            container: Some("mp4".to_string()),
            stream_preset: None,
            sources: SourceSelection {
                screen_id: Some("screen:1".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id,
                test_pattern: false,
            },
            layout: default_layout_settings(),
            output: OutputSettings {
                keep_original_mkv: false,
                record_enabled: true,
                stream_enabled: false,
                output_directory: None,
                ffmpeg_path: None,
                video: VideoSettings {
                    preset: VideoPreset::Tutorial1080p30,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 6000,
                },
                rtmp: RtmpSettings {
                    preset: RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        };
        database
            .create_completed_session(
                &make("imported", "imported", Some("mic".into())),
                &now,
                Some(file.to_str().unwrap()),
                None,
                Some(9),
            )
            .unwrap();
        database
            .create_completed_session(
                &make("no-mic", "record", None),
                &now,
                Some(file.to_str().unwrap()),
                None,
                Some(9),
            )
            .unwrap();
        assert_eq!(
            resolve_source(&state, "imported").unwrap_err().code,
            ERROR_IMPORTED
        );
        assert_eq!(
            resolve_source(&state, "no-mic").unwrap_err().code,
            ERROR_NO_AUDIO
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
