//! WindowFrame and WindowHeader (`components/window-frame.tsx`): the frame
//! the single-pane windows share (Stream Manager, Notes, Captions).
//!
//! - [`WindowFrame`] fills the window: the window's solid, the content coat
//!   over it, and the window's column of rows.
//! - [`WindowHeader`] is the 40 px toolbar band on the traffic lights' line,
//!   and the window's drag area. On macOS the title starts 88 px in (the
//!   14 px lights end 74 px in, so the title gets 14 px of air); elsewhere
//!   12 px, where the native frame owns the title bar. The title is the main
//!   window's recipe (14 px at 600 in the foreground); `meta` is a quiet
//!   inline fact after it (the Captions reader's state); the children are
//!   the window's few controls, trailing. Stream Manager keeps its row to
//!   the title.
//!
//! Open the window with [`crate::window::options`], which puts the traffic
//! lights on this band.

use gpui::{
    AnyElement, App, FontWeight, IntoElement, ParentElement, SharedString, Window,
    WindowControlArea, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, FONT, hsla, resolve},
    tokens::size,
};

/// The title's inset beside the macOS traffic lights.
pub const TRAFFIC_LIGHT_GUTTER: f32 = 88.0;
/// The title's inset where the native frame owns the title bar.
pub const PLAIN_GUTTER: f32 = 12.0;

/// The header's left inset: the traffic lights' gutter on macOS. It stays in
/// full screen, where macOS draws the lights over the band when the title
/// bar reveals.
pub fn gutter(mac: bool) -> f32 {
    if mac {
        TRAFFIC_LIGHT_GUTTER
    } else {
        PLAIN_GUTTER
    }
}

/// A single-pane window's root: the solid, the content coat, its rows.
#[derive(IntoElement)]
pub struct WindowFrame {
    children: SmallVec<[AnyElement; 4]>,
    appearance: Option<Appearance>,
}

impl WindowFrame {
    pub fn new() -> Self {
        WindowFrame {
            children: SmallVec::new(),
            appearance: None,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for WindowFrame {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for WindowFrame {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for WindowFrame {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        div().size_full().bg(hsla(t.glass_solid)).child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .bg(hsla(t.glass_content))
                .font_family(FONT)
                .text_color(hsla(t.foreground))
                .children(self.children),
        )
    }
}

/// The header row of a single-pane window.
#[derive(IntoElement)]
pub struct WindowHeader {
    title: SharedString,
    meta: Option<AnyElement>,
    children: SmallVec<[AnyElement; 2]>,
    mac: bool,
    appearance: Option<Appearance>,
}

impl WindowHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        WindowHeader {
            title: title.into(),
            meta: None,
            children: SmallVec::new(),
            mac: cfg!(target_os = "macos"),
            appearance: None,
        }
    }

    /// A quiet inline fact after the title.
    pub fn meta(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    /// Lays out for macOS (`true`, the traffic lights share the row) or for
    /// Windows and Linux, whatever this build runs on (the gallery shows
    /// both).
    pub fn mac(mut self, mac: bool) -> Self {
        self.mac = mac;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for WindowHeader {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for WindowHeader {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let title = div()
            .flex_none()
            .whitespace_nowrap()
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(hsla(t.foreground))
            .child(self.title);
        let meta = self.meta.map(|meta| {
            div()
                .min_w(px(0.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(meta)
        });
        let actions = (!self.children.is_empty()).then(|| {
            div()
                .ml_auto()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.0))
                .children(self.children)
        });
        div()
            .id("window-header")
            .flex_none()
            .w_full()
            .h(px(size::TOOLBAR))
            .flex()
            .items_center()
            .gap(px(8.0))
            .overflow_hidden()
            .pl(px(gutter(self.mac)))
            .pr(px(8.0))
            .border_b_1()
            .border_color(hsla(t.border))
            .window_control_area(WindowControlArea::Drag)
            .child(title)
            .children(meta)
            .children(actions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_clears_the_traffic_lights_only_on_macos() {
        assert_eq!(gutter(true), 88.0);
        assert_eq!(gutter(false), 12.0);
        // The lights end 74 px in: 14 px of air.
        assert_eq!(TRAFFIC_LIGHT_GUTTER - 74.0, 14.0);
    }
}
