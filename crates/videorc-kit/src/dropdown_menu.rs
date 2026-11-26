//! DropdownMenu (`components/ui/dropdown-menu.tsx`): a trigger and its menu
//! on the popup tier of the float glass. gpui-base's Popover owns the
//! trigger (pointer, Enter and Space), Escape, the outside press and focus
//! coming back; the menu's own keys are here: Up and Down move the
//! highlight past labels, separators and disabled items, wrapping; Home and
//! End jump; Enter and Space choose; Right opens a submenu and Left closes
//! it. Choosing an item closes the menu; a checkbox or radio item stays
//! open, as Base UI's do.
//!
//! The menu is data ([`Menu`]), built while it shows, so the panel knows
//! which rows it can move to. The same panel draws [`ContextMenu`]
//! (`context_menu.rs`) at the pointer.
//!
//! [`ContextMenu`]: crate::context_menu::ContextMenu

use std::rc::Rc;

use gpui::{
    Action, Anchor, AnyElement, App, ElementId, Entity, FocusHandle, Hsla, IntoElement,
    KeyDownEvent, Role, SharedString, Stateful, Toggled, Window, div, prelude::*, px,
};

use crate::{
    icon::{IconName, icon},
    motion::{floating, presence},
    popover::popup_glass,
    shortcut_keys::{ShortcutKeys, ShortcutStyle},
    theme::{Appearance, hsla, is_dark, resolve, with_alpha},
    tokens::{Theme, radius},
    tooltip::tooltip,
};

pub type MenuHandler = Rc<dyn Fn(&mut Window, &mut App)>;
/// Draws an item's 16 px icon in the colour its row gives it.
pub type MenuIcon = Rc<dyn Fn(Hsla) -> AnyElement>;

/// An item's tone: destructive items read in the destructive colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MenuItemTone {
    #[default]
    Default,
    Destructive,
}

/// Which edge of the trigger the menu lines up with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MenuAlign {
    #[default]
    Start,
    End,
}

/// An item's keys, right-aligned in the secondary tier.
#[derive(Clone)]
pub enum MenuShortcut {
    /// The binding the keymap gives an action (screens).
    Action(Rc<dyn Action>),
    /// A fixed keystroke sequence in GPUI's syntax (the docs, the gallery).
    Keys(&'static str),
}

impl MenuShortcut {
    fn keys(&self) -> ShortcutKeys {
        match self {
            MenuShortcut::Action(action) => ShortcutKeys::for_action(action.as_ref()),
            MenuShortcut::Keys(keys) => ShortcutKeys::keystrokes(keys),
        }
        .style(ShortcutStyle::Text)
    }
}

/// One item: a word, optionally its icon and keys, and what choosing it
/// does.
#[derive(Clone)]
pub struct MenuItem {
    label: SharedString,
    icon: Option<MenuIcon>,
    /// Trailing mark on the right (Health's status dot), before a shortcut.
    end: Option<MenuIcon>,
    shortcut: Option<MenuShortcut>,
    tone: MenuItemTone,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    on_select: Option<MenuHandler>,
}

impl MenuItem {
    pub fn new(label: impl Into<SharedString>) -> Self {
        MenuItem {
            label: label.into(),
            icon: None,
            end: None,
            shortcut: None,
            tone: MenuItemTone::Default,
            disabled: false,
            disabled_reason: None,
            on_select: None,
        }
    }

    /// A 16 px icon before the word, drawn in the row's colour.
    pub fn icon<E: IntoElement>(mut self, icon: impl Fn(Hsla) -> E + 'static) -> Self {
        self.icon = Some(Rc::new(move |color| icon(color).into_any_element()));
        self
    }

    /// A trailing mark after the label (ml-auto), drawn in the row's colour.
    /// Health's status dot sits here; a shortcut, if any, follows it.
    pub fn end<E: IntoElement>(mut self, end: impl Fn(Hsla) -> E + 'static) -> Self {
        self.end = Some(Rc::new(move |color| end(color).into_any_element()));
        self
    }

    pub fn shortcut(mut self, shortcut: MenuShortcut) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    pub fn tone(mut self, tone: MenuItemTone) -> Self {
        self.tone = tone;
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

    /// Runs when the item is chosen, by click or by key. The menu closes.
    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }
}

#[derive(Clone)]
enum Entry {
    Item(MenuItem),
    /// A checkbox item, or a radio item: the check shows on the right.
    Check {
        label: SharedString,
        checked: bool,
        radio: bool,
        disabled: bool,
        on_select: MenuHandler,
    },
    Label(SharedString),
    /// A heading row with the menu's subject (Electron's account menu:
    /// `DropdownMenuLabel` as `flex justify-between`), not a quiet label.
    Header(MenuHeader),
    Separator,
    Submenu {
        label: SharedString,
        icon: Option<MenuIcon>,
        menu: Rc<Menu>,
    },
}

/// Builds an element for a header's slot each time the menu draws.
type MenuSlot = Rc<dyn Fn() -> AnyElement>;

/// A menu's heading row: the subject at 14 px medium in the foreground
/// (truncating), an optional mark before it (a 20 px avatar) and an element
/// at its right end (a tier badge). Electron's account menu header:
/// `DropdownMenuLabel className="flex items-center justify-between gap-2
/// py-1.5"`.
#[derive(Clone)]
pub struct MenuHeader {
    title: SharedString,
    leading: Option<MenuSlot>,
    end: Option<MenuSlot>,
}

impl MenuHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        MenuHeader {
            title: title.into(),
            leading: None,
            end: None,
        }
    }

    /// A mark before the title (`gap-2`), such as a 20 px avatar.
    pub fn leading<E: IntoElement>(mut self, leading: impl Fn() -> E + 'static) -> Self {
        self.leading = Some(Rc::new(move || leading().into_any_element()));
        self
    }

    /// An element at the row's right end, such as a `Badge`.
    pub fn end<E: IntoElement>(mut self, end: impl Fn() -> E + 'static) -> Self {
        self.end = Some(Rc::new(move || end().into_any_element()));
        self
    }
}

/// A menu's rows, in order.
#[derive(Clone, Default)]
pub struct Menu {
    entries: Vec<Entry>,
    /// A fixed panel width (Electron's `w-56`, 224 px); else at least 128 px.
    width: Option<f32>,
}

impl Menu {
    pub fn new() -> Self {
        Menu::default()
    }

    /// A heading row with the menu's subject and an element at its right
    /// end (the account menu's name and tier badge).
    pub fn header(mut self, header: MenuHeader) -> Self {
        self.entries.push(Entry::Header(header));
        self
    }

    /// A fixed panel width in px (Electron's `w-56` is 224).
    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    /// A quiet heading row ("Send to"); it labels the rows under it.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.entries.push(Entry::Label(label.into()));
        self
    }

    pub fn item(mut self, item: MenuItem) -> Self {
        self.entries.push(Entry::Item(item));
        self
    }

    /// A checkbox item: `on_change` gets the value it turns to.
    pub fn checkbox(
        mut self,
        label: impl Into<SharedString>,
        checked: bool,
        on_change: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.entries.push(Entry::Check {
            label: label.into(),
            checked,
            radio: false,
            disabled: false,
            on_select: Rc::new(move |window, cx| on_change(!checked, window, cx)),
        });
        self
    }

    /// A radio item: one of a group, `checked` when it is the group's value.
    pub fn radio(
        mut self,
        label: impl Into<SharedString>,
        checked: bool,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.entries.push(Entry::Check {
            label: label.into(),
            checked,
            radio: true,
            disabled: false,
            on_select: Rc::new(on_select),
        });
        self
    }

    /// Turns the last checkbox or radio item off.
    pub fn disabled(mut self, disabled: bool) -> Self {
        if let Some(Entry::Check { disabled: last, .. }) = self.entries.last_mut() {
            *last = disabled;
        }
        self
    }

    /// The hairline between groups.
    pub fn separator(mut self) -> Self {
        self.entries.push(Entry::Separator);
        self
    }

    /// A row that opens `menu` beside it.
    pub fn submenu(mut self, label: impl Into<SharedString>, menu: Menu) -> Self {
        self.entries.push(Entry::Submenu {
            label: label.into(),
            icon: None,
            menu: Rc::new(menu),
        });
        self
    }

    /// A submenu row with its 16 px icon.
    pub fn submenu_with_icon<E: IntoElement>(
        mut self,
        label: impl Into<SharedString>,
        icon: impl Fn(Hsla) -> E + 'static,
        menu: Menu,
    ) -> Self {
        self.entries.push(Entry::Submenu {
            label: label.into(),
            icon: Some(Rc::new(move |color| icon(color).into_any_element())),
            menu: Rc::new(menu),
        });
        self
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Whether the highlight can rest on row `index`.
    pub fn can_highlight(&self, index: usize) -> bool {
        match self.entries.get(index) {
            Some(Entry::Item(item)) => !item.disabled,
            Some(Entry::Check { disabled, .. }) => !disabled,
            Some(Entry::Submenu { .. }) => true,
            _ => false,
        }
    }

    fn is_submenu(&self, index: usize) -> bool {
        matches!(self.entries.get(index), Some(Entry::Submenu { .. }))
    }

    /// The row the highlight moves to from `from`, forward or back, past
    /// the rows it cannot rest on and wrapping at the ends. With nothing
    /// highlighted, forward starts at the first row and back at the last.
    pub fn step(&self, from: Option<usize>, forward: bool) -> Option<usize> {
        let rows: Vec<usize> = (0..self.len()).filter(|&i| self.can_highlight(i)).collect();
        let (first, last) = (*rows.first()?, *rows.last()?);
        let Some(at) = from.and_then(|from| rows.iter().position(|&row| row == from)) else {
            return Some(if forward { first } else { last });
        };
        let next = if forward {
            (at + 1) % rows.len()
        } else {
            (at + rows.len() - 1) % rows.len()
        };
        Some(rows[next])
    }

    /// The first row the highlight can rest on (Home).
    pub fn first(&self) -> Option<usize> {
        self.step(None, true)
    }

    /// The last row the highlight can rest on (End).
    pub fn last(&self) -> Option<usize> {
        self.step(None, false)
    }
}

/// What a menu keeps between frames: its focus, the highlighted row and
/// the open submenu.
pub(crate) struct MenuNav {
    pub(crate) focus: FocusHandle,
    highlighted: Option<usize>,
    submenu: Option<usize>,
}

impl MenuNav {
    pub(crate) fn reset(&mut self) {
        self.highlighted = None;
        self.submenu = None;
    }

    pub(crate) fn has_submenu(&self) -> bool {
        self.submenu.is_some()
    }
}

pub(crate) fn menu_nav(key: SharedString, window: &mut Window, cx: &mut App) -> Entity<MenuNav> {
    window.use_keyed_state(key, cx, |_, cx| MenuNav {
        focus: cx.focus_handle(),
        highlighted: None,
        submenu: None,
    })
}

/// How a panel closes: the whole menu (an item was chosen), on Escape (a
/// context menu; gpui-base's Popover owns Escape for the rest), and itself
/// on Left (a submenu).
#[derive(Clone)]
pub(crate) struct PanelExits {
    pub(crate) close_all: MenuHandler,
    pub(crate) on_escape: Option<MenuHandler>,
    pub(crate) close_self: Option<MenuHandler>,
}

fn activate(
    menu: &Menu,
    index: usize,
    nav: &Entity<MenuNav>,
    exits: &PanelExits,
    window: &mut Window,
    cx: &mut App,
) {
    match &menu.entries[index] {
        Entry::Item(item) if !item.disabled => {
            if let Some(on_select) = &item.on_select {
                on_select(window, cx);
            }
            (exits.close_all)(window, cx);
        }
        Entry::Check {
            disabled: false,
            on_select,
            ..
        } => on_select(window, cx),
        Entry::Submenu { .. } => nav.update(cx, |nav, cx| {
            nav.highlighted = Some(index);
            nav.submenu = Some(index);
            cx.notify();
        }),
        _ => {}
    }
}

/// A row's colours: its text, and its fill while highlighted.
fn row_colors(t: &Theme, highlighted: bool, tone: MenuItemTone) -> (Hsla, Hsla) {
    match tone {
        MenuItemTone::Destructive => {
            let fill = with_alpha(t.destructive, if is_dark(t) { 0.2 } else { 0.1 });
            (hsla(t.destructive), hsla(fill))
        }
        MenuItemTone::Default => {
            let text = if highlighted {
                t.accent_foreground
            } else {
                t.popover_foreground
            };
            (hsla(text), hsla(t.accent))
        }
    }
}

/// 28 px rows on the chip radius, concentric inside the menu's 4 px inset.
fn row(
    id: impl Into<ElementId>,
    text: Hsla,
    fill: Option<Hsla>,
    disabled: bool,
) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .relative()
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_h(px(28.0))
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(radius::CHIP))
        .whitespace_nowrap()
        .text_size(px(14.0))
        .line_height(px(20.0))
        .text_color(text)
        .when_some(fill, |row, fill| row.bg(fill))
        .when(disabled, |row| row.opacity(0.5))
}

/// One menu panel to draw: its key (the root of its rows' ids), its rows,
/// what it keeps between frames, how it closes, and how far it has faded in.
pub(crate) struct Panel {
    pub(crate) key: SharedString,
    pub(crate) theme: &'static Theme,
    pub(crate) menu: Rc<Menu>,
    pub(crate) nav: Entity<MenuNav>,
    pub(crate) exits: PanelExits,
    pub(crate) progress: f32,
}

/// The menu panel: its rows, its keys, and its submenus.
pub(crate) fn menu_panel(panel: Panel, window: &mut Window, cx: &mut App) -> Stateful<gpui::Div> {
    let Panel {
        key,
        theme: t,
        menu,
        nav,
        exits,
        progress,
    } = panel;
    let width = menu.width;
    let (focus, highlighted, open_submenu) = {
        let state = nav.read(cx);
        (state.focus.clone(), state.highlighted, state.submenu)
    };
    let hover = |index: usize, opens: bool| {
        let nav = nav.clone();
        move |hovered: &bool, _: &mut Window, cx: &mut App| {
            if *hovered {
                nav.update(cx, |nav, cx| {
                    nav.highlighted = Some(index);
                    nav.submenu = opens.then_some(index);
                    cx.notify();
                });
            }
        }
    };

    let mut rows: Vec<AnyElement> = Vec::with_capacity(menu.len());
    for (index, entry) in menu.entries.iter().enumerate() {
        let lit = highlighted == Some(index);
        let row_id = ElementId::from(SharedString::from(format!("{key}/row/{index}")));
        match entry {
            Entry::Label(label) => rows.push(
                div()
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(hsla(t.muted_foreground))
                    .child(label.clone())
                    .into_any_element(),
            ),
            Entry::Header(header) => rows.push(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .child(
                        div()
                            .flex()
                            .min_w(px(0.0))
                            .items_center()
                            .gap(px(8.0))
                            .children(header.leading.as_ref().map(|leading| leading()))
                            .child(
                                div()
                                    .min_w(px(0.0))
                                    .truncate()
                                    .text_size(px(14.0))
                                    .line_height(px(20.0))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hsla(t.foreground))
                                    .child(header.title.clone()),
                            ),
                    )
                    .children(
                        header
                            .end
                            .as_ref()
                            .map(|end| div().flex_none().child(end())),
                    )
                    .into_any_element(),
            ),
            Entry::Separator => rows.push(
                div()
                    .h(px(1.0))
                    .mx(px(-4.0))
                    .my(px(4.0))
                    .bg(hsla(t.border))
                    .into_any_element(),
            ),
            Entry::Item(item) => {
                let (text, fill) = row_colors(t, lit, item.tone);
                let disabled = item.disabled;
                let shortcut_color = if lit && item.tone == MenuItemTone::Default {
                    t.accent_foreground
                } else {
                    t.muted_foreground
                };
                let reason = item.disabled_reason.clone().filter(|_| disabled);
                rows.push(
                    row(row_id, text, (lit && !disabled).then_some(fill), disabled)
                        .role(Role::MenuItem)
                        // The item's words are its accessible name: GPUI
                        // names no node from its child text, so without this
                        // a screen reader heard an unnamed item.
                        .aria_label(item.label.clone())
                        .on_hover(hover(index, false))
                        .when(!disabled, |row| {
                            let menu = menu.clone();
                            let nav = nav.clone();
                            let exits = exits.clone();
                            row.on_click(move |_, window, cx| {
                                activate(&menu, index, &nav, &exits, window, cx)
                            })
                        })
                        .when_some(reason, |row, reason| row.tooltip(tooltip(reason)))
                        .children(item.icon.as_ref().map(|icon| icon(text)))
                        .child(item.label.clone())
                        .children(item.end.as_ref().map(|end| {
                            div()
                                .ml_auto()
                                .pl(px(16.0))
                                .flex()
                                .items_center()
                                .child(end(text))
                        }))
                        .children(item.shortcut.as_ref().map(|shortcut| {
                            div()
                                .when(item.end.is_none(), |slot| slot.ml_auto())
                                .pl(px(16.0))
                                .text_size(px(12.0))
                                .text_color(hsla(shortcut_color))
                                .child(shortcut.keys())
                        }))
                        .into_any_element(),
                );
            }
            Entry::Check {
                label,
                checked,
                radio,
                disabled,
                ..
            } => {
                let (text, fill) = row_colors(t, lit, MenuItemTone::Default);
                let disabled = *disabled;
                rows.push(
                    row(row_id, text, (lit && !disabled).then_some(fill), disabled)
                        .pr(px(32.0))
                        .role(if *radio {
                            Role::MenuItemRadio
                        } else {
                            Role::MenuItemCheckBox
                        })
                        .aria_label(label.clone())
                        .aria_toggled(if *checked {
                            Toggled::True
                        } else {
                            Toggled::False
                        })
                        .on_hover(hover(index, false))
                        .when(!disabled, |row| {
                            let menu = menu.clone();
                            let nav = nav.clone();
                            let exits = exits.clone();
                            row.on_click(move |_, window, cx| {
                                activate(&menu, index, &nav, &exits, window, cx)
                            })
                        })
                        .child(label.clone())
                        .when(*checked, |row| {
                            row.child(
                                div()
                                    .absolute()
                                    .right(px(8.0))
                                    .top_0()
                                    .bottom_0()
                                    .flex()
                                    .items_center()
                                    .child(icon(IconName::Check, 16.0, text)),
                            )
                        })
                        .into_any_element(),
                );
            }
            Entry::Submenu {
                label,
                icon: glyph,
                menu: submenu,
            } => {
                let open = open_submenu == Some(index);
                let (text, fill) = row_colors(t, lit || open, MenuItemTone::Default);
                let sub_key = SharedString::from(format!("{key}/sub/{index}"));
                let sub_nav = menu_nav(SharedString::from(format!("{sub_key}/menu")), window, cx);
                let sub_focus = sub_nav.read(cx).focus.clone();
                let close_self: MenuHandler = {
                    let nav = nav.clone();
                    Rc::new(move |_, cx| {
                        nav.update(cx, |nav, cx| {
                            nav.submenu = None;
                            cx.notify();
                        })
                    })
                };
                let sub_exits = PanelExits {
                    close_all: exits.close_all.clone(),
                    on_escape: None,
                    close_self: Some(close_self),
                };
                let submenu = submenu.clone();
                let trigger = gpui_base::Button::new(row_id)
                    .role(Role::MenuItem)
                    .aria_label(label.clone())
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(radius::CHIP))
                    .whitespace_nowrap()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(text)
                    .when(lit || open, |row| row.bg(fill))
                    .on_hover(hover(index, true))
                    .children(glyph.as_ref().map(|icon| icon(text)))
                    .child(label.clone())
                    .child(div().ml_auto().pl(px(16.0)).child(icon(
                        IconName::CaretRight,
                        16.0,
                        text,
                    )));
                rows.push(
                    gpui_base::Popover::new(ElementId::from(sub_key.clone()))
                        .anchor(Anchor::LeftCenter)
                        .offset(px(4.0))
                        .open(open)
                        .track_focus(&sub_focus)
                        .on_open_change({
                            let nav = nav.clone();
                            let sub_nav = sub_nav.clone();
                            move |now_open, _, cx| {
                                let now_open = *now_open;
                                sub_nav.update(cx, |sub, _| sub.reset());
                                nav.update(cx, |nav, cx| {
                                    if now_open {
                                        nav.submenu = Some(index);
                                    } else if nav.submenu == Some(index) {
                                        nav.submenu = None;
                                    }
                                    cx.notify();
                                });
                            }
                        })
                        .trigger(trigger)
                        .content(move |_, window, cx| {
                            let panel = Panel {
                                key: sub_key,
                                theme: t,
                                menu: submenu,
                                nav: sub_nav,
                                exits: sub_exits,
                                progress: 1.0,
                            };
                            menu_panel(panel, window, cx)
                        })
                        .w_full()
                        .into_any_element(),
                );
            }
        }
    }

    let max_height = window.viewport_size().height - px(16.0);
    let keys = {
        let menu = menu.clone();
        let nav = nav.clone();
        move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
            let current = nav.read(cx).highlighted;
            let next = match event.keystroke.key.as_str() {
                "down" => menu.step(current, true),
                "up" => menu.step(current, false),
                "home" => menu.first(),
                "end" => menu.last(),
                "enter" | "space" => {
                    if let Some(index) = current {
                        activate(&menu, index, &nav, &exits, window, cx);
                    }
                    cx.stop_propagation();
                    return;
                }
                "right" => {
                    if let Some(index) = current.filter(|&index| menu.is_submenu(index)) {
                        activate(&menu, index, &nav, &exits, window, cx);
                    }
                    cx.stop_propagation();
                    return;
                }
                "left" => {
                    if let Some(close_self) = &exits.close_self {
                        close_self(window, cx);
                        cx.stop_propagation();
                    }
                    return;
                }
                "escape" => {
                    if let Some(on_escape) = &exits.on_escape {
                        on_escape(window, cx);
                        cx.stop_propagation();
                    }
                    return;
                }
                _ => return,
            };
            nav.update(cx, |nav, cx| {
                nav.highlighted = next;
                cx.notify();
            });
            cx.stop_propagation();
        }
    };

    div()
        .id(ElementId::from(SharedString::from(format!("{key}/panel"))))
        .role(Role::Menu)
        .track_focus(&focus)
        .on_key_down(keys)
        .occlude()
        .child(
            floating(
                popup_glass(t),
                progress,
                div().flex().flex_col().children(rows),
            )
            .id("menu-scroll")
            .min_w(px(128.0))
            .when_some(width, |panel, width| panel.w(px(width)))
            .max_h(max_height)
            .overflow_y_scroll()
            .p(px(4.0))
            .text_color(hsla(t.popover_foreground)),
        )
}

type MenuBuilder = Rc<dyn Fn(&mut Window, &mut App) -> Menu>;
type TriggerSetter = Box<dyn FnOnce(gpui_base::Popover) -> gpui_base::Popover>;

#[derive(IntoElement)]
pub struct DropdownMenu {
    id: ElementId,
    trigger: Option<TriggerSetter>,
    menu: Option<MenuBuilder>,
    align: MenuAlign,
    appearance: Option<Appearance>,
}

impl DropdownMenu {
    pub fn new(id: impl Into<ElementId>) -> Self {
        DropdownMenu {
            id: id.into(),
            trigger: None,
            menu: None,
            align: MenuAlign::Start,
            appearance: None,
        }
    }

    /// The control that opens it: a kit `Button`, or anything gpui-base can
    /// mark open while the menu shows.
    pub fn trigger<T>(mut self, trigger: T) -> Self
    where
        T: gpui_base::Selectable + IntoElement + 'static,
    {
        self.trigger = Some(Box::new(move |popover| popover.trigger(trigger)));
        self
    }

    /// The menu, built while it shows.
    pub fn menu(mut self, menu: impl Fn(&mut Window, &mut App) -> Menu + 'static) -> Self {
        self.menu = Some(Rc::new(menu));
        self
    }

    /// Lines the menu up with the trigger's start (the default) or end edge.
    pub fn align(mut self, align: MenuAlign) -> Self {
        self.align = align;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for DropdownMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let key = SharedString::from(self.id.to_string());
        let nav = menu_nav(SharedString::from(format!("{key}/menu")), window, cx);
        let open_key = SharedString::from(format!("{key}/open"));
        let open = window.use_keyed_state(open_key.clone(), cx, |_, _| false);
        let progress = presence(open_key, *open.read(cx), window, cx).progress;
        let focus = nav.read(cx).focus.clone();
        let build = self.menu;
        let mut popover = gpui_base::Popover::new(self.id)
            .anchor(match self.align {
                MenuAlign::Start => Anchor::TopLeft,
                MenuAlign::End => Anchor::TopRight,
            })
            .offset(px(4.0))
            .track_focus(&focus)
            .on_open_change({
                let nav = nav.clone();
                move |now_open, _, cx| {
                    let now_open = *now_open;
                    open.update(cx, |open, cx| {
                        *open = now_open;
                        cx.notify();
                    });
                    nav.update(cx, |nav, cx| {
                        nav.reset();
                        cx.notify();
                    });
                }
            })
            .content(move |_, window, cx| {
                let state = cx.entity();
                let close_all: MenuHandler = Rc::new(move |window, cx| {
                    state.update(cx, |state, cx| state.dismiss(window, cx));
                });
                let menu = Rc::new(
                    build
                        .as_ref()
                        .map(|build| build(window, cx))
                        .unwrap_or_default(),
                );
                let exits = PanelExits {
                    close_all,
                    on_escape: None,
                    close_self: None,
                };
                let panel = Panel {
                    key,
                    theme: t,
                    menu,
                    nav,
                    exits,
                    progress,
                };
                menu_panel(panel, window, cx)
            });
        if let Some(trigger) = self.trigger {
            popover = trigger(popover);
        }
        popover
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menu() -> Menu {
        Menu::new()
            .label("Send to")
            .item(MenuItem::new("Clip"))
            .item(MenuItem::new("Copy").disabled(true))
            .separator()
            .checkbox("Banners", true, |_, _, _| {})
            .submenu(
                "Highlight position",
                Menu::new().item(MenuItem::new("Top left")),
            )
    }

    #[test]
    fn the_highlight_rests_only_on_rows_that_act() {
        let menu = menu();
        let rows: Vec<usize> = (0..menu.len()).filter(|&i| menu.can_highlight(i)).collect();
        assert_eq!(rows, vec![1, 4, 5]);
    }

    #[test]
    fn up_and_down_skip_and_wrap() {
        let menu = menu();
        assert_eq!(menu.step(None, true), Some(1));
        assert_eq!(menu.step(None, false), Some(5));
        assert_eq!(menu.step(Some(1), true), Some(4));
        assert_eq!(menu.step(Some(5), true), Some(1));
        assert_eq!(menu.step(Some(1), false), Some(5));
        assert_eq!((menu.first(), menu.last()), (Some(1), Some(5)));
    }

    #[test]
    fn a_menu_with_nothing_to_choose_has_no_highlight() {
        let menu = Menu::new().label("Nothing yet").separator();
        assert_eq!(menu.step(None, true), None);
        assert_eq!(Menu::new().first(), None);
    }
}
