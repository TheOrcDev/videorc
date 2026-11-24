//! Kbd: a key chip (`components/ui/kbd.tsx`), a glass keycap with a bright
//! top edge and a dark bottom edge and the secondary-grey glyph. A shortcut
//! goes through `ShortcutKeys`, which prints it per platform into this chip.

use gpui::{
    App, ColorSpace, FontWeight, IntoElement, SharedString, Window, div, linear_color_stop,
    linear_gradient, prelude::*, px,
};

use crate::{
    chrome::box_shadow,
    theme::{Appearance, FONT, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, radius},
};

#[derive(IntoElement)]
pub struct Kbd {
    label: SharedString,
    on_filled: Option<Color>,
    appearance: Option<Appearance>,
}

impl Kbd {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Kbd {
            label: label.into(),
            on_filled: None,
            appearance: None,
        }
    }

    /// Inside a filled button (the chrome primary, destructive, Record, Go
    /// Live) the grey keycap reads at 2.38:1, so the chip takes the
    /// button's own ink on a faint fill of it, with no glass.
    pub fn on_filled(mut self, ink: Color) -> Self {
        self.on_filled = Some(ink);
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Kbd {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let chip = div()
            .h(px(20.0))
            .min_w(px(20.0))
            .px(px(4.0))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .rounded(px(radius::CHIP))
            .border_1()
            .font_family(FONT)
            .text_size(px(11.0))
            .font_weight(FontWeight::MEDIUM)
            .child(self.label);
        match self.on_filled {
            Some(ink) => chip
                .border_color(hsla(with_alpha(ink, 0.3)))
                .bg(hsla(with_alpha(ink, 0.1)))
                .text_color(hsla(ink)),
            None => chip
                .border_color(hsla(t.keycap_rim))
                .bg(linear_gradient(
                    180.0,
                    linear_color_stop(hsla(t.keycap_fill_top), 0.0),
                    linear_color_stop(hsla(t.keycap_fill_bottom), 1.0),
                )
                .color_space(ColorSpace::Oklab))
                .shadow(vec![
                    box_shadow(&Shadow {
                        inset: true,
                        x: 0.0,
                        y: 1.0,
                        blur: 0.0,
                        spread: 0.0,
                        color: t.keycap_highlight,
                    }),
                    box_shadow(&Shadow {
                        inset: true,
                        x: 0.0,
                        y: -1.0,
                        blur: 0.0,
                        spread: 0.0,
                        color: t.keycap_base,
                    }),
                ])
                .text_color(hsla(t.muted_foreground)),
        }
    }
}

/// Key chips side by side with the standard gap (two shortcuts, or ↑ ↓).
pub fn kbd_group(chips: impl IntoIterator<Item = Kbd>) -> gpui::Div {
    div().flex().items_center().gap(px(4.0)).children(chips)
}
