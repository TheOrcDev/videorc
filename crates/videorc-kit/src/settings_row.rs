//! SettingsRow (`components/ui/field.tsx`'s SettingsRow): one settings
//! row — the label and its 12 px description on the left, the control on
//! the right. Rows sit in a [`SettingsGroup`] (the React twin's
//! `FieldGroup variant="grouped"`): one inset group split by hairlines.
//! `error` is the row's own refusal or failure under the description.

use gpui::{
    AnyElement, App, ElementId, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::{radius, text},
};

#[derive(IntoElement)]
pub struct SettingsRow {
    id: ElementId,
    label: SharedString,
    description: Option<SharedString>,
    error: Option<SharedString>,
    /// When the control is a button that cannot take the label's name.
    accessibility_label: Option<SharedString>,
    children: SmallVec<[AnyElement; 2]>,
    /// Flush inside a [`SettingsGroup`]: no own padding (the group adds it).
    grouped: bool,
    appearance: Option<Appearance>,
}

impl SettingsRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        SettingsRow {
            id: id.into(),
            label: label.into(),
            description: None,
            error: None,
            accessibility_label: None,
            children: SmallVec::new(),
            grouped: false,
            appearance: None,
        }
    }

    /// 12 px secondary text under the label.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The row's own refusal or failure under the description.
    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self
    }

    /// Names the row when the control is a button (a label cannot name one).
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }

    pub(crate) fn grouped(mut self) -> Self {
        self.grouped = true;
        self
    }
}

impl ParentElement for SettingsRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SettingsRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let name = self
            .accessibility_label
            .clone()
            .unwrap_or_else(|| self.label.clone());

        let content = div()
            .flex()
            .flex_1()
            .min_w(px(0.0))
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(t.foreground))
                    .child(self.label),
            )
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
                        .type_scale(text::META)
                        .text_color(hsla(t.destructive))
                        .child(error),
                )
            });

        div()
            .id(self.id)
            .role(gpui::Role::Group)
            .aria_label(name)
            .flex()
            .w_full()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .when(!self.grouped, |row| row.px(px(12.0)).py(px(10.0)))
            .when(self.grouped, |row| row.px(px(12.0)).py(px(10.0)))
            .child(content)
            .children(self.children)
    }
}

/// The grouped settings list: one inset group split by hairlines, as React's
/// `FieldGroup variant="grouped"`.
#[derive(IntoElement)]
pub struct SettingsGroup {
    rows: SmallVec<[SettingsRow; 4]>,
    appearance: Option<Appearance>,
}

impl SettingsGroup {
    pub fn new() -> Self {
        SettingsGroup {
            rows: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn row(mut self, row: SettingsRow) -> Self {
        self.rows.push(row.grouped());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for SettingsGroup {
    fn default() -> Self {
        SettingsGroup::new()
    }
}

impl RenderOnce for SettingsGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let appearance = self.appearance;
        let rows = self.rows.into_iter().enumerate().map(|(index, row)| {
            let row = match appearance {
                Some(appearance) => row.appearance(appearance),
                None => row,
            };
            div()
                .when(index > 0, |row| {
                    row.border_t_1().border_color(hsla(t.border))
                })
                .child(row)
        });
        div()
            .flex()
            .w_full()
            .flex_col()
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.inset))
            .children(rows)
    }
}
