//! PanelSection (`components/panel-section.tsx`): the flush section every
//! pane is built from. No border box, background, radius or shadow: a 13 px
//! / 600 header, a 12 px description, an action on the title line, 16 px of
//! padding and a hairline to the next section.
//!
//! The title is a level 2 heading under the toolbar's level 1; a section
//! nested under another section's heading takes [`PanelSection::heading_level`]
//! 3. A titleless section is just padded content, and a section that is only
//! its header has no content block. GPUI has no `:last-child`, so the pane's
//! last section says [`PanelSection::last`] to drop its hairline.

use gpui::{
    AnyElement, App, ElementId, IntoElement, Role, SharedString, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::{size, text},
};

#[derive(IntoElement)]
pub struct PanelSection {
    id: ElementId,
    title: Option<SharedString>,
    description: Option<AnyElement>,
    icon: Option<AnyElement>,
    action: SmallVec<[AnyElement; 2]>,
    children: SmallVec<[AnyElement; 4]>,
    heading_level: usize,
    last: bool,
    appearance: Option<Appearance>,
}

impl PanelSection {
    pub fn new(id: impl Into<ElementId>) -> Self {
        PanelSection {
            id: id.into(),
            title: None,
            description: None,
            icon: None,
            action: SmallVec::new(),
            children: SmallVec::new(),
            heading_level: 2,
            last: false,
            appearance: None,
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// What the section is for, in 12 px secondary text.
    pub fn description(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    /// An icon before the title, 16 px in secondary text.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A control for the whole section, at the end of its header, centred on
    /// the title line.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action.push(action.into_any_element());
        self
    }

    /// 2 (the default) under the page, 3 when nested under a section.
    pub fn heading_level(mut self, level: usize) -> Self {
        self.heading_level = level.clamp(2, 3);
        self
    }

    /// The pane's last section: no hairline under it.
    pub fn last(mut self, last: bool) -> Self {
        self.last = last;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for PanelSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PanelSection {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let has_header =
            self.title.is_some() || self.description.is_some() || !self.action.is_empty();
        let has_content = !self.children.is_empty();
        let has_action = !self.action.is_empty();
        let icon = self.icon.map(|mark| {
            div()
                .flex_none()
                .size(px(16.0))
                .flex()
                .items_center()
                .justify_center()
                .text_color(hsla(t.muted_foreground))
                .child(mark)
        });
        let heading = self.title.map(|title| {
            div()
                .id("panel-section-title")
                .role(Role::Heading)
                .aria_level(self.heading_level)
                .flex()
                .items_center()
                .gap(px(8.0))
                .type_scale(text::SECTION)
                .text_color(hsla(t.foreground))
                .children(icon)
                .child(title)
        });
        let description = self.description.map(|description| {
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(description)
        });
        let header = has_header.then(|| {
            div()
                .min_h(px(24.0))
                .flex()
                .items_start()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .children(heading)
                        .children(description),
                )
                // As tall as the title line, so a 28 px button or a switch
                // centres on it.
                .when(has_action, |header| {
                    header.child(
                        div()
                            .flex_none()
                            .h(px(20.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .children(self.action),
                    )
                })
        });
        div()
            .id(self.id)
            .p(px(size::GUTTER))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .when(!self.last, |section| {
                section.border_b_1().border_color(hsla(t.border))
            })
            .children(header)
            .when(has_content, |section| {
                section.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .children(self.children),
                )
            })
    }
}
