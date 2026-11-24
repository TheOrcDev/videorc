//! Popover (`components/ui/popover.tsx`): gpui-base's Popover for the
//! behaviour (the trigger toggles it, Enter and Space too; Escape and an
//! outside press dismiss it and focus returns; the AccessKit dialog role),
//! the popup tier of the float glass: 288 px wide, the popup radius, p-3.
//! It fades and grows in and fades out in 100 ms (`motion.rs`).

use std::{cell::Cell, rc::Rc};

use gpui::{
    Anchor, AnyElement, App, Bounds, ElementId, IntoElement, Pixels, SharedString, Window,
    anchored, deferred, div, prelude::*, px,
};

use crate::{
    button::Button,
    chrome,
    motion::{Glass, floating, presence},
    theme::{Appearance, hsla, resolve},
    tokens::{Theme, radius},
};

type Content = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

#[derive(IntoElement)]
pub struct Popover {
    id: ElementId,
    trigger: Option<Button>,
    custom_trigger: Option<Box<dyn FnOnce(bool, &Window, &App) -> AnyElement>>,
    controlled_open: Option<bool>,
    on_open_change: Option<Rc<dyn Fn(bool, &mut Window, &mut App)>>,
    content: Option<Content>,
    anchor: Anchor,
    width: f32,
    flush: bool,
    appearance: Option<Appearance>,
}

impl Popover {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Popover {
            id: id.into(),
            trigger: None,
            custom_trigger: None,
            controlled_open: None,
            on_open_change: None,
            content: None,
            anchor: Anchor::TopLeft,
            width: 288.0,
            flush: false,
            appearance: None,
        }
    }

    /// The button that opens it; it shows as expanded while open.
    pub fn trigger(mut self, trigger: Button) -> Self {
        self.trigger = Some(trigger);
        self
    }

    /// Controlled opening for a shell shortcut or a door in Search.
    pub fn open(mut self, open: bool) -> Self {
        self.controlled_open = Some(open);
        self
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }

    /// A status-bar control, retaining the Base popover's trigger behaviour.
    pub fn trigger_with<E: IntoElement>(
        mut self,
        trigger: impl FnOnce(bool, &Window, &App) -> E + 'static,
    ) -> Self {
        self.custom_trigger = Some(Box::new(move |open, window, cx| {
            trigger(open, window, cx).into_any_element()
        }));
        self
    }

    /// What it holds, built while it shows (and once more as it fades out).
    pub fn content<E: IntoElement>(
        mut self,
        content: impl Fn(&mut Window, &mut App) -> E + 'static,
    ) -> Self {
        self.content = Some(Rc::new(move |window, cx| {
            content(window, cx).into_any_element()
        }));
        self
    }

    /// Which corner of the popup meets the trigger; top-left by default.
    pub fn anchor(mut self, anchor: Anchor) -> Self {
        self.anchor = anchor;
        self
    }

    /// Flush lists supply their own header, row and footer insets.
    pub fn flush(mut self) -> Self {
        self.flush = true;
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// `glass-float`: the popup tier, flat and opaque, its rim and drop.
pub fn popup_glass(t: &Theme) -> Glass {
    Glass {
        fill: t.glass_float,
        rim: t.glass_float_rim,
        drop: t.glass_float_drop,
        radius: radius::LG,
    }
}

/// The popup tier at rest, for a surface that does not animate (a toast,
/// whose stack moves it).
pub fn popup_surface(t: &Theme) -> gpui::Div {
    div()
        .border_1()
        .border_color(hsla(t.glass_float_rim))
        .bg(hsla(t.glass_float))
        .shadow(chrome::shadows(t.glass_float_drop))
        .rounded(px(radius::LG))
        .text_color(hsla(t.popover_foreground))
}

/// What a popover keeps between frames: whether it is open, and where its
/// popup last stood, for the fade out after gpui-base has closed it.
struct PopoverMotion {
    open: bool,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl RenderOnce for Popover {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let width = self.width;
        let flush = self.flush;
        let key = SharedString::from(format!("{}/motion", self.id));
        let motion = window.use_keyed_state(key.clone(), cx, |_, _| PopoverMotion {
            open: false,
            bounds: Rc::new(Cell::new(None)),
        });
        let (open, last) = {
            let state = motion.read(cx);
            (
                self.controlled_open.unwrap_or(state.open),
                state.bounds.clone(),
            )
        };
        let shown = presence(key, open, window, cx);
        let progress = shown.progress;

        let surface = move |progress: f32, content: Option<AnyElement>| {
            floating(
                popup_glass(t),
                progress,
                div().flex().flex_col().gap(px(12.0)).children(content),
            )
            .w(px(width))
            .p(px(if flush { 0.0 } else { 12.0 }))
            .text_size(px(14.0))
            .text_color(hsla(t.popover_foreground))
        };

        let content = self.content;
        let in_popup = content.clone();
        let record = last.clone();
        let callback = self.on_open_change;
        let mut popover = gpui_base::Popover::new(self.id)
            .anchor(self.anchor)
            .offset(px(6.0))
            .on_position(move |position, _| record.set(Some(position.bounds)))
            .on_open_change({
                let motion = motion.clone();
                move |now_open, window, cx| {
                    let now_open = *now_open;
                    if let Some(callback) = &callback {
                        callback(now_open, window, cx);
                    }
                    motion.update(cx, |state, cx| {
                        state.open = now_open;
                        cx.notify();
                    });
                }
            })
            .content(move |_, window, cx| {
                surface(
                    progress,
                    in_popup.as_ref().map(|content| content(window, cx)),
                )
                .id("popover-surface")
                .occlude()
            });
        if let Some(open) = self.controlled_open {
            popover = popover.open(open);
        }
        if let Some(trigger) = self.custom_trigger {
            popover = popover.trigger_with(trigger);
        }
        if let Some(trigger) = self.trigger {
            popover = popover.trigger(trigger);
        }

        // gpui-base drops the popup the frame it closes: a still copy where it
        // stood fades out over it, taking no input.
        let leaving = (!open && shown.should_render())
            .then(|| last.get())
            .flatten()
            .map(|bounds| {
                deferred(anchored().position(bounds.origin).child(surface(
                    progress,
                    content.as_ref().map(|content| content(window, cx)),
                )))
                .with_priority(gpui_base::POPUP_PRIORITY)
            });
        div().child(popover).children(leaving)
    }
}
