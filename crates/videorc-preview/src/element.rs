//! The preview element: the layer on the UI thread, the feed on the runtime,
//! and the contracts' watchdog between them.
//!
//! The UI owns a [`PreviewElement`] on its thread: it attaches the layer
//! once the native window exists, places it on the placeholder's rect in
//! the same layout pass, and carries out the two orders the watchdog can
//! only ask the UI thread for (re-place the layer, rebuild the native
//! path). The feed ([`crate::feed`]) runs on the tokio runtime. The
//! watchdog ticks every 750 ms (`FIRST_FRAME_TICK_MS`), builds a
//! [`first_frame::Snapshot`] from the feed's telemetry, runs the first-frame
//! contract until it is met and the presenting watch from then on, executes
//! the healing ladder, and publishes a [`PreviewStatus`] whenever it changes:
//! to the UI (through `notify`), to the log, and on a `watch` channel. A
//! fallback or a stall is a named state with its reason, never a silent
//! placeholder (AGENTS.md "Native Preview Rules").
//!
//! S2.3c: the element has two [`Route`]s. The layer route (the default) is
//! the `CAMetalLayer`; the texture route hands each frame to the UI as a
//! wgpu texture (`feed::TextureSink`) so the UI framework draws it itself
//! and can draw over it (the scene editor's handles). A switch is a
//! [`Handover`]: both sinks run until the new one has shown two frames (so
//! its first is on screen), then the old one stops; the layer hides or
//! shows in that same step. No frame is blank or stale on the way.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(not(target_os = "linux"))]
use raw_window_handle::HasWindowHandle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use videorc_app_core::client::socket::ENGINE_NOT_CONNECTED;
use videorc_app_core::supervisor::BackendState;
use videorc_app_core::{Level, Logger};
use videorc_protocol::PreviewSurfaceBounds;

use crate::LayerRect;
use crate::bounds::{Canvas, WindowGeometry, surface_bounds};
use crate::feed::{Feed, FeedCommand, FeedConfig, FeedReport, Telemetry, TextureSink};
use crate::first_frame::{
    self, Assessment, Budgets, HealingAction, Ledger, Presenting, PresentingWatch,
    PresentingWatchBudgets, Snapshot,
};
#[cfg(target_os = "linux")]
use crate::linux::{NativeHost, Placement, Presenter as LinuxPresenter};
#[cfg(target_os = "macos")]
use crate::macos::{Presenter, VideoLayer};

/// `FIRST_FRAME_TICK_MS`.
pub const TICK: Duration = Duration::from_millis(750);

/// S3.1b: the status's reason while the smokes' suspend holds the surface
/// down (`suspend-native-preview-surface`).
pub const SUSPENDED_REASON: &str = "The preview surface is suspended (smoke harness).";

/// S2.3c: a route handover that has not settled by then settles anyway, with
/// a warning (the new sink shows nothing, so the old one must not hold on).
pub const HANDOVER_TIMEOUT: Duration = Duration::from_millis(1500);
/// S2.3c: the new sink must have drawn this many frames before the old one
/// stops: the first is on screen once the second is drawn.
pub const HANDOVER_FRAMES: u64 = 2;

/// S2.3c: how the preview reaches the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The `CAMetalLayer` presented by the element's own thread (D1's
    /// default; the UI draws nothing per frame).
    Layer,
    /// The UI draws the imported texture itself, so it can draw over the
    /// video (the scene editor); costs CPU per frame while it is on.
    Texture,
}

impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Route::Layer => "layer",
            Route::Texture => "texture",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "layer" => Some(Route::Layer),
            "texture" => Some(Route::Texture),
            _ => None,
        }
    }
}

/// S2.3c: a route switch in flight; both sinks show frames until it settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handover {
    /// Towards the texture route: the layer keeps presenting until the UI has
    /// drawn `drawn` texture frames.
    ToTexture { started_at: Instant, drawn: u64 },
    /// Towards the layer route: the layer presents hidden until it has
    /// committed frames past `layer_presented_before`, then shows.
    ToLayer {
        started_at: Instant,
        layer_presented_before: u64,
    },
}

impl Handover {
    pub fn target(self) -> Route {
        match self {
            Handover::ToTexture { .. } => Route::Texture,
            Handover::ToLayer { .. } => Route::Layer,
        }
    }

    fn started_at(self) -> Instant {
        match self {
            Handover::ToTexture { started_at, .. } | Handover::ToLayer { started_at, .. } => {
                started_at
            }
        }
    }
}

/// Whether the layer is on screen for this route and handover: the settled
/// layer route, or the switch towards the texture route (the layer stays
/// until the texture has drawn).
pub fn layer_shown(route: Route, handover: Option<Handover>) -> bool {
    matches!(
        (route, handover),
        (Route::Layer, None) | (_, Some(Handover::ToTexture { .. }))
    )
}

/// Whether the presenter draws into the layer: whenever the layer is shown,
/// plus the switch towards it (it presents hidden until its first frames).
pub fn layer_presents(route: Route, handover: Option<Handover>) -> bool {
    layer_shown(route, handover) || matches!(handover, Some(Handover::ToLayer { .. }))
}

/// Whether the texture sink is on: the texture route (settled or not) and
/// the switch away from it.
pub fn texture_showing(route: Route, handover: Option<Handover>) -> bool {
    route == Route::Texture || matches!(handover, Some(Handover::ToLayer { .. }))
}

/// What the watchdog asks the UI thread to do.
#[derive(Debug, Clone, PartialEq)]
pub enum UiRequest {
    /// The status changed; show its hint.
    Status(PreviewStatus),
    /// `present-kick`'s UI half: place the layer again.
    Kick,
    /// `reset-native-path`: rebuild the presenter and the layer
    /// ([`PreviewElement::reset_native_path`]).
    ResetNativePath,
}

/// Where the preview is, for people.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No backend connection yet, or it dropped.
    Disconnected,
    /// The first-frame contract is pending.
    Starting,
    /// The chain agrees and advances.
    Presenting,
    /// A healing action is running.
    Healing,
    /// The presenting watch exhausted its ladder; the watch goes on.
    Stalled,
    /// The first-frame contract failed within its budget.
    Fallback,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Disconnected => "disconnected",
            Phase::Starting => "starting",
            Phase::Presenting => "presenting",
            Phase::Healing => "healing",
            Phase::Stalled => "stalled",
            Phase::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreviewStatus {
    pub phase: Phase,
    /// The truthful reason (`first_frame::blocked_reason`), or the error:
    /// the log's and `preview-window-state`'s, never a slot's (S3.0h).
    pub reason: Option<String>,
    pub presented_frame_id: u64,
    pub present_fps: Option<f64>,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl PreviewStatus {
    pub fn initial() -> Self {
        Self {
            phase: Phase::Disconnected,
            reason: Some(ENGINE_NOT_CONNECTED.to_string()),
            presented_frame_id: 0,
            present_fps: None,
            frame_width: 0,
            frame_height: 0,
        }
    }

    /// One line for the log. The slots never show the reason: they say
    /// the phase in the renderer's words ([`crate::words`], S3.0h).
    pub fn describe(&self) -> String {
        let mut text = self.phase.as_str().to_string();
        if let Some(reason) = &self.reason {
            text.push_str(": ");
            text.push_str(reason);
        }
        if self.phase == Phase::Presenting {
            text.push_str(&format!(
                " ({}x{}, frame {}{})",
                self.frame_width,
                self.frame_height,
                self.presented_frame_id,
                self.present_fps
                    .map(|fps| format!(", {fps:.1} fps"))
                    .unwrap_or_default()
            ));
        }
        text
    }
}

/// How the element is set up.
pub struct ElementConfig {
    pub feed: FeedConfig,
    pub canvas: Canvas,
    /// The slot's corner radius in points, for the surface's record.
    pub corner_radius: f64,
    /// Delivers the watchdog's requests to the UI thread.
    pub notify: Arc<dyn Fn(UiRequest) + Send + Sync>,
    /// S2.3c: the texture route's sink, when the UI has a wgpu device to
    /// import into; without one the texture route is refused by name.
    pub texture: Option<TextureSink>,
    pub logger: Logger,
}

/// The native half: the Metal presenter and the CAMetalLayer on macOS; the
/// Linux presenter (plan 220 S4.2c: a `wl_subsurface` or an X11 child
/// window over the CPU ring, `crate::linux`); nothing yet on Windows (plan
/// 220 S4.1d: the CPU route draws through the texture sink; S4.1c adds the
/// Windows presenter).
#[cfg(target_os = "macos")]
struct Native {
    presenter: Option<Presenter>,
    layer: Option<VideoLayer>,
}

/// Linux: the presenter exists from `attach` on (it is the child of one
/// host window); `presents` is what the feed was last told.
#[cfg(target_os = "linux")]
struct Native {
    presenter: Option<LinuxPresenter>,
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
struct Native;

#[cfg(target_os = "macos")]
impl Native {
    fn start() -> Result<Self, String> {
        let presenter = Presenter::start().map_err(|error| format!("Metal presenter: {error}"))?;
        Ok(Self {
            presenter: Some(presenter),
            layer: None,
        })
    }

    fn client(&self) -> Option<crate::macos::PresenterClient> {
        self.presenter.as_ref().map(Presenter::client)
    }

    fn has_layer(&self) -> bool {
        self.layer.is_some()
    }

    fn set_frame(&mut self, rect: LayerRect, _geometry: &WindowGeometry) -> bool {
        match self.layer.as_mut() {
            Some(layer) => layer.set_frame(rect),
            None => false,
        }
    }

    fn set_hidden(&mut self, hidden: bool) {
        if let Some(layer) = self.layer.as_mut() {
            layer.set_hidden(hidden);
        }
    }

    fn reapply_frame(&mut self) {
        if let Some(layer) = self.layer.as_mut() {
            layer.reapply_frame();
        }
    }

    fn drawable(&self) -> Option<((f64, f64), f64)> {
        self.layer
            .as_ref()
            .map(|layer| (layer.drawable_size(), layer.scale()))
    }

    fn frame(&self) -> Option<LayerRect> {
        self.layer.as_ref().and_then(VideoLayer::frame)
    }

    fn displayed_frame(&self) -> Option<LayerRect> {
        self.layer.as_ref().and_then(VideoLayer::displayed_frame)
    }

    fn display_max_fps(&self) -> Option<u32> {
        self.layer.as_ref().and_then(Presenter::display_max_fps)
    }

    fn screen_height(&self) -> Option<f64> {
        self.layer.as_ref().and_then(VideoLayer::screen_height)
    }

    /// Tells the presenter which layer to draw into.
    fn present_into_layer(&self, presents: bool) {
        if let Some(presenter) = &self.presenter {
            match (&self.layer, presents) {
                (Some(layer), true) => presenter.add_layer(0, layer),
                _ => presenter.remove_layer(0),
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Native {
    fn start() -> Result<Self, String> {
        Ok(Self { presenter: None })
    }

    fn client(&self) -> Option<crate::linux::PresenterClient> {
        self.presenter.as_ref().map(LinuxPresenter::client)
    }

    fn has_layer(&self) -> bool {
        self.presenter.is_some()
    }

    /// The child follows the slot: logical points, and the window's scale
    /// for the X11 child (device pixels).
    fn set_frame(&mut self, rect: LayerRect, geometry: &WindowGeometry) -> bool {
        match self.presenter.as_mut() {
            Some(presenter) => presenter.set_placement(Placement {
                rect,
                scale: geometry.scale_factor,
            }),
            None => false,
        }
    }

    fn set_hidden(&mut self, hidden: bool) {
        if let Some(presenter) = self.presenter.as_mut() {
            presenter.set_hidden(hidden);
        }
    }

    fn reapply_frame(&mut self) {
        if let Some(presenter) = self.presenter.as_ref() {
            presenter.reapply_placement();
        }
    }

    /// The child's size in device pixels, and the scale.
    fn drawable(&self) -> Option<((f64, f64), f64)> {
        let placement = self.presenter.as_ref()?.placement()?;
        Some((
            (
                placement.rect.width * placement.scale,
                placement.rect.height * placement.scale,
            ),
            placement.scale,
        ))
    }

    fn frame(&self) -> Option<LayerRect> {
        Some(self.presenter.as_ref()?.placement()?.rect)
    }

    fn displayed_frame(&self) -> Option<LayerRect> {
        self.frame()
    }

    fn display_max_fps(&self) -> Option<u32> {
        None
    }

    fn screen_height(&self) -> Option<f64> {
        None
    }

    /// The feed is told through `apply_sinks` (the presenter's client goes
    /// with the CPU ring's reader); nothing to do on the native half.
    fn present_into_layer(&self, _presents: bool) {}

    /// What the surface's status names, once attached.
    fn backing(&self) -> Option<crate::linux::Backing> {
        self.presenter.as_ref().map(LinuxPresenter::backing)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl Native {
    fn start() -> Result<Self, String> {
        Ok(Self)
    }

    fn has_layer(&self) -> bool {
        false
    }

    fn set_frame(&mut self, _rect: LayerRect, _geometry: &WindowGeometry) -> bool {
        false
    }

    fn set_hidden(&mut self, _hidden: bool) {}

    fn reapply_frame(&mut self) {}

    fn drawable(&self) -> Option<((f64, f64), f64)> {
        None
    }

    fn frame(&self) -> Option<LayerRect> {
        None
    }

    fn displayed_frame(&self) -> Option<LayerRect> {
        None
    }

    fn display_max_fps(&self) -> Option<u32> {
        None
    }

    fn screen_height(&self) -> Option<f64> {
        None
    }

    fn present_into_layer(&self, _presents: bool) {}
}

/// What this platform's element has for the layer route.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const LAYER_ROUTE_UNAVAILABLE: &str = "the layer route has no presenter on this platform yet (plan 220 S4.1c); the CPU preview draws on the texture route";

/// The element, owned by the UI thread.
pub struct PreviewElement {
    handle: tokio::runtime::Handle,
    feed: Option<Feed>,
    native: Native,
    rect: Option<LayerRect>,
    geometry: Option<WindowGeometry>,
    canvas: Canvas,
    corner_radius: f64,
    /// The host's visibility decision (S2.3b: a docked preview hides on
    /// purpose behind a dialog; the reason is the host's to report).
    visible: bool,
    /// The bounds last handed to the feed (the status reports them).
    last_bounds: Option<PreviewSurfaceBounds>,
    /// S2.3c: the route asked for, the switch in flight, and the sink.
    route: Route,
    handover: Option<Handover>,
    texture: Option<TextureSink>,
    watchdog: Option<JoinHandle<()>>,
    status: watch::Receiver<PreviewStatus>,
    logger: Logger,
}

impl PreviewElement {
    /// Starts the presenter, the feed and the watchdog. Fails when Metal is
    /// unavailable: the caller shows that reason (never a silent downgrade).
    /// Off macOS there is no presenter: the element starts on the texture
    /// route and needs its sink, or refuses by name.
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        config: ElementConfig,
    ) -> Result<Self, String> {
        let native = Native::start()?;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        if config.texture.is_none() {
            return Err(format!(
                "{LAYER_ROUTE_UNAVAILABLE}, and the texture route has no wgpu device to upload into"
            ));
        }
        #[cfg(target_os = "macos")]
        let feed = Feed::start(handle, state, config.feed, native.client());
        #[cfg(not(target_os = "macos"))]
        let feed = Feed::start(handle, state, config.feed);
        // S4.2c: Linux starts on the layer route too (the presenter comes
        // with the first `attach`); the host falls back to the texture
        // route, by name, when no window system takes a child.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let route = Route::Layer;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let route = Route::Texture;
        let (status_tx, status) = watch::channel(PreviewStatus::initial());
        let watchdog = handle.spawn(watchdog(
            feed.telemetry_handle(),
            feed.sender(),
            config.notify,
            config.logger.clone(),
            status_tx,
        ));
        let mut element = Self {
            handle: handle.clone(),
            feed: Some(feed),
            native,
            rect: None,
            geometry: None,
            canvas: config.canvas,
            corner_radius: config.corner_radius,
            visible: true,
            last_bounds: None,
            route,
            handover: None,
            texture: config.texture,
            watchdog: Some(watchdog),
            status,
            logger: config.logger,
        };
        if route == Route::Texture {
            // The sink is on from the first frame (no layer to hand over from).
            element.apply_sinks();
        }
        Ok(element)
    }

    // --- S2.3c: the routes ---

    /// The route asked for (the target while a handover is in flight).
    pub fn route(&self) -> Route {
        self.route
    }

    pub fn handover(&self) -> Option<Handover> {
        self.handover
    }

    /// Whether the UI should draw the texture (and keep the Image bound).
    pub fn texture_showing(&self) -> bool {
        texture_showing(self.route, self.handover)
    }

    /// Whether the layer is on screen right now.
    pub fn layer_shown(&self) -> bool {
        layer_shown(self.route, self.handover)
    }

    /// Whether the texture route can be used at all.
    pub fn texture_route_available(&self) -> bool {
        self.texture.is_some()
    }

    /// Switches the route. Towards the texture route: the texture sink
    /// starts and the layer keeps presenting until [`texture_frame_drawn`]
    /// (Self::texture_frame_drawn) has counted `HANDOVER_FRAMES`. Towards the
    /// layer route: the presenter draws into the hidden layer until it has
    /// committed `HANDOVER_FRAMES`, then the layer shows and the texture sink
    /// stops ([`tick_handover`](Self::tick_handover) watches for that).
    /// A switch during a handover reverses it on the spot. Refuses the
    /// texture route when no device was given.
    pub fn set_route(&mut self, route: Route) -> Result<(), String> {
        if route == Route::Texture && self.texture.is_none() {
            return Err("the texture route has no wgpu device to import into".to_string());
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        if route == Route::Layer {
            return Err(LAYER_ROUTE_UNAVAILABLE.to_string());
        }
        if self.route == route {
            return Ok(());
        }
        let now = Instant::now();
        let previous = self.route;
        self.route = route;
        match (route, self.handover) {
            (Route::Texture, None) => {
                if let (Some(feed), Some(sink)) = (&self.feed, &self.texture) {
                    feed.send(FeedCommand::TextureSink(Some(sink.clone())));
                }
                self.handover = Some(Handover::ToTexture {
                    started_at: now,
                    drawn: 0,
                });
            }
            (Route::Texture, Some(Handover::ToLayer { .. })) => {
                // Reversed before the layer showed: the texture sink is still
                // on; the layer stops again.
                self.handover = None;
                self.apply_sinks();
            }
            (Route::Layer, None) => {
                self.handover = Some(Handover::ToLayer {
                    started_at: now,
                    layer_presented_before: self.telemetry().layer_presented,
                });
                self.apply_sinks();
            }
            (Route::Layer, Some(Handover::ToTexture { .. })) => {
                // Reversed before the layer hid: the layer never stopped; the
                // texture sink goes.
                self.handover = None;
                if let Some(feed) = &self.feed {
                    feed.send(FeedCommand::TextureSink(None));
                }
            }
            (Route::Texture, Some(Handover::ToTexture { .. }))
            | (Route::Layer, Some(Handover::ToLayer { .. })) => {}
        }
        self.apply_layer_hidden();
        self.logger.log(
            Level::Info,
            &format!(
                "[preview] route: {} -> {} ({})",
                previous.as_str(),
                route.as_str(),
                match self.handover {
                    Some(_) => "handover started, both routes show until the new one has drawn",
                    None => "settled",
                }
            ),
        );
        Ok(())
    }

    /// The UI drew a frame with a texture bound (its rendering notifier's
    /// `AfterRendering`, or the next bind when there is none). Settles a
    /// handover towards the texture route after `HANDOVER_FRAMES`. Returns
    /// true when the handover settled on this call.
    pub fn texture_frame_drawn(&mut self) -> bool {
        let Some(Handover::ToTexture { started_at, drawn }) = self.handover else {
            return false;
        };
        let drawn = drawn + 1;
        if drawn < HANDOVER_FRAMES {
            self.handover = Some(Handover::ToTexture { started_at, drawn });
            return false;
        }
        self.settle(&format!(
            "the texture route drew {drawn} frames in {:.0} ms; the layer hides",
            started_at.elapsed().as_secs_f64() * 1000.0
        ));
        true
    }

    /// Watches a handover towards the layer route (the layer's commits) and
    /// the timeout of either. Returns true when the handover settled on this
    /// call.
    pub fn tick_handover(&mut self) -> bool {
        let Some(handover) = self.handover else {
            return false;
        };
        if let Handover::ToLayer {
            started_at,
            layer_presented_before,
        } = handover
        {
            let committed = self
                .telemetry()
                .layer_presented
                .saturating_sub(layer_presented_before);
            if committed >= HANDOVER_FRAMES {
                self.settle(&format!(
                    "the layer committed {committed} frames in {:.0} ms; it shows and the texture route stops",
                    started_at.elapsed().as_secs_f64() * 1000.0
                ));
                return true;
            }
        }
        if handover.started_at().elapsed() >= HANDOVER_TIMEOUT {
            self.logger.log(
                Level::Warn,
                &format!(
                    "[preview] route handover to {} did not settle within {HANDOVER_TIMEOUT:?}: settling anyway",
                    handover.target().as_str()
                ),
            );
            self.settle("timed out");
            return true;
        }
        false
    }

    /// Ends the handover: the sinks and the layer's visibility follow the
    /// settled route.
    fn settle(&mut self, why: &str) {
        self.handover = None;
        self.apply_sinks();
        self.apply_layer_hidden();
        self.logger.log(
            Level::Info,
            &format!("[preview] route: {} settled: {why}", self.route.as_str()),
        );
    }

    /// Tells the feed which sinks are on for the current route and handover,
    /// and the presenter which layer to draw into.
    fn apply_sinks(&mut self) {
        let presents = layer_presents(self.route, self.handover);
        let texture = texture_showing(self.route, self.handover);
        self.native.present_into_layer(presents);
        if let Some(feed) = &self.feed {
            #[cfg(target_os = "macos")]
            feed.send(FeedCommand::Presenter(
                presents.then(|| self.native.client()).flatten(),
            ));
            #[cfg(target_os = "linux")]
            feed.send(FeedCommand::CpuPresenter(
                presents.then(|| self.native.client()).flatten(),
            ));
            feed.send(FeedCommand::TextureSink(
                texture.then(|| self.texture.clone()).flatten(),
            ));
        }
    }

    /// The layer's hidden flag: the host's decision and the route's.
    fn apply_layer_hidden(&mut self) {
        let shown = self.visible && layer_shown(self.route, self.handover);
        self.native.set_hidden(!shown);
    }

    /// Adds the layer to the window (main thread, after the native window
    /// exists) and places it on the rect given so far. A layer in another
    /// window is removed first: the element has one layer, in one host, and
    /// moving it between windows never touches the backend's surface
    /// (S2.3b's dock and undock).
    #[cfg(target_os = "macos")]
    pub fn attach(&mut self, window: &dyn HasWindowHandle) -> Result<(), String> {
        let presenter = self
            .native
            .presenter
            .as_ref()
            .ok_or_else(|| "the presenter is down".to_string())?;
        self.native.layer = None;
        let mut layer = VideoLayer::attach(window, presenter.device())?;
        layer.set_hidden(!(self.visible && layer_shown(self.route, self.handover)));
        if layer_presents(self.route, self.handover) {
            presenter.add_layer(0, &layer);
        }
        self.native.layer = Some(layer);
        if let (Some(rect), Some(geometry)) = (self.rect, self.geometry) {
            self.place(rect, geometry);
        }
        Ok(())
    }

    /// Plan 220 S4.2c, Linux: builds the presenter's child in `window` (a
    /// subsurface under Wayland, a child window under X11) and places it on
    /// the rect given so far; a child in another window goes first. The
    /// feed's CPU reader gets the presenter when the layer route presents.
    /// A window system that takes no child is the error, by name: the host
    /// falls back to the texture route and says so.
    #[cfg(target_os = "linux")]
    pub fn attach(&mut self, window: &dyn NativeHost) -> Result<(), String> {
        self.native.presenter = None;
        let mut presenter = LinuxPresenter::attach(window)?;
        presenter.set_hidden(!(self.visible && layer_shown(self.route, self.handover)));
        self.logger.log(
            Level::Info,
            &format!(
                "[preview] Linux presenter attached: {} (never a native GPU surface)",
                presenter.backing().as_str()
            ),
        );
        self.native.presenter = Some(presenter);
        if let (Some(rect), Some(geometry)) = (self.rect, self.geometry) {
            self.place(rect, geometry);
        }
        self.apply_sinks();
        Ok(())
    }

    /// Off macOS and Linux there is no layer to add: the texture route needs
    /// no window handle, and the refusal names the missing presenter.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn attach(&mut self, _window: &dyn HasWindowHandle) -> Result<(), String> {
        Err(LAYER_ROUTE_UNAVAILABLE.to_string())
    }

    /// Plan 220 S4.2c: the surface the presenter has, named for the status.
    #[cfg(target_os = "linux")]
    pub fn native_backing(&self) -> Option<crate::linux::Backing> {
        self.native.backing()
    }

    /// Plan 220 S4.2c: the host's reason for drawing on the texture route
    /// (the window system took no child); `None` clears it. The surface's
    /// status carries it in its message.
    pub fn set_native_fallback_reason(&self, reason: Option<String>) {
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::CpuFallbackReason(reason));
        }
    }

    /// Takes the layer out of its window; the presenter stops drawing until
    /// the next [`attach`](Self::attach). The feed and the surface stay.
    pub fn detach(&mut self) {
        #[cfg(target_os = "macos")]
        {
            self.native.layer = None;
        }
        #[cfg(target_os = "linux")]
        {
            self.native.presenter = None;
            if let Some(feed) = &self.feed {
                feed.send(FeedCommand::CpuPresenter(None));
            }
        }
        self.rect = None;
        self.geometry = None;
        self.native.present_into_layer(false);
    }

    pub fn attached(&self) -> bool {
        self.native.has_layer()
    }

    /// The UI laid the placeholder out: the layer follows in the same pass,
    /// and the surface's bounds follow the layer. Returns true when the
    /// layer's frame changed.
    pub fn place(&mut self, rect: LayerRect, geometry: WindowGeometry) -> bool {
        self.rect = Some(rect);
        self.geometry = Some(geometry);
        let changed = self.native.set_frame(rect, &geometry);
        self.send_bounds();
        changed
    }

    fn send_bounds(&mut self) {
        let (Some(rect), Some(geometry)) = (self.rect, self.geometry) else {
            return;
        };
        let mut bounds = surface_bounds(&geometry, rect, self.canvas, self.corner_radius);
        bounds.visible = Some(self.visible && rect.width > 0.0 && rect.height > 0.0);
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::Bounds(bounds.clone()));
        }
        self.last_bounds = Some(bounds);
    }

    /// The host's visibility decision: a hidden layer draws nothing and the
    /// surface's record says `visible: false`. The reason is the host's.
    pub fn set_visible(&mut self, visible: bool) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        self.apply_layer_hidden();
        self.send_bounds();
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    /// The host's corner radius (the rounded slot; square in the Preview
    /// window), for the surface's record.
    pub fn set_corner_radius(&mut self, radius: f64) {
        if self.corner_radius == radius {
            return;
        }
        self.corner_radius = radius;
        self.send_bounds();
    }

    /// The bounds last handed to the feed.
    pub fn last_bounds(&self) -> Option<&PreviewSurfaceBounds> {
        self.last_bounds.as_ref()
    }

    /// The layer's drawable in backing pixels, and its contents scale.
    pub fn drawable(&self) -> Option<((f64, f64), f64)> {
        self.native.drawable()
    }

    /// Whether the presenter committed a frame within `within` (Electron's
    /// placement authority: `NATIVE_PREVIEW_NATIVE_AUTHORITY_MS`).
    pub fn presented_within(&self, within: Duration) -> bool {
        self.telemetry()
            .last_commit_at
            .is_some_and(|at| at.elapsed() <= within)
    }

    /// `present-kick`'s UI half: the layer's frame again, in one transaction.
    pub fn kick(&mut self) {
        self.native.reapply_frame();
    }

    /// `reset-native-path`: the presenter and the layer are retired and built
    /// again, and the feed gets a fresh surface. A failure leaves the native
    /// path down with its reason in the status.
    #[cfg(target_os = "macos")]
    pub fn reset_native_path(&mut self, window: &dyn HasWindowHandle) -> Result<(), String> {
        self.logger.log(
            Level::Warn,
            "[preview] reset-native-path: rebuilding the presenter and the layer",
        );
        self.native.layer = None;
        self.native.presenter = None;
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::Presenter(None));
        }
        let presenter = Presenter::start().map_err(|error| format!("Metal presenter: {error}"))?;
        if let Some(feed) = &self.feed {
            if layer_presents(self.route, self.handover) {
                feed.send(FeedCommand::Presenter(Some(presenter.client())));
            }
            feed.send(FeedCommand::RecreateSurface);
        }
        self.native.presenter = Some(presenter);
        self.attach(window)
    }

    /// `reset-native-path` on Linux (S4.2c): the presenter's child is taken
    /// down and built again in `window`, and the feed gets a fresh surface
    /// (the CPU ring reader its next ring).
    #[cfg(target_os = "linux")]
    pub fn reset_native_path(&mut self, window: &dyn NativeHost) -> Result<(), String> {
        self.logger.log(
            Level::Warn,
            "[preview] reset-native-path: rebuilding the presenter's child and the surface",
        );
        self.native.presenter = None;
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::CpuPresenter(None));
            feed.send(FeedCommand::RecreateSurface);
        }
        self.attach(window)
    }

    /// `reset-native-path` off macOS and Linux: no presenter to rebuild; the
    /// feed gets a fresh surface (and the CPU ring reader its next ring).
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn reset_native_path(&mut self, _window: &dyn HasWindowHandle) -> Result<(), String> {
        self.logger.log(
            Level::Warn,
            "[preview] reset-native-path: no presenter on this platform; the surface is recreated",
        );
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::RecreateSurface);
        }
        Ok(())
    }

    /// The frame the UI last set.
    pub fn frame(&self) -> Option<LayerRect> {
        self.native.frame()
    }

    /// The frame Core Animation currently displays (the resize oracle).
    pub fn displayed_frame(&self) -> Option<LayerRect> {
        self.native.displayed_frame()
    }

    /// The display's refresh rate behind the window.
    pub fn display_max_fps(&self) -> Option<u32> {
        self.native.display_max_fps()
    }

    /// The screen's height in points, for [`WindowGeometry`].
    pub fn screen_height(&self) -> Option<f64> {
        self.native.screen_height()
    }

    pub fn status(&self) -> PreviewStatus {
        self.status.borrow().clone()
    }

    pub fn status_watch(&self) -> watch::Receiver<PreviewStatus> {
        self.status.clone()
    }

    pub fn telemetry(&self) -> Telemetry {
        self.feed.as_ref().map(Feed::telemetry).unwrap_or_default()
    }

    /// S3.1b: the feed's telemetry itself, for a measurement that runs off
    /// the UI thread.
    pub fn telemetry_handle(&self) -> Option<Arc<Mutex<Telemetry>>> {
        self.feed.as_ref().map(Feed::telemetry_handle)
    }

    /// S3.1b: commits the Studio's scene now (Retry preview, the scene
    /// exercise); the answer is the revision, or why not.
    pub fn commit_scene(&self) -> tokio::sync::oneshot::Receiver<Result<u64, String>> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        match &self.feed {
            Some(feed) => feed.send(FeedCommand::CommitScene(reply)),
            None => {
                let _ = reply.send(Err("The preview is stopped.".to_string()));
            }
        }
        answer
    }

    /// S3.1b: the smokes' suspend (the surface goes down and stays down)
    /// and resume.
    pub fn suspend(&self, on: bool) {
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::Suspend(on));
        }
    }

    /// S3.1b: destroys and creates the backend's surface (the surface loss
    /// the smokes exercise); the feed, the presenter and the layer stay.
    pub fn recreate_surface(&self) {
        if let Some(feed) = &self.feed {
            feed.send(FeedCommand::RecreateSurface);
        }
    }

    /// S3.1b: the compositor's status now.
    pub fn read_compositor_status(
        &self,
    ) -> tokio::sync::oneshot::Receiver<Result<videorc_protocol::CompositorStatus, String>> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        match &self.feed {
            Some(feed) => feed.send(FeedCommand::ReadCompositorStatus(reply)),
            None => {
                let _ = reply.send(Err("The preview is stopped.".to_string()));
            }
        }
        answer
    }

    /// S3.1b: takes the backend's queued native host commands.
    pub fn drain_host_commands(
        &self,
    ) -> tokio::sync::oneshot::Receiver<Result<Vec<serde_json::Value>, String>> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        match &self.feed {
            Some(feed) => feed.send(FeedCommand::DrainHostCommands(reply)),
            None => {
                let _ = reply.send(Err("The preview is stopped.".to_string()));
            }
        }
        answer
    }

    /// The run's numbers (blocks the calling thread briefly; not for a
    /// runtime thread).
    pub fn report_blocking(&self) -> Option<FeedReport> {
        let feed = self.feed.as_ref()?;
        self.handle
            .block_on(tokio::time::timeout(Duration::from_secs(5), feed.report()))
            .ok()
            .flatten()
    }

    /// Stops the feed (lease released, surface destroyed), the watchdog, the
    /// presenter and the layer.
    pub fn stop(mut self) {
        if let Some(watchdog) = self.watchdog.take() {
            watchdog.abort();
        }
        if let Some(feed) = self.feed.take() {
            self.handle.block_on(feed.stop());
        }
        #[cfg(target_os = "macos")]
        {
            self.native.layer = None;
            self.native.presenter = None;
        }
        #[cfg(target_os = "linux")]
        {
            self.native.presenter = None;
        }
    }
}

enum Mode {
    FirstFrame { started_at: Instant, ledger: Ledger },
    Presenting { watch: PresentingWatch },
}

async fn watchdog(
    telemetry: Arc<Mutex<Telemetry>>,
    commands: tokio::sync::mpsc::UnboundedSender<FeedCommand>,
    notify: Arc<dyn Fn(UiRequest) + Send + Sync>,
    logger: Logger,
    status_tx: watch::Sender<PreviewStatus>,
) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut mode = Mode::FirstFrame {
        started_at: Instant::now(),
        ledger: Ledger::default(),
    };
    let mut was_connected = false;
    let mut last_frames_rendered: Option<u64> = None;
    let mut last_presented: Option<u64> = None;
    let mut current = PreviewStatus::initial();
    let publish = |next: PreviewStatus, current: &mut PreviewStatus| {
        let changed = next.phase != current.phase || next.reason != current.reason;
        if changed {
            let level = match next.phase {
                Phase::Fallback | Phase::Stalled => Level::Error,
                Phase::Healing | Phase::Disconnected => Level::Warn,
                Phase::Starting | Phase::Presenting => Level::Info,
            };
            logger.log(level, &format!("[preview] {}", next.describe()));
            notify(UiRequest::Status(next.clone()));
        }
        let _ = status_tx.send(next.clone());
        *current = next;
    };
    loop {
        tick.tick().await;
        let t = match telemetry.lock() {
            Ok(t) => t.clone(),
            Err(_) => continue,
        };
        let base = |phase: Phase, reason: Option<String>| PreviewStatus {
            phase,
            reason,
            presented_frame_id: t.presented_frame_id,
            present_fps: t.present_fps(),
            frame_width: t.frame_width,
            frame_height: t.frame_height,
        };
        if !t.connected {
            was_connected = false;
            last_frames_rendered = None;
            last_presented = None;
            let reason = t
                .last_error
                .clone()
                .unwrap_or_else(|| ENGINE_NOT_CONNECTED.to_string());
            publish(base(Phase::Disconnected, Some(reason)), &mut current);
            continue;
        }
        if t.suspended {
            // S3.1b: the smokes' suspend holds the surface down on purpose:
            // nothing to heal, and the resume starts the contract again.
            was_connected = false;
            last_frames_rendered = None;
            last_presented = None;
            publish(
                base(Phase::Starting, Some(SUSPENDED_REASON.to_string())),
                &mut current,
            );
            continue;
        }
        if !was_connected {
            // A fresh session: the first-frame contract starts again.
            was_connected = true;
            mode = Mode::FirstFrame {
                started_at: Instant::now(),
                ledger: Ledger::default(),
            };
        }
        let frames_advancing = t.frames_rendered > 0
            && last_frames_rendered.is_none_or(|last| t.frames_rendered > last);
        let presentation_advancing = t.presented_frame_id > 0
            && last_presented.is_none_or(|last| t.presented_frame_id > last);
        last_frames_rendered = Some(t.frames_rendered);
        last_presented = Some(t.presented_frame_id);
        let snapshot = Snapshot {
            elapsed_ms: 0,
            surface_live: t.surface_live,
            native_presenting: t.presenter_attached,
            frames_advancing,
            presentation_advancing,
            renderer_scene_revision: t.renderer_scene_revision,
            compositor_scene_revision: t.compositor_scene_revision,
            compositor_frame_scene_revision: t.compositor_frame_scene_revision,
            metal_target_present: t.metal_target_present,
        };
        let mut next_mode = None;
        let next = match &mut mode {
            Mode::FirstFrame { started_at, ledger } => {
                let snapshot = Snapshot {
                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                    ..snapshot
                };
                let (assessment, next_ledger) = first_frame::assess_first_frame(
                    &snapshot,
                    ledger,
                    &Budgets::FIRST_FRAME,
                    false,
                );
                *ledger = next_ledger;
                match assessment {
                    Assessment::Met => {
                        next_mode = Some(Mode::Presenting {
                            watch: PresentingWatch::default(),
                        });
                        base(Phase::Presenting, None)
                    }
                    Assessment::Pending { reason } => base(Phase::Starting, Some(reason)),
                    Assessment::Heal { action, reason } => {
                        heal(action, &reason, &commands, &notify, &logger);
                        base(Phase::Healing, Some(reason))
                    }
                    Assessment::Fallback { reason } => {
                        // Declared, with the blocked link; the presenting
                        // watch takes over so a revival is still noticed.
                        next_mode = Some(Mode::Presenting {
                            watch: PresentingWatch::default(),
                        });
                        base(Phase::Fallback, Some(reason))
                    }
                }
            }
            Mode::Presenting { watch } => {
                let (presenting, next_watch) = first_frame::assess_presenting(
                    &snapshot,
                    watch,
                    TICK.as_millis() as u64,
                    &PresentingWatchBudgets::DEFAULT,
                );
                *watch = next_watch;
                match presenting {
                    Presenting::Presenting => base(Phase::Presenting, None),
                    // Below the threshold: silent, the status stays.
                    Presenting::Observing { .. } => {
                        let mut status = base(current.phase, current.reason.clone());
                        if current.phase == Phase::Presenting {
                            status.reason = None;
                        }
                        status
                    }
                    Presenting::Heal { action, reason } => {
                        heal(action, &reason, &commands, &notify, &logger);
                        base(Phase::Healing, Some(reason))
                    }
                    Presenting::Stalled { reason } => base(Phase::Stalled, Some(reason)),
                }
            }
        };
        if let Some(next_mode) = next_mode {
            mode = next_mode;
        }
        publish(next, &mut current);
    }
}

fn heal(
    action: HealingAction,
    reason: &str,
    commands: &tokio::sync::mpsc::UnboundedSender<FeedCommand>,
    notify: &Arc<dyn Fn(UiRequest) + Send + Sync>,
    logger: &Logger,
) {
    logger.log(
        Level::Warn,
        &format!("[preview] healing: {} ({reason})", action.as_str()),
    );
    match action {
        HealingAction::PresentKick => {
            let _ = commands.send(FeedCommand::Kick);
            notify(UiRequest::Kick);
        }
        HealingAction::ResyncScene => {
            let _ = commands.send(FeedCommand::ResyncScene);
        }
        HealingAction::ResetNativePath => notify(UiRequest::ResetNativePath),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_routes_name_themselves() {
        assert_eq!(Route::parse("layer"), Some(Route::Layer));
        assert_eq!(Route::parse("texture"), Some(Route::Texture));
        assert_eq!(Route::parse("Texture"), None);
        assert_eq!(Route::Layer.as_str(), "layer");
        assert_eq!(Route::Texture.as_str(), "texture");
    }

    /// The handover table: the old route keeps showing until the new one has
    /// drawn; the layer presents hidden on its way back.
    #[test]
    fn the_layer_shows_and_presents_by_route_and_handover() {
        let now = Instant::now();
        let towards_texture = Handover::ToTexture {
            started_at: now,
            drawn: 0,
        };
        let towards_layer = Handover::ToLayer {
            started_at: now,
            layer_presented_before: 0,
        };
        let to_texture = Some(towards_texture);
        let to_layer = Some(towards_layer);
        // Settled layer route: the layer shows and presents, no texture.
        assert!(layer_shown(Route::Layer, None));
        assert!(layer_presents(Route::Layer, None));
        assert!(!texture_showing(Route::Layer, None));
        // Towards the texture route: the layer stays until the texture drew.
        assert!(layer_shown(Route::Texture, to_texture));
        assert!(layer_presents(Route::Texture, to_texture));
        assert!(texture_showing(Route::Texture, to_texture));
        // Settled texture route: the layer is hidden and idle.
        assert!(!layer_shown(Route::Texture, None));
        assert!(!layer_presents(Route::Texture, None));
        assert!(texture_showing(Route::Texture, None));
        // Towards the layer route: the layer presents hidden, the texture
        // keeps showing.
        assert!(!layer_shown(Route::Layer, to_layer));
        assert!(layer_presents(Route::Layer, to_layer));
        assert!(texture_showing(Route::Layer, to_layer));
        assert_eq!(towards_texture.target(), Route::Texture);
        assert_eq!(towards_layer.target(), Route::Layer);
    }

    #[test]
    fn the_reason_reaches_the_log_line_and_the_slot_says_the_phase() {
        let mut status = PreviewStatus::initial();
        assert_eq!(status.phase, Phase::Disconnected);
        assert_eq!(status.reason.as_deref(), Some(ENGINE_NOT_CONNECTED));
        assert_eq!(
            crate::words::phase(status.phase),
            Some(crate::words::OPENING)
        );
        status.phase = Phase::Fallback;
        status.reason = Some("Compositor frames are not advancing.".to_string());
        assert!(status.describe().starts_with("fallback: Compositor"));
        assert_eq!(
            crate::words::phase(status.phase),
            Some(crate::words::FAILED)
        );
        status.phase = Phase::Presenting;
        status.reason = None;
        assert_eq!(crate::words::phase(status.phase), None);
    }
}
