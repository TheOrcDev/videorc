//! SectionLabel: the one recipe for the small name over a group of rows or
//! fields (`components/section-label.tsx`), 11 px at 600 in the tertiary
//! tier: the sidebar's groups, a grouped list's label, a block of fields.

use gpui::{App, IntoElement, SharedString, Window, div, prelude::*};

use crate::{
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::text,
};

#[derive(IntoElement)]
pub struct SectionLabel {
    words: SharedString,
    appearance: Option<Appearance>,
}

impl SectionLabel {
    pub fn new(words: impl Into<SharedString>) -> Self {
        SectionLabel {
            words: words.into(),
            appearance: None,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for SectionLabel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        div()
            .type_scale(text::LABEL)
            .text_color(hsla(t.subtle))
            .child(self.words)
    }
}
