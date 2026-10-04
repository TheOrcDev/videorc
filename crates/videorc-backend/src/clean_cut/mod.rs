//! Clean cut (plan 119 S12a/S12b): "Stop recording, and the edited version is
//! already there."
//!
//! A durable job per (source session, mode) that transcribes a finished
//! recording word for word through the web route, asks the cloud for retakes
//! and false starts, applies the local rules of decision 16, builds a
//! frame-exact cut list (the EDL) and renders it into a derived session
//! (S13): `queued → transcribing → analyzing → ready → rendering →
//! validating → completed`. `ready` is the short stop while a built cut list
//! waits for the maintenance slot. `cleanCut.render` renders the current
//! revision again, in place: same output file, same derived row.
//!
//! Heavy work follows decision 18: audio extraction, every upload and the
//! render run in the idle maintenance slot, a starting capture preempts and
//! re-queues the job, and nothing uploads while a capture is live. Polling
//! the analysis job needs no slot. Before binding the source, a turn waits
//! for the recording's post-recording quality gate (S15), which may rewrite
//! the MP4 in place; a source that changes after the cut list was built is
//! reported as `source-changed` and the job starts over from transcription.
//!
//! Module map:
//! - [`rules`]: every tuning constant (decision 16 and 17 defaults).
//! - [`job`]: control handle, registry, failure codes, persist-and-emit.
//! - [`silence`]: WAV reader, RMS frames, chunk windows, speech bounds.
//! - [`transcribe`]: chunk uploads, resume, stitching, failure mapping.
//! - [`edl`]: sentences, local removals, cloud mapping, merge and snap.
//! - [`analysis`]: the `post-recording-clean-cut` job client.
//! - [`render`]: kept ranges, the FFmpeg graph, encoders, validation, publish.
//! - [`srt`]: the re-timed captions beside the output.

mod analysis;
mod edl;
mod job;
mod render;
mod rules;
mod silence;
mod srt;
mod transcribe;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::account;
use crate::entitlements;
use crate::protocol::{
    AiCapabilities, CleanCutCancelParams, CleanCutCondensedKeep, CleanCutEdl, CleanCutGetParams,
    CleanCutGetResult, CleanCutJob, CleanCutJobDetail, CleanCutJobState, CleanCutMode,
    CleanCutRenderParams, CleanCutStartParams, CleanCutTranscript, CleanCutTranscriptParams,
    CleanCutTranscriptSegment, CleanCutTranscriptWord, CleanCutUpdateEdlParams,
    EntitlementsSnapshot, FeatureId,
};
use crate::state::AppState;
use crate::storage::{CleanCutJobCreation, CleanCutSource, PersistedCleanCutJob};
use crate::videorc_api::VideorcApiClient;

use analysis::{AnalysisRecord, CloudResult, clamp_target_seconds, parse_cloud_result};
use job::{
    ERROR_FILE_MISSING, ERROR_NETWORK, ERROR_NO_SPEECH, ERROR_PREMIUM_REQUIRED, ERROR_PROCESSING,
    ERROR_SIGNED_OUT, ERROR_SOURCE_CHANGED, EVENT_STATUS, JobControl, JobFailure, PhaseOutcome,
    REFUSAL_ALREADY_RUNNING, REFUSAL_CONSENT_REQUIRED, REFUSAL_EDL_REVISION_CONFLICT,
    REFUSAL_INVALID_PARAMS, REFUSAL_NOT_ELIGIBLE, REFUSAL_NOT_FOUND, REFUSAL_NOT_READY,
    REFUSAL_PREMIUM_REQUIRED, REFUSAL_RENDER_FAILED, REFUSAL_SIGNED_OUT, REFUSAL_START_FAILED,
    REFUSAL_UNAVAILABLE, REFUSAL_UPDATE_FAILED, WorkerContext, fail_job, requeue_job,
    set_job_state, terminal_job,
};
use render::{RenderOutcome, RenderRecord};
use rules::{GATE_WAIT_MAX_SECS, GATE_WAIT_POLL_MS, MIN_SOURCE_DURATION_MS};
use transcribe::{TRANSCRIPT_VERSION, TranscriptBundle, TranscriptFile};

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
        Ok(CleanCutJobCreation::AlreadyActive) => Err(CleanCutRefusal::new(
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
    // `job_detail` reads the transcript for Condensed keeps: off the runtime.
    let jobs = tokio::task::spawn_blocking(move || -> Result<Vec<CleanCutJobDetail>> {
        Ok(database
            .latest_clean_cut_jobs_for_source(&for_query)?
            .into_iter()
            .map(job_detail)
            .collect())
    })
    .await
    .map_err(|error| format!("Clean cut get task failed: {error}"))?
    .map_err(|error| error.to_string())?;
    Ok(CleanCutGetResult { session_id, jobs })
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
    // A `ready` job with a live worker is waiting for the slot to render;
    // cancel reaches it too.
    if !persisted.job.state.is_active() && state.clean_cut.get(job_id).is_none() {
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

/// The states a cut list may be edited or rendered in: built and waiting,
/// rendered, or failed (a failed render keeps its list).
fn edl_is_editable(state: CleanCutJobState) -> bool {
    matches!(
        state,
        CleanCutJobState::Ready | CleanCutJobState::Completed | CleanCutJobState::Failed
    )
}

/// `cleanCut.updateEdl`: optimistic on `revision`; toggles, manual additions
/// and manual deletions. Returns the job with the whole new cut list. Allowed
/// in `ready`, `completed` and `failed`; the renderer follows it with
/// `cleanCut.render`.
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
    if !edl_is_editable(persisted.job.state) {
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

/// `cleanCut.render`: render the current cut list revision again. Allowed in
/// `ready`, `completed` and `failed` whenever a cut list exists. The job goes
/// to `queued` with step `render` and the worker replaces the output file and
/// the derived row in place (same `outputSessionId`).
pub async fn render(
    state: AppState,
    params: CleanCutRenderParams,
) -> std::result::Result<CleanCutJob, CleanCutRefusal> {
    let job_id = params.job_id.trim();
    if job_id.is_empty() {
        return Err(CleanCutRefusal::new(
            REFUSAL_INVALID_PARAMS,
            "jobId is required.",
        ));
    }
    let mut persisted = state
        .database
        .clean_cut_job(job_id)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_RENDER_FAILED, error.to_string()))?
        .ok_or_else(|| CleanCutRefusal::new(REFUSAL_NOT_FOUND, "Clean cut job was not found."))?;
    if !edl_is_editable(persisted.job.state) {
        return Err(CleanCutRefusal::new(
            REFUSAL_NOT_READY,
            "Clean cut is still working on this recording.",
        ));
    }
    if parse_edl(persisted.edl_json.as_deref()).is_none() {
        return Err(CleanCutRefusal::new(
            REFUSAL_NOT_READY,
            "The cut list is not ready yet.",
        ));
    }
    if let Some(control) = state.clean_cut.get(job_id) {
        if persisted.job.state == CleanCutJobState::Ready {
            // A worker already waits for the slot and re-reads the cut list
            // when it gets it.
            return Ok(persisted.job);
        }
        // A worker that just finished may still be unregistering.
        let finished = control.finished.notified();
        if state.clean_cut.get(job_id).is_some() {
            let _ = tokio::time::timeout(Duration::from_secs(2), finished).await;
        }
    }
    persisted.job.error_code = None;
    persisted.job.error_message = None;
    set_job_state(
        &state,
        &mut persisted,
        CleanCutJobState::Queued,
        Some("render"),
        0.0,
    );
    spawn_job(state.clone(), persisted.job.id.clone());
    Ok(persisted.job)
}

/// `cleanCut.transcript`: the stitched words and the sentence segments the
/// analysis used, for the review (S14).
pub async fn transcript(
    state: &AppState,
    params: CleanCutTranscriptParams,
) -> std::result::Result<CleanCutTranscript, CleanCutRefusal> {
    let job_id = params.job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(CleanCutRefusal::new(
            REFUSAL_INVALID_PARAMS,
            "jobId is required.",
        ));
    }
    let persisted = state
        .database
        .clean_cut_job(&job_id)
        .map_err(|error| CleanCutRefusal::new(REFUSAL_UPDATE_FAILED, error.to_string()))?
        .ok_or_else(|| CleanCutRefusal::new(REFUSAL_NOT_FOUND, "Clean cut job was not found."))?;
    let path = transcript_path_for(&persisted);
    let file = tokio::task::spawn_blocking(move || read_transcript(&path))
        .await
        .map_err(|error| {
            CleanCutRefusal::new(
                REFUSAL_UPDATE_FAILED,
                format!("Clean cut transcript task failed: {error}"),
            )
        })?
        .ok_or_else(|| {
            CleanCutRefusal::new(REFUSAL_NOT_READY, "The transcript is not ready yet.")
        })?;
    Ok(transcript_payload(job_id, file))
}

fn transcript_path_for(persisted: &PersistedCleanCutJob) -> PathBuf {
    persisted
        .job
        .transcript_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            transcribe::transcript_file_path(&transcribe::clean_cut_dir(
                &persisted.job.source_session_id,
            ))
        })
}

fn read_transcript(path: &Path) -> Option<TranscriptFile> {
    transcribe::read_json::<TranscriptFile>(path)
        .filter(|transcript| transcript.version == TRANSCRIPT_VERSION)
}

/// Pure: the wire shape of a stitched transcript. Segment ids are the ones
/// the analysis saw, because `sentences` is deterministic for the same words.
fn transcript_payload(job_id: String, file: TranscriptFile) -> CleanCutTranscript {
    let segments = edl::sentences(&file.words)
        .into_iter()
        .map(|segment| CleanCutTranscriptSegment {
            id: segment.id,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
        })
        .collect();
    CleanCutTranscript {
        job_id,
        language: file.language,
        words: file
            .words
            .into_iter()
            .map(|word| CleanCutTranscriptWord {
                text: word.text,
                start_ms: word.start_ms,
                end_ms: word.end_ms,
                filler: word.filler,
            })
            .collect(),
        segments,
    }
}

/// Condensed jobs only: the analysis `keeps` mapped to time through the
/// sentences of the saved transcript. Empty before the analysis answered, for
/// clean jobs, and when the transcript is gone. Reads one file.
fn condensed_keeps_for(persisted: &PersistedCleanCutJob) -> Vec<CleanCutCondensedKeep> {
    if persisted.job.mode != CleanCutMode::Condensed {
        return Vec::new();
    }
    let record = AnalysisRecord::from_persisted(persisted);
    let Some(result) = record.result.as_ref() else {
        return Vec::new();
    };
    let keeps = parse_cloud_result(result).keeps;
    if keeps.is_empty() {
        return Vec::new();
    }
    let Some(file) = read_transcript(&transcript_path_for(persisted)) else {
        return Vec::new();
    };
    edl::condensed_keeps(&keeps, &edl::sentences(&file.words))
}

/// Startup: stray partial renders are removed, and every job a dead process
/// owned (or left `ready`, waiting to render) gets a worker again.
pub fn resume_interrupted(state: &AppState) {
    sweep_stale_render_staging(state);
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

/// The render's staging and final paths live on the job row (never in the
/// shared Library journal, whose startup reconcile would delete a derived
/// session it does not understand). A requeued render writes a fresh partial
/// file; a terminal job forgets its record.
fn sweep_stale_render_staging(state: &AppState) {
    let jobs = match state.database.clean_cut_jobs_with_render_record() {
        Ok(jobs) => jobs,
        Err(error) => {
            state.emit_log(
                "warn",
                format!("Could not read Clean cut render records: {error:#}"),
            );
            return;
        }
    };
    for mut persisted in jobs {
        if let Some(record) = RenderRecord::from_persisted(&persisted) {
            render::remove_stale_staging(&record);
        }
        if !persisted.job.state.is_active() && persisted.job.state != CleanCutJobState::Ready {
            persisted.render_json = None;
            if let Err(error) = state.database.save_clean_cut_job(&persisted) {
                state.emit_log(
                    "warn",
                    format!(
                        "Could not clear the render record of Clean cut job {}: {error:#}",
                        persisted.job.id
                    ),
                );
            }
        }
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
    let condensed_keeps = condensed_keeps_for(&persisted);
    CleanCutJobDetail {
        job: persisted.job,
        edl,
        condensed_keeps,
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

/// `queued → transcribing → analyzing → ready → rendering → validating →
/// completed`, or `failed` / `cancelled`. Each turn of the loop waits for the
/// source's quality gate, then for the idle maintenance slot, re-checks the
/// gates, and runs the phases that still have work. A built cut list means
/// only the render is left, however the turn started (a fresh list, a
/// `cleanCut.render`, or a startup requeue). A capture preempting a phase
/// re-queues the job and the loop tries again when the slot frees.
async fn run_job(state: AppState, job_id: String, control: Arc<JobControl>) {
    loop {
        let Some(mut persisted) = state.database.clean_cut_job(&job_id).ok().flatten() else {
            return;
        };
        let render_pending = parse_edl(persisted.edl_json.as_deref()).is_some();
        // A built cut list waits for the slot as `ready`, the short stop the
        // renderer shows, not as `queued`.
        let waiting_ready = render_pending && persisted.job.state == CleanCutJobState::Ready;
        if !persisted.job.state.is_active() && !waiting_ready {
            return;
        }
        if control.is_shutdown_interrupted() {
            return;
        }
        if control.is_cancelled() {
            terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
            return;
        }
        if !waiting_ready {
            requeue_job(&state, &mut persisted);
        }

        // S15: the post-recording quality gate may still rewrite the source.
        if let Some(outcome) = wait_for_quality_gate(&state, &control, &mut persisted).await {
            if matches!(outcome, PhaseOutcome::UserCancelled) {
                terminal_job(&state, &mut persisted, CleanCutJobState::Cancelled, None);
            }
            return;
        }

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

        // Phase C: the render. Local work; it needs no account.
        if render_pending {
            // Re-read: the cut list may have been edited while we waited.
            let Some(fresh) = state.database.clean_cut_job(&job_id).ok().flatten() else {
                drop(permit);
                return;
            };
            persisted = fresh;
            let Some(edl) = parse_edl(persisted.edl_json.as_deref()) else {
                drop(permit);
                continue;
            };
            let maintenance = permit.cancel_token();
            let outcome =
                render::render_phase(&state, &control, &maintenance, &mut persisted, edl).await;
            drop(permit);
            match outcome {
                PhaseOutcome::Done(RenderOutcome::Published {
                    output_session_id,
                    output_path,
                    duration_ms,
                }) => {
                    spawn_output_poster(&state, output_session_id, output_path, duration_ms);
                    return;
                }
                PhaseOutcome::Done(RenderOutcome::Superseded) => continue,
                PhaseOutcome::Done(RenderOutcome::SourceChanged) => {
                    rebind_after_source_change(&state, &mut persisted);
                    continue;
                }
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
            }
        }

        // The transcript and the analysis need the account.
        let Some(token) = account::stored_session_token() else {
            drop(permit);
            fail_job(
                &state,
                &mut persisted,
                JobFailure::new(ERROR_SIGNED_OUT, "Sign in to continue the clean cut."),
            );
            return;
        };
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

        // Phase B3: the cut list, pure apart from one read of the audio. The
        // next turn renders it.
        match build_cut_list(&state, &mut persisted, &bundle, &cloud).await {
            Ok(()) => continue,
            Err(failure) => {
                fail_job(&state, &mut persisted, failure);
                return;
            }
        }
    }
}

/// Pure: whether a turn must still wait for the source to settle. The wait is
/// bounded; past it the turn proceeds and the identity checks catch a later
/// repair.
fn quality_gate_blocks(finalizing: bool, gate_ahead: bool, waited: Duration) -> bool {
    (finalizing || gate_ahead) && waited < Duration::from_secs(GATE_WAIT_MAX_SECS)
}

/// S15: hold the turn while the source's finalization is still exporting or
/// its post-recording quality gate is ahead of us (it may repair the MP4 in
/// place). `Some(outcome)` when interrupted.
async fn wait_for_quality_gate(
    state: &AppState,
    control: &JobControl,
    persisted: &mut PersistedCleanCutJob,
) -> Option<PhaseOutcome<()>> {
    let session_id = persisted.job.source_session_id.clone();
    let started = Instant::now();
    let mut announced = false;
    loop {
        if control.is_cancelled() {
            return Some(PhaseOutcome::UserCancelled);
        }
        if control.is_shutdown_interrupted() {
            return Some(PhaseOutcome::ShutdownInterrupted);
        }
        let mp4_path = state
            .database
            .clean_cut_source(&session_id)
            .ok()
            .flatten()
            .and_then(|source| source.mp4_path);
        let gate_ahead = mp4_path.as_deref().is_some_and(|path| {
            state
                .database
                .quality_gate_blocking_for_path(path)
                .unwrap_or(false)
        });
        let finalizing = state
            .recording_finalization
            .active_for_session(&session_id)
            .is_some();
        if !quality_gate_blocks(finalizing, gate_ahead, started.elapsed()) {
            if announced && (finalizing || gate_ahead) {
                state.emit_log(
                    "warn",
                    format!(
                        "Clean cut waited {} s for the quality check of {session_id}; going ahead.",
                        started.elapsed().as_secs()
                    ),
                );
            }
            return None;
        }
        if !announced {
            announced = true;
            let (job_state, progress) = (persisted.job.state, persisted.job.progress);
            set_job_state(state, persisted, job_state, Some("quality-check"), progress);
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(GATE_WAIT_POLL_MS)) => {}
            _ = control.cancelled.notified() => {}
        }
    }
}

/// After the cut list was built, the recording changed (the quality gate
/// repaired it, or the user remuxed it). Drop the list and the analysis, keep
/// the chunk files (the transcript phase discards them itself when the audio
/// changed), and let the loop start over from transcription. Logged as
/// `source-changed`; the job never fails for it.
fn rebind_after_source_change(state: &AppState, persisted: &mut PersistedCleanCutJob) {
    state.emit_log(
        "info",
        format!(
            "Clean cut: the recording for {} changed after its cut list was built ({ERROR_SOURCE_CHANGED}); starting over from the transcript.",
            persisted.job.source_session_id
        ),
    );
    match state.database.reset_clean_cut_edl(&persisted.job.id) {
        Ok(Some(fresh)) => *persisted = fresh,
        Ok(None) => {}
        Err(error) => state.emit_log(
            "warn",
            format!(
                "Could not reset the cut list of Clean cut job {}: {error:#}",
                persisted.job.id
            ),
        ),
    }
    let record = AnalysisRecord::from_persisted(persisted);
    AnalysisRecord::new(record.target_duration_seconds).store(persisted);
    persisted.edl_json = None;
    persisted.job.edl_summary = None;
    persisted.job.transcript_path = None;
    persisted.render_json = None;
    persisted.source_identity_json = None;
    requeue_job(state, persisted);
}

/// A poster for the new or replaced output, after the render's slot is gone
/// (the poster takes the priority maintenance slot itself).
fn spawn_output_poster(
    state: &AppState,
    output_session_id: String,
    output_path: PathBuf,
    duration_ms: i64,
) {
    let state = state.clone();
    tokio::spawn(async move {
        let ffmpeg = crate::ffmpeg::default_ffmpeg_path();
        // A re-render replaced the file: refresh the poster.
        crate::posters::remove_session_poster(&output_session_id).await;
        crate::posters::ensure_session_poster(
            &state,
            &output_session_id,
            &output_path.display().to_string(),
            Some(duration_ms),
            &ffmpeg,
        )
        .await;
    });
}

/// Words, audio and the cloud's answer become `edl_json`; the job is `ready`
/// with step `render`, and the next turn of the loop renders it.
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
    persisted.job.error_code = None;
    persisted.job.error_message = None;
    set_job_state(
        state,
        persisted,
        CleanCutJobState::Ready,
        Some("render"),
        1.0,
    );
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
        AiCapabilitiesCleanCut, CleanCutFrameRate, CleanCutManualRange, CleanCutRemovalToggle,
        CleanCutSourceIdentity, OutputSettings, RtmpPreset, RtmpSettings, SourceSelection,
        VideoPreset, VideoSettings, default_layout_settings,
    };
    use crate::storage::{Database, NewSession};
    use chrono::Utc;
    use tokio::sync::broadcast;
    use transcribe::TranscriptWord;

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
                CleanCutJobCreation::AlreadyActive
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

    const FPS30: CleanCutFrameRate = CleanCutFrameRate { num: 30, den: 1 };

    fn identity_for(path: &Path) -> CleanCutSourceIdentity {
        CleanCutSourceIdentity {
            path: path.display().to_string(),
            size_bytes: 1,
            modified_unix_ms: None,
        }
    }

    fn word(text: &str, start_ms: u64, end_ms: u64, filler: bool) -> TranscriptWord {
        TranscriptWord {
            text: text.to_string(),
            start_ms,
            end_ms,
            confidence: None,
            filler,
        }
    }

    fn write_transcript(path: &Path, words: Vec<TranscriptWord>) {
        transcribe::write_json_atomic(
            path,
            &TranscriptFile {
                version: TRANSCRIPT_VERSION,
                language: None,
                words,
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn render_requeues_a_built_cut_list_and_refuses_active_or_listless_jobs() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut persisted) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let params = |job_id: &str| CleanCutRenderParams {
            job_id: job_id.to_string(),
        };
        assert_eq!(
            render(fixture.state.clone(), params("nope"))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_FOUND
        );
        assert_eq!(
            render(fixture.state.clone(), params(&persisted.job.id))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_READY,
            "queued: still working"
        );
        fail_job(
            &fixture.state,
            &mut persisted,
            JobFailure::new(ERROR_NETWORK, "offline"),
        );
        assert_eq!(
            render(fixture.state.clone(), params(&persisted.job.id))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_READY,
            "failed without a cut list: nothing to render"
        );

        // A cut list makes a failed job renderable again.
        let edl = edl::build_edl(Vec::new(), 60_000, FPS30, identity_for(&fixture.mp4));
        persisted.edl_json = Some(serde_json::to_string(&edl).unwrap());
        persisted.job.edl_summary = Some(edl.summary());
        fail_job(
            &fixture.state,
            &mut persisted,
            JobFailure::new(job::ERROR_RENDER_FAILED, "ffmpeg died"),
        );
        let queued = render(fixture.state.clone(), params(&persisted.job.id))
            .await
            .unwrap();
        assert_eq!(queued.state, CleanCutJobState::Queued);
        assert_eq!(queued.step.as_deref(), Some("render"));
        assert_eq!(queued.progress, 0.0);
        assert!(queued.error_code.is_none(), "the old failure is cleared");
        assert!(
            fixture.state.clean_cut.get(&persisted.job.id).is_some(),
            "a worker owns the render"
        );
        fixture.state.clean_cut.interrupt_all_for_shutdown();

        // Editing follows the same rule: never while a worker renders.
        let mut rendering = database.clean_cut_job(&persisted.job.id).unwrap().unwrap();
        set_job_state(
            &fixture.state,
            &mut rendering,
            CleanCutJobState::Rendering,
            Some("render"),
            0.3,
        );
        let edit = |revision: u32, add_manual: Vec<CleanCutManualRange>| CleanCutUpdateEdlParams {
            job_id: persisted.job.id.clone(),
            revision,
            removals: Vec::new(),
            add_manual,
            remove_manual: Vec::new(),
        };
        assert_eq!(
            update_edl(&fixture.state, edit(rendering.job.edl_revision, Vec::new()))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_READY
        );
        assert_eq!(
            render(fixture.state.clone(), params(&persisted.job.id))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_READY
        );
        terminal_job(
            &fixture.state,
            &mut rendering,
            CleanCutJobState::Completed,
            None,
        );
        let edited = update_edl(
            &fixture.state,
            edit(
                rendering.job.edl_revision,
                vec![CleanCutManualRange {
                    start_ms: 1_000,
                    end_ms: 2_000,
                }],
            ),
        )
        .await
        .unwrap();
        assert_eq!(edited.job.edl_revision, rendering.job.edl_revision + 1);
        assert_eq!(edited.edl.unwrap().removals.len(), 1);
        assert!(
            edited.condensed_keeps.is_empty(),
            "clean jobs carry no keeps"
        );
        for state in [
            CleanCutJobState::Ready,
            CleanCutJobState::Completed,
            CleanCutJobState::Failed,
        ] {
            assert!(edl_is_editable(state), "{state:?}");
        }
        for state in [
            CleanCutJobState::Queued,
            CleanCutJobState::Transcribing,
            CleanCutJobState::Analyzing,
            CleanCutJobState::Rendering,
            CleanCutJobState::Validating,
            CleanCutJobState::Cancelled,
        ] {
            assert!(!edl_is_editable(state), "{state:?}");
        }
    }

    #[tokio::test]
    async fn transcript_returns_words_and_segments_once_stitched() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut persisted) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let params = |job_id: &str| CleanCutTranscriptParams {
            job_id: job_id.to_string(),
        };
        assert_eq!(
            transcript(&fixture.state, params("nope"))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_FOUND
        );
        assert_eq!(
            transcript(&fixture.state, params(&persisted.job.id))
                .await
                .unwrap_err()
                .code,
            REFUSAL_NOT_READY,
            "no transcript yet"
        );
        let path = fixture.dir.join("transcript.words.json");
        write_transcript(
            &path,
            vec![
                word("So", 0, 200, false),
                word("um", 250, 500, true),
                word("today.", 600, 900, false),
                word("Next", 2_000, 2_300, false),
            ],
        );
        persisted.job.transcript_path = Some(path.display().to_string());
        database.save_clean_cut_job(&persisted).unwrap();
        let payload = transcript(&fixture.state, params(&persisted.job.id))
            .await
            .unwrap();
        assert_eq!(payload.job_id, persisted.job.id);
        assert_eq!(payload.words.len(), 4);
        assert!(payload.words[1].filler && !payload.words[0].filler);
        assert_eq!(
            payload
                .segments
                .iter()
                .map(|segment| segment.id.as_str())
                .collect::<Vec<_>>(),
            ["s1", "s2"],
            "the same sentences the analysis saw"
        );
        assert_eq!(
            (payload.segments[0].start_ms, payload.segments[0].end_ms),
            (0, 900)
        );
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            json["language"],
            serde_json::Value::Null,
            "null, never absent (the S13/S14 interface)"
        );
        assert!(json["words"][0].get("filler").is_none());
        assert_eq!(json["words"][1]["filler"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn condensed_keeps_ride_on_get_for_condensed_jobs_only() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut condensed) = database
            .create_clean_cut_job("good", CleanCutMode::Condensed)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let path = fixture.dir.join("transcript.words.json");
        write_transcript(
            &path,
            vec![
                word("So", 0, 200, false),
                word("today.", 600, 900, false),
                word("Next", 2_000, 2_300, false),
            ],
        );
        condensed.job.transcript_path = Some(path.display().to_string());
        let mut record = AnalysisRecord::new(Some(900));
        record.job_id = Some("job-9".to_string());
        record.status = "completed".to_string();
        record.result = Some(serde_json::json!({
            "mode": "condensed",
            "drops": [],
            "keeps": [
                { "fromId": "s2", "toId": "s2", "title": "The end" },
                { "fromId": "s1", "toId": "s1", "title": "Intro" },
                { "fromId": "s9", "toId": "s9", "title": "unknown id" }
            ]
        }));
        record.store(&mut condensed);
        database.save_clean_cut_job(&condensed).unwrap();
        let CleanCutJobCreation::Created(_) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };

        let result = get(
            &fixture.state,
            CleanCutGetParams {
                session_id: "good".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.jobs.len(), 2);
        let detail = result
            .jobs
            .iter()
            .find(|detail| detail.job.mode == CleanCutMode::Condensed)
            .unwrap();
        assert_eq!(
            detail.condensed_keeps,
            vec![
                CleanCutCondensedKeep {
                    start_ms: 0,
                    end_ms: 900,
                    title: "Intro".to_string(),
                },
                CleanCutCondensedKeep {
                    start_ms: 2_000,
                    end_ms: 2_300,
                    title: "The end".to_string(),
                },
            ],
            "mapped through the sentences, sorted, unknown ids skipped"
        );
        assert_eq!(
            serde_json::to_value(detail).unwrap()["condensedKeeps"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let clean = result
            .jobs
            .iter()
            .find(|detail| detail.job.mode == CleanCutMode::Clean)
            .unwrap();
        assert!(clean.condensed_keeps.is_empty());
        assert!(
            serde_json::to_value(clean)
                .unwrap()
                .get("condensedKeeps")
                .is_none(),
            "omitted when empty"
        );
    }

    #[test]
    fn quality_gate_wait_is_bounded_and_rebind_resets_the_cut_list() {
        assert!(quality_gate_blocks(false, true, Duration::from_secs(1)));
        assert!(quality_gate_blocks(true, false, Duration::from_secs(1)));
        assert!(!quality_gate_blocks(false, false, Duration::ZERO));
        assert!(
            !quality_gate_blocks(true, true, Duration::from_secs(GATE_WAIT_MAX_SECS)),
            "past the bound the turn proceeds; the identity check catches a late repair"
        );

        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let CleanCutJobCreation::Created(mut persisted) = database
            .create_clean_cut_job("good", CleanCutMode::Condensed)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let mut record = AnalysisRecord::new(Some(600));
        record.job_id = Some("job-9".to_string());
        record.status = "completed".to_string();
        record.result = Some(serde_json::json!({ "drops": [] }));
        record.store(&mut persisted);
        let edl = edl::build_edl(Vec::new(), 60_000, FPS30, identity_for(&fixture.mp4));
        persisted.edl_json = Some(serde_json::to_string(&edl).unwrap());
        persisted.job.edl_summary = Some(edl.summary());
        persisted.job.transcript_path = Some("transcript.words.json".to_string());
        persisted.source_identity_json = serde_json::to_string(&edl.source_identity).ok();
        persisted.render_json =
            Some(r#"{"version":1,"stagingPath":"a","finalPath":"b","revision":0}"#.to_string());
        set_job_state(
            &fixture.state,
            &mut persisted,
            CleanCutJobState::Rendering,
            Some("render"),
            0.5,
        );
        let revision_before = persisted.job.edl_revision;

        rebind_after_source_change(&fixture.state, &mut persisted);

        let reloaded = database.clean_cut_job(&persisted.job.id).unwrap().unwrap();
        assert_eq!(reloaded.job.state, CleanCutJobState::Queued);
        assert!(reloaded.edl_json.is_none() && reloaded.job.edl_summary.is_none());
        assert_eq!(reloaded.job.edl_revision, revision_before + 1);
        assert!(reloaded.job.transcript_path.is_none());
        assert!(reloaded.render_json.is_none() && reloaded.source_identity_json.is_none());
        assert!(
            reloaded.job.error_code.is_none(),
            "source-changed is logged, not a failure"
        );
        let record = AnalysisRecord::from_persisted(&reloaded);
        assert_eq!(
            record.target_duration_seconds,
            Some(600),
            "the target survives"
        );
        assert!(
            record.job_id.is_none() && record.result.is_none(),
            "the analysis runs again on the new transcript"
        );
    }

    #[tokio::test]
    async fn startup_sweeps_stale_staging_and_gives_ready_jobs_a_worker() {
        let fixture = Fixture::new();
        fixture.add_recording("good", "record", 60_000, Some(&fixture.mp4));
        let database = &fixture.state.database;
        let edl = edl::build_edl(Vec::new(), 60_000, FPS30, identity_for(&fixture.mp4));

        let CleanCutJobCreation::Created(mut ready) = database
            .create_clean_cut_job("good", CleanCutMode::Clean)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let final_path = fixture.dir.join("talk (Clean cut).mp4");
        let staging = render::staging_path_for(&final_path, &ready.job.id);
        std::fs::write(&staging, b"partial").unwrap();
        ready.edl_json = Some(serde_json::to_string(&edl).unwrap());
        ready.job.edl_summary = Some(edl.summary());
        ready.render_json = serde_json::to_string(&RenderRecord {
            version: render::RENDER_RECORD_VERSION,
            staging_path: staging.display().to_string(),
            final_path: final_path.display().to_string(),
            output_session_id: None,
            revision: 0,
        })
        .ok();
        set_job_state(
            &fixture.state,
            &mut ready,
            CleanCutJobState::Ready,
            Some("render"),
            1.0,
        );

        let CleanCutJobCreation::Created(mut failed) = database
            .create_clean_cut_job("good", CleanCutMode::Condensed)
            .unwrap()
        else {
            panic!("expected a new job");
        };
        let failed_final = fixture.dir.join("talk (Condensed).mp4");
        let failed_staging = render::staging_path_for(&failed_final, &failed.job.id);
        std::fs::write(&failed_staging, b"partial").unwrap();
        failed.render_json = serde_json::to_string(&RenderRecord {
            version: render::RENDER_RECORD_VERSION,
            staging_path: failed_staging.display().to_string(),
            final_path: failed_final.display().to_string(),
            output_session_id: None,
            revision: 0,
        })
        .ok();
        fail_job(
            &fixture.state,
            &mut failed,
            JobFailure::new(job::ERROR_RENDER_FAILED, "ffmpeg died"),
        );

        resume_interrupted(&fixture.state);

        assert!(
            !staging.exists() && !failed_staging.exists(),
            "stray partial files are swept"
        );
        assert!(
            fixture.state.clean_cut.get(&ready.job.id).is_some(),
            "a ready job renders by itself after a restart"
        );
        assert!(fixture.state.clean_cut.get(&failed.job.id).is_none());
        let failed = database.clean_cut_job(&failed.job.id).unwrap().unwrap();
        assert!(
            failed.render_json.is_none(),
            "a terminal job forgets its record"
        );
        assert_eq!(failed.job.state, CleanCutJobState::Failed);
        let ready = database.clean_cut_job(&ready.job.id).unwrap().unwrap();
        assert_eq!(ready.job.state, CleanCutJobState::Ready);
        assert!(
            ready.render_json.is_some(),
            "the worker replaces it when it renders"
        );
        fixture.state.clean_cut.interrupt_all_for_shutdown();
    }
}
