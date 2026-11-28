//! Window frames in GPUI's coordinates and the core's (`desktop::window_frames`),
//! for the windows that save theirs: Notes, the Stream Manager, the Captions
//! reader and the floating Preview. The main window keeps none: like
//! Electron's (P043, P1553) it opens at 1180×780 every time.

use gpui::{App, Bounds, Pixels, Size, point, px, size};
use videorc_app_core::desktop::window_frames::{
    Display, Rect, centered_frame_in_work_area, clamp_min_size_to_work_area,
    clamp_restored_frame_to_work_area, min_size_for_frame,
};

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

/// Initial centered bounds and effective minimum size for a window, clamped to
/// the primary display's work area (minus the taskbar/dock) at every scale.
pub(crate) fn initial_bounds_and_min_size(
    desired: (f64, f64),
    min_size: (f64, f64),
    cx: &App,
) -> (Bounds<Pixels>, Size<Pixels>) {
    let primary = cx
        .primary_display()
        .or_else(|| cx.displays().into_iter().next());
    if let Some(display) = primary {
        let work_area = rect_of(display.visible_bounds());
        let frame = centered_frame_in_work_area(desired, min_size, work_area);
        let (min_w, min_h) = clamp_min_size_to_work_area(min_size, work_area);
        return (bounds_of(frame), size(px(min_w as f32), px(min_h as f32)));
    }
    (
        Bounds::centered(None, size(px(desired.0 as f32), px(desired.1 as f32)), cx),
        size(px(min_size.0 as f32), px(min_size.1 as f32)),
    )
}

/// Clamp either a remembered/targeted opening frame or a fresh default frame
/// (plus the window's minimum size) into the display's work area.
pub(crate) fn clamp_opening_bounds(
    saved_or_target: Option<Bounds<Pixels>>,
    desired: (f64, f64),
    min_size: (f64, f64),
    cx: &App,
) -> (Bounds<Pixels>, Size<Pixels>) {
    if let Some(bounds) = saved_or_target {
        let all = displays(cx);
        let frame = clamp_restored_frame_to_work_area(rect_of(bounds), min_size, &all);
        let (min_w, min_h) = min_size_for_frame(frame, min_size, &all);
        return (bounds_of(frame), size(px(min_w as f32), px(min_h as f32)));
    }
    initial_bounds_and_min_size(desired, min_size, cx)
}

/// Display metadata for the Screen key. GPUI exposes IDs and geometry, but
/// no portable labels: the core uses Electron's "Screen N" fallback. macOS
/// supplies native labels and global coordinates for the same GPUI IDs.
pub(crate) fn remote_displays(
    cx: &App,
) -> Vec<videorc_app_core::studio::remote_screens::RemoteDisplay> {
    let primary = cx.primary_display().map(|display| display.id());
    cx.displays()
        .iter()
        .map(|display| {
            #[cfg(target_os = "macos")]
            if let Some(native) = crate::platform::macos::remote_display(u64::from(display.id())) {
                return native;
            }
            #[cfg(target_os = "windows")]
            if let Some(native) = crate::platform::windows::remote_display(u64::from(display.id()))
            {
                return native;
            }
            videorc_app_core::studio::remote_screens::RemoteDisplay {
                id: u64::from(display.id()).to_string(),
                name: String::new(),
                bounds: rect_of(display.bounds()),
                work_area: rect_of(display.visible_bounds()),
                primary: primary == Some(display.id()),
            }
        })
        .collect()
}
