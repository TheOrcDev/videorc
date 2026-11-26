//! Caption preview backdrops: Electron's fixed preview gradients. GPUI has
//! no radial gradient, so dark/mixed are rasterised SVG images. Light uses
//! theme tokens (two-stop linear).

use std::sync::Arc;

use gpui::{
    App, Bounds, ColorSpace, IntoElement, RenderImage, Window, canvas, div, linear_color_stop,
    linear_gradient, prelude::*, px,
};

use crate::{
    chrome,
    theme::{Appearance, hsla, resolve},
};

/// A miniature's text: Electron's caption style cards draw their sample
/// caption at `text-[8px]` (captions-controls.tsx). It is a picture of a
/// caption, not text to read, so it is the one named exception to the
/// design guards' 11 px floor; reading text stays on the type scale.
pub const MINIATURE_TEXT_PX: f32 = 8.0;

/// Which Electron caption-preview surface to draw.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CaptionPreviewBackdrop {
    #[default]
    Light,
    Dark,
    Mixed,
}

#[derive(IntoElement)]
pub struct CaptionPreviewBackdropEl {
    kind: CaptionPreviewBackdrop,
    /// The frame's corner radius: the backdrop is clipped to it.
    radius: f32,
    appearance: Option<Appearance>,
}

impl CaptionPreviewBackdropEl {
    pub fn new(kind: CaptionPreviewBackdrop) -> Self {
        CaptionPreviewBackdropEl {
            kind,
            radius: 0.0,
            appearance: None,
        }
    }

    /// Clips the backdrop to the preview frame's corner radius (the raster
    /// too, which an ancestor's `overflow_hidden` does not round).
    pub fn rounded(mut self, radius: f32) -> Self {
        self.radius = radius.max(0.0);
        self
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

fn paint(window: &mut Window, bounds: Bounds<gpui::Pixels>, radius: f32, image: Arc<RenderImage>) {
    let corners = gpui::Corners::all(px(radius));
    let _ = window.paint_image(bounds, bounds, corners, image, 0, false);
}

fn dark_svg() -> &'static str {
    // 135deg #09090b → #27272a 55% → #18181b
    r##"<svg xmlns="http://www.w3.org/2000/svg" width="512" height="288" viewBox="0 0 512 288">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="55%" stop-color="#27272a"/>
      <stop offset="100%" stop-color="#18181b"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>"##
}

fn mixed_svg() -> &'static str {
    // radial slate + violet over 135deg #0f172a → #334155
    r##"<svg xmlns="http://www.w3.org/2000/svg" width="512" height="288" viewBox="0 0 512 288">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <radialGradient id="a" cx="25%" cy="20%" r="32%">
      <stop offset="0%" stop-color="#64748b"/>
      <stop offset="100%" stop-color="#64748b" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b" cx="78%" cy="70%" r="30%">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#base)"/>
  <rect width="100%" height="100%" fill="url(#a)"/>
  <rect width="100%" height="100%" fill="url(#b)"/>
</svg>"##
}

impl RenderOnce for CaptionPreviewBackdropEl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let radius = self.radius;
        match self.kind {
            CaptionPreviewBackdrop::Light => {
                div().size_full().rounded(px(radius)).bg(linear_gradient(
                    135.0,
                    linear_color_stop(hsla(t.video_ground_foreground), 0.0),
                    linear_color_stop(hsla(t.video_ground_muted), 1.0),
                )
                .color_space(ColorSpace::Oklab))
            }
            CaptionPreviewBackdrop::Dark | CaptionPreviewBackdrop::Mixed => {
                let svg = match self.kind {
                    CaptionPreviewBackdrop::Dark => dark_svg(),
                    _ => mixed_svg(),
                };
                let raster = chrome::rasterise_for_kit(svg, 512, 288);
                div()
                    .size_full()
                    .rounded(px(radius))
                    .overflow_hidden()
                    .child(match raster {
                        // A canvas has no size of its own: without `size_full`
                        // it lays out at 0×0 and the raster never paints.
                        Some(image) => canvas(
                            move |_, _, _| (),
                            move |bounds, _, window, _| {
                                paint(window, bounds, radius, image.clone());
                            },
                        )
                        .size_full()
                        .into_any_element(),
                        None => div()
                            .size_full()
                            .rounded(px(radius))
                            .bg(hsla(t.video_ground))
                            .into_any_element(),
                    })
            }
        }
    }
}
