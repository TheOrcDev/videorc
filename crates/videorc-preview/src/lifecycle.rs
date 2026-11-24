//! The Preview window's lifecycle (plan 220 S2.3b): Electron main's
//! `PreviewSupervisorModel` (`preview-supervisor.ts`), ported state for
//! state, with its tests, so `preview-window-state` reports the same
//! `supervisor` object the probes read.
//!
//! One difference, by design: Electron falls back to its proof surface (a
//! second BrowserWindow drawing JPEG frames), so a fallback names
//! `electron-proof-surface`. The Rust app has no proof surface: a fallback
//! says the transport is `unavailable`, the backing `none`, and carries the
//! reason (AGENTS.md "Native Preview Rules": a fallback is named, never a
//! silent placeholder).

use serde_json::{Value, json};
use videorc_protocol::{PreviewSurfaceBacking, PreviewTransport};

/// `PreviewLifecycleState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Closed,
    OpeningWindow,
    OpenNoSurface,
    StartingSurface,
    SurfaceLive,
    SurfaceFallback,
    PermissionRequired,
    Closing,
    Failed,
}

impl LifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            LifecycleState::Closed => "closed",
            LifecycleState::OpeningWindow => "opening-window",
            LifecycleState::OpenNoSurface => "open-no-surface",
            LifecycleState::StartingSurface => "starting-surface",
            LifecycleState::SurfaceLive => "surface-live",
            LifecycleState::SurfaceFallback => "surface-fallback",
            LifecycleState::PermissionRequired => "permission-required",
            LifecycleState::Closing => "closing",
            LifecycleState::Failed => "failed",
        }
    }

    /// `isPreviewTerminalState`.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            LifecycleState::Closed | LifecycleState::Failed | LifecycleState::PermissionRequired
        )
    }
}

/// `PreviewPermissionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    Ok,
    ScreenRecordingRequired,
    CameraRequired,
    Unknown,
}

impl PermissionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionStatus::Ok => "ok",
            PermissionStatus::ScreenRecordingRequired => "screen-recording-required",
            PermissionStatus::CameraRequired => "camera-required",
            PermissionStatus::Unknown => "unknown",
        }
    }

    /// `previewPermissionStatusFromIpc`: an unknown word is `unknown`.
    pub fn parse(text: &str) -> Self {
        match text {
            "ok" => PermissionStatus::Ok,
            "screen-recording-required" => PermissionStatus::ScreenRecordingRequired,
            "camera-required" => PermissionStatus::CameraRequired,
            _ => PermissionStatus::Unknown,
        }
    }
}

/// `PreviewLifecycleTransport`: a transport, or none, or unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleTransport {
    Transport(PreviewTransport),
    None,
    Unknown,
}

impl LifecycleTransport {
    fn json(self) -> Value {
        match self {
            LifecycleTransport::Transport(transport) => {
                serde_json::to_value(transport).unwrap_or(Value::Null)
            }
            LifecycleTransport::None => json!("none"),
            LifecycleTransport::Unknown => json!("unknown"),
        }
    }
}

/// `PreviewLifecycleBacking`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleBacking {
    Backing(PreviewSurfaceBacking),
    Unknown,
}

impl LifecycleBacking {
    fn json(self) -> Value {
        match self {
            LifecycleBacking::Backing(backing) => {
                serde_json::to_value(backing).unwrap_or(Value::Null)
            }
            LifecycleBacking::Unknown => json!("unknown"),
        }
    }
}

/// `NativePreviewHostKind`; the Rust app's layer is always `in-process`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    InProcess,
    HelperProcess,
    ExternalModule,
    ProofSurface,
    BackendD3d11Presenter,
}

impl HostKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HostKind::InProcess => "in-process",
            HostKind::HelperProcess => "helper-process",
            HostKind::ExternalModule => "external-module",
            HostKind::ProofSurface => "proof-surface",
            HostKind::BackendD3d11Presenter => "backend-d3d11-presenter",
        }
    }
}

/// `PreviewSupervisorState`.
#[derive(Debug, Clone, PartialEq)]
pub struct SupervisorState {
    pub lifecycle_state: LifecycleState,
    pub generation: u64,
    pub window_open: bool,
    pub window_visible: bool,
    pub surface_requested: bool,
    pub surface_active: bool,
    pub transport: LifecycleTransport,
    pub backing: LifecycleBacking,
    pub native_preview_host_kind: Option<HostKind>,
    pub permission_status: PermissionStatus,
    pub fallback_reason: Option<String>,
    pub last_error: Option<String>,
    /// ISO 8601, from the model's clock.
    pub updated_at: String,
}

impl SupervisorState {
    fn closed(generation: u64, updated_at: String) -> Self {
        Self {
            lifecycle_state: LifecycleState::Closed,
            generation,
            window_open: false,
            window_visible: false,
            surface_requested: false,
            surface_active: false,
            transport: LifecycleTransport::None,
            backing: LifecycleBacking::Backing(PreviewSurfaceBacking::None),
            native_preview_host_kind: None,
            permission_status: PermissionStatus::Ok,
            fallback_reason: None,
            last_error: None,
            updated_at,
        }
    }

    /// The `supervisor` object of `preview-window-state`, Electron's keys;
    /// the optional fields are absent, not null, as `undefined` serialises.
    pub fn to_json(&self) -> Value {
        let mut object = json!({
            "lifecycleState": self.lifecycle_state.as_str(),
            "generation": self.generation,
            "windowOpen": self.window_open,
            "windowVisible": self.window_visible,
            "surfaceRequested": self.surface_requested,
            "surfaceActive": self.surface_active,
            "transport": self.transport.json(),
            "backing": self.backing.json(),
            "permissionStatus": self.permission_status.as_str(),
            "updatedAt": self.updated_at,
        });
        let map = object.as_object_mut().expect("an object above");
        if let Some(kind) = self.native_preview_host_kind {
            map.insert("nativePreviewHostKind".into(), json!(kind.as_str()));
        }
        if let Some(reason) = &self.fallback_reason {
            map.insert("fallbackReason".into(), json!(reason));
        }
        if let Some(error) = &self.last_error {
            map.insert("lastError".into(), json!(error));
        }
        object
    }
}

/// `PreviewSurfaceLiveEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceLiveEvent {
    pub generation: u64,
    pub transport: LifecycleTransport,
    pub backing: LifecycleBacking,
    pub native_preview_host_kind: Option<HostKind>,
}

impl SurfaceLiveEvent {
    /// The Rust app's own surface: Metal, in process.
    pub fn metal_in_process(generation: u64) -> Self {
        Self {
            generation,
            transport: LifecycleTransport::Transport(PreviewTransport::NativeSurface),
            backing: LifecycleBacking::Backing(PreviewSurfaceBacking::CaMetalLayer),
            native_preview_host_kind: Some(HostKind::InProcess),
        }
    }
}

/// `PreviewPermissionEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionEvent {
    pub generation: u64,
    pub permission_status: PermissionStatus,
    pub message: Option<String>,
}

/// The platforms the capability rule knows (`nativePreviewCapability`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(target_os = "windows") {
            Platform::Win32
        } else {
            Platform::Linux
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Platform::Darwin => "darwin",
            Platform::Win32 => "win32",
            Platform::Linux => "linux",
        }
    }
}

/// `isNativePreviewCapability`: Metal on a `cametal-layer` is native on
/// macOS; the D3D11 triple on Windows; nothing else anywhere.
pub fn is_native_capability(event: &SurfaceLiveEvent, platform: Platform) -> bool {
    match platform {
        Platform::Darwin => {
            event.transport == LifecycleTransport::Transport(PreviewTransport::NativeSurface)
                && event.backing == LifecycleBacking::Backing(PreviewSurfaceBacking::CaMetalLayer)
        }
        Platform::Win32 => {
            event.transport == LifecycleTransport::Transport(PreviewTransport::D3d11SharedTexture)
                && event.backing
                    == LifecycleBacking::Backing(PreviewSurfaceBacking::DirectcompositionSwapChain)
                && event.native_preview_host_kind == Some(HostKind::BackendD3d11Presenter)
        }
        Platform::Linux => false,
    }
}

/// `PreviewSupervisorModel`.
pub struct Supervisor {
    state: SupervisorState,
    now: Box<dyn FnMut() -> String + Send>,
    platform: Platform,
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Supervisor")
            .field("state", &self.state)
            .field("platform", &self.platform.as_str())
            .finish()
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new(Platform::current(), Box::new(iso_now))
    }
}

/// `new Date().toISOString()`: UTC with milliseconds (civil-from-days, so
/// this crate needs no date dependency).
fn iso_now() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix(elapsed.as_secs(), elapsed.subsec_millis())
}

fn iso_from_unix(seconds: u64, millis: u32) -> String {
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

impl Supervisor {
    pub fn new(platform: Platform, now: Box<dyn FnMut() -> String + Send>) -> Self {
        let mut now = now;
        let state = SupervisorState::closed(0, now());
        Self {
            state,
            now,
            platform,
        }
    }

    pub fn snapshot(&self) -> SupervisorState {
        self.state.clone()
    }

    pub fn generation(&self) -> u64 {
        self.state.generation
    }

    pub fn lifecycle_state(&self) -> LifecycleState {
        self.state.lifecycle_state
    }

    /// `openWindow`: a fresh generation, unless a window is already up.
    pub fn open_window(&mut self) -> SupervisorState {
        if matches!(
            self.state.lifecycle_state,
            LifecycleState::OpeningWindow
                | LifecycleState::OpenNoSurface
                | LifecycleState::StartingSurface
                | LifecycleState::SurfaceLive
                | LifecycleState::SurfaceFallback
                | LifecycleState::PermissionRequired
        ) {
            return self.snapshot();
        }
        let generation = self.state.generation + 1;
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::OpeningWindow;
            state.generation = generation;
            state.window_open = false;
            state.window_visible = false;
            state.surface_requested = false;
            state.surface_active = false;
            state.transport = LifecycleTransport::None;
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
            state.permission_status = PermissionStatus::Ok;
            state.fallback_reason = None;
            state.last_error = None;
        })
    }

    /// `windowOpened`.
    pub fn window_opened(&mut self, visible: bool) -> SupervisorState {
        if self.state.lifecycle_state != LifecycleState::OpeningWindow {
            return self.snapshot();
        }
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::OpenNoSurface;
            state.window_open = true;
            state.window_visible = visible;
        })
    }

    /// `setWindowVisible`.
    pub fn set_window_visible(&mut self, visible: bool) -> SupervisorState {
        if !self.state.window_open || self.state.lifecycle_state == LifecycleState::Closed {
            return self.snapshot();
        }
        self.transition(|state| state.window_visible = visible)
    }

    /// `requestSurface`.
    pub fn request_surface(&mut self) -> SupervisorState {
        if !self.state.window_open
            || matches!(
                self.state.lifecycle_state,
                LifecycleState::Closing | LifecycleState::PermissionRequired
            )
        {
            return self.snapshot();
        }
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::StartingSurface;
            state.surface_requested = true;
            state.surface_active = false;
            state.transport = LifecycleTransport::None;
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
            state.permission_status = PermissionStatus::Ok;
            state.fallback_reason = None;
            state.last_error = None;
        })
    }

    /// `surfaceLive`: native on this platform, or a named fallback.
    pub fn surface_live(&mut self, event: SurfaceLiveEvent) -> SupervisorState {
        if !self.accepts_surface_event(event.generation) {
            return self.snapshot();
        }
        let native = !matches!(
            event.transport,
            LifecycleTransport::None | LifecycleTransport::Unknown
        ) && event.backing != LifecycleBacking::Unknown
            && is_native_capability(&event, self.platform);
        if !native {
            let reason = format!(
                "Preview transport {}/{} is not native on {}.",
                lifecycle_transport_name(event.transport),
                lifecycle_backing_name(event.backing),
                self.platform.as_str()
            );
            return self.fallback_transition(reason);
        }
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::SurfaceLive;
            state.surface_requested = true;
            state.surface_active = true;
            state.transport = event.transport;
            state.backing = event.backing;
            state.native_preview_host_kind = event.native_preview_host_kind;
            state.permission_status = PermissionStatus::Ok;
            state.fallback_reason = None;
            state.last_error = None;
        })
    }

    /// `surfaceFallback`: declared, with its reason.
    pub fn surface_fallback(&mut self, generation: u64, reason: &str) -> SupervisorState {
        if !self.accepts_surface_event(generation) {
            return self.snapshot();
        }
        self.fallback_transition(reason.to_string())
    }

    fn fallback_transition(&mut self, reason: String) -> SupervisorState {
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::SurfaceFallback;
            state.surface_requested = true;
            state.surface_active = false;
            // No proof surface here: nothing presents, and the reason says why.
            state.transport = LifecycleTransport::Transport(PreviewTransport::Unavailable);
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
            state.permission_status = PermissionStatus::Ok;
            state.fallback_reason = Some(reason);
            state.last_error = None;
        })
    }

    /// `permissionRequired`.
    pub fn permission_required(&mut self, event: PermissionEvent) -> SupervisorState {
        if !self.accepts_preview_event(event.generation) {
            return self.snapshot();
        }
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::PermissionRequired;
            state.surface_requested = false;
            state.surface_active = false;
            state.transport = LifecycleTransport::None;
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
            state.permission_status = event.permission_status;
            state.fallback_reason = None;
            state.last_error = event.message;
        })
    }

    /// `surfaceFailed`.
    pub fn surface_failed(&mut self, generation: u64, message: &str) -> SupervisorState {
        if !self.accepts_surface_event(generation) {
            return self.snapshot();
        }
        let message = message.to_string();
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::Failed;
            state.surface_requested = false;
            state.surface_active = false;
            state.transport = LifecycleTransport::None;
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
            state.last_error = Some(message);
        })
    }

    /// `closeWindow`: idempotent.
    pub fn close_window(&mut self) -> SupervisorState {
        if matches!(
            self.state.lifecycle_state,
            LifecycleState::Closed | LifecycleState::Closing
        ) {
            return self.snapshot();
        }
        self.transition(|state| {
            state.lifecycle_state = LifecycleState::Closing;
            state.window_visible = false;
            state.surface_requested = false;
            state.surface_active = false;
            state.transport = LifecycleTransport::None;
            state.backing = LifecycleBacking::Backing(PreviewSurfaceBacking::None);
            state.native_preview_host_kind = None;
        })
    }

    /// `finishClose`: only the closing generation.
    pub fn finish_close(&mut self, generation: u64) -> SupervisorState {
        if generation != self.state.generation
            || self.state.lifecycle_state != LifecycleState::Closing
        {
            return self.snapshot();
        }
        self.state = SupervisorState::closed(generation, (self.now)());
        self.snapshot()
    }

    fn accepts_surface_event(&self, generation: u64) -> bool {
        generation == self.state.generation
            && (self.state.surface_requested
                || (self.state.lifecycle_state == LifecycleState::Failed && self.state.window_open))
            && !matches!(
                self.state.lifecycle_state,
                LifecycleState::Closing
                    | LifecycleState::Closed
                    | LifecycleState::PermissionRequired
            )
    }

    fn accepts_preview_event(&self, generation: u64) -> bool {
        generation == self.state.generation
            && self.state.window_open
            && !matches!(
                self.state.lifecycle_state,
                LifecycleState::Closing
                    | LifecycleState::Closed
                    | LifecycleState::PermissionRequired
            )
    }

    fn transition(&mut self, patch: impl FnOnce(&mut SupervisorState)) -> SupervisorState {
        patch(&mut self.state);
        self.state.updated_at = (self.now)();
        self.snapshot()
    }
}

fn lifecycle_transport_name(transport: LifecycleTransport) -> String {
    match transport.json() {
        Value::String(name) => name,
        other => other.to_string(),
    }
}

fn lifecycle_backing_name(backing: LifecycleBacking) -> String {
    match backing.json() {
        Value::String(name) => name,
        other => other.to_string(),
    }
}

/// `PreviewWindowTargetAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetAction {
    None,
    Open,
    Close,
}

/// `previewWindowTargetAction`: a toggle or an explicit target as one
/// idempotent action.
pub fn target_action(current_open: bool, expected_open: Option<bool>) -> TargetAction {
    let target_open = expected_open.unwrap_or(!current_open);
    if target_open == current_open {
        TargetAction::None
    } else if target_open {
        TargetAction::Open
    } else {
        TargetAction::Close
    }
}

/// `PreviewWindowMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowMode {
    Docked,
    Floating,
}

impl WindowMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowMode::Docked => "docked",
            WindowMode::Floating => "floating",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "docked" => Some(WindowMode::Docked),
            "floating" => Some(WindowMode::Floating),
            _ => None,
        }
    }
}

/// `initialPreviewWindowMode` (plan 213 D5): a saved choice wins; a scripted
/// run or a Mac that ran Videorc before starts floating; a new install starts
/// stuck to the app.
pub fn initial_mode(
    saved: Option<WindowMode>,
    scripted: bool,
    existing_install: bool,
) -> WindowMode {
    match saved {
        Some(mode) => mode,
        None if scripted || existing_install => WindowMode::Floating,
        None => WindowMode::Docked,
    }
}

/// `DockHiddenReason`: why a docked preview is hidden on purpose right now.
/// The Rust app has no renderer slot reports, so `no-slot-report` never
/// occurs. What the slot says for each is `words::dock_hidden` (S3.0h).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockHiddenReason {
    MainWindowFullscreen,
    MainWindowHidden,
    OverlayOpen,
    NoSlotReport,
    SlotUnmounted,
    ScrolledAway,
}

impl DockHiddenReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DockHiddenReason::MainWindowFullscreen => "main-window-fullscreen",
            DockHiddenReason::MainWindowHidden => "main-window-hidden",
            DockHiddenReason::OverlayOpen => "overlay-open",
            DockHiddenReason::NoSlotReport => "no-slot-report",
            DockHiddenReason::SlotUnmounted => "slot-unmounted",
            DockHiddenReason::ScrolledAway => "scrolled-away",
        }
    }
}

/// `decideDockVisibility`'s inputs, in its order of precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DockVisibilityInput {
    pub main_window_visible: bool,
    pub main_window_minimized: bool,
    pub main_window_fullscreen: bool,
    pub overlay_open: bool,
    pub slot_mounted: bool,
    pub slot_in_view: bool,
}

/// `decideDockVisibility`: the first reason that applies, or visible.
pub fn decide_dock_visibility(input: DockVisibilityInput) -> Option<DockHiddenReason> {
    if input.main_window_fullscreen {
        return Some(DockHiddenReason::MainWindowFullscreen);
    }
    if !input.main_window_visible || input.main_window_minimized {
        return Some(DockHiddenReason::MainWindowHidden);
    }
    if input.overlay_open {
        return Some(DockHiddenReason::OverlayOpen);
    }
    if !input.slot_mounted {
        return Some(DockHiddenReason::SlotUnmounted);
    }
    if !input.slot_in_view {
        return Some(DockHiddenReason::ScrolledAway);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supervisor() -> Supervisor {
        let mut tick = 0u32;
        Supervisor::new(
            Platform::Darwin,
            Box::new(move || {
                let stamp = format!("2026-06-19T12:00:00.{tick:03}Z");
                tick += 1;
                stamp
            }),
        )
    }

    fn metal_live(generation: u64) -> SurfaceLiveEvent {
        SurfaceLiveEvent::metal_in_process(generation)
    }

    fn d3d11_live(generation: u64) -> SurfaceLiveEvent {
        SurfaceLiveEvent {
            generation,
            transport: LifecycleTransport::Transport(PreviewTransport::D3d11SharedTexture),
            backing: LifecycleBacking::Backing(PreviewSurfaceBacking::DirectcompositionSwapChain),
            native_preview_host_kind: Some(HostKind::BackendD3d11Presenter),
        }
    }

    #[test]
    fn tracks_the_happy_path_from_closed_window_to_live_native_surface() {
        let mut model = supervisor();
        let closed = model.snapshot();
        assert_eq!(closed.lifecycle_state, LifecycleState::Closed);
        assert_eq!(closed.generation, 0);
        assert!(!closed.window_open && !closed.surface_requested && !closed.surface_active);

        let opening = model.open_window();
        assert_eq!(opening.lifecycle_state, LifecycleState::OpeningWindow);
        assert_eq!(opening.generation, 1);
        assert!(!opening.window_open);

        let open = model.window_opened(true);
        assert_eq!(open.lifecycle_state, LifecycleState::OpenNoSurface);
        assert!(open.window_open && open.window_visible);

        let starting = model.request_surface();
        assert_eq!(starting.lifecycle_state, LifecycleState::StartingSurface);
        assert!(starting.surface_requested && !starting.surface_active);

        let live = model.surface_live(metal_live(1));
        assert_eq!(live.lifecycle_state, LifecycleState::SurfaceLive);
        assert!(live.surface_requested && live.surface_active);
        assert_eq!(
            live.transport,
            LifecycleTransport::Transport(PreviewTransport::NativeSurface)
        );
        assert_eq!(live.permission_status, PermissionStatus::Ok);
        let json = live.to_json();
        assert_eq!(json["transport"], "native-surface");
        assert_eq!(json["backing"], "cametal-layer");
        assert_eq!(json["nativePreviewHostKind"], "in-process");
        assert!(json.get("fallbackReason").is_none());
        assert!(json.get("lastError").is_none());
    }

    #[test]
    fn makes_close_idempotent_and_finishes_only_the_active_generation() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        model.surface_live(metal_live(1));

        let closing = model.close_window();
        assert_eq!(closing.lifecycle_state, LifecycleState::Closing);
        assert_eq!(closing.generation, 1);
        assert!(!closing.window_visible && !closing.surface_requested && !closing.surface_active);
        assert_eq!(closing.transport, LifecycleTransport::None);
        assert_eq!(model.close_window(), closing);

        let closed = model.finish_close(1);
        assert_eq!(closed.lifecycle_state, LifecycleState::Closed);
        assert_eq!(closed.generation, 1);
        assert!(!closed.window_open);
        assert_eq!(model.finish_close(1), closed);
    }

    #[test]
    fn opens_a_fresh_generation_while_an_older_close_is_still_settling() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        model.surface_live(metal_live(1));
        model.close_window();

        let reopened = model.open_window();
        assert_eq!(reopened.lifecycle_state, LifecycleState::OpeningWindow);
        assert_eq!(reopened.generation, 2);
        model.window_opened(true);
        model.request_surface();
        model.surface_live(metal_live(2));

        let after_stale_close = model.finish_close(1);
        assert_eq!(
            after_stale_close.lifecycle_state,
            LifecycleState::SurfaceLive
        );
        assert_eq!(after_stale_close.generation, 2);
        assert!(after_stale_close.window_open && after_stale_close.surface_active);
    }

    #[test]
    fn ignores_stale_surface_callbacks_from_previous_generations() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        model.surface_live(metal_live(1));
        model.close_window();
        model.open_window();
        model.window_opened(true);
        model.request_surface();

        let before = model.snapshot();
        model.surface_fallback(1, "old helper fell back late");
        model.surface_failed(1, "old helper failed late");
        model.surface_live(metal_live(1));
        assert_eq!(model.snapshot(), before);
    }

    #[test]
    fn does_not_let_permission_required_sessions_become_live_from_a_late_callback() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        let permission_required = model.permission_required(PermissionEvent {
            generation: 1,
            permission_status: PermissionStatus::ScreenRecordingRequired,
            message: Some("Screen Recording permission is required.".into()),
        });
        assert_eq!(
            permission_required.lifecycle_state,
            LifecycleState::PermissionRequired
        );
        assert!(!permission_required.surface_requested && !permission_required.surface_active);
        assert_eq!(
            permission_required.permission_status,
            PermissionStatus::ScreenRecordingRequired
        );
        assert_eq!(
            permission_required.last_error.as_deref(),
            Some("Screen Recording permission is required.")
        );
        model.surface_live(metal_live(1));
        assert_eq!(model.snapshot(), permission_required);
    }

    #[test]
    fn accepts_permission_required_while_the_window_is_open_before_surface_start() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        let state = model.permission_required(PermissionEvent {
            generation: 1,
            permission_status: PermissionStatus::ScreenRecordingRequired,
            message: Some("Screen Recording permission is required.".into()),
        });
        assert_eq!(state.lifecycle_state, LifecycleState::PermissionRequired);
        assert!(state.window_open);
    }

    #[test]
    fn marks_fallback_as_explicit_instead_of_native_live() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        let fallback = model.surface_fallback(1, "No Metal IOSurface target was available.");
        assert_eq!(fallback.lifecycle_state, LifecycleState::SurfaceFallback);
        assert!(fallback.surface_requested && !fallback.surface_active);
        // The Rust app has no proof surface: the fallback names no transport.
        assert_eq!(
            fallback.transport,
            LifecycleTransport::Transport(PreviewTransport::Unavailable)
        );
        assert_eq!(
            fallback.fallback_reason.as_deref(),
            Some("No Metal IOSurface target was available.")
        );
        assert_eq!(fallback.to_json()["transport"], "unavailable");
    }

    #[test]
    fn accepts_only_the_complete_d3d11_triple_as_windows_native() {
        let mut model = Supervisor::new(Platform::Win32, Box::new(|| "t".into()));
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        let live = model.surface_live(d3d11_live(1));
        assert_eq!(live.lifecycle_state, LifecycleState::SurfaceLive);
        assert_eq!(
            live.native_preview_host_kind,
            Some(HostKind::BackendD3d11Presenter)
        );
    }

    #[test]
    fn lets_the_d3d11_presenter_claim_a_window_whose_surface_failed_first() {
        let mut model = Supervisor::new(Platform::Win32, Box::new(|| "t".into()));
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        model.surface_failed(
            1,
            "Electron proof preview surface frame polling is enabled.",
        );
        let live = model.surface_live(d3d11_live(1));
        assert_eq!(live.lifecycle_state, LifecycleState::SurfaceLive);
        assert!(live.surface_requested && live.surface_active);
        assert_eq!(live.last_error, None);
    }

    #[test]
    fn keeps_a_failed_surface_failed_once_its_window_is_closing() {
        let mut model = supervisor();
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        model.surface_failed(1, "surface failed");
        let closing = model.close_window();
        model.surface_live(metal_live(1));
        model.surface_fallback(1, "late fallback");
        assert_eq!(model.snapshot(), closing);
    }

    #[test]
    fn fails_crossed_platform_pairs_closed_into_a_named_fallback() {
        let mut model = Supervisor::new(Platform::Win32, Box::new(|| "t".into()));
        model.open_window();
        model.window_opened(true);
        model.request_surface();
        let state = model.surface_live(metal_live(1));
        assert_eq!(state.lifecycle_state, LifecycleState::SurfaceFallback);
        assert!(!state.surface_active);
        assert_eq!(
            state.fallback_reason.as_deref(),
            Some("Preview transport native-surface/cametal-layer is not native on win32.")
        );
    }

    #[test]
    fn classifies_terminal_lifecycle_states() {
        assert!(LifecycleState::Closed.is_terminal());
        assert!(LifecycleState::Failed.is_terminal());
        assert!(LifecycleState::PermissionRequired.is_terminal());
        assert!(!LifecycleState::SurfaceLive.is_terminal());
        assert!(!LifecycleState::Closing.is_terminal());
    }

    #[test]
    fn target_action_turns_an_expected_state_into_an_idempotent_action() {
        assert_eq!(target_action(false, Some(true)), TargetAction::Open);
        assert_eq!(target_action(true, Some(true)), TargetAction::None);
        assert_eq!(target_action(true, Some(false)), TargetAction::Close);
        assert_eq!(target_action(false, Some(false)), TargetAction::None);
        assert_eq!(target_action(false, None), TargetAction::Open);
        assert_eq!(target_action(true, None), TargetAction::Close);
    }

    #[test]
    fn the_clock_prints_iso_8601_utc() {
        assert_eq!(iso_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        // 2026-06-19T12:00:00Z.
        assert_eq!(iso_from_unix(1_781_870_400, 7), "2026-06-19T12:00:00.007Z");
        assert_eq!(iso_from_unix(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_initial_mode_follows_plan_213_d5() {
        assert_eq!(
            initial_mode(Some(WindowMode::Docked), true, true),
            WindowMode::Docked
        );
        assert_eq!(initial_mode(None, true, false), WindowMode::Floating);
        assert_eq!(initial_mode(None, false, true), WindowMode::Floating);
        assert_eq!(initial_mode(None, false, false), WindowMode::Docked);
        assert_eq!(WindowMode::parse("floating"), Some(WindowMode::Floating));
        assert_eq!(WindowMode::parse("stuck"), None);
    }

    #[test]
    fn dock_visibility_names_the_first_reason_in_electrons_order() {
        let shown = DockVisibilityInput {
            main_window_visible: true,
            main_window_minimized: false,
            main_window_fullscreen: false,
            overlay_open: false,
            slot_mounted: true,
            slot_in_view: true,
        };
        assert_eq!(decide_dock_visibility(shown), None);
        assert_eq!(
            decide_dock_visibility(DockVisibilityInput {
                overlay_open: true,
                ..shown
            }),
            Some(DockHiddenReason::OverlayOpen)
        );
        assert_eq!(
            decide_dock_visibility(DockVisibilityInput {
                main_window_minimized: true,
                overlay_open: true,
                ..shown
            }),
            Some(DockHiddenReason::MainWindowHidden)
        );
        assert_eq!(
            decide_dock_visibility(DockVisibilityInput {
                main_window_fullscreen: true,
                main_window_visible: false,
                ..shown
            }),
            Some(DockHiddenReason::MainWindowFullscreen)
        );
        assert_eq!(
            decide_dock_visibility(DockVisibilityInput {
                slot_in_view: false,
                ..shown
            }),
            Some(DockHiddenReason::ScrolledAway)
        );
        assert_eq!(DockHiddenReason::OverlayOpen.as_str(), "overlay-open");
        assert_eq!(
            PermissionStatus::parse("nonsense"),
            PermissionStatus::Unknown
        );
    }
}
