//! Only the admin endpoint can name a managed file. Deletion mirrors
//! Electron's resolve → Trash → complete receipt, never remove_file.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, watch};
use videorc_app_core::library::{LibraryFiles, TrashOutcome};
use videorc_app_core::{
    BackendState, desktop::camera_extension::admin_request, process::BackendBootstrap,
};

pub struct Files {
    pub backend: watch::Receiver<BackendState>,
    deletion: Mutex<()>,
}
impl Files {
    pub fn new(backend: watch::Receiver<BackendState>) -> Arc<Self> {
        Arc::new(Self {
            backend,
            deletion: Mutex::new(()),
        })
    }
    pub fn bootstrap(&self) -> Result<BackendBootstrap, String> {
        self.backend
            .borrow()
            .bootstrap()
            .cloned()
            .ok_or_else(|| "Videorc is reconnecting. Try again in a moment.".into())
    }
    pub async fn path(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Managed session id is invalid.".into());
        }
        let value = admin_request(
            &self.bootstrap()?,
            "resource.admin.resolve_session_path",
            json!({"sessionId":id}),
            Duration::from_secs(15),
        )
        .await?;
        let path = value
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or("Managed session path is unavailable.")?;
        if !path.is_file() {
            return Err("Managed session path is unavailable.".into());
        }
        Ok(path)
    }
}
impl LibraryFiles for Files {
    async fn trash_session_deletion(&self, operation_id: &str) -> Result<TrashOutcome, String> {
        let _serial = self.deletion.lock().await;
        if operation_id.len() != 36
            || !operation_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
        {
            return Err("Library deletion operation id is invalid.".into());
        }
        let bootstrap = self.bootstrap()?;
        let value = admin_request(
            &bootstrap,
            "sessions.delete.resolve",
            json!({"operationId":operation_id}),
            Duration::from_secs(30),
        )
        .await?;
        if value.get("operationId").and_then(Value::as_str) != Some(operation_id) {
            return Err("Library deletion operation response is invalid.".into());
        }
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("Library deletion operation response is invalid.")?
            .to_owned();
        let paths = strings(value.get("paths"))?;
        let mut failed = match value.get("blockedPaths") {
            Some(paths) => strings(Some(paths))?,
            None => Vec::new(),
        };
        let failures = tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .filter(|raw| {
                    let path = Path::new(raw);
                    if !path.is_absolute() {
                        return true;
                    }
                    match std::fs::symlink_metadata(path) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                        Ok(meta) if meta.is_file() => trash_or_smoke(path).is_err(),
                        _ => true,
                    }
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|_| "Couldn't move the recordings to the Trash.")?;
        failed.extend(failures);
        let complete = admin_request(
            &bootstrap,
            "sessions.delete.complete",
            json!({"operationId":operation_id,"failedPaths":failed}),
            Duration::from_secs(120),
        )
        .await?;
        let deleted = complete
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(TrashOutcome {
            deleted,
            failed_count: failed.len().max(usize::from(!deleted)),
            session_id,
        })
    }
}
fn strings(value: Option<&Value>) -> Result<Vec<String>, String> {
    value
        .and_then(Value::as_array)
        .ok_or("Library deletion operation response is invalid.")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Library deletion operation response is invalid.".into())
        })
        .collect()
}
static SMOKE_TRASH_SEQ: AtomicU64 = AtomicU64::new(0);

/// Smoke runs only (plan 209 S16, Electron's `main/trash-paths.ts`
/// `smokeTrashDirectory`): a stand-in for the system Trash inside the run's
/// state directory (`VIDEORC_SMOKE_TRASH_DIR`), active only when unpackaged
/// and `VIDEORC_SMOKE_COMMAND_SERVER=1` with an absolute path.
pub(crate) fn smoke_trash_directory(
    value: Option<&str>,
    packaged: bool,
    smoke_command_server: bool,
) -> Option<PathBuf> {
    if packaged || !smoke_command_server {
        return None;
    }
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

fn trash_or_smoke(path: &Path) -> Result<(), String> {
    let packaged = crate::smoke::shell::packaged();
    let smoke_server = std::env::var("VIDEORC_SMOKE_COMMAND_SERVER").as_deref() == Ok("1");
    let raw = std::env::var("VIDEORC_SMOKE_TRASH_DIR").ok();
    if let Some(dir) = smoke_trash_directory(raw.as_deref(), packaged, smoke_server) {
        std::fs::create_dir_all(&dir)
            .map_err(|_| "Couldn't move the recording to the Trash.".to_string())?;
        let seq = SMOKE_TRASH_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recording");
        let dest = dir.join(format!("{now_ms}-{seq}-{name}"));
        return std::fs::rename(path, &dest)
            .map_err(|_| "Couldn't move the recording to the Trash.".to_string());
    }
    trash(path)
}

#[cfg(target_os = "macos")]
fn trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    objc2::rc::autoreleasepool(|_| {
        let raw = path.to_str().ok_or("The recording path is invalid.")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(raw));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|_| "Couldn't move the recording to the Trash.".into())
    })
}
/// Linux: the desktop's Trash through GIO (`gio trash`), as Electron's
/// `shell.trashItem` does there: the freedesktop Trash, restorable from the
/// file manager, on the recording's own filesystem.
#[cfg(target_os = "linux")]
fn trash(path: &Path) -> Result<(), String> {
    let output = std::process::Command::new("gio")
        .arg("trash")
        .arg("--")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|_| "Couldn't move the recording to the Trash.".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Couldn't move the recording to the Trash.".into())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn trash(_: &Path) -> Result<(), String> {
    Err("Moving recordings to the Trash isn't available on this platform yet.".into())
}

#[cfg(test)]
mod tests {
    use super::smoke_trash_directory;

    #[test]
    fn smoke_trash_directory_requires_unpackaged_smoke_server_and_absolute_path() {
        let abs = if cfg!(windows) {
            r"C:\smoke-trash"
        } else {
            "/tmp/videorc-smoke-trash"
        };
        assert!(smoke_trash_directory(Some(abs), false, true).is_some());
        assert!(smoke_trash_directory(Some(abs), true, true).is_none());
        assert!(smoke_trash_directory(Some(abs), false, false).is_none());
        assert!(smoke_trash_directory(Some("relative/trash"), false, true).is_none());
        assert!(smoke_trash_directory(Some("  "), false, true).is_none());
        assert!(smoke_trash_directory(None, false, true).is_none());
    }
}
