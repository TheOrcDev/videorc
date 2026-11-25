//! Tabs (`components/ui/tabs.tsx`, `tabs-variants.ts`): gpui-base's Tabs
//! for the behaviour (roving focus: arrows move, Home and End jump, Enter
//! and Space choose; the AccessKit tab roles), the glass segmented look.
//! Tabs switch a view; the panels are the screen's. The default variant is
//! a recessed track whose selected segment is a chrome plate; `Line` is a
//! strip of words with the selected one underlined.

use std::rc::Rc;

use gpui::{
    App, ColorSpace, ElementId, FontWeight, IntoElement, SharedString, Window, div,
    linear_color_stop, linear_gradient, prelude::*, px,
};

use crate::{
    badge::plate_shadows,
    chrome::box_shadow,
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{Shadow, radius, size},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TabsVariant {
    /// A recessed glass track; the selected segment is a chrome plate.
    #[default]
    Default,
    /// Words over a pane; the selected one is underlined.
    Line,
}

type SelectHandler = Rc<dyn Fn(usize, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Tabs {
    id: ElementId,
    tabs: Vec<(SharedString, bool)>,
    selected: usize,
    variant: TabsVariant,
    on_select: Option<SelectHandler>,
    appearance: Option<Appearance>,
}

impl Tabs {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Tabs {
            id: id.into(),
            tabs: Vec::new(),
            selected: 0,
            variant: TabsVariant::Default,
            on_select: None,
            appearance: None,
        }
    }

    pub fn tab(mut self, label: impl Into<SharedString>) -> Self {
        self.tabs.push((label.into(), false));
        self
    }

    pub fn disabled_tab(mut self, label: impl Into<SharedString>) -> Self {
        self.tabs.push((label.into(), true));
        self
    }

    /// The index of the tab whose view shows.
    pub fn selected(mut self, index: usize) -> Self {
        self.selected = index;
        self
    }

    pub fn variant(mut self, variant: TabsVariant) -> Self {
        self.variant = variant;
        self
    }

    /// Called with the chosen tab's index.
    pub fn on_select(mut self, handler: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Tabs {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let count = self.tabs.len();
        let line = self.variant == TabsVariant::Line;
        let tabs = self
            .tabs
            .into_iter()
            .enumerate()
            .map(|(index, (label, disabled))| {
                let selected = index == self.selected;
                let on_select = self.on_select.clone();
                let tab = gpui_base::Tab::new(index)
                    .selected(selected)
                    .disabled(disabled)
                    .set_position(index + 1, count)
                    .relative()
                    .h_full()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .px(px(12.0))
                    .rounded(px(radius::CHIP))
                    .border_1()
                    .border_color(gpui::transparent_black())
                    .whitespace_nowrap()
                    .text_size(px(13.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(if disabled {
                        with_alpha(t.muted_foreground, 0.5)
                    } else if selected {
                        t.foreground
                    } else {
                        t.muted_foreground
                    }))
                    .when(!disabled && !selected, |tab| {
                        tab.hover(|style| style.text_color(hsla(t.foreground)))
                    })
                    .when_some(on_select, |tab, on_select| {
                        tab.on_click(move |_, window, cx| on_select(index, window, cx))
                    })
                    .child(label);
                match (selected, line) {
                    (true, false) => tab
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(hsla(t.chrome_plate_top), 0.0),
                            linear_color_stop(hsla(t.chrome_plate_bottom), 1.0),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(plate_shadows(t)),
                    (true, true) => tab.child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom(px(-2.0))
                            .h(px(2.0))
                            .bg(hsla(t.foreground)),
                    ),
                    _ => tab,
                }
            });
        // Electron TabsList: `inline-flex w-fit` — hug the triggers; flex_1 on
        // each tab only shares space inside this track, not the page width.
        let list = gpui_base::Tabs::new(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .h(px(size::CONTROL))
            .p(px(2.0))
            .rounded(px(radius::ROW))
            .children(tabs);
        if line {
            list.gap(px(4.0))
        } else {
            // bg-foreground/5 with an inset 1 px ring of the hairline.
            list.bg(hsla(with_alpha(t.foreground, 0.05)))
                .shadow(vec![box_shadow(&Shadow {
                    inset: true,
                    x: 0.0,
                    y: 0.0,
                    blur: 0.0,
                    spread: 1.0,
                    color: t.border,
                })])
        }
    }
}
