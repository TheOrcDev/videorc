//! Retro LCD Studio kit (`components/lcd-panel.tsx`, plan 197 / plan 260):
//! each inspector section on one audiocn-style screen. Lives in the app
//! (not videorc-kit), as Electron keeps `lcd-panel.tsx` in the desktop app.
//!
//! Colours approximate the display's lit / dim / unlit ink from the theme's
//! primary and muted tokens until a dedicated LCD token pass lands. The
//! bezel is a chip-like recess on glass.

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Hsla, IntoElement, SharedString, Window, div,
    prelude::*, px,
};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, font, radius, text};
use videorc_kit::tooltip::tooltip;

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

/// The opaque solid for inverted key fills.
pub fn solid(theme: &Theme) -> Hsla {
    hsla(theme.glass_solid)
}

/// Record / stop key tone (logo LED red).
pub fn record_tone(theme: &Theme) -> Hsla {
    hsla(theme.live)
}

/// One inspector section's screen.
pub fn panel(
    id: impl Into<ElementId>,
    theme: &Theme,
    aria: impl Into<SharedString>,
    child: impl IntoElement,
) -> impl IntoElement {
    let bezel = hsla(theme.chip_fill_top);
    let edge = hsla(theme.chip_fill_bottom);
    let glass = hsla(with_alpha(theme.glass_solid, 0.35));
    div()
        .id(id)
        .flex()
        .flex_col()
        .rounded(px(radius::CHIP))
        .border_1()
        .border_color(edge)
        .bg(bezel)
        .p(px(3.))
        .child(
            div()
                .flex()
                .flex_col()
                .rounded(px(radius::ROW))
                .bg(glass)
                .px(px(12.))
                .py(px(4.))
                .font_family(font::MONO[0])
                .type_scale(text::META)
                .aria_label(aria)
                .child(child),
        )
}

/// A hairline between rows on the screen.
pub fn separator(theme: &Theme) -> impl IntoElement {
    div()
        .w_full()
        .h(px(1.))
        .my(px(2.))
        .bg(dim(theme))
        .opacity(0.35)
}

/// Words that are a sentence (blocked reason, switch status, takeover hint).
pub fn message(theme: &Theme, words: impl Into<SharedString>) -> impl IntoElement {
    div().py(px(6.)).text_color(dim(theme)).child(words.into())
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
                .child(title.into()),
        );
    if let Some(action) = action {
        row = row.child(
            div()
                .flex()
                .shrink_0()
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
    let ink = dim(theme);
    let lit_ink = lit(theme);
    div()
        .id(id)
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
        .child(div().truncate().child(label.into()))
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
    let fill = solid(theme);
    let muted = dim(theme);
    let mut button = div()
        .id(id)
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
        .text_size(px(12.));
    if !disabled {
        button = button
            .cursor_pointer()
            .hover(|style| style.bg(border).text_color(fill))
            .on_click(on_click);
    }
    button
        .children(leading)
        .child(div().truncate().child(label.into()))
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
    div()
        .id(id)
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
        .child(div().shrink_0().text_color(dim(theme)).child(label.into()))
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
    let ink = if pressed { lit(theme) } else { dim(theme) };
    let mut row = div()
        .id(id)
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
    row.child(div().min_w_0().truncate().child(label.into()))
        .child(div().shrink_0().child(if pressed { "On" } else { "Off" }))
}

/// A value button on the screen (Mute, Needs permission, Resume, On/Off).
pub fn value_button(
    id: impl Into<ElementId>,
    theme: &Theme,
    label: impl Into<SharedString>,
    lit_fill: bool,
    disabled: bool,
    tip: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let fill = solid(theme);
    let lit_ink = lit(theme);
    let dim_ink = dim(theme);
    let mut button = div()
        .id(id)
        .flex()
        .min_w_0()
        .items_center()
        .gap(px(8.))
        .rounded(px(radius::CHIP))
        .px(px(4.))
        .py(px(2.));
    if lit_fill {
        button = button.bg(lit_ink).text_color(fill);
    } else {
        button = button
            .text_color(if disabled { dim_ink } else { lit_ink })
            .hover(|style| style.bg(unlit(theme)).text_color(lit_ink));
    }
    if !disabled {
        button = button.cursor_pointer().on_click(on_click);
    }
    if let Some(tip) = tip {
        button = button.tooltip(tooltip(tip));
    }
    button.child(div().truncate().child(label.into()))
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
    div().aria_label(aria).child(value_button(
        id, theme, words, checked, disabled, None, on_change,
    ))
}
