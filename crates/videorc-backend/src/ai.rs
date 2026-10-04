use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::process_job::output_owned_tokio;
use crate::protocol::AiCapabilities;

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
