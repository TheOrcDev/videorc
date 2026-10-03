//! Clip suggestions and local clip export for the Publish tab.
//!
//! The ranking itself lives in `moments.rs` (plan 119 S1): clip marks the
//! streamer placed by saying "clip that" or pressing Mark clip (plan 068 D6),
//! then live-chat activity spikes aligned to the live-captions transcript. This
//! module only wraps it in the Publish RPC shapes and exports a suggestion as
//! a real file via a local ffmpeg trim.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::ffmpeg::resolve_ffmpeg_path;
use crate::moments::session_moments;
use crate::process_job::output_owned_tokio;
use crate::protocol::{ClipExportParams, ClipExportResult, ClipSuggestParams, ClipSuggestResult};
use crate::state::AppState;

const CLIP_EXPORT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub async fn suggest_clips(
    state: AppState,
    params: ClipSuggestParams,
) -> Result<ClipSuggestResult> {
    let found = session_moments(&state, &params.session_id)
        .await?
        .context("Session not found")?;
    Ok(ClipSuggestResult {
        session_id: params.session_id,
        moments: found.moments,
        chat_message_count: found.chat_message_count,
    })
}

pub async fn export_clip(state: AppState, params: ClipExportParams) -> Result<ClipExportResult> {
    if params.end_ms <= params.start_ms {
        bail!("Clip end must be after clip start.");
    }
    let candidates = state
        .database
        .session_media_candidates(&params.session_id)?;
    let input_path = candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .context(
            "The recording file for this session is missing on disk. Clips need the original recording.",
        )?;

    let output_path = clip_output_path(&input_path, params.start_ms, params.end_ms);
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());

    // Stream copy first (instant, lossless). Keyframe alignment can make copy
    // fail or produce empty output on some recordings — fall back to a
    // re-encode rather than silently shipping a broken file.
    let copy_args = clip_ffmpeg_args(
        &input_path,
        params.start_ms,
        params.end_ms,
        &output_path,
        false,
    );
    let copy_ok = run_clip_ffmpeg(&ffmpeg_path, &copy_args).await.is_ok()
        && clip_file_looks_valid(&output_path).await;
    if !copy_ok {
        let reencode_args = clip_ffmpeg_args(
            &input_path,
            params.start_ms,
            params.end_ms,
            &output_path,
            true,
        );
        run_clip_ffmpeg(&ffmpeg_path, &reencode_args).await?;
        if !clip_file_looks_valid(&output_path).await {
            bail!("Clip export produced no playable output.");
        }
    }

    Ok(ClipExportResult {
        session_id: params.session_id,
        path: output_path.display().to_string(),
    })
}

fn clip_output_path(input_path: &Path, start_ms: u64, end_ms: u64) -> PathBuf {
    let stem = input_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "recording".to_string());
    let name = format!(
        "{stem}-clip-{}-{}.mp4",
        clock_component(start_ms),
        clock_component(end_ms)
    );
    input_path.with_file_name(name)
}

fn clock_component(ms: u64) -> String {
    let total_seconds = ms / 1000;
    format!("{:02}m{:02}s", total_seconds / 60, total_seconds % 60)
}

pub fn clip_ffmpeg_args(
    input_path: &Path,
    start_ms: u64,
    end_ms: u64,
    output_path: &Path,
    reencode: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-ss".to_string(),
        format_ffmpeg_seconds(start_ms),
        "-to".to_string(),
        format_ffmpeg_seconds(end_ms),
        "-i".to_string(),
        input_path.display().to_string(),
    ];
    if reencode {
        // The bundled ffmpeg is LGPL-only (no libx264) — use the platform
        // hardware encoder, matching the capability-probed repair encoder.
        #[cfg(target_os = "macos")]
        args.extend([
            "-c:v".to_string(),
            "h264_videotoolbox".to_string(),
            "-b:v".to_string(),
            "8000k".to_string(),
        ]);
        #[cfg(target_os = "windows")]
        args.extend(["-c:v".to_string(), "h264_mf".to_string()]);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        args.extend(["-c:v".to_string(), "mpeg4".to_string()]);
        args.extend(["-c:a".to_string(), "aac".to_string()]);
    } else {
        args.extend(["-c".to_string(), "copy".to_string()]);
    }
    args.push(output_path.display().to_string());
    args
}

fn format_ffmpeg_seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

async fn run_clip_ffmpeg(ffmpeg_path: &str, args: &[String]) -> Result<()> {
    let mut command = Command::new(ffmpeg_path);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = timeout(CLIP_EXPORT_TIMEOUT, output_owned_tokio(&mut command))
        .await
        .context("Clip export timed out")?
        .with_context(|| format!("Could not start {ffmpeg_path} for clip export"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "Clip export failed with {}{}",
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

async fn clip_file_looks_valid(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.len() > 4096)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_args_stream_copy_then_reencode_fallback() {
        let copy = clip_ffmpeg_args(
            Path::new("/tmp/session.mp4"),
            12_500,
            57_250,
            Path::new("/tmp/session-clip-00m12s-00m57s.mp4"),
            false,
        );
        assert!(copy.windows(2).any(|pair| pair == ["-ss", "12.500"]));
        assert!(copy.windows(2).any(|pair| pair == ["-to", "57.250"]));
        assert!(copy.windows(2).any(|pair| pair == ["-c", "copy"]));

        let reencode = clip_ffmpeg_args(
            Path::new("/tmp/session.mp4"),
            0,
            5_000,
            Path::new("/tmp/out.mp4"),
            true,
        );
        assert!(!reencode.windows(2).any(|pair| pair == ["-c", "copy"]));
        assert!(reencode.iter().any(|arg| arg == "-c:v"));
    }

    #[test]
    fn clip_output_name_is_readable_and_next_to_the_recording() {
        let path = clip_output_path(Path::new("/videos/My Session.mp4"), 75_000, 130_000);
        assert_eq!(
            path,
            PathBuf::from("/videos/My Session-clip-01m15s-02m10s.mp4")
        );
    }
}
