//! ScrollArea (`components/ui/scroll-area.tsx`): a pane that scrolls with
//! gpui-base's scrollbar, drawn as the React flavour draws it: no track, a
//! 4 px thumb in a 10 px gutter (3 px inset), the scrollbar tokens, shown
//! on hover and while scrolling.

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, ScrollHandle, Window, div, prelude::*,
    px,
};
use gpui_base::{Scrollbar, ScrollbarMode};
use smallvec::SmallVec;

use crate::theme::{Appearance, hsla, resolve};

#[derive(IntoElement)]
pub struct ScrollArea {
    id: ElementId,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
    handle: Option<ScrollHandle>,
}

impl ScrollArea {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ScrollArea {
            id: id.into(),
            children: SmallVec::new(),
            appearance: None,
            handle: None,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }

    /// Scrolls with this handle (a page that brings a section into view)
    /// instead of one the pane keeps for itself.
    pub fn handle(mut self, handle: ScrollHandle) -> Self {
        self.handle = Some(handle);
        self
    }
}

impl ParentElement for ScrollArea {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ScrollArea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let handle = match self.handle {
            Some(handle) => handle,
            None => window
                .use_keyed_state(self.id.clone(), cx, |_, _| ScrollHandle::new())
                .read(cx)
                .clone(),
        };
        let (thumb, thumb_hover) = (t.scrollbar_thumb, t.scrollbar_thumb_hover);
        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id(self.id)
                    .size_full()
                    .track_scroll(&handle)
                    .overflow_y_scroll()
                    .children(self.children),
            )
            .child(
                div().absolute().top_0().left_0().size_full().child(
                    Scrollbar::vertical(&handle)
                        .id("scrollbar")
                        .mode(ScrollbarMode::Hover)
                        .viewport_from_layout()
                        .styles(|styles| {
                            styles
                                .track(|track| track.bg(gpui::transparent_black()).width(px(10.0)))
                                .thumb(|style| {
                                    style
                                        .bg(hsla(thumb))
                                        .width(px(4.0))
                                        .inset(px(3.0))
                                        .radius(px(2.0))
                                })
                                .thumb_hover(|style| style.bg(hsla(thumb_hover)))
                        }),
                ),
            )
    }
}
