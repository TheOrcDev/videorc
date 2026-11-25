//! The Studio preview on Linux (plan 260 S2.3c, lane L5): `videorc-preview`'s
//! element with its Linux presenter, spike S0.3's route. The backend's
//! CPU-composed frames, whole BGRA pixels in its shared-memory ring, are put
//! on the screen by the display server itself: a `wl_subsurface` of the main
//! window's surface on Wayland, a child window on X11. GPUI never redraws per
//! video frame; the slot only places the child where it lays out.
//!
//! Stacking: the child sits **above** GPUI's drawing. The Studio slot draws
//! nothing over the video (its words show only while no frame does, when the
//! child holds no buffer or is hidden), so above needs no transparent main
//! window. Below (#1922's `Stacking::BelowHost`, which needs the window's
//! background transparent and the slot left unpainted) comes with the Scene
//! editor's Linux pass, whose handles draw over the video. X11 is always
//! above.
//!
//! Above also means a dialog drawn over the slot can't cover the video: the
//! docked child hides while one is open (Electron's `overlay-open`). gpui-base
//! traps a dialog's focus in its "Dialog" key context (every kit `Dialog`,
//! the ⌘K palette included), and the Shell says when its first-run overlay
//! shows ([`Preview::set_cover_probe`]). ogre, 2026-11-25: Go Live, the
//! palette's search field and every first-run step sat under the video.
//!
//! Docked or floating: Pop out opens a GPUI window of its own, and the
//! child moves into it at that window's first layout (the presenter builds
//! its child in whichever window it attaches to, without restarting the
//! backend's surface); docking back, or closing the window, moves it home at
//! the Studio slot's next layout. Wayland lets no app keep a window on top
//! or out of capture (`platform::linux`), so the floating window is a
//! normal one there.

use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, AppContext, AsyncApp, Bounds, Context, Entity, FocusHandle, Pixels, TitlebarOptions,
    WeakEntity, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions, canvas, div,
    prelude::*, px, size,
};
use videorc_app_core::{Level, Logger};
use videorc_kit::theme::hsla;
use videorc_kit::tokens::DARK;
use videorc_preview::LayerRect;
use videorc_preview::bounds::WindowGeometry;
use videorc_preview::element::{ElementConfig, Phase, PreviewElement, UiRequest};
use videorc_preview::feed::{FeedConfig, FrameSource};
use videorc_preview::lifecycle::WindowMode;
use videorc_preview::linux::Stacking;
use videorc_protocol::PreviewSurfaceSource;

use super::{Preview, PreviewSetup, SLOT_RADIUS, scene, words_card};

/// Where the child is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Host {
    Docked,
    Floating,
}

/// The Linux half: the element, and the watchdog's reset waiting for a
/// window to rebuild the child in.
pub(super) struct Native {
    pub(super) element: PreviewElement,
    /// `reset-native-path` asked for: done at the slot's next layout, where
    /// the window is at hand (the watchdog's request carries none).
    pub(super) reset_pending: bool,
    /// The window the child is in.
    pub(super) host: Host,
    /// The child moves to this host at its next layout (Pop out, dock).
    pub(super) attach_pending: Option<Host>,
    pub(super) floating: Option<WindowHandle<FloatingPreview>>,
    /// Pop out was pressed and the window is opening.
    pub(super) opening: bool,
    /// What is over the docked slot (a dialog, the first-run overlay).
    pub(super) cover: Cover,
}

/// What covers the docked slot from above, as its canvas last saw it.
#[derive(Default)]
pub(super) struct Cover {
    /// A dialog or the Shell's overlay is open: the docked child hides.
    covered: bool,
    /// The element focused at the last look. A dialog moves focus as it
    /// opens and gives it back as it closes, and the key-context path is
    /// the drawn frame's, so a change asks for one more frame to read it.
    focus: Option<FocusHandle>,
    /// The Shell's full-window overlay (first run) is showing.
    probe: Option<Rc<dyn Fn(&App) -> bool>>,
}

/// gpui-base's modal host traps a dialog's focus in this key context.
const DIALOG_CONTEXT: &str = "Dialog";

/// The focused element is inside a dialog (the drawn frame's path).
fn dialog_focused(window: &Window) -> bool {
    window
        .context_stack()
        .iter()
        .any(|context| context.contains(DIALOG_CONTEXT))
}

/// Whether the child shows: a closed Preview never does; in its own window
/// it always does; docked, while the Studio page shows the slot fully in
/// view and nothing covers it.
fn child_visible(
    closed: bool,
    floating: bool,
    docked_shown: bool,
    scrolled_away: bool,
    covered: bool,
) -> bool {
    !closed && (floating || (docked_shown && !scrolled_away && !covered))
}

/// Where the child sits against GPUI's drawing (see the module's notes).
const STACKING: Stacking = Stacking::AboveHost;

fn failed(logger: Logger) -> Preview {
    Preview {
        phase: Phase::Fallback,
        mode: WindowMode::Docked,
        docked_shown: true,
        logger,
        native: None,
        closed: false,
        closed_from: WindowMode::Docked,
        studio: None,
        scrolled_away: false,
        smoke_slots: [None, None],
    }
}

/// Starts the element and attaches its child to `window` (the main window,
/// where the docked slot lives). A refused child leaves the slot saying the
/// preview failed, with the reason in the log, never a silent downgrade.
pub(super) fn new(setup: PreviewSetup, window: &mut Window, cx: &mut App) -> Entity<Preview> {
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
    let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel::<UiRequest>();
    let notify: Arc<dyn Fn(UiRequest) + Send + Sync> = Arc::new(move |request| {
        let _ = requests_tx.send(request);
    });
    let config = ElementConfig {
        feed: FeedConfig {
            frame_source: FrameSource::CpuRing,
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
                &format!("[preview] the Linux preview is unavailable: {error}"),
            );
            return cx.new(|_| failed(logger));
        }
    };
    element.set_linux_stacking(STACKING);
    if let Err(error) = element.attach(&*window) {
        // The element names the fallback in its status; the slot says the
        // preview failed until a reset attaches a child.
        logger.log(
            Level::Error,
            &format!("[preview] the Linux presenter could not join the window: {error}"),
        );
    } else if !element.chrome_supported() {
        // The named fallback: the Scene canvas is a schematic here.
        logger.log(
            Level::Info,
            &format!("[preview] {}", super::X11_SCHEMATIC_REASON),
        );
    }
    let mut status = element.status_watch();
    let phase = status.borrow().phase;
    cx.new(|cx: &mut Context<Preview>| {
        // The slot's words follow the element's phase; nothing else of the
        // status redraws.
        cx.spawn(async move |this: WeakEntity<Preview>, cx: &mut AsyncApp| {
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
        cx.spawn(async move |this: WeakEntity<Preview>, cx: &mut AsyncApp| {
            while let Some(request) = requests_rx.recv().await {
                if this
                    .update(cx, |preview, cx| preview.on_linux_request(request, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Preview {
            phase,
            mode: WindowMode::Docked,
            docked_shown: true,
            logger,
            native: Some(Native {
                element,
                reset_pending: false,
                host: Host::Docked,
                attach_pending: None,
                floating: None,
                opening: false,
                cover: Cover::default(),
            }),
            closed: false,
            closed_from: WindowMode::Docked,
            studio: Some(words_studio),
            scrolled_away: false,
            smoke_slots: [None, None],
        }
    })
}

/// The slot lies fully inside the clip its scroll view sets (half a point
/// of slack for rounding).
pub(super) fn fully_inside(clip: Bounds<Pixels>, slot: Bounds<Pixels>) -> bool {
    let slack = 0.5;
    f32::from(slot.origin.x) + slack >= f32::from(clip.origin.x)
        && f32::from(slot.origin.y) + slack >= f32::from(clip.origin.y)
        && f32::from(slot.right()) <= f32::from(clip.right()) + slack
        && f32::from(slot.bottom()) <= f32::from(clip.bottom()) + slack
}

/// The slot's place for the surface's record. Wayland gives no window a
/// screen position, so the origin is the window's own as GPUI knows it.
pub(super) fn geometry_of(window: &Window, slot: Bounds<Pixels>, cx: &App) -> WindowGeometry {
    let bounds = window.bounds();
    let viewport = window.viewport_size();
    let screen_height = window
        .display(cx)
        .map(|display| f64::from(display.bounds().size.height))
        .unwrap_or(0.0);
    WindowGeometry {
        screen_x: f64::from(bounds.origin.x) + f64::from(slot.origin.x),
        screen_y: f64::from(bounds.origin.y) + f64::from(slot.origin.y),
        content_width: f64::from(viewport.width),
        content_height: f64::from(viewport.height),
        screen_height,
        scale_factor: f64::from(window.scale_factor()),
    }
}

/// The child's rect: the slot in the window's logical points (the
/// presenter places a subsurface or child window relative to the window).
fn slot_rect(slot: Bounds<Pixels>) -> LayerRect {
    LayerRect {
        x: f64::from(slot.origin.x),
        y: f64::from(slot.origin.y),
        width: f64::from(slot.size.width),
        height: f64::from(slot.size.height),
    }
}

impl Preview {
    /// A host's slot laid out (the Studio's, or the floating window's): a
    /// child due in this host moves here first, a pending reset rebuilds it,
    /// then the child follows the slot in the same pass. Another host's
    /// layout places nothing.
    pub(super) fn place_linux(
        &mut self,
        host: Host,
        window: &Window,
        slot: Bounds<Pixels>,
        geometry: WindowGeometry,
    ) {
        let mut moved = false;
        {
            let Some(native) = self.native.as_mut() else {
                return;
            };
            if native.attach_pending == Some(host) {
                native.attach_pending = None;
                match native.element.attach(window) {
                    Ok(()) => {
                        native.host = host;
                        moved = true;
                    }
                    Err(error) => self.logger.log(
                        Level::Error,
                        &format!("[preview] the Linux presenter could not move: {error}"),
                    ),
                }
            }
            if native.host != host {
                return;
            }
            if std::mem::take(&mut native.reset_pending)
                && let Err(error) = native.element.reset_native_path(window)
            {
                self.logger.log(
                    Level::Error,
                    &format!("[preview] reset-native-path failed: {error}"),
                );
            }
            native.element.place(slot_rect(slot), geometry);
        }
        if moved {
            if host == Host::Floating {
                self.mode = WindowMode::Floating;
                self.logger
                    .log(Level::Info, "[preview] the Preview is in its own window");
            }
            self.apply_linux_visibility();
        }
    }

    /// The Shell's full-window overlay (first run): the docked child hides
    /// while `probe` says it shows. Dialogs need nothing: their focus says.
    pub fn set_cover_probe(&mut self, probe: impl Fn(&App) -> bool + 'static) {
        if let Some(native) = self.native.as_mut() {
            native.cover.probe = Some(Rc::new(probe));
        }
    }

    /// The docked slot's canvas, each frame: is a dialog or the Shell's
    /// overlay over the slot? The child hides while one is.
    pub(super) fn note_docked_cover(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(native) = self.native.as_mut() else {
            return;
        };
        let focus = window.focused(cx);
        if focus != native.cover.focus {
            // The path below is the drawn frame's: read it again once the
            // new focus is drawn.
            native.cover.focus = focus;
            window.request_animation_frame();
        }
        let overlay = native.cover.probe.as_ref().is_some_and(|probe| probe(cx));
        let covered = overlay || dialog_focused(window);
        if covered == native.cover.covered {
            return;
        }
        native.cover.covered = covered;
        self.logger.log(
            Level::Info,
            if covered {
                "[preview] a dialog is over the Studio: the docked child hides"
            } else {
                "[preview] nothing is over the Studio: the docked child shows"
            },
        );
        self.apply_linux_visibility();
        cx.notify();
    }

    /// The docked slot went out of (or back into) full view.
    pub(super) fn set_scrolled_away(&mut self, away: bool, cx: &mut Context<Self>) {
        if self.scrolled_away == away {
            return;
        }
        self.scrolled_away = away;
        self.apply_linux_visibility();
        cx.notify();
    }

    pub(super) fn apply_linux_visibility(&mut self) {
        let covered = self
            .native
            .as_ref()
            .is_some_and(|native| native.cover.covered);
        let visible = child_visible(
            self.closed,
            self.mode == WindowMode::Floating,
            self.docked_shown,
            self.scrolled_away,
            covered,
        );
        if let Some(native) = self.native.as_mut() {
            native.element.set_visible(visible);
            // A closed Preview presents nothing and the backend renders no
            // preview frames (Electron destroys its host on close).
            native.element.park(self.closed);
        }
    }

    /// Pop out: the window opens once this update has ended (its first draw
    /// places through this entity), and the child moves in at that draw.
    pub(super) fn float_linux(&mut self, cx: &mut Context<Self>) {
        let Some(native) = self.native.as_mut() else {
            return;
        };
        if native.floating.is_some() || native.opening {
            return;
        }
        native.opening = true;
        let weak = cx.entity().downgrade();
        cx.defer(move |cx| open_floating(weak, cx));
    }

    /// The floating window opened (or did not): the child is due there.
    fn floated_linux(
        &mut self,
        opened: anyhow::Result<WindowHandle<FloatingPreview>>,
        cx: &mut Context<Self>,
    ) {
        let Some(native) = self.native.as_mut() else {
            // Stopped while the window opened (quit): nothing to show in it.
            if let Ok(handle) = opened {
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            }
            return;
        };
        native.opening = false;
        match opened {
            Ok(handle) => {
                native.floating = Some(handle);
                native.attach_pending = Some(Host::Floating);
                let _ = handle.update(cx, |_, window, _| window.refresh());
            }
            Err(error) => self.logger.log(
                Level::Error,
                &format!("[preview] the Preview window did not open: {error:#}"),
            ),
        }
        cx.notify();
    }

    /// Docks the preview back and closes its window (the Studio's button).
    pub(super) fn dock_linux(&mut self, cx: &mut Context<Self>) {
        self.return_to_dock_linux();
        if let Some(handle) = self
            .native
            .as_mut()
            .and_then(|native| native.floating.take())
        {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
        cx.notify();
    }

    /// The user closed the floating window: the child comes home and the
    /// Preview is closed (P131), as on macOS; it opens in its own window
    /// again.
    pub(super) fn floating_closed_linux(&mut self, cx: &mut Context<Self>) {
        if let Some(native) = self.native.as_mut() {
            native.floating = None;
        }
        self.return_to_dock_linux();
        self.closed_from = WindowMode::Floating;
        self.closed = true;
        self.apply_linux_visibility();
        self.logger
            .log(Level::Info, "[preview] the Preview is closed");
        cx.notify();
    }

    /// The child is due in the Studio slot at its next layout.
    fn return_to_dock_linux(&mut self) {
        if self.mode == WindowMode::Docked {
            return;
        }
        if let Some(native) = self.native.as_mut() {
            native.attach_pending = Some(Host::Docked);
        }
        self.mode = WindowMode::Docked;
        self.apply_linux_visibility();
        self.logger
            .log(Level::Info, "[preview] the Preview is docked in the Studio");
    }

    /// The watchdog's UI half: place the child again (`present-kick`), or
    /// rebuild it at the slot's next layout (`reset-native-path`).
    fn on_linux_request(&mut self, request: UiRequest, cx: &mut Context<Self>) {
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
                native.reset_pending = true;
                cx.notify();
            }
        }
    }

    /// Stops the feed, the watchdog and the presenter, and closes the
    /// floating window, before the backend stops.
    pub(super) fn stop_linux(&mut self, cx: &mut Context<Self>) {
        if let Some(mut native) = self.native.take() {
            if let Some(handle) = native.floating.take() {
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            }
            native.element.stop();
            self.logger.log(Level::Info, "[preview] stopped");
        }
    }
}

/// Opens the floating Preview window, outside any update of the Preview
/// entity (see [`Preview::float_linux`]), and hands it to the Preview.
fn open_floating(preview: WeakEntity<Preview>, cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(960.), px(540.)), cx);
    let builder = preview.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Preview".into()),
                ..Default::default()
            }),
            kind: WindowKind::Floating,
            app_id: Some(crate::APP_ID.into()),
            ..Default::default()
        },
        move |window, cx| FloatingPreview::build(builder, window, cx),
    );
    let window = opened.as_ref().ok().copied();
    if preview
        .update(cx, |preview, cx| preview.floated_linux(opened, cx))
        .is_err()
        && let Some(window) = window
    {
        // The Preview went while the window opened (the app is quitting).
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
}

/// The floating Preview window on Linux: black, square-cornered, the child
/// placed on its whole content; over it the words the Studio slot would say
/// while no frame shows. It redraws when the Preview notifies, never per
/// frame.
pub(super) struct FloatingPreview {
    preview: WeakEntity<Preview>,
}

impl FloatingPreview {
    fn build(preview: WeakEntity<Preview>, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let closing = preview.clone();
        window.on_window_should_close(cx, move |_, cx| {
            let _ = closing.update(cx, |preview, cx| preview.floating_closed_linux(cx));
            true
        });
        cx.new(|cx: &mut Context<Self>| {
            if let Some(entity) = preview.upgrade() {
                cx.observe(&entity, |_, _, cx| cx.notify()).detach();
            }
            Self { preview }
        })
    }
}

impl Render for FloatingPreview {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let words = self
            .preview
            .upgrade()
            .and_then(|preview| preview.read(cx).floating_words());
        let preview = self.preview.clone();
        let slot = div()
            .size_full()
            .relative()
            .bg(hsla(DARK.video_ground))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let geometry = geometry_of(window, bounds, cx);
                        let _ = preview.update(cx, |preview, _| {
                            preview.place_linux(Host::Floating, window, bounds, geometry)
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        match words {
            Some(words) => slot.child(words_card(words)),
            None => slot,
        }
    }
}

#[cfg(test)]
mod tests {
    use gpui::{point, px, size};

    use super::*;

    #[test]
    fn the_child_follows_the_slot_in_window_points() {
        let slot = Bounds {
            origin: point(px(240.0), px(56.0)),
            size: size(px(800.0), px(450.0)),
        };
        let rect = slot_rect(slot);
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (240.0, 56.0, 800.0, 450.0)
        );
    }

    #[test]
    fn a_dialog_over_the_studio_hides_the_docked_child_only() {
        // closed, floating, docked_shown, scrolled_away, covered
        assert!(child_visible(false, false, true, false, false));
        // ogre, 2026-11-25: Go Live, ⌘K and first run sat under the video.
        assert!(!child_visible(false, false, true, false, true));
        // Its own window is never under the main window's dialogs.
        assert!(child_visible(false, true, true, false, true));
        assert!(!child_visible(false, false, true, true, false));
        assert!(!child_visible(false, false, false, false, false));
        assert!(!child_visible(true, true, true, false, false));
    }
}
