//! ScrollArea (`components/ui/scroll-area.tsx`): a pane that scrolls with
//! gpui-base's scrollbar, drawn as the React flavour draws it: no track, a
//! 4 px thumb in a 10 px gutter (3 px inset), the scrollbar tokens, shown
//! on hover and while scrolling.
//!
//! On a Mac set to classic scroll bars (a mouse plugged in, or "Show scroll
//! bars: Always"), Chromium draws the page's native thin bar in an 11 px
//! gutter, always visible, and the content stops short of it. The app tells
//! the kit which style the system uses ([`set_scrollbar_style`]); in
//! [`ScrollbarStyle::Classic`] a ScrollArea reserves that gutter while its
//! content overflows (always, with [`ScrollArea::stable_gutter`]) and keeps
//! its thumb in view.

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, ScrollHandle, Window, div, prelude::*,
    px,
};
use gpui_base::{ElementExt as _, Scrollbar, ScrollbarMode};
use smallvec::SmallVec;

use crate::theme::{Appearance, hsla, resolve};

/// The system's scroll bars: macOS's `NSScroller.preferredScrollerStyle`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScrollbarStyle {
    /// Thin bars over the content, shown while scrolling (a trackpad).
    #[default]
    Overlay,
    /// Bars in a gutter of their own, always shown (a mouse, or "Always").
    Classic,
}

impl gpui::Global for ScrollbarStyle {}

/// The width a classic bar takes beside the content (Chromium's thin bar).
pub const CLASSIC_GUTTER: f32 = 11.0;

/// Tells every ScrollArea which scroll bars the system draws. Call it at
/// startup and when the system's choice changes; Overlay until then.
pub fn set_scrollbar_style(style: ScrollbarStyle, cx: &mut App) {
    cx.set_global(style);
}

#[derive(IntoElement)]
pub struct ScrollArea {
    id: ElementId,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
    handle: Option<ScrollHandle>,
    /// The content is at least the viewport's height (a flex column).
    fill: bool,
    /// `scrollbar-gutter: stable`: the classic gutter even without overflow.
    stable_gutter: bool,
}

impl ScrollArea {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ScrollArea {
            id: id.into(),
            children: SmallVec::new(),
            appearance: None,
            handle: None,
            fill: false,
            stable_gutter: false,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }

    /// The content is at least as tall as the viewport, as a flex column, so
    /// a page's `flex-1` part stretches to the bottom (Electron's
    /// `CONFIG_GRID_PAIR`: the rule between Settings' two columns runs to the
    /// page's foot even when the content is short).
    pub fn fill(mut self, fill: bool) -> Self {
        self.fill = fill;
        self
    }

    /// `scrollbar-gutter: stable` (`data-pane-gutter="stable"`): with classic
    /// bars the gutter stays even when nothing overflows, so the page does
    /// not shift when it starts to.
    pub fn stable_gutter(mut self, stable: bool) -> Self {
        self.stable_gutter = stable;
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
        let classic = cx.try_global::<ScrollbarStyle>() == Some(&ScrollbarStyle::Classic);
        // Whether the content overflowed in the last frame: the classic
        // gutter is there only then (or always, when stable).
        let overflow = window.use_keyed_state(
            gpui::SharedString::from(format!("{}/overflow", self.id)),
            cx,
            |_, _| false,
        );
        let gutter = classic && (self.stable_gutter || *overflow.read(cx));
        let watch = handle.clone();
        div()
            .relative()
            .size_full()
            .when(classic, |area| {
                area.on_prepaint(move |_, window, cx| {
                    let now = watch.max_offset().y > px(0.5);
                    if *overflow.read(cx) != now {
                        overflow.update(cx, |o, _| *o = now);
                        // A redraw asked for in prepaint is dropped; ask
                        // from the next frame.
                        window.on_next_frame(|window, _| window.refresh());
                    }
                })
            })
            .child(
                div()
                    .id(self.id)
                    .size_full()
                    .track_scroll(&handle)
                    .overflow_y_scroll()
                    .when(gutter, |scroll| scroll.pr(px(CLASSIC_GUTTER)))
                    .map(|scroll| {
                        if self.fill {
                            scroll.child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .w_full()
                                    .min_h(gpui::relative(1.0))
                                    .children(self.children),
                            )
                        } else {
                            scroll.children(self.children)
                        }
                    }),
            )
            .child(
                div().absolute().top_0().left_0().size_full().child(
                    Scrollbar::vertical(&handle)
                        .id("scrollbar")
                        .mode(if classic {
                            ScrollbarMode::Always
                        } else {
                            ScrollbarMode::Hover
                        })
                        .viewport_from_layout()
                        .styles(move |styles| {
                            // Classic: Chromium's thin bar, a 7 px thumb in
                            // the 11 px gutter on a clear track
                            // (`scrollbar-color: thumb transparent`).
                            let (track_w, thumb_w, inset) = if classic {
                                (CLASSIC_GUTTER, 7.0, 2.0)
                            } else {
                                (10.0, 4.0, 3.0)
                            };
                            styles
                                .track(|track| {
                                    track.bg(gpui::transparent_black()).width(px(track_w))
                                })
                                .thumb(|style| {
                                    style
                                        .bg(hsla(thumb))
                                        .width(px(thumb_w))
                                        .inset(px(inset))
                                        .radius(px(thumb_w / 2.0))
                                })
                                .thumb_hover(|style| style.bg(hsla(thumb_hover)))
                        }),
                ),
            )
    }
}
