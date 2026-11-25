//! SelectableText: pointer-selectable copy (`select-text` in Electron).
//! Wraps [`gpui_base::SelectableText`]. The app must render one
//! [`gpui_base::TextSelectionLayer`] above its content and call
//! [`gpui_base::init`] at startup so selection and copy work.

use gpui::{
    App, ElementId, FontWeight, IntoElement, SharedString, TextStyleRefinement, Window, prelude::*,
    px,
};
use gpui_base::SelectableText as BaseSelectableText;

use crate::theme::{Appearance, FONT, hsla, resolve};

#[derive(IntoElement)]
pub struct SelectableText {
    id: ElementId,
    text: SharedString,
    size: f32,
    weight: FontWeight,
    appearance: Option<Appearance>,
}

impl SelectableText {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        SelectableText {
            id: id.into(),
            text: text.into(),
            size: 14.0,
            weight: FontWeight::NORMAL,
            appearance: None,
        }
    }

    pub fn text_size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    pub fn font_weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for SelectableText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let color = hsla(t.foreground);
        BaseSelectableText::new(self.id, self.text).text_style(TextStyleRefinement {
            font_family: Some(FONT.into()),
            font_size: Some(px(self.size).into()),
            font_weight: Some(self.weight),
            color: Some(color),
            ..Default::default()
        })
    }
}
