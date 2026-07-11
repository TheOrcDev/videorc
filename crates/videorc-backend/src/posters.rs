//! Recording posters (Library rewrite L2): one thumbnail frame per session,
//! extracted at finalize and lazily backfilled on demand for older
//! recordings. Posters live under the backend's own data dir
//! (`<db parent>/posters/<session id>.jpg`) and are served over the existing
//! token-authenticated HTTP server — the renderer never touches raw paths.

use std::path::PathBuf;

use crate::process_job::status_owned_tokio;
use crate::state::AppState;

const POSTER_WIDTH: u32 = 320;
/// Seek to ~10% in (clamped) so the poster shows content, not a black lead-in.
const POSTER_MIN_SEEK_SECONDS: f64 = 1.0;
const POSTER_MAX_SEEK_SECONDS: f64 = 30.0;

pub fn posters_directory() -> PathBuf {
    crate::storage::default_database_path()
        .parent()
        .map(|parent| parent.join("posters"))
        .unwrap_or_else(|| PathBuf::from("posters"))
}

pub fn poster_path(session_id: &str) -> PathBuf {
    // Session ids are UUIDs we mint; sanitize anyway so a hostile id can
    // never escape the posters directory.
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    posters_directory().join(format!("{safe}.jpg"))
}

pub fn poster_seek_seconds(duration_ms: Option<i64>) -> f64 {
    let duration_seconds = duration_ms.unwrap_or(0).max(0) as f64 / 1000.0;
    (duration_seconds * 0.1).clamp(POSTER_MIN_SEEK_SECONDS, POSTER_MAX_SEEK_SECONDS)
}

/// ffmpeg argv for the extraction (pure, tested).
pub fn poster_extract_args(input: &str, output: &str, duration_ms: Option<i64>) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-ss".to_string(),
        format!("{:.2}", poster_seek_seconds(duration_ms)),
        "-i".to_string(),
        input.to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale={POSTER_WIDTH}:-2"),
        "-q:v".to_string(),
        "4".to_string(),
        output.to_string(),
    ]
}

/// Make sure a poster exists for the session; returns true when one is
/// available afterwards. Extraction holds the ffmpeg maintenance permit so it
/// never competes with a live capture (idle-perf law); a single frame decode
/// is subsecond work.
pub async fn ensure_session_poster(
    state: &AppState,
    session_id: &str,
    recording_path: &str,
    duration_ms: Option<i64>,
    ffmpeg_path: &str,
) -> bool {
    let output = poster_path(session_id);
    if output.exists() {
        return true;
    }
    if !std::path::Path::new(recording_path).exists() {
        return false;
    }
    if let Some(parent) = output.parent()
        && tokio::fs::create_dir_all(parent).await.is_err()
    {
        return false;
    }
    let _maintenance = state
        .ffmpeg_work
        .begin_priority_maintenance_when_idle()
        .await;
    // Another request may have generated this poster while we waited.
    if output.exists() {
        return true;
    }
    let mut command = tokio::process::Command::new(ffmpeg_path);
    command
        .args(poster_extract_args(
            recording_path,
            &output.to_string_lossy(),
            duration_ms,
        ))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let status = status_owned_tokio(&mut command).await;
    let ok = matches!(status, Ok(status) if status.success()) && output.exists();
    if !ok {
        // Never leave a truncated poster behind to be served.
        let _ = tokio::fs::remove_file(&output).await;
    }
    ok
}

/// Delete a session's poster (session deletion, L3).
pub async fn remove_session_poster(session_id: &str) {
    let _ = tokio::fs::remove_file(poster_path(session_id)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seek_clamps_to_a_sane_window() {
        assert_eq!(poster_seek_seconds(None), 1.0);
        assert_eq!(poster_seek_seconds(Some(0)), 1.0);
        // 10% of a 2-minute recording = 12s.
        assert_eq!(poster_seek_seconds(Some(120_000)), 12.0);
        // Long recordings clamp to 30s so extraction stays fast.
        assert_eq!(poster_seek_seconds(Some(3_600_000)), 30.0);
    }

    #[test]
    fn extract_args_shape_the_ffmpeg_call() {
        let args = poster_extract_args("/tmp/in.mp4", "/tmp/out.jpg", Some(120_000));
        assert_eq!(args[0], "-y");
        assert_eq!(args[1], "-ss");
        assert_eq!(args[2], "12.00");
        assert!(args.contains(&"-frames:v".to_string()));
        assert!(args.contains(&"scale=320:-2".to_string()));
        assert_eq!(args.last().unwrap(), "/tmp/out.jpg");
    }

    #[test]
    fn poster_paths_are_traversal_safe() {
        let path = poster_path("../../etc/passwd");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "etcpasswd.jpg");
        assert!(poster_path("ab12-cd34").ends_with("posters/ab12-cd34.jpg"));
    }
}
