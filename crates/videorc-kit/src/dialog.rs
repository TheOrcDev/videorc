//! Dialog (`components/ui/dialog.tsx`): gpui-base's modal host for the
//! behaviour (focus trap, Escape cancels, Enter confirms, a backdrop press
//! dismisses, the AccessKit dialog role), the dialog tier of the float
//! glass: the panel radius, p-5, flat and opaque, four widths, never taller
//! than the window less 16 px on each side, the body scrolling.
//!
//! The screen holds a `DialogHandle` and opens it with
//! `handle.open(window, cx)`; focus moves into the dialog as it opens.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FocusHandle, FontWeight, IntoElement, ParentElement, SharedString,
    Window, WindowControlArea, div, prelude::*, px,
};
pub use gpui_base::{DialogChangeReason, DialogHandle};
use smallvec::SmallVec;

use crate::{
    chrome::SCRIM,
    icon::{IconName, icon},
    motion::{Glass, floating, presence},
    theme::{Appearance, FONT, hsla, resolve, with_alpha},
    tokens::{radius, size},
};

type OpenChange = Rc<dyn Fn(bool, DialogChangeReason, &mut Window, &mut App)>;

/// The four widths: sm 384 px (a rename, one question), md 448 px (the
/// default: confirmations, short forms), lg 576 px (forms, pickers, setup),
/// xl 768 px (review and media).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DialogSize {
    Sm,
    #[default]
    Md,
    Lg,
    Xl,
}

impl DialogSize {
    fn width(self) -> f32 {
        match self {
            DialogSize::Sm => 384.0,
            DialogSize::Md => 448.0,
            DialogSize::Lg => 576.0,
            DialogSize::Xl => 768.0,
        }
    }
}

#[derive(IntoElement)]
pub struct Dialog {
    id: ElementId,
    handle: DialogHandle,
    title: SharedString,
    description: Option<SharedString>,
    body: SmallVec<[AnyElement; 2]>,
    footer: SmallVec<[AnyElement; 2]>,
    size: DialogSize,
    /// Stacking index: a confirm over a card uses `1` so both stay open (L3 Forget).
    layer: usize,
    close_button: bool,
    palette: bool,
    appearance: Option<Appearance>,
    on_open_change: Option<OpenChange>,
}

impl Dialog {
    pub fn new(
        id: impl Into<ElementId>,
        handle: &DialogHandle,
        title: impl Into<SharedString>,
    ) -> Self {
        Dialog {
            id: id.into(),
            handle: handle.clone(),
            title: title.into(),
            description: None,
            body: SmallVec::new(),
            footer: SmallVec::new(),
            size: DialogSize::Md,
            layer: 0,
            close_button: true,
            palette: false,
            appearance: None,
            on_open_change: None,
        }
    }

    /// Stack above another open dialog without closing it. `0` is the default
    /// card; a Forget confirm over a person card uses `1` (L3). Escape and the
    /// backdrop hit the topmost layer first.
    pub fn layer(mut self, layer: usize) -> Self {
        self.layer = layer;
        self
    }

    /// Every real open/close, including Escape, backdrop and the close button.
    /// The shared focus restoration runs before this owner lifecycle callback.
    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, DialogChangeReason, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn size(mut self, size: DialogSize) -> Self {
        self.size = size;
        self
    }

    /// The footer's buttons, right-aligned, the primary last.
    pub fn footer(mut self, button: impl IntoElement) -> Self {
        self.footer.push(button.into_any_element());
        self
    }

    /// Hides the close button (an AlertDialog has none).
    pub fn close_button(mut self, shown: bool) -> Self {
        self.close_button = shown;
        self
    }

    /// CommandDialog owns its header, rows and footer on this one surface.
    pub(crate) fn palette(mut self) -> Self {
        self.palette = true;
        self.close_button = false;
        self.size = DialogSize::Lg;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for Dialog {
    /// The body, between the header and the footer; it scrolls.
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.body.extend(elements);
    }
}

impl RenderOnce for Dialog {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        // One focus handle per dialog, kept while it is rendered: focus goes
        // in when it opens and back where it was when it closes.
        let state = window.use_keyed_state(self.id.clone(), cx, |_, cx| DialogFocus {
            inside: cx.focus_handle(),
            before: None,
        });
        let focus = state.read(cx).inside.clone();
        let open = self.handle.is_open();
        let shown = presence(
            SharedString::from(format!("{}/motion", self.id)),
            open,
            window,
            cx,
        );
        let progress = shown.progress;
        let max_height = f32::from(window.viewport_size().height) - 32.0;

        let header = div()
            .flex()
            .flex_none()
            .flex_col()
            .gap(px(6.0))
            .pr(px(if self.close_button { 28.0 } else { 0.0 }))
            .child(
                gpui_base::DialogTitle::new()
                    .text_size(px(16.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(t.foreground))
                    .child(self.title.clone()),
            )
            .children(self.description.map(|description| {
                gpui_base::DialogDescription::new()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(hsla(t.muted_foreground))
                    .child(description)
            }));
        let body = div()
            .id("dialog-body")
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(if self.palette { 0.0 } else { 12.0 }))
            .children(self.body);
        let footer = div()
            .flex()
            .flex_none()
            .justify_end()
            .gap(px(8.0))
            .children(self.footer);
        let close = self.close_button.then(|| {
            div()
                .absolute()
                .top(px(12.0))
                .right(px(12.0))
                .opacity(progress)
                .child(gpui_base::DialogClose::new().trigger(move |button| {
                    button
                        .size(px(size::CONTROL))
                        .rounded(px(radius::CHIP))
                        .hover(|style| style.bg(hsla(t.muted)))
                        .accessibility_label("Close")
                        .child(icon(IconName::X, 16.0, hsla(t.muted_foreground)))
                }))
        });
        let glass = Glass {
            fill: t.glass_float_dialog,
            rim: t.glass_float_rim,
            drop: t.glass_float_dialog_drop,
            radius: radius::PANEL,
        };
        let surface = floating(
            glass,
            progress,
            div()
                .flex_1()
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .gap(px(if self.palette { 0.0 } else { 20.0 }))
                .when(!self.palette, |surface| surface.child(header))
                .child(body)
                .child(footer),
        )
        .id("dialog-surface")
        .occlude()
        .w(px(self.size.width()))
        .max_h(px(max_height))
        .flex()
        .flex_col()
        .p(px(if self.palette { 0.0 } else { 20.0 }))
        .font_family(FONT)
        .text_size(px(14.0))
        .text_color(hsla(t.popover_foreground))
        .children(close);

        let topmost = self.layer > 0;
        let dialog = gpui_base::Dialog::new(cx)
            .focus_handle(focus)
            .accessibility_label(self.title)
            .layer(self.layer, topmost)
            // The toolbar band stays the window's drag area under the scrim.
            .dismiss_below_y(px(size::TOOLBAR))
            .backdrop(
                div()
                    .size_full()
                    .bg(hsla(with_alpha(SCRIM, progress)))
                    .window_control_area(WindowControlArea::Drag),
            )
            .popup(surface);
        if open || !shown.should_render() {
            dialog
                .handle(self.handle)
                .on_open_change(move |open, reason, window, cx| {
                    if open {
                        let before = window.focused(cx);
                        let inside = state.update(cx, |state, _| {
                            state.before = before;
                            state.inside.clone()
                        });
                        inside.focus(window, cx);
                    } else if let Some(before) = state.update(cx, |state, _| state.before.take()) {
                        before.focus(window, cx);
                    }
                    if let Some(handler) = &self.on_open_change {
                        handler(open, reason, window, cx);
                    }
                })
        } else {
            // Closed, fading out: gpui-base would drop it this frame, so it
            // stays up, open, for the exit, and takes no Escape or backdrop.
            dialog
                .open(true)
                .close_on_escape(false)
                .close_on_backdrop_press(false)
        }
    }
}

/// A dialog's focus: its own handle, and what had focus before it opened.
struct DialogFocus {
    inside: FocusHandle,
    before: Option<FocusHandle>,
}
