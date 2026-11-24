//! Videorc Camera's system extension (plan 260 S2.6a part 4): the core's
//! controller (`desktop::camera_extension`, Electron's
//! `main/camera-extension.ts`) on the platform's request
//! ([`crate::platform::Platform::camera_extension`]), as videorc-rust's
//! `desktop/permissions.rs` runs it.
//!
//! - The extension is activated when the backend's switch is on: at every
//!   backend READY (the saved setting) and on `virtualCamera.changed`.
//!   Turning the camera off never deactivates (D12: the extension draws the
//!   "off" still); deactivation is Health's Remove Videorc Camera.
//! - Every phase is reported to the backend (`virtualCamera.platform.report`)
//!   on an admin socket, never fatally.
//! - Apple asks for the activation as early as possible; at launch only the
//!   lab aid (`VIDEORC_CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH=1`) is known.
//!
//! A bare `cargo` binary carries no extension: the controller reports it
//! unavailable with its reason, and nothing is submitted.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::{broadcast, watch};
use videorc_app_core::desktop::camera_extension::{
    CameraExtensionController, CameraExtensionState, CameraSwitchTracker, ExtensionHost,
    admin_request, camera_extension_availability, platform_report_for_camera_extension,
    should_activate_at_launch, unix_ms,
};
use videorc_app_core::{BackendBootstrap, BackendEvent, BackendState, Logger};

use crate::platform;

/// The event the client's filter must include for the camera switch.
pub const VIRTUAL_CAMERA_CHANGED: &str = "virtualCamera.changed";

const ADMIN_TIMEOUT: Duration = Duration::from_secs(10);

/// The controller, the switch as last seen, and the backend to report to.
pub struct Camera {
    controller: CameraExtensionController,
    switch: Mutex<CameraSwitchTracker>,
    backend: watch::Receiver<BackendState>,
    packaged: bool,
    runtime: Handle,
    logger: Logger,
}

impl Camera {
    /// Sets up the controller and follows the backend's READY and the
    /// camera switch on the core's runtime.
    pub fn install(
        runtime: &Handle,
        backend: watch::Receiver<BackendState>,
        mut events: broadcast::Receiver<BackendEvent>,
        logger: Logger,
    ) -> Arc<Self> {
        let binding = platform::current().camera_extension();
        let packaged = packaged();
        let availability =
            camera_extension_availability(ExtensionHost::current(), packaged, binding.is_some());
        let log = {
            let logger = logger.clone();
            Arc::new(move |line: String| logger.info(line))
        };
        let on_state = {
            let runtime = runtime.clone();
            let backend = backend.clone();
            let logger = logger.clone();
            Arc::new(move |state: &CameraExtensionState| {
                let Some(report) =
                    platform_report_for_camera_extension(state, ExtensionHost::current(), packaged)
                else {
                    return;
                };
                let backend = backend.clone();
                let logger = logger.clone();
                runtime.spawn(async move { report_to_backend(&backend, report, &logger).await });
            })
        };
        let controller =
            CameraExtensionController::new(availability, binding, log, on_state, Arc::new(unix_ms));
        let camera = Arc::new(Self {
            controller,
            switch: Mutex::new(CameraSwitchTracker::default()),
            backend: backend.clone(),
            packaged,
            runtime: runtime.clone(),
            logger,
        });

        // At every backend READY: report the phase, read the saved switch.
        {
            let camera = camera.clone();
            let mut backend = backend;
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
                        let camera = camera.clone();
                        tokio::spawn(async move { camera.reconcile().await });
                    }
                    if backend.changed().await.is_err() {
                        break;
                    }
                }
            });
        }
        // The switch turned on or off.
        {
            let camera = camera.clone();
            runtime.spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(BackendEvent::Untyped { event, payload })
                            if event == VIRTUAL_CAMERA_CHANGED =>
                        {
                            camera.switch_changed(&payload);
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        // The lab aid: activate at launch without the switch.
        if should_activate_at_launch(camera.controller.availability(), false, |name| {
            std::env::var(name).ok()
        }) {
            camera.activate();
        }
        camera
    }

    fn activate(&self) {
        let controller = self.controller.clone();
        self.runtime.spawn(async move {
            controller.activate().await;
        });
    }

    /// `reconcileCameraExtensionWithBackend`.
    async fn reconcile(&self) {
        if ExtensionHost::current() != ExtensionHost::MacOs {
            return;
        }
        let state = self.controller.state();
        if let Some(report) =
            platform_report_for_camera_extension(&state, ExtensionHost::MacOs, self.packaged)
        {
            report_to_backend(&self.backend, report, &self.logger).await;
        }
        if !self.controller.availability().available {
            return;
        }
        let switch_on = match ready_bootstrap(&self.backend) {
            Some(bootstrap) => {
                match admin_request(&bootstrap, "virtualCamera.status", json!({}), ADMIN_TIMEOUT)
                    .await
                {
                    Ok(status) => status["on"].as_bool() == Some(true),
                    Err(error) => {
                        self.logger
                            .warn(format!("Could not read the Videorc Camera switch: {error}"));
                        false
                    }
                }
            }
            None => false,
        };
        let activate = self
            .switch
            .lock()
            .map(|mut tracker| tracker.on_ready(switch_on, self.controller.state().phase))
            .unwrap_or(false);
        if activate {
            self.logger
                .info("Videorc Camera is on in the saved settings; activating its extension.");
            self.activate();
        }
    }

    /// `acceptVirtualCameraStatus`.
    fn switch_changed(&self, payload: &Value) {
        let Some(on) = payload.get("on").and_then(Value::as_bool) else {
            self.logger
                .warn("Main dropped a Videorc Camera status: no `on` in the payload.");
            return;
        };
        if ExtensionHost::current() != ExtensionHost::MacOs {
            return;
        }
        let phase = self.controller.state().phase;
        let activate = self
            .switch
            .lock()
            .map(|mut tracker| tracker.on_changed(on, phase))
            .unwrap_or(false)
            && self.controller.availability().available;
        if activate {
            self.logger
                .info("Videorc Camera switched on; activating its extension.");
            self.activate();
        }
    }

    /// The extension's state, for the Output page and Health.
    #[allow(dead_code)]
    pub fn state(&self) -> CameraExtensionState {
        self.controller.state()
    }

    /// Health's Remove Videorc Camera (`runVirtualCameraAction('remove')`),
    /// which a build without the extension answers as unavailable.
    #[allow(dead_code)]
    pub async fn deactivate(&self) -> CameraExtensionState {
        self.controller.deactivate().await
    }
}

/// A bundle that carries the extension (`Contents/Library/SystemExtensions`
/// beside the executable). A bare `cargo` binary is the dev app.
fn packaged() -> bool {
    std::env::current_exe().ok().is_some_and(|exe| {
        let text = exe.to_string_lossy().into_owned();
        let Some(index) = text.find(".app/Contents/MacOS/") else {
            return false;
        };
        std::path::Path::new(&text[..index + 4])
            .join("Contents/Library/SystemExtensions")
            .is_dir()
    })
}

fn ready_bootstrap(backend: &watch::Receiver<BackendState>) -> Option<BackendBootstrap> {
    backend.borrow().bootstrap().cloned()
}

/// `reportCameraExtensionToBackend`: never fatal.
async fn report_to_backend(
    backend: &watch::Receiver<BackendState>,
    report: Value,
    logger: &Logger,
) {
    let Some(bootstrap) = ready_bootstrap(backend) else {
        return;
    };
    if let Err(error) = admin_request(
        &bootstrap,
        "virtualCamera.platform.report",
        report,
        ADMIN_TIMEOUT,
    )
    .await
    {
        logger.warn(format!(
            "Videorc Camera's extension state did not reach the backend: {error}"
        ));
    }
}
