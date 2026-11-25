//! Label (`components/ui/label.tsx`): 14 px / 500 words that name a
//! control. Disabled peers dim it; the cursor stays the arrow (desktop
//! controls never take not-allowed).

use gpui::{App, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px};

use crate::theme::{Appearance, hsla, resolve};

#[derive(IntoElement)]
pub struct Label {
    words: SharedString,
    disabled: bool,
    appearance: Option<Appearance>,
}

impl Label {
    pub fn new(words: impl Into<SharedString>) -> Self {
        Label {
            words: words.into(),
            disabled: false,
            appearance: None,
        }
    }

    /// Dim when the control it names is off.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Label {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(hsla(t.foreground))
            .when(self.disabled, |label| label.opacity(0.5))
            .child(self.words)
    }
}
