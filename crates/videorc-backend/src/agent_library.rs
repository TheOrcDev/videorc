//! The Library for agents, backend half (plan 209 S15): `rename_recording`,
//! `start_clean_cut`, and what `get_recording` adds for them: each Clean cut's
//! progress and, when asked, the transcript.
//!
//! Every answer is allowlisted (D9). The paths that cross are the user's own
//! recordings; a Clean cut's working files (its transcript and cut list live
//! in app data) never do: the transcript crosses as text.

use serde_json::{Map, Value, json};

use crate::agent_call::ToolOutcome;
use crate::agent_look::RECORDING_MISSING;
use crate::agent_registry::AgentIdentity;
use crate::protocol::{CleanCutMode, CleanCutStartParams};
use crate::state::AppState;

/// Library titles, as the Library's own rename allows them.
pub const TITLE_MAX_CHARS: usize = 120;
/// A transcript crosses as text, up to this many characters (a long stream's
/// words); the answer says when it was cut.
pub const TRANSCRIPT_MAX_CHARS: usize = 120_000;

/// The Clean cut card's own sentences (`clean-cut-view.ts`): an agent hears
/// what the button says.
pub const CLEAN_CUT_SIGNED_OUT: &str = "Sign in to use Clean cut, part of Videorc Premium.";
pub const CLEAN_CUT_CONSENT_OFF: &str = "Cloud AI isn't allowed, so Clean cut can't run. Allow it once in Videorc's Library → Clean cut.";

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

// ---------------------------------------------------------------------------
// rename_recording
// ---------------------------------------------------------------------------

pub async fn rename_recording(
    state: &AppState,
    _agent: &AgentIdentity,
    args: Value,
) -> ToolOutcome {
    let Some(id) = text_of(&args, "recordingId") else {
        return ToolOutcome::refused("Say which recording: recordingId from list_recordings.");
    };
    let title = text_of(&args, "title").unwrap_or_default().to_string();
    if title.is_empty() || title.chars().count() > TITLE_MAX_CHARS {
        return ToolOutcome::refused("Titles must be 1-120 characters.");
    }
    match state.database.rename_session(id, &title) {
        Ok(true) => ToolOutcome::ok(
            format!("Renamed to \"{title}\"."),
            Some(json!({ "recordingId": id, "title": title })),
        ),
        Ok(false) => ToolOutcome::refused(RECORDING_MISSING),
        Err(error) => ToolOutcome::failed(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// start_clean_cut
// ---------------------------------------------------------------------------

/// The Studio's Cloud AI consent, as its agent projection says (the backend
/// never holds the renderer-local consent itself).
fn cloud_ai_consented(state: &AppState) -> bool {
    state.agents.studio_open()
        && state
            .agents
            .lock()
            .surface
            .as_ref()
            .and_then(|surface| surface.get("cloudAiConsent"))
            .and_then(Value::as_bool)
            == Some(true)
}

/// The account gates first, in the button's order and words: signed in, then
/// Premium (the Cloud AI capability's own reason), then the consent.
pub fn clean_cut_gate(
    signed_in: bool,
    premium: Result<(), String>,
    consented: bool,
) -> Result<(), String> {
    if !signed_in {
        return Err(CLEAN_CUT_SIGNED_OUT.to_string());
    }
    premium?;
    if !consented {
        return Err(CLEAN_CUT_CONSENT_OFF.to_string());
    }
    Ok(())
}

pub async fn start_clean_cut(state: &AppState, _agent: &AgentIdentity, args: Value) -> ToolOutcome {
    let Some(id) = text_of(&args, "recordingId") else {
        return ToolOutcome::refused("Say which recording: recordingId from list_recordings.");
    };
    let mode = match text_of(&args, "mode") {
        Some("condensed") => CleanCutMode::Condensed,
        _ => CleanCutMode::Clean,
    };
    let signed_in =
        crate::account::stored_session_token().is_some_and(|token| !token.trim().is_empty());
    let premium = crate::entitlements::require_feature(
        &crate::entitlements::current_entitlements(),
        crate::protocol::FeatureId::CloudAi,
    )
    .map_err(|error| error.to_string());
    if let Err(sentence) = clean_cut_gate(signed_in, premium, cloud_ai_consented(state)) {
        return ToolOutcome::refused(sentence);
    }
    let target_duration_seconds = (mode == CleanCutMode::Condensed)
        .then(|| args.get("targetMinutes").and_then(Value::as_u64))
        .flatten()
        .map(|minutes| (minutes.clamp(2, 60) * 60) as u32);
    let params = CleanCutStartParams {
        session_id: id.to_string(),
        mode,
        // Checked above: the streamer allowed Cloud AI in the Studio.
        consent_to_upload_audio: true,
        target_duration_seconds,
    };
    match crate::clean_cut::start(state.clone(), params).await {
        Ok(job) => ToolOutcome::ok(
            "Clean cut started. get_recording shows its progress.",
            Some(clean_cut_projection(&job)),
        ),
        Err(refusal) => ToolOutcome::refused(refusal.message),
    }
}

/// One Clean cut job, allowlisted: never its working files.
pub fn clean_cut_projection(job: &crate::protocol::CleanCutJob) -> Value {
    let mut out = Map::new();
    out.insert("jobId".into(), json!(job.id));
    out.insert("recordingId".into(), json!(job.source_session_id));
    out.insert(
        "mode".into(),
        serde_json::to_value(job.mode).unwrap_or(Value::Null),
    );
    out.insert(
        "state".into(),
        serde_json::to_value(job.state).unwrap_or(Value::Null),
    );
    out.insert("progress".into(), json!(job.progress));
    if let Some(step) = job.step.as_deref() {
        out.insert("step".into(), json!(step));
    }
    if let Some(output) = job.output_session_id.as_deref() {
        out.insert("cutRecordingId".into(), json!(output));
    }
    if let Some(message) = job.error_message.as_deref() {
        out.insert("error".into(), json!(message));
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// get_recording's additions
// ---------------------------------------------------------------------------

/// The newest Clean cut of each mode for a take.
pub fn clean_cuts(state: &AppState, recording_id: &str) -> Vec<Value> {
    state
        .database
        .latest_clean_cut_jobs_for_source(recording_id)
        .unwrap_or_default()
        .iter()
        .map(|persisted| clean_cut_projection(&persisted.job))
        .collect()
}

/// A stitched transcript as sentences with times, capped.
pub fn transcript_projection(transcript: &crate::protocol::CleanCutTranscript) -> Value {
    let mut segments = Vec::new();
    let mut chars = 0usize;
    let mut truncated = false;
    let mut words = transcript.words.iter().peekable();
    for segment in &transcript.segments {
        let mut text = Vec::new();
        while let Some(word) = words.peek() {
            if word.start_ms >= segment.end_ms {
                break;
            }
            if word.start_ms >= segment.start_ms {
                text.push(word.text.trim());
            }
            words.next();
        }
        let line = text.join(" ");
        if line.is_empty() {
            continue;
        }
        chars += line.chars().count();
        if chars > TRANSCRIPT_MAX_CHARS {
            truncated = true;
            break;
        }
        segments.push(json!({
            "startSeconds": segment.start_ms as f64 / 1000.0,
            "endSeconds": segment.end_ms as f64 / 1000.0,
            "text": line,
        }));
    }
    let mut out = Map::new();
    if let Some(language) = transcript.language.as_deref() {
        out.insert("language".into(), json!(language));
    }
    out.insert("segments".into(), Value::Array(segments));
    if truncated {
        out.insert("truncated".into(), json!(true));
    }
    Value::Object(out)
}

/// The take's transcript when Clean cut has made one; None otherwise.
pub async fn transcript(state: &AppState, recording_id: &str) -> Option<Value> {
    let jobs = state
        .database
        .latest_clean_cut_jobs_for_source(recording_id)
        .ok()?;
    for persisted in jobs {
        let params = crate::protocol::CleanCutTranscriptParams {
            job_id: persisted.job.id.clone(),
        };
        if let Ok(transcript) = crate::clean_cut::transcript(state, params).await {
            return Some(transcript_projection(&transcript));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_mcp::test_support::{connect_agent, test_state};
    use crate::protocol::{CleanCutTranscript, CleanCutTranscriptSegment, CleanCutTranscriptWord};

    #[tokio::test]
    async fn rename_needs_a_title_and_a_take_that_exists() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Claude Code");
        let outcome = rename_recording(
            &state,
            &agent,
            json!({ "recordingId": "nope", "title": "MCP episode 1" }),
        )
        .await;
        assert_eq!(outcome, ToolOutcome::refused(RECORDING_MISSING));
        let outcome = rename_recording(
            &state,
            &agent,
            json!({ "recordingId": "nope", "title": "x".repeat(121) }),
        )
        .await;
        assert_eq!(
            outcome,
            ToolOutcome::refused("Titles must be 1-120 characters.")
        );
    }

    #[test]
    fn clean_cut_refuses_in_the_buttons_order_and_words() {
        assert_eq!(
            clean_cut_gate(
                false,
                Err("Cloud AI is a Videorc Premium feature.".into()),
                false
            ),
            Err(CLEAN_CUT_SIGNED_OUT.to_string())
        );
        assert_eq!(
            clean_cut_gate(
                true,
                Err("Cloud AI is a Videorc Premium feature.".into()),
                false
            ),
            Err("Cloud AI is a Videorc Premium feature.".to_string())
        );
        assert_eq!(
            clean_cut_gate(true, Ok(()), false),
            Err(CLEAN_CUT_CONSENT_OFF.to_string())
        );
        assert_eq!(clean_cut_gate(true, Ok(()), true), Ok(()));
    }

    #[tokio::test]
    async fn clean_cut_without_a_studio_never_assumes_consent() {
        let state = test_state();
        assert!(!cloud_ai_consented(&state));
        // A published surface counts only while a Studio is attached.
        state.agents.lock().surface = Some(json!({ "cloudAiConsent": true }));
        assert!(!cloud_ai_consented(&state));
        state
            .agents
            .studio_sockets
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        assert!(cloud_ai_consented(&state));
    }

    #[test]
    fn a_transcript_crosses_as_timed_sentences_without_paths() {
        let word = |text: &str, start: u64, end: u64| CleanCutTranscriptWord {
            text: text.to_string(),
            start_ms: start,
            end_ms: end,
            filler: false,
        };
        let transcript = CleanCutTranscript {
            job_id: "job-1".to_string(),
            language: Some("en".to_string()),
            words: vec![
                word("Hello", 0, 400),
                word("chat.", 400, 900),
                word("Today", 1500, 1900),
                word("MCP.", 1900, 2400),
            ],
            segments: vec![
                CleanCutTranscriptSegment {
                    id: "s1".to_string(),
                    start_ms: 0,
                    end_ms: 900,
                },
                CleanCutTranscriptSegment {
                    id: "s2".to_string(),
                    start_ms: 1500,
                    end_ms: 2400,
                },
            ],
        };
        assert_eq!(
            transcript_projection(&transcript),
            json!({
                "language": "en",
                "segments": [
                    { "startSeconds": 0.0, "endSeconds": 0.9, "text": "Hello chat." },
                    { "startSeconds": 1.5, "endSeconds": 2.4, "text": "Today MCP." }
                ]
            })
        );
    }
}
