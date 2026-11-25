//! The preview element's GPUI side (plan 260 S2.3a, lane L1): the docked
//! slot on the Studio page and the floating Preview window, both showing
//! `videorc-preview`'s element: on macOS a `CAMetalLayer` presented on its
//! own thread from the backend's IOSurface ring, with the first-frame and
//! presenting contracts and their healing ladder. GPUI never redraws per
//! video frame; it notifies only when the slot's words change.
//!
//! What each slot says while no frame shows is `videorc_preview::words`,
//! Electron's `preview-stage.tsx` byte for byte: "Opening preview…" while
//! the first-frame contract runs, "Preview failed" once it declares its
//! fallback, and the floating window's cards on the Studio page while the
//! layer lives in the Preview window.
//!
//! Linux has its element since S2.3c (`linux.rs`, S0.3's route: the
//! presenter's child above GPUI's drawing, docked or in its own window). Windows
//! gets its own in S2.3b (D12's route); until then its slot says the preview
//! failed to start, which is the truth.

#[cfg(target_os = "macos")]
mod floating;
#[cfg(target_os = "macos")]
pub(crate) mod frame;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod scene;

use gpui::{AnyElement, App, AppContext, Context, Entity, FontWeight, Window, div, prelude::*, px};
use videorc_kit::theme::hsla;
// The video ground and its words are the same in every appearance.
use tokio::sync::watch;
use videorc_app_core::{BackendState, Level, Logger};
use videorc_kit::tokens::DARK as VIDEO;
use videorc_preview::element::Phase;
use videorc_preview::lifecycle::WindowMode;
use videorc_preview::words::{self, PreviewWords};

#[cfg(target_os = "linux")]
use gpui::canvas;
#[cfg(target_os = "macos")]
use {
    gpui::{
        AsyncApp, Bounds, Pixels, TitlebarOptions, WeakEntity, WindowBounds, WindowHandle,
        WindowKind, WindowOptions, canvas, size,
    },
    std::sync::Arc,
    videorc_preview::LayerRect,
    videorc_preview::bounds::WindowGeometry,
    videorc_preview::element::{ElementConfig, PreviewElement, UiRequest},
    videorc_preview::feed::{FeedConfig, FrameSource},
    videorc_protocol::PreviewSurfaceSource,
};

/// The Studio slot's corner radius in points (`preview-stage.tsx`'s
/// rounded stage). The floating window is square.
pub const SLOT_RADIUS: f64 = 12.0;

/// Why the Scene canvas stays a schematic on X11 (the log's, once): its
/// child window is opaque and on top, with no transparent sibling for the
/// editor's chrome.
#[cfg(target_os = "linux")]
pub const X11_SCHEMATIC_REASON: &str = "the Scene canvas stays a schematic on X11: the preview's \
     child window is opaque and above the window's drawing, with no transparent sibling for the \
     editor's chrome";

/// What the preview needs from the app's core.
pub struct PreviewSetup {
    pub runtime: tokio::runtime::Handle,
    pub backend: watch::Receiver<BackendState>,
    pub logger: Logger,
    /// The Studio, whose scene the preview shows (S3.1b).
    pub studio: std::sync::Arc<videorc_app_core::Studio<videorc_app_core::BackendClient>>,
}

/// Where the layer is.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Host {
    Docked,
    Floating,
}

/// The macOS half: the element, the docked host and the floating window's.
#[cfg(target_os = "macos")]
struct Native {
    element: PreviewElement,
    docked: macos::HostView,
    floating_view: Option<objc2::rc::Retained<objc2_app_kit::NSView>>,
    host: Host,
}

pub struct Preview {
    phase: Phase,
    mode: WindowMode,
    /// The Studio page is the one showing (the docked slot is on screen).
    docked_shown: bool,
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    logger: Logger,
    #[cfg(target_os = "macos")]
    native: Option<Native>,
    #[cfg(target_os = "linux")]
    native: Option<linux::Native>,
    #[cfg(target_os = "macos")]
    floating: Option<WindowHandle<floating::FloatingPreview>>,
    /// Pop out was pressed and the window is opening (`Preview::float`).
    #[cfg(target_os = "macos")]
    opening: bool,
    /// The Preview window's `preview-window.json` (P1549, P132), once the
    /// shell hands it over ([`Preview::remember_window`]).
    #[cfg(target_os = "macos")]
    frame: Option<frame::PreviewFrame>,
    /// Close Preview, or its window closed by hand (P131): no window and no
    /// docked video; the Studio says so and offers both places to open it.
    /// Every platform keeps it (P530, P541: Windows has no preview yet, and
    /// its Open / Close Preview still agree).
    closed: bool,
    /// Where a closed Preview opens again: where it was when it closed.
    closed_from: WindowMode,
    /// Linux: the docked slot isn't fully inside its scroll view, so the
    /// child (above the window's drawing, never clipped) hides and the slot
    /// says why (`scrolled-away`). macOS's docked view is clipped by GPUI.
    #[cfg(target_os = "linux")]
    scrolled_away: bool,
    /// The Studio, for the grants the preview's sources wait for (P141).
    studio: Option<std::sync::Arc<videorc_app_core::Studio<videorc_app_core::BackendClient>>>,
}

impl Preview {
    /// Starts the element in `window` (the main window, where the docked slot
    /// lives). A missing Metal device or a refused native view leaves the
    /// slot saying the preview failed, with the reason in the log, never a
    /// silent downgrade.
    pub fn new(setup: PreviewSetup, window: &mut Window, cx: &mut App) -> Entity<Self> {
        #[cfg(target_os = "macos")]
        {
            Self::new_macos(setup, window, cx)
        }
        #[cfg(target_os = "linux")]
        {
            linux::new(setup, window, cx)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (setup.runtime, setup.backend, window);
            setup.logger.log(
                Level::Warn,
                "[preview] no preview element on this platform yet (S2.3b on Windows)",
            );
            cx.new(|_| Self {
                phase: Phase::Fallback,
                mode: WindowMode::Docked,
                docked_shown: true,
                logger: setup.logger,
                closed: false,
                closed_from: WindowMode::Docked,
                studio: Some(setup.studio),
            })
        }
    }

    #[cfg(target_os = "macos")]
    fn new_macos(setup: PreviewSetup, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let PreviewSetup {
            runtime,
            backend,
            logger,
            studio,
        } = setup;
        let words_studio = studio.clone();
        let choice = scene::choose(|name| std::env::var(name).ok(), Some((&studio, &runtime)));
        logger.log(
            Level::Info,
            &format!("[preview] the preview shows {}", choice.described),
        );
        let docked = match macos::HostView::new(window, cx) {
            Ok(docked) => docked,
            Err(error) => {
                logger.log(Level::Error, &format!("[preview] {error}"));
                return cx.new(|_| Self::failed(logger));
            }
        };
        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel::<UiRequest>();
        let notify: Arc<dyn Fn(UiRequest) + Send + Sync> = Arc::new(move |request| {
            let _ = requests_tx.send(request);
        });
        let config = ElementConfig {
            feed: FeedConfig {
                frame_source: FrameSource::NativeLease,
                scene: choice.feed,
                source: PreviewSurfaceSource::Synthetic,
                target_fps: choice.fps,
                record_stats: false,
                logger: logger.clone(),
            },
            canvas: choice.canvas,
            corner_radius: SLOT_RADIUS,
            notify,
            texture: None,
            logger: logger.clone(),
        };
        let mut element = match PreviewElement::start(&runtime, backend, config) {
            Ok(element) => element,
            Err(error) => {
                logger.log(
                    Level::Error,
                    &format!("[preview] Native preview is unavailable: {error}"),
                );
                return cx.new(|_| Self::failed(logger));
            }
        };
        if let Err(error) = element.attach(&macos::ViewHost::of(&docked.view)) {
            logger.log(
                Level::Error,
                &format!("[preview] the layer could not join the Studio slot: {error}"),
            );
        }
        if !macos::tune_video_layer(&docked.view, SLOT_RADIUS) {
            logger.log(
                Level::Warn,
                "[preview] no video layer in the Studio slot to fit to it",
            );
        }
        let mut status = element.status_watch();
        let phase = status.borrow().phase;
        cx.new(|cx: &mut Context<Self>| {
            // The slot's words follow the element's phase; nothing else of
            // the status (its frame counter moves every second) redraws.
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                while status.changed().await.is_ok() {
                    let next = status.borrow_and_update().phase;
                    let alive = this.update(cx, |preview, cx| {
                        if preview.phase != next {
                            preview.phase = next;
                            cx.notify();
                        }
                    });
                    if alive.is_err() {
                        break;
                    }
                }
            })
            .detach();
            // The watchdog's requests for the UI thread.
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                while let Some(request) = requests_rx.recv().await {
                    if this
                        .update(cx, |preview, _| preview.on_request(request))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
            Self {
                phase,
                mode: WindowMode::Docked,
                docked_shown: true,
                logger,
                native: Some(Native {
                    element,
                    docked,
                    floating_view: None,
                    host: Host::Docked,
                }),
                floating: None,
                opening: false,
                frame: None,
                closed: false,
                closed_from: WindowMode::Docked,
                studio: Some(words_studio),
            }
        })
    }

    #[cfg(target_os = "macos")]
    fn failed(logger: Logger) -> Self {
        Self {
            phase: Phase::Fallback,
            mode: WindowMode::Docked,
            docked_shown: true,
            logger,
            native: None,
            floating: None,
            opening: false,
            frame: None,
            closed: false,
            closed_from: WindowMode::Docked,
            studio: None,
        }
    }

    /// Docked in the Studio, or in its own window.
    pub fn mode(&self) -> WindowMode {
        self.mode
    }

    /// The Scene canvas shows the live picture (X5 `liveCanvasActive`):
    /// the docked layer is here, not in its own window.
    pub fn live_canvas(&self) -> bool {
        self.scene_hosts_docked()
            && self.mode == WindowMode::Docked
            && !self.is_closed()
            && self.native_ready()
    }

    /// Show preview here (P540): a closed Preview opens docked, one in its
    /// own window comes back to the dock.
    pub fn show_docked(&mut self, cx: &mut gpui::Context<Self>) {
        if self.closed {
            self.open_docked(cx);
        } else if self.mode == WindowMode::Floating {
            #[cfg(target_os = "macos")]
            self.dock(cx);
            #[cfg(target_os = "linux")]
            self.dock_linux(cx);
        }
    }

    /// The Scene page's entry (P532): a closed Preview opens docked there;
    /// one in its own window stays where it is.
    pub fn open_docked_if_closed(&mut self, cx: &mut gpui::Context<Self>) {
        if self.closed {
            self.open_docked(cx);
        }
    }

    /// The layout-only line's action (P530, Electron `openPreviewWindow`):
    /// a closed Preview opens where it was; one in its own window comes to
    /// the front.
    pub fn open_or_show(&mut self, cx: &mut gpui::Context<Self>) {
        if self.closed {
            self.toggle_open(cx);
        } else if self.mode == WindowMode::Floating {
            self.bring_to_front(cx);
        }
    }

    /// The Scene page's canvas hosts the docked preview (X5,
    /// `liveCanvasSupported`): macOS, where GPUI composites the native view
    /// beneath its own drawing and paints the stage's chrome over it; and
    /// Linux on Wayland, where the chrome goes in a subsurface above the
    /// video ([`Self::set_stage_chrome`]). X11's child has no transparent
    /// sibling, so its canvas stays a schematic, by name; Windows has no
    /// element yet (S2.3b).
    pub fn scene_hosts_docked(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            true
        }
        #[cfg(target_os = "linux")]
        {
            self.native
                .as_ref()
                .is_some_and(|native| native.element.chrome_supported())
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            false
        }
    }

    /// The Scene editor's chrome over the live video, for a host whose
    /// video sits above the window's drawing (Linux's Wayland subsurface);
    /// `None` takes it down. macOS needs none: GPUI draws over its view.
    pub fn set_stage_chrome(&mut self, scene: Option<videorc_preview::chrome::ChromeScene>) {
        #[cfg(target_os = "linux")]
        if let Some(native) = self.native.as_mut() {
            native.element.set_chrome(scene);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = scene;
    }

    /// The chrome goes in its own surface over the video here (Linux on
    /// Wayland): the stage sends it instead of drawing it.
    pub fn stage_chrome_separate(&self) -> bool {
        cfg!(target_os = "linux") && self.scene_hosts_docked()
    }

    /// The element's phase (Starting, Presenting, Healing, Stalled,
    /// Fallback; Disconnected): the Studio's preview health reads it.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Retry preview has something to re-arm: the native element started.
    /// (A refused start, or Windows today, has none: Retry stays off.)
    pub fn can_retry(&self) -> bool {
        self.native_ready()
    }

    /// Retry preview (P117, P146; Electron's `refreshPreview`): the native
    /// path is rebuilt on the host that holds it (the presenter, the layer
    /// or child, and a fresh backend surface), the Studio's scene is
    /// committed again, and the watchdog starts the first-frame contract
    /// over with a fresh budget and healing ladder. True when it ran.
    pub fn retry(&mut self, cx: &mut Context<Self>) -> bool {
        #[cfg(target_os = "macos")]
        {
            if self.native.is_none() {
                return false;
            }
            self.on_request(UiRequest::ResetNativePath);
            if let Some(native) = self.native.as_mut() {
                native.element.rearm();
            }
            cx.notify();
            true
        }
        #[cfg(target_os = "linux")]
        {
            let Some(native) = self.native.as_mut() else {
                return false;
            };
            // The child is rebuilt at its host's next layout, where the
            // window is.
            native.reset_pending = true;
            native.element.rearm();
            cx.notify();
            true
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = cx;
            false
        }
    }

    /// P141 `permission-required`: while no frame presents, a selected
    /// screen, window or camera that waits for its grant names it (the
    /// device list says so; Electron's supervisor hears it from the
    /// surface).
    fn permission_words(&self) -> Option<PreviewWords> {
        if self.phase == Phase::Presenting {
            return None;
        }
        let watch = self.studio.as_ref()?.watch();
        let snapshot = watch.borrow();
        let devices = &snapshot.sources.devices.devices;
        let sources = &snapshot.settings.capture.sources;
        let waits = |id: &Option<String>| {
            id.as_deref().is_some_and(|id| {
                devices.iter().any(|device| {
                    device.id == id
                        && device.status == videorc_protocol::DeviceStatus::PermissionRequired
                })
            })
        };
        let screen = waits(&sources.screen_id) || waits(&sources.window_id);
        let camera = waits(&sources.camera_id);
        words::permission_wait(screen, camera).map(words::needs_permission)
    }

    /// What the Studio slot says, or nothing while a frame shows there.
    pub fn docked_words(&self) -> Option<PreviewWords> {
        if !self.native_ready() {
            return Some(words::FAILED);
        }
        if self.is_closed() {
            return Some(words::LIVES_IN_ITS_OWN_WINDOW);
        }
        #[cfg(target_os = "linux")]
        if self.mode == WindowMode::Docked
            && self.scrolled_away
            && let Some(hidden) =
                words::dock_hidden(videorc_preview::lifecycle::DockHiddenReason::ScrolledAway)
        {
            return Some(hidden);
        }
        if let Some(waiting) = self.permission_words() {
            return Some(waiting);
        }
        match self.mode {
            WindowMode::Floating => Some(words::away(self.phase)),
            WindowMode::Docked => words::phase(self.phase),
        }
    }

    /// What the Preview window says over its video while no frame shows
    /// there (opening, failed or stalled), or nothing.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn floating_words(&self) -> Option<PreviewWords> {
        self.permission_words().or_else(|| words::phase(self.phase))
    }

    #[cfg(target_os = "macos")]
    fn native_ready(&self) -> bool {
        self.native.is_some()
    }

    #[cfg(target_os = "linux")]
    fn native_ready(&self) -> bool {
        self.native.is_some()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn native_ready(&self) -> bool {
        false
    }

    /// The smoke driver's view of the preview (`inspect-native-preview-runtime`,
    /// `preview-window-state`): where it is, its phase, and what it says.
    pub fn smoke_state(&self) -> serde_json::Value {
        #[cfg(target_os = "macos")]
        let floating_open = self.floating.is_some();
        #[cfg(not(target_os = "macos"))]
        let floating_open = false;
        serde_json::json!({
            "mode": self.mode.as_str(),
            "phase": self.phase.as_str(),
            "nativeReady": self.native_ready(),
            "dockedShown": self.docked_shown,
            "canFloat": self.can_float(),
            "floatingOpen": floating_open,
            "closed": self.is_closed(),
            "sceneHostsDocked": self.scene_hosts_docked(),
            "words": self.docked_words().map(|words| serde_json::json!({
                "title": words.title,
                "detail": words.detail,
            })),
        })
    }

    /// The Preview's own window while it is open (macOS), for the driver.
    pub fn floating_window(&self) -> Option<gpui::AnyWindowHandle> {
        #[cfg(target_os = "macos")]
        return self.floating.map(Into::into);
        #[cfg(not(target_os = "macos"))]
        None
    }

    /// Whether the Preview can open in its own window here.
    pub fn can_float(&self) -> bool {
        self.native_ready()
    }

    /// Closed (P131): neither docked nor in its own window.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Close Preview (P131): the Preview window closes and the Preview stays
    /// closed, as Electron's `closePreviewWindow`.
    #[cfg(target_os = "macos")]
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = self.floating.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
        self.set_closed(cx);
    }

    /// Close Preview off macOS (P541): Linux's child goes home from its own
    /// window and hides; Windows (no preview yet) keeps the state alone.
    #[cfg(not(target_os = "macos"))]
    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.closed_from = self.mode;
        #[cfg(target_os = "linux")]
        if self.mode == WindowMode::Floating {
            self.dock_linux(cx);
        }
        self.closed = true;
        #[cfg(target_os = "linux")]
        self.apply_linux_visibility();
        self.logger
            .log(Level::Info, "[preview] the Preview is closed");
        cx.notify();
    }

    /// Window → Preview, ⌘P and the palette's Open/Close Preview (P1506,
    /// P541, Electron's `togglePreviewWindow`): an open Preview closes
    /// where it is; a closed one opens where it was.
    pub fn toggle_open(&mut self, cx: &mut Context<Self>) {
        if !self.closed {
            self.close(cx);
        } else if self.closed_from == WindowMode::Floating && self.can_float() {
            self.open_floating(cx);
        } else {
            self.open_docked(cx);
        }
    }

    /// Show here, from closed, off macOS: the Preview docks in the Studio.
    #[cfg(not(target_os = "macos"))]
    pub fn open_docked(&mut self, cx: &mut Context<Self>) {
        self.closed = false;
        #[cfg(target_os = "linux")]
        if self.mode == WindowMode::Floating {
            self.dock_linux(cx);
        }
        #[cfg(target_os = "linux")]
        self.apply_linux_visibility();
        cx.notify();
    }

    /// Open in its own window, from closed, off macOS (Linux; Windows has
    /// no Preview window, so it opens docked).
    #[cfg(not(target_os = "macos"))]
    pub fn open_floating(&mut self, cx: &mut Context<Self>) {
        self.closed = false;
        #[cfg(target_os = "linux")]
        {
            self.apply_linux_visibility();
            if self.mode == WindowMode::Docked {
                self.float_linux(cx);
            }
        }
        cx.notify();
    }

    /// Bring to front off macOS: Linux's Preview window comes up.
    #[cfg(not(target_os = "macos"))]
    pub fn bring_to_front(&self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if let Some(handle) = self.native.as_ref().and_then(|native| native.floating) {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        #[cfg(not(target_os = "linux"))]
        let _ = cx;
    }

    /// Show here, from closed: the Preview docks in the Studio.
    #[cfg(target_os = "macos")]
    pub fn open_docked(&mut self, cx: &mut Context<Self>) {
        self.closed = false;
        if self.mode == WindowMode::Floating {
            self.dock(cx);
        } else {
            if let Some(frame) = &self.frame {
                frame.docked();
            }
            self.apply_visibility();
            cx.notify();
        }
    }

    /// Open in its own window, from closed.
    #[cfg(target_os = "macos")]
    pub fn open_floating(&mut self, cx: &mut Context<Self>) {
        self.closed = false;
        self.apply_visibility();
        self.float(cx);
        cx.notify();
    }

    /// The layer back in the Studio's host, hidden, and the closed state
    /// saved.
    #[cfg(target_os = "macos")]
    fn set_closed(&mut self, cx: &mut Context<Self>) {
        self.closed_from = self.mode;
        self.return_to_dock();
        self.closed = true;
        self.apply_visibility();
        if let Some(frame) = &self.frame {
            frame.closed();
        }
        self.logger
            .log(Level::Info, "[preview] the Preview is closed");
        cx.notify();
    }

    /// The Preview window's remembered frame, mode and Keep on top.
    #[cfg(target_os = "macos")]
    pub fn remember_window(&mut self, frame: frame::PreviewFrame) {
        self.frame = Some(frame);
    }

    /// `restorePreviewWindowOnLaunch` (P1549): a Preview left floating
    /// floats again, once the workspace shows.
    #[cfg(target_os = "macos")]
    pub fn restore_at_launch(&mut self, cx: &mut Context<Self>) {
        if self.mode == WindowMode::Docked
            && self
                .frame
                .as_ref()
                .is_some_and(frame::PreviewFrame::floats_at_launch)
        {
            self.float(cx);
        } else if self
            .frame
            .as_ref()
            .is_some_and(frame::PreviewFrame::closed_at_launch)
        {
            // Left closed: the Studio shows it closed.
            self.closed = true;
            self.closed_from = if self
                .frame
                .as_ref()
                .is_some_and(frame::PreviewFrame::reopens_floating)
            {
                WindowMode::Floating
            } else {
                WindowMode::Docked
            };
            self.apply_visibility();
            cx.notify();
        }
    }

    /// The mode a closed Preview opens in again (`previewWindow.mode` while
    /// closed): the Preview shortcut's keys ride on that button (P125/P126).
    #[cfg(target_os = "macos")]
    pub fn reopens_floating(&self) -> bool {
        self.closed_from == WindowMode::Floating
    }

    /// Keep on top of other apps (P132), off unless turned on.
    #[cfg(target_os = "macos")]
    pub fn keep_on_top(&self) -> bool {
        self.frame
            .as_ref()
            .is_some_and(frame::PreviewFrame::always_on_top)
    }

    /// Turns Keep on top on or off: saved, and applied to the open window.
    #[cfg(target_os = "macos")]
    pub fn set_keep_on_top(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(frame) = &self.frame {
            frame.set_always_on_top(on);
        }
        if let Some(handle) = self.floating {
            let _ = handle.update(cx, |_, window, _| {
                if let Err(error) = crate::platform::current().set_keep_on_top(window, on) {
                    self.logger.log(
                        Level::Warn,
                        &format!("[preview] Keep on top didn't change: {error}"),
                    );
                }
            });
        }
        cx.notify();
    }

    /// Bring to front (P130): the Preview window comes up.
    #[cfg(target_os = "macos")]
    pub fn bring_to_front(&self, cx: &mut Context<Self>) {
        if let Some(handle) = self.floating {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
    }

    /// The shell says whether the Studio page shows: a slot that is not on
    /// screen presents nothing (the surface's record says `visible: false`).
    pub fn set_docked_shown(&mut self, shown: bool) {
        if self.docked_shown == shown {
            return;
        }
        self.docked_shown = shown;
        #[cfg(target_os = "macos")]
        self.apply_visibility();
        #[cfg(target_os = "linux")]
        self.apply_linux_visibility();
    }

    /// The docked slot, for the Studio page: the video where the layer
    /// shows, and the words while no frame does.
    pub fn docked_slot(entity: &Entity<Self>, cx: &App) -> AnyElement {
        let preview = entity.read(cx);
        #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(unused_mut))]
        let mut slot = div()
            .relative()
            .size_full()
            .rounded(px(SLOT_RADIUS as f32))
            .bg(hsla(VIDEO.video_ground))
            .overflow_hidden();
        #[cfg(target_os = "macos")]
        if preview.mode == WindowMode::Docked
            && let Some(native) = preview.native.as_ref()
        {
            let weak = entity.downgrade();
            slot = slot.child(native.docked.native.clone()).child(
                canvas(
                    move |bounds, window, cx| {
                        let geometry = macos::geometry_of(window, bounds, cx);
                        let _ = weak.update(cx, |preview, _| {
                            preview.place(Host::Docked, bounds, geometry)
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        // Linux: the presenter's child follows the slot in window points;
        // a pending reset-native-path rebuilds it here, where the window is.
        #[cfg(target_os = "linux")]
        if preview.mode == WindowMode::Docked && preview.native.is_some() {
            let weak = entity.downgrade();
            slot = slot.child(
                canvas(
                    move |bounds, window, cx| {
                        let geometry = linux::geometry_of(window, bounds, cx);
                        // A scroll view clips the slot: the child hides
                        // until the slot is fully in view.
                        let away = !linux::fully_inside(window.content_mask().bounds, bounds);
                        let _ = weak.update(cx, |preview, cx| {
                            preview.set_scrolled_away(away, cx);
                            preview.place_linux(linux::Host::Docked, window, bounds, geometry)
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        match preview.docked_words() {
            Some(words) => slot.child(words_card(words)).into_any_element(),
            None => slot.into_any_element(),
        }
    }

    /// Opens the Preview in its own window, or docks it back.
    pub fn toggle_floating(&mut self, cx: &mut gpui::Context<Self>) {
        // Closed, it opens in its own window.
        if self.closed {
            self.open_floating(cx);
            return;
        }
        #[cfg(target_os = "macos")]
        match self.mode {
            WindowMode::Docked => self.float(cx),
            WindowMode::Floating => self.dock(cx),
        }
        #[cfg(target_os = "linux")]
        match self.mode {
            WindowMode::Docked => self.float_linux(cx),
            WindowMode::Floating => self.dock_linux(cx),
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = cx;
    }

    /// Stops the feed (lease released, surface destroyed), the watchdog and
    /// the presenter; the floating window closes. Before the backend stops.
    pub fn stop(&mut self, cx: &mut gpui::Context<Self>) {
        #[cfg(target_os = "macos")]
        {
            if let Some(handle) = self.floating.take() {
                // Quitting while floating: the next launch floats it again.
                if let Some(frame) = &self.frame {
                    frame.quitting();
                }
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            }
            if let Some(native) = self.native.take() {
                native.element.stop();
                self.logger.log(Level::Info, "[preview] stopped");
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = cx;
        #[cfg(target_os = "linux")]
        self.stop_linux(cx);
    }

    // --- macOS: placing, moving and healing the layer ---

    /// A slot laid out: the layer follows in the same pass (top-left points
    /// inside its host view), and the surface's record gets the slot's
    /// place on the screen.
    #[cfg(target_os = "macos")]
    pub(crate) fn place(&mut self, host: Host, slot: Bounds<Pixels>, geometry: WindowGeometry) {
        let Some(native) = self.native.as_mut() else {
            return;
        };
        if native.host != host {
            return;
        }
        native.element.place(
            LayerRect {
                x: 0.0,
                y: 0.0,
                width: f64::from(slot.size.width),
                height: f64::from(slot.size.height),
            },
            geometry,
        );
    }

    #[cfg(target_os = "macos")]
    fn apply_visibility(&mut self) {
        let visible = !self.closed && (self.mode == WindowMode::Floating || self.docked_shown);
        if let Some(native) = self.native.as_mut() {
            native.element.set_visible(visible);
        }
    }

    /// Moves the layer into `host`'s view, with that host's corners. The
    /// backend's surface is not touched (plan 220 S2.3b).
    #[cfg(target_os = "macos")]
    fn attach_to(&mut self, host: Host) -> bool {
        let Some(native) = self.native.as_mut() else {
            return false;
        };
        let view = match host {
            Host::Docked => native.docked.view.clone(),
            Host::Floating => match native.floating_view.clone() {
                Some(view) => view,
                None => return false,
            },
        };
        let radius = match host {
            Host::Docked => SLOT_RADIUS,
            Host::Floating => 0.0,
        };
        native.element.set_corner_radius(radius);
        if let Err(error) = native.element.attach(&macos::ViewHost::of(&view)) {
            self.logger.log(
                Level::Error,
                &format!("[preview] the layer could not move: {error}"),
            );
            return false;
        }
        macos::tune_video_layer(&view, radius);
        native.host = host;
        true
    }

    /// Pop out: the window opens once this update has ended. `open_window`
    /// draws the new window before it returns, and that draw's canvas places
    /// the layer through this entity, which is leased while the Studio's
    /// button updates it: opening from here would lease it twice.
    #[cfg(target_os = "macos")]
    fn float(&mut self, cx: &mut Context<Self>) {
        if self.native.is_none() || self.floating.is_some() || self.opening {
            return;
        }
        self.opening = true;
        let weak = cx.entity().downgrade();
        cx.defer(move |cx| open_floating(weak, cx));
    }

    /// The Preview window is open (or did not open): its view takes the
    /// layer. Its first draw has already happened, while the layer was still
    /// docked, so its canvas placed nothing; it draws again from here.
    #[cfg(target_os = "macos")]
    fn floated(
        &mut self,
        opened: anyhow::Result<WindowHandle<floating::FloatingPreview>>,
        cx: &mut Context<Self>,
    ) {
        self.opening = false;
        let handle = match opened {
            Ok(handle) => handle,
            Err(error) => {
                self.logger.log(
                    Level::Error,
                    &format!("[preview] the Preview window did not open: {error:#}"),
                );
                cx.notify();
                return;
            }
        };
        if self.native.is_none() {
            // Stopped while the window opened (quit): nothing to show in it.
            let _ = handle.update(cx, |_, window, _| window.remove_window());
            return;
        }
        let view = handle.update(cx, |floating, _, _| floating.host_view());
        let hosted = match view {
            Ok(Ok(view)) => Ok(view),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(format!("{error:#}")),
        };
        match hosted {
            Ok(view) => {
                if let Some(native) = self.native.as_mut() {
                    native.floating_view = Some(view);
                }
            }
            Err(error) => self.logger.log(
                Level::Error,
                &format!("[preview] the Preview window cannot host the video: {error}"),
            ),
        }
        self.floating = Some(handle);
        if self.attach_to(Host::Floating) {
            self.mode = WindowMode::Floating;
            self.apply_visibility();
            self.logger
                .log(Level::Info, "[preview] the Preview is in its own window");
        }
        // The window's canvas places the layer on its next draw.
        let _ = handle.update(cx, |_, window, _| window.refresh());
        cx.notify();
    }

    /// Docks the preview back and closes its window (the Studio's button).
    #[cfg(target_os = "macos")]
    fn dock(&mut self, cx: &mut Context<Self>) {
        self.return_to_dock();
        if let Some(frame) = &self.frame {
            frame.docked();
        }
        if let Some(handle) = self.floating.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
        cx.notify();
    }

    /// The user closed the Preview window: the Preview is closed (P131),
    /// as Electron's window `closed` event; the layer waits, hidden, in the
    /// Studio's host.
    #[cfg(target_os = "macos")]
    pub(crate) fn floating_closed(&mut self, cx: &mut Context<Self>) {
        self.floating = None;
        self.set_closed(cx);
    }

    #[cfg(target_os = "macos")]
    fn return_to_dock(&mut self) {
        if self.mode == WindowMode::Docked {
            return;
        }
        self.attach_to(Host::Docked);
        if let Some(native) = self.native.as_mut() {
            native.floating_view = None;
        }
        self.mode = WindowMode::Docked;
        self.apply_visibility();
        self.logger
            .log(Level::Info, "[preview] the Preview is docked in the Studio");
    }

    /// The watchdog's UI half: place the layer again (`present-kick`), or
    /// rebuild the presenter and the layer (`reset-native-path`).
    #[cfg(target_os = "macos")]
    fn on_request(&mut self, request: UiRequest) {
        let Some(native) = self.native.as_mut() else {
            return;
        };
        match request {
            UiRequest::Status(status) => {
                self.logger
                    .log(Level::Info, &format!("[preview] {}", status.describe()));
            }
            UiRequest::Kick => native.element.kick(),
            UiRequest::ResetNativePath => {
                let (view, radius) = match native.host {
                    Host::Docked => (native.docked.view.clone(), SLOT_RADIUS),
                    Host::Floating => match native.floating_view.clone() {
                        Some(view) => (view, 0.0),
                        None => return,
                    },
                };
                match native
                    .element
                    .reset_native_path(&macos::ViewHost::of(&view))
                {
                    Ok(()) => {
                        macos::tune_video_layer(&view, radius);
                    }
                    Err(error) => self.logger.log(
                        Level::Error,
                        &format!("[preview] reset-native-path failed: {error}"),
                    ),
                }
            }
        }
    }
}

/// Opens the Preview window, outside any update of the Preview entity (see
/// [`Preview::float`]), and hands it to the Preview.
#[cfg(target_os = "macos")]
fn open_floating(preview: WeakEntity<Preview>, cx: &mut App) {
    let remembered = preview
        .upgrade()
        .and_then(|entity| entity.read(cx).frame.clone());
    let bounds = match &remembered {
        Some(frame) => frame.opening(cx),
        None => gpui::Bounds::centered(
            None,
            size(px(frame::DEFAULT_WIDTH), px(frame::DEFAULT_HEIGHT)),
            cx,
        ),
    };
    let builder = preview.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Preview".into()),
                ..Default::default()
            }),
            // A normal window, as Electron's: a panel hides when Videorc
            // goes to the background. Keep on top raises its level.
            kind: WindowKind::Normal,
            window_min_size: Some(size(px(frame::MIN_WIDTH), px(frame::MIN_HEIGHT))),
            ..Default::default()
        },
        move |window, cx| floating::FloatingPreview::build(builder, remembered, window, cx),
    );
    let window = opened.as_ref().ok().copied();
    if preview
        .update(cx, |preview, cx| preview.floated(opened, cx))
        .is_err()
        && let Some(window) = window
    {
        // The Preview went while the window opened (the app is quitting):
        // nothing would dock or close it.
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
}

/// A slot's words: the title, and the detail when there is one.
fn words_card(words: PreviewWords) -> impl IntoElement {
    let mut card = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .px(px(24.))
        .text_color(hsla(VIDEO.video_ground_foreground))
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(words.title),
        );
    if !words.detail.is_empty() {
        card = card.child(
            div()
                .text_size(px(12.))
                .text_color(hsla(VIDEO.video_ground_muted))
                .child(words.detail),
        );
    }
    card
}
