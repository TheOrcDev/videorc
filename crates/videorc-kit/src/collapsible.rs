//! Collapsible (`components/ui/collapsible.tsx`): a disclosure that keeps
//! its trigger visible and shows or hides a panel. The caller owns `open`
//! and updates it from [`Collapsible::on_toggle`], as React's
//! `Collapsible` root does with `open` / `onOpenChange`.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, InteractiveElement, IntoElement, SharedString,
    StyleRefinement, Window, div, prelude::*, px,
};

use crate::{
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
    content: Option<AnyElement>,
    on_toggle: Option<ToggleHandler>,
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
            content: None,
            on_toggle: None,
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

    /// The panel under the trigger while open.
    pub fn content(mut self, content: impl IntoElement) -> Self {
        self.content = Some(content.into_any_element());
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
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
        let chevron = icon(
            if open {
                IconName::CaretDown
            } else {
                IconName::CaretRight
            },
            14.0,
            hsla(t.muted_foreground),
        );

        let mut header = div()
            .id(self.id)
            .flex()
            .w_full()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::CHIP))
            .px(px(4.0))
            .py(px(6.0))
            .child(chevron)
            .child(div().flex_1().min_w(px(0.0)).child(self.trigger));

        if disabled {
            header = header.opacity(0.5);
        } else {
            header = header
                .cursor_pointer()
                .hover(|style| style.bg(hsla(t.muted)))
                .on_click(move |_, window, cx| {
                    if let Some(on_toggle) = &on_toggle {
                        on_toggle(!open, window, cx);
                    }
                });
        }

        let mut root = self.base.flex().flex_col().w_full().child(header);
        if open {
            if let Some(content) = self.content {
                root = root.child(div().w_full().pt(px(4.0)).pl(px(22.0)).child(content));
            }
        }
        root
    }
}
