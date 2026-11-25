//! Field (`components/ui/field.tsx`): a named control — label, the control,
//! then description / error (shadcn source order). Vertical stacks the name
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
    /// Trailing chip on the label row (title "0/100" counter).
    label_end: Option<AnyElement>,
    /// An element right after the label (`FieldLabel` is `w-fit gap-2`).
    label_after: Option<AnyElement>,
    description: Option<SharedString>,
    /// Description between the label and the control (`FieldContent`).
    description_above: bool,
    /// Electron's plain Field over its own row: the description 2 px under
    /// the label at a 16 px line (Output's Windows encoder).
    compact: bool,
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
            label_end: None,
            label_after: None,
            description: None,
            description_above: false,
            compact: false,
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

    /// Trailing element on the label row (character count, etc.).
    pub fn label_end(mut self, end: impl IntoElement) -> Self {
        self.label_end = Some(end.into_any_element());
        self
    }

    /// An element right after the label, 8 px on (a badge, a status dot):
    /// Electron's `FieldLabel` is `w-fit gap-2`, so its children follow the
    /// words. [`Self::label_end`] sits at the row's far end instead.
    pub fn label_after(mut self, after: impl IntoElement) -> Self {
        self.label_after = Some(after.into_any_element());
        self
    }

    /// The description under the label and above the control, as
    /// `FieldContent` (label + description, `gap-1`) before the control.
    pub fn description_above(mut self, above: bool) -> Self {
        self.description_above = above;
        self
    }

    /// The tight label + description stack (2 px apart, 16 px lines) of a
    /// plain Field, instead of SettingsRow's 4 px and 18 px.
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    /// 12 px muted line after the control (shadcn FieldDescription order).
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Destructive refusal after the control (shadcn FieldError order).
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
        let _invalid = self.invalid;
        let label_row = self.label.map(|label| {
            let words = div()
                .min_w(px(0.0))
                .text_size(px(14.0))
                .line_height(px(20.0))
                .font_weight(FontWeight::MEDIUM)
                // Electron keeps the label in the foreground; the error
                // line below carries the refusal.
                .text_color(hsla(t.foreground))
                .child(label);
            let name = div()
                .flex()
                .flex_1()
                .min_w(px(0.0))
                .items_center()
                .gap(px(8.0))
                .child(words)
                .children(
                    self.label_after
                        .map(|after| div().flex_none().flex().items_center().child(after)),
                );
            let mut row = div()
                .flex()
                .w_full()
                .items_center()
                .gap(px(8.0))
                .child(name);
            if let Some(end) = self.label_end {
                row = row.child(
                    div()
                        .flex_none()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(end),
                );
            }
            row
        });

        let compact = self.compact;
        let description = self.description.map(|description| {
            div()
                .type_scale(text::META)
                .line_height(px(if compact { 16.0 } else { 18.0 }))
                .text_color(hsla(t.muted_foreground))
                .child(description)
        });
        let error = self.error.map(|error| {
            let error = FieldError::new(error);
            match self.appearance {
                Some(appearance) => error.appearance(appearance),
                None => error,
            }
        });

        match self.orientation {
            // FieldContent first: label and description, 4 px apart, then
            // the control and the error.
            FieldOrientation::Vertical if self.description_above => div()
                .id(self.id)
                .role(gpui::Role::Group)
                .flex()
                .w_full()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .w_full()
                        .flex_col()
                        .gap(px(4.0))
                        .children(label_row)
                        .children(description),
                )
                .children(self.children)
                .children(error),
            // shadcn: label → control → description → error
            FieldOrientation::Vertical => div()
                .id(self.id)
                .role(gpui::Role::Group)
                .flex()
                .w_full()
                .flex_col()
                .gap(px(12.0))
                .children(label_row)
                .children(self.children)
                .children(description)
                .children(error),
            FieldOrientation::Horizontal => {
                let side = div()
                    .flex()
                    .min_w(px(0.0))
                    .flex_1()
                    .flex_col()
                    .gap(px(if compact { 2.0 } else { 4.0 }))
                    .children(label_row)
                    .children(description)
                    .children(error);
                div()
                    .id(self.id)
                    .role(gpui::Role::Group)
                    .flex()
                    .w_full()
                    .flex_row()
                    .items_center()
                    .gap(px(12.0))
                    .child(side)
                    .children(self.children)
            }
        }
    }
}

/// `FieldError` on its own (a refusal under a row or a group): 12 px words in
/// the foreground with the destructive XCircle (fill, 14 px) before them,
/// spoken as an alert. The colour marks it; the words stay readable.
#[derive(IntoElement)]
pub struct FieldError {
    message: SharedString,
    appearance: Option<Appearance>,
}

impl FieldError {
    pub fn new(message: impl Into<SharedString>) -> Self {
        FieldError {
            message: message.into(),
            appearance: None,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for FieldError {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let name = self.message.clone();
        div()
            .id(SharedString::from(format!("field-error/{}", self.message)))
            .role(gpui::Role::Alert)
            .aria_label(name)
            .flex()
            .items_start()
            .gap(px(6.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(hsla(t.foreground))
            .child(div().flex_none().mt(px(1.0)).child(icon(
                IconName::XCircleFill,
                14.0,
                hsla(t.destructive),
            )))
            .child(div().min_w(px(0.0)).child(self.message))
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
