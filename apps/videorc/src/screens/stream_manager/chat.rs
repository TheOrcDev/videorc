//! The chat pane (P957–P982): filters, empty states, live rows and send.

use std::sync::Arc;

use gpui::{
    AnyElement, App, AppContext, Context, Entity, Focusable, IntoElement, ScrollHandle,
    SharedString, Subscription, Window, div, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::model::LiveChatMessage;
use videorc_app_core::chat::store::DeliveryCursor;
use videorc_app_core::chat::view::{self, platform_label};
use videorc_app_core::stream_manager::copy::{
    CHAT_MESSAGES, CHAT_ON_STREAM, CHAT_PANE, START_A_LIVESTREAM,
};
use videorc_app_core::stream_manager::pane::{
    self, ChatFilter, chat_pane_messages, filter_platforms,
};
use videorc_app_core::stream_manager::send::{
    CHAT_SEND_MAX_CHARS, draft_length, validate_chat_draft, writable_providers,
};
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    command::InputEvent,
    dropdown_menu::{DropdownMenu, Menu},
    empty::Empty,
    icon::{IconName, icon},
    input::{Input, InputState},
    shortcut_keys::ShortcutKeys,
    switch::Switch,
    theme::{self, hsla},
    toggle_group::{ToggleGroup, ToggleItem},
};

use super::SharedStudio;
use super::layout::{Tier, full_labels};
use super::rows::chat_row;

/// The chat pane: filter bar, rows, empty body and composer.
pub struct ChatPane {
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
    filter: ChatFilter,
    /// Destinations + message platforms (≥2 draws the platform chips).
    platforms: Vec<String>,
    messages: Vec<Arc<LiveChatMessage>>,
    mention_names: Vec<String>,
    live: bool,
    can_send: bool,
    search: Entity<InputState>,
    draft: Entity<InputState>,
    chat_on_stream: bool,
    /// Show the composer chrome while live (or a marker context later).
    composer: bool,
    sending: bool,
    /// Clear the draft on the next render (after a successful send).
    clear_draft: bool,
    /// Follow the newest message (Electron's pinned follow).
    following: bool,
    unread: usize,
    incomplete: bool,
    delivery_cursor: DeliveryCursor,
    scroll: ScrollHandle,
    _search: Subscription,
    _draft: Subscription,
}

impl ChatPane {
    pub fn new(
        studio: SharedStudio,
        runtime: tokio::runtime::Handle,
        mut live_chat: watch::Receiver<LiveChat>,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(pane::copy::SEARCH_PLACEHOLDER));
        let draft = cx.new(|cx| {
            InputState::new(window, cx).placeholder("/marker [title], /clip · Local commands")
        });
        let search_sub = cx.subscribe(&search, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.filter.search = state.read(cx).value().to_string();
                cx.notify();
            }
        });
        let draft_sub = cx.subscribe(&draft, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let seed = live_chat.borrow().clone();
        let (messages, platforms, mention_names, can_send) = view_from_chat(&seed);
        let delivery_cursor = seed.delivery.cursor();
        cx.spawn(async move |this, cx| {
            loop {
                if live_chat.changed().await.is_err() {
                    break;
                }
                let chat = live_chat.borrow().clone();
                let alive = this.update(cx, |pane, cx| {
                    pane.apply_live_chat(&chat, cx);
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            filter: ChatFilter::default(),
            platforms,
            messages,
            mention_names,
            live,
            can_send,
            search,
            draft,
            chat_on_stream: false,
            composer: live,
            sending: false,
            clear_draft: false,
            following: true,
            unread: 0,
            incomplete: false,
            delivery_cursor,
            scroll: ScrollHandle::new(),
            _search: search_sub,
            _draft: draft_sub,
        }
    }

    fn apply_live_chat(&mut self, chat: &LiveChat, cx: &mut Context<Self>) {
        let (messages, platforms, mention_names, can_send) = view_from_chat(chat);
        self.messages = messages;
        self.platforms = platforms;
        self.mention_names = mention_names;
        self.can_send = can_send;
        self.composer = self.live && can_send;
        let progress = chat.delivery.progress(Some(self.delivery_cursor));
        self.delivery_cursor = chat.delivery.cursor();
        if progress.reset || self.following {
            self.unread = 0;
            self.incomplete = false;
            if self.following {
                self.scroll.scroll_to_bottom();
            }
        } else {
            self.unread = self.unread.saturating_add(progress.count);
            if progress.incomplete {
                self.incomplete = true;
            }
        }
        cx.notify();
    }

    fn follow_newest(&mut self, cx: &mut Context<Self>) {
        self.following = true;
        self.unread = 0;
        self.incomplete = false;
        self.scroll.scroll_to_bottom();
        cx.notify();
    }

    fn note_scroll(&mut self, cx: &mut Context<Self>) {
        let offset = self.scroll.offset();
        let max = self.scroll.max_offset();
        // GPUI scrolls with a negative Y; near the bottom means following.
        let at_bottom = max.y <= px(1.) || (-offset.y) >= max.y - px(24.);
        if at_bottom {
            if !self.following || self.unread > 0 || self.incomplete {
                self.following = true;
                self.unread = 0;
                self.incomplete = false;
                cx.notify();
            }
        } else if self.following {
            self.following = false;
            cx.notify();
        }
    }

    pub fn set_live(&mut self, live: bool, cx: &mut Context<Self>) {
        if self.live == live {
            return;
        }
        self.live = live;
        self.composer = live && self.can_send;
        cx.notify();
    }

    /// Whether a send can go out (writable destinations + a session).
    pub fn can_send(&self) -> bool {
        self.can_send
    }

    fn send_draft(&mut self, cx: &mut Context<Self>) {
        if self.sending || !self.can_send {
            return;
        }
        let text = self.draft.read(cx).value().to_string();
        let Some(text) = validate_chat_draft(&text, CHAT_SEND_MAX_CHARS) else {
            return;
        };
        self.sending = true;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let sent = runtime
                .spawn(async move { studio.send_chat(&text).await })
                .await;
            let _ = this.update(cx, |pane, cx| {
                pane.sending = false;
                if matches!(sent, Ok(Ok(Some(_)))) {
                    pane.clear_draft = true;
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// ⌘F: focus the search field.
    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.read(cx).focus_handle(cx).focus(window, cx);
    }

    /// ⌘L: focus the composer.
    pub fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composer {
            self.draft.read(cx).focus_handle(cx).focus(window, cx);
        }
    }

    /// Clear view: empty the chat list in this window (Library keeps history).
    pub fn clear_view(&mut self, cx: &mut Context<Self>) {
        self.messages.clear();
        self.filter = ChatFilter::default();
        cx.notify();
    }

    fn set_platform(&mut self, platform: Option<String>, cx: &mut Context<Self>) {
        self.filter.platform = platform;
        cx.notify();
    }

    fn set_mentions(&mut self, on: bool, cx: &mut Context<Self>) {
        self.filter.mentions = on;
        cx.notify();
    }

    fn set_questions(&mut self, on: bool, cx: &mut Context<Self>) {
        self.filter.questions = on;
        cx.notify();
    }

    fn set_chat_on_stream(&mut self, on: bool, cx: &mut Context<Self>) {
        self.chat_on_stream = on;
        cx.notify();
    }

    fn build_filters_menu(&self, this: gpui::WeakEntity<Self>) -> Menu {
        let platforms = self.platforms.clone();
        let platform = self.filter.platform.clone();
        let questions = self.filter.questions;
        let mentions = self.filter.mentions;
        let mut menu = Menu::new();
        if platforms.len() >= 2 {
            menu = menu.label(pane::copy::SHOW_CHAT_FROM);
            menu = menu.radio(pane::copy::EVERY_PLATFORM, platform.is_none(), {
                let this = this.clone();
                move |_, app| {
                    let _ = this.update(app, |this, cx| this.set_platform(None, cx));
                }
            });
            for p in &platforms {
                let selected = platform.as_deref() == Some(p.as_str());
                let value = p.clone();
                menu = menu.radio(platform_label(p), selected, {
                    let this = this.clone();
                    move |_, app| {
                        let _ =
                            this.update(app, |this, cx| this.set_platform(Some(value.clone()), cx));
                    }
                });
            }
            menu = menu.separator();
        }
        menu.checkbox(pane::copy::QUESTIONS, questions, {
            let this = this.clone();
            move |on, _, app| {
                let _ = this.update(app, |this, cx| this.set_questions(on, cx));
            }
        })
        .checkbox(pane::copy::MENTIONS, mentions, {
            let this = this;
            move |on, _, app| {
                let _ = this.update(app, |this, cx| this.set_mentions(on, cx));
            }
        })
    }

    fn filters_bar(
        &self,
        tier: Tier,
        labels: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let border = hsla(t.border);
        let this = cx.entity().downgrade();
        let platforms = self.platforms.clone();
        let platform = self.filter.platform.clone();
        let questions = self.filter.questions;
        let mentions = self.filter.mentions;
        let chat_on_stream = self.chat_on_stream;
        let active = self.filter.active_count();

        let mut kind_values: Vec<SharedString> = Vec::new();
        if questions {
            kind_values.push("questions".into());
        }
        if mentions {
            kind_values.push("mentions".into());
        }
        let kind_filters = ToggleGroup::new("chat-kind-filters")
            .xs(true)
            .multiple(true)
            .accessibility_label(pane::copy::CHAT_FILTERS)
            .item(ToggleItem::new("questions", pane::copy::QUESTIONS))
            .item(ToggleItem::new("mentions", pane::copy::MENTIONS))
            .value(kind_values)
            .on_change({
                let this = this.clone();
                move |values, _, app| {
                    let questions = values.iter().any(|v| v.as_ref() == "questions");
                    let mentions = values.iter().any(|v| v.as_ref() == "mentions");
                    let _ = this.update(app, |this, cx| {
                        this.filter.questions = questions;
                        this.filter.mentions = mentions;
                        cx.notify();
                    });
                }
            });

        let platform_filters = if platforms.len() >= 2 {
            let mut values: Vec<SharedString> = Vec::new();
            if let Some(ref p) = platform {
                values.push(p.clone().into());
            } else {
                values.push("all".into());
            }
            let mut group = ToggleGroup::new("chat-platform-filter")
                .xs(true)
                .accessibility_label(pane::copy::SHOW_CHAT_FROM)
                .item(ToggleItem::new("all", pane::copy::ALL))
                .value(values)
                .on_change({
                    let this = this.clone();
                    move |values, _, app| {
                        let next = values.first().map(|v| v.to_string()).filter(|v| v != "all");
                        let _ = this.update(app, |this, cx| this.set_platform(next, cx));
                    }
                });
            for p in &platforms {
                group = group.item(ToggleItem::new(p.clone(), platform_label(p)));
            }
            Some(group)
        } else {
            None
        };

        let filters_menu = DropdownMenu::new("chat-filters-menu")
            .trigger(
                Button::new("chat-filters")
                    .label(pane::copy::FILTERS)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .accessibility_label(pane::copy::CHAT_FILTERS),
            )
            .menu({
                let this = this.clone();
                move |_, app: &mut App| {
                    this.upgrade()
                        .map(|entity| {
                            let pane = entity.read(app);
                            pane.build_filters_menu(this.clone())
                        })
                        .unwrap_or_default()
                }
            });

        let search = div()
            .id("chat-search")
            .flex()
            .flex_1()
            .min_w(px(112.))
            .items_center()
            .gap(px(4.))
            .child(icon(IconName::MagnifyingGlass, 14., muted))
            .child(
                div().flex_1().min_w(px(0.)).child(
                    Input::new("chat-search-input", &self.search)
                        .accessibility_label(pane::copy::SEARCH_LABEL),
                ),
            )
            .child(ShortcutKeys::keystrokes("cmd-f"));

        let on_stream = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .child(
                Switch::new("chat-on-stream")
                    .small(true)
                    .checked(chat_on_stream)
                    .accessibility_label(CHAT_ON_STREAM)
                    .on_change({
                        let this = this;
                        move |on, _, app| {
                            let _ = this.update(app, |this, cx| this.set_chat_on_stream(on, cx));
                        }
                    }),
            )
            .when(labels, |row| {
                row.child(
                    div()
                        .text_size(px(11.))
                        .text_color(muted)
                        .child(CHAT_ON_STREAM),
                )
            });

        div()
            .id("chat-filters")
            .flex_none()
            .w_full()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .py(px(6.))
            .border_b_1()
            .border_color(border)
            .when(tier != Tier::Narrow, |row| {
                row.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .children(platform_filters.map(IntoElement::into_any_element))
                        .child(kind_filters),
                )
            })
            .when(tier == Tier::Narrow, |row| {
                row.child(filters_menu).when(active > 0, |row| {
                    row.child(Badge::new(format!("{active}")).variant(BadgeVariant::Outline))
                })
            })
            .child(search)
            .child(on_stream)
            .into_any_element()
    }
}

impl Render for ChatPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.clear_draft {
            self.clear_draft = false;
            self.draft
                .update(cx, |draft, cx| draft.set_value("", window, cx));
        }
        let width = f32::from(window.viewport_size().width);
        let tier = Tier::of(width);
        let labels = full_labels(width);
        let t = theme::resolve(None, window, cx);
        let border = hsla(t.border);
        let muted = hsla(t.muted_foreground);
        let shown = chat_pane_messages(&self.messages, &self.filter, &self.mention_names);
        let filtering = self.filter.filtering();
        let draft = self.draft.read(cx).value().to_string();
        let draft_len = draft_length(draft.trim());
        let can_send = self.can_send
            && !self.sending
            && validate_chat_draft(&draft, CHAT_SEND_MAX_CHARS).is_some();
        let filters = self.filters_bar(tier, labels, window, cx);
        let live = self.live;
        let this = cx.entity().downgrade();
        let show_jump = !self.following && !shown.is_empty();
        let (jump_label, jump_name) = view::jump_chip(self.unread, self.incomplete);
        let list: AnyElement = if shown.is_empty() {
            let empty = if filtering {
                pane::copy::NO_MATCH
            } else {
                START_A_LIVESTREAM
            };
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.))
                .child(Empty::new().description(empty))
                .into_any_element()
        } else {
            let scroll = self.scroll.clone();
            let this_scroll = this.clone();
            div()
                .id("chat-messages-host")
                .flex_1()
                .min_h(px(0.))
                .w_full()
                .relative()
                .child(
                    div()
                        .id("chat-messages")
                        .size_full()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .px(px(4.))
                        .py(px(4.))
                        .overflow_y_scroll()
                        .track_scroll(&scroll)
                        .aria_label(CHAT_MESSAGES)
                        .on_scroll(move |_, _, app| {
                            let _ = this_scroll.update(app, |pane, cx| pane.note_scroll(cx));
                        })
                        .children(shown.into_iter().map(|message| chat_row(message, live))),
                )
                .when(show_jump, |host| {
                    let this = this.clone();
                    host.child(
                        div()
                            .id("chat-jump-chip")
                            .absolute()
                            .bottom(px(8.))
                            .left_0()
                            .right_0()
                            .flex()
                            .justify_center()
                            .child(
                                Button::new("chat-jump")
                                    .label(jump_label)
                                    .variant(ButtonVariant::Secondary)
                                    .size(ButtonSize::Xs)
                                    .accessibility_label(jump_name)
                                    .on_click(move |_, _, app| {
                                        let _ = this.update(app, |pane, cx| pane.follow_newest(cx));
                                    }),
                            ),
                    )
                })
                .into_any_element()
        };

        div()
            .id("chat-pane")
            .size_full()
            .flex()
            .flex_col()
            .aria_label(CHAT_PANE)
            .child(filters)
            .child(list)
            .when(self.composer, |pane| {
                pane.child(
                    div()
                        .id("chat-composer")
                        .flex_none()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .border_t_1()
                        .border_color(border)
                        .px(px(8.))
                        .py(px(8.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div().flex_1().min_w(px(0.)).child(
                                        Input::new("chat-draft", &self.draft)
                                            .accessibility_label("Message or local command"),
                                    ),
                                )
                                .when(draft_len > 0, |row| {
                                    row.child(
                                        div()
                                            .flex_none()
                                            .text_size(px(11.))
                                            .text_color(muted)
                                            .child(format!("{draft_len}/{CHAT_SEND_MAX_CHARS}")),
                                    )
                                })
                                .child(ShortcutKeys::keystrokes("enter"))
                                .child(
                                    Button::new("chat-send")
                                        .label("Send")
                                        .variant(ButtonVariant::Ghost)
                                        .size(ButtonSize::Xs)
                                        .disabled(!can_send)
                                        .accessibility_label("Send")
                                        .on_click({
                                            let this = this.clone();
                                            move |_, _, app| {
                                                let _ = this
                                                    .update(app, |pane, cx| pane.send_draft(cx));
                                            }
                                        }),
                                ),
                        ),
                )
            })
    }
}

fn view_from_chat(chat: &LiveChat) -> (Vec<Arc<LiveChatMessage>>, Vec<String>, Vec<String>, bool) {
    let messages: Vec<Arc<LiveChatMessage>> = chat.messages.iter().cloned().collect();
    let platforms = filter_platforms(&chat.providers, &messages);
    let mention_names: Vec<String> = chat
        .providers
        .iter()
        .filter_map(|p| p.account_label.clone())
        .collect();
    let can_send = chat.session_id.is_some() && !writable_providers(&chat.providers).is_empty();
    (messages, platforms, mention_names, can_send)
}
