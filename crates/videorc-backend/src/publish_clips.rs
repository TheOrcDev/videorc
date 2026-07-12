//! Clip suggestions and local clip export for the Publish tab.
//!
//! Moments are ranked LOCALLY from data the app already has — live-chat
//! activity spikes aligned to the live-captions transcript — so a session
//! with chat gets clip-worthy time ranges without any cloud call, and every
//! suggestion exports as a real file via a local ffmpeg trim.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use chrono::DateTime;
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::ai::{CaptionCue, parse_srt};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::process_job::output_owned_tokio;
use crate::protocol::{
    ClipExportParams, ClipExportResult, ClipMoment, ClipSuggestParams, ClipSuggestResult,
};
use crate::state::AppState;

const CHAT_BUCKET_MS: u64 = 30_000;
const CLIP_LEAD_IN_MS: u64 = 10_000;
const CLIP_DEFAULT_LENGTH_MS: u64 = 45_000;
const CLIP_MIN_LENGTH_MS: u64 = 5_000;
const CLIP_MAX_LENGTH_MS: u64 = 90_000;
const MAX_SUGGESTED_CLIPS: usize = 3;
const CLIP_EXPORT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub async fn suggest_clips(
    state: AppState,
    params: ClipSuggestParams,
) -> Result<ClipSuggestResult> {
    let session = state
        .database
        .list_sessions(500)?
        .into_iter()
        .find(|session| session.id == params.session_id)
        .context("Session not found")?;
    let session_started_ms = DateTime::parse_from_rfc3339(&session.started_at)
        .context("Session start time is not a valid timestamp")?
        .timestamp_millis();
    let duration_ms = session
        .duration_ms
        .and_then(|value| u64::try_from(value).ok());

    let messages = state
        .database
        .list_live_chat_messages_recent(&params.session_id, 5_000)?;
    let message_offsets_ms: Vec<u64> = messages
        .iter()
        .filter_map(|message| DateTime::parse_from_rfc3339(&message.received_at).ok())
        .filter_map(|received| u64::try_from(received.timestamp_millis() - session_started_ms).ok())
        .filter(|offset| duration_ms.is_none_or(|duration| *offset <= duration + 60_000))
        .collect();

    let cues = captions_cues_for_session(&state, &params.session_id).await;
    let moments = rank_chat_spike_moments(&message_offsets_ms, &cues, duration_ms);

    Ok(ClipSuggestResult {
        session_id: params.session_id,
        moments,
        chat_message_count: message_offsets_ms.len() as u64,
    })
}

async fn captions_cues_for_session(state: &AppState, session_id: &str) -> Vec<CaptionCue> {
    let Ok(candidates) = state.database.session_media_candidates(session_id) else {
        return Vec::new();
    };
    for candidate in candidates {
        let srt_path = PathBuf::from(&candidate).with_extension("srt");
        if let Ok(content) = tokio::fs::read_to_string(&srt_path).await {
            let cues = parse_srt(&content);
            if !cues.is_empty() {
                return cues;
            }
        }
    }
    Vec::new()
}

/// Rank chat-activity spikes into clip moments. Pure so the whole ranking is
/// unit-testable: bucket message offsets, find buckets that stand out from
/// the session's own baseline, merge adjacent spikes, snap to caption cues.
pub fn rank_chat_spike_moments(
    message_offsets_ms: &[u64],
    cues: &[CaptionCue],
    duration_ms: Option<u64>,
) -> Vec<ClipMoment> {
    if message_offsets_ms.is_empty() {
        return Vec::new();
    }
    let max_offset = message_offsets_ms.iter().copied().max().unwrap_or(0);
    let bucket_count = (max_offset / CHAT_BUCKET_MS + 1) as usize;
    let mut buckets = vec![0u32; bucket_count];
    for offset in message_offsets_ms {
        buckets[(offset / CHAT_BUCKET_MS) as usize] += 1;
    }

    let total: u32 = buckets.iter().sum();
    let mean = f64::from(total) / buckets.len() as f64;
    let variance = buckets
        .iter()
        .map(|count| (f64::from(*count) - mean).powi(2))
        .sum::<f64>()
        / buckets.len() as f64;
    let std_dev = variance.sqrt();
    // A spike must stand out from the session's own baseline AND be absolutely
    // busy enough to mean something (3+ messages in 30s).
    let threshold = (mean + 1.5 * std_dev).max(3.0);

    let mut spikes: Vec<(usize, u32)> = buckets
        .iter()
        .enumerate()
        .filter(|(_, count)| f64::from(**count) >= threshold)
        .map(|(index, count)| (index, *count))
        .collect();
    spikes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));

    let mut chosen: Vec<(usize, u32)> = Vec::new();
    for (index, count) in spikes {
        if chosen.len() >= MAX_SUGGESTED_CLIPS {
            break;
        }
        // Adjacent buckets are the same moment — keep the strongest.
        if chosen
            .iter()
            .any(|(existing, _)| existing.abs_diff(index) <= 1)
        {
            continue;
        }
        chosen.push((index, count));
    }
    chosen.sort_by_key(|(index, _)| *index);

    chosen
        .into_iter()
        .map(|(index, count)| {
            let bucket_start = index as u64 * CHAT_BUCKET_MS;
            let mut start_ms = bucket_start.saturating_sub(CLIP_LEAD_IN_MS);
            let mut end_ms = start_ms + CLIP_DEFAULT_LENGTH_MS;
            if let Some(duration) = duration_ms {
                end_ms = end_ms.min(duration);
                start_ms = start_ms.min(end_ms.saturating_sub(CLIP_MIN_LENGTH_MS));
            }
            // Snap to caption cue boundaries so a clip never opens or cuts
            // mid-sentence.
            if let Some(cue) = cues
                .iter()
                .find(|cue| cue.start_ms <= start_ms && start_ms < cue.end_ms)
            {
                start_ms = cue.start_ms;
            }
            if let Some(cue) = cues
                .iter()
                .find(|cue| cue.start_ms <= end_ms && end_ms < cue.end_ms)
            {
                end_ms = cue.end_ms;
            }
            end_ms = end_ms.min(start_ms + CLIP_MAX_LENGTH_MS);
            let excerpt = cues
                .iter()
                .filter(|cue| cue.end_ms > start_ms && cue.start_ms < end_ms)
                .map(|cue| cue.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(200)
                .collect::<String>();
            ClipMoment {
                start_ms,
                end_ms,
                reason: format!("Chat spiked — {count} messages in 30s"),
                excerpt,
            }
        })
        .filter(|moment| moment.end_ms > moment.start_ms + CLIP_MIN_LENGTH_MS)
        .collect()
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
            "The recording file for this session is missing on disk — clips need the original recording.",
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

    fn cue(start_ms: u64, end_ms: u64, text: &str) -> CaptionCue {
        CaptionCue {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn quiet_sessions_produce_no_suggestions() {
        // Uniform low chatter never crosses the absolute 3-messages floor.
        let offsets: Vec<u64> = (0..10).map(|index| index * 60_000).collect();
        assert!(rank_chat_spike_moments(&offsets, &[], Some(600_000)).is_empty());
        assert!(rank_chat_spike_moments(&[], &[], None).is_empty());
    }

    #[test]
    fn a_chat_spike_becomes_one_cue_snapped_moment() {
        // Baseline: one message a minute. Spike: 8 messages around 5:10.
        let mut offsets: Vec<u64> = (0..10).map(|index| index * 60_000).collect();
        offsets.extend((0..8).map(|index| 310_000 + index * 1_000));
        let cues = [
            cue(280_000, 292_000, "so I tried the risky refactor"),
            cue(292_000, 305_000, "and it actually works first try"),
            cue(305_000, 330_000, "chat is going wild right now"),
        ];

        let moments = rank_chat_spike_moments(&offsets, &cues, Some(900_000));

        assert_eq!(moments.len(), 1);
        let moment = &moments[0];
        // The 10s lead-in (290s) lands inside the first cue → the clip opens
        // at that cue's start so it never begins mid-sentence.
        assert_eq!(moment.start_ms, 280_000);
        assert!(moment.end_ms > moment.start_ms + CLIP_MIN_LENGTH_MS);
        // 8 spike messages + the baseline message sharing the bucket.
        assert!(moment.reason.contains("9 messages"));
        assert!(moment.excerpt.contains("actually works"));
    }

    #[test]
    fn adjacent_spike_buckets_merge_into_the_strongest_moment() {
        let mut offsets = Vec::new();
        // Two adjacent hot buckets at 10:00-10:30 (6 msgs) and 10:30-11:00 (9 msgs).
        offsets.extend((0..6).map(|index| 600_000 + index * 4_000));
        offsets.extend((0..9).map(|index| 630_000 + index * 3_000));
        // Baseline noise so the mean is low.
        offsets.extend((0..20).map(|index| index * 45_000));

        let moments = rank_chat_spike_moments(&offsets, &[], Some(1_500_000));

        assert_eq!(moments.len(), 1);
        // 9 spike messages + the baseline message sharing the stronger bucket.
        assert!(moments[0].reason.contains("10 messages"));
    }

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
