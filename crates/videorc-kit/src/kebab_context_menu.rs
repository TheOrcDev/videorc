//! KebabContextMenu (`components/kebab-context-menu.tsx`): the right-click
//! twin of a row's ⋯ menu, built from the same `KebabMenuItem` list, so the
//! two menus can never disagree. Groups, keys, disabled reasons and the
//! destructive item last, exactly as in `KebabMenu`.

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, IntoElement, Window, prelude::*};

use crate::{
    context_menu::ContextMenu,
    kebab_menu::{KebabMenuItem, kebab_menu},
    theme::Appearance,
};

type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct KebabContextMenu {
    id: ElementId,
    items: Vec<KebabMenuItem>,
    row: AnyElement,
    on_open_change: Option<OpenChange>,
    appearance: Option<Appearance>,
}

impl KebabContextMenu {
    /// `items` is the same list the row's ⋯ menu takes; `row` is the row
    /// itself, which keeps its own look.
    pub fn new(id: impl Into<ElementId>, items: Vec<KebabMenuItem>, row: impl IntoElement) -> Self {
        KebabContextMenu {
            id: id.into(),
            items,
            row: row.into_any_element(),
            on_open_change: None,
            appearance: None,
        }
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for KebabContextMenu {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let menu = kebab_menu(&self.items);
        let mut context = ContextMenu::new(self.id, self.row).menu(move |_, _| menu.clone());
        if let Some(on_open_change) = self.on_open_change {
            context =
                context.on_open_change(move |open, window, cx| on_open_change(open, window, cx));
        }
        if let Some(appearance) = self.appearance {
            context = context.appearance(appearance);
        }
        context
    }
}
