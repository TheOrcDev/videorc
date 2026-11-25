//! Separator (`components/ui/separator.tsx`): a 1 px border rule that
//! splits a column or a row. Horizontal fills the width; vertical stretches
//! with its parent.

use gpui::{App, Div, IntoElement, StyleRefinement, Window, div, prelude::*, px};

use crate::theme::{Appearance, hsla, resolve};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SeparatorOrientation {
    #[default]
    Horizontal,
    Vertical,
}

#[derive(IntoElement)]
pub struct Separator {
    base: Div,
    orientation: SeparatorOrientation,
    appearance: Option<Appearance>,
}

impl Separator {
    pub fn new() -> Self {
        Separator {
            base: div(),
            orientation: SeparatorOrientation::Horizontal,
            appearance: None,
        }
    }

    pub fn orientation(mut self, orientation: SeparatorOrientation) -> Self {
        self.orientation = orientation;
        self
    }

    pub fn horizontal(self) -> Self {
        self.orientation(SeparatorOrientation::Horizontal)
    }

    pub fn vertical(self) -> Self {
        self.orientation(SeparatorOrientation::Vertical)
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for Separator {
    fn default() -> Self {
        Self::new()
    }
}

impl Styled for Separator {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for Separator {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let rule = self.base.flex_none().bg(hsla(t.border));
        match self.orientation {
            SeparatorOrientation::Horizontal => rule.h(px(1.0)).w_full().into_any_element(),
            SeparatorOrientation::Vertical => rule.w(px(1.0)).self_stretch().into_any_element(),
        }
    }
}
