use super::*;
use gpui::Window;
use videorc_app_core::desktop::{
    permissions::SystemPermissionPane, system_access::SystemAccessAction,
};

impl HealthScreen {
    pub(super) fn permission_action(
        &mut self,
        pane: SystemPermissionPane,
        action: SystemAccessAction,
        cx: &mut Context<Self>,
    ) {
        if self.permission_pending.is_some() {
            return;
        }
        if action == SystemAccessAction::OpenSettings {
            self.error = self.permissions.open_settings(cx, pane).err();
            cx.notify();
            return;
        }
        self.permission_pending = Some(pane);
        let task = match action {
            SystemAccessAction::RequestMediaAccess => self.permissions.request(cx, pane),
            SystemAccessAction::Relaunch => self.permissions.relaunch(cx),
            SystemAccessAction::OpenSettings => unreachable!(),
        };
        cx.spawn(async move |entity, cx| {
            let result = task.await;
            let _ = entity.update(cx, |this, cx| {
                this.permission_pending = None;
                this.error = result.err();
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn export(&mut self, cx: &mut Context<Self>) {
        if self.export_pending || !self.studio.is_connected() {
            return;
        }
        self.export_pending = true;
        self.error = None;
        let studio = self.studio.clone();
        let logger = self.logger.clone();
        let crash_path = self.paths.backend_crash_log_file();
        let telemetry = self.studio.telemetry_now();
        let job = self.runtime.spawn(async move {
            let crashes = tokio::task::spawn_blocking(move || crash_log::read_crash_log(&crash_path)).await.unwrap_or_default();
            let logs: Vec<_> = logger.recent().iter().map(|line| json!({"level":line.level.as_str(),"message":line.message,"timestamp":line.timestamp})).collect();
            // The backend owns both the managed destination and recursive
            // redaction. Never export directly from the app or choose an
            // arbitrary output directory.
            match studio.export_support_bundle(json!({"runtimeInfo":{"platform":crate::app::hotkeys::node_platform(),"app":"gpui","backendCrashes":crashes},"nativePreviewSurfaceStatus":telemetry.preview_surface,"logs":logs})).await {
                Some(Ok(path)) => Ok(PathBuf::from(path)),
                _ => Err(()),
            }
        });
        cx.spawn(async move |entity, cx| {
            let answer = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.export_pending = false;
                match answer {
                    Ok(Ok(path)) => this.exported = Some(path),
                    _ => this.error = Some("Couldn't export a support bundle".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn reveal_bundle(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.exported.clone() else {
            return;
        };
        let root = self.paths.user_data_dir.join("support-bundles");
        let job = self
            .runtime
            .spawn_blocking(move || checked_bundle_path(&path, &root));
        cx.spawn(async move |entity, cx| {
            let path = job.await.ok().flatten();
            let _ = entity.update(cx, |this, cx| {
                if let Some(path) = path {
                    cx.reveal_path(&path);
                } else {
                    this.error = Some("Only an exported support bundle can be revealed.".into());
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn remove_camera(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.removing || !self.studio.is_connected() {
            return;
        }
        self.confirm.close(window, cx);
        self.removing = true;
        let client = self.studio.backend().clone();
        let camera = self.camera.clone();
        let job = self.runtime.spawn(async move {
            // Off first: the switch watcher must not reinstall while removal
            // is in flight, exactly as Electron's action orders it.
            client
                .request("virtualCamera.set", json!({"on":false}))
                .await
                .map_err(|_| ())?;
            let state = camera.deactivate().await;
            let (ok, message) = videorc_app_core::desktop::camera_extension::removal_result(&state);
            Ok::<_, ()>((ok, message))
        });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.removing = false;
                this.error = Some(match result {
                    Ok(Ok((true, message))) => message
                        .unwrap_or(videorc_app_core::studio::virtual_camera::copy::REMOVED)
                        .into(),
                    Ok(Ok((false, message))) => {
                        message.unwrap_or("Couldn't remove Videorc Camera").into()
                    }
                    _ => "Couldn't remove Videorc Camera".into(),
                });
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        self.rebuild(cx);
    }
}

fn checked_bundle_path(path: &std::path::Path, root: &std::path::Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.parent()? != root {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let stamp = name
        .strip_prefix("videorc-support-bundle-")?
        .strip_suffix("Z.json")?;
    let (date, time) = stamp.split_once('-')?;
    if date.len() != 8
        || time.len() != 6
        || !date.bytes().chain(time.bytes()).all(|c| c.is_ascii_digit())
    {
        return None;
    }
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file()
        || std::fs::symlink_metadata(root)
            .ok()?
            .file_type()
            .is_symlink()
    {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    (canonical.parent()? == std::fs::canonicalize(root).ok()?).then_some(canonical)
}
