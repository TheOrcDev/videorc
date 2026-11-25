//! Chat in Studio (`studio-chat.tsx`, plan 204; P188–P199): while on air
//! and switched on, the livestream's chat under Session. Each row is a small
//! avatar, the name and the words, its chips and the platform mark; a click
//! puts the message on stream and a click on the live row takes it off. The
//! full chat (filters, search, the composer, removals, Sidekick) is the
//! Stream Manager's, and the header is its door.
//!
//! The words, the gate, each row and the keys are `videorc_app_core::chat`'s
//! (`view`, `highlight`, `highlight_driver`); this file draws them. The list
//! is GPUI's variable-height `list`, newest at the bottom and following it
//! (owner call, 2026-10-21): only the streamer's own scroll stops it, and the
//! jump chip goes back.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui::{
    AnyElement, ClipboardItem, Context, FocusHandle, FollowMode, FontStyle, FontWeight,
    HighlightStyle, Image, ImageFormat, KeyDownEvent, ListAlignment, ListState, ObjectFit,
    StrikethroughStyle, StyledText, WeakEntity, Window, div, img, list, prelude::*, px,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::highlight::{FAILURE_SHOWN_FOR, StatusChip};
use videorc_app_core::chat::highlight_driver::{self as driver, ChatHighlight};
use videorc_app_core::chat::images::{self, ImageKind};
use videorc_app_core::chat::model::CommentHighlightState;
use videorc_app_core::chat::store::DeliveryCursor;
use videorc_app_core::chat::view::{
    self, ChatRowView, LIST_HEIGHT_PX, OPEN_STREAM_MANAGER_SHORTCUT, RowKey, RowTint, RunStyle,
    StudioChatBody, StudioChatView, copy,
};
use videorc_app_core::shortcuts::shortcut_accelerator;
use videorc_app_core::studio::screen_views::talk_show_room_in;
use videorc_app_core::studio::session::session_is_live;
use videorc_app_core::{BackendEvent, StudioSnapshot};
use videorc_kit::chrome::focus_ring;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::toast::{ToastData, ToastKind};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::{tooltip, tooltip_with_shortcut};
use videorc_kit::{Badge, BadgeVariant, Button, ButtonSize, ButtonVariant, Empty, PanelSection};

use super::transport::AppStudio;
use crate::screens::notifications::{Delivery, Shared as Notices};

/// `overlays.layout`: the streamer's placement of the card (plan 164).
const OVERLAY_LAYOUT_EVENT: &str = "overlays.layout";

/// The events the section follows; `main.rs` adds them to the client's
/// filter.
pub const EVENTS: [&str; 2] = [driver::STATUS_EVENT, OVERLAY_LAYOUT_EVENT];

/// `Avatar size="sm"`.
const AVATAR_PX: f32 = 24.;
/// The row's words: `text-sm leading-snug`.
const ROW_TEXT_PX: f32 = 14.;
const ROW_LINE_PX: f32 = 19.;
/// How many rows the list measures beyond its edges.
const OVERDRAW_PX: f32 = 256.;
/// Avatars kept beyond the rows on screen before the cache is trimmed.
const AVATAR_CACHE: usize = 512;
/// After a scroll, the list takes up following again in its own layout:
/// the section looks once more this much later.
const SCROLL_SETTLE: Duration = Duration::from_millis(100);

/// A row's picture: the cached avatar, or the monogram while it loads or
/// when it can't.
#[derive(Clone)]
enum Avatar {
    Loading,
    Ready(Arc<Image>),
    Failed,
}

/// What the section follows from the snapshot (`studioChatShows`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Gate {
    shows: bool,
    hydrated: bool,
}

impl Gate {
    fn of(snapshot: &StudioSnapshot) -> Self {
        Self {
            shows: view::studio_chat_shows(
                snapshot.settings.studio.studio_chat(),
                session_is_live(&snapshot.session.status),
            ),
            hydrated: snapshot.settings.hydrated,
        }
    }
}

/// The `comments-window` key as GPUI writes it, for the Open Stream Manager
/// tooltip (`shortcutAccelerator('comments-window')`).
fn stream_manager_keys() -> Option<&'static str> {
    static KEYS: OnceLock<Option<&'static str>> = OnceLock::new();
    *KEYS.get_or_init(|| {
        shortcut_accelerator(OPEN_STREAM_MANAGER_SHORTCUT).map(|accelerator| {
            let keys: &'static str =
                Box::leak(crate::app::menus::keystroke(&accelerator).into_boxed_str());
            keys
        })
    })
}

/// `setSettings({...current, studioChat: on})`.
fn write_studio_chat(studio: Arc<AppStudio>, runtime: &tokio::runtime::Handle, on: bool) {
    let _ = runtime.spawn(async move {
        if let Err(error) = studio
            .update_studio_settings(|settings| settings.set("studioChat", json!(on)))
            .await
        {
            eprintln!("[videorc-app] Chat in Studio: {}", error.message);
        }
    });
}

pub struct ChatSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    gate: Gate,
    chat: LiveChat,
    highlight: ChatHighlight,
    /// `overlays.layout.get`, then its pushes.
    overlay_layout: Option<Value>,
    notice: Option<String>,
    body: StudioChatBody,
    /// The rows the list holds, oldest first.
    rows: Rc<Vec<ChatRowView>>,
    list: ListState,
    delivery: DeliveryCursor,
    unread: usize,
    incomplete: bool,
    /// The streamer's own scroll brought the newest row into view (the list
    /// follows it again from its next layout).
    at_end: bool,
    /// A look after the scroll is on its way.
    recheck: bool,
    /// The list's one tab stop: ↑ ↓ Home End move, C copies, Enter and
    /// Space press the active row.
    focus: FocusHandle,
    active: Option<String>,
    avatars: Rc<HashMap<String, Avatar>>,
}

impl ChatSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        mut live_chat: watch::Receiver<LiveChat>,
        cx: &mut Context<Self>,
    ) -> Self {
        let gate = Gate::of(&snapshot.borrow());
        let chat = live_chat.borrow().clone();
        cx.spawn(async move |this, cx| {
            while snapshot.changed().await.is_ok() {
                let gate = Gate::of(&snapshot.borrow_and_update());
                if this
                    .update(cx, |section, cx| section.set_gate(gate, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while live_chat.changed().await.is_ok() {
                let chat = live_chat.borrow_and_update().clone();
                if this
                    .update(cx, |section, cx| section.apply_chat(chat, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        BackendEvent::ClientLagged { skipped }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if this
                    .update(cx, |section, cx| section.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let list = ListState::new(0, ListAlignment::Top, px(OVERDRAW_PX));
        list.set_follow_mode(FollowMode::Tail);
        // The list holds its own state while it calls this: only the
        // section's flags change here.
        let scrolled = cx.weak_entity();
        list.set_scroll_handler(move |event, _, cx| {
            let at_end = event.is_following_tail || event.visible_range.end >= event.count;
            let _ = scrolled.update(cx, |section, cx| section.scrolled(at_end, cx));
        });
        let delivery = chat.delivery.cursor();
        let mut section = Self {
            studio,
            runtime,
            gate,
            chat,
            highlight: ChatHighlight::default(),
            overlay_layout: None,
            notice: None,
            body: StudioChatBody::NoChat(copy::NO_CHAT),
            rows: Rc::new(Vec::new()),
            list,
            delivery,
            unread: 0,
            incomplete: false,
            at_end: true,
            recheck: false,
            focus: cx.focus_handle(),
            active: None,
            avatars: Rc::new(HashMap::new()),
        };
        section.read_backend(cx);
        if section.gate.shows {
            section.rebuild(cx);
        }
        section
    }

    fn set_gate(&mut self, gate: Gate, cx: &mut Context<Self>) {
        if gate == self.gate {
            return;
        }
        let opens = gate.shows && !self.gate.shows;
        self.gate = gate;
        if opens {
            // It appears following the newest message, with nothing unread.
            self.list.set_follow_mode(FollowMode::Tail);
            self.unread = 0;
            self.incomplete = false;
            self.at_end = true;
            self.delivery = self.chat.delivery.cursor();
            self.rebuild(cx);
        } else if !gate.shows {
            self.active = None;
        }
        cx.notify();
    }

    /// The list is on the newest message: following it, or scrolled back to
    /// its end (it follows again from the next layout).
    fn following(&self) -> bool {
        self.at_end || self.list.is_following_tail() || self.list.is_scrolled_to_end() == Some(true)
    }

    /// The streamer's own scroll (wheel, touch, the scrollbar). The list is
    /// mid-event: nothing here may touch it.
    fn scrolled(&mut self, at_end: bool, cx: &mut Context<Self>) {
        if self.at_end != at_end {
            self.at_end = at_end;
            if at_end {
                self.unread = 0;
                self.incomplete = false;
            }
            cx.notify();
        }
        if !at_end && !self.recheck {
            self.recheck = true;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SCROLL_SETTLE).await;
                let _ = this.update(cx, |section, cx| {
                    section.recheck = false;
                    cx.notify();
                });
            })
            .detach();
        }
    }

    fn apply_chat(&mut self, chat: LiveChat, cx: &mut Context<Self>) {
        let progress = chat.delivery.progress(Some(self.delivery));
        self.delivery = chat.delivery.cursor();
        self.chat = chat;
        if progress.reset {
            // A new livestream (or a clear): it follows from the start.
            self.list.set_follow_mode(FollowMode::Tail);
            self.active = None;
        }
        let following = progress.reset || self.following();
        if following && !self.list.is_following_tail() {
            // Scrolled back to the end: the new row is followed too.
            self.list.set_follow_mode(FollowMode::Tail);
        }
        self.at_end = following;
        if following {
            self.unread = 0;
            self.incomplete = false;
        } else {
            self.unread = self.unread.saturating_add(progress.count);
            self.incomplete |= progress.incomplete;
        }
        if self.gate.shows {
            self.rebuild(cx);
        }
        cx.notify();
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Untyped { event, payload } => match event.as_str() {
                driver::STATUS_EVENT => {
                    if let Ok(state) = serde_json::from_value::<CommentHighlightState>(payload) {
                        self.highlight.status(state);
                        self.refresh_rows(cx);
                    }
                }
                OVERLAY_LAYOUT_EVENT => self.overlay_layout = Some(payload),
                _ => {}
            },
            // A new connection, or events it missed: read the card and the
            // placement again.
            BackendEvent::Ready(_)
            | BackendEvent::EventsLagged(_)
            | BackendEvent::ClientLagged { .. } => self.read_backend(cx),
            _ => {}
        }
    }

    /// `comments.highlight.status` and `overlays.layout.get`.
    fn read_backend(&mut self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            let status = driver::read_status(&**studio.backend()).await;
            let layout = studio.overlay_layout().await.ok();
            (status, layout)
        });
        cx.spawn(async move |this, cx| {
            let Ok((status, layout)) = job.await else {
                return;
            };
            let _ = this.update(cx, |section, cx| {
                if layout.is_some() {
                    section.overlay_layout = layout;
                }
                if let Some(state) = status {
                    section.highlight.authoritative(state);
                    section.refresh_rows(cx);
                }
            });
        })
        .detach();
    }

    fn refresh_rows(&mut self, cx: &mut Context<Self>) {
        if self.gate.shows {
            self.rebuild(cx);
        }
        cx.notify();
    }

    /// The rows from the chat and the highlight. The list keeps every row
    /// it already measured: only the rows that came, went or changed move.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let StudioChatView { notice, body, rows } =
            StudioChatView::new(&self.chat, self.highlight.input());
        {
            let old_ids: Vec<&str> = self.rows.iter().map(|row| row.id.as_str()).collect();
            let new_ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
            for splice in view::row_splices(&old_ids, &new_ids) {
                self.list.splice(splice.range, splice.count);
            }
            let before: HashMap<&str, &ChatRowView> =
                self.rows.iter().map(|row| (row.id.as_str(), row)).collect();
            for (index, row) in rows.iter().enumerate() {
                if before.get(row.id.as_str()).is_some_and(|old| *old != row) {
                    self.list.remeasure_items(index..index + 1);
                }
            }
        }
        if self
            .active
            .as_deref()
            .is_some_and(|id| !rows.iter().any(|row| row.id == id))
        {
            self.active = None;
        }
        let wanted: Vec<String> = rows
            .iter()
            .filter_map(|row| row.avatar_url.clone())
            .filter(|url| !self.avatars.contains_key(url))
            .collect();
        if self.avatars.len() + wanted.len() > AVATAR_CACHE {
            let keep: std::collections::HashSet<&str> = rows
                .iter()
                .filter_map(|row| row.avatar_url.as_deref())
                .collect();
            Rc::make_mut(&mut self.avatars).retain(|url, _| keep.contains(url.as_str()));
        }
        self.notice = notice;
        self.body = body;
        self.rows = Rc::new(rows);
        for url in wanted {
            self.load_avatar(url, cx);
        }
    }

    /// `useCachedAvatar`: the backend caches the picture, the route serves
    /// its bytes; the monogram stays when either refuses.
    fn load_avatar(&mut self, url: String, cx: &mut Context<Self>) {
        if self.avatars.contains_key(&url) {
            return;
        }
        Rc::make_mut(&mut self.avatars).insert(url.clone(), Avatar::Loading);
        let backend = self.studio.backend().clone();
        let remote = url.clone();
        let job = self.runtime.spawn(async move {
            let local = driver::cache_image(&*backend, &remote).await?;
            let bytes = images::read_route(&local).await.ok()?;
            let kind = images::image_kind(&bytes)?;
            Some((kind, bytes))
        });
        cx.spawn(async move |this, cx| {
            let picture = job.await.ok().flatten();
            let _ = this.update(cx, |section, cx| {
                let avatar = match picture {
                    Some((kind, bytes)) => {
                        let format = match kind {
                            ImageKind::Png => ImageFormat::Png,
                            ImageKind::Jpeg => ImageFormat::Jpeg,
                            ImageKind::Gif => ImageFormat::Gif,
                            ImageKind::Webp => ImageFormat::Webp,
                        };
                        Avatar::Ready(Arc::new(Image::from_bytes(format, bytes)))
                    }
                    None => Avatar::Failed,
                };
                Rc::make_mut(&mut section.avatars).insert(url, avatar);
                cx.notify();
            });
        })
        .detach();
    }

    /// The jump chip: back to the newest message, following it again.
    fn follow(&mut self, cx: &mut Context<Self>) {
        self.list.set_follow_mode(FollowMode::Tail);
        self.at_end = true;
        self.unread = 0;
        self.incomplete = false;
        cx.notify();
    }

    /// Hiding is cheap to undo, so it never asks: the section goes, and one
    /// toast says where it went, with Undo.
    fn hide(&mut self, cx: &mut Context<Self>) {
        if !self.gate.hydrated {
            return;
        }
        write_studio_chat(self.studio.clone(), &self.runtime, false);
        let Some(notices) = cx.try_global::<Notices>().map(|shared| shared.0.clone()) else {
            return;
        };
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let undo_notices = notices.clone();
        let mut toast = ToastData::new(ToastKind::Info, copy::HIDDEN)
            .description(copy::HIDDEN_WHERE)
            .action(copy::UNDO, move |_, cx| {
                write_studio_chat(studio.clone(), &runtime, true);
                undo_notices.update(cx, |_, cx| {
                    cx.emit(Delivery::Dismiss(copy::HIDDEN_TOAST_ID.to_string()))
                });
            });
        // Undo is a moment's offer, not a state still true: it goes on its
        // own (`TOAST_WITH_DESCRIPTION_MS`).
        toast.timeout = Some(Some(videorc_app_core::notices::WITH_DESCRIPTION));
        notices.update(cx, |hub, cx| {
            hub.press_toast(copy::HIDDEN_TOAST_ID.to_string(), toast, cx)
        });
    }

    /// A click on a row: it becomes the active one, and a row that can go
    /// on stream goes on (or comes off).
    fn click_row(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.active = Some(id.to_string());
        window.focus(&self.focus, cx);
        self.press(id, cx);
        cx.notify();
    }

    /// `toggleCommentHighlight` for the row `id`.
    fn press(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.rows.iter().any(|row| row.id == id && row.pressable()) {
            return;
        }
        let Some(message) = self.chat.message(id).cloned() else {
            return;
        };
        let snapshot = self.studio.snapshot();
        let room_open = talk_show_room_in(&self.studio.cloud_now()).open;
        let canvas = driver::highlight_canvas(
            &snapshot.settings.capture_doc,
            room_open,
            self.overlay_layout.as_ref(),
        );
        let click = match self
            .highlight
            .click(&message, self.chat.session_id.as_deref(), &canvas)
        {
            Ok(click) => click,
            Err(mark) => {
                self.expire_later(mark, cx);
                self.read_backend(cx);
                self.refresh_rows(cx);
                return;
            }
        };
        self.refresh_rows(cx);
        let backend = self.studio.backend().clone();
        let sent = click.clone();
        let job = self.runtime.spawn(async move {
            let outcome = driver::send(&*backend, &sent).await;
            // A failure reads the card again: it stays where the backend
            // says it is.
            let status = if outcome.is_err() {
                driver::read_status(&*backend).await
            } else {
                None
            };
            (outcome, status)
        });
        cx.spawn(async move |this, cx| {
            let Ok((outcome, status)) = job.await else {
                return;
            };
            let _ = this.update(cx, |section, cx| {
                if let Some(mark) =
                    section
                        .highlight
                        .settle(click.intent, &click.message_id, outcome)
                {
                    section.expire_later(mark, cx);
                }
                if let Some(state) = status {
                    section.highlight.authoritative(state);
                }
                section.refresh_rows(cx);
            });
        })
        .detach();
    }

    /// A failure's reason leaves its row after five seconds.
    fn expire_later(&self, mark: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FAILURE_SHOWN_FOR).await;
            let _ = this.update(cx, |section, cx| {
                if section.highlight.expire_failure(mark) {
                    section.refresh_rows(cx);
                }
            });
        })
        .detach();
    }

    /// One tab stop for the list (`chatRowKeyCommand`): ↑ ↓ Home End move
    /// the active row, C copies "Name: message", Enter and Space are the
    /// row's own click.
    fn keys(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            return;
        }
        let modifiers = event.keystroke.modifiers;
        let Some(key) = view::row_key(
            &event.keystroke.key,
            modifiers.shift,
            modifiers.platform || modifiers.control,
            modifiers.alt,
        ) else {
            return;
        };
        let rows = self.rows.clone();
        let index = self
            .active
            .as_deref()
            .and_then(|id| rows.iter().position(|row| row.id == id));
        match key {
            RowKey::Move(step) => {
                let Some(next) = view::row_after_move(rows.len(), index, step) else {
                    return;
                };
                self.active = Some(rows[next].id.clone());
                // The streamer's own move: it stops following unless it
                // lands on the newest row.
                let newest = next + 1 == rows.len();
                if !newest {
                    self.list.pause_following_tail();
                }
                self.at_end = newest;
                self.list.scroll_to_reveal_item(next);
            }
            RowKey::Copy => {
                let Some(row) = index.and_then(|index| rows.get(index)) else {
                    return;
                };
                cx.write_to_clipboard(ClipboardItem::new_string(row.copy.clone()));
            }
            RowKey::Press => {
                let Some(row) = index.and_then(|index| rows.get(index)) else {
                    return;
                };
                let id = row.id.clone();
                self.press(&id, cx);
            }
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn messages(
        &mut self,
        empty_text: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let following = self.following();
        if following {
            // Back on the newest message (the streamer's own scroll, or the
            // keys): nothing is unread any more.
            self.unread = 0;
            self.incomplete = false;
        }
        let show_jump = !following && !self.rows.is_empty();
        let (jump_label, jump_name) = view::jump_chip(self.unread, self.incomplete);
        let body: AnyElement = if self.rows.is_empty() {
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(Empty::new().description(empty_text))
                .into_any_element()
        } else {
            let rows = self.rows.clone();
            let avatars = self.avatars.clone();
            let section = cx.entity().downgrade();
            let active = self
                .focus
                .is_focused(window)
                .then(|| self.active.clone())
                .flatten();
            list(self.list.clone(), move |index, window, cx| {
                let t = theme::resolve(None, window, cx);
                match rows.get(index) {
                    Some(row) => chat_row(row, index, active.as_deref(), &avatars, &section, t),
                    None => div().into_any_element(),
                }
            })
            .size_full()
            .into_any_element()
        };
        div()
            .id("studio-chat-list")
            .relative()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("studio-chat-messages")
                    .h(px(LIST_HEIGHT_PX))
                    .w_full()
                    .track_focus(&self.focus)
                    .tab_index(0)
                    .on_key_down(cx.listener(Self::keys))
                    .aria_label(copy::LIST)
                    .child(body),
            )
            .children(show_jump.then(|| {
                div()
                    .absolute()
                    .bottom(px(8.))
                    .left_0()
                    .right_0()
                    .flex()
                    .justify_center()
                    .child(
                        Button::new("studio-chat-jump")
                            .label(jump_label)
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::Xs)
                            .accessibility_label(jump_name)
                            .on_click(cx.listener(|section, _, _, cx| section.follow(cx))),
                    )
            }))
            .into_any_element()
    }
}

impl Render for ChatSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.gate.shows {
            return div().id("studio-chat").into_any_element();
        }
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let ghost_ink = hsla(t.foreground);
        // The full chat is the Stream Manager's; this is its door.
        let open = Button::new("studio-chat-open-stream-manager")
            .variant(ButtonVariant::Ghost)
            .label(copy::OPEN_STREAM_MANAGER)
            .accessibility_label(copy::OPEN_STREAM_MANAGER)
            .on_click(|_, _, cx| crate::screens::stream_manager::window::show(cx));
        let open_tip = div().id("studio-chat-open-stream-manager-tip");
        let open = match stream_manager_keys() {
            Some(keys) => open_tip.tooltip(tooltip_with_shortcut(copy::OPEN_STREAM_MANAGER, keys)),
            None => open_tip.tooltip(tooltip(copy::OPEN_STREAM_MANAGER)),
        }
        .child(open);
        let hide = Button::new("studio-chat-hide")
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::IconXs)
            .accessibility_label(copy::HIDE)
            .tooltip(copy::HIDE)
            .child(icon(IconName::X, 16., ghost_ink))
            .on_click(cx.listener(|section, _, _, cx| section.hide(cx)));
        // No "Chat" title (plan 235 D3): the rows are plainly chat, and the
        // list names itself.
        let notice = self
            .notice
            .clone()
            .map(|notice| div().type_scale(text::META).text_color(muted).child(notice));
        let body = match self.body.clone() {
            StudioChatBody::NoChat(words) => div()
                .type_scale(text::META)
                .text_color(muted)
                .child(words)
                .into_any_element(),
            StudioChatBody::List { empty_text } => self.messages(empty_text, window, cx),
        };
        PanelSection::new("studio-chat")
            .action(open)
            .action(hide)
            .children(notice)
            .child(body)
            .into_any_element()
    }
}

/// `StudioChatRow`: one message, a button when it can go on stream.
fn chat_row(
    row: &ChatRowView,
    index: usize,
    active: Option<&str>,
    avatars: &HashMap<String, Avatar>,
    section: &WeakEntity<ChatSection>,
    t: &'static Theme,
) -> AnyElement {
    let foreground = hsla(t.foreground);
    let muted = hsla(t.muted_foreground);
    let live = row.phase == videorc_app_core::chat::RowPhase::Live;
    let tint = row.tint;
    let (line, runs) = view::row_line(row);
    let highlights: Vec<_> = runs
        .into_iter()
        .map(|(range, style)| (range, run_style(style, t)))
        .collect();

    let picture = row
        .avatar_url
        .as_ref()
        .and_then(|url| match avatars.get(url) {
            Some(Avatar::Ready(image)) => Some(image.clone()),
            Some(Avatar::Loading | Avatar::Failed) | None => None,
        });
    let avatar = div()
        .flex_none()
        .mt(px(1.))
        .size(px(AVATAR_PX))
        .rounded_full()
        .overflow_hidden()
        .bg(hsla(t.muted))
        .flex()
        .items_center()
        .justify_center()
        .child(match picture {
            Some(image) => img(image)
                .size_full()
                .object_fit(ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .type_scale(text::META)
                .text_color(muted)
                .child(row.initials.clone())
                .into_any_element(),
        });

    let words = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(2.))
        .child(
            div()
                .text_size(px(ROW_TEXT_PX))
                .line_height(px(ROW_LINE_PX))
                .text_color(foreground)
                .child(StyledText::new(line).with_highlights(highlights)),
        )
        // P199: why the highlight failed, under the row.
        .children(row.problem.clone().map(|problem| {
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(problem)
        }));

    let arrival = row.arrival.as_ref().map(|chip| {
        div()
            .id(("studio-chat-arrival", index))
            .flex_none()
            .tooltip(tooltip(chip.hint.clone()))
            .child(Badge::new(chip.label.clone()).variant(BadgeVariant::Outline))
    });
    let chips = row.chips.iter().map(|(label, chip)| {
        Badge::new(*label).variant(match chip {
            StatusChip::Neutral => BadgeVariant::Default,
            StatusChip::Chrome => BadgeVariant::Chrome,
            StatusChip::Destructive => BadgeVariant::Destructive,
        })
    });
    let trailing = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .children(
            row.amount
                .clone()
                .map(|amount| Badge::new(amount).variant(BadgeVariant::Warning)),
        )
        .children(arrival)
        .children(chips)
        // The platform mark closes the row (plan 165). The kit has no
        // platform marks yet, so the platform's name stands in for it.
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(row.platform_label),
        );

    let focused = active == Some(row.id.as_str());
    let pressable = row.pressable();
    let id = row.id.clone();
    let section = section.clone();
    let mut plate = div()
        .id(("studio-chat-row", index))
        .w_full()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(8.))
        .px(px(8.))
        .py(px(4.))
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(gpui::transparent_black())
        .aria_label(row.name.clone())
        .when(pressable, |plate| {
            plate.aria_description(row.description.clone())
        })
        .child(avatar)
        .child(words)
        .child(trailing);
    // One background per row: on stream, then paid, then member.
    plate = if live {
        plate
            .bg(hsla(t.chrome_row_live_top))
            .border_color(hsla(t.chrome_row_rim))
    } else {
        match tint {
            Some(RowTint::Paid) => plate
                .bg(hsla(with_alpha(t.warning, 0.10)))
                .border_color(hsla(with_alpha(t.warning, 0.30))),
            // A member's plate, with the member hue only as its 2px edge.
            Some(RowTint::Member) => plate.relative().bg(hsla(t.chrome_row_member_top)).child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .bottom_0()
                    .w(px(2.))
                    .rounded_full()
                    .bg(hsla(t.member)),
            ),
            None => plate,
        }
    };
    if pressable {
        let accent = hsla(t.accent);
        plate = plate
            .cursor_pointer()
            .when(!live && tint.is_none(), |plate| {
                plate.hover(move |style| style.bg(accent))
            });
    }
    if focused {
        plate = plate.shadow(vec![focus_ring(t)]);
    }
    let plate = plate.on_click(move |_, window, cx| {
        let _ = section.update(cx, |section, cx| section.click_row(&id, window, cx));
    });
    div().w_full().pb(px(2.)).child(plate).into_any_element()
}

/// How a run of the row's line reads.
fn run_style(style: RunStyle, t: &Theme) -> HighlightStyle {
    let muted = hsla(t.muted_foreground);
    match style {
        RunStyle::Author => HighlightStyle {
            font_weight: Some(FontWeight::SEMIBOLD),
            ..HighlightStyle::default()
        },
        RunStyle::Notice => HighlightStyle {
            color: Some(muted),
            font_style: Some(FontStyle::Italic),
            ..HighlightStyle::default()
        },
        RunStyle::Deleted => HighlightStyle {
            color: Some(muted),
            strikethrough: Some(StrikethroughStyle {
                thickness: px(1.),
                color: Some(muted),
            }),
            ..HighlightStyle::default()
        },
    }
}
