//! Window frames in GPUI's coordinates and the core's (`desktop::window_frames`),
//! for the windows that save theirs: Notes, the Stream Manager, the Captions
//! reader and the floating Preview. The main window keeps none: like
//! Electron's (P043, P1553) it opens at 1180×780 every time.

use gpui::{App, Bounds, Pixels, point, px, size};
use videorc_app_core::desktop::window_frames::{Display, Rect};

/// Every display's bounds and work area (without the menu bar and the
/// Dock), in the same coordinates as a window's frame.
pub(crate) fn displays(cx: &App) -> Vec<Display> {
    cx.displays()
        .iter()
        .map(|display| Display {
            bounds: rect_of(display.bounds()),
            work_area: rect_of(display.visible_bounds()),
        })
        .collect()
}

pub(crate) fn rect_of(bounds: Bounds<Pixels>) -> Rect {
    Rect::new(
        f64::from(f32::from(bounds.origin.x)),
        f64::from(f32::from(bounds.origin.y)),
        f64::from(f32::from(bounds.size.width)),
        f64::from(f32::from(bounds.size.height)),
    )
}

pub(crate) fn bounds_of(frame: Rect) -> Bounds<Pixels> {
    Bounds {
        origin: point(px(frame.x as f32), px(frame.y as f32)),
        size: size(px(frame.width as f32), px(frame.height as f32)),
    }
}
