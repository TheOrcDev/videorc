//! Toasts (`components/ui/sonner.tsx`, the skill's Toast discipline):
//! gpui-base's ToastManager and ToastStack for the queue, the timing, the
//! stacking motion and the AccessKit alert role; every toast is the same
//! neutral float glass, and its type colours its icon only (owner call
//! 2026-09-29; a design guard holds it).
//!
//! - One id per kind of toast: a newer one replaces the older.
//! - At most three show, each dismissible, above the status bar.
//! - A one-line toast stays 4 s; one with a description at least 8 s; one
//!   with an action or cancel until it is acted on or closed.
//!
//! Layout matches sonner 2.0.7 (L7 design-parity K1–K9): 16 px pad, centred
//! icon row, description near-title strength, close as a 20 px circle on the
//! top-left corner, inverted action chip, optional cancel before the action.
//!
//! A window hosts one `Toaster` entity as its top layer and calls `show`.

use std::{
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    Anchor, AnyElement, App, Context, FocusHandle, FontWeight, IntoElement, Render, SharedString,
    Window, div, prelude::*, px,
};
use gpui_base::{ToastManager, ToastMotion, ToastOptions, ToastStack, ToastStackState};

use crate::{
    icon::{IconName, icon},
    popover::popup_surface,
    theme::{Appearance, FONT, current, hsla, is_dark, with_alpha},
    tokens::{Color, Theme, radius, size},
};

/// What the toast says by its icon's colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToastKind {
    /// No icon.
    #[default]
    Plain,
    /// Async work that finished out of view; a destructive confirmation.
    Success,
    /// Neutral news, or a step to take in the browser.
    Info,
    /// It can't happen now, or it is degraded.
    Warning,
    /// It failed and needs you.
    Error,
}

/// A click handler: a toast's action, cancel, or its close button.
pub type ActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One toast's words and its optional action / cancel.
#[derive(Clone)]
pub struct ToastData {
    pub kind: ToastKind,
    pub title: SharedString,
    pub description: Option<SharedString>,
    pub action: Option<(SharedString, ActionHandler)>,
    /// Drawn before the action (Electron sonner cancel / Copy beside Retry).
    pub cancel: Option<(SharedString, ActionHandler)>,
    /// None uses the defaults; Some(None) waits until explicitly dismissed.
    pub timeout: Option<Option<Duration>>,
    /// Only a manual close; expiry and programmatic dismissal do not read news.
    pub on_close: Option<ActionHandler>,
    /// The timed toast actually left, after its exit animation. Not called
    /// by replacement, an action or programmatic/manual dismissal.
    pub on_auto_close: Option<ActionHandler>,
}

impl ToastData {
    pub fn new(kind: ToastKind, title: impl Into<SharedString>) -> Self {
        ToastData {
            kind,
            title: title.into(),
            description: None,
            action: None,
            cancel: None,
            timeout: None,
            on_close: None,
            on_auto_close: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn action(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.action = Some((label.into(), Rc::new(handler)));
        self
    }

    /// Cancel / secondary chip drawn before the action (Copy beside Retry).
    pub fn cancel(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.cancel = Some((label.into(), Rc::new(handler)));
        self
    }

    /// `defaultToastDuration`: an action or cancel waits for the streamer; a
    /// description gets time to be read.
    fn timeout(&self) -> Option<Duration> {
        if let Some(timeout) = self.timeout {
            return timeout;
        }
        if self.action.is_some() || self.cancel.is_some() {
            None
        } else if self.description.is_some() {
            Some(Duration::from_secs(8))
        } else {
            Some(Duration::from_secs(4))
        }
    }
}

/// How often the queue advances while a toast shows.
const TICK: Duration = Duration::from_millis(50);
/// Each window shows at most three.
const VISIBLE: usize = 3;

/// Sonner description ink: near-title strength (not muted-foreground).
/// Light `#3f3f3f`, dark hsl(0 0% 91%). Allowlisted in design guards.
const DESC_LIGHT: Color = 0x3f3f3fff;
const DESC_DARK: Color = 0xe8e8e8ff;

/// Close-button rim / glyph (sonner light gray scale).
const CLOSE_BORDER_LIGHT: Color = 0xedededff;
const CLOSE_GLYPH_LIGHT: Color = 0x171717ff;
const CLOSE_HOVER_BG_LIGHT: Color = 0xf8f8f8ff;
const CLOSE_HOVER_BORDER_LIGHT: Color = 0xe8e8e8ff;
const CLOSE_HOVER_BG_DARK: Color = 0x1f1f1fff;
const CLOSE_HOVER_BORDER_DARK: Color = 0x404040ff;

pub struct Toaster {
    toasts: ToastManager<SharedString, ToastData>,
    stack: ToastStackState,
    focus: FocusHandle,
    ticking: bool,
    expiring: BTreeSet<SharedString>,
}

impl Toaster {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Toaster {
            toasts: ToastManager::new(ToastMotion::sonner()),
            stack: ToastStackState::default(),
            focus: cx.focus_handle(),
            ticking: false,
            expiring: BTreeSet::new(),
        }
    }

    /// Shows `toast` under `id`, replacing the one already there.
    pub fn show(
        &mut self,
        id: impl Into<SharedString>,
        toast: ToastData,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let options = ToastOptions {
            timeout: toast.timeout(),
        };
        let id = id.into();
        self.expiring.remove(&id);
        self.toasts.push(id, toast, options, Instant::now());
        self.tick(window, cx);
        cx.notify();
    }

    /// Whether a recovery still has a visible, active toast to replace.
    pub fn contains(&self, id: &SharedString) -> bool {
        self.toasts.visible(VISIBLE).any(|(shown, _, phase)| {
            shown == id && phase != gpui_base::ToastTransitionStatus::Ending
        })
    }

    pub fn dismiss(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        self.expiring.remove(id);
        if self.toasts.dismiss(id, Instant::now()) {
            self.tick(window, cx);
            cx.notify();
        }
    }

    /// Advances the queue while anything shows, then stops: an idle window
    /// runs no timer.
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.ticking {
            return;
        }
        self.ticking = true;
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let alive = this.update_in(cx, |this, window, cx| {
                    let paused = this.stack.is_expanded() || !window.is_visible();
                    let changes = this.toasts.advance(Instant::now(), paused);
                    this.expiring.extend(changes.ending);
                    let callbacks = changes
                        .removed
                        .into_iter()
                        .filter_map(|(id, toast)| {
                            this.expiring
                                .remove(&id)
                                .then_some(toast.on_auto_close)
                                .flatten()
                        })
                        .collect::<Vec<_>>();
                    // Call outside this entity's update, so a callback may
                    // safely publish another toast. Undo remains usable for
                    // the whole exit animation, until the toast is removed.
                    if !callbacks.is_empty() {
                        window.defer(cx, move |window, cx| {
                            for callback in callbacks {
                                callback(window, cx);
                            }
                        });
                    }
                    if changes.changed {
                        cx.notify();
                    }
                    let alive = !this.toasts.is_empty();
                    this.ticking = alive;
                    alive
                });
                if !matches!(alive, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }
}

/// A kind's icon and the tone that colours it: the one place a toast's
/// type paints.
fn kind_icon(kind: ToastKind, t: &Theme) -> Option<(IconName, Color)> {
    match kind {
        ToastKind::Plain => None,
        ToastKind::Success => Some((IconName::CheckCircle, t.success)),
        ToastKind::Info => Some((IconName::Info, t.info)),
        ToastKind::Warning => Some((IconName::Warning, t.warning)),
        ToastKind::Error => Some((IconName::XCircle, t.destructive)),
    }
}

fn description_color(t: &Theme) -> Color {
    if is_dark(t) { DESC_DARK } else { DESC_LIGHT }
}

/// Sonner `[data-button]`: inverted chip (popover-foreground on glass-float).
fn toast_action_chip(
    id: SharedString,
    label: SharedString,
    handler: ActionHandler,
    t: &Theme,
) -> AnyElement {
    div()
        .id(id)
        .flex_none()
        .h(px(24.0))
        .px(px(8.0))
        .rounded(px(radius::TOAST_ACTION))
        .flex()
        .items_center()
        .justify_center()
        .bg(hsla(t.popover_foreground))
        .text_color(hsla(t.glass_float))
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .cursor_pointer()
        .on_click(move |_, window, cx| handler(window, cx))
        .child(label)
        .into_any_element()
}

/// Sonner `[data-cancel]`: same height, quiet fill.
fn toast_cancel_chip(
    id: SharedString,
    label: SharedString,
    handler: ActionHandler,
    t: &Theme,
) -> AnyElement {
    let fill = if is_dark(t) {
        with_alpha(0xffffffff, 0.3)
    } else {
        with_alpha(0x000000ff, 0.08)
    };
    div()
        .id(id)
        .flex_none()
        .h(px(24.0))
        .px(px(8.0))
        .rounded(px(radius::TOAST_ACTION))
        .flex()
        .items_center()
        .justify_center()
        .bg(hsla(fill))
        .text_color(hsla(t.popover_foreground))
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .cursor_pointer()
        .on_click(move |_, window, cx| handler(window, cx))
        .child(label)
        .into_any_element()
}

/// Sonner close: 20×20 circle on the card's top-left corner.
fn toast_close(id: SharedString, on_close: ActionHandler, t: &Theme) -> AnyElement {
    let dark = is_dark(t);
    let border = if dark {
        t.glass_float_rim
    } else {
        CLOSE_BORDER_LIGHT
    };
    let glyph = if dark {
        t.popover_foreground
    } else {
        CLOSE_GLYPH_LIGHT
    };
    let hover_bg = if dark {
        CLOSE_HOVER_BG_DARK
    } else {
        CLOSE_HOVER_BG_LIGHT
    };
    let hover_border = if dark {
        CLOSE_HOVER_BORDER_DARK
    } else {
        CLOSE_HOVER_BORDER_LIGHT
    };
    div()
        .id(id)
        .absolute()
        .top(px(-7.0))
        .left(px(-7.0))
        .size(px(20.0))
        .rounded_full()
        .border_1()
        .border_color(hsla(border))
        .bg(hsla(t.glass_float))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(hsla(hover_bg)).border_color(hsla(hover_border)))
        .aria_label("Dismiss notification")
        .on_click(move |_, window, cx| on_close(window, cx))
        .child(icon(IconName::X, 14.0, hsla(glyph)))
        .into_any_element()
}

/// One toast card: the float glass, the tinted icon, the words, cancel,
/// action and the close button. Public so the gallery can show each kind still.
pub fn toast_card(
    t: &'static Theme,
    id: SharedString,
    toast: &ToastData,
    on_close: Option<ActionHandler>,
    _appearance: Option<Appearance>,
) -> AnyElement {
    let tone = kind_icon(toast.kind, t);
    let words = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .text_size(px(13.0))
                .line_height(px(19.5))
                .font_weight(FontWeight::MEDIUM)
                .child(toast.title.clone()),
        )
        .children(toast.description.clone().map(|description| {
            div()
                .text_size(px(13.0))
                .line_height(px(18.2))
                .text_color(hsla(description_color(t)))
                .child(description)
        }));

    let cancel = toast.cancel.clone().map(|(label, handler)| {
        toast_cancel_chip(
            SharedString::from(format!("{id}-cancel")),
            label,
            handler,
            t,
        )
    });
    let action = toast.action.clone().map(|(label, handler)| {
        toast_action_chip(
            SharedString::from(format!("{id}-action")),
            label,
            handler,
            t,
        )
    });
    let close = on_close
        .map(|on_close| toast_close(SharedString::from(format!("{id}-close")), on_close, t));

    popup_surface(t)
        .relative()
        .w_full()
        .flex()
        .items_center()
        .gap(px(6.0))
        .p(px(16.0))
        .font_family(FONT)
        .children(tone.map(|(name, tone)| {
            // Sonner icon margins: -3 start, +4 end (gap already 6).
            div()
                .flex_none()
                .ml(px(-3.0))
                .mr(px(4.0))
                .child(icon(name, 16.0, hsla(tone)))
        }))
        .child(words)
        .child(
            div()
                .flex_none()
                .ml_auto()
                .flex()
                .items_center()
                .gap(px(6.0))
                .children(cancel)
                .children(action),
        )
        .children(close)
        .into_any_element()
}

impl Render for Toaster {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = current(window, cx).theme();
        let this = cx.entity().downgrade();
        let items: Vec<(SharedString, AnyElement)> = self
            .toasts
            .visible(VISIBLE)
            .map(|(id, toast, status)| {
                let close_id = id.clone();
                let this = this.clone();
                let closed = toast.on_close.clone();
                let on_close: ActionHandler = Rc::new(move |window, cx| {
                    if let Some(closed) = &closed {
                        closed(window, cx);
                    }
                    let _ = this.update(cx, |toaster, cx| toaster.dismiss(&close_id, window, cx));
                });
                let mut data = toast.clone();
                // Action and cancel both dismiss, then run the handler.
                if let Some((label, action)) = data.action.take() {
                    let entity = cx.entity().downgrade();
                    let action_id = id.clone();
                    data.action = Some((
                        label,
                        Rc::new(move |window, cx| {
                            let _ = entity
                                .update(cx, |toaster, cx| toaster.dismiss(&action_id, window, cx));
                            action(window, cx);
                        }),
                    ));
                }
                if let Some((label, cancel)) = data.cancel.take() {
                    let entity = cx.entity().downgrade();
                    let cancel_id = id.clone();
                    data.cancel = Some((
                        label,
                        Rc::new(move |window, cx| {
                            let _ = entity
                                .update(cx, |toaster, cx| toaster.dismiss(&cancel_id, window, cx));
                            cancel(window, cx);
                        }),
                    ));
                }
                let card = gpui_base::Toast::new(id.clone())
                    .transition_status(status)
                    .occlude()
                    .w_full()
                    .child(toast_card(t, id.clone(), &data, Some(on_close), None));
                (id.clone(), card.into_any_element())
            })
            .collect();
        items
            .into_iter()
            .fold(
                ToastStack::new("toasts", self.stack.clone()),
                |stack, (id, item)| stack.item(id, item),
            )
            .placement(Anchor::BottomRight)
            .focus_handle(self.focus.clone())
            .flex()
            .flex_col()
            .w(px(356.0))
            .absolute()
            .right(px(16.0))
            .bottom(px(size::STATUS_BAR + 12.0))
    }
}
