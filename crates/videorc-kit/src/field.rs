//! Field (`components/ui/field.tsx`): a named control — label, optional
//! description / error, and the control itself. Vertical stacks the name
//! above the control (Room sounds, room audio routing); horizontal is the
//! SettingsRow shape. [`FieldGroup`] stacks fields, optionally as one
//! inset grouped list.

use gpui::{
    AnyElement, App, ElementId, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    icon::{IconName, icon},
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::{radius, text},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FieldOrientation {
    #[default]
    Vertical,
    Horizontal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FieldGroupVariant {
    #[default]
    Default,
    /// One inset group split by hairlines (`FieldGroup variant="grouped"`).
    Grouped,
}

#[derive(IntoElement)]
pub struct Field {
    id: ElementId,
    orientation: FieldOrientation,
    label: Option<SharedString>,
    description: Option<SharedString>,
    error: Option<SharedString>,
    invalid: bool,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl Field {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Field {
            id: id.into(),
            orientation: FieldOrientation::Vertical,
            label: None,
            description: None,
            error: None,
            invalid: false,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn orientation(mut self, orientation: FieldOrientation) -> Self {
        self.orientation = orientation;
        self
    }

    pub fn horizontal(self) -> Self {
        self.orientation(FieldOrientation::Horizontal)
    }

    /// 14 px / 500 name for the control.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// 12 px muted line under the label.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Destructive refusal under the description.
    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self.invalid = true;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for Field {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Field {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let content = div()
            .flex()
            .min_w(px(0.0))
            .flex_col()
            .gap(px(4.0))
            .when(self.orientation == FieldOrientation::Horizontal, |c| {
                c.flex_1()
            })
            .when_some(self.label, |content, label| {
                content.child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(hsla(if self.invalid {
                            t.destructive
                        } else {
                            t.foreground
                        }))
                        .child(label),
                )
            })
            .when_some(self.description, |content, description| {
                content.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(description),
                )
            })
            .when_some(self.error, |content, error| {
                content.child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(6.0))
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(hsla(t.foreground))
                        .child(icon(IconName::XCircleFill, 14.0, hsla(t.destructive)))
                        .child(div().min_w(px(0.0)).child(error)),
                )
            });

        let body = match self.orientation {
            FieldOrientation::Vertical => div()
                .id(self.id)
                .role(gpui::Role::Group)
                .flex()
                .w_full()
                .flex_col()
                .gap(px(8.0))
                .child(content)
                .children(self.children),
            FieldOrientation::Horizontal => div()
                .id(self.id)
                .role(gpui::Role::Group)
                .flex()
                .w_full()
                .flex_row()
                .items_center()
                .gap(px(12.0))
                .child(content)
                .children(self.children),
        };
        body
    }
}

/// Stack of fields; `Grouped` is the inset macOS-settings list.
#[derive(IntoElement)]
pub struct FieldGroup {
    variant: FieldGroupVariant,
    children: SmallVec<[AnyElement; 4]>,
    appearance: Option<Appearance>,
}

impl FieldGroup {
    pub fn new() -> Self {
        FieldGroup {
            variant: FieldGroupVariant::Default,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn variant(mut self, variant: FieldGroupVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn grouped(self) -> Self {
        self.variant(FieldGroupVariant::Grouped)
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for FieldGroup {
    fn default() -> Self {
        FieldGroup::new()
    }
}

impl ParentElement for FieldGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for FieldGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        match self.variant {
            FieldGroupVariant::Default => div()
                .flex()
                .w_full()
                .flex_col()
                .gap(px(24.0))
                .children(self.children)
                .into_any_element(),
            FieldGroupVariant::Grouped => {
                let kids: Vec<_> = self
                    .children
                    .into_iter()
                    .enumerate()
                    .map(|(index, child)| {
                        div()
                            .px(px(12.0))
                            .py(px(10.0))
                            .when(index > 0, |row| {
                                row.border_t_1().border_color(hsla(t.border))
                            })
                            .child(child)
                            .into_any_element()
                    })
                    .collect();
                div()
                    .flex()
                    .w_full()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(px(radius::ROW))
                    .border_1()
                    .border_color(hsla(t.border))
                    .bg(hsla(t.inset))
                    .children(kids)
                    .into_any_element()
            }
        }
    }
}
