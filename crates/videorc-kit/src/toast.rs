//! Toasts (`components/ui/sonner.tsx`, the skill's Toast discipline):
//! gpui-base's ToastManager and ToastStack for the queue, the timing, the
//! stacking motion and the AccessKit alert role; every toast is the same
//! neutral float glass, and its type colours its icon only (owner call
//! 2026-09-29; a design guard holds it).
//!
//! - One id per kind of toast: a newer one replaces the older.
//! - At most three show, each dismissible, above the status bar.
//! - A one-line toast stays 4 s; one with a description at least 8 s; one
//!   with an action until it is acted on or closed.
//!
//! A window hosts one `Toaster` entity as its top layer and calls `show`.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    Anchor, AnyElement, App, Context, FocusHandle, FontWeight, IntoElement, Render, SharedString,
    Window, div, prelude::*, px,
};
use gpui_base::{ToastManager, ToastMotion, ToastOptions, ToastStack, ToastStackState};

use crate::{
    button::{Button, ButtonSize, ButtonVariant},
    icon::{IconName, icon},
    popover::popup_surface,
    theme::{Appearance, FONT, current, hsla},
    tokens::{Color, Theme, size},
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

/// A click handler: a toast's action, or its close button.
pub type ActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One toast's words and its optional action.
#[derive(Clone)]
pub struct ToastData {
    pub kind: ToastKind,
    pub title: SharedString,
    pub description: Option<SharedString>,
    pub action: Option<(SharedString, ActionHandler)>,
    /// None uses the defaults; Some(None) waits until explicitly dismissed.
    pub timeout: Option<Option<Duration>>,
    /// Only a manual close; expiry and programmatic dismissal do not read news.
    pub on_close: Option<ActionHandler>,
}

impl ToastData {
    pub fn new(kind: ToastKind, title: impl Into<SharedString>) -> Self {
        ToastData {
            kind,
            title: title.into(),
            description: None,
            action: None,
            timeout: None,
            on_close: None,
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

    /// `defaultToastDuration`: an action waits for the streamer, a
    /// description gets time to be read.
    fn timeout(&self) -> Option<Duration> {
        if let Some(timeout) = self.timeout {
            return timeout;
        }
        if self.action.is_some() {
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

pub struct Toaster {
    toasts: ToastManager<SharedString, ToastData>,
    stack: ToastStackState,
    focus: FocusHandle,
    ticking: bool,
}

impl Toaster {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Toaster {
            toasts: ToastManager::new(ToastMotion::sonner()),
            stack: ToastStackState::default(),
            focus: cx.focus_handle(),
            ticking: false,
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
        self.toasts.push(id.into(), toast, options, Instant::now());
        self.tick(window, cx);
        cx.notify();
    }

    /// Whether a recovery still has a visible/closing toast to replace.
    pub fn contains(&self, id: &SharedString) -> bool {
        self.toasts.get(id).is_some()
    }

    pub fn dismiss(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
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
                let alive = this.update_in(cx, |this, _, cx| {
                    let paused = this.stack.is_expanded();
                    if this.toasts.advance(Instant::now(), paused).changed {
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

/// One toast card: the float glass, the tinted icon, the words, the action
/// and the close button. Public so the gallery can show each kind still.
pub fn toast_card(
    t: &'static Theme,
    id: SharedString,
    toast: &ToastData,
    on_close: Option<ActionHandler>,
    appearance: Option<Appearance>,
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
                .line_height(px(18.0))
                .font_weight(FontWeight::MEDIUM)
                .child(toast.title.clone()),
        )
        .children(toast.description.clone().map(|description| {
            div()
                .text_size(px(13.0))
                .line_height(px(18.0))
                .text_color(hsla(t.muted_foreground))
                .child(description)
        }));
    let action = toast.action.clone().map(|(label, handler)| {
        let mut button = Button::new(SharedString::from(format!("{id}-action")))
            .label(label)
            .variant(ButtonVariant::Secondary)
            .size(ButtonSize::Xs)
            .on_click(move |_, window, cx| handler(window, cx));
        if let Some(appearance) = appearance {
            button = button.appearance(appearance);
        }
        button
    });
    let close = on_close.map(|on_close| {
        let mut button = Button::new(SharedString::from(format!("{id}-close")))
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::IconXs)
            .accessibility_label("Dismiss notification")
            .on_click(move |_, window, cx| on_close(window, cx))
            .child(icon(IconName::X, 14.0, hsla(t.muted_foreground)));
        if let Some(appearance) = appearance {
            button = button.appearance(appearance);
        }
        button
    });
    popup_surface(t)
        .w_full()
        .flex()
        .items_start()
        .gap(px(8.0))
        .px(px(16.0))
        .py(px(14.0))
        .font_family(FONT)
        .children(tone.map(|(name, tone)| {
            // The one place a toast's type paints: its icon.
            div().pt(px(1.0)).child(icon(name, 16.0, hsla(tone)))
        }))
        .child(words)
        .children(action)
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
            .bottom(px(size::STATUS_BAR + 16.0))
    }
}
