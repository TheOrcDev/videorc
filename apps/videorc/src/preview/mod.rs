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
//! presenter's child above GPUI's drawing, docked only for now). Windows
//! gets its own in S2.3b (D12's route); until then its slot says the preview
//! failed to start, which is the truth.

#[cfg(target_os = "macos")]
mod floating;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod scene;

use gpui::{AnyElement, App, AppContext, Entity, FontWeight, Window, div, prelude::*, px, rgb};
use tokio::sync::watch;
use videorc_app_core::{BackendState, Level, Logger};
use videorc_preview::element::Phase;
use videorc_preview::lifecycle::WindowMode;
use videorc_preview::words::{self, PreviewWords};

#[cfg(target_os = "linux")]
use gpui::canvas;
#[cfg(target_os = "macos")]
use {
    gpui::{
        AsyncApp, Bounds, Context, Pixels, TitlebarOptions, WeakEntity, WindowBounds, WindowHandle,
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

/// What the preview needs from the app's core.
pub struct PreviewSetup {
    pub runtime: tokio::runtime::Handle,
    pub backend: watch::Receiver<BackendState>,
    pub logger: Logger,
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
            })
        }
    }

    #[cfg(target_os = "macos")]
    fn new_macos(setup: PreviewSetup, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let PreviewSetup {
            runtime,
            backend,
            logger,
        } = setup;
        let choice = scene::choose(|name| std::env::var(name).ok());
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
        }
    }

    /// Docked in the Studio, or in its own window.
    pub fn mode(&self) -> WindowMode {
        self.mode
    }

    /// What the Studio slot says, or nothing while a frame shows there.
    pub fn docked_words(&self) -> Option<PreviewWords> {
        if !self.native_ready() {
            return Some(words::FAILED);
        }
        match self.mode {
            WindowMode::Floating => Some(words::away(self.phase)),
            WindowMode::Docked => words::phase(self.phase),
        }
    }

    /// What the Preview window says over its video while no frame shows
    /// there (opening, failed or stalled), or nothing.
    #[cfg(target_os = "macos")]
    pub(crate) fn floating_words(&self) -> Option<PreviewWords> {
        words::phase(self.phase)
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

    /// Whether the Preview can open in its own window here (macOS; Linux's
    /// floating window is S2.3c's follow-up).
    pub fn can_float(&self) -> bool {
        cfg!(target_os = "macos") && self.native_ready()
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
            .bg(rgb(0x000000))
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
                        let _ = weak.update(cx, |preview, _| {
                            preview.place_linux(window, bounds, geometry)
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
        #[cfg(target_os = "macos")]
        match self.mode {
            WindowMode::Docked => self.float(cx),
            WindowMode::Floating => self.dock(cx),
        }
        #[cfg(not(target_os = "macos"))]
        let _ = cx;
    }

    /// Stops the feed (lease released, surface destroyed), the watchdog and
    /// the presenter; the floating window closes. Before the backend stops.
    pub fn stop(&mut self, cx: &mut gpui::Context<Self>) {
        #[cfg(target_os = "macos")]
        {
            if let Some(handle) = self.floating.take() {
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
        self.stop_linux();
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
        let visible = self.mode == WindowMode::Floating || self.docked_shown;
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
        if let Some(handle) = self.floating.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
        cx.notify();
    }

    /// The user closed the Preview window: the layer comes back to the
    /// Studio slot.
    #[cfg(target_os = "macos")]
    pub(crate) fn floating_closed(&mut self, cx: &mut Context<Self>) {
        self.floating = None;
        self.return_to_dock();
        cx.notify();
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
    let bounds = gpui::Bounds::centered(None, size(px(960.), px(540.)), cx);
    let builder = preview.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Preview".into()),
                ..Default::default()
            }),
            kind: WindowKind::Floating,
            ..Default::default()
        },
        move |window, cx| floating::FloatingPreview::build(builder, window, cx),
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
        .text_color(rgb(0xe8e8ea))
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
                .text_color(rgb(0x8e8e93))
                .child(words.detail),
        );
    }
    card
}
