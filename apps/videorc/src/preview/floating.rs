//! The floating Preview window (plan 260 S2.3a, macOS): its own
//! `NativeView` (a native view shows in one window only), above other apps
//! and out of every screen capture, square-cornered. The element's layer
//! moves into it without restarting the backend's surface (plan 220
//! S2.3b's dock and undock), and closing it docks the preview again.

use gpui::{
    App, Context, Entity, FontWeight, WeakEntity, Window, canvas, div, prelude::*, px, rgb,
};
use objc2::rc::Retained;
use objc2_app_kit::NSView;
use videorc_preview::words;

use super::macos::{self, HostView};
use super::{Host, Preview};

pub struct FloatingPreview {
    /// The view the layer goes into, or why GPUI could not host one.
    host: Result<HostView, String>,
    preview: WeakEntity<Preview>,
}

impl FloatingPreview {
    /// The window's root view (`open_window`'s builder): hosts the view,
    /// takes the window out of capture and docks the preview when the user
    /// closes it. The preview attaches its layer once the window is open
    /// (`Preview::float`), never from inside this builder.
    pub fn build(preview: WeakEntity<Preview>, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let host = HostView::new(window, cx);
        if macos::float_out_of_capture(window) != Some(0) {
            eprintln!("[videorc-app] preview: the Preview window could not be kept out of capture");
        }
        let closing = preview.clone();
        window.on_window_should_close(cx, move |_, cx| {
            let _ = closing.update(cx, |preview, cx| preview.floating_closed(cx));
            true
        });
        cx.new(|_| Self { host, preview })
    }

    /// The view the element's layer goes into, or why there is none.
    pub fn host_view(&self) -> Result<Retained<NSView>, String> {
        match &self.host {
            Ok(host) => Ok(host.view.clone()),
            Err(error) => Err(error.clone()),
        }
    }
}

impl Render for FloatingPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let slot = div().size_full().relative().bg(rgb(0x000000));
        let Ok(host) = &self.host else {
            // No native view: the honest card, as the docked slot says it.
            return slot
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .text_color(rgb(0xe8e8ea))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(words::FAILED.title),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(0x8e8e93))
                        .child(words::FAILED.detail),
                );
        };
        let preview = self.preview.clone();
        slot.child(host.native.clone()).child(
            canvas(
                move |bounds, window, cx| {
                    let geometry = macos::geometry_of(window, bounds, cx);
                    let _ = preview.update(cx, |preview, _| {
                        preview.place(Host::Floating, bounds, geometry)
                    });
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
}
