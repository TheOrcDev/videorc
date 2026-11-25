//! Collapsible (`components/ui/collapsible.tsx`): a disclosure that keeps
//! its trigger visible and shows or hides a panel. The caller owns `open`
//! and updates it from [`Collapsible::on_toggle`], as React's
//! `Collapsible` root does with `open` / `onOpenChange`.
//!
//! The header is a real button, as Base UI's `Collapsible.Trigger` is: it
//! takes Tab focus (a focus-visible ring), toggles on click, Enter and Space,
//! and tells assistive tech whether the panel is expanded.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, IntoElement, SharedString, StyleRefinement, Window, div,
    prelude::*, px,
};

use crate::{
    chrome::focus_ring,
    icon::{IconName, icon},
    theme::{Appearance, hsla, resolve},
    tokens::radius,
};

type ToggleHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Collapsible {
    id: ElementId,
    open: bool,
    disabled: bool,
    trigger: AnyElement,
    accessibility_label: Option<SharedString>,
    content: Option<AnyElement>,
    on_toggle: Option<ToggleHandler>,
    /// Electron Base UI Collapsible is unstyled; the kit chrome is opt-in.
    unstyled: bool,
    appearance: Option<Appearance>,
    base: Div,
}

impl Collapsible {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Collapsible {
            id: id.into(),
            open: false,
            disabled: false,
            trigger: SharedString::from("").into_any_element(),
            accessibility_label: None,
            content: None,
            on_toggle: None,
            unstyled: false,
            appearance: None,
            base: div(),
        }
    }

    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The always-visible header (title row, chevron, etc.).
    pub fn trigger(mut self, trigger: impl IntoElement) -> Self {
        self.trigger = trigger.into_any_element();
        self
    }

    /// The header button's name for assistive tech, when the trigger is not
    /// plain text (a status dot and a title, Health's groups).
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// The panel under the trigger while open.
    pub fn content(mut self, content: impl IntoElement) -> Self {
        self.content = Some(content.into_any_element());
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }

    /// No kit chrome: no caret, hover fill, chip radius, or content indent.
    pub fn unstyled(mut self, unstyled: bool) -> Self {
        self.unstyled = unstyled;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Styled for Collapsible {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for Collapsible {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let open = self.open;
        let disabled = self.disabled;
        let on_toggle = self.on_toggle;
        let unstyled = self.unstyled;

        let ring = focus_ring(t);
        // `Collapsible.Trigger` is a button: Tab focus, Enter and Space, and
        // `aria-expanded`. gpui-base's Button centres its content; the header
        // reads from the leading edge.
        let mut header = gpui_base::Button::new(self.id)
            .disabled(disabled)
            .aria_expanded(open)
            .when_some(self.accessibility_label, |header, label| {
                header.accessibility_label(label)
            })
            .flex()
            .w_full()
            .items_center()
            .justify_start()
            // gpui-base sets a 1.0 line box; keep text-sm's 20 px so a plain
            // trigger label keeps its descenders.
            .line_height(px(20.0))
            .focus_visible(move |style| style.shadow(vec![ring]));
        if unstyled {
            header = header.child(div().flex_1().min_w(px(0.0)).child(self.trigger));
        } else {
            let chevron = icon(
                if open {
                    IconName::CaretDown
                } else {
                    IconName::CaretRight
                },
                14.0,
                hsla(t.muted_foreground),
            );
            header = header
                .gap(px(8.0))
                .rounded(px(radius::CHIP))
                .px(px(4.0))
                .py(px(6.0))
                .child(chevron)
                .child(div().flex_1().min_w(px(0.0)).child(self.trigger));
        }

        if disabled {
            header = header.opacity(0.5);
        } else {
            header = header.cursor_pointer().on_click(move |_, window, cx| {
                if let Some(on_toggle) = &on_toggle {
                    on_toggle(!open, window, cx);
                }
            });
            if !unstyled {
                header = header.hover(|style| style.bg(hsla(t.muted)));
            }
        }

        let mut root = self.base.flex().flex_col().w_full().child(header);
        if open {
            if let Some(content) = self.content {
                let panel = if unstyled {
                    div().w_full().child(content)
                } else {
                    div().w_full().pt(px(4.0)).pl(px(22.0)).child(content)
                };
                root = root.child(panel);
            }
        }
        root
    }
}
