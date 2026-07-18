//! Library session operations (Library rewrite L3): Duplicate and Import.
//! Both do their file work off the async runtime (spawn_blocking copies) and
//! finish by writing truthful rows — sizes statted from the real files,
//! durations probed, posters extracted.

use anyhow::{Context, Result, bail};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::ffi::CString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Output as ProcessOutput;

use crate::process_job::output_owned_tokio;
use crate::state::AppState;
use crate::storage::{SessionFileBoundIdentity, SessionFileOperation};

const IMPORTABLE_EXTENSIONS: [&str; 5] = ["mp4", "mov", "m4v", "mkv", "webm"];

/// `Recording.mp4` → `Recording (copy).mp4`, `Recording (copy 2).mp4`, … the
/// first name that does not exist yet (pure candidate builder, tested).
pub fn duplicate_candidate_path(source: &Path, attempt: u32) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Recording");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let suffix = if attempt == 0 {
        " (copy)".to_string()
    } else {
        format!(" (copy {})", attempt + 1)
    };
    source.with_file_name(format!("{stem}{suffix}{extension}"))
}

fn first_free_duplicate_path(source: &Path) -> Result<PathBuf> {
    for attempt in 0..10_000 {
        let candidate = duplicate_candidate_path(source, attempt);
        if !candidate
            .try_exists()
            .with_context(|| format!("Could not inspect duplicate path {}", candidate.display()))?
        {
            return Ok(candidate);
        }
    }
    bail!("Could not find a free destination after 10,000 duplicate names.")
}

pub fn import_extension_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|ext| IMPORTABLE_EXTENSIONS.contains(&ext.as_str()))
}

/// Where an import lands. A BLANK setting means the platform default — the
/// same contract recording uses (Settings says "Blank uses the default") — so
/// import creates and uses it instead of demanding explicit configuration.
/// An explicitly configured directory must already exist: a typo should
/// surface here, not silently divert imports somewhere else.
fn resolve_import_output_dir(output_directory: &str, default_dir: PathBuf) -> Result<PathBuf> {
    let trimmed = output_directory.trim();
    if trimmed.is_empty() {
        std::fs::create_dir_all(&default_dir).with_context(|| {
            format!(
                "Could not create the default recordings directory {}.",
                default_dir.display()
            )
        })?;
        return Ok(default_dir);
    }
    // Same contract as recording: `~` expands, relative paths are refused
    // (they would resolve against the backend cwd — inside the app bundle).
    let dir = crate::recording::expand_user_path(trimmed);
    if !dir.is_absolute() || !dir.is_dir() {
        bail!(
            "The output directory in Settings does not exist. Fix it there, or clear it to use the default."
        );
    }
    Ok(dir)
}

/// Copy-safe destination inside the output directory for an import (pure
/// candidate builder; uniqueness handled like Duplicate).
fn import_destination(output_directory: &Path, source: &Path) -> Result<PathBuf> {
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported recording.mp4");
    let base = output_directory.join(name);
    if !base
        .try_exists()
        .with_context(|| format!("Could not inspect import path {}", base.display()))?
    {
        return Ok(base);
    }
    first_free_duplicate_path(&base)
}

fn staging_path_for(destination: &Path, session_id: &str) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    destination.with_file_name(format!(".{name}.{session_id}.videorc-partial"))
}

async fn copy_and_publish_session_file(
    state: &AppState,
    operation: &SessionFileOperation,
    source: &Path,
) -> Result<u64> {
    let source = source.to_path_buf();
    let staging = PathBuf::from(&operation.staging_path);
    let destination = PathBuf::from(&operation.final_path);
    let copy_source = source.clone();
    let copy_staging = staging.clone();
    let database = state.database.clone();
    let operation_id = operation.id.clone();
    let copied = tokio::task::spawn_blocking(move || -> Result<(u64, SessionFileBoundIdentity)> {
        let mut source_file = std::fs::File::open(&copy_source)
            .with_context(|| format!("Could not open {}", copy_source.display()))?;
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut staging_file = options
            .open(&copy_staging)
            .with_context(|| format!("Could not create {}", copy_staging.display()))?;
        staging_file.sync_all()?;
        sync_session_file_parent(&copy_staging)?;
        let object_identity = crate::storage::capture_session_file_object_identity_from_file(
            &staging_file,
            &copy_staging,
        )?;
        database
            .bind_session_file_operation_object_identity(&operation_id, &object_identity)
            .context("Could not bind the managed copy to its open staging file")?;
        let bytes = std::io::copy(&mut source_file, &mut staging_file)?;
        staging_file.sync_all()?;
        let content_identity = crate::storage::capture_session_file_content_identity_from_file(
            &mut staging_file,
            &copy_staging,
        )?;
        database
            .bind_session_file_operation_content_identity(&operation_id, &content_identity)
            .context("Could not bind the managed copy to its staged bytes")?;
        Ok((
            bytes,
            SessionFileBoundIdentity {
                content_identity,
                object_identity,
            },
        ))
    })
    .await
    .context("Copy task failed.")?;

    let copied = match copied {
        Ok(copied) => copied,
        Err(error) => {
            let cleanup = state
                .database
                .cancel_session_file_operation(operation)
                .err()
                .map(|cleanup_error| format!(" Cleanup also failed: {cleanup_error:#}."))
                .unwrap_or_default();
            return Err(anyhow::anyhow!(
                "Could not stage the managed copy: {error}.{cleanup}"
            ));
        }
    };

    let (copied, expected_ownership) = copied;

    let publish_staging = staging.clone();
    let publish_destination = destination.clone();
    let published = tokio::task::spawn_blocking(move || {
        publish_identity_bound_session_file(
            &publish_staging,
            &publish_destination,
            &expected_ownership,
        )
    })
    .await
    .context("Publish task failed.")?;

    match published {
        Ok(()) => Ok(copied),
        Err(error) => {
            let cleanup = state
                .database
                .cancel_session_file_operation(operation)
                .err()
                .map(|cleanup_error| format!(" Cleanup also failed: {cleanup_error:#}."))
                .unwrap_or_default();
            Err(anyhow::anyhow!(
                "Could not publish the managed copy: {error}.{cleanup}"
            ))
        }
    }
}

fn publish_identity_bound_session_file(
    staging: &Path,
    destination: &Path,
    expected: &SessionFileBoundIdentity,
) -> Result<()> {
    rename_session_file_no_replace(staging, destination)?;
    sync_session_file_parent(destination)?;
    if crate::storage::capture_session_file_bound_identity(destination)?.is_some_and(|actual| {
        crate::storage::session_file_bound_identity_matches(
            &actual,
            &expected.content_identity,
            Some(&expected.object_identity),
        )
    }) {
        return Ok(());
    }
    if rename_session_file_no_replace(destination, staging).is_ok() {
        let _ = sync_session_file_parent(staging);
    }
    bail!("Managed staging file changed during publication; the raced file was not adopted.")
}

/// Atomically publish a same-directory staging file without ever replacing an
/// existing destination. Cleanup can therefore distinguish an operation-owned
/// final file (staging disappeared) from a raced external file (staging remains).
#[cfg(target_os = "macos")]
pub(crate) fn rename_session_file_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_session_file_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn rename_session_file_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use windows::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    use windows::core::PCWSTR;

    let source = crate::atomic_file::windows_verbatim_path(source)?;
    let destination = crate::atomic_file::windows_verbatim_path(destination)?;
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| {
        let hresult = error.code().0 as u32;
        if hresult & 0xffff_0000 == 0x8007_0000 {
            io::Error::from_raw_os_error((hresult & 0xffff) as i32)
        } else {
            io::Error::other(error)
        }
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn rename_session_file_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::hard_link(source, destination)?;
    std::fs::remove_file(source)
}

pub(crate) fn sync_session_file_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    // MoveFileExW uses MOVEFILE_WRITE_THROUGH above; opening directories for
    // FlushFileBuffers is not portable through std on Windows.
    Ok(())
}

fn finish_session_file_operation_best_effort(state: &AppState, operation_id: &str) {
    if let Err(error) = state.database.finish_session_file_operation(operation_id) {
        state.emit_log(
            "warn",
            format!(
                "Session file was committed, but operation {operation_id} remains for startup reconciliation: {error:#}"
            ),
        );
    }
}

pub(crate) async fn probe_duration_ms(ffmpeg_path: &str, file: &Path) -> Option<i64> {
    let ffprobe = crate::ffmpeg::ffprobe_path_for(ffmpeg_path);
    let mut command = tokio::process::Command::new(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(file)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = output_duration_probe(&mut command).await.ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let seconds: f64 = parsed["format"]["duration"].as_str()?.parse().ok()?;
    (seconds.is_finite() && seconds > 0.0).then_some((seconds * 1000.0) as i64)
}

async fn output_duration_probe(command: &mut tokio::process::Command) -> io::Result<ProcessOutput> {
    // Finalization bounds this probe with `tokio::time::timeout`. Without this,
    // dropping `wait_with_output` leaves ffprobe running after that timeout.
    command.kill_on_drop(true);
    output_owned_tokio(command).await
}

/// Duplicate the session's VISIBLE file + row. Returns the new session id.
pub async fn duplicate_session(state: &AppState, session_id: &str) -> Result<String> {
    let Some(facts) = state.database.session_clone_facts(session_id)? else {
        bail!("Session not found.");
    };
    let title = facts.title;
    let mp4_path = facts.mp4_path;
    let visible = mp4_path
        .clone()
        .or(facts.output_path.clone())
        .ok_or_else(|| anyhow::anyhow!("This session has no local file to duplicate."))?;
    let source = PathBuf::from(&visible);
    if !source
        .try_exists()
        .with_context(|| format!("Could not inspect recording file {}", source.display()))?
    {
        bail!("The recording file is missing on disk.");
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let destination = first_free_duplicate_path(&source)?;
    let staging = staging_path_for(&destination, &new_id);
    let operation = state.database.begin_session_file_operation(
        "duplicate",
        &new_id,
        &staging,
        &destination,
    )?;
    let size = copy_and_publish_session_file(state, &operation, &source).await? as i64;
    let new_title = format!("{} (copy)", title.trim());
    let destination_string = destination.display().to_string();
    // The copy takes the same slot the source's visible file had.
    let (new_output, new_mp4) = if mp4_path.is_some() {
        (None, Some(destination_string.clone()))
    } else {
        (Some(destination_string.clone()), None)
    };
    let inserted = match state.database.clone_session_row(
        session_id,
        &new_id,
        &new_title,
        new_output.as_deref(),
        new_mp4.as_deref(),
        &chrono::Utc::now().to_rfc3339(),
        Some(size),
    ) {
        Ok(inserted) => inserted,
        Err(error) => {
            let _ = state.database.cancel_session_file_operation(&operation);
            return Err(error);
        }
    };
    if !inserted {
        let _ = state.database.cancel_session_file_operation(&operation);
        bail!("Session row vanished while duplicating.");
    }
    finish_session_file_operation_best_effort(state, &operation.id);
    // Poster: copy the source's if present, else extract lazily later.
    let source_poster = crate::posters::poster_path(session_id);
    if source_poster.exists() {
        let _ = std::fs::copy(&source_poster, crate::posters::poster_path(&new_id));
    }
    Ok(new_id)
}

/// Import a foreign recording: managed copy into the output directory, probed
/// duration, completed session row, poster. Returns the new session id.
pub async fn import_recording(
    state: &AppState,
    source_path: &str,
    output_directory: &str,
    ffmpeg_path: &str,
) -> Result<String> {
    let source = PathBuf::from(source_path);
    if !source
        .try_exists()
        .with_context(|| format!("Could not inspect import file {}", source.display()))?
    {
        bail!("That file does not exist.");
    }
    if !import_extension_allowed(&source) {
        bail!("Only MP4, MOV, M4V, MKV, and WebM files can be imported.");
    }
    let output_dir =
        resolve_import_output_dir(output_directory, crate::recording::default_recordings_dir())?;
    let destination = import_destination(&output_dir, &source)?;
    let id = uuid::Uuid::new_v4().to_string();
    let staging = staging_path_for(&destination, &id);
    let operation =
        state
            .database
            .begin_session_file_operation("import", &id, &staging, &destination)?;
    let file_size_bytes = copy_and_publish_session_file(state, &operation, &source).await? as i64;
    let now = chrono::Utc::now().to_rfc3339();
    let title = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported recording")
        .to_string();
    let destination_string = destination.display().to_string();
    let is_mp4_family = destination
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "mov" | "m4v"))
        .unwrap_or(false);
    let new_session = crate::storage::NewSession {
        id: id.clone(),
        title,
        started_at: now.clone(),
        mode: "imported".to_string(),
        output_path: (!is_mp4_family).then(|| destination_string.clone()),
        container: (!is_mp4_family).then(|| {
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("mkv")
                .to_ascii_lowercase()
        }),
        stream_preset: None,
        sources: crate::protocol::SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: false,
        },
        layout: crate::protocol::default_layout_settings(),
        // Imported files were not produced by a capture session; the output
        // config is a neutral placeholder the UI never reads for imports.
        output: crate::protocol::OutputSettings {
            record_enabled: false,
            stream_enabled: false,
            output_directory: Some(output_directory.trim().to_string()),
            ffmpeg_path: None,
            keep_original_mkv: false,
            video: crate::protocol::VideoSettings {
                preset: crate::protocol::VideoPreset::Tutorial1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            },
            rtmp: crate::protocol::RtmpSettings {
                preset: crate::protocol::RtmpPreset::Custom,
                server_url: String::new(),
                stream_key: String::new(),
            },
        },
    };
    let duration_ms = probe_duration_ms(ffmpeg_path, &destination).await;
    if let Err(error) = state.database.create_completed_session(
        &new_session,
        &now,
        is_mp4_family.then_some(destination_string.as_str()),
        duration_ms,
        Some(file_size_bytes),
    ) {
        let _ = state.database.cancel_session_file_operation(&operation);
        return Err(error);
    }
    finish_session_file_operation_best_effort(state, &operation.id);
    crate::posters::ensure_session_poster(
        state,
        &id,
        &destination_string,
        duration_ms,
        ffmpeg_path,
    )
    .await;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sampled_identity_collision_bytes(middle: u8) -> Vec<u8> {
        let mut bytes = vec![0x31; 192 * 1024];
        bytes[64 * 1024..128 * 1024].fill(middle);
        bytes
    }

    fn long_running_probe_command(pid_file: &Path) -> tokio::process::Command {
        #[cfg(target_os = "windows")]
        {
            let escaped_pid_file = pid_file.display().to_string().replace('\'', "''");
            let script = format!(
                "[System.IO.File]::WriteAllText('{escaped_pid_file}', [string]$PID); Start-Sleep -Seconds 30"
            );
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            command
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut command = tokio::process::Command::new("sh");
            command
                .args([
                    "-c",
                    "printf '%s\\n' \"$$\" > \"$1\"; exec sleep 30",
                    "videorc-duration-probe-test",
                ])
                .arg(pid_file);
            command
        }
    }

    #[tokio::test]
    async fn timed_out_duration_probe_terminates_its_child() {
        let base = std::env::temp_dir().join(format!(
            "videorc-duration-probe-timeout-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let pid_file = base.join("pid");
        let mut command = long_running_probe_command(&pid_file);
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        // Windows runners can take more than a second to cold-start
        // powershell.exe before the script writes its PID. Keep the command's
        // 30-second sleep as the behavior under test while allowing startup
        // enough time that a slow host does not turn this lifecycle assertion
        // into a PID-file race.
        let probe_timeout = if cfg!(target_os = "windows") {
            std::time::Duration::from_secs(5)
        } else {
            std::time::Duration::from_secs(1)
        };
        let result = tokio::time::timeout(probe_timeout, output_duration_probe(&mut command)).await;
        assert!(result.is_err(), "probe child should exceed the timeout");

        let pid = std::fs::read_to_string(&pid_file)
            .expect("probe child should publish its pid before sleeping")
            .trim()
            .parse::<u32>()
            .expect("probe child pid should be numeric");
        let stopped = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !crate::process_job::process_is_running(pid).expect("probe child liveness") {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or(false);
        if !stopped {
            let _ = crate::process_job::terminate_process(pid, true);
        }
        let _ = std::fs::remove_dir_all(&base);

        assert!(stopped, "timed-out duration probe child {pid} stayed alive");
    }

    #[test]
    fn duplicate_names_count_upward() {
        let source = Path::new("/tmp/Weekly Update.mp4");
        assert_eq!(
            duplicate_candidate_path(source, 0),
            Path::new("/tmp/Weekly Update (copy).mp4")
        );
        assert_eq!(
            duplicate_candidate_path(source, 1),
            Path::new("/tmp/Weekly Update (copy 2).mp4")
        );
        // Extension-less files survive.
        assert_eq!(
            duplicate_candidate_path(Path::new("/tmp/raw"), 0),
            Path::new("/tmp/raw (copy)")
        );
    }

    #[test]
    fn import_extension_gate() {
        assert!(import_extension_allowed(Path::new("/x/a.MP4")));
        assert!(import_extension_allowed(Path::new("/x/a.webm")));
        assert!(!import_extension_allowed(Path::new("/x/a.txt")));
        assert!(!import_extension_allowed(Path::new("/x/noext")));
    }

    // Regression (2026-07-06): import demanded an explicit output directory
    // while Settings promises "Blank uses the default" — a blank setting must
    // resolve (and create) the default recordings dir, like recording does.
    #[test]
    fn blank_output_directory_resolves_and_creates_the_default() {
        let base =
            std::env::temp_dir().join(format!("videorc-import-dir-{}", uuid::Uuid::new_v4()));
        let default_dir = base.join("Videorc").join("Recordings");

        let resolved = resolve_import_output_dir("  ", default_dir.clone()).unwrap();

        assert_eq!(resolved, default_dir);
        assert!(default_dir.is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn configured_output_directory_is_used_when_it_exists_and_errors_when_missing() {
        let base =
            std::env::temp_dir().join(format!("videorc-import-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();

        let resolved =
            resolve_import_output_dir(base.to_str().unwrap(), PathBuf::from("/unused")).unwrap();
        assert_eq!(resolved, base);

        let missing = base.join("nope");
        let error = resolve_import_output_dir(missing.to_str().unwrap(), PathBuf::from("/unused"))
            .unwrap_err();
        assert!(error.to_string().contains("does not exist"), "{error}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn no_replace_publish_preserves_an_existing_destination() {
        let directory = std::env::temp_dir().join(format!(
            "videorc-no-replace-publish-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let staging = directory.join("staging.partial");
        let destination = directory.join("recording.mp4");
        std::fs::write(&staging, b"new bytes").unwrap();
        std::fs::write(&destination, b"existing bytes").unwrap();

        let error = rename_session_file_no_replace(&staging, &destination).unwrap_err();

        assert_eq!(std::fs::read(&destination).unwrap(), b"existing bytes");
        assert_eq!(std::fs::read(&staging).unwrap(), b"new bytes");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::AlreadyExists | io::ErrorKind::PermissionDenied | io::ErrorKind::Other
        ));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn identity_bound_publish_rejects_a_same_sample_replacement() {
        let directory = std::env::temp_dir().join(format!(
            "videorc-identity-bound-publish-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let staging = directory.join("staging.partial");
        let replacement = directory.join("replacement.partial");
        let destination = directory.join("recording.mp4");
        std::fs::write(&staging, sampled_identity_collision_bytes(0x41)).unwrap();
        let expected = crate::storage::capture_session_file_bound_identity(&staging)
            .unwrap()
            .unwrap();
        let original_modified = std::fs::metadata(&staging).unwrap().modified().unwrap();

        std::fs::write(&replacement, sampled_identity_collision_bytes(0x42)).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        let replacement_ownership =
            crate::storage::capture_session_file_bound_identity(&replacement)
                .unwrap()
                .unwrap();
        assert_eq!(
            replacement_ownership.content_identity,
            expected.content_identity
        );
        assert_ne!(
            replacement_ownership.object_identity,
            expected.object_identity
        );
        std::fs::remove_file(&staging).unwrap();
        rename_session_file_no_replace(&replacement, &staging).unwrap();

        let error =
            publish_identity_bound_session_file(&staging, &destination, &expected).unwrap_err();

        assert!(error.to_string().contains("raced file was not adopted"));
        assert!(!destination.exists());
        assert_eq!(
            crate::storage::capture_session_file_bound_identity(&staging)
                .unwrap()
                .unwrap()
                .object_identity,
            replacement_ownership.object_identity
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn identity_bound_publish_accepts_mtime_drift_for_the_same_object() {
        let directory = std::env::temp_dir().join(format!(
            "videorc-identity-bound-mtime-publish-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let staging = directory.join("staging.partial");
        let destination = directory.join("recording.mp4");
        std::fs::write(&staging, b"owned recording bytes").unwrap();
        let expected = crate::storage::capture_session_file_bound_identity(&staging)
            .unwrap()
            .unwrap();
        let changed_modified =
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_234_567_890);
        std::fs::File::options()
            .write(true)
            .open(&staging)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(changed_modified))
            .unwrap();
        let timestamp_drift = crate::storage::capture_session_file_bound_identity(&staging)
            .unwrap()
            .unwrap();
        assert_ne!(timestamp_drift.content_identity, expected.content_identity);
        assert_eq!(timestamp_drift.object_identity, expected.object_identity);

        publish_identity_bound_session_file(&staging, &destination, &expected).unwrap();

        let published = crate::storage::capture_session_file_bound_identity(&destination)
            .unwrap()
            .unwrap();
        assert_eq!(published.object_identity, expected.object_identity);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"owned recording bytes"
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
