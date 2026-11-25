//! StatusBadge (`components/status-badge.tsx`): a 22 px round glass chip.
//! The label is muted normal weight; the value is medium foreground. A
//! glowing 6 px tone dot leads, unless the tone is error/live (tinted chip,
//! no dot) or a leading icon replaces the dot.

use gpui::{AnyElement, App, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px};

use crate::{
    badge::{dot, glass_chip, tinted},
    status_dot::StatusTone,
    theme::{Appearance, hsla, resolve},
};

#[derive(IntoElement)]
pub struct StatusBadge {
    value: SharedString,
    label: Option<SharedString>,
    tone: StatusTone,
    icon: Option<AnyElement>,
    appearance: Option<Appearance>,
}

impl StatusBadge {
    pub fn new(value: impl Into<SharedString>) -> Self {
        StatusBadge {
            value: value.into(),
            label: None,
            tone: StatusTone::Neutral,
            icon: None,
            appearance: None,
        }
    }

    /// Muted label before the value ("Chat", "Captions").
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn tone(mut self, tone: StatusTone) -> Self {
        self.tone = tone;
        self
    }

    /// Replaces the glowing dot (and takes the tone when not error/live).
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

impl RenderOnce for StatusBadge {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let emphasis = matches!(self.tone, StatusTone::Error | StatusTone::Live);
        let (tone_color, glow) = self.tone.colors(t);

        let mark = if let Some(icon) = self.icon {
            Some(
                div()
                    .flex_none()
                    .size(px(14.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon)
                    .into_any_element(),
            )
        } else if !emphasis {
            Some(dot(tone_color, glow).into_any_element())
        } else {
            None
        };

        let words = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w(px(0.0))
            .overflow_hidden()
            .children(self.label.map(|label| {
                div()
                    .font_weight(FontWeight::NORMAL)
                    .text_color(hsla(if emphasis {
                        t.foreground
                    } else {
                        t.muted_foreground
                    }))
                    .opacity(if emphasis { 0.8 } else { 1.0 })
                    .child(label)
            }))
            .child(
                div()
                    .max_w(px(160.0))
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .child(self.value),
            );

        let chip = div()
            .flex()
            .flex_none()
            .h(px(22.0))
            .w_fit()
            .items_center()
            .gap(px(6.0))
            .overflow_hidden()
            .rounded_full()
            .border_1()
            .border_color(gpui::transparent_black())
            .px(px(10.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .whitespace_nowrap()
            .children(mark)
            .child(words);

        match self.tone {
            StatusTone::Error => tinted(chip, t, t.destructive),
            StatusTone::Live => tinted(chip, t, t.live),
            _ => glass_chip(chip, t).text_color(hsla(t.foreground)),
        }
    }
}
