//! Videorc Camera's system extension (plan 220 S2.6b), as Electron main
//! keeps it (`main/camera-extension.ts`), without the OS calls.
//!
//! macOS looks the extension up in the requesting process's bundle, so the
//! request comes from the app itself (`videorc-app`'s
//! `desktop::camera_extension`, the `OSSystemExtensionRequest` the Node addon
//! made). This module is the one place the app keeps the extension's state:
//! the phases, what each request update means, when the camera switch
//! activates it, and what the backend is told (`virtualCamera.platform.report`).
//!
//! Turning the camera off never deactivates (D12: the extension draws the
//! "off" still); deactivation is Health's "Remove Videorc Camera".

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_protocol::VirtualCameraPlatformStep;

use super::permissions::PermissionFuture;

/// `dev.theorcdev.videorc.camera`, from the one identifiers file.
pub fn camera_extension_identifier() -> String {
    serde_json::from_str::<Value>(include_str!(
        "../../../../apps/desktop/camera-extension/identifiers.json"
    ))
    .ok()
    .and_then(|ids| ids["extensionBundleId"].as_str().map(str::to_string))
    .unwrap_or_else(|| "dev.theorcdev.videorc.camera".to_string())
}

/// Plan 220 S3.6a: where the Output page's "Open System Settings" goes
/// (`CAMERA_EXTENSION_APPROVAL_URLS`, main/virtual-camera-action.ts). macOS
/// 13 and 14 allow a camera extension in Privacy & Security; from macOS 15
/// (Darwin 24) it is a switch under General → Login Items & Extensions →
/// Camera Extensions. An unreadable release reads as the current pane.
pub const APPROVAL_URL_PRIVACY_SECURITY: &str =
    "x-apple.systempreferences:com.apple.preference.security";
pub const APPROVAL_URL_LOGIN_ITEMS_EXTENSIONS: &str =
    "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/// `cameraExtensionApprovalUrl(osRelease)`.
pub fn camera_extension_approval_url(os_release: Option<&str>) -> &'static str {
    let darwin: Option<u32> = os_release
        .and_then(|release| release.split('.').next())
        .and_then(|major| major.trim().parse().ok());
    if darwin.is_some_and(|darwin| darwin < 24) {
        APPROVAL_URL_PRIVACY_SECURITY
    } else {
        APPROVAL_URL_LOGIN_ITEMS_EXTENSIONS
    }
}

/// `removalResult` (main/virtual-camera-action.ts): Health's Remove
/// Videorc Camera, in words, from the extension's state after the
/// deactivation: whether it went, and what to say beside it.
pub fn removal_result(state: &CameraExtensionState) -> (bool, Option<&'static str>) {
    match state.phase {
        CameraExtensionPhase::Removed => (true, None),
        CameraExtensionPhase::RebootRequired => (
            true,
            Some("Videorc Camera is gone after your Mac restarts."),
        ),
        CameraExtensionPhase::NeedsApproval => {
            (true, Some("Approve the removal in System Settings."))
        }
        CameraExtensionPhase::Unavailable => (false, Some("Not available on this computer.")),
        // The system's own words stay in the log (the controller logs each step).
        _ => (
            false,
            Some("macOS didn't remove Videorc Camera. Try again in a moment."),
        ),
    }
}

/// A lab aid: activate at launch without the switch.
pub const ACTIVATE_AT_LAUNCH_ENV: &str = "VIDEORC_CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CameraExtensionAction {
    Activate,
    Deactivate,
}

impl CameraExtensionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            CameraExtensionAction::Activate => "activate",
            CameraExtensionAction::Deactivate => "deactivate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CameraExtensionUpdateKind {
    NeedsApproval,
    Replacing,
    Completed,
    WillCompleteAfterReboot,
    Failed,
}

/// One step of a request, as the native request reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraExtensionUpdate {
    pub kind: CameraExtensionUpdateKind,
    pub action: CameraExtensionAction,
    pub identifier: String,
    pub code: Option<i64>,
    pub code_name: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub existing_version: Option<String>,
    pub new_version: Option<String>,
}

impl CameraExtensionUpdate {
    pub fn plain(
        kind: CameraExtensionUpdateKind,
        action: CameraExtensionAction,
        identifier: &str,
    ) -> Self {
        Self {
            kind,
            action,
            identifier: identifier.to_string(),
            code: None,
            code_name: None,
            reason: None,
            detail: None,
            existing_version: None,
            new_version: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CameraExtensionPhase {
    /// No request has been made in this launch.
    Idle,
    /// This build or platform cannot host the extension; `reason` says why.
    Unavailable,
    Activating,
    /// macOS is waiting for the person to allow it in System Settings.
    NeedsApproval,
    /// An update is replacing an older installed copy.
    Replacing,
    Active,
    /// Activated, but live only after the next restart.
    RebootRequired,
    Deactivating,
    Removed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraExtensionState {
    pub phase: CameraExtensionPhase,
    pub action: Option<CameraExtensionAction>,
    /// Plain copy for `failed` and `unavailable`.
    pub reason: Option<String>,
    pub code: Option<i64>,
    pub code_name: Option<String>,
    /// The system's own words, for diagnostics.
    pub detail: Option<String>,
    pub existing_version: Option<String>,
    pub new_version: Option<String>,
    pub updated_at: u64,
}

impl CameraExtensionState {
    fn bare(phase: CameraExtensionPhase, action: Option<CameraExtensionAction>, now: u64) -> Self {
        Self {
            phase,
            action,
            reason: None,
            code: None,
            code_name: None,
            detail: None,
            existing_version: None,
            new_version: None,
            updated_at: now,
        }
    }
}

/// `CameraExtensionAvailability`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraExtensionAvailability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The extension's platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionHost {
    MacOs,
    Other,
}

impl ExtensionHost {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            ExtensionHost::MacOs
        } else {
            ExtensionHost::Other
        }
    }
}

/// `cameraExtensionAvailability`: why this process cannot host the
/// extension, or that it can. `packaged` is a signed bundle that carries the
/// extension (the Rust app's is S5.1's); `has_binding` that this build can
/// make the request at all.
pub fn camera_extension_availability(
    host: ExtensionHost,
    packaged: bool,
    has_binding: bool,
) -> CameraExtensionAvailability {
    let unavailable = |reason: &str| CameraExtensionAvailability {
        available: false,
        reason: Some(reason.to_string()),
    };
    if host != ExtensionHost::MacOs {
        return unavailable("Videorc Camera's extension exists on macOS only.");
    }
    if !packaged {
        return unavailable(
            "The dev app carries no Videorc Camera extension. Use a Developer ID signed packaged build in the Applications folder.",
        );
    }
    if !has_binding {
        // Electron names its addon export here; the Rust app's request is
        // compiled in, so this means a build without the macOS half.
        return unavailable(
            "This build of Videorc can't make the Videorc Camera request. Rebuild it for macOS.",
        );
    }
    CameraExtensionAvailability {
        available: true,
        reason: None,
    }
}

/// `shouldActivateCameraExtensionAtLaunch`: Apple asks for the activation as
/// early as possible, so an update replaces the old extension at launch.
pub fn should_activate_at_launch(
    availability: &CameraExtensionAvailability,
    switch_on: bool,
    env: impl Fn(&str) -> Option<String>,
) -> bool {
    if !availability.available {
        return false;
    }
    switch_on || env(ACTIVATE_AT_LAUNCH_ENV).is_some_and(|value| value.trim() == "1")
}

/// `applyCameraExtensionUpdate`: the next state for one update.
pub fn apply_camera_extension_update(
    update: &CameraExtensionUpdate,
    now: u64,
) -> CameraExtensionState {
    let mut next = CameraExtensionState::bare(CameraExtensionPhase::Idle, Some(update.action), now);
    match update.kind {
        CameraExtensionUpdateKind::NeedsApproval => {
            next.phase = CameraExtensionPhase::NeedsApproval
        }
        CameraExtensionUpdateKind::Replacing => {
            next.phase = CameraExtensionPhase::Replacing;
            next.existing_version = update.existing_version.clone();
            next.new_version = update.new_version.clone();
        }
        CameraExtensionUpdateKind::Completed => {
            next.phase = match update.action {
                CameraExtensionAction::Activate => CameraExtensionPhase::Active,
                CameraExtensionAction::Deactivate => CameraExtensionPhase::Removed,
            }
        }
        CameraExtensionUpdateKind::WillCompleteAfterReboot => {
            next.phase = CameraExtensionPhase::RebootRequired
        }
        CameraExtensionUpdateKind::Failed => {
            next.phase = CameraExtensionPhase::Failed;
            next.reason = Some(
                update
                    .reason
                    .clone()
                    .unwrap_or_else(|| FAILED_FALLBACK.to_string()),
            );
            next.code = update.code;
            next.code_name = update.code_name.clone();
            next.detail = update.detail.clone();
        }
    }
    next
}

const FAILED_FALLBACK: &str = "macOS reported an error installing Videorc Camera.";

/// `updateSettlesRequest`: only `replacing` leaves the request open.
pub fn update_settles_request(kind: CameraExtensionUpdateKind) -> bool {
    kind != CameraExtensionUpdateKind::Replacing
}

/// `CAMERA_EXTENSION_DEV_BUILD_REPORT`.
pub const DEV_BUILD_REPORT: &str =
    "Videorc Camera needs the installed Videorc app; a development build can't run it.";

/// `platformReportForCameraExtension`: what the backend is told for one
/// state (`virtualCamera.platform.report`'s params), or nothing new.
pub fn platform_report_for_camera_extension(
    state: &CameraExtensionState,
    host: ExtensionHost,
    packaged: bool,
) -> Option<Value> {
    if host != ExtensionHost::MacOs {
        return None;
    }
    let step = |step: VirtualCameraPlatformStep| json!({ "platformStep": step });
    match state.phase {
        CameraExtensionPhase::NeedsApproval => Some(step(VirtualCameraPlatformStep::NeedsApproval)),
        CameraExtensionPhase::Activating | CameraExtensionPhase::Replacing => {
            Some(step(VirtualCameraPlatformStep::Installing))
        }
        CameraExtensionPhase::Active => Some(step(VirtualCameraPlatformStep::Ready)),
        CameraExtensionPhase::RebootRequired => Some(step(VirtualCameraPlatformStep::NeedsReboot)),
        CameraExtensionPhase::Failed => Some(json!({
            "platformStep": VirtualCameraPlatformStep::Failed,
            "message": state.reason.clone().unwrap_or_else(|| FAILED_FALLBACK.to_string()),
        })),
        CameraExtensionPhase::Unavailable => Some(json!({
            "platformStep": VirtualCameraPlatformStep::Failed,
            "message": if packaged {
                state.reason.clone().unwrap_or_else(|| DEV_BUILD_REPORT.to_string())
            } else {
                DEV_BUILD_REPORT.to_string()
            },
        })),
        CameraExtensionPhase::Idle
        | CameraExtensionPhase::Deactivating
        | CameraExtensionPhase::Removed => None,
    }
}

/// `cameraExtensionShouldActivateForSwitch`: only an off-to-on edge with no
/// request live or finished activates; a failed activation never retries
/// on its own report; off never deactivates.
pub fn should_activate_for_switch(
    on: bool,
    phase: CameraExtensionPhase,
    previous_on: Option<bool>,
) -> bool {
    if !on || previous_on == Some(true) {
        return false;
    }
    matches!(
        phase,
        CameraExtensionPhase::Idle | CameraExtensionPhase::Failed | CameraExtensionPhase::Removed
    )
}

/// Every update of one request, from whichever thread the OS answers on.
pub type UpdateSink = Arc<dyn Fn(CameraExtensionUpdate) + Send + Sync>;

/// `CameraExtensionBinding`: makes the request. An error means it could not
/// be submitted at all.
pub trait CameraExtensionBinding: Send + Sync {
    fn submit(
        &self,
        action: CameraExtensionAction,
        identifier: String,
        on_update: UpdateSink,
    ) -> PermissionFuture<'_, Result<(), String>>;
}

type StateSink = Arc<dyn Fn(&CameraExtensionState) + Send + Sync>;

struct Pending {
    action: CameraExtensionAction,
    generation: u64,
    settled: watch::Sender<Option<CameraExtensionState>>,
}

struct ControllerInner {
    generation: u64,
    state: CameraExtensionState,
    pending: Option<Pending>,
}

/// `createCameraExtensionController`.
#[derive(Clone)]
pub struct CameraExtensionController {
    identifier: String,
    availability: CameraExtensionAvailability,
    binding: Option<Arc<dyn CameraExtensionBinding>>,
    inner: Arc<Mutex<ControllerInner>>,
    log: Arc<dyn Fn(String) + Send + Sync>,
    on_state: StateSink,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl CameraExtensionController {
    pub fn new(
        availability: CameraExtensionAvailability,
        binding: Option<Arc<dyn CameraExtensionBinding>>,
        log: Arc<dyn Fn(String) + Send + Sync>,
        on_state: StateSink,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        let mut state = CameraExtensionState::bare(
            if availability.available {
                CameraExtensionPhase::Idle
            } else {
                CameraExtensionPhase::Unavailable
            },
            None,
            now(),
        );
        state.reason = availability.reason.clone();
        Self {
            identifier: camera_extension_identifier(),
            availability,
            binding,
            inner: Arc::new(Mutex::new(ControllerInner {
                generation: 0,
                state,
                pending: None,
            })),
            log,
            on_state,
            now,
        }
    }

    pub fn identifier(&self) -> &str {
        &self.identifier
    }

    pub fn availability(&self) -> &CameraExtensionAvailability {
        &self.availability
    }

    pub fn state(&self) -> CameraExtensionState {
        self.lock().state.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ControllerInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `setState`: kept, logged and reported.
    fn set_state(&self, inner: &mut ControllerInner, next: CameraExtensionState) {
        inner.state = next.clone();
        (self.log)(format!(
            "Videorc Camera extension: {}{}{}",
            serde_json::to_value(next.phase)
                .ok()
                .and_then(|phase| phase.as_str().map(str::to_string))
                .unwrap_or_default(),
            next.reason
                .as_deref()
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default(),
            next.code_name
                .as_deref()
                .map(|name| format!(" [{name}]"))
                .unwrap_or_default(),
        ));
        (self.on_state)(&next);
    }

    /// Submits an activation. Resolves at the first update that leaves the
    /// request waiting on the person or finishes it; a later approval still
    /// updates the state. A second call while one is pending joins it.
    pub async fn activate(&self) -> CameraExtensionState {
        self.request(CameraExtensionAction::Activate).await
    }

    pub async fn deactivate(&self) -> CameraExtensionState {
        self.request(CameraExtensionAction::Deactivate).await
    }

    async fn request(&self, action: CameraExtensionAction) -> CameraExtensionState {
        let (Some(binding), true) = (self.binding.clone(), self.availability.available) else {
            let mut inner = self.lock();
            let mut next = inner.state.clone();
            next.phase = CameraExtensionPhase::Unavailable;
            next.action = Some(action);
            next.reason = self.availability.reason.clone();
            next.updated_at = (self.now)();
            self.set_state(&mut inner, next.clone());
            return next;
        };
        let joined = {
            let inner = self.lock();
            inner
                .pending
                .as_ref()
                .filter(|pending| pending.action == action)
                .map(|pending| pending.settled.subscribe())
        };
        if let Some(joined) = joined {
            return wait_settled(joined, self).await;
        }
        let (settled, generation) = {
            let mut inner = self.lock();
            inner.generation += 1;
            let generation = inner.generation;
            let (settled, receiver) = watch::channel(None);
            // A superseded request's waiters get the newer request's state
            // (Electron leaves that promise unresolved).
            let next = CameraExtensionState::bare(
                match action {
                    CameraExtensionAction::Activate => CameraExtensionPhase::Activating,
                    CameraExtensionAction::Deactivate => CameraExtensionPhase::Deactivating,
                },
                Some(action),
                (self.now)(),
            );
            if let Some(old) = inner.pending.replace(Pending {
                action,
                generation,
                settled,
            }) {
                let _ = old.settled.send(Some(next.clone()));
            }
            self.set_state(&mut inner, next);
            (receiver, generation)
        };
        let controller = self.clone();
        let sink: UpdateSink = Arc::new(move |update: CameraExtensionUpdate| {
            controller.on_update(generation, update);
        });
        if let Err(error) = binding.submit(action, self.identifier.clone(), sink).await {
            let mut failed = CameraExtensionState::bare(
                CameraExtensionPhase::Failed,
                Some(action),
                (self.now)(),
            );
            failed.reason = Some(format!(
                "Videorc Camera could not be {}: {error}",
                match action {
                    CameraExtensionAction::Activate => "activated",
                    CameraExtensionAction::Deactivate => "removed",
                }
            ));
            failed.code_name = Some("addon".to_string());
            self.settle(generation, failed);
        }
        wait_settled(settled, self).await
    }

    /// One update from the OS. A newer request owns the state; an older
    /// one's late words are dropped.
    fn on_update(&self, generation: u64, update: CameraExtensionUpdate) {
        let next = apply_camera_extension_update(&update, (self.now)());
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        self.set_state(&mut inner, next.clone());
        if update_settles_request(update.kind)
            && let Some(pending) = inner
                .pending
                .take_if(|pending| pending.generation == generation)
        {
            let _ = pending.settled.send(Some(next));
        }
    }

    fn settle(&self, generation: u64, next: CameraExtensionState) {
        let mut inner = self.lock();
        self.set_state(&mut inner, next.clone());
        if let Some(pending) = inner
            .pending
            .take_if(|pending| pending.generation == generation)
        {
            let _ = pending.settled.send(Some(next));
        }
    }
}

async fn wait_settled(
    mut settled: watch::Receiver<Option<CameraExtensionState>>,
    controller: &CameraExtensionController,
) -> CameraExtensionState {
    loop {
        if let Some(state) = settled.borrow_and_update().clone() {
            return state;
        }
        if settled.changed().await.is_err() {
            return controller.state();
        }
    }
}

/// `requestBackendAdmin`: one request on an admin socket of its own (the
/// camera's platform report and switch are admin-only), within `timeout`.
pub async fn admin_request(
    bootstrap: &crate::process::BackendBootstrap,
    method: &str,
    params: Value,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let socket = crate::client::BackendSocket::connect(&bootstrap.admin(), timeout, timeout)
        .await
        .map_err(|_| format!("The admin request {method} could not connect."))?;
    let result = socket.request_with_timeout(method, params, timeout).await;
    socket.close().await;
    result.map_err(|error| format!("The admin request {method} failed: {}", error.message))
}

/// The switch as the app last saw it, and what to do on a change
/// (`acceptVirtualCameraStatus` and `reconcileCameraExtensionWithBackend`).
#[derive(Debug, Default)]
pub struct CameraSwitchTracker {
    last_on: Option<bool>,
}

impl CameraSwitchTracker {
    /// At every backend READY: a fresh read of the switch.
    pub fn on_ready(&mut self, switch_on: bool, phase: CameraExtensionPhase) -> bool {
        let activate = should_activate_for_switch(switch_on, phase, None);
        self.last_on = Some(switch_on);
        activate
    }

    /// `virtualCamera.changed`.
    pub fn on_changed(&mut self, switch_on: bool, phase: CameraExtensionPhase) -> bool {
        let activate = should_activate_for_switch(switch_on, phase, self.last_on);
        self.last_on = Some(switch_on);
        activate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_approval_pane_follows_the_macos_release() {
        assert_eq!(
            camera_extension_approval_url(Some("23.6.0")),
            APPROVAL_URL_PRIVACY_SECURITY
        );
        assert_eq!(
            camera_extension_approval_url(Some("24.1.0")),
            APPROVAL_URL_LOGIN_ITEMS_EXTENSIONS
        );
        assert_eq!(
            camera_extension_approval_url(None),
            APPROVAL_URL_LOGIN_ITEMS_EXTENSIONS
        );
    }
    use CameraExtensionPhase as P;
    use CameraExtensionUpdateKind as K;

    #[derive(Default)]
    struct FakeBinding {
        calls: Mutex<Vec<(CameraExtensionAction, String)>>,
        sinks: Mutex<Vec<UpdateSink>>,
        fail: Option<String>,
    }

    impl FakeBinding {
        fn emit(&self, update: CameraExtensionUpdate) {
            let sink = self.sinks.lock().unwrap().last().cloned().unwrap();
            sink(update);
        }
        fn emit_to(&self, index: usize, update: CameraExtensionUpdate) {
            let sink = self.sinks.lock().unwrap()[index].clone();
            sink(update);
        }
    }

    impl CameraExtensionBinding for FakeBinding {
        fn submit(
            &self,
            action: CameraExtensionAction,
            identifier: String,
            on_update: UpdateSink,
        ) -> PermissionFuture<'_, Result<(), String>> {
            self.calls.lock().unwrap().push((action, identifier));
            self.sinks.lock().unwrap().push(on_update);
            let fail = self.fail.clone();
            Box::pin(async move { fail.map_or(Ok(()), Err) })
        }
    }

    struct Harness {
        controller: CameraExtensionController,
        binding: Arc<FakeBinding>,
        states: Arc<Mutex<Vec<CameraExtensionState>>>,
        lines: Arc<Mutex<Vec<String>>>,
    }

    fn harness_with(binding: FakeBinding, packaged: bool) -> Harness {
        let binding = Arc::new(binding);
        let states = Arc::new(Mutex::new(Vec::new()));
        let lines = Arc::new(Mutex::new(Vec::new()));
        let kept = states.clone();
        let logged = lines.clone();
        let controller = CameraExtensionController::new(
            camera_extension_availability(ExtensionHost::MacOs, packaged, true),
            Some(binding.clone() as Arc<dyn CameraExtensionBinding>),
            Arc::new(move |line| logged.lock().unwrap().push(line)),
            Arc::new(move |state| kept.lock().unwrap().push(state.clone())),
            Arc::new(|| 1_000),
        );
        Harness {
            controller,
            binding,
            states,
            lines,
        }
    }

    fn harness() -> Harness {
        harness_with(FakeBinding::default(), true)
    }

    fn update(kind: K, action: CameraExtensionAction) -> CameraExtensionUpdate {
        CameraExtensionUpdate::plain(kind, action, "dev.theorcdev.videorc.camera")
    }

    fn phases(h: &Harness) -> Vec<P> {
        h.states.lock().unwrap().iter().map(|s| s.phase).collect()
    }

    async fn settle_soon<F: std::future::Future>(future: F) -> F::Output {
        tokio::time::timeout(std::time::Duration::from_secs(5), future)
            .await
            .expect("settled")
    }

    #[test]
    fn the_identifier_comes_from_identifiers_json() {
        assert_eq!(
            camera_extension_identifier(),
            "dev.theorcdev.videorc.camera"
        );
    }

    #[test]
    fn availability_and_launch_activation() {
        assert!(camera_extension_availability(ExtensionHost::MacOs, true, true).available);
        let other = camera_extension_availability(ExtensionHost::Other, true, true);
        assert!(other.reason.unwrap().contains("macOS only"));
        let dev = camera_extension_availability(ExtensionHost::MacOs, false, true);
        assert!(dev.reason.unwrap().contains("dev app"));
        assert!(!camera_extension_availability(ExtensionHost::MacOs, true, false).available);

        let available = camera_extension_availability(ExtensionHost::MacOs, true, true);
        let unavailable = camera_extension_availability(ExtensionHost::MacOs, false, true);
        assert!(should_activate_at_launch(&available, true, |_| None));
        assert!(!should_activate_at_launch(&available, false, |_| None));
        assert!(should_activate_at_launch(&available, false, |name| {
            (name == ACTIVATE_AT_LAUNCH_ENV).then(|| " 1 ".to_string())
        }));
        assert!(!should_activate_at_launch(&unavailable, true, |_| Some(
            "1".to_string()
        )));
    }

    #[test]
    fn every_update_kind_maps_to_a_phase() {
        let activate = CameraExtensionAction::Activate;
        let deactivate = CameraExtensionAction::Deactivate;
        assert_eq!(
            apply_camera_extension_update(&update(K::NeedsApproval, activate), 5).phase,
            P::NeedsApproval
        );
        assert_eq!(
            apply_camera_extension_update(&update(K::Completed, activate), 5).phase,
            P::Active
        );
        assert_eq!(
            apply_camera_extension_update(&update(K::Completed, deactivate), 5).phase,
            P::Removed
        );
        assert_eq!(
            apply_camera_extension_update(&update(K::WillCompleteAfterReboot, activate), 5).phase,
            P::RebootRequired
        );
        let failed = apply_camera_extension_update(&update(K::Failed, activate), 5);
        assert_eq!(failed.reason.as_deref(), Some(FAILED_FALLBACK));
        assert_eq!(failed.updated_at, 5);
        for kind in [
            K::NeedsApproval,
            K::Completed,
            K::WillCompleteAfterReboot,
            K::Failed,
        ] {
            assert!(update_settles_request(kind));
        }
        assert!(!update_settles_request(K::Replacing));
    }

    #[tokio::test]
    async fn starts_idle_activates_and_settles_on_completion() {
        let h = harness();
        assert_eq!(h.controller.state().phase, P::Idle);
        let controller = h.controller.clone();
        let pending = tokio::spawn(async move { controller.activate().await });
        tokio::task::yield_now().await;
        while h.binding.calls.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        assert_eq!(h.controller.state().phase, P::Activating);
        assert_eq!(
            *h.binding.calls.lock().unwrap(),
            [(
                CameraExtensionAction::Activate,
                "dev.theorcdev.videorc.camera".to_string()
            )]
        );
        h.binding
            .emit(update(K::Completed, CameraExtensionAction::Activate));
        assert_eq!(settle_soon(pending).await.unwrap().phase, P::Active);
        assert_eq!(phases(&h), [P::Activating, P::Active]);
        assert_eq!(
            *h.lines.lock().unwrap(),
            [
                "Videorc Camera extension: activating",
                "Videorc Camera extension: active"
            ]
        );
    }

    #[tokio::test]
    async fn resolves_at_needs_approval_and_keeps_reporting_the_approval() {
        let h = harness();
        let controller = h.controller.clone();
        let pending = tokio::spawn(async move { controller.activate().await });
        while h.binding.sinks.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        h.binding
            .emit(update(K::NeedsApproval, CameraExtensionAction::Activate));
        assert_eq!(settle_soon(pending).await.unwrap().phase, P::NeedsApproval);
        h.binding
            .emit(update(K::Completed, CameraExtensionAction::Activate));
        assert_eq!(h.controller.state().phase, P::Active);
        assert_eq!(phases(&h), [P::Activating, P::NeedsApproval, P::Active]);
    }

    #[tokio::test]
    async fn replacing_stays_open_until_the_request_finishes() {
        let h = harness();
        let controller = h.controller.clone();
        let pending = tokio::spawn(async move { controller.activate().await });
        while h.binding.sinks.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let mut replacing = update(K::Replacing, CameraExtensionAction::Activate);
        replacing.existing_version = Some("0.17.0".to_string());
        replacing.new_version = Some("0.18.0".to_string());
        h.binding.emit(replacing);
        let state = h.controller.state();
        assert_eq!(state.phase, P::Replacing);
        assert_eq!(state.existing_version.as_deref(), Some("0.17.0"));
        assert_eq!(state.new_version.as_deref(), Some("0.18.0"));
        assert!(!pending.is_finished());
        h.binding.emit(update(
            K::WillCompleteAfterReboot,
            CameraExtensionAction::Activate,
        ));
        assert_eq!(settle_soon(pending).await.unwrap().phase, P::RebootRequired);
    }

    #[tokio::test]
    async fn carries_the_mapped_failure_reason_and_code() {
        let h = harness();
        let controller = h.controller.clone();
        let pending = tokio::spawn(async move { controller.activate().await });
        while h.binding.sinks.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let mut failed = update(K::Failed, CameraExtensionAction::Activate);
        failed.code = Some(3);
        failed.code_name = Some("unsupportedParentBundleLocation".to_string());
        failed.reason = Some(
            "Move Videorc to the Applications folder, then turn Videorc Camera on again."
                .to_string(),
        );
        failed.detail = Some("parent bundle".to_string());
        h.binding.emit(failed);
        let state = settle_soon(pending).await.unwrap();
        assert_eq!(state.phase, P::Failed);
        assert_eq!(state.code, Some(3));
        assert_eq!(state.detail.as_deref(), Some("parent bundle"));
        assert_eq!(
            h.lines.lock().unwrap().last().unwrap(),
            "Videorc Camera extension: failed (Move Videorc to the Applications folder, then turn Videorc Camera on again.) [unsupportedParentBundleLocation]"
        );
    }

    #[tokio::test]
    async fn joins_a_pending_request_and_drops_a_superseded_requests_late_words() {
        let h = harness();
        let first = {
            let controller = h.controller.clone();
            tokio::spawn(async move { controller.activate().await })
        };
        while h.binding.sinks.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let second = {
            let controller = h.controller.clone();
            tokio::spawn(async move { controller.activate().await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(h.binding.calls.lock().unwrap().len(), 1, "joined");
        let removal = {
            let controller = h.controller.clone();
            tokio::spawn(async move { controller.deactivate().await })
        };
        while h.binding.sinks.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        assert_eq!(h.controller.state().phase, P::Deactivating);
        // The superseded activation's waiters get the newer state.
        assert_eq!(settle_soon(first).await.unwrap().phase, P::Deactivating);
        assert_eq!(settle_soon(second).await.unwrap().phase, P::Deactivating);
        // The older activation reports now: ignored.
        h.binding
            .emit_to(0, update(K::Completed, CameraExtensionAction::Activate));
        assert_eq!(h.controller.state().phase, P::Deactivating);
        h.binding
            .emit(update(K::Completed, CameraExtensionAction::Deactivate));
        assert_eq!(settle_soon(removal).await.unwrap().phase, P::Removed);
        let actions: Vec<_> = h
            .binding
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(action, _)| *action)
            .collect();
        assert_eq!(
            actions,
            [
                CameraExtensionAction::Activate,
                CameraExtensionAction::Deactivate
            ]
        );
    }

    #[tokio::test]
    async fn a_submission_that_fails_becomes_failed_with_the_addon_marker() {
        let h = harness_with(
            FakeBinding {
                fail: Some(
                    "Camera extension requests must be made on the macOS main thread.".to_string(),
                ),
                ..FakeBinding::default()
            },
            true,
        );
        let failed = settle_soon(h.controller.activate()).await;
        assert_eq!(failed.phase, P::Failed);
        assert_eq!(failed.code_name.as_deref(), Some("addon"));
        assert!(failed.reason.unwrap().contains(
            "could not be activated: Camera extension requests must be made on the macOS main thread."
        ));
    }

    #[tokio::test]
    async fn an_unavailable_host_answers_at_once_and_never_calls_the_binding() {
        let h = harness_with(FakeBinding::default(), false);
        let state = h.controller.state();
        assert_eq!(state.phase, P::Unavailable);
        assert!(state.reason.unwrap().contains("dev app"));
        let result = settle_soon(h.controller.activate()).await;
        assert_eq!(result.phase, P::Unavailable);
        assert_eq!(result.action, Some(CameraExtensionAction::Activate));
        assert!(h.binding.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn the_backend_hears_every_phase_it_knows() {
        let state = |phase: P, reason: Option<&str>| CameraExtensionState {
            reason: reason.map(str::to_string),
            ..CameraExtensionState::bare(phase, Some(CameraExtensionAction::Activate), 0)
        };
        let mac = ExtensionHost::MacOs;
        assert_eq!(
            platform_report_for_camera_extension(&state(P::NeedsApproval, None), mac, true),
            Some(json!({"platformStep": "needs-approval"}))
        );
        for phase in [P::Activating, P::Replacing] {
            assert_eq!(
                platform_report_for_camera_extension(&state(phase, None), mac, true),
                Some(json!({"platformStep": "installing"}))
            );
        }
        assert_eq!(
            platform_report_for_camera_extension(&state(P::Active, None), mac, true),
            Some(json!({"platformStep": "ready"}))
        );
        assert_eq!(
            platform_report_for_camera_extension(&state(P::RebootRequired, None), mac, true),
            Some(json!({"platformStep": "needs-reboot"}))
        );
        assert_eq!(
            platform_report_for_camera_extension(&state(P::Failed, Some("nope")), mac, true),
            Some(json!({"platformStep": "failed", "message": "nope"}))
        );
        assert_eq!(
            platform_report_for_camera_extension(
                &state(P::Unavailable, Some("dev app")),
                mac,
                false
            ),
            Some(json!({"platformStep": "failed", "message": DEV_BUILD_REPORT}))
        );
        assert_eq!(
            platform_report_for_camera_extension(
                &state(P::Unavailable, Some("no binding")),
                mac,
                true
            ),
            Some(json!({"platformStep": "failed", "message": "no binding"}))
        );
        for phase in [P::Idle, P::Deactivating, P::Removed] {
            assert_eq!(
                platform_report_for_camera_extension(&state(phase, None), mac, true),
                None
            );
        }
        assert_eq!(
            platform_report_for_camera_extension(
                &state(P::Active, None),
                ExtensionHost::Other,
                true
            ),
            None
        );
    }

    #[test]
    fn the_switch_activates_only_on_an_off_to_on_edge() {
        assert!(should_activate_for_switch(true, P::Idle, None));
        assert!(should_activate_for_switch(true, P::Failed, Some(false)));
        assert!(should_activate_for_switch(true, P::Removed, None));
        assert!(!should_activate_for_switch(true, P::Active, None));
        assert!(!should_activate_for_switch(true, P::NeedsApproval, None));
        assert!(!should_activate_for_switch(false, P::Idle, None));
        assert!(!should_activate_for_switch(true, P::Failed, Some(true)));

        let mut tracker = CameraSwitchTracker::default();
        assert!(tracker.on_ready(true, P::Idle));
        // The failed activation's own report says on again: no retry.
        assert!(!tracker.on_changed(true, P::Failed));
        assert!(!tracker.on_changed(false, P::Failed));
        assert!(tracker.on_changed(true, P::Failed));
        // A fresh backend is a fresh read.
        assert!(tracker.on_ready(true, P::Failed));
    }

    #[test]
    fn the_electron_source_still_says_the_same() {
        let source = include_str!("../../../../apps/desktop/src/main/camera-extension.ts");
        for sentence in [
            "Videorc Camera's extension exists on macOS only.",
            "The dev app carries no Videorc Camera extension. Use a Developer ID signed packaged build in the Applications folder.",
            DEV_BUILD_REPORT,
            FAILED_FALLBACK,
            ACTIVATE_AT_LAUNCH_ENV,
        ] {
            assert!(source.contains(sentence), "{sentence}");
        }
    }
}
