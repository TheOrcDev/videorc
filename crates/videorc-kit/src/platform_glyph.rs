//! PlatformGlyph (`components/platform-glyph.tsx`): the 30×24 destination
//! mark. YouTube is the official red play mark on the row surface (no tile);
//! X is the partner-kit lockup that follows the theme; every other platform
//! sits on a 24 px tinted chip with its 16 px mark.

use std::sync::Arc;

use gpui::{
    App, Bounds, ElementId, IntoElement, RenderImage, SharedString, Window, canvas, div,
    prelude::*, px,
};

use crate::{
    chat_platform::ChatPlatform,
    chrome,
    icon::{IconName, icon},
    theme::{Appearance, hsla, is_dark, resolve, with_alpha},
    tokens::{Color, Theme, fixed, radius},
};

/// Slot: Electron `h-6 w-7.5` (24 × 30).
const SLOT_W: f32 = 30.0;
const SLOT_H: f32 = 24.0;
/// Tile / X lockup edge.
const TILE: f32 = 24.0;
/// YouTube mark floor (ToS III.F.2a).
const YT_H: f32 = 20.0;
const YT_W: f32 = 28.6;
/// Mark crop inside the official artboard.
const YT_VIEW: &str = "102.6875 119.167969 396 277.402343";

#[derive(IntoElement)]
pub struct PlatformGlyph {
    id: ElementId,
    platform: ChatPlatform,
    appearance: Option<Appearance>,
}

impl PlatformGlyph {
    pub fn new(platform: ChatPlatform) -> Self {
        PlatformGlyph {
            id: ("platform-glyph", platform as usize).into(),
            platform,
            appearance: None,
        }
    }

    /// Override the stable element ID when repeating a platform under one parent.
    pub fn id(mut self, id: impl Into<ElementId>) -> Self {
        self.id = id.into();
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

fn paint_mark(window: &mut Window, bounds: Bounds<gpui::Pixels>, image: Arc<RenderImage>) {
    let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), image, 0, false);
}

fn brand_img(svg: &str, w: u32, h: u32) -> Option<Arc<RenderImage>> {
    chrome::rasterise_for_kit(svg, w, h)
}

fn youtube_svg() -> String {
    let raw = include_str!("../icons/youtube-icon-red.svg");
    // Crop clear space so the painted box is the visible mark.
    if let Some(rest) = raw
        .split_once("<svg")
        .and_then(|(_, rest)| rest.split_once('>').map(|(_, body)| body))
    {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{YT_VIEW}" width="{YT_W}" height="{YT_H}">{rest}"#
        )
    } else {
        raw.to_string()
    }
}

fn x_lockup_svg(dark: bool) -> &'static str {
    if dark {
        include_str!("../icons/x-logo-lockup-white-on-black.svg")
    } else {
        include_str!("../icons/x-logo-lockup-black-on-white.svg")
    }
}

/// Tile fill + ink for platforms that sit on a chip (not YouTube / X).
fn tile_colors(platform: ChatPlatform, t: &Theme) -> Option<(Color, Color)> {
    match platform {
        ChatPlatform::Twitch => Some((
            with_alpha(fixed::PLATFORM_TWITCH, 0.15),
            fixed::PLATFORM_TWITCH_INK,
        )),
        ChatPlatform::Kick => Some((fixed::PLATFORM_KICK, fixed::PLATFORM_KICK_INK)),
        ChatPlatform::Facebook => Some((
            with_alpha(fixed::PLATFORM_FACEBOOK, 0.15),
            fixed::PLATFORM_FACEBOOK,
        )),
        ChatPlatform::Instagram => Some((
            with_alpha(fixed::PLATFORM_INSTAGRAM, 0.15),
            fixed::PLATFORM_INSTAGRAM,
        )),
        ChatPlatform::Tiktok => Some((with_alpha(t.foreground, 0.1), t.foreground)),
        ChatPlatform::Custom => Some((with_alpha(t.foreground, 0.1), t.muted_foreground)),
        ChatPlatform::Youtube | ChatPlatform::X => None,
    }
}

impl RenderOnce for PlatformGlyph {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let label: SharedString = self.platform.label().into();
        let slot = div()
            .id(self.id)
            .flex()
            .flex_none()
            .w(px(SLOT_W))
            .h(px(SLOT_H))
            .items_center()
            .justify_center()
            .overflow_hidden()
            .role(gpui::Role::Image)
            .aria_label(label);

        match self.platform {
            ChatPlatform::Youtube => {
                let raster = brand_img(&youtube_svg(), (YT_W * 2.0) as u32, (YT_H * 2.0) as u32);
                let mark = match raster {
                    Some(image) => div()
                        .w(px(YT_W))
                        .h(px(YT_H))
                        .flex_none()
                        .child(canvas(
                            move |_, _, _| (),
                            move |bounds, _, window, _| {
                                paint_mark(window, bounds, image.clone());
                            },
                        ))
                        .into_any_element(),
                    None => icon(IconName::YoutubeLogo, YT_H, hsla(fixed::PLATFORM_YOUTUBE))
                        .into_any_element(),
                };
                slot.child(mark)
            }
            ChatPlatform::X => {
                let dark = is_dark(t);
                let raster = brand_img(x_lockup_svg(dark), 48, 48);
                let mark = match raster {
                    Some(image) => div()
                        .size(px(TILE))
                        .flex_none()
                        .overflow_hidden()
                        .rounded(px(radius::CHIP))
                        .child(canvas(
                            move |_, _, _| (),
                            move |bounds, _, window, _| {
                                paint_mark(window, bounds, image.clone());
                            },
                        ))
                        .into_any_element(),
                    None => div()
                        .size(px(TILE))
                        .rounded(px(radius::CHIP))
                        .bg(hsla(if dark { 0x000000ff } else { 0xffffffff }))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(
                            IconName::XLogo,
                            16.0,
                            hsla(if dark { 0xffffffff } else { 0x000000ff }),
                        ))
                        .into_any_element(),
                };
                slot.child(mark)
            }
            other => {
                let (fill, ink) = tile_colors(other, t).unwrap_or((t.muted, t.foreground));
                slot.child(
                    div()
                        .size(px(TILE))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(radius::CHIP))
                        .bg(hsla(fill))
                        .child(icon(other.icon(), 16.0, hsla(ink))),
                )
            }
        }
    }
}
