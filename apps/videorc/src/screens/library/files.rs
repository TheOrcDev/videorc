//! Only the admin endpoint can name a managed file. Deletion mirrors
//! Electron's resolve → Trash → complete receipt, never remove_file.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
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
                        Ok(meta) if meta.is_file() => trash(path).is_err(),
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
#[cfg(not(target_os = "macos"))]
fn trash(_: &Path) -> Result<(), String> {
    Err("Moving recordings to the Trash isn't available on this platform yet.".into())
}
