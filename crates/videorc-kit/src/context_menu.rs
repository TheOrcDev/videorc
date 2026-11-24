//! ContextMenu (`components/ui/context-menu.tsx`): a right-click on the
//! wrapped area opens the menu at the pointer, on the same panel, rows and
//! keys as DropdownMenu (`dropdown_menu.rs`). Escape or a press outside
//! closes it, and focus goes back where it was.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FocusHandle, IntoElement, MouseButton, Pixels, Point, SharedString,
    Window, anchored, deferred, div, prelude::*, px,
};

use crate::{
    dropdown_menu::{Menu, MenuHandler, Panel, PanelExits, menu_nav, menu_panel},
    motion::presence,
    theme::{Appearance, resolve},
};

type MenuBuilder = Rc<dyn Fn(&mut Window, &mut App) -> Menu>;
type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// Where the menu stands while open, and what had focus before it.
#[derive(Default)]
struct ContextMenuState {
    at: Option<Point<Pixels>>,
    previous: Option<FocusHandle>,
}

#[derive(IntoElement)]
pub struct ContextMenu {
    id: ElementId,
    area: AnyElement,
    menu: Option<MenuBuilder>,
    on_open_change: Option<OpenChange>,
    appearance: Option<Appearance>,
}

impl ContextMenu {
    /// `area` is what a right-click opens the menu on (a row); it keeps its
    /// own look and layout.
    pub fn new(id: impl Into<ElementId>, area: impl IntoElement) -> Self {
        ContextMenu {
            id: id.into(),
            area: area.into_any_element(),
            menu: None,
            on_open_change: None,
            appearance: None,
        }
    }

    /// The menu, built while it shows.
    pub fn menu(mut self, menu: impl Fn(&mut Window, &mut App) -> Menu + 'static) -> Self {
        self.menu = Some(Rc::new(menu));
        self
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

impl RenderOnce for ContextMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let key = SharedString::from(self.id.to_string());
        let state = window.use_keyed_state(SharedString::from(format!("{key}/at")), cx, |_, _| {
            ContextMenuState::default()
        });
        let nav = menu_nav(SharedString::from(format!("{key}/menu")), window, cx);
        let at = state.read(cx).at;
        let progress = presence(
            SharedString::from(format!("{key}/open")),
            at.is_some(),
            window,
            cx,
        )
        .progress;
        let on_open_change = self.on_open_change;

        let close: MenuHandler = {
            let state = state.clone();
            let on_open_change = on_open_change.clone();
            Rc::new(move |window, cx| {
                let previous = state.update(cx, |state, cx| {
                    cx.notify();
                    state.at.take().map(|_| state.previous.take())
                });
                let Some(previous) = previous else {
                    return;
                };
                match previous {
                    Some(previous) => previous.focus(window, cx),
                    None => window.blur(cx),
                }
                if let Some(on_open_change) = &on_open_change {
                    on_open_change(false, window, cx);
                }
            })
        };

        let popup = at.map(|at| {
            let menu = Rc::new(
                self.menu
                    .as_ref()
                    .map(|build| build(window, cx))
                    .unwrap_or_default(),
            );
            let exits = PanelExits {
                close_all: close.clone(),
                on_escape: Some(close.clone()),
                close_self: None,
            };
            let panel = Panel {
                key: key.clone(),
                theme: t,
                menu,
                nav: nav.clone(),
                exits,
                progress,
            };
            let outside = {
                let nav = nav.clone();
                let close = close.clone();
                move |_: &gpui::MouseDownEvent, window: &mut Window, cx: &mut App| {
                    // A submenu stands outside the panel. A press outside
                    // both closes the submenu during this event; one inside
                    // it leaves it open, and is no press outside the menu.
                    let nav = nav.clone();
                    let close = close.clone();
                    window.defer(cx, move |window, cx| {
                        if !nav.read(cx).has_submenu() {
                            close(window, cx);
                        }
                    });
                }
            };
            deferred(
                anchored()
                    .position(at)
                    .snap_to_window_with_margin(px(8.0))
                    .child(menu_panel(panel, window, cx).on_mouse_down_out(outside)),
            )
            .with_priority(gpui_base::POPUP_PRIORITY)
        });

        div()
            .id(self.id)
            .on_mouse_down(MouseButton::Right, {
                let state = state.clone();
                let nav = nav.clone();
                move |event, window, cx| {
                    cx.stop_propagation();
                    let focus = nav.update(cx, |nav, _| {
                        nav.reset();
                        nav.focus.clone()
                    });
                    let previous = window.focused(cx);
                    let was_open = state.update(cx, |state, cx| {
                        let was_open = state.at.is_some();
                        state.at = Some(event.position);
                        if !was_open {
                            state.previous = previous;
                        }
                        cx.notify();
                        was_open
                    });
                    window.defer(cx, move |window, cx| focus.focus(window, cx));
                    if !was_open && let Some(on_open_change) = &on_open_change {
                        on_open_change(true, window, cx);
                    }
                }
            })
            .child(self.area)
            .children(popup)
    }
}
