//! Badge: a glass chip (`components/ui/badge.tsx`). Every badge is a small
//! piece of the window glass and its text stays monochrome. A status chip
//! carries its tone in a glowing dot; an emphasis chip (failed, on air)
//! tints the glass itself.

use gpui::{
    AnyElement, App, ColorSpace, FontWeight, IntoElement, SharedString, Window, div,
    linear_color_stop, linear_gradient, prelude::*, px,
};

use crate::{
    chrome::{self, Direction, box_shadow},
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, Theme, radius},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BadgeVariant {
    /// Neutral glass.
    #[default]
    Default,
    /// The same glass with secondary text: 9:16, beta, counts, Idle.
    Outline,
    /// Secondary text, no glass.
    Ghost,
    /// Status: the tone lives in the dot, never in the text.
    Success,
    Warning,
    /// A grey dot that does not glow.
    Neutral,
    /// Emphasis: tinted glass for what must interrupt.
    Destructive,
    Live,
    /// A highlight's On stream: a polished chrome chip with a green dot.
    Chrome,
    /// A member's chip: a chrome plate.
    Plate,
}

#[derive(IntoElement)]
pub struct Badge {
    label: SharedString,
    variant: BadgeVariant,
    /// Leading mark (`data-icon="inline-start"`): EyeSlash on Screen hidden,
    /// a platform glyph on chat arrival chips. On status variants it replaces
    /// the glowing dot (Electron StatusBadge's `icon`).
    icon: Option<AnyElement>,
    appearance: Option<Appearance>,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Badge {
            label: label.into(),
            variant: BadgeVariant::Default,
            icon: None,
            appearance: None,
        }
    }

    pub fn variant(mut self, variant: BadgeVariant) -> Self {
        self.variant = variant;
        self
    }

    /// 12–14 px leading icon before the label (Screen hidden EyeSlash, chat marks).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// The chip's own light and shade: `inset 0 1px 0 highlight, 0 1px 2px drop`.
pub(crate) fn chip_shadows(t: &Theme) -> Vec<gpui::BoxShadow> {
    vec![
        box_shadow(&Shadow {
            inset: true,
            x: 0.0,
            y: 1.0,
            blur: 0.0,
            spread: 0.0,
            color: t.chip_highlight,
        }),
        box_shadow(&Shadow {
            inset: false,
            x: 0.0,
            y: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: t.chip_drop,
        }),
    ]
}

/// `glass-chip`: the rim, the two-stop fill and the chip's light and shade.
pub(crate) fn glass_chip(element: gpui::Div, t: &Theme) -> gpui::Div {
    element
        .border_color(hsla(t.chip_rim))
        .bg(linear_gradient(
            180.0,
            linear_color_stop(hsla(t.chip_fill_top), 0.0),
            linear_color_stop(hsla(t.chip_fill_bottom), 1.0),
        )
        .color_space(ColorSpace::Oklab))
        .shadow(chip_shadows(t))
}

/// The status dot: the tone, a 2 px halo at 22% and an 8 px glow.
pub(crate) fn dot(tone: Color, glow: f32) -> impl IntoElement {
    let mut halo = vec![box_shadow(&Shadow {
        inset: false,
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 2.0,
        color: with_alpha(tone, 0.22),
    })];
    if glow > 0.0 {
        halo.push(box_shadow(&Shadow {
            inset: false,
            x: 0.0,
            y: 0.0,
            blur: 8.0,
            spread: 0.0,
            color: with_alpha(tone, glow),
        }));
    }
    div()
        .flex_none()
        .size(px(6.0))
        .rounded_full()
        .bg(hsla(tone))
        .shadow(halo)
}

impl RenderOnce for Badge {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        // 11 px at weight 500: a tag, not the 600 section label. The 16 px
        // line box holds Segoe UI's descenders.
        let chip = || {
            div()
                .relative()
                .h(px(20.0))
                .px(px(6.0))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .gap(px(4.0))
                .rounded(px(radius::TAG))
                .border_1()
                .border_color(gpui::transparent_black())
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .font_weight(FontWeight::MEDIUM)
        };
        let words = div().relative().child(self.label);
        let leading = self.icon.map(|mark| {
            div()
                .relative()
                .flex_none()
                .items_center()
                .justify_center()
                .child(mark)
        });
        let status = |tone: Color, glow: f32, leading: Option<gpui::Div>| {
            let mark = match leading {
                Some(icon) => icon.into_any_element(),
                None => div().relative().child(dot(tone, glow)).into_any_element(),
            };
            glass_chip(chip(), t)
                .gap(px(6.0))
                .text_color(hsla(t.foreground))
                .child(mark)
        };
        match self.variant {
            BadgeVariant::Default => glass_chip(chip(), t)
                .text_color(hsla(t.foreground))
                .children(leading)
                .child(words),
            BadgeVariant::Outline => glass_chip(chip(), t)
                .text_color(hsla(t.muted_foreground))
                .children(leading)
                .child(words),
            BadgeVariant::Ghost => chip()
                .text_color(hsla(t.muted_foreground))
                .children(leading)
                .child(words),
            BadgeVariant::Success => status(t.success, t.chip_dot_glow, leading).child(words),
            BadgeVariant::Warning => status(t.warning, t.chip_dot_glow, leading).child(words),
            BadgeVariant::Neutral => status(t.muted_foreground, 0.0, leading)
                .text_color(hsla(t.muted_foreground))
                .child(words),
            BadgeVariant::Destructive => tinted(chip(), t, t.destructive)
                .children(leading)
                .child(words),
            BadgeVariant::Live => tinted(chip(), t, t.live).children(leading).child(words),
            BadgeVariant::Chrome => {
                let mark = match leading {
                    Some(icon) => icon.into_any_element(),
                    None => div()
                        .relative()
                        .child(dot(t.success, t.chip_dot_glow))
                        .into_any_element(),
                };
                chip()
                    .gap(px(6.0))
                    .shadow(chrome::shadows(t.chrome_fill_shadow))
                    .text_color(hsla(t.chrome_fill_ink))
                    .child(chrome::metal(
                        t.chrome_fill_stops,
                        [radius::TAG; 4],
                        Direction::Down,
                    ))
                    .child(mark)
                    .child(words)
            }
            BadgeVariant::Plate => chip()
                .bg(linear_gradient(
                    180.0,
                    linear_color_stop(hsla(t.chrome_plate_top), 0.0),
                    linear_color_stop(hsla(t.chrome_plate_bottom), 1.0),
                )
                .color_space(ColorSpace::Oklab))
                .shadow(plate_shadows(t))
                .text_color(hsla(t.foreground))
                .children(leading)
                .child(words),
        }
    }
}

/// `glass-chip-tinted`: the tone mixed into the rim and the fill, and into
/// the ink over its base.
pub(crate) fn tinted(chip: gpui::Div, t: &Theme, tone: Color) -> gpui::Div {
    chip.border_color(hsla(with_alpha(tone, t.chip_tint_rim)))
        .bg(linear_gradient(
            180.0,
            linear_color_stop(hsla(with_alpha(tone, t.chip_tint_top)), 0.0),
            linear_color_stop(hsla(with_alpha(tone, t.chip_tint_bottom)), 1.0),
        )
        .color_space(ColorSpace::Oklab))
        .shadow(chip_shadows(t))
        .text_color(hsla(chrome::mix(
            tone,
            t.chip_tint_ink_base,
            t.chip_tint_ink,
        )))
}

/// `chrome-plate`: `inset 0 1px 0 hi, inset 0 0 0 1px rim`. Public so a
/// screen that wears the plate (the shell's selected row) uses this recipe
/// rather than a copy.
pub fn plate_shadows(t: &Theme) -> Vec<gpui::BoxShadow> {
    vec![
        box_shadow(&Shadow {
            inset: true,
            x: 0.0,
            y: 1.0,
            blur: 0.0,
            spread: 0.0,
            color: t.chrome_plate_hi,
        }),
        box_shadow(&Shadow {
            inset: true,
            x: 0.0,
            y: 0.0,
            blur: 0.0,
            spread: 1.0,
            color: t.chrome_plate_rim,
        }),
    ]
}
