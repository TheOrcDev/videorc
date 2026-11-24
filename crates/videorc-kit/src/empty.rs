//! Empty (`components/ui/empty.tsx`): an empty state in words only —
//! short muted text, centred, with an optional 14 px / 500 title and an
//! action. No media tile, no illustration, no dashed box and no radius of
//! its own. The pane or list it sits in sets the space around it.

use gpui::{AnyElement, App, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, hsla, resolve},
    tokens::text,
};

#[derive(IntoElement)]
pub struct Empty {
    title: Option<SharedString>,
    description: Option<SharedString>,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl Empty {
    pub fn new() -> Self {
        Empty {
            title: None,
            description: None,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    /// Optional 14 px / 500 title above the muted line.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Short muted text.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for Empty {
    fn default() -> Self {
        Empty::new()
    }
}

impl ParentElement for Empty {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Empty {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let header = div()
            .flex()
            .max_w(px(384.0))
            .flex_col()
            .items_center()
            .gap(px(4.0))
            .when_some(self.title, |header, title| {
                header.child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child(title),
                )
            })
            .when_some(self.description, |header, description| {
                header.child(
                    div()
                        .text_size(px(text::META.size))
                        .line_height(px(text::META.line_height))
                        .text_color(hsla(t.muted_foreground))
                        .child(description),
                )
            });

        div()
            .flex()
            .w_full()
            .min_w(px(0.0))
            .flex_1()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .p(px(24.0))
            .text_center()
            .child(header)
            .when(!self.children.is_empty(), |empty| {
                empty.child(
                    div()
                        .flex()
                        .w_full()
                        .max_w(px(384.0))
                        .min_w(px(0.0))
                        .flex_col()
                        .items_center()
                        .gap(px(12.0))
                        .children(self.children),
                )
            })
    }
}
