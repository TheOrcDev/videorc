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
    icon::{IconName, icon},
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::{radius, text},
};

#[derive(IntoElement)]
pub struct SettingsRow {
    id: ElementId,
    label: SharedString,
    /// An element before the label's words (Guests' "● Room closed").
    label_leading: Option<AnyElement>,
    description: Option<AnyElement>,
    error: Option<SharedString>,
    /// When the control is a button that cannot take the label's name.
    accessibility_label: Option<SharedString>,
    children: SmallVec<[AnyElement; 2]>,
    /// Flush inside a [`SettingsGroup`]: no own padding (the group adds it).
    grouped: bool,
    /// Ungrouped flush: no padding (Electron bare horizontal Field / L7 K2).
    flush: bool,
    appearance: Option<Appearance>,
}

impl SettingsRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        SettingsRow {
            id: id.into(),
            label: label.into(),
            label_leading: None,
            description: None,
            error: None,
            accessibility_label: None,
            children: SmallVec::new(),
            grouped: false,
            flush: false,
            appearance: None,
        }
    }

    /// 12 px secondary text under the label (string or a status-dot row).
    /// An element before the label's words, 6 px on (a StatusDot: "● Room
    /// closed"). The row is still named by the label's words.
    pub fn label_leading(mut self, leading: impl IntoElement) -> Self {
        self.label_leading = Some(leading.into_any_element());
        self
    }

    /// The description as balanced lines, as Electron's horizontal
    /// FieldDescription draws it (`text-balance`): use it for words, and
    /// [`Self::description`] for an element.
    pub fn description_balanced(mut self, text: impl Into<SharedString>) -> Self {
        let id = SharedString::from(format!("{}/description", self.id));
        self.description =
            Some(crate::balanced_text::BalancedText::new(id, text, 12.0, 18.0).into_any_element());
        self
    }

    pub fn description(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    /// The row's own refusal or failure under the description (FieldError look).
    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self
    }

    /// Names the row when the control is a button (a label cannot name one).
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// No padding outside a group (Electron ungrouped horizontal Field).
    pub fn flush(mut self, flush: bool) -> Self {
        self.flush = flush;
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
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(t.foreground))
                    .children(
                        self.label_leading
                            .map(|leading| div().flex_none().flex().items_center().child(leading)),
                    )
                    .child(div().min_w(px(0.0)).child(self.label)),
            )
            .children(self.description.map(|description| {
                div()
                    .type_scale(text::META)
                    .line_height(px(18.0))
                    .text_color(hsla(t.muted_foreground))
                    .child(description)
            }))
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

        let pad = !self.flush && !self.grouped;
        div()
            .id(self.id)
            .role(gpui::Role::Group)
            .aria_label(name)
            .flex()
            .w_full()
            .flex_row()
            .items_start()
            .gap(px(12.0))
            .when(pad || self.grouped, |row| row.px(px(12.0)).py(px(10.0)))
            .when(self.flush, |row| row.gap(px(12.0)))
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
