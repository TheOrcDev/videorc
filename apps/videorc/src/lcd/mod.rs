//! Retro LCD Studio kit (`components/lcd-panel.tsx`, plan 197 / plan 260):
//! each inspector section on one audiocn-style screen. Lives in the app
//! (not videorc-kit), as Electron keeps `lcd-panel.tsx` in the desktop app.
//!
//! Colours approximate the display's lit / dim / unlit ink from the theme's
//! primary and muted tokens until a dedicated LCD token pass lands. The
//! bezel is the chip glass (`LCD_ON_GLASS`), the screen a recess in it.
//!
//! audiocn's screen prints its words in capitals (`uppercase`) in a mono
//! face at `text-sm`; GPUI has no text transform, so the helpers capitalise
//! the words they draw and keep the sentence-case words as the AccessKit
//! name. Sentences (`message`) stay in sentence case, as `LCD_MESSAGE` does.

use gpui::{
    AnyElement, App, Bounds, ClickEvent, ColorSpace, Div, ElementId, Hsla, IntoElement,
    SharedString, Stateful, Window, canvas, div, fill, linear_color_stop, linear_gradient, point,
    prelude::*, px,
};
use videorc_kit::chrome::box_shadow;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::select::SelectTriggerState;
use videorc_kit::slider::Slider;
use videorc_kit::theme::{hsla, is_dark, with_alpha};
use videorc_kit::tokens::{Shadow, Theme, radius};
use videorc_kit::tooltip::tooltip;

/// The screen's face: `--font-mono` in Electron, the kit's loadable mono
/// (Menlo / Consolas / DejaVu Sans Mono).
pub const SCREEN_FONT: &str = videorc_kit::FONT_MONO;

/// The screen's text: `text-sm` with `leading-none`.
const SCREEN_TEXT_PX: f32 = 14.;
/// `LCD_MESSAGE`'s `leading-snug` (1.375) at the screen's size.
const MESSAGE_LINE_PX: f32 = 19.;

/// The words as the screen prints them (`uppercase`).
pub fn caps(words: impl Into<SharedString>) -> SharedString {
    SharedString::from(words.into().to_uppercase())
}

/// Lit pixel ink on the screen.
pub fn lit(theme: &Theme) -> Hsla {
    hsla(theme.primary)
}

/// Dim pixel ink (labels, secondary words).
pub fn dim(theme: &Theme) -> Hsla {
    hsla(with_alpha(theme.primary, 0.4))
}

/// Unlit hover wash behind a row.
pub fn unlit(theme: &Theme) -> Hsla {
    hsla(with_alpha(theme.primary, 0.07))
}

/// `LCD_FADER` (`lcd-panel.tsx:249-252`): the track in the dim ink, the
/// range and the knob lit, the knob's ring the screen's glow (lit at 60% in
/// dark, 22% in light, `lcd-display.tsx:29,33`).
pub fn fader(slider: Slider, theme: &Theme) -> Slider {
    let glow = with_alpha(theme.primary, if is_dark(theme) { 0.6 } else { 0.22 });
    slider
        .track_color(with_alpha(theme.primary, 0.4))
        .range_color(theme.primary)
        .thumb_color(theme.primary, glow)
}

/// The device picker on the screen (`lcd-device-picker.tsx:93-127`,
/// `LCD_VALUE_BUTTON`): the pick lit in capitals, the placeholder and a
/// disabled picker dim, then the pixel chevron; the unlit dots light behind
/// it on hover and while its list is open. The kit Select keeps the button,
/// the keys and the list.
pub fn picker_trigger(theme: &Theme) -> impl FnOnce(SelectTriggerState) -> AnyElement + 'static {
    let (lit_ink, dim_ink, unlit_ink) = (lit(theme), dim(theme), unlit(theme));
    move |state| {
        let quiet = state.label.is_none() || state.disabled;
        let ink = if quiet { dim_ink } else { lit_ink };
        let words = state.label.unwrap_or(state.placeholder);
        div()
            .id("lcd-picker-trigger")
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .mx(px(-4.))
            .px(px(4.))
            .py(px(2.))
            .rounded(px(radius::CHIP))
            .text_color(ink)
            .when(state.open, |trigger| trigger.bg(unlit_ink))
            .when(!state.disabled, |trigger| {
                trigger.hover(move |style| style.bg(unlit_ink))
            })
            .child(div().min_w_0().truncate().child(caps(words)))
            .child(pixel_chevron(ink))
            .into_any_element()
    }
}

/// `LcdPixelChevron` (down): five 2 px dots in a 5×3 grid, 10 × 6 px.
fn pixel_chevron(ink: Hsla) -> Div {
    let dot = |x: f32, y: f32| {
        div()
            .absolute()
            .left(px(x * 2.))
            .top(px(y * 2.))
            .size(px(2.))
            .bg(ink)
    };
    div()
        .relative()
        .flex_none()
        .w(px(10.))
        .h(px(6.))
        .child(dot(0., 0.))
        .child(dot(4., 0.))
        .child(dot(1., 1.))
        .child(dot(3., 1.))
        .child(dot(2., 2.))
}

/// The opaque solid for inverted key fills.
pub fn solid(theme: &Theme) -> Hsla {
    hsla(theme.glass_solid)
}

/// Record / stop key tone (logo LED red).
pub fn record_tone(theme: &Theme) -> Hsla {
    hsla(theme.live)
}

/// One inspector section's screen (`LcdPanel`: audiocn's `LcdDisplay` at
/// `size="sm"` with `LCD_ON_GLASS`): the chip glass bezel (`p-1.5`, its rim,
/// top highlight and drop) round a recessed screen (`px-3 py-1`).
pub fn panel(
    id: impl Into<ElementId>,
    theme: &Theme,
    aria: impl Into<SharedString>,
    child: impl IntoElement,
) -> impl IntoElement {
    let dark = is_dark(theme);
    // Dark: the window glass through the screen
    // (`color-mix(glass-solid 35%, transparent)`). Light: the backlit grey
    // `oklch(0.93 …)` of the ink, nearest in the tokens as the border tone.
    let glass = if dark {
        with_alpha(theme.glass_solid, 0.35)
    } else {
        theme.border
    };
    let (recess_blur, recess_ring) = if dark {
        (theme.chip_drop, theme.chip_drop)
    } else {
        (
            with_alpha(theme.foreground, 0.28),
            with_alpha(theme.foreground, 0.2),
        )
    };
    div()
        .id(id)
        .aria_label(aria)
        .flex()
        .flex_col()
        // `rounded-lg` (10 px) is the popup tier in GPUI; the panel tier is
        // the nearest a surface on the page may take.
        .rounded(px(radius::PANEL))
        .border_1()
        .border_color(hsla(theme.chip_rim))
        .bg(linear_gradient(
            180.0,
            linear_color_stop(hsla(theme.chip_fill_top), 0.0),
            linear_color_stop(hsla(theme.chip_fill_bottom), 1.0),
        )
        .color_space(ColorSpace::Oklab))
        .shadow(vec![
            box_shadow(&Shadow {
                inset: true,
                x: 0.0,
                y: 1.0,
                blur: 0.0,
                spread: 0.0,
                color: theme.chip_highlight,
            }),
            box_shadow(&Shadow {
                inset: false,
                x: 0.0,
                y: 1.0,
                blur: 2.0,
                spread: 0.0,
                color: theme.chip_drop,
            }),
        ])
        .p(px(6.))
        .child(
            div()
                .flex()
                .flex_col()
                .rounded(px(radius::ROW))
                .bg(hsla(glass))
                .shadow(vec![
                    box_shadow(&Shadow {
                        inset: true,
                        x: 0.0,
                        y: 1.0,
                        blur: if dark { 3.0 } else { 4.0 },
                        spread: 0.0,
                        color: recess_blur,
                    }),
                    box_shadow(&Shadow {
                        inset: true,
                        x: 0.0,
                        y: 0.0,
                        blur: 0.0,
                        spread: 1.0,
                        color: recess_ring,
                    }),
                ])
                .px(px(12.))
                .py(px(4.))
                .font_family(SCREEN_FONT)
                .text_size(px(SCREEN_TEXT_PX))
                .line_height(px(SCREEN_TEXT_PX))
                .font_weight(gpui::FontWeight::NORMAL)
                .text_color(lit(theme))
                .child(child),
        )
}

/// The dotted rule between rows (`LcdDisplaySeparator`): a dim dot every
/// 4 px on a 2 px line, painted in one pass.
pub fn separator(theme: &Theme) -> impl IntoElement {
    let ink = dim(theme);
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let left = f32::from(bounds.origin.x);
            let right = left + f32::from(bounds.size.width);
            let top = bounds.origin.y;
            let mut x = left + 1.;
            while x + 1. <= right {
                window.paint_quad(fill(
                    Bounds::new(point(px(x), top), gpui::size(px(1.), px(1.))),
                    ink,
                ));
                x += 4.;
            }
        },
    )
    .w_full()
    .h(px(2.))
    .flex_none()
}

/// Words that are a sentence (blocked reason, switch status, takeover hint).
pub fn message(theme: &Theme, words: impl Into<SharedString>) -> impl IntoElement {
    div()
        .py(px(6.))
        .line_height(px(MESSAGE_LINE_PX))
        .text_color(dim(theme))
        .child(words.into())
}

/// Section title on the screen, with an optional action (Open Images cog).
pub fn header(
    theme: &Theme,
    title: impl Into<SharedString>,
    action: Option<AnyElement>,
) -> impl IntoElement {
    let mut row = div()
        .flex()
        .min_h(px(32.))
        .items_center()
        .justify_between()
        .gap(px(16.))
        .py(px(6.))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_color(lit(theme))
                .child(caps(title)),
        );
    if let Some(action) = action {
        row = row.child(
            div()
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(12.))
                .child(action),
        );
    }
    div().flex().flex_col().child(row).child(separator(theme))
}

/// Dim action words that light on hover ("Open Permissions", a blocked jump).
pub fn action_button(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let label = label.into();
    let ink = dim(theme);
    let lit_ink = lit(theme);
    div()
        .id(id)
        .aria_label(label.clone())
        .flex()
        .min_w_0()
        .items_center()
        .gap(px(8.))
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(2.))
        .text_color(ink)
        .hover(|style| style.bg(unlit(theme)).text_color(lit_ink))
        .cursor_pointer()
        .on_click(on_click)
        .child(div().truncate().child(caps(label)))
        .child(icon(IconName::CaretRight, 10., lit_ink))
}

/// Settings cog that opens the owning page ("Open Sources", "Open Images").
pub fn cog(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let label = label.into();
    let tip = label.clone();
    let ink = dim(theme);
    let lit_ink = lit(theme);
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(2.))
        .text_color(ink)
        .hover(|style| style.bg(unlit(theme)).text_color(lit_ink))
        .cursor_pointer()
        .tooltip(tooltip(tip))
        .aria_label(label)
        .on_click(on_click)
        .child(icon(IconName::GearSix, 14., ink))
}

/// A transport key on the screen (Record, Go Live, Stop).
pub fn key(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    tone: KeyTone,
    disabled: bool,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let border = match tone {
        KeyTone::Ink => lit(theme),
        KeyTone::Record => record_tone(theme),
    };
    let label = label.into();
    let ink_fill = solid(theme);
    let muted = dim(theme);
    let mut button = div()
        .id(id)
        .aria_label(label.clone())
        .flex()
        .flex_1()
        .min_w_0()
        .min_h(px(36.))
        .items_center()
        .justify_center()
        .gap(px(6.))
        .rounded(px(radius::CHIP))
        .border_2()
        .border_color(if disabled { muted } else { border })
        .px(px(8.))
        .text_color(if disabled { muted } else { border })
        // `text-[0.85em]` of the screen's 14 px.
        .text_size(px(12.))
        .line_height(px(12.));
    if !disabled {
        button = button
            .cursor_pointer()
            .hover(|style| style.bg(border).text_color(ink_fill))
            .on_click(on_click);
    }
    // `whitespace-nowrap` with no truncation (`lcd-panel.tsx:193`): a long
    // label runs into the key's padding, as Electron's does, never "RECO…".
    button
        .children(leading)
        .child(div().flex_none().whitespace_nowrap().child(caps(label)))
        .children(trailing)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyTone {
    Ink,
    Record,
}

/// A fact row that jumps to its page: dim label, lit value, pixel chevron.
pub fn nav_row(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    value: impl IntoElement,
    on_navigate: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let label = label.into();
    div()
        .id(id)
        .aria_label(label.clone())
        .flex()
        .min_w_0()
        .items_center()
        .justify_between()
        .gap(px(16.))
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(8.))
        .hover(|style| style.bg(unlit(theme)))
        .cursor_pointer()
        .on_click(on_navigate)
        .child(
            div()
                .flex_shrink_0()
                .text_color(dim(theme))
                .child(caps(label)),
        )
        .child(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(px(8.))
                .text_color(lit(theme))
                .child(div().min_w_0().truncate().child(value))
                .child(icon(IconName::CaretRight, 10., lit(theme))),
        )
}

/// A press row that flips On/Off (a takeover).
pub fn press_row(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    pressed: bool,
    disabled: bool,
    on_press: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let label = label.into();
    let ink = if pressed { lit(theme) } else { dim(theme) };
    let mut row = div()
        .id(id)
        .aria_label(label.clone())
        .flex()
        .min_w_0()
        .items_center()
        .justify_between()
        .gap(px(16.))
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(8.))
        .text_color(ink);
    if !disabled {
        row = row
            .hover(|style| style.bg(unlit(theme)))
            .cursor_pointer()
            .on_click(on_press);
    }
    row.child(div().min_w_0().truncate().child(caps(label)))
        .child(
            div()
                .flex_shrink_0()
                .child(caps(if pressed { "On" } else { "Off" })),
        )
}

/// A value button on the screen (Mute, Needs permission, Resume, On/Off):
/// `LCD_VALUE_BUTTON`, the words in capitals.
pub fn value_button(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    lit_fill: bool,
    disabled: bool,
    tip: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    value_button_with(
        id, theme, None, false, label, lit_fill, disabled, tip, on_click,
    )
}

/// [`value_button`] with a glyph before its words (the Microphone's
/// speaker and Mute), in the words' ink: dim at rest and lit on hover, as
/// the retro mute is (`text-(--lcd-display-ink-dim) hover:text-lit`).
#[allow(clippy::too_many_arguments)]
pub fn icon_value_button(
    id: impl Into<ElementId>,
    theme: &Theme,
    glyph: IconName,
    label: impl Into<SharedString>,
    lit_fill: bool,
    disabled: bool,
    tip: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    value_button_with(
        id,
        theme,
        Some(glyph),
        true,
        label,
        lit_fill,
        disabled,
        tip,
        on_click,
    )
}

#[allow(clippy::too_many_arguments)]
fn value_button_with(
    id: impl Into<ElementId>,
    theme: &Theme,
    glyph: Option<IconName>,
    dim_at_rest: bool,
    label: impl Into<SharedString>,
    lit_fill: bool,
    disabled: bool,
    tip: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    let ink_fill = solid(theme);
    let lit_ink = lit(theme);
    let dim_ink = dim(theme);
    let ink = if lit_fill {
        ink_fill
    } else if disabled || dim_at_rest {
        dim_ink
    } else {
        lit_ink
    };
    let mut button = div()
        .id(id)
        .aria_label(label.clone())
        .flex()
        .min_w_0()
        .items_center()
        .gap(px(8.))
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(2.));
    if lit_fill {
        button = button.bg(lit_ink).text_color(ink_fill);
    } else {
        button = button
            .text_color(ink)
            .hover(|style| style.bg(unlit(theme)).text_color(lit_ink));
    }
    if !disabled {
        button = button.cursor_pointer().on_click(on_click);
    }
    if let Some(tip) = tip {
        button = button.tooltip(tooltip(tip));
    }
    button
        .children(glyph.map(|glyph| icon(glyph, 14., ink)))
        .child(div().truncate().child(caps(label)))
}

/// On/Off switch drawn as lit words (LcdPanelSwitch).
pub fn switch_words(
    id: impl Into<ElementId>,
    theme: &Theme,
    checked: bool,
    disabled: bool,
    aria: impl Into<SharedString>,
    on_change: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let words = if checked { "On" } else { "Off" };
    value_button(id, theme, words, checked, disabled, None, on_change).aria_label(aria)
}
