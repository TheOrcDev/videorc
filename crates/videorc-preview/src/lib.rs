//! `videorc-preview`: the product's preview element (plan 220 S2.3a), grown
//! from the S0.2h spike crate `videorc-spike-layer`, whose presenter and
//! measurements it keeps unchanged.
//!
//! The texture route (S0.2c, S0.2f) binds a new `wgpu::Texture` to a UI
//! element every video frame, so the whole UI redraws 60 times a second. The
//! element here keeps the video out of the UI's redraw: a `CAMetalLayer`
//! added as a sublayer of the window's own `NSView` (through the raw window
//! handle), placed on the preview element's rect during the UI's layout pass,
//! and presented from its own thread. The UI framework draws nothing per
//! video frame; it only moves the layer when the element moves.
//!
//! The pieces:
//!
//! - [`LayerRect`]: a rect in the window's content, top-left points.
//! - [`bounds`]: the one `PreviewSurfaceBounds` (in `videorc-protocol`)
//!   built from the element's rect and the window's geometry.
//! - [`first_frame`]: the first-frame and presenting contracts, ported from
//!   Electron main's `native-preview-first-frame.ts`: pure decisions with
//!   their tests, on every platform.
//! - [`stats`]: the measurement types (per-frame timings, the resize
//!   tracker), with no platform code.
//! - [`playback`] (S3.7b, macOS): the Library's player on the same layer
//!   and presenter: a second feed over the backend's `playback.*` family
//!   (open, play, pause, seek, mute, close; `playback.frameReady` leased by
//!   id) and a [`playback::PlaybackElement`] the Library page places on its
//!   slot. No contracts' watchdog: a playback is not a live capture, and its
//!   status is the backend's.
//! - macOS only: [`VideoLayer`] (main thread: owns the sublayer, sets its
//!   frame inside a `CATransaction` with implicit actions disabled, reads
//!   back the frame Core Animation displays), [`Presenter`] (its own thread:
//!   imports each leased IOSurface through `videorc-gpu-import` with a
//!   three-entry cache like the addon's, draws it contain-fit into each
//!   layer's next drawable with one render pass, presents, waits for the
//!   GPU, reports timings), [`feed`] (the latest-wins frame lease loop over
//!   the backend's `preview.frameReady` lane, the surface lifecycle and the
//!   present reports), [`element`] (the two halves tied together with the
//!   contracts' watchdog and its status) and [`words`] (what a slot says
//!   for that status: the renderer's preview states, never a reason).
//!
//! - Linux only (plan 220 S4.2c): [`linux`], the presenter on P4-D2's
//!   route: the CPU ring's frames on a `wl_subsurface` over a `wl_shm` pool
//!   (Wayland) or an X11 child window over MIT-SHM, outside Slint's redraw,
//!   named for what it is and never a native GPU surface; the texture
//!   route is the fallback and the editor's.
//!
//! Windows compiles the platform-free modules only; its native route is
//! S4.1c.

pub mod bounds;
pub mod chrome;
pub mod first_frame;
pub mod lifecycle;
pub mod stats;

pub mod cpu_frames;
#[cfg(not(target_os = "macos"))]
pub mod cpu_playback;
pub mod element;
pub mod feed;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub mod playback;
pub mod words;
#[cfg(target_os = "macos")]
pub use macos::{
    ClockAnchor, ImportOutcome, LayerPresent, PresentReport, Presenter, PresenterClient, VideoLayer,
};

/// A layer rect in the window's content coordinates: top-left origin, points
/// (logical pixels), the way every UI framework reports an element's rect.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LayerRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LayerRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Two rects agree within `tolerance` points on every edge.
    pub fn approx_eq(&self, other: &LayerRect, tolerance: f64) -> bool {
        (self.x - other.x).abs() <= tolerance
            && (self.y - other.y).abs() <= tolerance
            && (self.width - other.width).abs() <= tolerance
            && (self.height - other.height).abs() <= tolerance
    }

    /// Snaps the rect to the device pixel grid at `scale` (2 on a Retina
    /// display), so the layer's edges land on whole pixels.
    pub fn snapped(&self, scale: f64) -> LayerRect {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let snap = |value: f64| (value * scale).round() / scale;
        let x0 = snap(self.x);
        let y0 = snap(self.y);
        let x1 = snap(self.x + self.width);
        let y1 = snap(self.y + self.height);
        LayerRect {
            x: x0,
            y: y0,
            width: (x1 - x0).max(0.0),
            height: (y1 - y0).max(0.0),
        }
    }

    /// The largest rect of `aspect` (width / height) that fits in `self`,
    /// centred: the docked preview's placeholder gives the layer exactly the
    /// video's rect, so the letterbox is the UI's background, not the layer's.
    pub fn contain(&self, aspect: f64) -> LayerRect {
        if !(aspect.is_finite() && aspect > 0.0) || self.width <= 0.0 || self.height <= 0.0 {
            return *self;
        }
        let (width, height) = if self.width / self.height > aspect {
            (self.height * aspect, self.height)
        } else {
            (self.width, self.width / aspect)
        };
        LayerRect {
            x: self.x + (self.width - width) / 2.0,
            y: self.y + (self.height - height) / 2.0,
            width,
            height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contain_fits_the_aspect_and_centres() {
        let outer = LayerRect::new(240.0, 0.0, 1040.0, 800.0);
        let fitted = outer.contain(16.0 / 9.0);
        assert!((fitted.width - 1040.0).abs() < 1e-9);
        assert!((fitted.height - 585.0).abs() < 1e-9);
        assert!((fitted.x - 240.0).abs() < 1e-9);
        assert!((fitted.y - 107.5).abs() < 1e-9);
        let tall = LayerRect::new(0.0, 0.0, 400.0, 800.0).contain(2.0);
        assert!((tall.width - 400.0).abs() < 1e-9);
        assert!((tall.height - 200.0).abs() < 1e-9);
        assert!((tall.y - 300.0).abs() < 1e-9);
    }

    #[test]
    fn snapping_lands_on_half_points_at_2x() {
        let rect = LayerRect::new(240.3, 107.26, 1040.1, 584.9).snapped(2.0);
        assert_eq!(rect, LayerRect::new(240.5, 107.5, 1040.0, 584.5));
        assert_eq!(
            LayerRect::new(1.0, 1.0, 1.0, 1.0).snapped(f64::NAN),
            LayerRect::new(1.0, 1.0, 1.0, 1.0)
        );
    }

    #[test]
    fn approx_eq_uses_the_tolerance_on_every_edge() {
        let a = LayerRect::new(0.0, 0.0, 10.0, 10.0);
        assert!(a.approx_eq(&LayerRect::new(0.2, 0.0, 10.0, 9.8), 0.25));
        assert!(!a.approx_eq(&LayerRect::new(0.0, 0.0, 10.0, 9.0), 0.25));
    }
}
