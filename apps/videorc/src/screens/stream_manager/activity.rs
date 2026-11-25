//! The activity pane (P983–P989): live rows from chat events and the
//! dashboard's destination / audience facts.

use std::sync::Arc;

use gpui::{
    AnyElement, AppContext, Context, FontWeight, IntoElement, SharedString, Window, div,
    prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::model::LiveChatMessage;
use videorc_app_core::chat::view::platform_label;
use videorc_app_core::stream_manager::activity::{ActivityItem, activity_items};
use videorc_app_core::stream_manager::dashboard::LiveDashboard;
use videorc_kit::{
    empty::Empty,
    theme::{self, hsla},
};

/// Electron's empty copy (`activity-pane.tsx`).
const ACTIVITY_EMPTY: &str = "Follows, subs, gifts, tips and raids appear here as they happen.";
const ACTIVITY_PANE: &str = "Activity";
const ACTIVITY_LIST: &str = "Activity";

/// The activity pane: rows from live chat + dashboard destination events.
pub struct ActivityPane {
    items: Vec<ActivityItem>,
    messages: Vec<Arc<LiveChatMessage>>,
    destination_events: Vec<videorc_app_core::stream_manager::dashboard::DestinationEvent>,
    audience: Option<videorc_app_core::stream_manager::dashboard::AudienceSnapshot>,
}

impl ActivityPane {
    pub fn new(
        mut live_chat: watch::Receiver<LiveChat>,
        mut dashboard: watch::Receiver<LiveDashboard>,
        cx: &mut Context<Self>,
    ) -> Self {
        let chat = live_chat.borrow().clone();
        let board = dashboard.borrow().clone();
        let messages: Vec<Arc<LiveChatMessage>> = chat.messages.iter().cloned().collect();
        let destination_events = board.destination_events.clone();
        let audience = board.audience.clone();
        let items = activity_items(&messages, &destination_events, audience.as_ref());
        cx.spawn(async move |this, cx| {
            loop {
                tokio::select! {
                    changed = live_chat.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let chat = live_chat.borrow().clone();
                        let alive = this.update(cx, |pane, cx| {
                            pane.messages = chat.messages.iter().cloned().collect();
                            pane.rebuild(cx);
                        });
                        if alive.is_err() {
                            break;
                        }
                    }
                    changed = dashboard.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let board = dashboard.borrow().clone();
                        let alive = this.update(cx, |pane, cx| {
                            pane.destination_events = board.destination_events.clone();
                            pane.audience = board.audience.clone();
                            pane.rebuild(cx);
                        });
                        if alive.is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .detach();
        Self {
            items,
            messages,
            destination_events,
            audience,
        }
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        self.items = activity_items(
            &self.messages,
            &self.destination_events,
            self.audience.as_ref(),
        );
        cx.notify();
    }

    /// Clear view: empty the activity list in this window.
    pub fn clear_view(&mut self, cx: &mut Context<Self>) {
        self.messages.clear();
        self.destination_events.clear();
        self.audience = None;
        self.items.clear();
        cx.notify();
    }
}

impl Render for ActivityPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let border = hsla(t.border);
        let body: AnyElement = if self.items.is_empty() {
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.))
                .child(Empty::new().description(ACTIVITY_EMPTY))
                .into_any_element()
        } else {
            div()
                .id("activity-list")
                .flex_1()
                .min_h(px(0.))
                .w_full()
                .flex()
                .flex_col()
                .overflow_y_scroll()
                .aria_label(ACTIVITY_LIST)
                .children(
                    self.items
                        .iter()
                        .cloned()
                        .map(|item| activity_row(item, muted, border)),
                )
                .into_any_element()
        };
        div()
            .id("activity-pane")
            .size_full()
            .flex()
            .flex_col()
            .aria_label(ACTIVITY_PANE)
            .child(body)
    }
}

fn activity_row(item: ActivityItem, muted: gpui::Hsla, border: gpui::Hsla) -> AnyElement {
    let platform = platform_label(&item.platform);
    let short = if item.short.is_empty() {
        None
    } else {
        Some(item.short.clone())
    };
    div()
        .id(SharedString::from(format!("activity-{}", item.id)))
        .w_full()
        .flex()
        .flex_col()
        .gap(px(2.))
        .px(px(12.))
        .py(px(8.))
        .border_b_1()
        .border_color(border)
        .child(
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(item.name),
                )
                .child(div().text_size(px(11.)).text_color(muted).child(platform))
                .children(short.map(|short| {
                    div()
                        .text_size(px(11.))
                        .text_color(muted)
                        .child(short)
                        .into_any_element()
                })),
        )
        .child(div().text_size(px(12.)).child(item.line))
        .children(item.message.map(|message| {
            div()
                .text_size(px(12.))
                .text_color(muted)
                .child(message)
                .into_any_element()
        }))
        .into_any_element()
}
