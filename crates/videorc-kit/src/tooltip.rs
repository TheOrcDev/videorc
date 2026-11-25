//! Tooltip (`components/ui/tooltip.tsx`): the tooltip tier of the float
//! glass, 12 px words, an optional key chip. It rides GPUI's own tooltip
//! (hover delay, placement): `.tooltip(tooltip("Record"))` on any stateful
//! element, or `Button::tooltip`.

use gpui::{AnyView, App, Context, IntoElement, Render, SharedString, Window, div, prelude::*, px};

use crate::{
    motion::{Glass, floating, presence},
    shortcut_keys::ShortcutKeys,
    theme::{FONT, current, hsla},
    tokens::radius,
};

enum ShortcutSource {
    /// GPUI keystroke syntax (`cmd-shift-j`).
    Keystrokes(SharedString),
    /// Electron accelerator (`CmdOrCtrl+Shift+J`).
    Accelerator(SharedString),
}

pub struct Tooltip {
    text: SharedString,
    shortcut: Option<ShortcutSource>,
}

impl Render for Tooltip {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = current(window, cx).theme();
        // Each tooltip is a new view, so it fades and grows in from the
        // start. GPUI drops a tooltip the moment the pointer leaves, so it
        // has no fade out.
        let progress = presence("kit-tooltip", true, window, cx).progress;
        let glass = Glass {
            fill: t.glass_float_tooltip,
            rim: t.glass_float_rim,
            drop: t.glass_float_drop,
            radius: radius::ROW,
        };
        let chip = self.shortcut.as_ref().map(|source| match source {
            ShortcutSource::Keystrokes(keys) => ShortcutKeys::keystrokes_owned(keys.clone()),
            ShortcutSource::Accelerator(accel) => ShortcutKeys::accelerator(accel.clone()),
        });
        gpui_base::Tooltip::new("tooltip").child(
            floating(
                glass,
                progress,
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().child(self.text.clone()))
                    .children(chip),
            )
            .max_w(px(320.0))
            .px(px(8.0))
            .py(px(4.0))
            .when(self.shortcut.is_some(), |tip| tip.pr(px(4.0)))
            .font_family(FONT)
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(hsla(t.popover_foreground)),
        )
    }
}

/// A tooltip builder for GPUI's `.tooltip(...)`.
pub fn tooltip(
    text: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| {
        cx.new(|_| Tooltip {
            text: text.clone(),
            shortcut: None,
        })
        .into()
    }
}

/// A tooltip with a GPUI keystroke chip (`cmd-shift-j`). Accepts a runtime
/// string so screens need not `Box::leak` a live keymap binding.
pub fn tooltip_with_shortcut(
    text: impl Into<SharedString>,
    shortcut: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    let shortcut = shortcut.into();
    move |_, cx| {
        cx.new(|_| Tooltip {
            text: text.clone(),
            shortcut: Some(ShortcutSource::Keystrokes(shortcut.clone())),
        })
        .into()
    }
}

/// A tooltip with an Electron accelerator chip (`CmdOrCtrl+Shift+J`), for
/// bindings that still arrive in accelerator form from the live keymap.
pub fn tooltip_with_accelerator(
    text: impl Into<SharedString>,
    accelerator: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    let accelerator = accelerator.into();
    move |_, cx| {
        cx.new(|_| Tooltip {
            text: text.clone(),
            shortcut: Some(ShortcutSource::Accelerator(accelerator.clone())),
        })
        .into()
    }
}
