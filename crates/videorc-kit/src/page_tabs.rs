//! PageTabs (`components/page-tabs.tsx`): a page with tabs. One segmented
//! TabsList pinned in a strip under the toolbar (hairline below, gutter at
//! the sides), and only the region under it scrolls. The selected tab is
//! the caller's: the shell keeps it, remembers it on this device and opens
//! a named tab from a link. Built on [`crate::Tabs`].

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, IntoElement, SharedString, Window, div, prelude::*, px};
use smallvec::SmallVec;

use crate::{
    tabs::Tabs,
    theme::{Appearance, hsla, resolve},
    tokens::size,
};

type SelectHandler = Rc<dyn Fn(usize, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct PageTabs {
    id: ElementId,
    tabs: Vec<SharedString>,
    selected: usize,
    /// The strip's accessible name ("Settings sections").
    label: SharedString,
    on_select: Option<SelectHandler>,
    children: SmallVec<[AnyElement; 4]>,
    appearance: Option<Appearance>,
}

impl PageTabs {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        PageTabs {
            id: id.into(),
            tabs: Vec::new(),
            selected: 0,
            label: label.into(),
            on_select: None,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn tab(mut self, label: impl Into<SharedString>) -> Self {
        self.tabs.push(label.into());
        self
    }

    /// The index of the tab whose panel shows.
    pub fn selected(mut self, index: usize) -> Self {
        self.selected = index;
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

impl ParentElement for PageTabs {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PageTabs {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let appearance = self.appearance;
        let selected = self.selected.min(self.tabs.len().saturating_sub(1));
        let on_select = self.on_select.clone();

        let mut tabs = Tabs::new(SharedString::from(format!("{}/tabs", self.id)));
        for label in self.tabs {
            tabs = tabs.tab(label);
        }
        tabs = tabs.selected(selected);
        if let Some(on_select) = on_select {
            tabs = tabs.on_select(move |index, window, cx| on_select(index, window, cx));
        }
        if let Some(appearance) = appearance {
            tabs = tabs.appearance(appearance);
        }

        // PaneStrip: hairline below, gutter at the sides, never scrolls away.
        // The strip carries the list's accessible name (React's TabsList
        // aria-label); Tabs itself has no label slot yet.
        let strip = div()
            .id(SharedString::from(format!("{}/strip", self.id)))
            .flex_none()
            .w_full()
            .px(px(size::GUTTER))
            .py(px(8.0))
            .border_b_1()
            .border_color(hsla(t.border))
            .aria_label(self.label)
            .child(tabs);

        // Only the region under the strip scrolls; keyed by tab so a change
        // starts the new panel at the top.
        let body = div()
            .id(SharedString::from(format!("{}/scroll/{selected}", self.id)))
            .flex()
            .min_h(px(0.0))
            .flex_1()
            .w_full()
            .flex_col()
            .overflow_y_scroll()
            .children(self.children);

        div()
            .id(self.id)
            .flex()
            .min_h(px(0.0))
            .flex_1()
            .w_full()
            .flex_col()
            .gap(px(0.0))
            .child(strip)
            .child(body)
    }
}
