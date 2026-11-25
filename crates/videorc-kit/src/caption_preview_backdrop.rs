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
    appearance: Option<Appearance>,
}

impl CaptionPreviewBackdropEl {
    pub fn new(kind: CaptionPreviewBackdrop) -> Self {
        CaptionPreviewBackdropEl {
            kind,
            appearance: None,
        }
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

fn paint(window: &mut Window, bounds: Bounds<gpui::Pixels>, image: Arc<RenderImage>) {
    let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), image, 0, false);
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
        match self.kind {
            CaptionPreviewBackdrop::Light => div().size_full().bg(linear_gradient(
                135.0,
                linear_color_stop(hsla(t.video_ground_foreground), 0.0),
                linear_color_stop(hsla(t.video_ground_muted), 1.0),
            )
            .color_space(ColorSpace::Oklab)),
            CaptionPreviewBackdrop::Dark | CaptionPreviewBackdrop::Mixed => {
                let svg = match self.kind {
                    CaptionPreviewBackdrop::Dark => dark_svg(),
                    _ => mixed_svg(),
                };
                let raster = chrome::rasterise_for_kit(svg, 512, 288);
                div().size_full().overflow_hidden().child(match raster {
                    Some(image) => canvas(
                        move |_, _, _| (),
                        move |bounds, _, window, _| {
                            paint(window, bounds, image.clone());
                        },
                    )
                    .into_any_element(),
                    None => div()
                        .size_full()
                        .bg(hsla(t.video_ground))
                        .into_any_element(),
                })
            }
        }
    }
}
