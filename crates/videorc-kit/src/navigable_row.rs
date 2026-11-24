//! NavigableRow (`components/navigable-row.tsx`): a fact row of icon,
//! label and value. When the value's one true home is another page, the row
//! is a button with a chevron that jumps there ([`NavigableRow::on_navigate`]),
//! and a hint lists the facts a short value stands for, on hover and focus.
//! On the row metrics: 32 px, 12 px padding, flush inside a
//! [`GroupedList`](crate::list_row::GroupedList). The Studio's Session rows
//! and Settings' pointer rows are this one component.
//!
//! A text value gives way first: the label keeps its width and the value
//! truncates ("Microphone" beside "Microphone (HD Pro Webcam C920)", never
//! "Mic…"). A control value (a Stop button) keeps its width instead, and the
//! label truncates.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, SharedString, Window, div,
    prelude::*, px,
};

use crate::{
    chrome::focus_ring,
    icon::{IconName, icon},
    list_row::GroupedRow,
    theme::{Appearance, hsla, resolve},
    tokens::{radius, size},
    tooltip::tooltip,
};

type NavigateHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

enum Value {
    Text(SharedString),
    Control(AnyElement),
}

#[derive(IntoElement)]
pub struct NavigableRow {
    id: ElementId,
    label: SharedString,
    value: Value,
    icon: Option<AnyElement>,
    leading: Option<AnyElement>,
    hint: Vec<SharedString>,
    on_navigate: Option<NavigateHandler>,
    grouped: bool,
    appearance: Option<Appearance>,
}

impl NavigableRow {
    /// A row whose value is words.
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self::with_value(id, label, Value::Text(value.into()))
    }

    /// A row whose value is a control (a Stop button) or a composed value.
    pub fn with_control(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        value: impl IntoElement,
    ) -> Self {
        Self::with_value(id, label, Value::Control(value.into_any_element()))
    }

    fn with_value(id: impl Into<ElementId>, label: impl Into<SharedString>, value: Value) -> Self {
        NavigableRow {
            id: id.into(),
            label: label.into(),
            value,
            icon: None,
            leading: None,
            hint: Vec::new(),
            on_navigate: None,
            grouped: false,
            appearance: None,
        }
    }

    /// The row's icon, 16 px in secondary text (an SVG tinted by its text
    /// colour takes it).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A small visual in the icon's place, when the row shows a picture (a
    /// thumbnail of the pick). Keep it 16 px tall.
    pub fn leading(mut self, leading: impl IntoElement) -> Self {
        self.leading = Some(leading.into_any_element());
        self
    }

    /// The facts a summarised value stands for, one per line. Shown only on
    /// a row that navigates, since only a button takes focus.
    pub fn hint(mut self, lines: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.hint = lines.into_iter().map(Into::into).collect();
        self
    }

    /// Makes the row a button that jumps to the value's one true home.
    pub fn on_navigate(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_navigate = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl GroupedRow for NavigableRow {
    fn grouped(mut self) -> Self {
        self.grouped = true;
        self
    }
}

/// The tooltip's text for a hint: one fact per line.
pub fn hint_text(lines: &[SharedString]) -> Option<SharedString> {
    (!lines.is_empty()).then(|| {
        lines
            .iter()
            .map(|line| &**line)
            .collect::<Vec<_>>()
            .join("\n")
            .into()
    })
}

impl RenderOnce for NavigableRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let navigates = self.on_navigate.is_some();
        let text_value = matches!(self.value, Value::Text(_));
        let corner = if self.grouped { 0.0 } else { radius::ROW };
        let leading = match self.icon {
            Some(mark) => Some(
                div()
                    .flex_none()
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(hsla(t.muted_foreground))
                    .child(mark)
                    .into_any_element(),
            ),
            None => self.leading,
        };
        let label = div()
            .min_w(px(0.0))
            .truncate()
            .text_color(hsla(t.muted_foreground))
            .map(|label| {
                if text_value {
                    label.flex_none()
                } else {
                    label.flex_1()
                }
            })
            .child(self.label);
        let value = div()
            .min_w(px(0.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_color(hsla(t.foreground))
            .font_weight(FontWeight::MEDIUM)
            .when(text_value, |value| value.flex_1().justify_end())
            .child(match self.value {
                Value::Text(words) => div()
                    .min_w(px(0.0))
                    .truncate()
                    .child(words)
                    .into_any_element(),
                Value::Control(control) => control,
            })
            .when(navigates, |value| {
                value.child(icon(IconName::CaretRight, 14.0, hsla(t.muted_foreground)))
            });
        let body = |row: gpui::Div| {
            row.w_full()
                .h(px(size::ROW))
                .flex()
                .items_center()
                .gap(px(10.0))
                .px(px(12.0))
                .text_size(px(14.0))
                .line_height(px(20.0))
                .children(leading)
                .child(label)
                .child(value)
        };
        match self.on_navigate {
            Some(on_navigate) => {
                let ring = focus_ring(t);
                let mut row = gpui_base::Button::new(self.id)
                    .w_full()
                    .rounded(px(corner))
                    .hover(|style| style.bg(hsla(t.accent)))
                    .focus_visible(move |style| style.shadow(vec![ring]))
                    .on_click(move |event, window, cx| on_navigate(event, window, cx))
                    .child(body(div()));
                if let Some(text) = hint_text(&self.hint) {
                    row = row.tooltip(tooltip(text));
                }
                row.into_any_element()
            }
            None => body(div()).rounded(px(corner)).into_any_element(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hint_reads_one_fact_per_line() {
        assert_eq!(hint_text(&[]), None);
        let lines: Vec<SharedString> = vec!["1080p".into(), "1080p".into(), "60 fps".into()];
        assert_eq!(hint_text(&lines).as_deref(), Some("1080p\n1080p\n60 fps"));
    }
}
