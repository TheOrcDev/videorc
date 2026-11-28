//! Library file actions driven by agents (`delete_recording`,
//! `export_recording`, and `rename_recording` refresh; plan 209 S15).
//!
//! Bridges [`Studio::set_agent_app_listener`] to the GPUI app's
//! [`crate::screens::library::Core`] (`Library<BackendClient, Files>`) so
//! agent deletes go through the exact two-phase Trash (or smoke Trash
//! stand-in) flow and exports run `Library::remux` with Electron's 10 s
//! short-export wait.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use videorc_app_core::client::BackendClient;
use videorc_app_core::library::view::{can_export_mp4, is_finalizing};
use videorc_app_core::library::{DeleteError, copy as library_copy};
use videorc_app_core::studio::Studio;
use videorc_app_core::studio::agent::{AppAgentAction, AppAgentAnswer, AppAgentIntent};

use crate::screens::library::Core;

/// How long `export_recording` waits for a short export before answering that
/// it continues in the background (Electron's `EXPORT_ANSWER_WAIT_MS`).
const EXPORT_ANSWER_WAIT: Duration = Duration::from_secs(10);

/// Installs the Studio's agent-Library listener on the core Tokio runtime.
pub fn install(
    runtime: &tokio::runtime::Handle,
    studio: Arc<Studio<BackendClient>>,
    library: Arc<Core>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<AppAgentIntent>();
    studio.set_agent_app_listener(Some(tx));
    runtime.spawn(async move {
        while let Some(intent) = rx.recv().await {
            let library = library.clone();
            match intent.action {
                AppAgentAction::RecordingRenamed => {
                    tokio::spawn(async move {
                        let _ = library.refresh().await;
                    });
                }
                AppAgentAction::DeleteRecording { ref recording_id } => {
                    let result = run_delete(&library, recording_id).await;
                    intent.answer(result);
                }
                AppAgentAction::ExportRecording {
                    ref recording_id,
                    session_active,
                } => {
                    let result = run_export(library, recording_id, session_active).await;
                    intent.answer(result);
                }
            }
        }
    });
}

async fn run_delete(library: &Core, id: &str) -> Result<AppAgentAnswer, String> {
    let title = library
        .data()
        .sessions
        .iter()
        .find(|session| session.id == id)
        .map(|session| session.title.clone());
    match library.delete(&[id.to_string()]).await {
        Ok(()) => Ok(AppAgentAnswer::Deleted { title }),
        Err(DeleteError::Rpc(error)) => Err(error.message),
        Err(DeleteError::FilesKept(message)) => Err(message),
    }
}

async fn run_export(
    library: Arc<Core>,
    id: &str,
    session_active: bool,
) -> Result<AppAgentAnswer, String> {
    let row = library
        .data()
        .sessions
        .iter()
        .find(|session| session.id == id)
        .cloned();
    if let Some(ref row) = row
        && let Some(mp4_path) = row.mp4_path.as_deref().filter(|p| !p.is_empty())
    {
        return Ok(AppAgentAnswer::Exported {
            already_mp4: true,
            exported: true,
            path: Some(mp4_path.to_string()),
        });
    }
    if session_active {
        return Err(library_copy::CAPTURE_HOLD_REASON.to_string());
    }
    if let Some(ref row) = row {
        if is_finalizing(row) {
            return Err("This recording is still exporting its MP4 in the background.".to_string());
        }
        if !can_export_mp4(row) {
            return Err(
                "That recording has no MP4 to make: it isn't a finished recording.".to_string(),
            );
        }
    }

    let id_owned = id.to_string();
    let lib_for_task = library.clone();
    let mut export_handle = tokio::spawn(async move {
        lib_for_task.remux(&id_owned).await?;
        let path = lib_for_task
            .data()
            .sessions
            .iter()
            .find(|s| s.id == id_owned)
            .and_then(|s| s.mp4_path.clone());
        Ok::<Option<String>, videorc_app_core::client::RpcError>(path)
    });

    match tokio::time::timeout(EXPORT_ANSWER_WAIT, &mut export_handle).await {
        Ok(Ok(Ok(path))) => Ok(AppAgentAnswer::Exported {
            already_mp4: false,
            exported: true,
            path,
        }),
        Ok(Ok(Err(error))) => Err(error.message),
        Ok(Err(_)) => Err("Videorc couldn't export that recording.".to_string()),
        Err(_) => {
            // Keep exporting in the background; `export_handle` keeps running when detached.
            Ok(AppAgentAnswer::Exported {
                already_mp4: false,
                exported: false,
                path: None,
            })
        }
    }
}
