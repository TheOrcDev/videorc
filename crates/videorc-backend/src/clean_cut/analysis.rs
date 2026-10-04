//! The cloud analysis job (docs/clean-cut-contract.md, part C): sentences go
//! up as `post-recording-clean-cut` input, retakes and false starts (and,
//! for Condensed, the kept selection) come back by segment id. The create
//! call uploads transcript text and therefore holds the maintenance slot;
//! polling does not.
//!
//! `clean_cut_jobs.analysis_json` holds an [`AnalysisRecord`]: the target
//! length chosen at start, then the server job id, then its result. The
//! segments themselves are never stored: regrouping the saved transcript is
//! deterministic, and the server forgets its copy once the job is terminal.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::edl::{CloudDrop, CloudKeep, Segment, sentences, total_text_chars};
use super::job::{
    ERROR_ANALYSIS, ERROR_ANALYSIS_TIMEOUT, ERROR_TRANSCRIPT_TOO_LONG, JobFailure, PhaseOutcome,
    WorkerContext, persist_and_emit, set_job_state,
};
use super::rules::{
    ANALYSIS_MAX_TOTAL_CHARS, ANALYSIS_POLL_TIMEOUT_SECS, CONDENSED_DEFAULT_TARGET_SECONDS,
    CONDENSED_MAX_TARGET_SECONDS, CONDENSED_MIN_TARGET_SECONDS,
};
use super::transcribe::{TranscriptBundle, map_job_failure};
use crate::moments;
use crate::protocol::{CleanCutJobState, CleanCutMode, ClipMoment, ClipMomentSource};
use crate::storage::PersistedCleanCutJob;
use crate::videorc_api::{AiApiFailure, AiJobCleanCutWindows};

pub const ANALYSIS_RECORD_VERSION: u32 = 1;
pub const WORKFLOW_KIND: &str = "post-recording-clean-cut";
const DESKTOP_CLIENT_VERSION: &str = concat!("videorc-desktop/", env!("CARGO_PKG_VERSION"));
const CREATE_ATTEMPTS: u32 = 3;
const POLL_FIRST_DELAY: Duration = Duration::from_secs(3);
const POLL_MAX_DELAY: Duration = Duration::from_secs(20);
const POLL_FAILURE_MAX_DELAY: Duration = Duration::from_secs(60);
const POLL_MAX_CONSECUTIVE_FAILURES: u32 = 10;
/// Progress shares of the whole job for this phase.
const PROGRESS_ANALYSIS_START: f64 = 0.88;
const PROGRESS_ANALYSIS_SPAN: f64 = 0.10;

/// What is known about the server-side analysis of one job.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRecord {
    #[serde(default)]
    pub version: u32,
    /// Condensed only; chosen at `cleanCut.start`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_duration_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    /// `pending`, `completed`, or `skipped` (nothing to analyse).
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<AiJobCleanCutWindows>,
    /// `artifacts.cleanCut`, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

impl AnalysisRecord {
    pub fn new(target_duration_seconds: Option<u32>) -> Self {
        Self {
            version: ANALYSIS_RECORD_VERSION,
            target_duration_seconds,
            ..Self::default()
        }
    }

    pub fn from_persisted(persisted: &PersistedCleanCutJob) -> Self {
        persisted
            .analysis_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<AnalysisRecord>(json).ok())
            .filter(|record| record.version == ANALYSIS_RECORD_VERSION)
            .unwrap_or_else(|| AnalysisRecord::new(None))
    }

    pub fn store(&self, persisted: &mut PersistedCleanCutJob) {
        persisted.analysis_json = serde_json::to_string(self).ok();
    }
}

/// `artifacts.cleanCut`, read leniently: unknown drop kinds survive as
/// strings (and are skipped when mapped), `beats` are kept only as raw JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudResult {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub drops: Vec<CloudDrop>,
    #[serde(default)]
    pub keeps: Vec<CloudKeep>,
    #[serde(default)]
    pub beats: Vec<Value>,
    #[serde(default)]
    pub windows: Option<AiJobCleanCutWindows>,
}

pub fn parse_cloud_result(value: &Value) -> CloudResult {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

/// A `mustKeep` range for Condensed: a clip mark or a chat peak, as segment ids.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MustKeep {
    pub from_id: String,
    pub to_id: String,
    pub reason: String,
}

/// Snap each moment to the sentences it overlaps.
pub fn must_keep_from_moments(moments: &[ClipMoment], segments: &[Segment]) -> Vec<MustKeep> {
    moments
        .iter()
        .filter_map(|moment| {
            let overlapping: Vec<&Segment> = segments
                .iter()
                .filter(|segment| {
                    segment.end_ms > moment.start_ms && segment.start_ms < moment.end_ms
                })
                .collect();
            let first = overlapping.first()?;
            let last = overlapping.last()?;
            Some(MustKeep {
                from_id: first.id.clone(),
                to_id: last.id.clone(),
                reason: match moment.source {
                    Some(ClipMomentSource::Chat) => "chat-peak".to_string(),
                    _ => "clip-mark".to_string(),
                },
            })
        })
        .collect()
}

pub fn clamp_target_seconds(target: Option<u32>) -> u32 {
    target
        .unwrap_or(CONDENSED_DEFAULT_TARGET_SECONDS)
        .clamp(CONDENSED_MIN_TARGET_SECONDS, CONDENSED_MAX_TARGET_SECONDS)
}

/// The `inputJson` of the analysis job.
pub fn build_input_json(
    mode: CleanCutMode,
    duration_ms: u64,
    language: Option<&str>,
    segments: &[Segment],
    target_duration_seconds: Option<u32>,
    must_keep: &[MustKeep],
) -> Value {
    let mut input = json!({
        "mode": mode.as_str(),
        "durationMs": duration_ms,
        "language": language,
        "segments": segments
            .iter()
            .map(|segment| json!({
                "id": segment.id,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
                "text": segment.text,
            }))
            .collect::<Vec<Value>>(),
    });
    if mode == CleanCutMode::Condensed {
        input["targetDurationSeconds"] = json!(clamp_target_seconds(target_duration_seconds));
        input["mustKeep"] = json!(must_keep);
    }
    input
}

/// `cleancut:<sessionId>:<mode>:<16 hex of a hash of the input>`.
pub fn client_request_id(session_id: &str, mode: CleanCutMode, input: &Value) -> String {
    let digest = Sha256::digest(input.to_string().as_bytes());
    let hex: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("cleancut:{session_id}:{}:{hex}", mode.as_str())
}

pub fn build_job_body(session_id: &str, client_request_id: &str, input: Value) -> Value {
    json!({
        "sessionClientId": session_id,
        "workflowKind": WORKFLOW_KIND,
        "clientRequestId": client_request_id,
        "clientVersion": DESKTOP_CLIENT_VERSION,
        "consentToUploadAudio": true,
        "inputJson": input,
    })
}

fn analysis_progress(windows: Option<&AiJobCleanCutWindows>) -> f64 {
    let share = windows
        .filter(|windows| windows.total > 0)
        .map(|windows| f64::from(windows.completed.min(windows.total)) / f64::from(windows.total))
        .unwrap_or(0.0);
    PROGRESS_ANALYSIS_START + PROGRESS_ANALYSIS_SPAN * share
}

/// Create the analysis job unless the record already names one. Needs the
/// slot: the request carries the transcript text.
pub async fn ensure_analysis_started(
    ctx: &WorkerContext<'_>,
    persisted: &mut PersistedCleanCutJob,
    bundle: &TranscriptBundle,
) -> PhaseOutcome<AnalysisRecord> {
    let mut record = AnalysisRecord::from_persisted(persisted);
    if record.job_id.is_some() || record.status == "skipped" {
        return PhaseOutcome::Done(record);
    }
    set_job_state(
        ctx.state,
        persisted,
        CleanCutJobState::Analyzing,
        Some("analyze"),
        PROGRESS_ANALYSIS_START,
    );

    let segments = sentences(&bundle.transcript.words);
    if segments.is_empty() {
        record.status = "skipped".to_string();
        record.store(persisted);
        persist_and_emit(ctx.state, persisted);
        return PhaseOutcome::Done(record);
    }
    if total_text_chars(&segments) > ANALYSIS_MAX_TOTAL_CHARS {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_TRANSCRIPT_TOO_LONG,
            "This recording's transcript is too long for Clean cut.",
        ));
    }

    let mode = persisted.job.mode;
    let session_id = persisted.job.source_session_id.clone();
    let must_keep = if mode == CleanCutMode::Condensed {
        match moments::session_moments(ctx.state, &session_id).await {
            Ok(Some(moments)) => must_keep_from_moments(&moments.moments, &segments),
            Ok(None) => Vec::new(),
            Err(error) => {
                ctx.state.emit_log(
                    "warn",
                    format!("Clean cut: could not read the moments of {session_id}: {error:#}"),
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let input = build_input_json(
        mode,
        bundle.plan.duration_ms,
        bundle.transcript.language.as_deref(),
        &segments,
        record.target_duration_seconds,
        &must_keep,
    );
    let request_id = client_request_id(&session_id, mode, &input);
    let body = build_job_body(&session_id, &request_id, input);

    let interrupts = ctx.interrupts();
    let created = tokio::select! {
        created = create_with_retries(ctx, &body) => created,
        outcome = interrupts.wait() => return outcome,
    };
    match created {
        Ok(snapshot) => {
            record.job_id = Some(snapshot.id.clone());
            record.client_request_id = Some(request_id);
            record.status = "pending".to_string();
            // An idempotent create may hand back a job that already finished.
            let finished_result = if snapshot.status == "completed" {
                snapshot.artifacts.and_then(|artifacts| artifacts.clean_cut)
            } else {
                None
            };
            if let Some(result) = finished_result {
                record.status = "completed".to_string();
                record.result = Some(result);
            }
            record.store(persisted);
            persist_and_emit(ctx.state, persisted);
            PhaseOutcome::Done(record)
        }
        Err(failure) => {
            ctx.state.emit_log(
                "warn",
                format!(
                    "Clean cut analysis job could not be created for {session_id}: {}",
                    failure.message()
                ),
            );
            PhaseOutcome::Failed(map_job_failure(&failure))
        }
    }
}

async fn create_with_retries(
    ctx: &WorkerContext<'_>,
    body: &Value,
) -> Result<crate::videorc_api::AiJobPollSnapshot, AiApiFailure> {
    let mut attempt = 1_u32;
    loop {
        match ctx.client.create_ai_job_checked(ctx.token, body).await {
            Ok(snapshot) => return Ok(snapshot),
            Err(failure) if failure.is_retryable() && attempt < CREATE_ATTEMPTS => {
                tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
                attempt += 1;
            }
            Err(failure) => return Err(failure),
        }
    }
}

/// Poll until the job is terminal. `running` may go back to `queued` while
/// the server continues within a new time budget; that is progress, not a
/// failure. Needs no slot: pass `ctx.without_slot()`.
pub async fn wait_for_result(
    ctx: &WorkerContext<'_>,
    persisted: &mut PersistedCleanCutJob,
    mut record: AnalysisRecord,
) -> PhaseOutcome<CloudResult> {
    if record.status == "skipped" {
        return PhaseOutcome::Done(CloudResult::default());
    }
    if let Some(result) = record.result.as_ref() {
        return PhaseOutcome::Done(parse_cloud_result(result));
    }
    let Some(job_id) = record.job_id.clone() else {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_ANALYSIS,
            "The analysis job was never created.",
        ));
    };

    let started = Instant::now();
    let mut delay = POLL_FIRST_DELAY;
    let mut consecutive_failures = 0_u32;
    let interrupts = ctx.interrupts();
    loop {
        if let Some(outcome) = interrupts.check() {
            return outcome;
        }
        if started.elapsed() > Duration::from_secs(ANALYSIS_POLL_TIMEOUT_SECS) {
            return PhaseOutcome::Failed(JobFailure::new(
                ERROR_ANALYSIS_TIMEOUT,
                "The analysis took too long. Start Clean cut again to retry.",
            ));
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            outcome = interrupts.wait() => return outcome,
        }
        let snapshot = match ctx.client.get_ai_job_checked(ctx.token, &job_id).await {
            Ok(snapshot) => snapshot,
            Err(failure)
                if failure.is_retryable()
                    && consecutive_failures < POLL_MAX_CONSECUTIVE_FAILURES =>
            {
                consecutive_failures += 1;
                delay = (delay * 2).min(POLL_FAILURE_MAX_DELAY);
                continue;
            }
            Err(failure) => return PhaseOutcome::Failed(map_job_failure(&failure)),
        };
        consecutive_failures = 0;
        delay = (delay * 3 / 2).min(POLL_MAX_DELAY);
        match snapshot.status.as_str() {
            "completed" => {
                let Some(result) = snapshot.artifacts.and_then(|artifacts| artifacts.clean_cut)
                else {
                    return PhaseOutcome::Failed(JobFailure::new(
                        ERROR_ANALYSIS,
                        "The analysis finished without a result.",
                    ));
                };
                record.status = "completed".to_string();
                record.result = Some(result.clone());
                record.store(persisted);
                set_job_state(
                    ctx.state,
                    persisted,
                    CleanCutJobState::Analyzing,
                    Some("cut-list"),
                    PROGRESS_ANALYSIS_START + PROGRESS_ANALYSIS_SPAN,
                );
                return PhaseOutcome::Done(parse_cloud_result(&result));
            }
            "failed" => {
                return PhaseOutcome::Failed(JobFailure::new(
                    snapshot
                        .error_code
                        .filter(|code| !code.trim().is_empty())
                        .unwrap_or_else(|| ERROR_ANALYSIS.to_string()),
                    snapshot
                        .error_message
                        .filter(|message| !message.trim().is_empty())
                        .unwrap_or_else(|| "The analysis failed on the server.".to_string()),
                ));
            }
            "cancelled" => {
                return PhaseOutcome::Failed(JobFailure::new(
                    ERROR_ANALYSIS,
                    "The analysis was cancelled on the server.",
                ));
            }
            _ => {
                let progress = snapshot
                    .artifacts
                    .and_then(|artifacts| artifacts.clean_cut_progress)
                    .map(|progress| progress.windows);
                if progress.is_some() && progress != record.windows {
                    record.windows = progress;
                    record.store(persisted);
                    set_job_state(
                        ctx.state,
                        persisted,
                        CleanCutJobState::Analyzing,
                        Some("analyze"),
                        analysis_progress(record.windows.as_ref()),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(id: &str, start_ms: u64, end_ms: u64) -> Segment {
        Segment {
            id: id.to_string(),
            start_ms,
            end_ms,
            text: format!("text of {id}"),
        }
    }

    #[test]
    fn input_json_follows_the_contract_and_the_request_id_hashes_it() {
        let segments = vec![segment("s1", 0, 4_200), segment("s2", 4_300, 9_000)];
        let clean = build_input_json(CleanCutMode::Clean, 9_500, Some("en"), &segments, None, &[]);
        assert_eq!(clean["mode"], json!("clean"));
        assert_eq!(clean["durationMs"], json!(9_500));
        assert_eq!(clean["language"], json!("en"));
        assert_eq!(clean["segments"][1]["id"], json!("s2"));
        assert_eq!(clean["segments"][1]["startMs"], json!(4_300));
        assert_eq!(clean["segments"][1]["text"], json!("text of s2"));
        assert!(clean.get("targetDurationSeconds").is_none());
        assert!(clean.get("mustKeep").is_none());

        let must_keep = vec![MustKeep {
            from_id: "s2".into(),
            to_id: "s2".into(),
            reason: "clip-mark".into(),
        }];
        let condensed = build_input_json(
            CleanCutMode::Condensed,
            9_500,
            None,
            &segments,
            Some(60),
            &must_keep,
        );
        assert_eq!(condensed["language"], Value::Null);
        assert_eq!(
            condensed["targetDurationSeconds"],
            json!(120),
            "clamped to the minimum"
        );
        assert_eq!(condensed["mustKeep"][0]["fromId"], json!("s2"));
        assert_eq!(condensed["mustKeep"][0]["reason"], json!("clip-mark"));
        assert_eq!(clamp_target_seconds(None), 900);
        assert_eq!(clamp_target_seconds(Some(10_000)), 3_600);

        let id = client_request_id("session-1", CleanCutMode::Clean, &clean);
        assert!(id.starts_with("cleancut:session-1:clean:"), "{id}");
        assert_eq!(id.len(), "cleancut:session-1:clean:".len() + 16);
        assert_eq!(
            id,
            client_request_id("session-1", CleanCutMode::Clean, &clean)
        );
        assert_ne!(
            id,
            client_request_id("session-1", CleanCutMode::Clean, &condensed)
        );
        let body = build_job_body("session-1", &id, clean);
        assert_eq!(body["workflowKind"], json!(WORKFLOW_KIND));
        assert_eq!(body["consentToUploadAudio"], json!(true));
        assert_eq!(body["sessionClientId"], json!("session-1"));
        assert!(
            body["clientVersion"]
                .as_str()
                .unwrap()
                .starts_with("videorc-desktop/")
        );
    }

    #[test]
    fn moments_become_must_keep_ranges_by_overlapping_sentences() {
        let segments = vec![
            segment("s1", 0, 10_000),
            segment("s2", 10_000, 20_000),
            segment("s3", 20_000, 30_000),
        ];
        let moments = vec![
            ClipMoment {
                start_ms: 8_000,
                end_ms: 22_000,
                reason: "You said clip that".into(),
                excerpt: String::new(),
                source: Some(ClipMomentSource::Voice),
            },
            ClipMoment {
                start_ms: 25_000,
                end_ms: 26_000,
                reason: "Chat spiked".into(),
                excerpt: String::new(),
                source: Some(ClipMomentSource::Chat),
            },
            ClipMoment {
                start_ms: 40_000,
                end_ms: 50_000,
                reason: "after the end".into(),
                excerpt: String::new(),
                source: None,
            },
        ];
        let must_keep = must_keep_from_moments(&moments, &segments);
        assert_eq!(
            must_keep,
            vec![
                MustKeep {
                    from_id: "s1".into(),
                    to_id: "s3".into(),
                    reason: "clip-mark".into(),
                },
                MustKeep {
                    from_id: "s3".into(),
                    to_id: "s3".into(),
                    reason: "chat-peak".into(),
                },
            ]
        );
    }

    #[test]
    fn cloud_results_parse_leniently_and_records_round_trip() {
        let result = parse_cloud_result(&json!({
            "mode": "clean",
            "drops": [
                { "fromId": "s12", "toId": "s13", "kind": "retake", "confidence": 0.82, "reason": "Restarted." },
                { "fromId": "s20", "toId": "s20", "kind": "mumble", "confidence": 0.9 },
                { "kind": "retake" }
            ],
            "windows": { "total": 8, "completed": 8 },
            "surprise": true
        }));
        assert_eq!(result.drops.len(), 3);
        assert_eq!(
            result.drops[1].kind, "mumble",
            "unknown kinds are kept for the mapper to skip"
        );
        assert_eq!(
            result.drops[2].from_id, "",
            "a bare entry defaults instead of failing"
        );
        assert!(result.keeps.is_empty());
        assert_eq!(
            result.windows,
            Some(AiJobCleanCutWindows {
                total: 8,
                completed: 8
            })
        );
        assert_eq!(
            parse_cloud_result(&json!("garbage")),
            CloudResult::default()
        );

        let mut record = AnalysisRecord::new(Some(900));
        record.job_id = Some("job-1".into());
        record.status = "pending".into();
        let json = serde_json::to_string(&record).unwrap();
        assert!(
            !json.contains("result"),
            "absent fields are omitted, never null"
        );
        let back: AnalysisRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, record);
        assert!((analysis_progress(None) - 0.88).abs() < 1e-9);
        assert!(
            (analysis_progress(Some(&AiJobCleanCutWindows {
                total: 4,
                completed: 2
            })) - 0.93)
                .abs()
                < 1e-9
        );
    }
}
