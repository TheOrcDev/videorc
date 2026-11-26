//! The frame feed: the backend's preview surface and the latest-wins lease
//! loop, in the order Electron main and the renderer do it
//! (`native-preview-frame-lease.ts`, `NativePreviewLatestPump`), with the
//! lease policy the S0.2h layer route measured.
//!
//! RPCs and events, in order:
//!
//! 1. Control socket (renderer credential): `backend.ready`, then
//!    `events.setIncluded` keeps `preview.frameReady`, `compositor.status`
//!    and `preview.surface.status`.
//! 2. Lease socket (admin credential: the backend refuses leases to the
//!    renderer role): `backend.ready`, then `events.setIncluded []`.
//! 3. `scene.load_from_capture_config` commits the app's scene; its
//!    revision is the renderer revision the contracts compare against.
//!    S3.1b: the scene is the Studio's ([`SceneFeed`]), committed when the
//!    feed connects and again 250 ms after the Studio's scene changes, and
//!    never while a session holds the scene (`shouldReloadSceneFromCaptureConfig`).
//!    A scene the backend commits on its own (a newer revision, or a new
//!    compositor run: a live source switch, a smoke's direct apply) becomes
//!    the renderer revision too, except while a commit of the feed's own is
//!    on its way (the layout-intent proof Electron waits for), so healing
//!    never overwrites it.
//! 4. `preview.surface.create` with the element's bounds (the one
//!    `PreviewSurfaceBounds`), the target rate and the source; the backend
//!    starts its preview compositor at the bounds' device pixels and
//!    publishes each frame as an IOSurface from a three-slot ring.
//! 5. Every rendered frame arrives as `preview.frameReady`; the newest one
//!    wins (frames that arrived while the loop was busy are skipped, never
//!    queued).
//! 6. For each one: `preview.surface.frame.acquire` on the lease socket
//!    retains that frame's IOSurface, the presenter draws it into the layer
//!    and waits for the GPU, then `preview.surface.frame.release` lets it go.
//!    One lease at a time; the backend releases it if the socket drops.
//! 7. `preview.surface.update_bounds` follows the layer (latest wins, one in
//!    flight) and `preview.surface.present` reports what was presented once
//!    a second, so `preview.surface.status` is truthful (`native-surface` on
//!    a `cametal-layer`, the presented frame id, the cadence).
//! 8. `preview.surface.destroy` on stop.
//!
//! The feed follows the supervisor: it starts when a backend is ready and
//! starts again, with a fresh surface, after a restart or a dropped socket.
//!
//! S2.3c, the texture route: with a [`TextureSink`] set, each leased frame is
//! also imported into the UI's own wgpu device (once per ring slot, as the
//! presenter caches its Metal textures) and handed to the UI thread as a
//! [`TextureFrame`], which binds it to the slot's `Image` and redraws. Both
//! sinks may be on at once (the switch between the routes keeps the old one
//! presenting until the new one has drawn). The texture route releases a
//! frame's lease by the S0.2c.2 "ring" policy: after the UI reports the
//! frame bound and the next `preview.frameReady` arrives (or
//! [`ring_wait`] passes), plus a device wait. That trusts the backend's
//! three-slot ring (slot N is drawn again at N+3) and needs no rendering
//! notifier (`docs/rust-ui/spike-video-comparison.md`).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use videorc_app_core::client::methods::{
    CompositorStatusGet, PreviewSurfaceCreate, PreviewSurfaceDestroy, PreviewSurfaceUpdateBounds,
    SceneLoadFromCaptureConfig,
};
use videorc_app_core::client::{BackendSocket, RpcError};
use videorc_app_core::process::BackendBootstrap;
use videorc_app_core::supervisor::BackendState;
use videorc_app_core::{Level, Logger};
use videorc_protocol::{
    CompositorFrameReady, CompositorStatus, PreviewCpuRingStatus, PreviewSurfaceBounds,
    PreviewSurfaceBoundsParams, PreviewSurfaceCreateParams, PreviewSurfacePresentParams,
    PreviewSurfaceSource, PreviewSurfaceState, PreviewSurfaceStatus, PreviewTransport,
    SceneCommitStatus, SceneConfigParams,
};

use crate::cpu_frames::{CpuFrameSource, CpuRequest, CpuSinks};
#[cfg(target_os = "macos")]
use crate::macos::{ImportOutcome, PresenterClient};
pub use crate::stats::FeedReport;
#[cfg(target_os = "macos")]
use crate::stats::attach_stamps;
use crate::stats::{LayerFrameRecord, LayerRunSummary, Series, percentile};

/// The presenter should answer within this after a frame is handed over
/// (the spike's `BIND_DEADLINE`); a frame that misses it counts as dropped.
/// Its lease is still held until the presenter answers (its GPU work is
/// done) or its thread is gone: elapsed time never lets the backend reuse a
/// surface the presenter may still sample ([`await_layer`]).
const PRESENT_DEADLINE: Duration = Duration::from_millis(250);
/// After a dropped socket or a failed session, before the next try
/// (`ENGINE_RECONNECT_DELAY`).
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// Bounds updates are coalesced to this cadence (Electron's placement
/// writer coalesces the same way).
const BOUNDS_UPDATE_SPACING: Duration = Duration::from_millis(50);
/// `preview.surface.present` cadence.
const PRESENT_REPORT_INTERVAL: Duration = Duration::from_secs(1);
/// The first bounds must arrive from the UI within this; otherwise the
/// surface is created at a default size and resized when they do.
const FIRST_BOUNDS_WAIT: Duration = Duration::from_secs(2);
const COMMIT_WINDOW: usize = 240;
/// S3.1b: the source-to-present latencies `preview.surface.present`
/// reports, over the last this many frames.
const LATENCY_WINDOW: usize = 240;
/// S3.1b: the renderer reloads its scene 250 ms after a change
/// (`SCENE_RELOAD_DELAY`).
const SCENE_RELOAD_DELAY: Duration = videorc_app_core::studio::preview_scene::SCENE_RELOAD_DELAY;
/// S3.1b: how long a fresh connection waits for the Studio's scene (its
/// settings load on the same connection) before it creates the surface on
/// the backend's own scene.
const FIRST_SCENE_WAIT: Duration = Duration::from_secs(5);
/// S2.3c: the texture route caches one import per ring slot, as the presenter does.
#[cfg(target_os = "macos")]
const TEXTURE_IMPORT_CACHE_SIZE: usize = 3;

/// S2.3c: how long the texture route waits for the next `preview.frameReady`
/// before releasing a bound frame's lease anyway (the "ring" policy's bound):
/// three frame periods at the target rate, between 50 and 250 ms, so a
/// static scene never holds a lease for long.
pub fn ring_wait(target_fps: u32) -> Duration {
    let period_ms = 1000.0 / f64::from(target_fps.max(1));
    Duration::from_millis((3.0 * period_ms).clamp(50.0, 250.0) as u64)
}

/// S3.1b: the scene the feed commits. The Studio's request
/// (`videorc_app_core::studio::preview_scene::preview_scene_request`):
/// `Some` while a commit may run, `None` while the scene belongs to a
/// session or nothing has loaded; or one fixed scene (the measurement's
/// pinned canvas).
#[derive(Clone)]
pub struct SceneFeed {
    rx: watch::Receiver<Option<SceneConfigParams>>,
    /// Keeps a fixed scene's sender alive (a closed channel would end the
    /// feed's watch).
    _fixed: Option<Arc<watch::Sender<Option<SceneConfigParams>>>>,
    /// S3.1e: the Studio's scene when the Studio's own layout transaction
    /// already committed it, with that commit's number
    /// (`preview_scene_adopted`): taken as committed once, never committed
    /// again (Electron's one-shot `skipNextConfigSceneReloadRef`).
    adopted: Option<watch::Receiver<Option<(u64, SceneConfigParams)>>>,
    /// S3.1e: told each time the feed committed the Studio's scene, so the
    /// Studio confirms the working scene (`loadScene`'s
    /// `persistWorkingVisual`).
    on_committed: Option<SceneCommitted>,
}

/// S3.1e: told after each commit of the Studio's scene.
pub type SceneCommitted = Arc<dyn Fn(&SceneConfigParams) + Send + Sync>;

impl SceneFeed {
    /// One scene, always allowed (the measurement's test pattern).
    pub fn fixed(params: SceneConfigParams) -> Self {
        let (tx, rx) = watch::channel(Some(params));
        Self {
            rx,
            _fixed: Some(Arc::new(tx)),
            adopted: None,
            on_committed: None,
        }
    }

    /// The Studio's scene as it changes.
    pub fn following(rx: watch::Receiver<Option<SceneConfigParams>>) -> Self {
        Self {
            rx,
            _fixed: None,
            adopted: None,
            on_committed: None,
        }
    }

    /// S3.1e: the scene the Studio's transaction committed, adopted when
    /// it is the request.
    pub fn with_adopted(
        mut self,
        adopted: watch::Receiver<Option<(u64, SceneConfigParams)>>,
    ) -> Self {
        self.adopted = Some(adopted);
        self
    }

    /// S3.1e: told after each commit of the Studio's scene.
    pub fn on_committed(mut self, hook: SceneCommitted) -> Self {
        self.on_committed = Some(hook);
        self
    }

    /// The adopted scene now.
    fn adopted_now(&self) -> Option<(u64, SceneConfigParams)> {
        self.adopted.as_ref().and_then(|rx| rx.borrow().clone())
    }

    /// The request now.
    pub fn current(&self) -> Option<SceneConfigParams> {
        self.rx.borrow().clone()
    }
}

/// Plan 220 S4.1d: where the feed's frames come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSource {
    /// The backend's IOSurface, leased per `preview.frameReady` (macOS).
    NativeLease,
    /// Whole BGRA frames in the backend's shared-memory ring
    /// (`preview.cpu.open`; Windows and Linux).
    CpuRing,
}

impl FrameSource {
    /// The platform's own: the IOSurface lease on macOS, the ring elsewhere.
    pub const fn platform_default() -> Self {
        if cfg!(target_os = "macos") {
            Self::NativeLease
        } else {
            Self::CpuRing
        }
    }
}

/// The status words of the CPU route (the backend's `preview.surface.status`
/// message, Health, the slot): the platform's CPU preview, never a native
/// surface (plan 220 PF3).
pub const fn cpu_route_words() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows CPU preview: frames over shared memory, drawn by the app (CPU composition, not a native surface)."
    } else {
        "Linux CPU preview: frames over shared memory, drawn by the app (CPU composition, not a native surface)."
    }
}

/// Plan 220 S4.2c: the words for the backing that shows the CPU frames,
/// and the named reason when the surface route is the fallback.
pub fn cpu_route_message(
    backing: videorc_protocol::PreviewSurfaceBacking,
    fallback_reason: Option<&str>,
) -> String {
    use videorc_protocol::PreviewSurfaceBacking as Backing;
    let base = match backing {
        Backing::WlShmSubsurface => {
            "Linux CPU preview: frames over shared memory on a Wayland subsurface (wl_shm over the ring; CPU composition, not a native GPU surface)."
        }
        Backing::X11ShmChildWindow => {
            "Linux CPU preview: frames over shared memory in an X11 child window (MIT-SHM over the ring; CPU composition, not a native GPU surface)."
        }
        _ => cpu_route_words(),
    };
    match fallback_reason {
        Some(reason)
            if !matches!(
                backing,
                Backing::WlShmSubsurface | Backing::X11ShmChildWindow
            ) =>
        {
            format!("{base} Texture route fallback: {reason}")
        }
        _ => base.to_string(),
    }
}

/// What the feed is told to show.
#[derive(Clone)]
pub struct FeedConfig {
    /// Plan 220 S4.1d: where the frames come from.
    pub frame_source: FrameSource,
    /// The scene the app commits (`scene.load_from_capture_config`).
    pub scene: SceneFeed,
    /// What the surface says it shows (Electron derives it from the capture
    /// config: window, screen, camera, else synthetic).
    pub source: PreviewSurfaceSource,
    pub target_fps: u32,
    /// Keep every frame's timings for a report (the measurement).
    pub record_stats: bool,
    pub logger: Logger,
}

/// S2.3c: the texture route's sink. The feed imports each leased frame into
/// `device` (the UI's own wgpu device, the one Slint renders with) and calls
/// `deliver` with the imported texture; the UI thread binds it and answers
/// through the frame's `bound` sender.
#[derive(Clone)]
pub struct TextureSink {
    pub device: wgpu::Device,
    /// S4.1d: the CPU route uploads each frame with `Queue::write_texture`.
    pub queue: wgpu::Queue,
    pub deliver: Arc<dyn Fn(TextureFrame) + Send + Sync>,
}

/// One frame on the texture route, on its way to the UI thread.
pub struct TextureFrame {
    pub frame_id: u64,
    pub iosurface_id: u32,
    pub width: u32,
    pub height: u32,
    /// The IOSurface imported on the sink's device (BGRA8, zero copy; cached
    /// per ring slot, so the same texture comes back for the same slot).
    pub texture: wgpu::Texture,
    /// The UI thread fires this once the frame is bound to the slot's
    /// `Image` and a redraw is requested; the lease is released after it and
    /// the ring wait. Dropping it counts the frame as dropped.
    pub bound: oneshot::Sender<Instant>,
}

/// The feed's orders.
pub enum FeedCommand {
    /// The layer moved or the window did: the surface's bounds follow.
    Bounds(PreviewSurfaceBounds),
    /// The presenter to draw into (`None` while the native path is down, or
    /// while the texture route alone shows the preview).
    #[cfg(target_os = "macos")]
    Presenter(Option<PresenterClient>),
    /// S2.3c: the texture route's sink (`None` turns the route off and drops
    /// its imports).
    TextureSink(Option<TextureSink>),
    /// Plan 220 S4.2c: the Linux presenter the CPU ring's frames go to
    /// (`None` while the surface route is off or its child is detached).
    #[cfg(target_os = "linux")]
    CpuPresenter(Option<crate::linux::PresenterClient>),
    /// Plan 220 S4.2c: why the surface route is not the one showing (the
    /// status names the texture route as the fallback with this reason);
    /// `None` clears it.
    CpuFallbackReason(Option<String>),
    /// `present-kick`: the freshest frame through the normal path again.
    Kick,
    /// `resync-scene`: commit the Studio's scene again; while a session
    /// holds the scene, take the backend's committed one as the app's
    /// (Electron's renderer presents committed compositor truth again).
    ResyncScene,
    /// S3.1b: commit the Studio's scene now (Retry preview, the scene
    /// exercise); the answer is the committed revision, or why not.
    CommitScene(oneshot::Sender<Result<u64, String>>),
    /// S3.1b: the smokes' suspend (true) destroys the surface and presents
    /// nothing until the resume (false) creates it again.
    Suspend(bool),
    /// The Preview is closed (true): the same as the smokes' suspend, for
    /// its own reason, so neither one's resume undoes the other's. Electron
    /// destroys its native host when the Preview closes, so a closed Preview
    /// draws nothing and the backend renders no preview frames; opening it
    /// (false) creates the surface again and the first-frame contract starts
    /// from the top.
    Park(bool),
    /// S3.1b: take the backend's native host commands
    /// (`preview.surface.take_native_host_commands`): the element places
    /// its own layer, so they are read, logged and dropped.
    DrainHostCommands(oneshot::Sender<Result<Vec<Value>, String>>),
    /// S3.1b: the compositor's status now (`compositor.status`), which also
    /// refreshes [`Telemetry::scene`].
    ReadCompositorStatus(oneshot::Sender<Result<CompositorStatus, String>>),
    /// `reset-native-path`'s surface half: destroy and create the surface.
    RecreateSurface,
    /// The run's numbers so far.
    Report(oneshot::Sender<FeedReport>),
    /// Release, destroy, close.
    Stop,
}

/// What the contracts' watchdog and the UI read each tick.
#[derive(Debug, Clone, Default)]
pub struct Telemetry {
    /// Both sockets are open.
    pub connected: bool,
    /// A sink is attached: the layer's presenter, the texture route's sink,
    /// or both (the contracts' "native presenting").
    pub presenter_attached: bool,
    /// S2.3c: frames the layer's presenter committed (the texture route's
    /// frames count in `presented` too; the route switch waits on this one).
    pub layer_presented: u64,
    /// S2.3c: frames bound on the texture route.
    pub texture_frames: u64,
    /// S2.3c: the texture route's sink is set.
    pub texture_route: bool,
    /// `preview.surface.status` says `live`.
    pub surface_live: bool,
    pub surface_message: Option<String>,
    /// What the backend's status says it presents (`native-surface` on a
    /// `cametal-layer` once the first present report lands; the backend
    /// labels a fresh synthetic surface as Electron's proof surface until
    /// then).
    pub surface_transport: Option<PreviewTransport>,
    pub surface_backing: Option<videorc_protocol::PreviewSurfaceBacking>,
    pub renderer_scene_revision: Option<u64>,
    pub compositor_scene_revision: Option<u64>,
    pub compositor_frame_scene_revision: Option<u64>,
    /// The latest frame carried a frame target: an IOSurface id on the
    /// native route, the mapped ring on the CPU route (S4.1d).
    pub metal_target_present: bool,
    /// S4.1d: the feed reads CPU frames over shared memory.
    pub cpu_route: bool,
    /// S4.1d: the CPU ring is mapped and read.
    pub cpu_ring_open: bool,
    pub cpu_ring_generation: u64,
    /// S4.1d: the compositor sequence of the frame presented last.
    pub cpu_last_source_sequence: Option<u64>,
    /// S4.1d: the last frame's upload to the UI's bind, ms.
    pub cpu_upload_to_bind_ms: f64,
    /// S4.2c: what shows the CPU frames now (the presenter's surface, or
    /// Slint's image); `None` before the reader has a sink.
    pub cpu_backing: Option<videorc_protocol::PreviewSurfaceBacking>,
    /// S4.2c: the presenter's commit-to-release time of the last frame
    /// (`None` when the server had not released it within the wait).
    pub cpu_present_to_release_ms: Option<f64>,
    /// S4.2c: why the surface route is not showing, when the texture route
    /// is the fallback.
    pub cpu_fallback_reason: Option<String>,
    /// The compositor's `framesRendered` on the latest `preview.frameReady`.
    pub frames_rendered: u64,
    /// The last frame id the presenter committed to the layer.
    pub presented_frame_id: u64,
    /// Frames presented since the feed started.
    pub presented: u64,
    /// `preview.frameReady` events not leased (latest wins).
    pub skipped: u64,
    /// Acquires the backend answered `null` to: it had moved past that
    /// frame's run or scene revision (normal at start-up and on a scene
    /// change).
    pub refused: u64,
    /// Presents that failed or timed out.
    pub dropped: u64,
    /// The surface's frame size.
    pub frame_width: u32,
    pub frame_height: u32,
    pub last_error: Option<String>,
    /// When the presenter last committed a frame (S2.3b: the placement
    /// authority decays without presents, as Electron's does).
    pub last_commit_at: Option<Instant>,
    commits: VecDeque<Instant>,
    /// S3.1b: a scene commit of the feed's own is on its way: the backend's
    /// scenes are not taken as the app's meanwhile.
    pub scene_commit_in_flight: bool,
    /// S3.1b: the compositor run the app's scene revision belongs to.
    pub scene_run_id: Option<String>,
    /// S3.1b: the scene revision of the frame presented last.
    pub presented_scene_revision: Option<u64>,
    /// S3.1b: the scene as the compositor last reported it.
    pub scene: Option<SceneState>,
    /// S3.1b: the feed's own commits, and the backend's scenes it took.
    pub scene_commits: u64,
    pub scene_adoptions: u64,
    /// S3.1b: the feed's last commit, and when its revision reached the
    /// screen (the proof).
    pub last_scene_commit: Option<SceneCommitRecord>,
    /// S3.1b: the smokes' suspend holds the surface down.
    pub suspended: bool,
    /// The Preview is closed: the surface is down until it opens
    /// ([`FeedCommand::Park`]).
    pub parked: bool,
    /// The host hid the video on purpose (its page is away, or a dialog is
    /// over the slot): the watchdog doesn't judge it until it shows again.
    /// The surface stays up, unlike [`Self::parked`].
    pub hidden_by_host: bool,
    /// S3.1b: the backend's native host commands the feed took.
    pub host_commands_taken: u64,
    /// S3.1b: the backend's latest `preview.surface.status`.
    pub backend_status: Option<PreviewSurfaceStatus>,
    /// S3.1b: source-to-present latency per presented frame, ms.
    latencies: VecDeque<f64>,
    /// S3.1b: a measurement in progress (`measure-native-preview-surface`).
    measurement: Option<Measurement>,
}

/// S3.1b: the scene the compositor reports (`compositor.status`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SceneState {
    pub revision: Option<u64>,
    pub frame_revision: Option<u64>,
    pub run_id: Option<String>,
    /// The layout preset's wire name (`screen-camera`, …).
    pub layout_preset: Option<String>,
    /// The layout's camera shape (`rectangle`, `circle`, …).
    pub camera_shape: Option<String>,
    pub sources: Vec<SceneSourceState>,
}

/// One source of [`SceneState`].
#[derive(Debug, Clone, PartialEq)]
pub struct SceneSourceState {
    pub id: String,
    pub kind: String,
    pub visible: bool,
    pub shape: Option<String>,
    pub transform: (f64, f64, f64, f64),
}

impl SceneState {
    pub fn of(status: &CompositorStatus) -> Self {
        let text = |value: Value| value.as_str().map(str::to_string);
        Self {
            revision: status.scene_revision,
            frame_revision: status.frame_scene_revision,
            run_id: status.run_id.clone(),
            layout_preset: status
                .scene_layout
                .as_ref()
                .and_then(|layout| text(serde_json::to_value(&layout.layout_preset).ok()?)),
            camera_shape: status
                .scene_layout
                .as_ref()
                .and_then(|layout| text(serde_json::to_value(&layout.camera_shape).ok()?)),
            sources: status
                .scene_sources
                .iter()
                .map(|source| SceneSourceState {
                    id: source.id.clone(),
                    kind: serde_json::to_value(&source.kind)
                        .ok()
                        .and_then(text)
                        .unwrap_or_default(),
                    visible: source.visible,
                    shape: source
                        .shape
                        .as_ref()
                        .and_then(|shape| text(serde_json::to_value(shape).ok()?)),
                    transform: (
                        source.transform.x,
                        source.transform.y,
                        source.transform.width,
                        source.transform.height,
                    ),
                })
                .collect(),
        }
    }
}

/// S3.1b: the feed's last scene commit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneCommitRecord {
    pub revision: u64,
    pub at: Instant,
    /// When a frame of that revision (or a later one) was first presented.
    pub on_screen_at: Option<Instant>,
}

impl SceneCommitRecord {
    /// Commit to the first frame of it on screen, ms.
    pub fn latency_ms(&self) -> Option<f64> {
        self.on_screen_at
            .map(|at| at.saturating_duration_since(self.at).as_secs_f64() * 1000.0)
    }
}

/// S3.1b: what a measurement window collects.
#[derive(Debug, Clone)]
struct Measurement {
    started_at: Instant,
    commits: Vec<Instant>,
    latencies: Vec<f64>,
    dropped_before: u64,
    skipped_before: u64,
    presented_before: u64,
    frames_rendered_before: u64,
}

/// S3.1b: one measurement window (`measure-native-preview-surface`,
/// `measure-preview-motion`): what the element presented in it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MeasureReport {
    pub seconds: f64,
    pub presented: u64,
    pub measured_fps: Option<f64>,
    pub interval: Series,
    pub interval_jitter_p95_ms: Option<f64>,
    pub input_to_present: Series,
    pub input_to_present_last_ms: Option<f64>,
    pub dropped: u64,
    pub skipped: u64,
    pub frames_rendered: u64,
    pub compositor_frame_lag: u64,
    pub presented_frame_id: u64,
    pub source_pixels_present: bool,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl Telemetry {
    pub(crate) fn note_commit(&mut self, at: Instant) {
        self.last_commit_at = Some(at);
        if self.commits.len() >= COMMIT_WINDOW {
            self.commits.pop_front();
        }
        self.commits.push_back(at);
        if let Some(measurement) = self.measurement.as_mut() {
            measurement.commits.push(at);
        }
    }

    /// S3.1b: one presented frame's source-to-present latency.
    pub(crate) fn note_latency(&mut self, ms: f64) {
        if self.latencies.len() >= LATENCY_WINDOW {
            self.latencies.pop_front();
        }
        self.latencies.push_back(ms);
        if let Some(measurement) = self.measurement.as_mut() {
            measurement.latencies.push(ms);
        }
    }

    /// S3.1b: a scene the backend reports (`preview.frameReady` or
    /// `compositor.status`) becomes the app's scene revision when it is
    /// newer, or of another compositor run (a session's compositor, a
    /// restart), unless a commit of the feed's own is on its way. True when
    /// it was taken.
    pub fn note_backend_scene(&mut self, run_id: Option<&str>, revision: Option<u64>) -> bool {
        let Some(revision) = revision else {
            return false;
        };
        if self.scene_commit_in_flight {
            return false;
        }
        let newer = self
            .renderer_scene_revision
            .is_none_or(|current| revision > current);
        let run_changed = run_id.is_some()
            && self.scene_run_id.is_some()
            && self.scene_run_id.as_deref() != run_id;
        if !newer && !run_changed {
            return false;
        }
        if self.renderer_scene_revision == Some(revision) {
            self.scene_run_id = run_id.map(str::to_string);
            return false;
        }
        self.renderer_scene_revision = Some(revision);
        if run_id.is_some() {
            self.scene_run_id = run_id.map(str::to_string);
        }
        self.scene_adoptions += 1;
        true
    }

    /// S3.1b: the feed's own commit landed: its revision is the app's.
    pub fn note_scene_commit(&mut self, commit: &SceneCommitStatus, at: Instant) {
        self.renderer_scene_revision = Some(commit.scene_revision);
        self.compositor_scene_revision = commit.compositor_status.scene_revision;
        self.compositor_frame_scene_revision = commit.compositor_status.frame_scene_revision;
        if commit.compositor_status.run_id.is_some() {
            self.scene_run_id = commit.compositor_status.run_id.clone();
        }
        self.scene = Some(SceneState::of(&commit.compositor_status));
        self.scene_commits += 1;
        self.last_scene_commit = Some(SceneCommitRecord {
            revision: commit.scene_revision,
            at,
            on_screen_at: None,
        });
    }

    /// S3.1b: starts a measurement window.
    pub fn start_measurement(&mut self) {
        self.measurement = Some(Measurement {
            started_at: Instant::now(),
            commits: Vec::new(),
            latencies: Vec::new(),
            dropped_before: self.dropped,
            skipped_before: self.skipped,
            presented_before: self.presented,
            frames_rendered_before: self.frames_rendered,
        });
    }

    /// S3.1b: ends the window and says what it held.
    pub fn finish_measurement(&mut self) -> MeasureReport {
        let Some(measurement) = self.measurement.take() else {
            return MeasureReport::default();
        };
        let seconds = measurement.started_at.elapsed().as_secs_f64();
        let intervals: Vec<f64> = measurement
            .commits
            .iter()
            .zip(measurement.commits.iter().skip(1))
            .map(|(a, b)| b.duration_since(*a).as_secs_f64() * 1000.0)
            .collect();
        let measured_fps = match (measurement.commits.first(), measurement.commits.last()) {
            (Some(first), Some(last)) if measurement.commits.len() > 1 => {
                let span = last.duration_since(*first).as_secs_f64();
                (span > 0.0).then(|| (measurement.commits.len() - 1) as f64 / span)
            }
            _ => None,
        };
        let mean =
            (!intervals.is_empty()).then(|| intervals.iter().sum::<f64>() / intervals.len() as f64);
        let jitters: Vec<f64> = mean
            .map(|mean| intervals.iter().map(|value| (value - mean).abs()).collect())
            .unwrap_or_default();
        MeasureReport {
            seconds,
            presented: self.presented.saturating_sub(measurement.presented_before),
            measured_fps,
            interval: Series::of(&intervals),
            interval_jitter_p95_ms: percentile(&jitters, 95.0),
            input_to_present: Series::of(&measurement.latencies),
            input_to_present_last_ms: measurement.latencies.last().copied(),
            dropped: self.dropped.saturating_sub(measurement.dropped_before),
            skipped: self.skipped.saturating_sub(measurement.skipped_before),
            frames_rendered: self
                .frames_rendered
                .saturating_sub(measurement.frames_rendered_before),
            compositor_frame_lag: self.frames_rendered.saturating_sub(self.presented_frame_id),
            presented_frame_id: self.presented_frame_id,
            source_pixels_present: self.presented > 0,
            frame_width: self.frame_width,
            frame_height: self.frame_height,
        }
    }

    /// S3.1b: the source-to-present latencies over the last frames.
    pub fn input_to_present(&self) -> Series {
        let values: Vec<f64> = self.latencies.iter().copied().collect();
        Series::of(&values)
    }

    fn intervals_ms(&self) -> Vec<f64> {
        self.commits
            .iter()
            .zip(self.commits.iter().skip(1))
            .map(|(a, b)| b.duration_since(*a).as_secs_f64() * 1000.0)
            .collect()
    }

    /// Frames per second over the last commits.
    pub fn present_fps(&self) -> Option<f64> {
        let (first, last) = (self.commits.front()?, self.commits.back()?);
        let span = last.duration_since(*first).as_secs_f64();
        (span > 0.0 && self.commits.len() > 1).then(|| (self.commits.len() - 1) as f64 / span)
    }

    pub fn commit_interval(&self) -> Series {
        Series::of(&self.intervals_ms())
    }

    /// `preview.surface.present`'s params from the telemetry.
    pub fn present_params(&self) -> PreviewSurfacePresentParams {
        let interval = self.commit_interval();
        let latency = self.input_to_present();
        let whole = |value: Option<f64>| value.map(|ms| ms.round().max(0.0) as u64);
        let (transport, backing, message) = if self.cpu_route {
            let backing = self
                .cpu_backing
                .unwrap_or(videorc_protocol::PreviewSurfaceBacking::GpuiImage);
            (
                PreviewTransport::CpuSharedMemory,
                backing,
                Some(cpu_route_message(
                    backing,
                    self.cpu_fallback_reason.as_deref(),
                )),
            )
        } else {
            (
                PreviewTransport::NativeSurface,
                videorc_protocol::PreviewSurfaceBacking::CaMetalLayer,
                None,
            )
        };
        PreviewSurfacePresentParams {
            transport: Some(transport),
            backing: Some(backing),
            presented_frame_id: (self.presented_frame_id > 0).then_some(self.presented_frame_id),
            compositor_frame_lag: Some(
                self.frames_rendered.saturating_sub(self.presented_frame_id),
            ),
            dropped_frames: self.dropped,
            // S3.1b: source to present (the frame's age at the lease, plus
            // the lease to the commit), as main's pump reports it.
            input_to_present_latency_ms: whole(self.latencies.back().copied()),
            input_to_present_latency_p50_ms: whole(latency.p50),
            input_to_present_latency_p95_ms: whole(latency.p95),
            input_to_present_latency_p99_ms: whole(latency.p99),
            present_fps: self.present_fps(),
            interval_p95_ms: interval.p95,
            interval_p99_ms: interval.p99,
            native_preview_main_scene_mismatch_count: None,
            native_preview_main_scene_mismatch_age_ms: None,
            native_preview_main_last_skipped_scene_revision: None,
            native_preview_main_last_skipped_frame_scene_revision: None,
            native_preview_iosurface_import_live_count: None,
            native_preview_iosurface_import_peak_count: None,
            native_preview_iosurface_import_ceiling: Some(3),
            message,
            frame_polling_suppressed: false,
            source_pixels_present: self.presented > 0,
        }
    }
}

/// The feed's handle: its orders go in, its telemetry comes out.
pub struct Feed {
    commands: mpsc::UnboundedSender<FeedCommand>,
    telemetry: Arc<Mutex<Telemetry>>,
    task: Option<JoinHandle<()>>,
}

impl Feed {
    /// Starts the feed on `handle`; it waits for the supervisor's backend.
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        config: FeedConfig,
        #[cfg(target_os = "macos")] presenter: Option<PresenterClient>,
    ) -> Self {
        let (commands, inbox) = mpsc::unbounded_channel();
        #[cfg(target_os = "macos")]
        let presenter_attached = presenter.is_some();
        #[cfg(not(target_os = "macos"))]
        let presenter_attached = false;
        let telemetry = Arc::new(Mutex::new(Telemetry {
            presenter_attached,
            cpu_route: config.frame_source == FrameSource::CpuRing,
            ..Telemetry::default()
        }));
        let task = handle.spawn(run(
            state,
            config,
            inbox,
            telemetry.clone(),
            #[cfg(target_os = "macos")]
            presenter,
        ));
        Self {
            commands,
            telemetry,
            task: Some(task),
        }
    }

    pub fn send(&self, command: FeedCommand) {
        let _ = self.commands.send(command);
    }

    /// The order channel, for the watchdog.
    pub fn sender(&self) -> mpsc::UnboundedSender<FeedCommand> {
        self.commands.clone()
    }

    /// The telemetry itself, for the watchdog's ticks.
    pub fn telemetry_handle(&self) -> Arc<Mutex<Telemetry>> {
        self.telemetry.clone()
    }

    pub fn telemetry(&self) -> Telemetry {
        self.telemetry.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// Asks for the report; `None` when the feed is gone.
    pub async fn report(&self) -> Option<FeedReport> {
        let (tx, rx) = oneshot::channel();
        self.send(FeedCommand::Report(tx));
        rx.await.ok()
    }

    /// Stops the feed: the lease is released, the surface destroyed, the
    /// sockets closed. Waits for it.
    pub async fn stop(mut self) {
        self.send(FeedCommand::Stop);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
        }
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        let _ = self.commands.send(FeedCommand::Stop);
    }
}

/// What ended a session.
enum Exit {
    Stop,
    Disconnected(String),
}

/// What carries from one session to the next (and waits for the first).
struct Carried {
    bounds: Option<PreviewSurfaceBounds>,
    /// S3.1b: the smokes' suspend outlives a reconnect.
    suspended: bool,
    /// A closed Preview's park outlives a reconnect too.
    parked: bool,
    #[cfg(target_os = "macos")]
    presenter: Option<PresenterClient>,
    /// S4.2c: the Linux presenter the CPU frames go to.
    #[cfg(target_os = "linux")]
    cpu_presenter: Option<crate::linux::PresenterClient>,
    /// S2.3c: the texture route's sink and its per-ring-slot imports.
    texture: Option<TextureSink>,
    #[cfg(target_os = "macos")]
    imports: Vec<TextureImport>,
    stats: Stats,
}

/// One IOSurface imported on the texture sink's device.
#[cfg(target_os = "macos")]
struct TextureImport {
    iosurface_id: u32,
    width: u32,
    height: u32,
    texture: wgpu::Texture,
}

async fn run(
    mut state: watch::Receiver<BackendState>,
    config: FeedConfig,
    mut commands: mpsc::UnboundedReceiver<FeedCommand>,
    telemetry: Arc<Mutex<Telemetry>>,
    #[cfg(target_os = "macos")] presenter: Option<PresenterClient>,
) {
    let mut carried = Carried {
        bounds: None,
        suspended: false,
        parked: false,
        #[cfg(target_os = "macos")]
        presenter,
        #[cfg(target_os = "linux")]
        cpu_presenter: None,
        texture: None,
        #[cfg(target_os = "macos")]
        imports: Vec::new(),
        stats: Stats::new(config.record_stats),
    };
    loop {
        // Wait for a ready backend, answering the orders that need no backend.
        let bootstrap = loop {
            if let Some(bootstrap) = state.borrow_and_update().bootstrap().cloned() {
                break bootstrap;
            }
            tokio::select! {
                changed = state.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                command = commands.recv() => match command {
                    Some(FeedCommand::Stop) | None => return,
                    Some(command) => carried.idle_command(command, &telemetry),
                }
            }
        };
        let generation_state = state.clone();
        let exit = session(
            &bootstrap,
            &config,
            &mut commands,
            &telemetry,
            &mut carried,
            generation_state,
        )
        .await;
        if let Ok(mut t) = telemetry.lock() {
            t.connected = false;
            t.surface_live = false;
        }
        match exit {
            Ok(Exit::Stop) => return,
            Ok(Exit::Disconnected(reason)) => {
                config.logger.log(
                    Level::Warn,
                    &format!("[preview] feed disconnected: {reason}"),
                );
            }
            Err(error) => {
                config
                    .logger
                    .log(Level::Error, &format!("[preview] feed failed: {error:#}"));
                if let Ok(mut t) = telemetry.lock() {
                    t.last_error = Some(format!("{error:#}"));
                }
            }
        }
        // Wait out the retry delay, still answering orders.
        let retry = tokio::time::sleep(RETRY_DELAY);
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                changed = state.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    break;
                }
                command = commands.recv() => match command {
                    Some(FeedCommand::Stop) | None => return,
                    Some(command) => carried.idle_command(command, &telemetry),
                }
            }
        }
    }
}

impl Carried {
    #[cfg(target_os = "macos")]
    fn has_presenter(&self) -> bool {
        self.presenter.is_some()
    }

    #[cfg(target_os = "linux")]
    fn has_presenter(&self) -> bool {
        self.cpu_presenter.is_some()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn has_presenter(&self) -> bool {
        false
    }

    /// S4.1d, S4.2c: the sinks the CPU ring's reader feeds.
    fn cpu_sinks(&self) -> CpuSinks {
        CpuSinks {
            texture: self.texture.clone(),
            #[cfg(target_os = "linux")]
            presenter: self.cpu_presenter.clone(),
        }
    }

    fn note_sinks(&self, telemetry: &Arc<Mutex<Telemetry>>) {
        if let Ok(mut t) = telemetry.lock() {
            t.presenter_attached = self.has_presenter() || self.texture.is_some();
            t.texture_route = self.texture.is_some();
        }
    }

    /// The texture for this frame's IOSurface on the sink's device, imported
    /// when the cache has none (entries of another size are dropped, as the
    /// presenter drops its own).
    #[cfg(not(target_os = "macos"))]
    fn texture_for(
        &mut self,
        _sink: &TextureSink,
        _leased: &Leased,
    ) -> Result<wgpu::Texture, String> {
        Err(
            "IOSurface import is macOS-only; this platform's frames come from the CPU ring"
                .to_string(),
        )
    }

    #[cfg(target_os = "macos")]
    fn texture_for(
        &mut self,
        sink: &TextureSink,
        leased: &Leased,
    ) -> Result<wgpu::Texture, String> {
        if let Some(import) = self.imports.iter().find(|import| {
            import.iosurface_id == leased.iosurface_id
                && import.width == leased.width
                && import.height == leased.height
        }) {
            return Ok(import.texture.clone());
        }
        let texture = videorc_gpu_import::import_iosurface(
            &sink.device,
            leased.iosurface_id,
            leased.width,
            leased.height,
            wgpu::TextureFormat::Bgra8Unorm,
        )
        .map_err(|error| error.to_string())?;
        self.imports
            .retain(|import| import.width == leased.width && import.height == leased.height);
        if self.imports.len() >= TEXTURE_IMPORT_CACHE_SIZE {
            self.imports.remove(0);
        }
        self.imports.push(TextureImport {
            iosurface_id: leased.iosurface_id,
            width: leased.width,
            height: leased.height,
            texture: texture.clone(),
        });
        Ok(texture)
    }

    /// The surface is held down: the smokes' suspend or a closed Preview.
    fn held(&self) -> bool {
        self.suspended || self.parked
    }

    /// Why the surface is held down, for the log.
    fn held_why(&self) -> &'static str {
        match (self.suspended, self.parked) {
            (true, _) => "suspended",
            (false, true) => "parked (the Preview is closed)",
            (false, false) => "held",
        }
    }

    /// What brings it back, for the log.
    fn held_until(&self) -> &'static str {
        match (self.suspended, self.parked) {
            (true, true) => "the resume and the Preview opening",
            (true, false) => "the resume",
            (false, _) => "the Preview opens",
        }
    }

    fn idle_command(&mut self, command: FeedCommand, telemetry: &Arc<Mutex<Telemetry>>) {
        match command {
            FeedCommand::Bounds(bounds) => self.bounds = Some(bounds),
            #[cfg(target_os = "macos")]
            FeedCommand::Presenter(presenter) => {
                self.presenter = presenter;
                self.note_sinks(telemetry);
            }
            FeedCommand::TextureSink(sink) => {
                #[cfg(target_os = "macos")]
                if sink.is_none() {
                    // The imports keep their IOSurfaces retained: let them go.
                    self.imports.clear();
                }
                self.texture = sink;
                self.note_sinks(telemetry);
            }
            #[cfg(target_os = "linux")]
            FeedCommand::CpuPresenter(presenter) => {
                self.cpu_presenter = presenter;
                self.note_sinks(telemetry);
            }
            FeedCommand::CpuFallbackReason(reason) => {
                if let Ok(mut t) = telemetry.lock() {
                    t.cpu_fallback_reason = reason;
                }
            }
            FeedCommand::Report(reply) => {
                #[cfg(target_os = "macos")]
                let presenter = self.presenter.as_ref();
                #[cfg(not(target_os = "macos"))]
                let presenter = None;
                let _ = reply.send(self.stats.report(
                    presenter,
                    &telemetry.lock().map(|t| t.clone()).unwrap_or_default(),
                ));
            }
            FeedCommand::Kick | FeedCommand::ResyncScene | FeedCommand::RecreateSurface => {}
            FeedCommand::CommitScene(reply) => {
                let _ = reply.send(Err(NOT_CONNECTED.to_string()));
            }
            FeedCommand::DrainHostCommands(reply) => {
                let _ = reply.send(Err(NOT_CONNECTED.to_string()));
            }
            FeedCommand::ReadCompositorStatus(reply) => {
                let _ = reply.send(Err(NOT_CONNECTED.to_string()));
            }
            FeedCommand::Suspend(on) => {
                self.suspended = on;
                if let Ok(mut t) = telemetry.lock() {
                    t.suspended = on;
                }
            }
            FeedCommand::Park(on) => {
                self.parked = on;
                if let Ok(mut t) = telemetry.lock() {
                    t.parked = on;
                }
            }
            FeedCommand::Stop => {}
        }
    }
}

/// What the scene and drain orders answer while no engine is connected.
const NOT_CONNECTED: &str = "The preview is not connected to Videorc's engine.";

/// One `preview.frameReady`.
#[derive(Debug, Clone)]
struct FrameReady {
    frame: CompositorFrameReady,
    received_at: Instant,
}

/// The lease socket and its one outstanding lease.
struct Lease {
    socket: BackendSocket,
    outstanding: Option<String>,
    /// This side closed the socket to free a lease whose outcome was lost
    /// (the socket's own state may not say so until its reader ends).
    abandoned: bool,
}

impl Lease {
    /// Retains `ready`'s frame. `Ok(None)`: the backend had no frame for that
    /// run and scene revision (it moved on).
    async fn acquire(&mut self, ready: &CompositorFrameReady) -> Result<Option<Leased>> {
        if let Some(id) = &self.outstanding {
            bail!("lease {id} is still outstanding");
        }
        let lease_id = uuid::Uuid::new_v4().to_string();
        let mut params = json!({ "leaseId": lease_id });
        params["runId"] = json!(ready.run_id.clone().unwrap_or_default());
        if let Some(revision) = ready.scene_revision {
            params["sceneRevision"] = json!(revision);
        }
        // The id is outstanding from the moment the request goes out: when
        // its answer is lost (the reply missed its deadline), the backend may
        // hold the lease on this socket, and only a release by id (or the
        // socket closing) frees it. Forgetting it would leave every later
        // acquire busy.
        self.outstanding = Some(lease_id.clone());
        let payload = match self
            .socket
            .request("preview.surface.frame.acquire", params)
            .await
        {
            Ok(payload) => payload,
            Err(error) => {
                if error.is_outcome_unknown() {
                    self.give_back_unknown().await;
                } else {
                    // The backend answered: it holds nothing.
                    self.outstanding = None;
                }
                return Err(error.into());
            }
        };
        if payload.is_null() {
            self.outstanding = None;
            return Ok(None);
        }
        let frame: CompositorFrameReady = match serde_json::from_value(payload) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = self.release().await;
                return Err(anyhow!("the leased frame did not parse: {error}"));
            }
        };
        let (Some(iosurface_id), Some(width), Some(height)) = (
            frame.metal_target_iosurface_id,
            frame.metal_target_width,
            frame.metal_target_height,
        ) else {
            let _ = self.release().await;
            bail!("the leased frame has no IOSurface: the Metal compositor is off or failed");
        };
        Ok(Some(Leased {
            frame_id: frame.frames_rendered,
            iosurface_id,
            width,
            height,
            acquired_at: Instant::now(),
            frame_scene_revision: frame.frame_scene_revision.or(frame.scene_revision),
            frame_age_ms: frame.frame_age_ms,
        }))
    }

    /// An acquire whose outcome is unknown: release the id it named (a
    /// backend that never granted it answers so, and nothing is held). When
    /// that answer is lost too, the socket closes: the backend frees a closed
    /// socket's lease, and the closed socket ends this session, which the
    /// feed starts again after `RETRY_DELAY`.
    async fn give_back_unknown(&mut self) {
        let Some(lease_id) = self.outstanding.take() else {
            return;
        };
        let released = self
            .socket
            .request(
                "preview.surface.frame.release",
                json!({ "leaseId": lease_id }),
            )
            .await;
        if let Err(error) = released
            && error.is_outcome_unknown()
        {
            self.abandoned = true;
            self.socket.close().await;
        }
    }

    /// The socket can still lease frames.
    fn is_live(&self) -> bool {
        !self.abandoned && self.socket.is_open()
    }

    async fn release(&mut self) -> Result<()> {
        let Some(lease_id) = self.outstanding.take() else {
            return Ok(());
        };
        let acknowledged = self
            .socket
            .request(
                "preview.surface.frame.release",
                json!({ "leaseId": lease_id }),
            )
            .await?;
        if acknowledged.as_bool() != Some(true) {
            bail!("the frame release was not acknowledged: {acknowledged}");
        }
        Ok(())
    }
}

struct Leased {
    frame_id: u64,
    iosurface_id: u32,
    width: u32,
    height: u32,
    acquired_at: Instant,
    /// S3.1b: the scene revision the frame was rendered from.
    frame_scene_revision: Option<u64>,
    /// S3.1b: how old the frame was when it was leased.
    frame_age_ms: Option<u64>,
}

/// The measurement's raw material.
struct Stats {
    on: bool,
    started_at: Instant,
    records: Vec<LayerFrameRecord>,
    lease_held_ms: Vec<f64>,
    ready_to_commit_ms: Vec<f64>,
    frame_events: u64,
    repeated: u64,
    iosurfaces: std::collections::BTreeSet<u32>,
    notes: Vec<String>,
    target_fps: u32,
}

impl Stats {
    fn new(on: bool) -> Self {
        Self {
            on,
            started_at: Instant::now(),
            records: Vec::new(),
            lease_held_ms: Vec::new(),
            ready_to_commit_ms: Vec::new(),
            frame_events: 0,
            repeated: 0,
            iosurfaces: Default::default(),
            notes: Vec::new(),
            target_fps: 60,
        }
    }

    fn report(
        &mut self,
        #[cfg(target_os = "macos")] presenter: Option<&PresenterClient>,
        #[cfg(not(target_os = "macos"))] presenter: Option<&()>,
        telemetry: &Telemetry,
    ) -> FeedReport {
        #[cfg(target_os = "macos")]
        if let Some(presenter) = presenter {
            let stamps = presenter.take_presented();
            let orphans = attach_stamps(&mut self.records, &stamps);
            if orphans > 0 {
                self.notes.push(format!(
                    "{orphans} presented-time stamps matched no recorded frame"
                ));
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = presenter;
        if telemetry.cpu_route {
            self.notes.push(format!(
                "CPU route: ring generation {}, last upload to bind {:.2} ms",
                telemetry.cpu_ring_generation, telemetry.cpu_upload_to_bind_ms
            ));
        }
        FeedReport {
            seconds: self.started_at.elapsed().as_secs_f64(),
            frame_events: self.frame_events,
            summary: LayerRunSummary::of(&self.records, self.target_fps),
            lease_held_ms: Series::of(&self.lease_held_ms),
            ready_to_commit_ms: Series::of(&self.ready_to_commit_ms),
            skipped: telemetry.skipped,
            refused: telemetry.refused,
            dropped: telemetry.dropped,
            repeated: self.repeated,
            target_fps: self.target_fps,
            frame_width: telemetry.frame_width,
            frame_height: telemetry.frame_height,
            iosurfaces: self.iosurfaces.len(),
            notes: self.notes.clone(),
        }
    }
}

fn set_surface(telemetry: &Arc<Mutex<Telemetry>>, status: &PreviewSurfaceStatus) {
    if let Ok(mut t) = telemetry.lock() {
        t.backend_status = Some(status.clone());
        t.surface_live = status.state == PreviewSurfaceState::Live;
        t.surface_message = status.message.clone();
        t.surface_transport = Some(status.transport);
        t.surface_backing = Some(status.backing);
        if status.width > 0 && status.height > 0 {
            t.frame_width = status.width;
            t.frame_height = status.height;
        }
    }
}

/// Commits `params` (`scene.load_from_capture_config`): its revision is the
/// app's scene from then on. Scenes the backend reports meanwhile are not
/// taken (the commit's own echo may arrive before its answer).
async fn commit_scene(
    control: &BackendSocket,
    params: &SceneConfigParams,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    why: &str,
) -> Result<u64> {
    if let Ok(mut t) = telemetry.lock() {
        t.scene_commit_in_flight = true;
    }
    let answer = control
        .call::<SceneLoadFromCaptureConfig>(params)
        .await
        .context("scene.load_from_capture_config");
    let outcome = match answer {
        Ok(commit) if commit.applied => {
            if let Ok(mut t) = telemetry.lock() {
                t.note_scene_commit(&commit, Instant::now());
            }
            if let Some(hook) = &config.scene.on_committed {
                hook(params);
            }
            config.logger.log(
                Level::Info,
                &format!(
                    "[preview] scene committed at revision {} ({}; {why})",
                    commit.scene_revision, commit.mode
                ),
            );
            Ok(commit.scene_revision)
        }
        Ok(commit) => Err(anyhow!(
            "the scene was not applied: {}",
            commit.message.unwrap_or_else(|| commit.mode.clone())
        )),
        Err(error) => Err(error),
    };
    if let Ok(mut t) = telemetry.lock() {
        t.scene_commit_in_flight = false;
    }
    outcome
}

/// `resync-scene` while a session holds the scene: the backend's committed
/// scene becomes the app's (Electron's renderer presents committed
/// compositor truth again rather than authoring a scene).
async fn adopt_compositor_scene(
    control: &BackendSocket,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
) -> Result<Option<u64>> {
    let status = control
        .call::<CompositorStatusGet>(&())
        .await
        .context("compositor.status")?;
    let Some(revision) = status.scene_revision else {
        return Ok(None);
    };
    if let Ok(mut t) = telemetry.lock() {
        if t.renderer_scene_revision != Some(revision) {
            t.renderer_scene_revision = Some(revision);
            t.scene_adoptions += 1;
        }
        t.scene_run_id = status.run_id.clone();
        t.compositor_scene_revision = status.scene_revision;
        t.compositor_frame_scene_revision = status.frame_scene_revision;
        t.scene = Some(SceneState::of(&status));
    }
    config.logger.log(
        Level::Info,
        &format!("[preview] resync-scene: the session's scene (revision {revision}) is the app's"),
    );
    Ok(Some(revision))
}

/// Takes the backend's queued native host commands (on the admin socket).
async fn take_host_commands(
    lease: &Lease,
    telemetry: &Arc<Mutex<Telemetry>>,
) -> Result<Vec<Value>> {
    let taken = lease
        .socket
        .request("preview.surface.take_native_host_commands", json!({}))
        .await
        .context("preview.surface.take_native_host_commands")?;
    let commands = match taken {
        Value::Array(commands) => commands,
        Value::Null => Vec::new(),
        other => bail!("the host commands were not a list: {other}"),
    };
    if let Ok(mut t) = telemetry.lock() {
        t.host_commands_taken += commands.len() as u64;
        if let Some(status) = t.backend_status.as_mut() {
            status.pending_host_command_count = 0;
        }
    }
    Ok(commands)
}

/// The surface's source as the scene shows it (Electron's main derives it
/// from the scene: a screen or window, else a camera, else synthetic).
fn surface_source(
    scene: Option<&SceneConfigParams>,
    fallback: &PreviewSurfaceSource,
) -> PreviewSurfaceSource {
    match scene {
        Some(scene) if scene.sources.window_id.is_some() => PreviewSurfaceSource::Window,
        Some(scene) if scene.sources.screen_id.is_some() => PreviewSurfaceSource::Screen,
        Some(scene) if scene.sources.camera_id.is_some() && !scene.sources.test_pattern => {
            PreviewSurfaceSource::Camera
        }
        Some(_) => PreviewSurfaceSource::Synthetic,
        None => fallback.clone(),
    }
}

async fn create_surface(
    control: &BackendSocket,
    config: &FeedConfig,
    bounds: &PreviewSurfaceBounds,
    telemetry: &Arc<Mutex<Telemetry>>,
) -> Result<PreviewSurfaceStatus> {
    let source = surface_source(config.scene.current().as_ref(), &config.source);
    let status = control
        .call::<PreviewSurfaceCreate>(&PreviewSurfaceCreateParams {
            bounds: bounds.clone(),
            target_fps: config.target_fps,
            source,
        })
        .await
        .context("preview.surface.create")?;
    set_surface(telemetry, &status);
    config.logger.log(
        Level::Info,
        &format!(
            "[preview] surface {:?} {}x{} @ {} fps ({:?} on {:?}){}",
            status.state,
            status.width,
            status.height,
            status.target_fps,
            status.transport,
            status.backing,
            status
                .message
                .as_deref()
                .map(|m| format!(": {m}"))
                .unwrap_or_default()
        ),
    );
    if status.state != PreviewSurfaceState::Live {
        bail!(
            "the preview surface is {:?}{}",
            status.state,
            status
                .message
                .as_deref()
                .map(|m| format!(": {m}"))
                .unwrap_or_default()
        );
    }
    Ok(status)
}

fn default_bounds() -> PreviewSurfaceBounds {
    PreviewSurfaceBounds {
        width: 1280.0,
        height: 720.0,
        scale_factor: 1.0,
        visible: Some(true),
        ..PreviewSurfaceBounds::default()
    }
}

/// One session against one backend generation.
async fn session(
    bootstrap: &BackendBootstrap,
    config: &FeedConfig,
    commands: &mut mpsc::UnboundedReceiver<FeedCommand>,
    telemetry: &Arc<Mutex<Telemetry>>,
    carried: &mut Carried,
    mut state: watch::Receiver<BackendState>,
) -> Result<Exit> {
    let control = Arc::new(
        BackendSocket::connect(
            &bootstrap.renderer(),
            Duration::from_secs(30),
            Duration::from_secs(30),
        )
        .await
        .context("the control socket")?,
    );
    let lease_socket = BackendSocket::connect(
        &bootstrap.admin(),
        Duration::from_secs(30),
        Duration::from_secs(2),
    )
    .await
    .context("the lease socket")?;
    lease_socket.set_included_events(&[]).await?;
    control
        .set_included_events(&[
            "preview.frameReady",
            "compositor.status",
            "preview.surface.status",
        ])
        .await?;
    if let Ok(mut t) = telemetry.lock() {
        t.connected = true;
        t.last_error = None;
        // A new engine: its revisions and runs are its own.
        t.renderer_scene_revision = None;
        t.scene_run_id = None;
        t.scene_commit_in_flight = false;
        t.suspended = carried.suspended;
        t.parked = carried.parked;
    }
    let mut lease = Lease {
        socket: lease_socket,
        outstanding: None,
        abandoned: false,
    };

    // Subscribe before the surface exists so the first frame is not lost.
    let mut events = control.subscribe();
    let (frames_tx, mut frames) = watch::channel::<Option<FrameReady>>(None);
    let feeder_telemetry = telemetry.clone();
    let feeder_logger = config.logger.clone();
    let feeder = tokio::spawn(async move {
        let adopted = |t: &mut Telemetry, run: Option<&str>, revision: Option<u64>| {
            if t.note_backend_scene(run, revision) {
                feeder_logger.log(
                    Level::Info,
                    &format!(
                        "[preview] the backend's scene revision {} is the app's (committed outside the Studio's scene)",
                        revision.unwrap_or_default()
                    ),
                );
            }
        };
        loop {
            match events.recv().await {
                Ok(event) if event.event == "preview.frameReady" => {
                    if let Ok(frame) = serde_json::from_value::<CompositorFrameReady>(event.payload)
                    {
                        if let Ok(mut t) = feeder_telemetry.lock() {
                            t.frames_rendered = frame.frames_rendered;
                            t.compositor_scene_revision = frame.scene_revision;
                            t.compositor_frame_scene_revision = frame.frame_scene_revision;
                            t.metal_target_present =
                                frame.metal_target_iosurface_id.is_some() || t.cpu_ring_open;
                            adopted(&mut t, frame.run_id.as_deref(), frame.scene_revision);
                        }
                        // Latest wins, like NativePreviewLatestPump.
                        let _ = frames_tx.send(Some(FrameReady {
                            frame,
                            received_at: Instant::now(),
                        }));
                    }
                }
                Ok(event) if event.event == "preview.surface.status" => {
                    if let Ok(status) =
                        serde_json::from_value::<PreviewSurfaceStatus>(event.payload)
                    {
                        set_surface(&feeder_telemetry, &status);
                    }
                }
                Ok(event) if event.event == "compositor.status" => {
                    if let Ok(status) = serde_json::from_value::<CompositorStatus>(event.payload)
                        && let Ok(mut t) = feeder_telemetry.lock()
                    {
                        t.compositor_scene_revision = status.scene_revision;
                        t.compositor_frame_scene_revision = status.frame_scene_revision;
                        if status.scene_revision.is_some() {
                            t.scene = Some(SceneState::of(&status));
                        }
                        adopted(&mut t, status.run_id.as_deref(), status.scene_revision);
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    // S4.1d: the CPU route's reader thread, for this session's ring. The
    // element's sink order may still be in the inbox (the backend was ready
    // before the first command was read): take it now, and start later when
    // it arrives during the session.
    while let Ok(command) = commands.try_recv() {
        match command {
            FeedCommand::Stop => return Ok(Exit::Stop),
            command => carried.idle_command(command, telemetry),
        }
    }
    let mut cpu = match config.frame_source {
        FrameSource::CpuRing if !carried.cpu_sinks().is_empty() => {
            start_cpu_route(carried.cpu_sinks(), config, telemetry)
        }
        FrameSource::CpuRing => {
            config.logger.log(
                Level::Info,
                "[preview] the CPU route waits for the element's sink (a presenter or the texture)",
            );
            None
        }
        FrameSource::NativeLease => None,
    };
    let outcome = session_body(
        &control,
        config,
        commands,
        telemetry,
        carried,
        &mut lease,
        &mut frames,
        &mut state,
        &mut cpu,
    )
    .await;
    if let Some(cpu) = cpu.take() {
        cpu.source.stop();
        if let Ok(mut t) = telemetry.lock() {
            t.cpu_ring_open = false;
            t.metal_target_present = false;
        }
    }
    feeder.abort();
    let _ = lease.release().await;
    if control.is_open() {
        match control.call::<PreviewSurfaceDestroy>(&()).await {
            Ok(status) => set_surface(telemetry, &status),
            Err(error) => config
                .logger
                .log(Level::Warn, &format!("[preview] surface destroy: {error}")),
        }
        let _ = take_host_commands(&lease, telemetry).await;
    }
    lease.socket.close().await;
    control.close().await;
    outcome
}

/// S3.1b: when the Studio's scene is committed. The renderer's effect runs
/// 250 ms after a change (each change restarts the wait) while nothing holds
/// the scene, and runs again once a hold ends even if nothing changed.
#[derive(Debug, Default)]
struct ScenePolicy {
    /// What this connection committed last.
    committed: Option<SceneConfigParams>,
    /// A `None` (a session, a start or a stop) was seen since then.
    held: bool,
    /// The change's 250 ms run out at.
    due: Option<tokio::time::Instant>,
    /// S3.1e: the Studio's transaction commit last adopted (each is
    /// adopted once).
    adopted: Option<u64>,
}

impl ScenePolicy {
    /// The Studio's scene changed to `request`.
    fn changed(&mut self, request: Option<&SceneConfigParams>) {
        if request.is_none() {
            self.held = true;
        }
        self.due = Some(tokio::time::Instant::now() + SCENE_RELOAD_DELAY);
    }

    /// The wait ran out with `request` the Studio's scene: what to commit.
    /// S3.1e: a scene the Studio's own transaction committed (`adopted`) is
    /// taken as committed, never sent again.
    fn due(
        &mut self,
        request: Option<SceneConfigParams>,
        adopted: Option<&(u64, SceneConfigParams)>,
    ) -> Option<SceneConfigParams> {
        self.due = None;
        let request = request?;
        if let Some((commit, params)) = adopted
            && self.adopted != Some(*commit)
            && *params == request
        {
            self.adopted = Some(*commit);
            self.committed(request);
            return None;
        }
        let again = self.held || self.committed.as_ref() != Some(&request);
        again.then_some(request)
    }

    fn committed(&mut self, params: SceneConfigParams) {
        self.committed = Some(params);
        self.held = false;
    }
}

/// S4.1d: the CPU route's reader and its requests to the session.
struct CpuRoute {
    source: CpuFrameSource,
    inbox: mpsc::UnboundedReceiver<CpuRequest>,
}

/// S4.1d, S4.2c: the sinks changed (a route switch, a presenter attached
/// or detached): the reader takes them, or starts now that there is one.
async fn sync_cpu_sinks(
    cpu: &mut Option<CpuRoute>,
    carried: &Carried,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    lease: &Lease,
    surface_up: bool,
) {
    if config.frame_source != FrameSource::CpuRing {
        return;
    }
    let sinks = carried.cpu_sinks();
    match cpu.as_ref() {
        Some(route) => route.source.set_sinks(sinks),
        None if !sinks.is_empty() => {
            *cpu = start_cpu_route(sinks, config, telemetry);
            if surface_up && let Some(route) = cpu.as_ref() {
                open_cpu_ring(lease, route, config, telemetry, "preview.cpu.open").await;
            }
        }
        None => {}
    }
}

/// S4.1d: starts the CPU frame reader for `sinks`; a failure is logged and
/// leaves the route without frames (the contract declares it).
fn start_cpu_route(
    sinks: CpuSinks,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
) -> Option<CpuRoute> {
    let (requests, inbox) = mpsc::unbounded_channel();
    match CpuFrameSource::start(
        sinks,
        telemetry.clone(),
        config.logger.clone(),
        requests,
        tokio::runtime::Handle::current(),
    ) {
        Ok(source) => Some(CpuRoute { source, inbox }),
        Err(error) => {
            config.logger.log(
                Level::Error,
                &format!("[preview] the CPU frame reader did not start: {error}"),
            );
            if let Ok(mut t) = telemetry.lock() {
                t.last_error = Some(format!("the CPU frame reader did not start: {error}"));
            }
            None
        }
    }
}

/// S4.1d: `preview.cpu.open` on the lease socket (the ring closes with it);
/// the ring, when the backend has one, goes to the reader thread.
async fn open_cpu_ring(
    lease: &Lease,
    cpu: &CpuRoute,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    method: &str,
) {
    match lease.socket.request(method, json!({})).await {
        Ok(payload) => match serde_json::from_value::<PreviewCpuRingStatus>(payload) {
            Ok(status) => {
                if let Some(ring) = &status.ring {
                    config.logger.log(
                        Level::Info,
                        &format!(
                            "[preview] CPU preview ring generation {}: {}x{}, {} frames written so far",
                            ring.generation, ring.width, ring.height, status.frames_written
                        ),
                    );
                } else {
                    config.logger.log(
                        Level::Info,
                        &format!(
                            "[preview] CPU preview ring: {}",
                            status.message.as_deref().unwrap_or("no ring yet")
                        ),
                    );
                }
                cpu.source.set_ring(status.ring);
            }
            Err(error) => config.logger.log(
                Level::Warn,
                &format!("[preview] {method} answered an unreadable status: {error}"),
            ),
        },
        Err(error) => {
            config
                .logger
                .log(Level::Error, &format!("[preview] {method}: {error}"));
            if let Ok(mut t) = telemetry.lock() {
                t.last_error = Some(format!("{method}: {error}"));
            }
            cpu.source.set_ring(None);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn session_body(
    control: &Arc<BackendSocket>,
    config: &FeedConfig,
    commands: &mut mpsc::UnboundedReceiver<FeedCommand>,
    telemetry: &Arc<Mutex<Telemetry>>,
    carried: &mut Carried,
    lease: &mut Lease,
    frames: &mut watch::Receiver<Option<FrameReady>>,
    state: &mut watch::Receiver<BackendState>,
    cpu: &mut Option<CpuRoute>,
) -> Result<Exit> {
    carried.stats.target_fps = config.target_fps;
    let mut scene_rx = config.scene.rx.clone();
    let mut scene_open = true;
    let mut policy = ScenePolicy::default();

    // S3.1b: the Studio's scene first (its settings load on this same
    // engine connection, so it may take a moment to be there); the surface
    // is created on the backend's own scene if it never comes.
    if scene_rx.borrow().is_none() {
        let deadline = tokio::time::sleep(FIRST_SCENE_WAIT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                changed = scene_rx.changed() => {
                    if changed.is_err() {
                        scene_open = false;
                        break;
                    }
                    if scene_rx.borrow().is_some() {
                        break;
                    }
                }
                command = commands.recv() => match command {
                    Some(FeedCommand::Stop) | None => return Ok(Exit::Stop),
                    Some(command) => carried.idle_command(command, telemetry),
                }
            }
        }
    }
    let first = scene_rx.borrow_and_update().clone();
    match first {
        Some(params) => match commit_scene(control, &params, config, telemetry, "connected").await {
            Ok(_) => policy.committed(params),
            Err(error) => config.logger.log(
                Level::Warn,
                &format!("[preview] the Studio's scene was not committed: {error:#}"),
            ),
        },
        None => config.logger.log(
            Level::Info,
            "[preview] no Studio scene to commit yet (a session or the settings hold it): the backend's scene is shown",
        ),
    }

    // The UI places the layer a few event-loop turns after show(); the
    // surface is created on those bounds, or on a default and resized.
    if carried.bounds.is_none() {
        let deadline = tokio::time::sleep(FIRST_BOUNDS_WAIT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                command = commands.recv() => match command {
                    Some(FeedCommand::Stop) | None => return Ok(Exit::Stop),
                    Some(command) => carried.idle_command(command, telemetry),
                }
            }
            if carried.bounds.is_some() {
                break;
            }
        }
    }
    let mut sent_bounds = carried.bounds.clone().unwrap_or_else(default_bounds);
    let mut surface_up = !carried.held();
    if surface_up {
        create_surface(control, config, &sent_bounds, telemetry).await?;
        drain_if_pending(lease, config, telemetry).await;
        if let Some(cpu) = cpu.as_ref() {
            open_cpu_ring(lease, cpu, config, telemetry, "preview.cpu.open").await;
        }
    } else {
        config.logger.log(
            Level::Info,
            &format!(
                "[preview] {}: no surface until {}",
                carried.held_why(),
                carried.held_until()
            ),
        );
    }

    let mut bounds_in_flight: Option<JoinHandle<Result<PreviewSurfaceStatus, RpcError>>> = None;
    let mut bounds_sent_at = Instant::now();
    let mut last_presented: Option<u64> = None;
    let mut report_tick = tokio::time::interval(PRESENT_REPORT_INTERVAL);
    report_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut log_tick = tokio::time::interval(Duration::from_secs(10));
    log_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut presented_at_last_log = 0u64;
    let mut kick = false;
    // S2.3c: the frame the ring wait saw while a lease was held; presented
    // next (through the select, so orders still get their turn).
    let mut pending: Option<FrameReady> = None;

    loop {
        // The latest bounds go out once the previous update answered.
        if surface_up
            && bounds_in_flight.is_none()
            && let Some(bounds) = carried.bounds.as_ref()
            && *bounds != sent_bounds
            && bounds_sent_at.elapsed() >= BOUNDS_UPDATE_SPACING
        {
            sent_bounds = bounds.clone();
            bounds_sent_at = Instant::now();
            let control = control.clone();
            let params = PreviewSurfaceBoundsParams {
                bounds: sent_bounds.clone(),
            };
            bounds_in_flight = Some(tokio::spawn(async move {
                control.call::<PreviewSurfaceUpdateBounds>(&params).await
            }));
        }
        let scene_due = policy.due;
        tokio::select! {
            _ = std::future::ready(()), if pending.is_some() && surface_up => {
                let ready = pending.take().expect("checked");
                pending = present_one(&ready, config, telemetry, carried, lease, frames, &mut last_presented, kick).await?;
                kick = false;
            }
            changed = frames.changed(), if pending.is_none() => {
                if changed.is_err() {
                    return Ok(Exit::Disconnected("the frame feeder ended".to_string()));
                }
                let Some(ready) = frames.borrow_and_update().clone() else { continue };
                if surface_up {
                    pending = present_one(&ready, config, telemetry, carried, lease, frames, &mut last_presented, kick).await?;
                    kick = false;
                }
            }
            changed = scene_rx.changed(), if scene_open => {
                if changed.is_err() {
                    scene_open = false;
                } else {
                    let request = scene_rx.borrow_and_update().clone();
                    policy.changed(request.as_ref());
                }
            }
            _ = tokio::time::sleep_until(scene_due.unwrap_or_else(tokio::time::Instant::now)), if scene_due.is_some() => {
                let request = scene_rx.borrow().clone();
                let adopted = config.scene.adopted_now();
                let adopting = adopted.as_ref().is_some_and(|(commit, params)| {
                    policy.adopted != Some(*commit) && Some(params) == request.as_ref()
                });
                if adopting {
                    config.logger.log(Level::Info, "[preview] the Studio's scene was committed by its own layout transaction: adopted, not committed again");
                }
                if let Some(params) = policy.due(request, adopted.as_ref()) {
                    match commit_scene(control, &params, config, telemetry, "the Studio's scene changed").await {
                        Ok(_) => policy.committed(params),
                        Err(error) => config.logger.log(Level::Warn, &format!("[preview] the Studio's scene was not committed: {error:#}")),
                    }
                }
            }
            request = async { cpu.as_mut().expect("checked").inbox.recv().await }, if cpu.is_some() => {
                match request {
                    Some(CpuRequest::Reopen) => {
                        if surface_up && let Some(cpu) = cpu.as_ref() {
                            open_cpu_ring(lease, cpu, config, telemetry, "preview.cpu.status").await;
                        }
                    }
                    None => {
                        // The reader thread ended (a panic is the only way):
                        // the route is down, by name, and this arm is off.
                        config.logger.log(Level::Error, "[preview] the CPU frame reader ended; no frames can show until the surface is recreated");
                        if let Ok(mut t) = telemetry.lock() {
                            t.last_error = Some("the CPU frame reader ended".to_string());
                            t.cpu_ring_open = false;
                            t.metal_target_present = false;
                        }
                        *cpu = None;
                    }
                }
            }
            command = commands.recv() => match command {
                Some(FeedCommand::Stop) | None => return Ok(Exit::Stop),
                Some(FeedCommand::Kick) => {
                    if let Some(cpu) = cpu.as_ref() {
                        cpu.source.kick();
                    }
                    kick = true;
                    let ready = frames.borrow().clone();
                    if let Some(ready) = ready && surface_up {
                        pending = present_one(&ready, config, telemetry, carried, lease, frames, &mut last_presented, true).await?;
                        kick = false;
                    }
                }
                Some(FeedCommand::TextureSink(sink)) => {
                    carried.idle_command(FeedCommand::TextureSink(sink), telemetry);
                    sync_cpu_sinks(cpu, carried, config, telemetry, lease, surface_up).await;
                }
                #[cfg(target_os = "linux")]
                Some(FeedCommand::CpuPresenter(presenter)) => {
                    carried.idle_command(FeedCommand::CpuPresenter(presenter), telemetry);
                    sync_cpu_sinks(cpu, carried, config, telemetry, lease, surface_up).await;
                }
                Some(FeedCommand::ResyncScene) => {
                    let request = scene_rx.borrow().clone();
                    let outcome = match request {
                        Some(params) => commit_scene(control, &params, config, telemetry, "resync-scene").await.map(|_| policy.committed(params)),
                        None => adopt_compositor_scene(control, config, telemetry).await.map(|_| ()),
                    };
                    if let Err(error) = outcome {
                        config.logger.log(Level::Warn, &format!("[preview] resync-scene: {error:#}"));
                    }
                }
                Some(FeedCommand::CommitScene(reply)) => {
                    let request = scene_rx.borrow().clone();
                    let answer = match request {
                        Some(params) => match commit_scene(control, &params, config, telemetry, "asked to commit again").await {
                            Ok(revision) => {
                                policy.committed(params);
                                Ok(revision)
                            }
                            Err(error) => Err(format!("{error:#}")),
                        },
                        None => Err(SCENE_HELD.to_string()),
                    };
                    let _ = reply.send(answer);
                }
                Some(FeedCommand::RecreateSurface) => {
                    let _ = lease.release().await;
                    match control.call::<PreviewSurfaceDestroy>(&()).await {
                        Ok(status) => set_surface(telemetry, &status),
                        Err(error) => config.logger.log(Level::Warn, &format!("[preview] reset: destroy: {error}")),
                    }
                    sent_bounds = carried.bounds.clone().unwrap_or_else(default_bounds);
                    if !carried.held() {
                        create_surface(control, config, &sent_bounds, telemetry).await?;
                        surface_up = true;
                        {
                            // Plan 260 S2.3a (found by S0.1): the backend refuses every lease on a
                            // surface created again until a scene is committed to it, and the
                            // watchdog's resync-scene step only got there 4.6 to 5.2 s later.
                            // Commit the scene at once.
                            let request = scene_rx.borrow().clone();
                            if let Some(params) = request {
                                match commit_scene(control, &params, config, telemetry, "the surface was created again").await {
                                    Ok(_) => policy.committed(params),
                                    Err(error) => config.logger.log(Level::Warn, &format!("[preview] the scene was not committed to the new surface: {error:#}")),
                                }
                            }
                        }
                    }
                    drain_if_pending(lease, config, telemetry).await;
                    last_presented = None;
                }
                Some(command @ (FeedCommand::Suspend(_) | FeedCommand::Park(_))) => {
                    // The smokes' suspend and a closed Preview's park hold the
                    // surface down for their own reasons: down while either
                    // holds, back when neither does.
                    let why = carried.held_why();
                    carried.idle_command(command, telemetry);
                    let held = carried.held();
                    if held && surface_up {
                        pending = None;
                        let _ = lease.release().await;
                        match control.call::<PreviewSurfaceDestroy>(&()).await {
                            Ok(status) => set_surface(telemetry, &status),
                            Err(error) => config.logger.log(Level::Warn, &format!("[preview] suspend: destroy: {error}")),
                        }
                        surface_up = false;
                        config.logger.log(Level::Info, &format!("[preview] {}: the surface is down until {}", carried.held_why(), carried.held_until()));
                    } else if !held && !surface_up {
                        sent_bounds = carried.bounds.clone().unwrap_or_else(default_bounds);
                        create_surface(control, config, &sent_bounds, telemetry).await?;
                        surface_up = true;
                        last_presented = None;
                        {
                            // Plan 260 S2.3a (found by S0.1): the backend refuses every lease on a
                            // surface created again until a scene is committed to it, and the
                            // watchdog's resync-scene step only got there 4.6 to 5.2 s later.
                            // Commit the scene at once.
                            let request = scene_rx.borrow().clone();
                            if let Some(params) = request {
                                match commit_scene(control, &params, config, telemetry, "the surface was created again").await {
                                    Ok(_) => policy.committed(params),
                                    Err(error) => config.logger.log(Level::Warn, &format!("[preview] the scene was not committed to the new surface: {error:#}")),
                                }
                            }
                        }
                        // S4.2c: the CPU ring opens with the surface, as at the
                        // session's start (the reader's own reopen only asks
                        // while it is polling an old ring).
                        if let Some(cpu) = cpu.as_ref() {
                            open_cpu_ring(lease, cpu, config, telemetry, "preview.cpu.open").await;
                        }
                        config.logger.log(Level::Info, &format!("[preview] {why} no more: the surface is back"));
                    }
                    drain_if_pending(lease, config, telemetry).await;
                }
                Some(FeedCommand::ReadCompositorStatus(reply)) => {
                    let answer = control.call::<CompositorStatusGet>(&()).await.map_err(|error| error.to_string());
                    if let Ok(status) = &answer
                        && let Ok(mut t) = telemetry.lock()
                    {
                        t.compositor_scene_revision = status.scene_revision;
                        t.compositor_frame_scene_revision = status.frame_scene_revision;
                        t.scene = Some(SceneState::of(status));
                    }
                    let _ = reply.send(answer);
                }
                Some(FeedCommand::DrainHostCommands(reply)) => {
                    let answer = take_host_commands(lease, telemetry).await.map_err(|error| format!("{error:#}"));
                    if let Ok(commands) = &answer && !commands.is_empty() {
                        config.logger.log(Level::Info, &format!("[preview] took {} native host command(s); the element places its own layer", commands.len()));
                    }
                    let _ = reply.send(answer);
                }
                Some(command) => carried.idle_command(command, telemetry),
            },
            result = async { bounds_in_flight.as_mut().expect("checked").await }, if bounds_in_flight.is_some() => {
                bounds_in_flight = None;
                match result {
                    Ok(Ok(status)) => {
                        set_surface(telemetry, &status);
                        if status.pending_host_command_count > 0 {
                            drain_if_pending(lease, config, telemetry).await;
                        }
                    }
                    Ok(Err(error)) => config.logger.log(Level::Warn, &format!("[preview] update_bounds: {error}")),
                    Err(error) => config.logger.log(Level::Warn, &format!("[preview] update_bounds task: {error}")),
                }
            }
            _ = report_tick.tick(), if surface_up => {
                let params = telemetry.lock().map(|t| t.present_params()).unwrap_or_else(|_| Telemetry::default().present_params());
                let control = control.clone();
                let telemetry = telemetry.clone();
                tokio::spawn(async move {
                    // S4.2c: the answer is the surface's status with the
                    // backing the report named (a route switch shows there
                    // within a report), so the telemetry's surface follows it.
                    if let Ok(answer) = control.request("preview.surface.present", serde_json::to_value(params).unwrap_or(Value::Null)).await
                        && let Ok(status) = serde_json::from_value::<PreviewSurfaceStatus>(answer)
                    {
                        set_surface(&telemetry, &status);
                    }
                });
            }
            _ = log_tick.tick() => {
                let t = telemetry.lock().map(|t| t.clone()).unwrap_or_default();
                let interval = t.commit_interval();
                config.logger.log(Level::Info, &format!(
                    "[preview] {} frames presented (+{} in 10 s, {:.2}/s), commit interval p95 {:.2} ms, skipped {}, dropped {}, {}x{}; layer {}, texture {}{}; scene revision {} (shown {}); the backend's status says {:?} on {:?}",
                    t.presented,
                    t.presented - presented_at_last_log,
                    t.present_fps().unwrap_or(0.0),
                    interval.p95.unwrap_or(0.0),
                    t.skipped,
                    t.dropped,
                    t.frame_width,
                    t.frame_height,
                    t.layer_presented,
                    t.texture_frames,
                    if t.texture_route { " (texture route on)" } else { "" },
                    t.renderer_scene_revision.map(|revision| revision.to_string()).unwrap_or_else(|| "none".to_string()),
                    t.presented_scene_revision.map(|revision| revision.to_string()).unwrap_or_else(|| "none".to_string()),
                    t.surface_transport,
                    t.surface_backing
                ));
                presented_at_last_log = t.presented;
            }
            changed = state.changed() => {
                // The supervisor moved on (a restart): this generation's
                // sockets are dead or about to be.
                if changed.is_err() || !state.borrow().is_ready() {
                    return Ok(Exit::Disconnected("the engine generation ended".to_string()));
                }
            }
            reason = control.wait_closed() => {
                return Ok(Exit::Disconnected(reason));
            }
        }
    }
}

/// What `CommitScene` answers while a session holds the scene.
pub const SCENE_HELD: &str =
    "A recording or livestream holds the scene; the preview shows the session's scene.";

/// S3.1b: the backend queues native host commands for Electron main's
/// helper; the element places its own layer, so a queue left behind is
/// taken and logged (the readiness gates want it empty).
async fn drain_if_pending(lease: &Lease, config: &FeedConfig, telemetry: &Arc<Mutex<Telemetry>>) {
    let pending = telemetry
        .lock()
        .ok()
        .and_then(|t| {
            t.backend_status
                .as_ref()
                .map(|status| status.pending_host_command_count)
        })
        .unwrap_or(0);
    if pending == 0 {
        return;
    }
    if let Err(error) = take_host_commands(lease, telemetry).await {
        config
            .logger
            .log(Level::Warn, &format!("[preview] host commands: {error:#}"));
    }
}

/// Leases `ready`'s frame, hands it to the sinks (the layer's presenter, the
/// texture route, or both), waits until each is done with it and releases
/// it. `force` presents a frame id already shown (the kick). Returns the
/// `preview.frameReady` the texture route's ring wait saw while the lease
/// was held, for the caller to present next.
#[allow(clippy::too_many_arguments)]
async fn present_one(
    ready: &FrameReady,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    carried: &mut Carried,
    lease: &mut Lease,
    frames: &mut watch::Receiver<Option<FrameReady>>,
    last_presented: &mut Option<u64>,
    force: bool,
) -> Result<Option<FrameReady>> {
    carried.stats.frame_events += 1;
    if config.frame_source == FrameSource::CpuRing {
        // S4.1d: the ring's reader presents on its own thread; the event
        // only keeps the telemetry's `framesRendered` moving.
        return Ok(None);
    }
    if ready.frame.metal_target_iosurface_id.is_none() {
        return Ok(None);
    }
    if !force && *last_presented == Some(ready.frame.frames_rendered) {
        return Ok(None);
    }
    if let Ok(mut t) = telemetry.lock()
        && t.presented > 0
        && let Some(last) = *last_presented
    {
        // Frames that arrived while the loop was busy (latest wins).
        t.skipped += ready.frame.frames_rendered.saturating_sub(last + 1);
    }
    let leased = match lease.acquire(&ready.frame).await {
        Ok(Some(leased)) => leased,
        Ok(None) => {
            if let Ok(mut t) = telemetry.lock() {
                t.refused += 1;
            }
            return Ok(None);
        }
        Err(error) => {
            if let Ok(mut t) = telemetry.lock() {
                t.dropped += 1;
                t.last_error = Some(format!("{error:#}"));
            }
            // A dead lease socket ends the session; a refused frame does not.
            if !lease.is_live() {
                return Err(error);
            }
            config
                .logger
                .log(Level::Warn, &format!("[preview] lease: {error:#}"));
            return Ok(None);
        }
    };
    if carried.stats.on {
        carried.stats.iosurfaces.insert(leased.iosurface_id);
        if *last_presented == Some(leased.frame_id) {
            carried.stats.repeated += 1;
        }
    }

    // The texture route's half: import (cached per ring slot) and hand the
    // texture to the UI thread, which binds it and answers.
    let texture_sink = carried.texture.clone();
    let mut bound_rx: Option<oneshot::Receiver<Instant>> = None;
    if let Some(sink) = texture_sink.as_ref() {
        match carried.texture_for(sink, &leased) {
            Ok(texture) => {
                let (bound, rx) = oneshot::channel();
                (sink.deliver)(TextureFrame {
                    frame_id: leased.frame_id,
                    iosurface_id: leased.iosurface_id,
                    width: leased.width,
                    height: leased.height,
                    texture,
                    bound,
                });
                bound_rx = Some(rx);
            }
            Err(reason) => {
                if let Ok(mut t) = telemetry.lock() {
                    t.dropped += 1;
                    t.last_error = Some(format!("frame {}: {reason}", leased.frame_id));
                }
                config.logger.log(
                    Level::Warn,
                    &format!(
                        "[preview] texture import of frame {}: {reason}",
                        leased.frame_id
                    ),
                );
            }
        }
    }
    // The layer's half: the presenter draws into every attached layer and
    // answers once the GPU is done.
    let layer_reply = layer_present(carried, &leased);
    if bound_rx.is_none() && layer_reply.is_none() {
        // No sink: nothing to draw into; let the frame go.
        lease.release().await?;
        return Ok(None);
    }

    let layer_report = layer_reply.map(|reply| tokio::task::block_in_place(|| await_layer(&reply)));
    let mut texture_bound_at: Option<Instant> = None;
    let mut next: Option<FrameReady> = None;
    if let Some(rx) = bound_rx {
        match tokio::time::timeout(PRESENT_DEADLINE, rx).await {
            Ok(Ok(at)) => texture_bound_at = Some(at),
            Ok(Err(_)) | Err(_) => {
                if let Ok(mut t) = telemetry.lock() {
                    t.dropped += 1;
                    t.last_error = Some(format!(
                        "the UI did not bind frame {} within {PRESENT_DEADLINE:?}",
                        leased.frame_id
                    ));
                }
            }
        }
        if texture_bound_at.is_some() {
            // The ring policy: the UI draws the bound frame on its next
            // tick; the lease goes once the next frame is announced (slot N
            // is drawn again at N+3) or the wait passes, and the device has
            // finished what it was given.
            if let Ok(Ok(())) =
                tokio::time::timeout(ring_wait(config.target_fps), frames.changed()).await
            {
                next = frames.borrow_and_update().clone();
            }
            if let Some(sink) = texture_sink.as_ref() {
                let device = sink.device.clone();
                let polled = tokio::task::block_in_place(|| {
                    device.poll(wgpu::PollType::wait_indefinitely())
                });
                if let Err(error) = polled {
                    config.logger.log(
                        Level::Warn,
                        &format!(
                            "[preview] device wait after frame {}: {error}",
                            leased.frame_id
                        ),
                    );
                }
            }
        }
    }
    let release_started = Instant::now();
    lease.release().await?;
    let held_ms = release_started
        .saturating_duration_since(leased.acquired_at)
        .as_secs_f64()
        * 1000.0;

    // What the layer did with it.
    let (layer_committed, layer_record) =
        layer_outcome(layer_report, &leased, config, telemetry, carried.stats.on);
    if texture_bound_at.is_some()
        && let Ok(mut t) = telemetry.lock()
    {
        t.texture_frames += 1;
    }
    finish_present(
        ready,
        config,
        telemetry,
        carried,
        last_presented,
        &leased,
        held_ms,
        layer_committed,
        texture_bound_at,
        layer_record,
    );
    Ok(next)
}

/// The presenter's answer for one frame. On time: the report. Late: the
/// frame counts as missed (`Timeout`), but this still waits for the answer
/// (the presenter sends it once every command buffer that samples the
/// surface has completed) or for the presenter's thread to end, before the
/// caller releases the lease. The wait is bounded by the presenter's own
/// work: `nextDrawable` gives up after a second, and no other request is
/// queued ahead of this one (the loop holds one lease at a time).
fn await_layer<T>(
    reply: &std::sync::mpsc::Receiver<T>,
) -> Result<T, std::sync::mpsc::RecvTimeoutError> {
    match reply.recv_timeout(PRESENT_DEADLINE) {
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // Ownership stays with the presenter until it answers; what it
            // answers late is not counted as a present.
            let _ = reply.recv();
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        }
        answered => answered,
    }
}

/// The layer's present of one leased frame: the presenter's answer, when a
/// presenter draws. Off macOS there is none.
#[cfg(target_os = "macos")]
fn layer_present(
    carried: &Carried,
    leased: &Leased,
) -> Option<std::sync::mpsc::Receiver<crate::macos::PresentReport>> {
    carried.presenter.as_ref().map(|presenter| {
        presenter.present(
            leased.frame_id,
            leased.iosurface_id,
            leased.width,
            leased.height,
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn layer_present(_carried: &Carried, _leased: &Leased) -> Option<std::sync::mpsc::Receiver<()>> {
    None
}

/// What the layer did with the frame: when it committed, and the record.
#[cfg(not(target_os = "macos"))]
fn layer_outcome(
    _layer_report: Option<Result<(), std::sync::mpsc::RecvTimeoutError>>,
    _leased: &Leased,
    _config: &FeedConfig,
    _telemetry: &Arc<Mutex<Telemetry>>,
    _record: bool,
) -> (Option<Instant>, Option<LayerFrameRecord>) {
    (None, None)
}

#[cfg(target_os = "macos")]
fn layer_outcome(
    layer_report: Option<Result<crate::macos::PresentReport, std::sync::mpsc::RecvTimeoutError>>,
    leased: &Leased,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    record: bool,
) -> (Option<Instant>, Option<LayerFrameRecord>) {
    let mut layer_committed: Option<Instant> = None;
    let mut layer_record: Option<LayerFrameRecord> = None;
    match layer_report {
        None => {}
        Some(Err(_)) => {
            if let Ok(mut t) = telemetry.lock() {
                t.dropped += 1;
                t.last_error = Some(format!(
                    "the presenter did not answer for frame {} within {PRESENT_DEADLINE:?}",
                    leased.frame_id
                ));
            }
        }
        Some(Ok(report)) => {
            if let ImportOutcome::Failed(reason) = &report.import {
                if let Ok(mut t) = telemetry.lock() {
                    t.dropped += 1;
                    t.last_error = Some(format!("frame {}: {reason}", leased.frame_id));
                }
                config.logger.log(
                    Level::Warn,
                    &format!("[preview] import of frame {}: {reason}", leased.frame_id),
                );
            } else if report.layers.is_empty() {
                // No layer is attached yet (the native window exists a few
                // event-loop turns after show()), or the texture route alone
                // shows the preview: the frame was imported, not drawn by
                // the layer. Neither a present nor a drop on this half.
            } else {
                layer_committed = report
                    .layers
                    .iter()
                    .filter(|layer| layer.failure.is_none())
                    .map(|layer| layer.committed_at)
                    .max();
                for layer in &report.layers {
                    if let Some(failure) = &layer.failure {
                        config.logger.log(
                            Level::Warn,
                            &format!(
                                "[preview] frame {} layer {}: {failure}",
                                leased.frame_id, layer.layer
                            ),
                        );
                    }
                }
                if layer_committed.is_some() {
                    if let Ok(mut t) = telemetry.lock() {
                        t.layer_presented += 1;
                    }
                    if record {
                        layer_record = Some(report.into_record());
                    }
                } else if let Ok(mut t) = telemetry.lock() {
                    t.dropped += 1;
                }
            }
        }
    }
    (layer_committed, layer_record)
}

/// The frame counts as presented once either sink showed it; the layer's
/// commit is the cadence reference while it is up.
#[allow(clippy::too_many_arguments)]
fn finish_present(
    ready: &FrameReady,
    config: &FeedConfig,
    telemetry: &Arc<Mutex<Telemetry>>,
    carried: &mut Carried,
    last_presented: &mut Option<u64>,
    leased: &Leased,
    held_ms: f64,
    layer_committed: Option<Instant>,
    texture_bound_at: Option<Instant>,
    layer_record: Option<LayerFrameRecord>,
) {
    let committed_at = layer_committed.or(texture_bound_at);
    if let Some(committed_at) = committed_at {
        *last_presented = Some(leased.frame_id);
        let mut proof: Option<(u64, f64)> = None;
        if let Ok(mut t) = telemetry.lock() {
            t.presented += 1;
            t.presented_frame_id = leased.frame_id;
            t.frame_width = leased.width;
            t.frame_height = leased.height;
            t.note_commit(committed_at);
            // S3.1b: source to present: the frame's age at the lease, then
            // the lease to the commit.
            if let Some(age) = leased.frame_age_ms {
                let lease_to_commit = committed_at
                    .saturating_duration_since(leased.acquired_at)
                    .as_secs_f64()
                    * 1000.0;
                t.note_latency(age as f64 + lease_to_commit);
            }
            if let Some(revision) = leased.frame_scene_revision {
                t.presented_scene_revision = Some(revision);
                // The layout-intent proof: the committed scene is on screen.
                if let Some(commit) = t.last_scene_commit.as_mut()
                    && commit.on_screen_at.is_none()
                    && revision >= commit.revision
                {
                    commit.on_screen_at = Some(committed_at);
                    proof = commit.latency_ms().map(|ms| (commit.revision, ms));
                }
            }
        }
        if let Some((revision, ms)) = proof {
            config.logger.log(
                Level::Info,
                &format!(
                    "[preview] scene revision {revision} on screen {ms:.0} ms after its commit"
                ),
            );
        }
        if carried.stats.on {
            carried.stats.lease_held_ms.push(held_ms);
            carried.stats.ready_to_commit_ms.push(
                committed_at
                    .saturating_duration_since(ready.received_at)
                    .as_secs_f64()
                    * 1000.0,
            );
            if let Some(record) = layer_record {
                carried.stats.records.push(record);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_reports_the_native_route_and_its_cadence() {
        let mut t = Telemetry::default();
        let t0 = Instant::now();
        for i in 0..10u64 {
            t.note_commit(t0 + Duration::from_millis(i * 16));
            t.presented += 1;
            t.presented_frame_id = 100 + i;
        }
        t.frames_rendered = 112;
        let params = t.present_params();
        assert_eq!(params.transport, Some(PreviewTransport::NativeSurface));
        assert_eq!(
            params.backing,
            Some(videorc_protocol::PreviewSurfaceBacking::CaMetalLayer)
        );
        assert_eq!(params.presented_frame_id, Some(109));
        assert_eq!(params.compositor_frame_lag, Some(3));
        assert!(params.source_pixels_present);
        let fps = params.present_fps.unwrap();
        assert!((fps - 62.5).abs() < 0.1, "{fps}");
        assert_eq!(params.interval_p95_ms, Some(16.0));
        // The backend reads these params back as they went out.
        let wire = serde_json::to_value(&params).unwrap();
        let back: PreviewSurfacePresentParams = serde_json::from_value(wire).unwrap();
        assert_eq!(back, params);
    }

    #[test]
    fn an_empty_telemetry_claims_no_frame() {
        let params = Telemetry::default().present_params();
        assert_eq!(params.presented_frame_id, None);
        assert_eq!(params.present_fps, None);
        assert!(!params.source_pixels_present);
    }

    #[test]
    fn the_ring_wait_is_three_frame_periods_within_its_bounds() {
        assert_eq!(ring_wait(60), Duration::from_millis(50));
        assert_eq!(ring_wait(30), Duration::from_millis(100));
        assert_eq!(ring_wait(10), Duration::from_millis(250));
        assert_eq!(ring_wait(0), Duration::from_millis(250));
    }

    fn scene(preset: videorc_protocol::LayoutPreset) -> SceneConfigParams {
        let mut params: SceneConfigParams = serde_json::from_value(json!({
            "sources": {"testPattern": true},
            "layout": {
                "layoutPreset": "screen-only", "cameraTransformMode": "preset",
                "cameraTransform": null, "cameraCorner": "bottom-right",
                "cameraSize": "medium", "cameraShape": "rectangle", "cameraMargin": 32,
                "cameraFit": "fill", "cameraMirror": false, "cameraZoom": 100,
                "cameraOffsetX": 0, "cameraOffsetY": 0, "sideBySideSplit": "70-30",
                "sideBySideCameraSide": "right"
            }
        }))
        .unwrap();
        params.layout.layout_preset = preset;
        params
    }

    /// S3.1b: the renderer's reload effect: a change commits once its wait
    /// runs out, the same scene twice commits once, and a hold (a session)
    /// makes the next allowed scene commit again even unchanged.
    #[test]
    fn the_studios_scene_is_committed_on_change_and_again_after_a_hold() {
        use videorc_protocol::LayoutPreset::{ScreenCamera, ScreenOnly};
        let mut policy = ScenePolicy::default();
        let only = scene(ScreenOnly);
        policy.changed(Some(&only));
        assert!(policy.due.is_some(), "the 250 ms wait runs");
        assert_eq!(policy.due(Some(only.clone()), None), Some(only.clone()));
        policy.committed(only.clone());
        policy.changed(Some(&only));
        assert_eq!(policy.due(Some(only.clone()), None), None, "nothing new");
        // A session holds the scene, then ends: the scene comes back.
        policy.changed(None);
        assert_eq!(policy.due(None, None), None, "never while held");
        policy.changed(Some(&only));
        assert_eq!(policy.due(Some(only.clone()), None), Some(only.clone()));
        policy.committed(only.clone());
        // A start that never ran still counts as a hold, as the effect does.
        policy.changed(None);
        policy.changed(Some(&only));
        assert_eq!(policy.due(Some(only.clone()), None), Some(only.clone()));
        policy.committed(only);
        let camera = scene(ScreenCamera);
        policy.changed(Some(&camera));
        assert_eq!(policy.due(Some(camera.clone()), None), Some(camera.clone()));
        // S3.1e: a scene the Studio's transaction committed is adopted, even
        // after a hold (a session's live switch), and never sent again.
        policy.changed(None);
        let only = scene(ScreenOnly);
        policy.changed(Some(&only));
        let commit = (1, only.clone());
        assert_eq!(policy.due(Some(only.clone()), Some(&commit)), None);
        assert_eq!(policy.committed.as_ref(), Some(&only));
        policy.changed(Some(&only));
        assert_eq!(
            policy.due(Some(only.clone()), Some(&commit)),
            None,
            "already the app's"
        );
        // Once only: a session's end commits the Studio's scene again.
        policy.changed(None);
        policy.changed(Some(&only));
        assert_eq!(
            policy.due(Some(only.clone()), Some(&commit)),
            Some(only.clone())
        );
        policy.committed(only.clone());
        assert_eq!(
            policy.due(Some(camera.clone()), Some(&(2, only))),
            Some(camera)
        );
    }

    /// S3.1b: a scene the backend commits on its own is the app's when it is
    /// newer or of another run, never while the feed's own commit is on its
    /// way (its echo can beat its answer).
    #[test]
    fn the_backends_own_scenes_become_the_apps() {
        let mut t = Telemetry::default();
        assert!(
            t.note_backend_scene(Some("run-1"), Some(10)),
            "the first scene"
        );
        assert_eq!(t.renderer_scene_revision, Some(10));
        assert!(
            !t.note_backend_scene(Some("run-1"), Some(9)),
            "an older one"
        );
        assert!(
            !t.note_backend_scene(Some("run-1"), Some(10)),
            "the same one"
        );
        assert!(t.note_backend_scene(Some("run-1"), Some(12)), "a newer one");
        assert!(t.note_backend_scene(Some("run-2"), Some(3)), "another run");
        assert_eq!(t.renderer_scene_revision, Some(3));
        t.scene_commit_in_flight = true;
        assert!(
            !t.note_backend_scene(Some("run-2"), Some(40)),
            "own commit in flight"
        );
        assert!(!t.note_backend_scene(Some("run-2"), None));
        t.scene_commit_in_flight = false;
        assert!(t.note_backend_scene(Some("run-2"), Some(40)));
        assert_eq!(t.scene_adoptions, 4);
    }

    #[test]
    fn a_measurement_counts_only_its_window() {
        let mut t = Telemetry::default();
        let t0 = Instant::now();
        t.note_commit(t0);
        t.presented = 1;
        t.start_measurement();
        for i in 1..=5u64 {
            t.note_commit(t0 + Duration::from_millis(i * 20));
            t.note_latency(3.0);
            t.presented += 1;
        }
        t.frames_rendered = 9;
        t.presented_frame_id = 8;
        let report = t.finish_measurement();
        assert_eq!(report.presented, 5);
        assert_eq!(report.interval.n, 4);
        assert!((report.measured_fps.unwrap() - 50.0).abs() < 0.01);
        assert_eq!(report.input_to_present.p50, Some(3.0));
        assert_eq!(report.compositor_frame_lag, 1);
        assert!(
            t.finish_measurement() == MeasureReport::default(),
            "one window at a time"
        );
        // The present report carries the latencies now.
        assert_eq!(t.present_params().input_to_present_latency_p95_ms, Some(3));
    }

    #[test]
    fn the_surface_says_what_the_scene_shows() {
        use videorc_protocol::LayoutPreset::{ScreenCamera, ScreenOnly};
        let fallback = PreviewSurfaceSource::Synthetic;
        assert_eq!(
            surface_source(None, &fallback),
            PreviewSurfaceSource::Synthetic
        );
        assert_eq!(
            surface_source(Some(&scene(ScreenOnly)), &fallback),
            PreviewSurfaceSource::Synthetic
        );
        let mut screen = scene(ScreenCamera);
        screen.sources.test_pattern = false;
        screen.sources.screen_id = Some("screen:1".into());
        assert_eq!(
            surface_source(Some(&screen), &fallback),
            PreviewSurfaceSource::Screen
        );
        screen.sources.screen_id = None;
        screen.sources.camera_id = Some("cam".into());
        assert_eq!(
            surface_source(Some(&screen), &fallback),
            PreviewSurfaceSource::Camera
        );
    }

    #[test]
    fn the_default_bounds_are_a_visible_720p_slot() {
        let bounds = default_bounds();
        assert_eq!(crate::bounds::render_size(&bounds), (1280, 720));
        assert_eq!(bounds.visible, Some(true));
    }
}
