//! The activity pane (P983–P989): live rows from chat events and the
//! dashboard's destination / audience facts, with kind filters and Auto-show.

use std::sync::Arc;

use gpui::{
    AnyElement, Context, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::model::LiveChatMessage;
use videorc_app_core::chat::view::platform_label;
use videorc_app_core::stream_manager::activity::{ActivityFilter, ActivityItem, activity_items};
use videorc_app_core::stream_manager::dashboard::LiveDashboard;
use videorc_kit::empty::Empty;
use videorc_kit::platform_glyph::PlatformMark;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, hsla};
use videorc_kit::toggle_group::{ToggleGroup, ToggleItem};

/// Electron's empty copy (`activity-pane.tsx`).
const ACTIVITY_EMPTY: &str = "Follows, subs, gifts, tips and raids appear here as they happen.";
const ACTIVITY_FILTERED_EMPTY: &str = "Nothing matches this filter.";
const ACTIVITY_PANE: &str = "Activity";
const ACTIVITY_LIST: &str = "Activity";
const AUTO_SHOW: &str = "Auto-show";
/// The switch's name (`aria-label`).
const AUTO_SHOW_NAME: &str =
    "Automatically show new follows, subs, gifts, tips, rewards, raids and streaks on stream";
const FILTER_ACTIVITY: &str = "Filter activity";
/// `PlatformFilter`'s order.
const PLATFORM_ORDER: &[&str] = &[
    "youtube",
    "twitch",
    "kick",
    "x",
    "facebook",
    "tiktok",
    "instagram",
    "custom",
];
const SHOW_FROM: &str = "Show activity from";

const FILTERS: &[(ActivityFilter, &str)] = &[
    (ActivityFilter::Follows, "Follows"),
    (ActivityFilter::Support, "Subs"),
    (ActivityFilter::Tips, "Tips"),
    (ActivityFilter::Rewards, "Rewards"),
    (ActivityFilter::Raids, "Raids"),
    (ActivityFilter::Streaks, "Streaks"),
    (ActivityFilter::Destinations, "Destinations"),
];

/// The activity pane: rows from live chat + dashboard destination events.
pub struct ActivityPane {
    items: Vec<ActivityItem>,
    messages: Vec<Arc<LiveChatMessage>>,
    destination_events: Vec<videorc_app_core::stream_manager::dashboard::DestinationEvent>,
    audience: Option<videorc_app_core::stream_manager::dashboard::AudienceSnapshot>,
    /// `None` = All.
    filter: Option<ActivityFilter>,
    /// `PlatformFilter`'s choice; `None` = All.
    platform: Option<String>,
    auto_show: bool,
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
            filter: None,
            platform: None,
            auto_show: false,
        }
    }

    /// The platforms chat reads, in the filter's order (`PlatformFilter`).
    fn platforms(&self) -> Vec<&'static str> {
        PLATFORM_ORDER
            .iter()
            .copied()
            .filter(|platform| self.messages.iter().any(|m| m.platform == *platform))
            .collect()
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
        self.rebuild(cx);
    }

    fn shown(&self) -> Vec<&ActivityItem> {
        self.items
            .iter()
            .filter(|item| match self.filter {
                None => true,
                Some(want) => item.filter == Some(want),
            })
            .filter(|item| {
                self.platform
                    .as_deref()
                    .is_none_or(|platform| item.platform == platform)
            })
            .collect()
    }

    /// `ActivityPane`'s header: the platform filter (All and each platform's
    /// mark, as chat's), the kind chips that have rows (with their count; a
    /// chip pressed again turns back off), and Auto-show with its words.
    fn filters_bar(&self, muted: gpui::Hsla, cx: &mut Context<Self>) -> AnyElement {
        let this = cx.entity().downgrade();
        let mut platform_group = ToggleGroup::new("activity-platform-filter")
            .xs(true)
            .accessibility_label(SHOW_FROM)
            .item(ToggleItem::new("all", "All"))
            .value(vec![SharedString::from(
                self.platform.clone().unwrap_or_else(|| "all".into()),
            )])
            .on_change({
                let this = this.clone();
                move |values, _, app| {
                    let next = values.first().map(|v| v.to_string()).filter(|v| v != "all");
                    let _ = this.update(app, |pane, cx| {
                        pane.platform = next;
                        cx.notify();
                    });
                }
            });
        for platform in self.platforms() {
            platform_group = platform_group.item(
                ToggleItem::new(platform, platform_label(platform))
                    .child(
                        PlatformMark::new(chat_platform(platform))
                            .id(SharedString::from(format!(
                                "activity-filter-mark-{platform}"
                            )))
                            .size(20.),
                    )
                    .chip(true),
            );
        }
        let with_rows: Vec<(ActivityFilter, &str, usize)> = FILTERS
            .iter()
            .map(|(filter, label)| {
                let count = self
                    .items
                    .iter()
                    .filter(|item| item.filter == Some(*filter))
                    .count();
                (*filter, *label, count)
            })
            .filter(|(_, _, count)| *count > 0)
            .collect();
        let kinds = (!with_rows.is_empty()).then(|| {
            let mut group = ToggleGroup::new("activity-kind-filters")
                .xs(true)
                .accessibility_label(FILTER_ACTIVITY)
                .value(
                    self.filter
                        .map(|filter| vec![SharedString::from(filter_id(filter))])
                        .unwrap_or_default(),
                )
                .on_change({
                    let this = this.clone();
                    move |values, _, app| {
                        let next = values.first().map(|v| v.as_ref()).and_then(parse_filter);
                        let _ = this.update(app, |pane, cx| {
                            pane.filter = next;
                            cx.notify();
                        });
                    }
                });
            for (filter, label, count) in with_rows {
                group = group.item(ToggleItem::new(
                    filter_id(filter),
                    format!("{label} {count}"),
                ));
            }
            group
        });
        let auto_show = self.auto_show;
        div()
            .id("activity-filters")
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .py(px(6.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w(px(0.))
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .child(platform_group)
                    .children(kinds),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(12.))
                    .text_color(muted)
                    .child(AUTO_SHOW)
                    .child(
                        Switch::new("activity-auto-show")
                            .small(true)
                            .accessibility_label(AUTO_SHOW_NAME)
                            .checked(auto_show)
                            .on_change(move |value, _, app| {
                                let _ = this.update(app, |pane, cx| {
                                    pane.auto_show = value;
                                    cx.notify();
                                });
                            }),
                    ),
            )
            .into_any_element()
    }

    /// `activityCapabilityNote`: what this stream's platforms don't share.
    fn capability_note(&self) -> Option<String> {
        let platforms = self.platforms();
        let mut notes: Vec<&str> = Vec::new();
        if platforms.contains(&"x") {
            notes.push("X doesn't share tips. New X followers show as a count.");
        }
        if platforms.contains(&"kick") {
            notes.push("Kick shows each new follow but doesn't share a follower total.");
        }
        (!notes.is_empty()).then(|| notes.join(" "))
    }
}

/// `ChatPlatformIcon`'s platform: the backend's id, anything else custom.
fn chat_platform(platform: &str) -> videorc_kit::ChatPlatform {
    use videorc_kit::ChatPlatform;
    match platform {
        "youtube" => ChatPlatform::Youtube,
        "twitch" => ChatPlatform::Twitch,
        "kick" => ChatPlatform::Kick,
        "x" => ChatPlatform::X,
        "facebook" => ChatPlatform::Facebook,
        "tiktok" => ChatPlatform::Tiktok,
        "instagram" => ChatPlatform::Instagram,
        _ => ChatPlatform::Custom,
    }
}

fn filter_id(filter: ActivityFilter) -> &'static str {
    match filter {
        ActivityFilter::Follows => "follows",
        ActivityFilter::Support => "support",
        ActivityFilter::Tips => "tips",
        ActivityFilter::Rewards => "rewards",
        ActivityFilter::Raids => "raids",
        ActivityFilter::Streaks => "streaks",
        ActivityFilter::Destinations => "destinations",
    }
}

fn parse_filter(id: &str) -> Option<ActivityFilter> {
    match id {
        "follows" => Some(ActivityFilter::Follows),
        "support" => Some(ActivityFilter::Support),
        "tips" => Some(ActivityFilter::Tips),
        "rewards" => Some(ActivityFilter::Rewards),
        "raids" => Some(ActivityFilter::Raids),
        "streaks" => Some(ActivityFilter::Streaks),
        "destinations" => Some(ActivityFilter::Destinations),
        _ => None,
    }
}

fn activity_row(item: &ActivityItem, muted: gpui::Hsla, border: gpui::Hsla) -> AnyElement {
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
                        .child(item.name.clone()),
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
        .child(div().text_size(px(12.)).child(item.line.clone()))
        .children(item.message.as_ref().map(|message| {
            div()
                .text_size(px(12.))
                .text_color(muted)
                .child(message.clone())
                .into_any_element()
        }))
        .into_any_element()
}

impl Render for ActivityPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let border = hsla(t.border);
        let shown = self.shown();
        let filtering = self.filter.is_some();
        let filtering = filtering || self.platform.is_some();
        let empty: String = if filtering {
            ACTIVITY_FILTERED_EMPTY.into()
        } else {
            match self.capability_note() {
                Some(note) => format!("{ACTIVITY_EMPTY} {note}"),
                None => ACTIVITY_EMPTY.into(),
            }
        };
        div()
            .id("activity-pane")
            .size_full()
            .flex()
            .flex_col()
            .aria_label(ACTIVITY_PANE)
            .child(self.filters_bar(muted, cx))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .flex_col()
                    .when(shown.is_empty(), |body| {
                        body.items_center()
                            .justify_center()
                            .px(px(16.))
                            .child(Empty::new().description(empty))
                    })
                    .when(!shown.is_empty(), |body| {
                        let mut list = div().id(ACTIVITY_LIST).flex().flex_col().w_full();
                        for item in &shown {
                            list = list.child(activity_row(item, muted, border));
                        }
                        body.child(list)
                    }),
            )
    }
}
