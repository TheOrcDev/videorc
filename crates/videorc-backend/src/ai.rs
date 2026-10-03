use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::process::Command;
use tokio::time::{Duration, sleep, timeout};

use crate::account;
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::process_job::output_owned_tokio;
use crate::protocol::{
    AiArtifact, AiArtifactKind, AiArtifactStatus, AiCapabilities, AiJobSnapshot, AiWorkflowResult,
    ExportPublishPackParams, ExportPublishPackResult, HealthEvent, HealthLevel,
    RunAiWorkflowParams,
};
use crate::recording::emit_health_event;
use crate::state::AppState;
use crate::storage::default_artifacts_dir;
use crate::transcript::{CaptionCue, caption_cues_text, parse_srt};
use crate::videorc_api::{AiAudioJobRequest, AiObjectUploadRequest, VideorcApiClient};

const AI_WORKFLOW_KIND_POST_RECORDING: &str = "post-recording-publish-pack";
const AI_JOB_POLL_INTERVAL: Duration = Duration::from_secs(2);
const AI_JOB_POLL_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const DESKTOP_CLIENT_VERSION: &str = concat!("videorc-desktop/", env!("CARGO_PKG_VERSION"));

struct WebAiJobContext<'a> {
    session_id: &'a str,
    client_request_id: &'a str,
    diagnostic_summary: Option<&'a str>,
    health_events: &'a [HealthEvent],
    /// Server-capability-gated extras (None when unsupported or not requested).
    outputs: Option<Vec<String>>,
    tone: Option<String>,
    chat_context: Option<Value>,
}

pub async fn run_ai_workflow(
    state: AppState,
    params: RunAiWorkflowParams,
) -> Result<AiWorkflowResult> {
    // The DB records where files were written, not whether they still exist —
    // use the first recorded path that is actually on disk, and fail with a
    // human explanation instead of FFmpeg's raw ENOENT when none are
    // (2026-07-03 report: "transcript" on a session whose file had been
    // moved/deleted surfaced "exit status 254: Error opening input").
    let candidates = state
        .database
        .session_media_candidates(&params.session_id)?;
    if candidates.is_empty() {
        anyhow::bail!("Session does not have a local recording output");
    }
    let input_path = candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file());
    let Some(input_path) = input_path else {
        anyhow::bail!(
            "The recording file for this session is missing on disk (looked for {}). It may have been moved or deleted. AI features need the original recording file.",
            candidates.join(", ")
        );
    };

    // Live captions already wrote a full timestamped transcript next to the
    // recording (<recording>.srt). Reuse it: no audio extraction, no audio
    // upload — cloud generation runs over the text the app already has, and
    // the Transcript card is Ready even before any cloud consent.
    let captions_transcript = captions_transcript_for(&input_path).await;

    if let Some(CaptionsTranscript {
        srt_path,
        text: transcript_text,
        timed_text,
    }) = captions_transcript
    {
        // The card and the exported transcript.txt keep the plain prose; the
        // job gets the timed text so chapters carry real times (plan 068 D10).
        let artifacts = vec![state.database.save_ai_artifact(
            &params.session_id,
            AiArtifactKind::Transcript,
            AiArtifactStatus::Ready,
            json!({
                "privacy": "Read from the live-captions file next to the recording. Uploaded as text only when cloud consent is on.",
                "source": "live-captions",
                "text": transcript_text,
            }),
            Some(srt_path.display().to_string()),
        )?];

        if !params.consent_to_upload_audio {
            emit_health_event(
                &state,
                Some(&params.session_id),
                HealthLevel::Info,
                "ai-consent-required",
                "Transcript is ready from live captions. Cloud generation did not run because consent was not granted.",
            )?;
            emit_ai_artifacts_changed(&state, &params.session_id);
            return Ok(AiWorkflowResult {
                session_id: params.session_id,
                audio_path: String::new(),
                artifacts,
            });
        }

        let cloud_result = run_web_ai_job(
            &state,
            &params.session_id,
            AiJobInput::Transcript(&timed_text),
            AiJobOptions {
                outputs: params.outputs.clone(),
                tone: params.tone.clone(),
            },
        )
        .await;
        return finish_workflow(
            &state,
            params.session_id,
            String::new(),
            artifacts,
            cloud_result,
        );
    }

    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path);
    let artifact_dir = default_artifacts_dir().join(&params.session_id);
    fs::create_dir_all(&artifact_dir)
        .await
        .with_context(|| format!("Could not create {}", artifact_dir.display()))?;

    let audio_path = artifact_dir.join("audio.m4a");
    extract_audio(&ffmpeg_path, &input_path, &audio_path).await?;
    let mut artifacts = vec![state.database.save_ai_artifact(
        &params.session_id,
        AiArtifactKind::AudioExtract,
        AiArtifactStatus::Ready,
        json!({
            "privacy": "Local audio extract. Not uploaded unless cloud AI is explicitly run.",
            "sourcePath": input_path.display().to_string(),
        }),
        Some(audio_path.display().to_string()),
    )?];

    if !params.consent_to_upload_audio {
        artifacts.push(state.database.save_ai_artifact(
            &params.session_id,
            AiArtifactKind::Transcript,
            AiArtifactStatus::PendingConsent,
            json!({
                "message": "Cloud transcription is waiting for explicit consent to upload extracted audio.",
            }),
            None,
        )?);
        emit_health_event(
            &state,
            Some(&params.session_id),
            HealthLevel::Info,
            "ai-consent-required",
            "Audio was extracted locally. Cloud AI did not run because consent was not granted.",
        )?;
        emit_ai_artifacts_changed(&state, &params.session_id);
        return Ok(AiWorkflowResult {
            session_id: params.session_id,
            audio_path: audio_path.display().to_string(),
            artifacts,
        });
    }

    let cloud_result = run_web_ai_job(
        &state,
        &params.session_id,
        AiJobInput::Audio(&audio_path),
        AiJobOptions {
            outputs: params.outputs.clone(),
            tone: params.tone.clone(),
        },
    )
    .await;
    finish_workflow(
        &state,
        params.session_id,
        audio_path.display().to_string(),
        artifacts,
        cloud_result,
    )
}

/// Shared tail of `run_ai_workflow`: append cloud artifacts or record the
/// failure truthfully (a Failed TitleDescription stub carries the reason to
/// the flagship card; a Ready transcript stays Ready).
fn finish_workflow(
    state: &AppState,
    session_id: String,
    audio_path: String,
    mut artifacts: Vec<AiArtifact>,
    cloud_result: Result<Vec<AiArtifact>>,
) -> Result<AiWorkflowResult> {
    match cloud_result {
        Ok(cloud_artifacts) => artifacts.extend(cloud_artifacts),
        Err(error) => {
            let message = error.to_string();
            let code = if message.contains("Sign in") {
                "cloud-ai-sign-in-required"
            } else {
                "cloud-ai-job-failed"
            };
            let event_message = if code == "cloud-ai-sign-in-required" {
                "Cloud AI did not run because the Videorc session is not signed in."
            } else {
                "Cloud AI failed. The local recording and any local transcript are still available."
            };
            let has_ready_transcript = artifacts.iter().any(|artifact| {
                artifact.kind == AiArtifactKind::Transcript
                    && artifact.status == AiArtifactStatus::Ready
            });
            let stub_kind = if has_ready_transcript {
                AiArtifactKind::TitleDescription
            } else {
                AiArtifactKind::Transcript
            };
            artifacts.push(state.database.save_ai_artifact(
                &session_id,
                stub_kind,
                AiArtifactStatus::Failed,
                json!({
                    "message": message,
                    "provider": "videorc",
                }),
                None,
            )?);
            emit_health_event(
                state,
                Some(&session_id),
                HealthLevel::Warn,
                code,
                event_message,
            )?;
        }
    }

    emit_ai_artifacts_changed(state, &session_id);
    Ok(AiWorkflowResult {
        session_id,
        audio_path,
        artifacts,
    })
}

/// What the cloud job runs over: extracted audio (uploaded for transcription)
/// or transcript text the app already has (live captions — uploaded as text).
enum AiJobInput<'a> {
    Audio(&'a Path),
    Transcript(&'a str),
}

/// Per-kind generation options; silently dropped when the server does not
/// advertise the matching capability, so older servers keep working.
#[derive(Default, Clone)]
struct AiJobOptions {
    outputs: Option<Vec<String>>,
    tone: Option<String>,
}

async fn run_web_ai_job(
    state: &AppState,
    session_id: &str,
    input: AiJobInput<'_>,
    options: AiJobOptions,
) -> Result<Vec<AiArtifact>> {
    let token = account::stored_session_token().context("Sign in to use cloud AI.")?;
    let client = VideorcApiClient::new()?;
    let capabilities = client.get_ai_capabilities(&token).await?;
    validate_cloud_ai_capabilities(&capabilities)?;
    let outputs = options
        .outputs
        .filter(|_| capabilities.workflow.supports_outputs_filter);
    let tone = options.tone.filter(|_| capabilities.workflow.supports_tone);
    let chat_context = if capabilities.workflow.supports_chat_context {
        build_chat_context(state, session_id)
    } else {
        None
    };
    // The server dedupes jobs by client request id alone, so the id carries
    // the requested outputs/tone: a later full run must not get back the
    // post-stream pack's publish_pack-only job (plan 068 D10).
    let options_fingerprint = job_options_fingerprint(outputs.as_deref(), tone.as_deref());
    let client_request_id = match &input {
        AiJobInput::Audio(audio_path) => {
            ai_client_request_id(session_id, audio_path, &options_fingerprint).await?
        }
        AiJobInput::Transcript(transcript) => build_ai_client_request_id(
            session_id,
            &ai_input_hash(transcript.as_bytes(), &options_fingerprint),
        ),
    };
    let health_events = state.database.list_health_events(session_id)?;
    let health_events_json =
        serde_json::to_string(&health_events).context("Could not serialize AI health events.")?;
    let diagnostic_summary = diagnostic_summary_for_session(state, session_id);
    let job_context = WebAiJobContext {
        session_id,
        client_request_id: &client_request_id,
        diagnostic_summary: diagnostic_summary.as_deref(),
        health_events: &health_events,
        outputs,
        tone,
        chat_context,
    };

    let initial_job = match input {
        AiJobInput::Transcript(transcript) => {
            if !capabilities.features.transcript_jobs_enabled {
                bail!("Transcript-backed Videorc AI is not enabled for this account.");
            }
            create_transcript_backed_ai_job(&client, &token, &job_context, transcript).await?
        }
        AiJobInput::Audio(audio_path) => {
            let audio_size = fs::metadata(audio_path)
                .await
                .with_context(|| format!("Could not inspect {}", audio_path.display()))?
                .len();
            let audio_intake_error = audio_intake_error(&capabilities, audio_size);
            if capabilities.features.multipart_audio_jobs_enabled && audio_intake_error.is_none() {
                let chat_context_json = job_context
                    .chat_context
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                client
                    .create_ai_job_from_audio(
                        &token,
                        AiAudioJobRequest {
                            audio_path,
                            client_request_id: &client_request_id,
                            client_version: DESKTOP_CLIENT_VERSION,
                            diagnostic_summary: job_context.diagnostic_summary,
                            health_events_json: &health_events_json,
                            session_client_id: session_id,
                            outputs: job_context.outputs.as_deref(),
                            tone: job_context.tone.as_deref(),
                            chat_context_json: chat_context_json.as_deref(),
                        },
                    )
                    .await?
                    .job
            } else if capabilities.features.object_backed_jobs_enabled
                && audio_intake_error.is_none()
            {
                create_object_backed_ai_job(&client, &token, &job_context, audio_path, audio_size)
                    .await?
            } else if capabilities.features.transcript_jobs_enabled {
                let transcript =
                    latest_local_transcript_text(state, session_id)?.with_context(|| {
                        audio_intake_error.clone().unwrap_or_else(|| {
                            "No ready local transcript is available for transcript-backed AI."
                                .to_string()
                        })
                    })?;
                create_transcript_backed_ai_job(&client, &token, &job_context, &transcript).await?
            } else if let Some(error) = audio_intake_error {
                bail!("{error}");
            } else {
                bail!("Videorc AI audio intake is not enabled for this account.");
            }
        }
    };

    let completed_job = wait_for_ai_job(
        state,
        session_id,
        &client,
        &token,
        initial_job,
        &capabilities,
    )
    .await?;
    save_completed_web_ai_artifacts(state, session_id, &completed_job)
}

fn validate_cloud_ai_capabilities(capabilities: &AiCapabilities) -> Result<()> {
    if !capabilities.entitlement.cloud_ai || !capabilities.readiness.access.cloud_ai_entitled {
        bail!("Cloud AI requires Videorc Premium.");
    }
    if capabilities.readiness.access.globally_disabled {
        bail!("Cloud AI is disabled on the Videorc server.");
    }
    if !capabilities.readiness.gateway.configured {
        bail!(
            "{}",
            capabilities
                .readiness
                .gateway
                .config_error
                .as_deref()
                .unwrap_or("Videorc AI Gateway is not configured.")
        );
    }
    if !capabilities.readiness.worker.configured {
        bail!(
            "{}",
            capabilities
                .readiness
                .worker
                .config_error
                .as_deref()
                .unwrap_or("Videorc AI worker is not configured.")
        );
    }
    if !capabilities.features.cloud_ai_enabled {
        bail!("Videorc cloud AI is not ready for this account.");
    }
    Ok(())
}

fn audio_intake_error(capabilities: &AiCapabilities, audio_size: u64) -> Option<String> {
    if !capabilities.readiness.transcription.configured {
        return Some(
            capabilities
                .readiness
                .transcription
                .config_error
                .clone()
                .unwrap_or_else(|| "Videorc cloud transcription is not configured.".to_string()),
        );
    }
    if let Some(max_audio_bytes) = capabilities.limits.max_audio_bytes
        && audio_size > max_audio_bytes
    {
        return Some(format!(
            "Recording audio is too large for configured AI intake ({} > {} bytes).",
            audio_size, max_audio_bytes
        ));
    }
    None
}

async fn create_object_backed_ai_job(
    client: &VideorcApiClient,
    token: &str,
    job_context: &WebAiJobContext<'_>,
    audio_path: &Path,
    audio_size: u64,
) -> Result<AiJobSnapshot> {
    let upload = client
        .request_ai_object_upload(
            token,
            &AiObjectUploadRequest {
                client_request_id: job_context.client_request_id,
                client_version: DESKTOP_CLIENT_VERSION,
                consent_to_upload_audio: true,
                file_name: "audio.m4a",
                mime_type: "audio/mp4",
                session_client_id: job_context.session_id,
                size_bytes: audio_size,
                workflow_kind: AI_WORKFLOW_KIND_POST_RECORDING,
            },
        )
        .await?;
    client.upload_ai_object(&upload.ticket, audio_path).await?;

    let mut job_request = upload.job_request;
    let mut input_json = json!({
        "diagnosticSummary": job_context.diagnostic_summary,
        "healthEvents": job_context.health_events,
    });
    if let (Some(object), Some(chat_context)) = (
        input_json.as_object_mut(),
        job_context.chat_context.as_ref(),
    ) {
        object.insert("chatContext".to_string(), chat_context.clone());
    }
    let object = job_request
        .as_object_mut()
        .context("AI object upload response did not include a job request object.")?;
    object.insert("inputJson".to_string(), input_json);
    apply_job_options(&mut job_request, job_context);
    Ok(client.create_ai_job(token, &job_request).await?.job)
}

async fn create_transcript_backed_ai_job(
    client: &VideorcApiClient,
    token: &str,
    job_context: &WebAiJobContext<'_>,
    transcript: &str,
) -> Result<AiJobSnapshot> {
    let mut input_json = json!({
        "diagnosticSummary": job_context.diagnostic_summary,
        "healthEvents": job_context.health_events,
        "transcript": transcript,
    });
    if let (Some(object), Some(chat_context)) = (
        input_json.as_object_mut(),
        job_context.chat_context.as_ref(),
    ) {
        object.insert("chatContext".to_string(), chat_context.clone());
    }
    let mut body = json!({
        "clientRequestId": job_context.client_request_id,
        "clientVersion": DESKTOP_CLIENT_VERSION,
        "inputJson": input_json,
        "sessionClientId": job_context.session_id,
        "workflowKind": AI_WORKFLOW_KIND_POST_RECORDING,
    });
    apply_job_options(&mut body, job_context);
    Ok(client.create_ai_job(token, &body).await?.job)
}

/// Attach capability-gated per-kind options to a job create body.
fn apply_job_options(body: &mut Value, job_context: &WebAiJobContext<'_>) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if let Some(outputs) = &job_context.outputs {
        object.insert("outputs".to_string(), json!(outputs));
    }
    if let Some(tone) = &job_context.tone {
        object.insert("tone".to_string(), json!(tone));
    }
}

async fn wait_for_ai_job(
    state: &AppState,
    session_id: &str,
    client: &VideorcApiClient,
    token: &str,
    initial_job: AiJobSnapshot,
    capabilities: &AiCapabilities,
) -> Result<AiJobSnapshot> {
    let started = tokio::time::Instant::now();
    let queued_delay = Duration::from_millis(capabilities.readiness.worker.queued_job_delay_ms);
    let running_delay = Duration::from_millis(capabilities.readiness.worker.running_job_timeout_ms);
    let mut queued_delay_reported = false;
    let mut running_delay_reported = false;
    let mut job = initial_job;
    loop {
        match job.status.as_str() {
            "completed" => return Ok(job),
            "failed" => {
                bail!(
                    "{}",
                    job.error_message
                        .as_deref()
                        .unwrap_or("Videorc AI job failed.")
                )
            }
            "cancelled" => bail!("Videorc AI job was cancelled."),
            _ => {}
        }
        let elapsed = started.elapsed();
        if job.status == "queued" && !queued_delay_reported && elapsed >= queued_delay {
            emit_health_event(
                state,
                Some(session_id),
                HealthLevel::Info,
                "cloud-ai-worker-delayed",
                "Queued - Videorc AI worker is delayed.",
            )?;
            queued_delay_reported = true;
        }
        if job.status == "running" && !running_delay_reported && elapsed >= running_delay {
            emit_health_event(
                state,
                Some(session_id),
                HealthLevel::Warn,
                "cloud-ai-worker-still-processing",
                "Still processing - Videorc AI is taking longer than expected.",
            )?;
            running_delay_reported = true;
        }
        if elapsed > AI_JOB_POLL_TIMEOUT {
            bail!("Videorc AI job timed out before completion.");
        }
        sleep(AI_JOB_POLL_INTERVAL).await;
        job = client.get_ai_job(token, &job.id).await?;
    }
}

fn save_completed_web_ai_artifacts(
    state: &AppState,
    session_id: &str,
    job: &AiJobSnapshot,
) -> Result<Vec<AiArtifact>> {
    let owner_artifacts = job
        .artifacts
        .as_ref()
        .context("Completed Videorc AI job did not include owner artifacts.")?;
    let mut saved = Vec::new();

    if let Some(transcript) = &owner_artifacts.transcript {
        saved.push(state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::Transcript,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "text": transcript.text,
                "transcription": owner_artifacts.transcription_metadata,
            }),
            None,
        )?);
    }

    // Per-kind jobs return only the requested generation blocks — an absent
    // block must never overwrite a previously generated artifact with empties.
    let publish_pack = object_or_empty(&owner_artifacts.publish_pack);
    if !publish_pack.is_empty() {
        saved.push(state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::TitleDescription,
            AiArtifactStatus::Ready,
            json!({
                "description": string_field(publish_pack, "description"),
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "title": string_field(publish_pack, "title"),
                "titleVariants": value_field(publish_pack, "titleVariants"),
            }),
            None,
        )?);
        saved.push(state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::Summary,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "text": string_field(publish_pack, "summary"),
            }),
            None,
        )?);
        saved.push(state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::Chapters,
            AiArtifactStatus::Ready,
            json!({
                "chapters": value_field(publish_pack, "chapters"),
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
            }),
            None,
        )?);
    }

    let social_posts = object_or_empty(&owner_artifacts.social_posts);
    if !social_posts.is_empty() {
        saved.push(state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::SocialPosts,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "twitchTitle": string_field(social_posts, "twitchTitle"),
                "xPost": string_field(social_posts, "xPost"),
                "xThread": value_field(social_posts, "xThread"),
            }),
            None,
        )?);
    }

    saved.extend(save_creator_intelligence_value_artifacts(
        state,
        session_id,
        job,
        &owner_artifacts.creator_intelligence,
    )?);
    Ok(saved)
}

fn object_or_empty(value: &Value) -> &serde_json::Map<String, Value> {
    static EMPTY: std::sync::OnceLock<serde_json::Map<String, Value>> = std::sync::OnceLock::new();
    value
        .as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(serde_json::Map::new))
}

fn string_field(object: &serde_json::Map<String, Value>, field: &str) -> String {
    object
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn value_field(object: &serde_json::Map<String, Value>, field: &str) -> Value {
    object.get(field).cloned().unwrap_or(Value::Null)
}

fn save_creator_intelligence_value_artifacts(
    state: &AppState,
    session_id: &str,
    job: &AiJobSnapshot,
    creator_intelligence: &Value,
) -> Result<Vec<AiArtifact>> {
    let intelligence = object_or_empty(creator_intelligence);
    // A per-kind job that did not ask for creator intelligence (the
    // post-stream pack asks for publish_pack + social_posts only) returns
    // null here. Saving five empty Ready artifacts would shadow real
    // highlights and light the pipeline dot for a step that never ran.
    if intelligence.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![
        state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::Highlights,
            AiArtifactStatus::Ready,
            json!({
                "highlights": value_field(intelligence, "highlights"),
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
            }),
            None,
        )?,
        state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::SmartZoom,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "suggestions": value_field(intelligence, "smartZoom"),
            }),
            None,
        )?,
        state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::NoiseCleanup,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "suggestions": value_field(intelligence, "noiseCleanup"),
            }),
            None,
        )?,
        state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::SilenceRemoval,
            AiArtifactStatus::Ready,
            json!({
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
                "suggestions": value_field(intelligence, "silenceRemoval"),
            }),
            None,
        )?,
        state.database.save_ai_artifact(
            session_id,
            AiArtifactKind::HealthAssistant,
            AiArtifactStatus::Ready,
            json!({
                "explanations": value_field(intelligence, "healthAssistant"),
                "jobId": job.id,
                "model": job.model,
                "provider": job.provider,
            }),
            None,
        )?,
    ])
}

const CHAT_CONTEXT_MAX_ENTRIES: usize = 100;
const CHAT_CONTEXT_MAX_TEXT_CHARS: usize = 500;

/// Top chat moments for grounding titles/highlights in audience reaction.
/// Evenly sampled when the session has more messages than the server cap.
fn build_chat_context(state: &AppState, session_id: &str) -> Option<Value> {
    let session_started_ms = state
        .database
        .list_sessions(500)
        .ok()?
        .into_iter()
        .find(|session| session.id == session_id)
        .and_then(|session| {
            chrono::DateTime::parse_from_rfc3339(&session.started_at)
                .ok()
                .map(|started| started.timestamp_millis())
        })?;
    let messages = state
        .database
        .list_live_chat_messages_recent(session_id, 500)
        .ok()?;
    if messages.is_empty() {
        return None;
    }
    let step = messages.len().div_ceil(CHAT_CONTEXT_MAX_ENTRIES).max(1);
    let entries: Vec<Value> = messages
        .iter()
        .step_by(step)
        .take(CHAT_CONTEXT_MAX_ENTRIES)
        .filter_map(|message| {
            let text: String = message
                .message_text
                .chars()
                .take(CHAT_CONTEXT_MAX_TEXT_CHARS)
                .collect();
            if text.trim().is_empty() {
                return None;
            }
            let at_ms = chrono::DateTime::parse_from_rfc3339(&message.received_at)
                .ok()
                .and_then(|received| {
                    u64::try_from(received.timestamp_millis() - session_started_ms).ok()
                });
            Some(json!({
                "atMs": at_ms,
                "platform": message.platform,
                "author": message.author_name,
                "text": text,
            }))
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    Some(Value::Array(entries))
}

fn diagnostic_summary_for_session(state: &AppState, session_id: &str) -> Option<String> {
    state
        .database
        .list_sessions(500)
        .ok()?
        .into_iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.final_diagnostics)
        .and_then(|diagnostics| serde_json::to_string(&diagnostics).ok())
}

fn latest_local_transcript_text(state: &AppState, session_id: &str) -> Result<Option<String>> {
    Ok(state
        .database
        .list_ai_artifacts(session_id)?
        .into_iter()
        .rev()
        .find_map(|artifact| {
            if artifact.kind != AiArtifactKind::Transcript
                || artifact.status != AiArtifactStatus::Ready
            {
                return None;
            }
            content_string(&artifact, "text").filter(|text| !text.trim().is_empty())
        }))
}

async fn ai_client_request_id(
    session_id: &str,
    audio_path: &Path,
    options_fingerprint: &str,
) -> Result<String> {
    let audio = fs::read(audio_path)
        .await
        .with_context(|| format!("Could not read {}", audio_path.display()))?;
    Ok(build_ai_client_request_id(
        session_id,
        &ai_input_hash(&audio, options_fingerprint),
    ))
}

/// The generation options that make one job differ from another over the
/// same input. Empty for a default full run (no outputs filter, no tone).
fn job_options_fingerprint(outputs: Option<&[String]>, tone: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(outputs) = outputs {
        let mut outputs = outputs.to_vec();
        outputs.sort();
        outputs.dedup();
        parts.push(format!("outputs={}", outputs.join(",")));
    }
    if let Some(tone) = tone {
        parts.push(format!("tone={tone}"));
    }
    parts.join(";")
}

/// SHA-256 of the job input, plus the options fingerprint when there is one
/// (so a default full run keeps the id it always had).
fn ai_input_hash(input: &[u8], options_fingerprint: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    if !options_fingerprint.is_empty() {
        hasher.update(b"\0");
        hasher.update(options_fingerprint.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn build_ai_client_request_id(session_id: &str, audio_hash: &str) -> String {
    let session_component = safe_client_request_component(session_id)
        .chars()
        .take(40)
        .collect::<String>();
    format!("desktop:{session_component}:{audio_hash}")
}

fn safe_client_request_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub fn list_ai_artifacts(state: &AppState, session_id: &str) -> Result<Vec<AiArtifact>> {
    state.database.list_ai_artifacts(session_id)
}

pub async fn export_publish_pack(
    state: AppState,
    params: ExportPublishPackParams,
) -> Result<ExportPublishPackResult> {
    let artifacts = state.database.list_ai_artifacts(&params.session_id)?;
    if !artifacts.iter().any(|artifact| {
        artifact.status == AiArtifactStatus::Ready && is_publish_pack_kind(&artifact.kind)
    }) {
        bail!("No ready AI artifacts are available for this session");
    }

    let artifact_dir = default_artifacts_dir().join(&params.session_id);
    fs::create_dir_all(&artifact_dir)
        .await
        .with_context(|| format!("Could not create {}", artifact_dir.display()))?;

    let markdown_path = artifact_dir.join("publish-pack.md");
    let markdown = render_publish_pack(&artifacts);
    fs::write(&markdown_path, markdown)
        .await
        .with_context(|| format!("Could not write {}", markdown_path.display()))?;

    // The pack finale advertises paste-ready per-field files — write every one
    // whose artifact is Ready (the checklist used to promise five files while
    // only the combined markdown existed).
    let mut files = vec![markdown_path.display().to_string()];
    for (file_name, content) in publish_pack_files(&artifacts) {
        let path = artifact_dir.join(file_name);
        fs::write(&path, content)
            .await
            .with_context(|| format!("Could not write {}", path.display()))?;
        files.push(path.display().to_string());
    }

    Ok(ExportPublishPackResult {
        session_id: params.session_id,
        markdown_path: markdown_path.display().to_string(),
        files,
    })
}

/// The per-field paste-ready files for a pack export, skipping artifacts that
/// are missing or empty. Pure so the file list is unit-testable.
fn publish_pack_files(artifacts: &[AiArtifact]) -> Vec<(&'static str, String)> {
    let title_description = latest_ready_artifact(artifacts, AiArtifactKind::TitleDescription);
    let mut files = Vec::new();
    if let Some(title) = title_description.and_then(|artifact| content_string(artifact, "title"))
        && !title.trim().is_empty()
    {
        files.push(("title.txt", title));
    }
    if let Some(description) =
        title_description.and_then(|artifact| content_string(artifact, "description"))
        && !description.trim().is_empty()
    {
        files.push(("description.txt", description));
    }
    if let Some(chapters) = latest_ready_artifact(artifacts, AiArtifactKind::Chapters) {
        let lines = chapter_lines(chapters);
        if !lines.is_empty() {
            files.push(("chapters.txt", lines.join("\n")));
        }
    }
    if let Some(summary) = latest_ready_artifact(artifacts, AiArtifactKind::Summary)
        .and_then(|artifact| content_string(artifact, "text"))
        && !summary.trim().is_empty()
    {
        files.push(("summary.md", summary));
    }
    if let Some(transcript) = latest_ready_artifact(artifacts, AiArtifactKind::Transcript)
        .and_then(|artifact| content_string(artifact, "text"))
        && !transcript.trim().is_empty()
    {
        files.push(("transcript.txt", transcript));
    }
    files
}

fn emit_ai_artifacts_changed(state: &AppState, session_id: &str) {
    state.emit_event(
        "ai.artifacts.changed",
        serde_json::json!({ "sessionId": session_id }),
    );
}

async fn extract_audio(ffmpeg_path: &str, input_path: &Path, output_path: &Path) -> Result<()> {
    let mut command = Command::new(ffmpeg_path);
    command
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            &input_path.display().to_string(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            &output_path.display().to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = timeout(
        Duration::from_secs(20 * 60),
        output_owned_tokio(&mut command),
    )
    .await
    .context("FFmpeg audio extraction timed out")?
    .with_context(|| format!("Could not start {ffmpeg_path} for audio extraction"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "FFmpeg audio extraction failed with {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }

    Ok(())
}

/// The `<recording>.srt` transcript in the two shapes the workflow needs.
struct CaptionsTranscript {
    srt_path: PathBuf,
    /// Plain prose, one cue per line: the Transcript card and transcript.txt.
    text: String,
    /// `[m:ss]` blocks (see `timed_transcript_text`): what the cloud job reads.
    timed_text: String,
}

/// Live captions (or Orcle listening) write `<recording>.srt` next to the
/// finished file (captions.rs). If it exists and parses to a non-empty
/// transcript, the publish workflow can skip audio extraction and cloud
/// transcription.
async fn captions_transcript_for(input_path: &Path) -> Option<CaptionsTranscript> {
    let srt_path = input_path.with_extension("srt");
    let content = fs::read_to_string(&srt_path).await.ok()?;
    let cues = parse_srt(&content);
    let text = caption_cues_text(&cues);
    if text.trim().is_empty() {
        return None;
    }
    Some(CaptionsTranscript {
        srt_path,
        text,
        timed_text: timed_transcript_text(&cues),
    })
}

/// A new timed-transcript block starts at the first cue this far past the
/// current block's first cue.
const TIMED_TRANSCRIPT_BLOCK_MS: u64 = 30_000;
/// The web job route rejects transcripts over 120,000 characters
/// (`transcript-too-large`); stay well under it.
const TIMED_TRANSCRIPT_MAX_CHARS: usize = 110_000;

/// The transcript the post-recording job reads: cues grouped into ~30 s
/// blocks, one line per block, `[m:ss] words…` (`[h:mm:ss]` from an hour).
/// That is the clock the web prompt already uses for its timestamped chat
/// moments and YouTube uses for chapters, so the model reads one notation
/// and its chapters carry real times instead of guesses (plan 068 D10).
///
/// Over `TIMED_TRANSCRIPT_MAX_CHARS` (counted in UTF-16 units, like the web's
/// `string.length`), whole blocks are dropped from the START (the end of a
/// stream is what the pack is about) and one note line says where the text
/// now begins. An empty cue list gives an empty string.
pub fn timed_transcript_text(cues: &[CaptionCue]) -> String {
    timed_transcript_text_capped(cues, TIMED_TRANSCRIPT_MAX_CHARS)
}

fn timed_transcript_text_capped(cues: &[CaptionCue], max_chars: usize) -> String {
    let blocks = timed_transcript_blocks(cues);
    let lengths: Vec<usize> = blocks.iter().map(|(_, line)| utf16_len(line)).collect();
    // Every kept line but the last is followed by one '\n'.
    let mut kept_len = lengths.iter().sum::<usize>() + blocks.len().saturating_sub(1);
    if kept_len <= max_chars {
        return join_block_lines(&blocks);
    }
    for first in 1..blocks.len() {
        kept_len -= lengths[first - 1] + 1;
        let note = transcript_omitted_note(blocks[first].0);
        if utf16_len(&note) + 1 + kept_len <= max_chars {
            return format!("{note}\n{}", join_block_lines(&blocks[first..]));
        }
    }
    // Only reachable when one block alone is over the cap: keep that block's
    // newest words so the job still gets text inside the limit.
    let Some((start_ms, line)) = blocks.last() else {
        return String::new();
    };
    let note = transcript_omitted_note(*start_ms);
    let budget = max_chars.saturating_sub(utf16_len(&note) + 1);
    format!("{note}\n{}", utf16_tail(line, budget))
}

/// `(block start ms, "[m:ss] text text…")` for each ~30 s block, in cue order.
fn timed_transcript_blocks(cues: &[CaptionCue]) -> Vec<(u64, String)> {
    let mut blocks: Vec<(u64, String)> = Vec::new();
    for cue in cues {
        let text = cue.text.trim();
        if text.is_empty() {
            continue;
        }
        match blocks.last_mut() {
            Some((start_ms, line))
                if cue.start_ms < start_ms.saturating_add(TIMED_TRANSCRIPT_BLOCK_MS) =>
            {
                line.push(' ');
                line.push_str(text);
            }
            _ => blocks.push((
                cue.start_ms,
                format!("[{}] {text}", transcript_clock(cue.start_ms)),
            )),
        }
    }
    blocks
}

fn join_block_lines(blocks: &[(u64, String)]) -> String {
    blocks
        .iter()
        .map(|(_, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn transcript_omitted_note(start_ms: u64) -> String {
    format!(
        "[transcript starts at {}; earlier part omitted for length]",
        transcript_clock(start_ms)
    )
}

/// `m:ss` under an hour, `h:mm:ss` from an hour (seconds floored).
fn transcript_clock(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The longest suffix of `text` that fits in `budget` UTF-16 units.
fn utf16_tail(text: &str, budget: usize) -> &str {
    let mut used = 0;
    let mut start = text.len();
    for (index, ch) in text.char_indices().rev() {
        used += ch.len_utf16();
        if used > budget {
            break;
        }
        start = index;
    }
    &text[start..]
}

fn render_publish_pack(artifacts: &[AiArtifact]) -> String {
    let title_description = latest_ready_artifact(artifacts, AiArtifactKind::TitleDescription);
    let transcript = latest_ready_artifact(artifacts, AiArtifactKind::Transcript);
    let summary = latest_ready_artifact(artifacts, AiArtifactKind::Summary);
    let chapters = latest_ready_artifact(artifacts, AiArtifactKind::Chapters);
    let highlights = latest_ready_artifact(artifacts, AiArtifactKind::Highlights);
    let smart_zoom = latest_ready_artifact(artifacts, AiArtifactKind::SmartZoom);
    let noise_cleanup = latest_ready_artifact(artifacts, AiArtifactKind::NoiseCleanup);
    let silence_removal = latest_ready_artifact(artifacts, AiArtifactKind::SilenceRemoval);
    let health_assistant = latest_ready_artifact(artifacts, AiArtifactKind::HealthAssistant);

    let title = title_description
        .and_then(|artifact| content_string(artifact, "title"))
        .unwrap_or_else(|| "Untitled Videorc Session".to_string());
    let description = title_description
        .and_then(|artifact| content_string(artifact, "description"))
        .unwrap_or_default();
    let summary_text = summary
        .and_then(|artifact| content_string(artifact, "text"))
        .unwrap_or_default();
    let transcript_text = transcript
        .and_then(|artifact| content_string(artifact, "text"))
        .unwrap_or_default();

    let mut markdown = format!("# {title}\n\n");
    if !description.is_empty() {
        markdown.push_str("## Description\n\n");
        markdown.push_str(&description);
        markdown.push_str("\n\n");
    }
    if !summary_text.is_empty() {
        markdown.push_str("## Summary\n\n");
        markdown.push_str(&summary_text);
        markdown.push_str("\n\n");
    }
    if let Some(chapters) = chapters {
        let lines = chapter_lines(chapters);
        if !lines.is_empty() {
            markdown.push_str("## Chapters\n\n");
            for line in lines {
                markdown.push_str("- ");
                markdown.push_str(&line);
                markdown.push('\n');
            }
            markdown.push('\n');
        }
    }
    if let Some(highlights) = highlights {
        let lines = object_lines(
            highlights,
            "highlights",
            &["timestamp", "title", "reason", "suggestedUse"],
        );
        if !lines.is_empty() {
            markdown.push_str("## Highlights\n\n");
            push_markdown_list(&mut markdown, lines);
        }
    }
    if let Some(smart_zoom) = smart_zoom {
        let lines = object_lines(
            smart_zoom,
            "suggestions",
            &["timestamp", "action", "subject", "reason"],
        );
        if !lines.is_empty() {
            markdown.push_str("## Smart Zoom Notes\n\n");
            push_markdown_list(&mut markdown, lines);
        }
    }
    let cleanup_lines = noise_cleanup
        .map(|artifact| {
            object_lines(
                artifact,
                "suggestions",
                &["issue", "suggestion", "confidence"],
            )
        })
        .unwrap_or_default()
        .into_iter()
        .chain(
            silence_removal
                .map(|artifact| {
                    object_lines(
                        artifact,
                        "suggestions",
                        &["timestamp", "reason", "editSuggestion"],
                    )
                })
                .unwrap_or_default(),
        )
        .collect::<Vec<_>>();
    if !cleanup_lines.is_empty() {
        markdown.push_str("## Cleanup Suggestions\n\n");
        push_markdown_list(&mut markdown, cleanup_lines);
    }
    if let Some(health_assistant) = health_assistant {
        let lines = object_lines(
            health_assistant,
            "explanations",
            &["level", "issue", "explanation", "action"],
        );
        if !lines.is_empty() {
            markdown.push_str("## Health Assistant\n\n");
            push_markdown_list(&mut markdown, lines);
        }
    }
    if !transcript_text.is_empty() {
        markdown.push_str("## Transcript\n\n");
        markdown.push_str(&transcript_text);
        markdown.push('\n');
    }

    markdown
}

fn latest_ready_artifact(artifacts: &[AiArtifact], kind: AiArtifactKind) -> Option<&AiArtifact> {
    artifacts
        .iter()
        .rev()
        .find(|artifact| artifact.kind == kind && artifact.status == AiArtifactStatus::Ready)
}

fn is_publish_pack_kind(kind: &AiArtifactKind) -> bool {
    matches!(
        kind,
        AiArtifactKind::Transcript
            | AiArtifactKind::TitleDescription
            | AiArtifactKind::Summary
            | AiArtifactKind::Chapters
            | AiArtifactKind::Highlights
            | AiArtifactKind::SmartZoom
            | AiArtifactKind::NoiseCleanup
            | AiArtifactKind::SilenceRemoval
            | AiArtifactKind::HealthAssistant
    )
}

fn content_string(artifact: &AiArtifact, key: &str) -> Option<String> {
    artifact
        .content
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn chapter_lines(artifact: &AiArtifact) -> Vec<String> {
    artifact
        .content
        .get("chapters")
        .and_then(Value::as_array)
        .map(|chapters| {
            chapters
                .iter()
                .filter_map(|chapter| {
                    let timestamp = chapter.get("timestamp").and_then(Value::as_str)?;
                    let title = chapter.get("title").and_then(Value::as_str)?;
                    Some(format!("{timestamp} {title}"))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn object_lines(artifact: &AiArtifact, key: &str, fields: &[&str]) -> Vec<String> {
    artifact
        .content
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let values = fields
                        .iter()
                        .filter_map(|field| object.get(*field).and_then(Value::as_str))
                        .filter(|value| !value.trim().is_empty())
                        .collect::<Vec<_>>();
                    (!values.is_empty()).then(|| values.join(" - "))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn push_markdown_list(markdown: &mut String, lines: Vec<String>) {
    for line in lines {
        markdown.push_str("- ");
        markdown.push_str(&line);
        markdown.push('\n');
    }
    markdown.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue_at(start_ms: u64, text: &str) -> CaptionCue {
        CaptionCue {
            start_ms,
            end_ms: start_ms + 2_000,
            text: text.to_string(),
        }
    }

    #[test]
    fn timed_transcript_groups_cues_into_thirty_second_blocks() {
        let cues = vec![
            cue_at(1_200, "Welcome back"),
            cue_at(12_000, "today we build it"),
            cue_at(31_199, "still the first block"),
            cue_at(31_200, "a new block starts"),
            cue_at(95_000, "after a pause"),
        ];

        assert_eq!(
            timed_transcript_text(&cues),
            "[0:01] Welcome back today we build it still the first block\n\
             [0:31] a new block starts\n\
             [1:35] after a pause"
        );
    }

    #[test]
    fn timed_transcript_uses_hours_from_the_first_hour() {
        let cues = vec![
            cue_at(3_599_999, "last words of the hour"),
            cue_at(3_723_456, "into the second hour"),
            cue_at(36_000_000, "ten hours in"),
        ];

        assert_eq!(
            timed_transcript_text(&cues),
            "[59:59] last words of the hour\n[1:02:03] into the second hour\n[10:00:00] ten hours in"
        );
    }

    #[test]
    fn timed_transcript_of_an_empty_srt_is_empty() {
        assert_eq!(timed_transcript_text(&parse_srt("")), "");
        assert_eq!(timed_transcript_text(&[]), "");
    }

    #[test]
    fn timed_transcript_over_the_cap_drops_whole_blocks_from_the_start() {
        // Ten blocks, 30 s apart, each "[m:ss] block N words…".
        let cues: Vec<CaptionCue> = (0..10)
            .map(|index| {
                cue_at(
                    index * 30_000,
                    &format!("block {index} {}", "word ".repeat(20)),
                )
            })
            .collect();
        let full = timed_transcript_text_capped(&cues, usize::MAX);
        let full_lines: Vec<&str> = full.lines().collect();
        assert_eq!(full_lines.len(), 10);
        assert_eq!(timed_transcript_text(&cues), full, "far under the real cap");

        let cap = full.len() / 2;
        let capped = timed_transcript_text_capped(&cues, cap);
        assert!(utf16_len(&capped) <= cap, "{} > {cap}", utf16_len(&capped));
        let mut lines = capped.lines();
        let note = lines.next().unwrap();
        let kept: Vec<&str> = lines.collect();
        // The kept lines are the newest whole blocks, untouched.
        assert!(!kept.is_empty() && kept.len() < 10);
        assert_eq!(kept, full_lines[10 - kept.len()..].to_vec());
        let first_kept = 10 - kept.len();
        assert_eq!(
            note,
            format!(
                "[transcript starts at {}; earlier part omitted for length]",
                transcript_clock(first_kept as u64 * 30_000)
            )
        );
        // As many blocks as fit: one more would break the cap.
        let one_more = format!(
            "{}\n{}",
            transcript_omitted_note((first_kept as u64 - 1) * 30_000),
            full_lines[first_kept - 1..].join("\n")
        );
        assert!(utf16_len(&one_more) > cap);
    }

    #[test]
    fn timed_transcript_cap_counts_utf16_units_like_the_web() {
        // "😀" is one char but two UTF-16 units; the web's `.length` counts two.
        let cues = vec![cue_at(0, &"😀".repeat(100)), cue_at(30_000, "tail")];
        let full = timed_transcript_text_capped(&cues, usize::MAX);
        assert_eq!(full.chars().count(), 7 + 100 + 1 + 11);
        assert_eq!(utf16_len(&full), 7 + 200 + 1 + 11);
        // Fits by chars (119), not by UTF-16 units (219): it must be cut.
        let capped = timed_transcript_text_capped(&cues, 150);
        assert_eq!(
            capped,
            "[transcript starts at 0:30; earlier part omitted for length]\n[0:30] tail"
        );
    }

    #[test]
    fn timed_transcript_keeps_the_newest_words_when_one_block_is_over_the_cap() {
        let cues = vec![cue_at(65_000, &"x".repeat(500))];
        let capped = timed_transcript_text_capped(&cues, 200);
        assert!(utf16_len(&capped) <= 200);
        assert!(
            capped.starts_with("[transcript starts at 1:05; earlier part omitted for length]\n")
        );
        assert!(capped.ends_with("xxx"));
    }

    #[test]
    fn a_job_without_creator_intelligence_saves_no_empty_intelligence_artifacts() {
        let (events, _) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let job: AiJobSnapshot = serde_json::from_value(json!({
            "artifacts": {
                "creatorIntelligence": null,
                "publishPack": {
                    "title": "Shipping the thing",
                    "titleVariants": ["Shipping the thing"],
                    "description": "We ship it.",
                    "summary": "Shipped.",
                    "chapters": [{ "timestamp": "0:00", "title": "Intro" }]
                },
                "socialPosts": { "xPost": "Shipped", "xThread": [], "twitchTitle": "Shipping" },
                "transcript": null,
                "transcriptionMetadata": null
            },
            "clientRequestId": null,
            "completedAt": null,
            "costEstimateCents": null,
            "createdAt": "2026-09-27T00:00:00Z",
            "errorCode": null,
            "errorMessage": null,
            "id": "job-1",
            "inputTokens": null,
            "model": null,
            "outputJson": null,
            "outputTokens": null,
            "provider": "videorc",
            "runAttempts": 1,
            "sessionClientId": "missing-session",
            "startedAt": null,
            "status": "completed",
            "workflowKind": AI_WORKFLOW_KIND_POST_RECORDING
        }))
        .unwrap();

        let owner = job.artifacts.as_ref().unwrap();
        let saved = save_creator_intelligence_value_artifacts(
            &state,
            "missing-session",
            &job,
            &owner.creator_intelligence,
        )
        .unwrap();
        assert!(saved.is_empty());
    }

    #[test]
    fn a_partial_run_never_shares_a_request_id_with_the_full_run() {
        let transcript = b"[0:00] hello";
        // A default full run keeps the plain content hash it always had.
        assert_eq!(
            ai_input_hash(transcript, &job_options_fingerprint(None, None)),
            format!("{:x}", Sha256::digest(transcript))
        );
        let pack = job_options_fingerprint(
            Some(&["social_posts".to_string(), "publish_pack".to_string()]),
            None,
        );
        assert_eq!(pack, "outputs=publish_pack,social_posts");
        assert_eq!(
            pack,
            job_options_fingerprint(
                Some(&["publish_pack".to_string(), "social_posts".to_string()]),
                None
            ),
            "output order does not matter"
        );
        let full = ai_input_hash(transcript, "");
        let partial = ai_input_hash(transcript, &pack);
        let highlights = ai_input_hash(
            transcript,
            &job_options_fingerprint(Some(&["creator_intelligence".to_string()]), None),
        );
        let casual = ai_input_hash(
            transcript,
            &job_options_fingerprint(Some(&["publish_pack".to_string()]), Some("casual")),
        );
        assert_ne!(full, partial);
        assert_ne!(partial, highlights);
        assert_ne!(
            casual,
            ai_input_hash(
                transcript,
                &job_options_fingerprint(Some(&["publish_pack".to_string()]), None)
            )
        );
        // Still a 64-hex digest, so the id stays inside the server's length cap.
        assert_eq!(partial.len(), 64);
    }

    #[test]
    fn publish_pack_files_write_only_ready_nonempty_fields() {
        let artifacts = vec![
            AiArtifact {
                id: "1".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::TitleDescription,
                status: AiArtifactStatus::Ready,
                content: json!({ "title": "How I Built X", "description": "" }),
                file_path: None,
                created_at: "2026-07-11T00:00:00Z".to_string(),
            },
            AiArtifact {
                id: "2".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::Transcript,
                status: AiArtifactStatus::Ready,
                content: json!({ "text": "hello world" }),
                file_path: None,
                created_at: "2026-07-11T00:00:00Z".to_string(),
            },
        ];

        let files = publish_pack_files(&artifacts);
        let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();

        // Empty description and missing summary/chapters are skipped — the
        // export writes exactly the paste-ready fields that exist.
        assert_eq!(names, vec!["title.txt", "transcript.txt"]);
        assert_eq!(files[0].1, "How I Built X");
    }

    #[test]
    fn renders_publish_pack_markdown() {
        let artifacts = vec![
            AiArtifact {
                id: "1".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::TitleDescription,
                status: AiArtifactStatus::Ready,
                content: json!({
                    "title": "Tutorial Session",
                    "description": "Learn the flow.",
                }),
                file_path: None,
                created_at: "2026-05-30T00:00:00Z".to_string(),
            },
            AiArtifact {
                id: "2".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::Chapters,
                status: AiArtifactStatus::Ready,
                content: json!({
                    "chapters": [{"timestamp": "00:00", "title": "Intro"}],
                }),
                file_path: None,
                created_at: "2026-05-30T00:00:01Z".to_string(),
            },
            AiArtifact {
                id: "3".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::Highlights,
                status: AiArtifactStatus::Ready,
                content: json!({
                    "highlights": [{"timestamp": "00:12", "title": "Aha moment", "reason": "Useful clip", "suggestedUse": "Short"}],
                }),
                file_path: None,
                created_at: "2026-05-30T00:00:02Z".to_string(),
            },
            AiArtifact {
                id: "4".to_string(),
                session_id: "session".to_string(),
                kind: AiArtifactKind::HealthAssistant,
                status: AiArtifactStatus::Ready,
                content: json!({
                    "explanations": [{"level": "warn", "issue": "Dropped frames", "explanation": "Encoder overload", "action": "Lower bitrate"}],
                }),
                file_path: None,
                created_at: "2026-05-30T00:00:03Z".to_string(),
            },
        ];

        let markdown = render_publish_pack(&artifacts);

        assert!(markdown.contains("# Tutorial Session"));
        assert!(markdown.contains("## Description"));
        assert!(markdown.contains("- 00:00 Intro"));
        assert!(markdown.contains("## Highlights"));
        assert!(markdown.contains("## Health Assistant"));
    }

    #[test]
    fn client_request_component_uses_supported_characters() {
        assert_eq!(
            safe_client_request_component("session id/with spaces"),
            "session_id_with_spaces"
        );
        assert_eq!(
            safe_client_request_component("retry:session_123.1"),
            "retry:session_123.1"
        );
    }

    #[test]
    fn client_request_id_preserves_hash_with_long_session_ids() {
        let hash = "a".repeat(64);
        let id = build_ai_client_request_id("session/with spaces/".repeat(8).as_str(), &hash);

        assert!(id.len() <= 120);
        assert!(id.ends_with(&format!(":{hash}")));
        assert!(!id.contains('/'));
        assert!(!id.contains(' '));
    }
}
