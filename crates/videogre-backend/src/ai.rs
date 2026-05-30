use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use reqwest::multipart;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::fs;
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::protocol::{
    AiArtifact, AiArtifactKind, AiArtifactStatus, AiWorkflowResult, HealthLevel,
    RunAiWorkflowParams,
};
use crate::recording::emit_health_event;
use crate::state::AppState;
use crate::storage::default_artifacts_dir;

const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const OPENAI_AUDIO_UPLOAD_LIMIT_BYTES: u64 = 25 * 1024 * 1024;

pub async fn run_ai_workflow(
    state: AppState,
    params: RunAiWorkflowParams,
) -> Result<AiWorkflowResult> {
    let input_path = state
        .database
        .session_output_path(&params.session_id)?
        .map(PathBuf::from)
        .context("Session does not have a local recording output")?;

    let ffmpeg_path = params
        .ffmpeg_path
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ffmpeg".to_string());
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
        emit_ai_artifacts_changed(&state, &params.session_id)?;
        return Ok(AiWorkflowResult {
            session_id: params.session_id,
            audio_path: audio_path.display().to_string(),
            artifacts,
        });
    }

    let audio_size = fs::metadata(&audio_path)
        .await
        .with_context(|| format!("Could not inspect {}", audio_path.display()))?
        .len();
    if audio_size > OPENAI_AUDIO_UPLOAD_LIMIT_BYTES {
        artifacts.push(state.database.save_ai_artifact(
            &params.session_id,
            AiArtifactKind::Transcript,
            AiArtifactStatus::Failed,
            json!({
                "message": "Extracted audio is larger than the OpenAI transcription upload limit. Shorter recordings or chunked transcription are needed.",
                "limitBytes": OPENAI_AUDIO_UPLOAD_LIMIT_BYTES,
                "actualBytes": audio_size,
            }),
            None,
        )?);
        emit_health_event(
            &state,
            Some(&params.session_id),
            HealthLevel::Warn,
            "ai-audio-too-large",
            "Extracted audio is too large for a single cloud transcription upload.",
        )?;
        emit_ai_artifacts_changed(&state, &params.session_id)?;
        return Ok(AiWorkflowResult {
            session_id: params.session_id,
            audio_path: audio_path.display().to_string(),
            artifacts,
        });
    }

    let api_key = match std::env::var("OPENAI_API_KEY") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            artifacts.push(state.database.save_ai_artifact(
                &params.session_id,
                AiArtifactKind::Transcript,
                AiArtifactStatus::Failed,
                json!({
                    "message": "OPENAI_API_KEY is not configured, so cloud transcription could not run.",
                }),
                None,
            )?);
            emit_health_event(
                &state,
                Some(&params.session_id),
                HealthLevel::Warn,
                "openai-api-key-missing",
                "Set OPENAI_API_KEY before running cloud transcription.",
            )?;
            emit_ai_artifacts_changed(&state, &params.session_id)?;
            return Ok(AiWorkflowResult {
                session_id: params.session_id,
                audio_path: audio_path.display().to_string(),
                artifacts,
            });
        }
    };

    let client = reqwest::Client::new();
    let transcript = match transcribe_audio(&client, &api_key, &audio_path).await {
        Ok(transcript) => transcript,
        Err(error) => {
            artifacts.push(state.database.save_ai_artifact(
                &params.session_id,
                AiArtifactKind::Transcript,
                AiArtifactStatus::Failed,
                json!({
                    "message": format!("Cloud transcription failed: {error}"),
                    "provider": "openai",
                    "model": transcription_model(),
                }),
                None,
            )?);
            emit_health_event(
                &state,
                Some(&params.session_id),
                HealthLevel::Warn,
                "ai-transcription-failed",
                "Cloud transcription failed. The local recording and extracted audio are still available.",
            )?;
            emit_ai_artifacts_changed(&state, &params.session_id)?;
            return Ok(AiWorkflowResult {
                session_id: params.session_id,
                audio_path: audio_path.display().to_string(),
                artifacts,
            });
        }
    };
    artifacts.push(state.database.save_ai_artifact(
        &params.session_id,
        AiArtifactKind::Transcript,
        AiArtifactStatus::Ready,
        json!({
            "text": transcript,
            "provider": "openai",
            "model": transcription_model(),
        }),
        None,
    )?);

    let publish_pack = match summarize_and_chapter(&client, &api_key, &transcript).await {
        Ok(publish_pack) => publish_pack,
        Err(error) => {
            artifacts.push(state.database.save_ai_artifact(
                &params.session_id,
                AiArtifactKind::Summary,
                AiArtifactStatus::Failed,
                json!({
                    "message": format!("Summary and chapter generation failed: {error}"),
                    "provider": "openai",
                    "model": text_model(),
                }),
                None,
            )?);
            emit_health_event(
                &state,
                Some(&params.session_id),
                HealthLevel::Warn,
                "ai-publish-pack-failed",
                "Transcript was saved, but summary and chapter generation failed.",
            )?;
            emit_ai_artifacts_changed(&state, &params.session_id)?;
            return Ok(AiWorkflowResult {
                session_id: params.session_id,
                audio_path: audio_path.display().to_string(),
                artifacts,
            });
        }
    };
    artifacts.push(state.database.save_ai_artifact(
        &params.session_id,
        AiArtifactKind::Summary,
        AiArtifactStatus::Ready,
        json!({
            "text": publish_pack.summary,
            "provider": "openai",
            "model": text_model(),
        }),
        None,
    )?);
    artifacts.push(state.database.save_ai_artifact(
        &params.session_id,
        AiArtifactKind::Chapters,
        AiArtifactStatus::Ready,
        json!({
            "chapters": publish_pack.chapters,
            "provider": "openai",
            "model": text_model(),
        }),
        None,
    )?);

    emit_ai_artifacts_changed(&state, &params.session_id)?;

    Ok(AiWorkflowResult {
        session_id: params.session_id,
        audio_path: audio_path.display().to_string(),
        artifacts,
    })
}

pub fn list_ai_artifacts(state: &AppState, session_id: &str) -> Result<Vec<AiArtifact>> {
    state.database.list_ai_artifacts(session_id)
}

fn emit_ai_artifacts_changed(state: &AppState, session_id: &str) -> Result<()> {
    state.emit_event(
        "ai.artifacts.changed",
        state.database.list_ai_artifacts(session_id)?,
    );
    Ok(())
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

    let output = timeout(Duration::from_secs(20 * 60), command.output())
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

async fn transcribe_audio(
    client: &reqwest::Client,
    api_key: &str,
    audio_path: &Path,
) -> Result<String> {
    let audio = fs::read(audio_path)
        .await
        .with_context(|| format!("Could not read {}", audio_path.display()))?;
    let file_part = multipart::Part::bytes(audio)
        .file_name("videogre-audio.m4a")
        .mime_str("audio/mp4")?;
    let form = multipart::Form::new()
        .text("model", transcription_model())
        .text("response_format", "json")
        .part("file", file_part);

    let response = client
        .post(OPENAI_TRANSCRIPTIONS_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await?
        .error_for_status()?
        .json::<OpenAiTranscriptionResponse>()
        .await?;

    Ok(response.text)
}

async fn summarize_and_chapter(
    client: &reqwest::Client,
    api_key: &str,
    transcript: &str,
) -> Result<PublishPack> {
    let prompt = format!(
        "You are helping a creator publish a recorded gaming or coding tutorial session.\n\
         Return strict JSON with keys summary and chapters. chapters must be an array of objects \
         with timestamp and title. Use approximate timestamps if the transcript has no timings.\n\n\
         Transcript:\n{transcript}"
    );
    let response = client
        .post(OPENAI_RESPONSES_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "model": text_model(),
            "input": prompt,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let output_text = response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| response_output_text(&response))
        .unwrap_or_default();

    parse_publish_pack(&output_text)
}

fn parse_publish_pack(output_text: &str) -> Result<PublishPack> {
    if let Ok(pack) = serde_json::from_str::<PublishPack>(output_text) {
        return Ok(pack);
    }

    let Some(start) = output_text.find('{') else {
        bail!("AI response did not include JSON");
    };
    let Some(end) = output_text.rfind('}') else {
        bail!("AI response did not include complete JSON");
    };
    serde_json::from_str(&output_text[start..=end]).context("Could not parse AI publish pack JSON")
}

fn response_output_text(value: &Value) -> Option<String> {
    let mut chunks = Vec::new();
    for item in value.get("output")?.as_array()? {
        for content in item.get("content")?.as_array()? {
            if let Some(text) = content.get("text").and_then(Value::as_str) {
                chunks.push(text.to_string());
            }
        }
    }
    (!chunks.is_empty()).then(|| chunks.join("\n"))
}

fn transcription_model() -> String {
    std::env::var("VIDEOGRE_OPENAI_TRANSCRIPTION_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-4o-mini-transcribe".to_string())
}

fn text_model() -> String {
    std::env::var("VIDEOGRE_OPENAI_TEXT_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-5-mini".to_string())
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishPack {
    summary: String,
    chapters: Vec<Chapter>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Chapter {
    timestamp: String,
    title: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_from_model_output() {
        let pack = parse_publish_pack(
            r#"```json
{"summary":"A short session.","chapters":[{"timestamp":"00:00","title":"Intro"}]}
```"#,
        )
        .unwrap();

        assert_eq!(pack.summary, "A short session.");
        assert_eq!(pack.chapters[0].title, "Intro");
    }
}
