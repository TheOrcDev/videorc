//! Camera-off avatar (`camera-off-avatar.tsx`; P400): a circle with the
//! name's first letter; "Camera off" for screen readers. Geometry from
//! `guests::tile`.

use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use videorc_app_core::guests::tile::{camera_off_look, name_initial};
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, text};

/// Screen-reader label for the camera-off look.
pub const CAMERA_OFF_LABEL: &str = "Camera off";

/// The camera-off look centred in a tile of `tile_w`×`tile_h` (canvas px).
pub fn camera_off_avatar(
    name: &str,
    tile_w: i64,
    tile_h: i64,
    t: &Theme,
    label: &str,
) -> AnyElement {
    let (diameter, font) = camera_off_look(tile_w, tile_h);
    let letter = name_initial(name);
    div()
        .id("camera-off-avatar")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(diameter as f32))
                .rounded_full()
                .bg(hsla(with_alpha(t.video_ground_muted, 0.35)))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_size(px(font as f32))
                        .text_color(hsla(t.video_ground_foreground))
                        .child(letter),
                ),
        )
        .aria_label(label.to_string())
        .into_any_element()
}
