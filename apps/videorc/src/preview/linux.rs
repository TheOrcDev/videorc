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
//! Docked only for now: Linux's floating Preview window is its own follow-up
//! (`can_float` says no here, so the Studio offers no Pop out).

use std::sync::Arc;

use gpui::{App, AppContext, AsyncApp, Bounds, Context, Entity, Pixels, WeakEntity, Window};
use videorc_app_core::{Level, Logger};
use videorc_preview::LayerRect;
use videorc_preview::bounds::WindowGeometry;
use videorc_preview::element::{ElementConfig, Phase, PreviewElement, UiRequest};
use videorc_preview::feed::{FeedConfig, FrameSource};
use videorc_preview::lifecycle::WindowMode;
use videorc_preview::linux::Stacking;
use videorc_protocol::PreviewSurfaceSource;

use super::{Preview, PreviewSetup, SLOT_RADIUS, scene};

/// The Linux half: the element, and the watchdog's reset waiting for a
/// window to rebuild the child in.
pub(super) struct Native {
    pub(super) element: PreviewElement,
    /// `reset-native-path` asked for: done at the slot's next layout, where
    /// the window is at hand (the watchdog's request carries none).
    pub(super) reset_pending: bool,
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
    } = setup;
    let choice = scene::choose(|name| std::env::var(name).ok());
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
            }),
        }
    })
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
    /// The docked slot laid out: a pending reset rebuilds the child first,
    /// then the child follows the slot in the same pass.
    pub(super) fn place_linux(
        &mut self,
        window: &Window,
        slot: Bounds<Pixels>,
        geometry: WindowGeometry,
    ) {
        let Some(native) = self.native.as_mut() else {
            return;
        };
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

    /// A slot that is not on screen presents nothing.
    pub(super) fn apply_linux_visibility(&mut self) {
        let visible = self.docked_shown;
        if let Some(native) = self.native.as_mut() {
            native.element.set_visible(visible);
        }
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

    /// Stops the feed, the watchdog and the presenter, before the backend.
    pub(super) fn stop_linux(&mut self) {
        if let Some(native) = self.native.take() {
            native.element.stop();
            self.logger.log(Level::Info, "[preview] stopped");
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
}
