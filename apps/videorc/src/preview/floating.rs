//! The floating Preview window (plan 260 S2.3a, macOS): its own
//! `NativeView` (a native view shows in one window only), square-cornered.
//! As Electron's (P1548), it stays visible to screen capture: the core's
//! rule for the Preview role, applied through Hide from stream like every
//! window's. It sits above other apps only with Keep on top (P132), and
//! remembers its frame (P1549, `super::frame`). The element's layer
//! moves into it without restarting the backend's surface (plan 220
//! S2.3b's dock and undock), and closing it docks the preview again. Over
//! the video it says what the Studio slot would: "Opening preview…" until
//! the first frame, "Preview failed" once the contracts give up. It redraws
//! when the Preview notifies (its phase or mode changed), never per frame.

use gpui::{App, Context, Entity, WeakEntity, Window, canvas, div, prelude::*};
use objc2::rc::Retained;
use objc2_app_kit::NSView;
use videorc_kit::theme::hsla;
use videorc_kit::tokens::DARK;
use videorc_preview::words;

use videorc_app_core::desktop::capture_protection::WindowRole;

use super::frame::PreviewFrame;
use super::macos::{self, HostView};
use super::{Host, Preview, words_card};
use crate::app::hide::HideFromStream;

pub struct FloatingPreview {
    /// The view the layer goes into, or why GPUI could not host one.
    host: Result<HostView, String>,
    preview: WeakEntity<Preview>,
}

impl FloatingPreview {
    /// The window's root view (`open_window`'s builder): hosts the view,
    /// applies the capture rule and Keep on top, follows the frame, and
    /// docks the preview when the user closes it. The preview attaches its
    /// layer once the window is open (`Preview::float`), never from inside
    /// this builder.
    pub fn build(
        preview: WeakEntity<Preview>,
        frame: Option<PreviewFrame>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let host = HostView::new(window, cx);
        // The Preview role is never hidden (P1548); this keeps it on the
        // same path as the other windows.
        if cx.has_global::<HideFromStream>() {
            let _ = HideFromStream::apply(window, WindowRole::Preview, false, cx);
        }
        let on_top = frame.as_ref().is_some_and(PreviewFrame::always_on_top);
        if let Err(error) = crate::platform::current().set_keep_on_top(window, on_top) {
            eprintln!("[videorc-app] preview: Keep on top didn't apply: {error}");
        }
        let closing = preview.clone();
        window.on_window_should_close(cx, move |_, cx| {
            let _ = closing.update(cx, |preview, cx| preview.floating_closed(cx));
            true
        });
        cx.new(|cx: &mut Context<Self>| {
            if let Some(entity) = preview.upgrade() {
                cx.observe(&entity, |_, _, cx| cx.notify()).detach();
            }
            if let Some(frame) = frame {
                frame.moved(window);
                cx.observe_window_bounds(window, move |_, window, _| frame.moved(window))
                    .detach();
            }
            Self { host, preview }
        })
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The video ground is the same in every appearance.
        let slot = div().size_full().relative().bg(hsla(DARK.video_ground));
        let Ok(host) = &self.host else {
            // No native view: the honest card, as the docked slot says it.
            return slot.child(words_card(words::FAILED));
        };
        let words = self
            .preview
            .upgrade()
            .and_then(|preview| preview.read(cx).floating_words());
        let preview = self.preview.clone();
        let slot = slot.child(host.native.clone()).child(
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
        );
        match words {
            Some(words) => slot.child(words_card(words)),
            None => slot,
        }
    }
}
