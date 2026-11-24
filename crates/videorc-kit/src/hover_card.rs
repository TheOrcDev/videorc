//! HoverCard (`components/ui/hover-card.tsx`): gpui-base's HoverCard for
//! the behaviour (it opens 600 ms after the pointer rests on the trigger and
//! closes 300 ms after the pointer leaves both, Base UI's delays; a tap
//! opens it on touch), the popup tier of the float glass: 288 px wide, the
//! popup radius, p-3, 14 px words, 4 px from the trigger. It fades and grows
//! in over 100 ms (`motion.rs`).

use gpui::{
    Anchor, AnyElement, App, ElementId, IntoElement, SharedString, Window, div, prelude::*, px,
};

use crate::{
    motion::{floating, presence},
    popover::popup_glass,
    theme::{Appearance, hsla, resolve},
};

type Content = Box<dyn FnOnce(&mut Window, &mut App) -> AnyElement>;

#[derive(IntoElement)]
pub struct HoverCard {
    id: ElementId,
    trigger: Option<AnyElement>,
    content: Option<Content>,
    anchor: Anchor,
    width: f32,
    padding: f32,
    appearance: Option<Appearance>,
}

impl HoverCard {
    pub fn new(id: impl Into<ElementId>) -> Self {
        HoverCard {
            id: id.into(),
            trigger: None,
            content: None,
            anchor: Anchor::TopCenter,
            width: 288.0,
            padding: 12.0,
            appearance: None,
        }
    }

    /// What the pointer rests on.
    pub fn trigger(mut self, trigger: impl IntoElement) -> Self {
        self.trigger = Some(trigger.into_any_element());
        self
    }

    /// What it holds, built while it shows.
    pub fn content<E: IntoElement>(
        mut self,
        content: impl FnOnce(&mut Window, &mut App) -> E + 'static,
    ) -> Self {
        self.content = Some(Box::new(move |window, cx| {
            content(window, cx).into_any_element()
        }));
        self
    }

    /// Which point of the card meets the trigger; its top centre by default
    /// (below the trigger, centred).
    pub fn anchor(mut self, anchor: Anchor) -> Self {
        self.anchor = anchor;
        self
    }

    /// 288 px by default (`w-72`).
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// 12 px by default (`p-3`); a compact card of short lines takes 8.
    pub fn padding(mut self, padding: f32) -> Self {
        self.padding = padding;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for HoverCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let key = SharedString::from(format!("{}/motion", self.id));
        let open = window.use_keyed_state(key.clone(), cx, |_, _| false);
        let shown = presence(key, *open.read(cx), window, cx);
        let progress = shown.progress;
        let (width, padding, content) = (self.width, self.padding, self.content);
        let mut card = gpui_base::HoverCard::new(self.id)
            .anchor(self.anchor)
            .on_open_change(move |now_open, _, cx| {
                let now_open = *now_open;
                open.update(cx, |open, cx| {
                    *open = now_open;
                    cx.notify();
                });
            })
            .content(move |_, window, cx| {
                floating(
                    popup_glass(t),
                    progress,
                    div()
                        .flex()
                        .flex_col()
                        .children(content.map(|content| content(window, cx))),
                )
                .id("hover-card-surface")
                .mt(px(4.0))
                .w(px(width))
                .p(px(padding))
                .text_size(px(14.0))
                .text_color(hsla(t.popover_foreground))
                .occlude()
            });
        if let Some(trigger) = self.trigger {
            card = card.trigger(trigger);
        }
        card
    }
}
