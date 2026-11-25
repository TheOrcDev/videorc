//! ToggleGroup (`components/ui/toggle-group.tsx`): gpui-base's ToggleGroup
//! for the toolbar role and Toggle for pressed / focus / AccessKit, filter
//! chips on the chrome plate. Several values at once (`multiple`), or a
//! filter row where one is on. Choosing one value among 2–4 options is
//! [`crate::SegmentedControl`].
//!
//! Size and variant match the React twin's Toggle props (default / xs,
//! default / outline) without `<Name>Size` / `<Name>Variant` enums: the
//! twin's cva lives on `toggle`, not on `toggle-group`.
//!
//! An item's label is the default chip text and its accessible name. React's
//! `ToggleGroupItem` children are [`ToggleItem::child`]: a preview swatch,
//! title and description (Captions Style), which replaces the label text
//! while the label stays the AccessKit name.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Axis, ColorSpace, ElementId, FontWeight, IntoElement, SharedString, Window,
    linear_color_stop, linear_gradient, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    badge::plate_shadows,
    theme::{Appearance, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, radius, size},
    tooltip::tooltip,
};

type ChangeHandler = Rc<dyn Fn(Vec<SharedString>, &mut Window, &mut App)>;

/// One chip in a [`ToggleGroup`].
pub struct ToggleItem {
    value: SharedString,
    label: SharedString,
    /// React `ToggleGroupItem` children: preview content instead of the label.
    child: Option<AnyElement>,
    /// Hover words (L3 Kinds of cuts chips).
    tooltip: Option<SharedString>,
    disabled: bool,
}

impl ToggleItem {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        ToggleItem {
            value: value.into(),
            label: label.into(),
            child: None,
            tooltip: None,
            disabled: false,
        }
    }

    /// Custom chip body (a style swatch, title and description). The item's
    /// label remains the accessible name.
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.child = Some(child.into_any_element());
        self
    }

    /// A tooltip in the float glass's tooltip tier.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(IntoElement)]
pub struct ToggleGroup {
    id: ElementId,
    items: Vec<ToggleItem>,
    value: Vec<SharedString>,
    multiple: bool,
    /// The compact 24 px chips; the default is the 28 px control height.
    xs: bool,
    /// Outlined chips; the default is transparent.
    outline: bool,
    /// Caption style cards: pressed = `border-primary/50 bg-primary/10`.
    card: bool,
    /// Gap between chips in px. Default 8.
    spacing: f32,
    vertical: bool,
    disabled: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl ToggleGroup {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ToggleGroup {
            id: id.into(),
            items: Vec::new(),
            value: Vec::new(),
            multiple: false,
            xs: false,
            outline: false,
            card: false,
            spacing: 8.0,
            vertical: false,
            disabled: false,
            ground: None,
            accessibility_label: None,
            on_change: None,
            appearance: None,
        }
    }

    pub fn item(mut self, item: ToggleItem) -> Self {
        self.items.push(item);
        self
    }

    /// The pressed values, in item order.
    pub fn value(mut self, value: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.value = value.into_iter().map(Into::into).collect();
        self
    }

    /// Several chips can stay pressed.
    pub fn multiple(mut self, multiple: bool) -> Self {
        self.multiple = multiple;
        self
    }

    /// 24 px chips for dense filter rows.
    pub fn xs(mut self, xs: bool) -> Self {
        self.xs = xs;
        self
    }

    /// Outlined chips.
    pub fn outline(mut self, outline: bool) -> Self {
        self.outline = outline;
        self
    }

    /// Caption style cards: selected chip uses primary wash, not chrome plate.
    pub fn card(mut self, card: bool) -> Self {
        self.card = card;
        self
    }

    /// Gap between chips in px.
    pub fn spacing(mut self, spacing: f32) -> Self {
        self.spacing = spacing;
        self
    }

    pub fn vertical(mut self, vertical: bool) -> Self {
        self.vertical = vertical;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The colour the group sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Called with the next pressed values (item order) when a chip flips.
    pub fn on_change(
        mut self,
        handler: impl Fn(Vec<SharedString>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// The next pressed values after flipping `value` in `current`, keeping
/// `order` (the group's item values). Single-select replaces; multiple
/// adds or removes.
pub fn next_values(
    order: &[SharedString],
    current: &[SharedString],
    value: &SharedString,
    multiple: bool,
) -> Vec<SharedString> {
    if multiple {
        let mut next: Vec<SharedString> = current
            .iter()
            .filter(|v| order.iter().any(|o| o == *v))
            .cloned()
            .collect();
        if next.iter().any(|v| v == value) {
            next.retain(|v| v != value);
        } else {
            next.push(value.clone());
        }
        order
            .iter()
            .filter(|o| next.iter().any(|v| v == *o))
            .cloned()
            .collect()
    } else if current.iter().any(|v| v == value) {
        Vec::new()
    } else {
        vec![value.clone()]
    }
}

impl RenderOnce for ToggleGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let height = if self.xs { 24.0 } else { size::CONTROL };
        let text_size = if self.xs { 12.0 } else { 14.0 };
        let order: Vec<SharedString> = self.items.iter().map(|item| item.value.clone()).collect();
        let current = self.value.clone();
        let multiple = self.multiple;
        let group_disabled = self.disabled;
        let group_id = SharedString::from(format!("{}", self.id));

        let chips: SmallVec<[AnyElement; 4]> = self
            .items
            .into_iter()
            .map(|item| {
                let pressed = current.iter().any(|v| v == &item.value);
                let disabled = group_disabled || item.disabled;
                let on_change = self.on_change.clone();
                let order = order.clone();
                let current = current.clone();
                let value = item.value.clone();
                let chip_id = SharedString::from(format!("{group_id}/{}", item.value));
                let custom = item.child.is_some();
                let tip = item.tooltip.clone();
                let body = item
                    .child
                    .unwrap_or_else(|| item.label.clone().into_any_element());

                let mut chip = gpui_base::Toggle::new(chip_id)
                    .pressed(pressed)
                    .disabled(disabled)
                    .accessibility_label(item.label.clone())
                    .px(px(if custom {
                        8.0
                    } else if self.xs {
                        6.0
                    } else {
                        10.0
                    }))
                    .py(px(if custom { 8.0 } else { 0.0 }))
                    .flex()
                    .gap(px(4.0))
                    .rounded(px(if custom { radius::ROW } else { radius::CHIP }))
                    .text_size(px(text_size))
                    .font_weight(FontWeight::MEDIUM)
                    .border_1()
                    .border_color(gpui::transparent_black());
                chip = if custom {
                    chip.min_h(px(height))
                        .flex_col()
                        .items_stretch()
                        .justify_start()
                        .whitespace_normal()
                        .child(body)
                } else {
                    chip.h(px(height))
                        .items_center()
                        .justify_center()
                        .whitespace_nowrap()
                        .child(body)
                };

                if let Some(on_change) = on_change {
                    chip = chip.on_change(move |_, _, window, cx| {
                        let next = next_values(&order, &current, &value, multiple);
                        on_change(next, window, cx);
                    });
                }

                if disabled {
                    let ink = faded_over(t.muted_foreground, ground, 0.5);
                    chip = chip.text_color(hsla(ink));
                    if self.outline {
                        chip = chip
                            .border_color(hsla(faded_over(t.input, ground, 0.5)))
                            .bg(hsla(faded_over(t.glass_solid, ground, 0.5)));
                    }
                } else if pressed && self.card {
                    chip = chip
                        .text_color(hsla(t.foreground))
                        .border_color(hsla(with_alpha(t.primary, 0.5)))
                        .bg(hsla(with_alpha(t.primary, 0.1)));
                } else if pressed {
                    chip = chip
                        .text_color(hsla(t.foreground))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(hsla(t.chrome_plate_top), 0.0),
                            linear_color_stop(hsla(t.chrome_plate_bottom), 1.0),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(plate_shadows(t));
                } else {
                    chip = chip
                        .text_color(hsla(t.muted_foreground))
                        .hover(|style| style.text_color(hsla(t.foreground)).bg(hsla(t.muted)));
                    if self.outline {
                        chip = chip.border_color(hsla(t.input)).bg(hsla(t.glass_solid));
                    }
                }

                if let Some(words) = tip {
                    chip = chip.tooltip(tooltip(words));
                }

                chip.into_any_element()
            })
            .collect();

        let mut group = gpui_base::ToggleGroup::new(self.id)
            .axis(if self.vertical {
                Axis::Vertical
            } else {
                Axis::Horizontal
            })
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(self.spacing.max(0.0)))
            .children(chips);
        if self.vertical {
            group = group.flex_col().items_stretch();
        }
        if let Some(label) = self.accessibility_label {
            group = group.aria_label(label);
        }
        group
    }
}
