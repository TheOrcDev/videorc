//! KebabMenu (`components/kebab-menu.tsx`): the ⋯ overflow menu for
//! low-frequency per-item actions, a ghost icon trigger and a dropdown. One
//! anatomy for every list and card (recordings, assets, scenes, scheduled
//! livestreams, chat rows). Items group by `group` with a hairline between
//! groups, destructive items last; `shortcut` shows an item's keys; `busy`
//! swaps the dots for a spinner while an item's work runs.

use std::{rc::Rc, time::Duration};

use gpui::{
    App, ElementId, Hsla, IntoElement, SharedString, TimedTransformation, Transformation, Window,
    div, prelude::*,
};

use crate::{
    button::{Button, ButtonSize, ButtonVariant},
    dropdown_menu::{
        DropdownMenu, Menu, MenuAlign, MenuHandler, MenuIcon, MenuItem, MenuItemTone, MenuShortcut,
    },
    icon::{IconName, icon},
    theme::{Appearance, hsla, motion, resolve},
};

/// One action in a row's ⋯ menu, and in its right-click twin.
#[derive(Clone)]
pub struct KebabMenuItem {
    id: SharedString,
    label: SharedString,
    icon: Option<MenuIcon>,
    destructive: bool,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    group: Option<SharedString>,
    shortcut: Option<MenuShortcut>,
    on_select: MenuHandler,
}

impl KebabMenuItem {
    /// `on_select` runs when the item is chosen, by click or by key. The
    /// menu closes.
    pub fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        KebabMenuItem {
            id: id.into(),
            label: label.into(),
            icon: None,
            destructive: false,
            disabled: false,
            disabled_reason: None,
            group: None,
            shortcut: None,
            on_select: Rc::new(on_select),
        }
    }

    pub fn id(&self) -> &SharedString {
        &self.id
    }

    pub fn icon<E: IntoElement>(mut self, icon: impl Fn(Hsla) -> E + 'static) -> Self {
        self.icon = Some(Rc::new(move |color| icon(color).into_any_element()));
        self
    }

    /// Destructive items render in the destructive tone, last, in a group
    /// of their own.
    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Why a disabled item is off, on hover: one sentence.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// Items with the same group sit together, a hairline between groups,
    /// in the order each group first appears. Ungrouped items form one
    /// group.
    pub fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.group = Some(group.into());
        self
    }

    /// The item's keys, right-aligned.
    pub fn shortcut(mut self, shortcut: MenuShortcut) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    fn menu_item(&self) -> MenuItem {
        let on_select = self.on_select.clone();
        let mut item = MenuItem::new(self.label.clone())
            .tone(if self.destructive {
                MenuItemTone::Destructive
            } else {
                MenuItemTone::Default
            })
            .disabled(self.disabled)
            .on_select(move |window, cx| on_select(window, cx));
        if let Some(glyph) = self.icon.clone() {
            item = item.icon(move |color| glyph(color));
        }
        if let Some(shortcut) = self.shortcut.clone() {
            item = item.shortcut(shortcut);
        }
        if let Some(reason) = self.disabled_reason.clone() {
            item = item.disabled_reason(reason);
        }
        item
    }
}

/// Groups the items for the menu: each `group` in first-appearance order,
/// then the destructive items on their own at the end.
pub fn kebab_menu_groups(items: &[KebabMenuItem]) -> Vec<Vec<KebabMenuItem>> {
    let mut groups: Vec<(Option<SharedString>, Vec<KebabMenuItem>)> = Vec::new();
    let mut destructive = Vec::new();
    for item in items {
        if item.destructive {
            destructive.push(item.clone());
            continue;
        }
        match groups.iter_mut().find(|(group, _)| *group == item.group) {
            Some((_, members)) => members.push(item.clone()),
            None => groups.push((item.group.clone(), vec![item.clone()])),
        }
    }
    let mut groups: Vec<Vec<KebabMenuItem>> = groups.into_iter().map(|(_, items)| items).collect();
    if !destructive.is_empty() {
        groups.push(destructive);
    }
    groups
}

/// The menu both the ⋯ and the right-click show: the groups with a
/// hairline between them.
pub fn kebab_menu(items: &[KebabMenuItem]) -> Menu {
    kebab_menu_groups(items)
        .iter()
        .enumerate()
        .fold(Menu::new(), |menu, (index, group)| {
            let menu = if index > 0 { menu.separator() } else { menu };
            group
                .iter()
                .fold(menu, |menu, item| menu.item(item.menu_item()))
        })
}

/// When the trigger shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KebabReveal {
    #[default]
    Always,
    /// Hidden until its host row (the element with `.group(KEBAB_HOST)`) is
    /// hovered; it stays while the menu is open or an item's work runs.
    Hover,
}

/// The group name a host row takes for `KebabReveal::Hover`.
pub const KEBAB_HOST: &str = "kebab-host";

#[derive(IntoElement)]
pub struct KebabMenu {
    id: ElementId,
    items: Vec<KebabMenuItem>,
    label: SharedString,
    busy: bool,
    disabled: bool,
    reveal: KebabReveal,
    appearance: Option<Appearance>,
}

impl KebabMenu {
    pub fn new(id: impl Into<ElementId>, items: Vec<KebabMenuItem>) -> Self {
        KebabMenu {
            id: id.into(),
            items,
            label: "More actions".into(),
            busy: false,
            disabled: false,
            reveal: KebabReveal::Always,
            appearance: None,
        }
    }

    /// The trigger's accessible name: "Actions for Launch demo".
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    /// An item's work is running: a spinner replaces the dots.
    pub fn busy(mut self, busy: bool) -> Self {
        self.busy = busy;
        self
    }

    /// The whole menu is unavailable (the app is reconnecting).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn reveal(mut self, reveal: KebabReveal) -> Self {
        self.reveal = reveal;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for KebabMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ink = hsla(t.foreground);
        let glyph = if self.busy {
            let spinner = icon(IconName::CircleNotch, 16.0, ink);
            if motion(cx) {
                spinner.with_timed_transformation(
                    TimedTransformation::rotation(
                        Duration::from_secs(1),
                        Transformation::default(),
                    )
                    .with_max_fps(60.0),
                )
            } else {
                spinner.with_transformation(Transformation::default())
            }
        } else {
            icon(IconName::DotsThreeBold, 16.0, ink)
        };
        let mut trigger = Button::new(SharedString::from(format!("{}/trigger", self.id)))
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Icon)
            .disabled(self.disabled)
            .accessibility_label(self.label)
            .child(glyph);
        if let Some(appearance) = self.appearance {
            trigger = trigger.appearance(appearance);
        }
        let menu = kebab_menu(&self.items);
        // The DropdownMenu's own open flag (`dropdown_menu.rs` keys it so):
        // a hover-revealed trigger stays while its menu is open.
        let open_key = SharedString::from(format!("{}/open", self.id));
        let open = *window.use_keyed_state(open_key, cx, |_, _| false).read(cx);
        let mut dropdown = DropdownMenu::new(self.id)
            .trigger(trigger)
            .align(MenuAlign::End)
            .menu(move |_, _| menu.clone());
        if let Some(appearance) = self.appearance {
            dropdown = dropdown.appearance(appearance);
        }
        let hidden_until_hover = self.reveal == KebabReveal::Hover && !self.busy && !open;
        div()
            .flex_none()
            .when(hidden_until_hover, |host| {
                host.opacity(0.0)
                    .group_hover(KEBAB_HOST, |style| style.opacity(1.0))
            })
            .child(dropdown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &'static str) -> KebabMenuItem {
        KebabMenuItem::new(id, id, |_, _| {})
    }

    fn ids(groups: &[Vec<KebabMenuItem>]) -> Vec<Vec<&str>> {
        groups
            .iter()
            .map(|group| group.iter().map(|item| &**item.id()).collect())
            .collect()
    }

    #[test]
    fn groups_keep_first_appearance_order_and_destructive_goes_last() {
        let items = vec![
            item("rename").group("edit"),
            item("delete").destructive(true),
            item("reveal").group("file"),
            item("duplicate").group("edit"),
            item("share"),
        ];
        assert_eq!(
            ids(&kebab_menu_groups(&items)),
            vec![
                vec!["rename", "duplicate"],
                vec!["reveal"],
                vec!["share"],
                vec!["delete"],
            ]
        );
    }

    #[test]
    fn a_menu_draws_a_hairline_between_groups() {
        let items = vec![
            item("a").group("x"),
            item("b").group("y"),
            item("c").destructive(true),
        ];
        let menu = kebab_menu(&items);
        assert_eq!(menu.len(), 5);
        let rows: Vec<usize> = (0..menu.len()).filter(|&i| menu.can_highlight(i)).collect();
        assert_eq!(rows, vec![0, 2, 4]);
    }
}
