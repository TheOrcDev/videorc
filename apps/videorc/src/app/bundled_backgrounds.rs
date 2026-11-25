//! The bundled pictures, registered with the backend at every READY, as
//! Electron's main does for the renderer (`bundledBackgroundAssets`,
//! `livePosterAssets`): each preset under its `builtin-bg-NN` id and each
//! live look's poster under `live-<id>-<look>`, so a scene or the camera's
//! background naming one resolves on the backend
//! (`resource.capability.register_background`, a path check; nothing is
//! read until it is shown).
//!
//! The files are [`videorc_app_core::bundled`]'s: the checkout's in a dev
//! build, the package's resources once there is one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tokio::runtime::Handle;
use tokio::sync::watch;
use videorc_app_core::desktop::camera_extension::admin_request;
use videorc_app_core::scenes::background::BUNDLED_BACKGROUNDS;
use videorc_app_core::{BackendState, Logger};

const ADMIN_TIMEOUT: Duration = Duration::from_secs(10);

/// Every bundled picture as `(assetId, path)`: the presets in manifest
/// order, then the live posters (`live-*.webp` beside them) by name. Only
/// files that exist, as Electron's `existsSync` filter.
pub fn bundled_pictures(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut pictures: Vec<(String, PathBuf)> = BUNDLED_BACKGROUNDS
        .iter()
        .map(|(id, file)| (id.to_string(), dir.join(file)))
        .filter(|(_, path)| path.is_file())
        .collect();
    let mut posters: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            let poster = stem.starts_with("live-")
                && path.extension().and_then(|ext| ext.to_str()) == Some("webp")
                && path.is_file();
            poster.then_some((stem, path))
        })
        .collect();
    posters.sort();
    pictures.extend(posters);
    pictures
}

/// Registers the bundled pictures at each backend READY (once per
/// generation). A refusal is logged, never fatal.
pub fn install(runtime: &Handle, mut backend: watch::Receiver<BackendState>, logger: Logger) {
    runtime.spawn(async move {
        let mut seen = None;
        loop {
            let ready = match &*backend.borrow_and_update() {
                BackendState::Ready { generation, .. } => Some(*generation),
                _ => None,
            };
            if let Some(generation) = ready
                && seen != Some(generation)
            {
                seen = Some(generation);
                let bootstrap = backend.borrow().bootstrap().cloned();
                if let Some(bootstrap) = bootstrap {
                    let logger = logger.clone();
                    tokio::spawn(async move { register(&bootstrap, &logger).await });
                }
            }
            if backend.changed().await.is_err() {
                break;
            }
        }
    });
}

async fn register(bootstrap: &videorc_app_core::BackendBootstrap, logger: &Logger) {
    let dir = &videorc_app_core::bundled::current().backgrounds;
    let pictures = bundled_pictures(dir);
    if pictures.is_empty() {
        logger.warn(format!(
            "No bundled background pictures in {}; presets and live posters won't resolve.",
            dir.display()
        ));
        return;
    }
    let mut refused = 0usize;
    for (asset_id, path) in &pictures {
        let params = json!({ "assetId": asset_id, "path": path.to_string_lossy() });
        if let Err(error) = admin_request(
            bootstrap,
            "resource.capability.register_background",
            params,
            ADMIN_TIMEOUT,
        )
        .await
        {
            refused += 1;
            if refused == 1 {
                logger.warn(format!(
                    "The backend refused the bundled picture {asset_id}: {error}"
                ));
            }
        }
    }
    if refused > 0 {
        logger.warn(format!(
            "{refused} of {} bundled pictures were refused.",
            pictures.len()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkout_has_the_ten_presets_then_every_live_poster() {
        let pictures = bundled_pictures(&videorc_app_core::bundled::current().backgrounds);
        let ids: Vec<&str> = pictures.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids[0], "builtin-bg-01");
        assert_eq!(ids[9], "builtin-bg-10");
        assert!(ids.contains(&"live-silk-satin"));
        assert!(ids[10..].iter().all(|id| id.starts_with("live-")));
        // Ten backgrounds with three looks each.
        assert_eq!(ids.len(), 10 + 30);
    }
}
