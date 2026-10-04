//! Clean cut (plan 119 S12a/S12b): "Stop recording, and the edited version is
//! already there."
//!
//! A durable job per (source session, mode) that transcribes a finished
//! recording word for word through the web route, asks the cloud for retakes
//! and false starts, applies the local rules of decision 16 and builds a
//! frame-exact cut list, the EDL. Rendering the EDL into a derived session is
//! S13's: it picks a `ready` job up at `cleanCut.render`, moves it through
//! `rendering → validating → completed`, and reads `edl_json` (see
//! [`protocol::CleanCutEdl`]) plus the bound `source_identity_json`.
//!
//! Heavy work follows decision 18: audio extraction and every upload run in
//! the idle maintenance slot, a starting capture preempts and re-queues the
//! job, and nothing uploads while a capture is live. Polling the analysis
//! job needs no slot.
//!
//! Module map:
//! - [`rules`]: every tuning constant (decision 16 defaults).
//! - [`job`]: control handle, registry, failure codes, persist-and-emit.
//! - [`silence`]: WAV reader, RMS frames, chunk windows, speech bounds.
//! - [`transcribe`]: chunk uploads, resume, stitching, failure mapping.
//! - [`edl`]: sentences, local removals, cloud mapping, merge and snap.
//! - [`analysis`]: the `post-recording-clean-cut` job client.

mod analysis;
mod edl;
mod job;
mod rules;
mod silence;
mod transcribe;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::account;
use crate::entitlements;
use crate::protocol::{
    AiCapabilities, CleanCutCancelParams, CleanCutEdl, CleanCutGetParams, CleanCutGetResult,
    CleanCutJob, CleanCutJobDetail, CleanCutJobState, CleanCutMode, CleanCutStartParams,
    CleanCutUpdateEdlParams, EntitlementsSnapshot, FeatureId,
};
use crate::state::AppState;
use crate::storage::{CleanCutJobCreation, CleanCutSource, PersistedCleanCutJob};
use crate::videorc_api::VideorcApiClient;

use analysis::{AnalysisRecord, CloudResult, clamp_target_seconds};
use job::{
    ERROR_FILE_MISSING, ERROR_NETWORK, ERROR_NO_SPEECH, ERROR_PREMIUM_REQUIRED, ERROR_PROCESSING,
    ERROR_SIGNED_OUT, ERROR_SOURCE_CHANGED, EVENT_STATUS, JobControl, JobFailure, PhaseOutcome,
    REFUSAL_ALREADY_RUNNING, REFUSAL_CONSENT_REQUIRED, REFUSAL_EDL_REVISION_CONFLICT,
    REFUSAL_INVALID_PARAMS, REFUSAL_NOT_ELIGIBLE, REFUSAL_NOT_FOUND, REFUSAL_NOT_READY,
    REFUSAL_PREMIUM_REQUIRED, REFUSAL_SIGNED_OUT, REFUSAL_START_FAILED, REFUSAL_UNAVAILABLE,
    REFUSAL_UPDATE_FAILED, WorkerContext, fail_job, requeue_job, set_job_state, terminal_job,
};
use rules::MIN_SOURCE_DURATION_MS;
use transcribe::TranscriptBundle;

pub use job::{CleanCutRefusal, CleanCutRegistry};

/// How long `cleanCut.cancel` waits for a running worker to stop.
const CANCEL_WAIT: Duration = Duration::from_secs(10);

// --- RPCs ---------------------------------------------------------------------

/// `cleanCut.start`: refuse with a typed code, or create (or return) the job.
/// Order: eligibility, already running, consent, sign-in, Premium, then the
/// one network call for the capability block.
pub async fn start(
    state: AppState,
    params: CleanCutStartParams,
) -> std::result::Result<CleanCutJob, CleanCutRefusal> {
    let prepared = prepare_start(
        &state,
        &params,
        &entitlements::current_entitlements(),
        account::stored_session_token(),
    )?;
    let client = VideorcApiClient::new().map_err(|error| {
        CleanCutRefusal::new(
            REFUSAL_UNAVAILABLE,
            format!("Could not reach Videorc: {error}"),
        )
    })?;
    let capabilities = client
        .get_ai_capabilities(&prepared.token)
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("Sign in") {
                CleanCutRefusal::new(REFUSAL_SIGNED_OUT, "Sign in to use Clean cut.")
            } else {
                CleanCutRefusal::new(
                    REFUSAL_UNAVAILABLE,
                    format!("Could not check whether Clean cut is available: {message}"),
                )
            }
        })?;
    check_capabilities(&capabilities)?;
    admit_start(&state, prepared)
}

struct PreparedStart {
    session_id: String,
    mode: CleanCutMode,
    target_duration_seconds: Option<u32>,
    token: String,
}

fn prepare_start(
    state: &AppState,
    params: &CleanCutStartParams,
    snapshot: &EntitlementsSnapshot,
    token: Option<String>,
) -> std::result::Result<PreparedStart, CleanCutRefusal> {
    let session_id = params.session_id.trim();
    if session_id.is_empty() {
        return Err(CleanCutRefusal::new(
            REFUSAL_NOT_ELIGIBLE,
            "sessionId is required.",
        ));
    }
    resolve_source(state, session_id)?;
    let active_for_mode = state
        .database
        .latest_clean_cut_jobs_for_source(session_id)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_START_FAILED, error.to_string()))?
        .into_iter()
        .any(|persisted| persisted.job.mode == params.mode && persisted.job.state.is_active());
    if active_for_mode {
        return Err(CleanCutRefusal::new(
            REFUSAL_ALREADY_RUNNING,
            "Clean cut is already working on this recording.",
        ));
    }
    if !params.consent_to_upload_audio {
        return Err(CleanCutRefusal::new(
            REFUSAL_CONSENT_REQUIRED,
            "Allow Cloud AI to upload this recording's audio first.",
        ));
    }
    let Some(token) = token.filter(|token| !token.trim().is_empty()) else {
        return Err(CleanCutRefusal::new(
            REFUSAL_SIGNED_OUT,
            "Sign in to use Clean cut.",
        ));
    };
    entitlements::require_feature(snapshot, FeatureId::CloudAi)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_PREMIUM_REQUIRED, error.to_string()))?;
    Ok(PreparedStart {
        session_id: session_id.to_string(),
        mode: params.mode,
        target_duration_seconds: params.target_duration_seconds,
        token,
    })
}

/// Decision 11: a finished Videorc recording with an MP4 on disk, recorded
/// (not imported, not derived), at least ten seconds long.
fn resolve_source(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<CleanCutSource, CleanCutRefusal> {
    let refuse = |message: &str| CleanCutRefusal::new(REFUSAL_NOT_ELIGIBLE, message);
    let source = state
        .database
        .clean_cut_source(session_id)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_START_FAILED, error.to_string()))?
        .ok_or_else(|| refuse("This recording is not in the Library."))?;
    if source.status != "completed" {
        return Err(refuse(
            "Clean cut is available once the recording has finished.",
        ));
    }
    if source.mode == "imported" {
        return Err(refuse("Imported videos are not supported yet."));
    }
    if source.derived_from_session_id.is_some() || source.processing_kind.is_some() {
        return Err(refuse(
            "A Clean cut or Noise Cleaned copy cannot be cut again.",
        ));
    }
    if !matches!(source.mode.as_str(), "record" | "record+stream") {
        return Err(refuse("Only finished recordings can be cut."));
    }
    let duration_ms = source
        .duration_ms
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
    if duration_ms < MIN_SOURCE_DURATION_MS {
        return Err(refuse("Recordings shorter than 10 seconds cannot be cut."));
    }
    let Some(mp4_path) = source.mp4_path.as_deref() else {
        return Err(refuse("The recording's MP4 file is missing on disk."));
    };
    let path = Path::new(mp4_path);
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        return Err(refuse("Only MP4 recordings are supported."));
    }
    if !path.is_file() {
        return Err(refuse("The recording's MP4 file is missing on disk."));
    }
    Ok(source)
}

/// Contract part B: the server must offer Clean cut and say it is available.
fn check_capabilities(capabilities: &AiCapabilities) -> std::result::Result<(), CleanCutRefusal> {
    match capabilities.clean_cut.as_ref() {
        Some(block) if block.available => Ok(()),
        Some(block) => Err(CleanCutRefusal::new(
            REFUSAL_UNAVAILABLE,
            match block.reason_code.as_deref() {
                Some("premium-required") => "Clean cut needs Premium.".to_string(),
                Some("quota-exhausted") => {
                    "This month's Clean cut minutes are used up.".to_string()
                }
                Some("disabled") => {
                    "Clean cut is paused on the server. Try again later.".to_string()
                }
                Some("blocked") => "Cloud AI is not available for this account.".to_string(),
                Some("provider-unconfigured") => {
                    "The transcription service is not set up yet. Try again later.".to_string()
                }
                Some(other) => format!("Clean cut is not available right now ({other})."),
                None => "Clean cut is not available right now.".to_string(),
            },
        )),
        None => Err(CleanCutRefusal::new(
            REFUSAL_UNAVAILABLE,
            "This version of Videorc's service does not offer Clean cut yet.",
        )),
    }
}

fn admit_start(
    state: &AppState,
    prepared: PreparedStart,
) -> std::result::Result<CleanCutJob, CleanCutRefusal> {
    match state
        .database
        .create_clean_cut_job(&prepared.session_id, prepared.mode)
    {
        Ok(CleanCutJobCreation::Created(mut persisted)) => {
            let target = (prepared.mode == CleanCutMode::Condensed)
                .then(|| clamp_target_seconds(prepared.target_duration_seconds));
            AnalysisRecord::new(target).store(&mut persisted);
            if let Err(error) = state.database.save_clean_cut_job(&persisted) {
                state.emit_log(
                    "warn",
                    format!(
                        "Could not record the Clean cut target for {}: {error:#}",
                        persisted.job.id
                    ),
                );
            }
            state.emit_event(EVENT_STATUS, &persisted.job);
            spawn_job(state.clone(), persisted.job.id.clone());
            Ok(persisted.job)
        }
        Ok(CleanCutJobCreation::AlreadyActive(_)) => Err(CleanCutRefusal::new(
            REFUSAL_ALREADY_RUNNING,
            "Clean cut is already working on this recording.",
        )),
        Ok(CleanCutJobCreation::Ready(persisted)) => Ok(persisted.job),
        Err(error) => Err(CleanCutRefusal::new(
            REFUSAL_START_FAILED,
            error.to_string(),
        )),
    }
}

/// `cleanCut.get`: the newest job per mode for one source, with the full cut
/// list where one exists.
pub async fn get(
    state: &AppState,
    params: CleanCutGetParams,
) -> std::result::Result<CleanCutGetResult, String> {
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("sessionId is required".to_string());
    }
    let database = state.database.clone();
    let for_query = session_id.clone();
    let jobs =
        tokio::task::spawn_blocking(move || database.latest_clean_cut_jobs_for_source(&for_query))
            .await
            .map_err(|error| format!("Clean cut get task failed: {error}"))?
            .map_err(|error| error.to_string())?;
    Ok(CleanCutGetResult {
        session_id,
        jobs: jobs.into_iter().map(job_detail).collect(),
    })
}

/// `cleanCut.list`: active jobs first, then the newest finished job per
/// source and mode.
pub async fn list(state: &AppState) -> std::result::Result<Vec<CleanCutJob>, String> {
    let database = state.database.clone();
    tokio::task::spawn_blocking(move || database.list_clean_cut_jobs())
        .await
        .map_err(|error| format!("Clean cut list task failed: {error}"))?
        .map_err(|error| error.to_string())
}

/// `cleanCut.cancel`: stop the worker if one runs, else mark the row.
pub async fn cancel(
    state: AppState,
    params: CleanCutCancelParams,
) -> std::result::Result<CleanCutJob, String> {
    let job_id = params.job_id.trim();
    if job_id.is_empty() {
        return Err("jobId is required".to_string());
    }
    let persisted = state
        .database
        .clean_cut_job(job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Clean cut job was not found.".to_string())?;
    if !persisted.job.state.is_active() {
        return Ok(persisted.job);
    }
    if let Some(control) = state.clean_cut.get(job_id) {
        control.request_cancel();
        let finished = control.finished.notified();
        if state.clean_cut.get(job_id).is_some() {
            let _ = tokio::time::timeout(CANCEL_WAIT, finished).await;
        }
    } else {
        let mut persisted = persisted;
        terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
    }
    state
        .database
        .clean_cut_job(job_id)
        .map_err(|error| error.to_string())?
        .map(|persisted| persisted.job)
        .ok_or_else(|| "Clean cut job was not found.".to_string())
}

/// `cleanCut.updateEdl`: optimistic on `revision`; toggles, manual additions
/// and manual deletions. Returns the job with the whole new cut list.
pub async fn update_edl(
    state: &AppState,
    params: CleanCutUpdateEdlParams,
) -> std::result::Result<CleanCutJobDetail, CleanCutRefusal> {
    let job_id = params.job_id.trim();
    if job_id.is_empty() {
        return Err(CleanCutRefusal::new(
            REFUSAL_INVALID_PARAMS,
            "jobId is required.",
        ));
    }
    let persisted = state
        .database
        .clean_cut_job(job_id)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_UPDATE_FAILED, error.to_string()))?
        .ok_or_else(|| CleanCutRefusal::new(REFUSAL_NOT_FOUND, "Clean cut job was not found."))?;
    if !matches!(
        persisted.job.state,
        CleanCutJobState::Ready | CleanCutJobState::Completed
    ) {
        return Err(CleanCutRefusal::new(
            REFUSAL_NOT_READY,
            "The cut list is not ready yet.",
        ));
    }
    if persisted.job.edl_revision != params.revision {
        return Err(CleanCutRefusal::new(
            REFUSAL_EDL_REVISION_CONFLICT,
            "The cut list changed. Reload it and try again.",
        ));
    }
    let edl = parse_edl(persisted.edl_json.as_deref())
        .ok_or_else(|| CleanCutRefusal::new(REFUSAL_NOT_READY, "The cut list is not ready yet."))?;
    let updated = edl::apply_edl_update(edl, &params)
        .map_err(|message| CleanCutRefusal::new(REFUSAL_INVALID_PARAMS, message))?;
    let json = serde_json::to_string(&updated)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_UPDATE_FAILED, error.to_string()))?;
    match state
        .database
        .update_clean_cut_edl(job_id, params.revision, &json)
    {
        Ok(Some(persisted)) => {
            state.emit_event(EVENT_STATUS, &persisted.job);
            Ok(job_detail(persisted))
        }
        Ok(None) => Err(CleanCutRefusal::new(
            REFUSAL_EDL_REVISION_CONFLICT,
            "The cut list changed. Reload it and try again.",
        )),
        Err(error) => Err(CleanCutRefusal::new(
            REFUSAL_UPDATE_FAILED,
            error.to_string(),
        )),
    }
}

/// Startup: every job a dead process owned is queued again and gets a worker.
pub fn resume_interrupted(state: &AppState) {
    match state.database.reconcile_interrupted_clean_cut_jobs() {
        Ok(jobs) => {
            for job in jobs {
                state.emit_event(EVENT_STATUS, &job);
                spawn_job(state.clone(), job.id);
            }
        }
        Err(error) => state.emit_log(
            "warn",
            format!("Could not reconcile interrupted Clean cut jobs: {error:#}"),
        ),
    }
}

/// Delete, duplicate, remux and repair are refused while a worker owns a job
/// on the source (`main.rs`).
pub fn session_mutation_blocked(state: &AppState, session_id: &str) -> Result<bool> {
    Ok(state
        .database
        .active_clean_cut_job_for_source(session_id)?
        .is_some())
}

fn parse_edl(json: Option<&str>) -> Option<CleanCutEdl> {
    json.and_then(|json| serde_json::from_str::<CleanCutEdl>(json).ok())
        .filter(|edl| edl.version == edl::EDL_VERSION)
}

fn job_detail(persisted: PersistedCleanCutJob) -> CleanCutJobDetail {
    let edl = parse_edl(persisted.edl_json.as_deref());
    CleanCutJobDetail {
        job: persisted.job,
        edl,
    }
}

// --- The worker ---------------------------------------------------------------

fn spawn_job(state: AppState, job_id: String) {
    let control = state.clean_cut.register(&job_id);
    tokio::spawn(async move {
        run_job(state.clone(), job_id.clone(), control).await;
        state.clean_cut.finish(&job_id);
    });
}

/// `queued → transcribing → analyzing → ready`, or `failed` / `cancelled`.
/// Each turn of the loop waits for the idle maintenance slot, re-checks the
/// gates, and runs the phases that still have work. A capture preempting a
/// phase re-queues the job and the loop tries again when the slot frees.
async fn run_job(state: AppState, job_id: String, control: Arc<JobControl>) {
    loop {
        let Some(mut persisted) = state.database.clean_cut_job(&job_id).ok().flatten() else {
            return;
        };
        if !persisted.job.state.is_active() {
            return;
        }
        if control.is_shutdown_interrupted() {
            return;
        }
        if control.is_cancelled() {
            terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
            return;
        }
        requeue_job(&state, &mut persisted);

        let permit_future = state.ffmpeg_work.begin_maintenance_when_idle();
        tokio::pin!(permit_future);
        let permit = tokio::select! {
            permit = &mut permit_future => permit,
            _ = control.cancelled.notified() => {
                if control.is_cancelled() {
                    terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
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
            terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
            return;
        }

        // The gates, every turn: the account may have changed while queued.
        let Some(token) = account::stored_session_token() else {
            drop(permit);
            fail_job(
                &state,
                &mut persisted,
                JobFailure::new(ERROR_SIGNED_OUT, "Sign in to continue the clean cut."),
            );
            return;
        };
        if let Err(error) =
            entitlements::require_feature(&entitlements::current_entitlements(), FeatureId::CloudAi)
        {
            drop(permit);
            fail_job(
                &state,
                &mut persisted,
                JobFailure::new(ERROR_PREMIUM_REQUIRED, error.to_string()),
            );
            return;
        }
        let client = match VideorcApiClient::new() {
            Ok(client) => client,
            Err(error) => {
                drop(permit);
                fail_job(
                    &state,
                    &mut persisted,
                    JobFailure::new(
                        ERROR_NETWORK,
                        format!("Could not build the Videorc client: {error}"),
                    ),
                );
                return;
            }
        };
        let ctx = WorkerContext {
            state: &state,
            control: control.clone(),
            maintenance: Some(permit.cancel_token()),
            client: &client,
            token: &token,
        };

        // Phase A: the transcript (extraction and uploads hold the slot).
        let bundle = match transcribe::ensure_transcript(&ctx, &mut persisted).await {
            PhaseOutcome::Done(bundle) => bundle,
            PhaseOutcome::CapturePreempted => {
                drop(permit);
                continue;
            }
            PhaseOutcome::UserCancelled => {
                drop(permit);
                terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
                return;
            }
            PhaseOutcome::ShutdownInterrupted => {
                drop(permit);
                return;
            }
            PhaseOutcome::Failed(failure) => {
                drop(permit);
                fail_job(&state, &mut persisted, failure);
                return;
            }
        };

        // Phase B1: create the analysis job (uploads text, so still the slot).
        let record = match analysis::ensure_analysis_started(&ctx, &mut persisted, &bundle).await {
            PhaseOutcome::Done(record) => record,
            PhaseOutcome::CapturePreempted => {
                drop(permit);
                continue;
            }
            PhaseOutcome::UserCancelled => {
                drop(permit);
                terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
                return;
            }
            PhaseOutcome::ShutdownInterrupted => {
                drop(permit);
                return;
            }
            PhaseOutcome::Failed(failure) => {
                drop(permit);
                fail_job(&state, &mut persisted, failure);
                return;
            }
        };
        drop(permit);

        // Phase B2: wait for the server, slot released.
        let poll_ctx = ctx.without_slot();
        let cloud = match analysis::wait_for_result(&poll_ctx, &mut persisted, record).await {
            PhaseOutcome::Done(cloud) => cloud,
            PhaseOutcome::CapturePreempted => continue,
            PhaseOutcome::UserCancelled => {
                terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
                return;
            }
            PhaseOutcome::ShutdownInterrupted => return,
            PhaseOutcome::Failed(failure) => {
                fail_job(&state, &mut persisted, failure);
                return;
            }
        };

        // Phase B3: the cut list, pure apart from one read of the audio.
        match build_cut_list(&state, &mut persisted, &bundle, &cloud).await {
            Ok(()) => return,
            Err(failure) => {
                fail_job(&state, &mut persisted, failure);
                return;
            }
        }
    }
}

/// Words, audio and the cloud's answer become `edl_json`; the job is `ready`.
/// S13 continues from here.
async fn build_cut_list(
    state: &AppState,
    persisted: &mut PersistedCleanCutJob,
    bundle: &TranscriptBundle,
    cloud: &CloudResult,
) -> std::result::Result<(), JobFailure> {
    set_job_state(
        state,
        persisted,
        CleanCutJobState::Analyzing,
        Some("cut-list"),
        0.98,
    );
    // The identity bound under the slot must still hold.
    let source_path = PathBuf::from(&bundle.plan.source_identity.path);
    let current = transcribe::capture_source_identity(&source_path).map_err(|error| {
        JobFailure::new(
            ERROR_FILE_MISSING,
            format!("The recording file could not be read: {error}"),
        )
    })?;
    if current != bundle.plan.source_identity {
        return Err(JobFailure::new(
            ERROR_SOURCE_CHANGED,
            "The recording changed while Clean cut was working. Start it again.",
        ));
    }

    let audio = transcribe::audio_path(&bundle.dir);
    let frames = tokio::task::spawn_blocking(move || {
        let wav = silence::open_wav(&audio)?;
        wav.rms_frames()
    })
    .await
    .map_err(|error| {
        JobFailure::new(
            ERROR_PROCESSING,
            format!("The audio analysis task failed: {error}"),
        )
    })?
    .map_err(|error| {
        JobFailure::new(
            ERROR_PROCESSING,
            format!("Could not read the extracted audio: {error}"),
        )
    })?;

    let words = &bundle.transcript.words;
    let duration_ms = bundle.plan.duration_ms;
    let segments = edl::sentences(words);
    let mut raw = edl::local_removals(words, &frames, duration_ms);
    raw.extend(edl::map_drops(&cloud.drops, &segments));
    if persisted.job.mode == CleanCutMode::Condensed {
        raw.extend(edl::condensed_removals(
            &cloud.keeps,
            &segments,
            duration_ms,
        ));
    }
    if words.is_empty() && raw.is_empty() {
        return Err(JobFailure::new(
            ERROR_NO_SPEECH,
            "No speech found, nothing to cut.",
        ));
    }
    let edl = edl::build_edl(
        raw,
        duration_ms,
        bundle.plan.frame_rate,
        bundle.plan.source_identity.clone(),
    );
    let json = serde_json::to_string(&edl).map_err(|error| {
        JobFailure::new(
            ERROR_PROCESSING,
            format!("Could not serialize the cut list: {error}"),
        )
    })?;
    persisted.edl_json = Some(json);
    persisted.job.edl_summary = Some(edl.summary());
    terminal_job(state, persisted, CleanCutJobState::Ready, None);
    if let Some(summary) = persisted.job.edl_summary.as_ref() {
        state.emit_log(
            "info",
            format!(
                "Clean cut ready for {}: {} removals keep {} ms of {} ms from {}.",
                persisted.job.source_session_id,
                summary.removal_count,
                summary.kept_ms,
                summary.duration_ms,
                edl.source_identity.path
            ),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        AiCapabilitiesCleanCut, CleanCutFrameRate, CleanCutRemovalToggle, CleanCutSourceIdentity,
        OutputSettings, RtmpPreset, RtmpSettings, SourceSelection, VideoPreset, VideoSettings,
        default_layout_settings,
    };
    use crate::storage::{Database, NewSession};
    use chrono::Utc;
    use tokio::sync::broadcast;

    fn test_state(database: Database) -> AppState {
        let (events, _) = broadcast::channel(32);
        AppState::new("test-token".to_string(), 0, events, database)
    }

    fn recording(id: &str, path: &Path, mode: &str) -> NewSession {
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
                microphone_id: Some("microphone:1".to_string()),
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

    struct Fixture {
        state: AppState,
        dir: PathBuf,
        mp4: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("videorc-clean-cut-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let mp4 = dir.join("talk.mp4");
            std::fs::write(&mp4, vec![0x51; 64 * 1024]).unwrap();
            Self {
                state: test_state(Database::open_in_memory_for_tests()),
                dir,
                mp4,
            }
        }

        fn add_recording(&self, id: &str, mode: &str, duration_ms: i64, mp4: Option<&Path>) {
            let now = Utc::now().to_rfc3339();
            self.state
                .database
                .create_completed_session(
                    &recording(id, &self.mp4, mode),
                    &now,
                    mp4.map(|path| path.to_str().unwrap()),
                    Some(duration_ms),
                    Some(64 * 1024),
                )
                .unwrap();
        }

        fn params(&self, session_id: &str) -> CleanCutStartParams {
            CleanCutStartParams {
                session_id: session_id.to_string(),
                mode: CleanCutMode::Clean,
                consent_to_upload_audio: true,
                target_duration_seconds: None,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn capabilities_with(clean_cut: Option<AiCapabilitiesCleanCut>) -> AiCapabilities {
        let json = r#"{
            "entitlement":{"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},
            "features":{"cloudAiEnabled":true,"gatewayConfigured":true,"modelTestingEnabled":true,"multipartAudioJobsEnabled":true,"objectBackedJobsEnabled":false,"transcriptJobsEnabled":true,"uploadTicketsEnabled":false},
            "generatedAt":"2026-06-15T12:30:00.000Z",
            "limits":{"dailyJobs":25,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"maxOutputTokens":1900,"maxTranscriptCharacters":90000,"monthlyJobs":600},
            "models":{"allowedTextModelCount":2,"allowedTextModelsConfigured":true,"defaultTextModel":"openai/gpt-5.5","fallbackTextModels":[]},
            "objectStorage":{"deleteConfigured":false,"downloadConfigured":false,"provider":null,"providerError":null,"proofConfigured":false,"proofTtlMs":null,"uploadConfigured":false},
            "readiness":{"access":{"cloudAiEntitled":true,"globallyDisabled":false},"gateway":{"configError":null,"configured":true},"objectStorage":{"deleteConfigError":null,"downloadConfigError":null,"proofConfigError":null,"providerError":null,"uploadConfigError":null},"transcription":{"configError":null,"configured":true}},
            "transcription":{"configured":true,"configError":null,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"requestTimeoutMs":65000},
            "workflow":{"inputModes":[],"kind":"post-recording-publish-pack","outputs":[]}
        }"#;
        let mut capabilities: AiCapabilities = serde_json::from_str(json).unwrap();
        capabilities.clean_cut = clean_cut;
        capabilities
    }

    #[test]
    fn job_states_are_active_until_ready_and_terminal_after() {
        for state in [
            CleanCutJobState::Queued,
            CleanCutJobState::Transcribing,
            CleanCutJobState::Analyzing,
            CleanCutJobState::Rendering,
            CleanCutJobState::Validating,
        ] {
            assert!(state.is_active(), "{state:?}");
            assert_eq!(state.as_str().parse::<CleanCutJobState>().unwrap(), state);
        }
        assert!(
            !CleanCutJobState::Ready.is_active(),
            "ready waits for review or render and blocks no mutation"
        );
        for state in [
            CleanCutJobState::Completed,
            CleanCutJobState::Failed,
            CleanCutJobState::Cancelled,
        ] {
            assert!(!state.is_active());
            assert_eq!(state.as_str().parse::<CleanCutJobState>().unwrap(), state);
        }
        assert_eq!(
            serde_json::to_value(CleanCutJobState::Transcribing).unwrap(),
            serde_json::json!("transcribing")
        );
        assert_eq!(
            serde_json::to_value(CleanCutMode::Condensed).unwrap(),
            serde_json::json!("condensed")
        );
        assert!("weird".parse::<CleanCutJobState>().is_err());
    }

    #[test]
    fn eligibility_refuses_with_typed_codes_in_order() {
        let fixture = Fixture::new();
        let snapshot = entitlements::developer_test_entitlements();
        let token = Some("session-token".to_string());
        let refusal = |params: &CleanCutStartParams,
                       snapshot: &EntitlementsSnapshot,
                       token: Option<String>| {
            prepare_start(&fixture.state, params, snapshot, token)
                .err()
                .unwrap()
        };

        assert_eq!(
            refusal(&fixture.params("missing"), &snapshot, token.clone()).code,
            REFUSAL_NOT_ELIGIBLE
        );
        fixture.add_recording("imported", "imported", 60_000, Some(&fixture.mp4));
        assert_eq!(
            refusal(&fixture.params("imported"), &snapshot, token.clone()).code,
            REFUSAL_NOT_ELIGIBLE
        );
        fixture.add_recording("stream-only", "stream", 60_000, None);
        assert_eq!(
            refusal(&fixture.params("stream-only"), &snapshot, token.clone()).code,
            REFUSAL_NOT_ELIGIBLE
        );
        fixture.add_recording("short", "record", 9_999, Some(&fixture.mp4));
        assert!(
            refusal(&fixture.params("short"), &snapshot, token.clone())
                .message
                .contains("10 seconds")
        );
        fixture.add_recording(
            "gone",
            "record",
            60_000,
            Some(&fixture.dir.join("gone.mp4")),
        );
        assert!(
            refusal(&fixture.params("gone"), &snapshot, token.clone())
                .message
                .contains("missing")
        );
        fixture.add_recording("mkv", "record", 60_000, Some(&fixture.dir.join("talk.mkv")));
        assert!(
            refusal(&fixture.params("mkv"), &snapshot, token.clone())
                .message
                .contains("MP4")
        );

        fixture.add_recording("good", "record+stream", 60_000, Some(&fixture.mp4));
        let mut no_consent = fixture.params("good");
        no_consent.consent_to_upload_audio = false;
        assert_eq!(
            refusal(&no_consent, &snapshot, token.clone()).code,
            REFUSAL_CONSENT_REQUIRED
        );
        assert_eq!(
            refusal(&fixture.params("good"), &snapshot, None).code,
            REFUSAL_SIGNED_OUT
        );
        assert_eq!(
            refusal(&fixture.params("good"), &snapshot, Some("   ".to_string())).code,
            REFUSAL_SIGNED_OUT
        );
        assert_eq!(
            refusal(
                &fixture.params("good"),
                &entitlements::basic_entitlements(),
                token.clone()
            )
            .code,
            REFUSAL_PREMIUM_REQUIRED
        );
        let prepared = prepare_start(
            &fixture.state,
            &fixture.params("good"),
            &snapshot,
            token.clone(),
        )
        .unwrap();
        assert_eq!(prepared.session_id, "good");
        assert_eq!(prepared.mode, CleanCutMode::Clean);
        assert_eq!(prepared.token, "session-token");
        assert!(
            fixture
                .state
                .database
                .list_clean_cut_jobs()
                .unwrap()
                .is_empty(),
            "preparing never creates a row"
        );
    }

    #[test]
    fn capabilities_gate_needs_the_block_and_available() {
        assert_eq!(
            check_capabilities(&capabilities_with(None))
                .unwrap_err()
                .code,
            REFUSAL_UNAVAILABLE
        );
        let unavailable = check_capabilities(&capabilities_with(Some(AiCapabilitiesCleanCut {
            supported: true,
            available: false,
            reason_code: Some("quota-exhausted".to_string()),
            ..AiCapabilitiesCleanCut::default()
        })))
        .unwrap_err();
        assert_eq!(unavailable.code, REFUSAL_UNAVAILABLE);
        assert!(unavailable.message.contains("minutes"));
        let blocked = check_capabilities(&capabilities_with(Some(AiCapabilitiesCleanCut {
            available: false,
            reason_code: Some("blocked".to_string()),
            ..AiCapabilitiesCleanCut::default()
        })))
        .unwrap_err();
        assert!(blocked.message.contains("account"));
        let newer = check_capabilities(&capabilities_with(Some(AiCapabilitiesCleanCut {
            available: false,
            reason_code: Some("maintenance".to_string()),
            ..AiCapabilitiesCleanCut::default()
        })))
        .unwrap_err();
        assert!(
            newer.message.contains("maintenance"),
            "unknown codes are shown, not rejected"
        );
        assert!(
            check_capabilities(&capabilities_with(Some(AiCapabilitiesCleanCut {
                supported: true,
                available: true,
                ..AiCapabilitiesCleanCut::default()
            })))
            .is_ok()
        );
        // The contract's part B block parses with every field present and
        // with the block absent.
        let parsed: AiCapabilitiesCleanCut = serde_json::from_str(
            r#"{"supported":true,"available":true,"reasonCode":null,"maxChunkSeconds":120,"maxChunkBytes":4000000,"monthlySecondsLimit":72000,"remainingSeconds":64000,"modes":["clean","condensed"],"workflowKind":"post-recording-clean-cut"}"#,
        )
        .unwrap();
        assert!(parsed.available && parsed.reason_code.is_none());
        assert_eq!(parsed.modes, vec!["clean", "condensed"]);
        assert!(
            !capabilities_with(None).features.clean_cut_enabled,
            "an older server omits the feature flag"
        );
    }

    #[test]
    fn one_active_job_per_source_and_mode_and_ready_jobs_are_returned() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;

        let created = match database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        {
            CleanCutJobCreation::Created(persisted) => persisted,
            other => panic!("expected a new job, got {other:?}"),
        };
        assert_eq!(created.job.state, CleanCutJobState::Queued);
        assert_eq!(created.job.edl_revision, 0);
        assert!(created.job.edl_summary.is_none());
        assert!(
            matches!(
                database
                    .create_clean_cut_job("good", CleanCutMode::Clean)
                    .unwrap(),
                CleanCutJobCreation::AlreadyActive(_)
            ),
            "the partial unique index backs the refusal"
        );
        assert!(
            matches!(
                database
                    .create_clean_cut_job("good", CleanCutMode::Condensed)
                    .unwrap(),
                CleanCutJobCreation::Created(_)
            ),
            "modes are independent"
        );
        assert!(session_mutation_blocked(&fixture.state, "good").unwrap());
        assert!(!session_mutation_blocked(&fixture.state, "other").unwrap());

        // The worker finished: a cut list is waiting for review.
        let mut ready = created.clone();
        let edl = edl::build_edl(
            Vec::new(),
            60_000,
            CleanCutFrameRate { num: 30, den: 1 },
            CleanCutSourceIdentity {
                path: fixture.mp4.display().to_string(),
                size_bytes: 1,
                modified_unix_ms: None,
            },
        );
        ready.edl_json = Some(serde_json::to_string(&edl).unwrap());
        ready.job.edl_summary = Some(edl.summary());
        terminal_job(&fixture.state, &mut ready, CleanCutJobState::Ready, None);
        let reloaded = database.clean_cut_job(&created.job.id).unwrap().unwrap();
        assert_eq!(reloaded.job.state, CleanCutJobState::Ready);
        assert_eq!(reloaded.job.progress, 1.0);
        assert_eq!(reloaded.job.edl_summary.as_ref().unwrap().kept_ms, 60_000);
        match database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        {
            CleanCutJobCreation::Ready(persisted) => assert_eq!(persisted.job.id, created.job.id),
            other => panic!("expected the ready job, got {other:?}"),
        }

        // A failed job is history; the next start creates a new row.
        let mut failed = reloaded.clone();
        fail_job(
            &fixture.state,
            &mut failed,
            JobFailure::new("clean-cut-monthly-quota-exhausted", "Used up."),
        );
        let failed = database.clean_cut_job(&created.job.id).unwrap().unwrap();
        assert_eq!(failed.job.state, CleanCutJobState::Failed);
        assert_eq!(
            failed.job.error_code.as_deref(),
            Some("clean-cut-monthly-quota-exhausted")
        );
        assert!(matches!(
            database
                .create_clean_cut_job("good", CleanCutMode::Clean)
                .unwrap(),
            CleanCutJobCreation::Created(_)
        ));
        let latest = database.latest_clean_cut_jobs_for_source("good").unwrap();
        assert_eq!(latest.len(), 2, "one per mode");
        assert!(
            latest
                .iter()
                .all(|persisted| persisted.job.state == CleanCutJobState::Queued)
        );
        let listed = database.list_clean_cut_jobs().unwrap();
        assert_eq!(listed.len(), 3, "two active, one finished");
    }

    #[tokio::test]
    async fn cancel_without_a_worker_marks_the_row_and_get_returns_the_cut_list() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(created) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let cancelled = cancel(
            fixture.state.clone(),
            CleanCutCancelParams {
                job_id: created.job.id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(cancelled.state, CleanCutJobState::Cancelled);
        assert!(cancelled.error_code.is_none());
        assert!(!session_mutation_blocked(&fixture.state, "good").unwrap());
        let again = cancel(
            fixture.state.clone(),
            CleanCutCancelParams {
                job_id: created.job.id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            again.state,
            CleanCutJobState::Cancelled,
            "cancel is idempotent"
        );
        assert!(
            cancel(
                fixture.state.clone(),
                CleanCutCancelParams {
                    job_id: "nope".to_string()
                }
            )
            .await
            .is_err()
        );

        let result = get(
            &fixture.state,
            CleanCutGetParams {
                session_id: "good".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.session_id, "good");
        assert_eq!(result.jobs.len(), 1);
        assert!(result.jobs[0].edl.is_none());
        assert!(
            get(
                &fixture.state,
                CleanCutGetParams {
                    session_id: "unknown".to_string()
                }
            )
            .await
            .unwrap()
            .jobs
            .is_empty()
        );
    }

    #[tokio::test]
    async fn edl_updates_are_optimistic_on_the_revision() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut persisted) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let not_ready = update_edl(
            &fixture.state,
            CleanCutUpdateEdlParams {
                job_id: persisted.job.id.clone(),
                revision: 0,
                removals: Vec::new(),
                add_manual: Vec::new(),
                remove_manual: Vec::new(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(not_ready.code, REFUSAL_NOT_READY);

        let edl = edl::build_edl(
            vec![edl::RawRemoval {
                start_ms: 0,
                end_ms: 1_000,
                kind: crate::protocol::CleanCutRemovalKind::Head,
                reason: "head".to_string(),
                confidence: None,
                enabled: true,
            }],
            60_000,
            CleanCutFrameRate { num: 30, den: 1 },
            CleanCutSourceIdentity {
                path: fixture.mp4.display().to_string(),
                size_bytes: 1,
                modified_unix_ms: None,
            },
        );
        persisted.edl_json = Some(serde_json::to_string(&edl).unwrap());
        terminal_job(
            &fixture.state,
            &mut persisted,
            CleanCutJobState::Ready,
            None,
        );

        let toggled = update_edl(
            &fixture.state,
            CleanCutUpdateEdlParams {
                job_id: persisted.job.id.clone(),
                revision: 0,
                removals: vec![CleanCutRemovalToggle {
                    id: "r1".to_string(),
                    enabled: false,
                }],
                add_manual: Vec::new(),
                remove_manual: Vec::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(toggled.job.edl_revision, 1);
        let edl = toggled.edl.unwrap();
        assert!(!edl.removals[0].enabled);
        assert_eq!(edl.stats.kept_ms, 60_000);
        assert_eq!(toggled.job.edl_summary.unwrap().kept_ms, 60_000);

        let stale = update_edl(
            &fixture.state,
            CleanCutUpdateEdlParams {
                job_id: persisted.job.id.clone(),
                revision: 0,
                removals: Vec::new(),
                add_manual: Vec::new(),
                remove_manual: Vec::new(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, REFUSAL_EDL_REVISION_CONFLICT);
        let unknown = update_edl(
            &fixture.state,
            CleanCutUpdateEdlParams {
                job_id: persisted.job.id.clone(),
                revision: 1,
                removals: vec![CleanCutRemovalToggle {
                    id: "r9".to_string(),
                    enabled: true,
                }],
                add_manual: Vec::new(),
                remove_manual: Vec::new(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.code, REFUSAL_INVALID_PARAMS);
        assert_eq!(
            update_edl(
                &fixture.state,
                CleanCutUpdateEdlParams {
                    job_id: "nope".to_string(),
                    revision: 0,
                    removals: Vec::new(),
                    add_manual: Vec::new(),
                    remove_manual: Vec::new(),
                },
            )
            .await
            .unwrap_err()
            .code,
            REFUSAL_NOT_FOUND
        );
    }

    #[test]
    fn interrupted_jobs_are_requeued_with_their_progress_files_intact() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut persisted) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        persisted.job.transcript_path = Some("transcript.words.json".to_string());
        persisted.analysis_json =
            Some(r#"{"version":1,"jobId":"job-9","status":"pending"}"#.to_string());
        set_job_state(
            &fixture.state,
            &mut persisted,
            CleanCutJobState::Analyzing,
            Some("analyze"),
            0.9,
        );

        let requeued = database.reconcile_interrupted_clean_cut_jobs().unwrap();
        assert_eq!(requeued.len(), 1);
        assert_eq!(requeued[0].state, CleanCutJobState::Queued);
        let reloaded = database.clean_cut_job(&persisted.job.id).unwrap().unwrap();
        assert_eq!(
            reloaded.job.transcript_path.as_deref(),
            Some("transcript.words.json")
        );
        assert!(reloaded.analysis_json.as_deref().unwrap().contains("job-9"));
        assert!(
            (reloaded.job.progress - 0.9).abs() < 1e-9,
            "progress is kept"
        );
        let record = AnalysisRecord::from_persisted(&reloaded);
        assert_eq!(record.job_id.as_deref(), Some("job-9"));

        // Preemption and shutdown both leave the row active for the next turn.
        requeue_job(&fixture.state, &mut persisted);
        assert_eq!(
            database
                .clean_cut_job(&persisted.job.id)
                .unwrap()
                .unwrap()
                .job
                .state,
            CleanCutJobState::Queued
        );
        let outcome: PhaseOutcome<()> = job::Interrupts {
            control: &JobControl::new(),
            maintenance: None,
        }
        .check()
        .unwrap_or(PhaseOutcome::Done(()));
        assert!(matches!(outcome, PhaseOutcome::Done(())));
        let control = JobControl::new();
        control.request_cancel();
        assert!(matches!(
            job::Interrupts {
                control: &control,
                maintenance: None
            }
            .check::<()>(),
            Some(PhaseOutcome::UserCancelled)
        ));
        let control = JobControl::new();
        control.request_shutdown_interrupt();
        assert!(matches!(
            job::Interrupts {
                control: &control,
                maintenance: None
            }
            .check::<()>(),
            Some(PhaseOutcome::ShutdownInterrupted)
        ));
    }

    #[tokio::test]
    async fn a_waiting_capture_preempts_a_phase_through_the_maintenance_token() {
        let fixture = Fixture::new();
        let maintenance = fixture.state.ffmpeg_work.try_begin_maintenance().unwrap();
        let token = maintenance.cancel_token();
        let control = JobControl::new();
        let interrupts = job::Interrupts {
            control: &control,
            maintenance: Some(&token),
        };
        assert!(interrupts.check::<()>().is_none());
        let coordinator = fixture.state.ffmpeg_work.clone();
        let waiting_capture =
            tokio::spawn(async move { coordinator.begin_capture_when_available().await });
        tokio::task::yield_now().await;
        assert!(matches!(
            interrupts.check::<()>(),
            Some(PhaseOutcome::CapturePreempted)
        ));
        let outcome: PhaseOutcome<()> =
            tokio::time::timeout(Duration::from_secs(2), interrupts.wait())
                .await
                .expect("wait resolves on the interrupt");
        assert!(matches!(outcome, PhaseOutcome::CapturePreempted));
        drop(maintenance);
        let capture = waiting_capture.await.unwrap();
        drop(capture);
    }
}
