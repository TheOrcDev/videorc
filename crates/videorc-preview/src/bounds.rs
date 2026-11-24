//! The one bounds type, built from the element's rect.
//!
//! `videorc_protocol::PreviewSurfaceBounds` is the only bounds type on the
//! Rust side since S2.3a: the backend keeps it in the surface status and
//! sizes the preview compositor from it (`width × scaleFactor` device pixels,
//! the sizing oracle), the native host and its helper read it, and this
//! crate writes it. Electron's four mirrors were the renderer's and main's
//! copies of the same shape; the TS one is generated from the Rust type
//! (S1.1b).
//!
//! The docked element places its own layer in-process, so the backend never
//! moves anything from these bounds; they are the surface's record of where
//! the preview is and how large to render.

use videorc_protocol::PreviewSurfaceBounds;

use crate::LayerRect;

/// Where the window sits, in points: its content's top-left on the screen
/// (top-left origin, as every UI framework reports it), its content size,
/// the screen's height (AppKit measures from the bottom) and the backing
/// scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowGeometry {
    pub screen_x: f64,
    pub screen_y: f64,
    pub content_width: f64,
    pub content_height: f64,
    pub screen_height: f64,
    pub scale_factor: f64,
}

/// How large the backend renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Canvas {
    /// The slot's own device pixels (the product's default: Electron's
    /// sizing oracle).
    Slot,
    /// A pinned canvas in pixels whatever the slot's size (the 4K60
    /// measurement; the layer contain-fits the frame).
    Pinned { width: u32, height: u32 },
}

/// The surface bounds for a layer on `rect` (top-left points in the window's
/// content) inside `window`, with the slot's corner radius in points.
pub fn surface_bounds(
    window: &WindowGeometry,
    rect: LayerRect,
    canvas: Canvas,
    corner_radius: f64,
) -> PreviewSurfaceBounds {
    let scale = if window.scale_factor.is_finite() && window.scale_factor > 0.0 {
        window.scale_factor.clamp(1.0, 3.0)
    } else {
        1.0
    };
    let (width, height) = match canvas {
        Canvas::Slot => (rect.width.max(1.0), rect.height.max(1.0)),
        Canvas::Pinned { width, height } => (
            f64::from(width.max(1)) / scale,
            f64::from(height.max(1)) / scale,
        ),
    };
    PreviewSurfaceBounds {
        screen_x: window.screen_x + rect.x,
        screen_y: window.screen_y + rect.y,
        width,
        height,
        scale_factor: scale,
        screen_height: Some(window.screen_height),
        clip_x: None,
        clip_y: None,
        clip_width: None,
        clip_height: None,
        visible: Some(rect.width > 0.0 && rect.height > 0.0),
        order_above_window_id: None,
        elevated: None,
        corner_radius: (corner_radius > 0.0).then_some(corner_radius),
        host_x: Some(rect.x),
        host_y: Some(rect.y),
        host_height: Some(window.content_height),
    }
}

/// The device pixels the backend renders for these bounds
/// (`surface_render_dimension` in `preview_surface.rs`).
pub fn render_size(bounds: &PreviewSurfaceBounds) -> (u32, u32) {
    let scale = if bounds.scale_factor.is_finite() && bounds.scale_factor > 0.0 {
        bounds.scale_factor.clamp(1.0, 3.0)
    } else {
        1.0
    };
    let dimension = |points: f64| (points * scale).round().max(1.0) as u32;
    (dimension(bounds.width), dimension(bounds.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> WindowGeometry {
        WindowGeometry {
            screen_x: 40.0,
            screen_y: 60.0,
            content_width: 1180.0,
            content_height: 780.0,
            screen_height: 982.0,
            scale_factor: 2.0,
        }
    }

    #[test]
    fn the_slot_canvas_renders_at_the_layers_device_pixels() {
        let rect = LayerRect::new(240.0, 57.0, 900.0, 506.25);
        let bounds = surface_bounds(&window(), rect, Canvas::Slot, 12.0);
        assert_eq!((bounds.screen_x, bounds.screen_y), (280.0, 117.0));
        assert_eq!((bounds.width, bounds.height), (900.0, 506.25));
        assert_eq!(bounds.scale_factor, 2.0);
        assert_eq!(bounds.screen_height, Some(982.0));
        assert_eq!((bounds.host_x, bounds.host_y), (Some(240.0), Some(57.0)));
        assert_eq!(bounds.host_height, Some(780.0));
        assert_eq!(bounds.corner_radius, Some(12.0));
        assert_eq!(bounds.visible, Some(true));
        assert_eq!(render_size(&bounds), (1800, 1013));
        // Every optional the docked element does not use stays off the wire.
        let wire = serde_json::to_value(&bounds).unwrap();
        for absent in ["clipX", "orderAboveWindowId", "elevated"] {
            assert!(wire.get(absent).is_none(), "{absent} should be absent");
        }
    }

    #[test]
    fn a_pinned_canvas_renders_at_its_pixels_whatever_the_slot() {
        let rect = LayerRect::new(240.0, 57.0, 900.0, 506.25);
        let bounds = surface_bounds(
            &window(),
            rect,
            Canvas::Pinned {
                width: 3840,
                height: 2160,
            },
            0.0,
        );
        assert_eq!((bounds.width, bounds.height), (1920.0, 1080.0));
        assert_eq!(render_size(&bounds), (3840, 2160));
        assert_eq!(bounds.corner_radius, None);
        assert_eq!(bounds.host_x, Some(240.0));
    }

    #[test]
    fn a_bad_scale_falls_back_to_one_and_an_empty_rect_is_hidden() {
        let bad = WindowGeometry {
            scale_factor: f64::NAN,
            ..window()
        };
        let bounds = surface_bounds(&bad, LayerRect::new(0.0, 0.0, 0.0, 0.0), Canvas::Slot, 0.0);
        assert_eq!(bounds.scale_factor, 1.0);
        assert_eq!(bounds.visible, Some(false));
        assert_eq!((bounds.width, bounds.height), (1.0, 1.0));
    }
}
