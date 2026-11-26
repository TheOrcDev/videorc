//! The chat pane (P957–P982): filters, empty states, live rows and send.
//! A row's click (and its ⋯ Highlight) puts the message on stream or takes
//! it off through `chat::highlight_driver`, as the Studio's chat does; the
//! corner pick writes the highlight's place into the overlay layout
//! (Electron's `snapHighlightToAnchor`).

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, App, AppContext, Context, Entity, Focusable, IntoElement, ScrollHandle,
    SharedString, Subscription, Window, div, prelude::*, px,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::highlight::FAILURE_SHOWN_FOR;
use videorc_app_core::chat::highlight_driver::{self as driver, ChatHighlight};
use videorc_app_core::chat::images;
use videorc_app_core::chat::model::CommentHighlightState;
use videorc_app_core::chat::model::{LiveChatMessage, LiveChatProviderState};
use videorc_app_core::chat::store::DeliveryCursor;
use videorc_app_core::chat::view::{self, platform_label};
use videorc_app_core::client::BackendEvent;
use videorc_app_core::editor::inspector::{overlay_snap_rect, with_overlay_rect};
use videorc_app_core::stream_manager::completions::{
    ComposerCompletion, EDIT_CHAT_COMMANDS, composer_completions,
};
use videorc_app_core::stream_manager::copy::{
    CHAT_MESSAGES, CHAT_ON_STREAM, CHAT_PANE, START_A_LIVESTREAM,
};
use videorc_app_core::stream_manager::pane::{
    self, ChatFilter, chat_pane_messages, filter_platforms,
};
use videorc_app_core::stream_manager::removal::{
    self, ModerationOperation, OutcomeKind, latest_by_message, removal_outcome_toast,
    remove_from_chat_available,
};
use videorc_app_core::stream_manager::send::{
    CHAT_SEND_MAX_CHARS, draft_length, validate_chat_draft, writable_providers,
};
use videorc_app_core::studio::screen_views::talk_show_room_in;
use videorc_app_core::user_error::{Failure, REMOVE_THE_MESSAGE, toast_user_error};
use videorc_kit::theme::TypeScale as _;
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    command::{CommandItem, CommandList, InputEvent},
    dropdown_menu::{DropdownMenu, Menu},
    empty::Empty,
    icon::{IconName, icon},
    input::{Input, InputState},
    shortcut_keys::ShortcutKeys,
    switch::Switch,
    theme::{self, hsla},
    toast::{ToastData, ToastKind, Toaster},
    toggle_group::{ToggleGroup, ToggleItem},
};

use super::SharedStudio;
use super::layout::{Tier, full_labels};
use super::rows::{OnHighlight, OnRemove, chat_row};
use crate::screens::chat_media::{self, Picture};

/// How many emote/GIF pictures to keep for the visible chat.
const MEDIA_CACHE: usize = 512;

const UNDO: &str = "Undo";

/// `overlays.layout`: the backend's placement as it changes.
const OVERLAY_LAYOUT_EVENT: &str = "overlays.layout";

/// The highlight card's corner (`CommentHighlightAnchor`), bottom left by
/// default (the backend's and Electron's default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HighlightAnchor {
    TopLeft,
    TopRight,
    #[default]
    BottomLeft,
    BottomRight,
}

impl HighlightAnchor {
    pub const ALL: [Self; 4] = [
        Self::TopLeft,
        Self::TopRight,
        Self::BottomLeft,
        Self::BottomRight,
    ];

    /// The wire's word, which is also the overlay snap's.
    pub fn id(self) -> &'static str {
        match self {
            Self::TopLeft => "top-left",
            Self::TopRight => "top-right",
            Self::BottomLeft => "bottom-left",
            Self::BottomRight => "bottom-right",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::TopLeft => "Top left",
            Self::TopRight => "Top right",
            Self::BottomLeft => "Bottom left",
            Self::BottomRight => "Bottom right",
        }
    }

    /// `normalizeCommentHighlightAnchor`: an unknown word is the default.
    pub fn parse(value: Option<&str>) -> Self {
        Self::ALL
            .into_iter()
            .find(|anchor| Some(anchor.id()) == value)
            .unwrap_or_default()
    }
}

/// The chat pane: filter bar, rows, empty body and composer.
pub struct ChatPane {
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
    filter: ChatFilter,
    /// Destinations + message platforms (≥2 draws the platform chips).
    platforms: Vec<String>,
    /// Live chat providers (Remove from chat's scope check).
    providers: Vec<LiveChatProviderState>,
    messages: Vec<Arc<LiveChatMessage>>,
    mention_names: Vec<String>,
    live: bool,
    can_send: bool,
    /// Session removals (`liveChat.moderationOperation`).
    operations: Vec<ModerationOperation>,
    /// Message ids with Remove in flight (Undo toast or the RPC).
    requesting: Vec<String>,
    toaster: Entity<Toaster>,
    /// P962: the destinations whose chat only a sign-in brings.
    sign_in_rows: Vec<pane::SignInRow>,
    search: Entity<InputState>,
    draft: Entity<InputState>,
    chat_on_stream: bool,
    /// Show the composer chrome while live (or a marker context later).
    composer: bool,
    sending: bool,
    /// Clear the draft on the next render (after a successful send).
    clear_draft: bool,
    /// Replace the draft on the next render (after picking a completion).
    pending_draft: Option<String>,
    /// Selected row in the composer completion list.
    completion_index: usize,
    /// Follow the newest message (Electron's pinned follow).
    following: bool,
    /// Frames left to keep a following list at its newest message while the
    /// rows lay out (a window opened onto chat that is already there).
    settle_scroll: u8,
    /// A past session's transcript is on screen (Library ⋯ → Open in Stream
    /// Manager): the live chat waits until Back to live.
    history: bool,
    unread: usize,
    incomplete: bool,
    delivery_cursor: DeliveryCursor,
    scroll: ScrollHandle,
    /// The click in flight, the backend's card and a failure's reason.
    highlight: ChatHighlight,
    /// Clicks sent and not answered yet (`comments-window-command-trace`).
    pending: usize,
    session_id: Option<String>,
    /// `overlays.layout`, once read: the card's rects.
    overlay_layout: Option<Value>,
    anchor: HighlightAnchor,
    /// Emote and GIF pictures (P198), keyed by remote URL.
    pictures: Rc<HashMap<String, Picture>>,
    _search: Subscription,
    _draft: Subscription,
}

impl ChatPane {
    pub fn new(
        studio: SharedStudio,
        runtime: tokio::runtime::Handle,
        mut live_chat: watch::Receiver<LiveChat>,
        mut moderation: watch::Receiver<Vec<ModerationOperation>>,
        toaster: Entity<Toaster>,
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
        let draft_sub = cx.subscribe(&draft, |this, state, event: &InputEvent, cx| match event {
            InputEvent::Change => {
                this.completion_index = 0;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                let draft = state.read(cx).value().to_string();
                let completions = composer_completions(&draft);
                if let Some(row) = completions.get(this.completion_index) {
                    this.apply_completion(row, cx);
                } else {
                    this.send_draft(cx);
                }
            }
            _ => {}
        });
        let seed = live_chat.borrow().clone();
        let (messages, platforms, mention_names, can_send) = view_from_chat(&seed);
        let sign_in_rows = pane::chat_sign_in_rows(&seed.providers);
        let delivery_cursor = seed.delivery.cursor();
        let session_id = seed.session_id.clone();
        let operations = moderation.borrow().clone();
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
                    .update(cx, |pane, cx| pane.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                if live_chat.changed().await.is_err() {
                    break;
                }
                let chat = live_chat.borrow().clone();
                let alive = this.update(cx, |pane, cx| {
                    if !pane.history {
                        pane.apply_live_chat(&chat, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                if moderation.changed().await.is_err() {
                    break;
                }
                let operations = moderation.borrow().clone();
                let alive = this.update(cx, |pane, cx| {
                    pane.operations = operations;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut pane = Self {
            studio,
            runtime,
            filter: ChatFilter::default(),
            platforms,
            providers: seed.providers.clone(),
            messages,
            mention_names,
            live,
            can_send,
            operations,
            requesting: Vec::new(),
            toaster,
            sign_in_rows,
            search,
            draft,
            chat_on_stream: false,
            composer: live,
            sending: false,
            clear_draft: false,
            pending_draft: None,
            completion_index: 0,
            following: true,
            history: false,
            settle_scroll: 0,
            unread: 0,
            incomplete: false,
            delivery_cursor,
            scroll: ScrollHandle::new(),
            highlight: ChatHighlight::default(),
            pending: 0,
            session_id,
            overlay_layout: None,
            anchor: HighlightAnchor::default(),
            pictures: Rc::new(HashMap::new()),
            _search: search_sub,
            _draft: draft_sub,
        };
        pane.read_backend(cx);
        pane
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Untyped { event, payload } => match event.as_str() {
                driver::STATUS_EVENT => {
                    if let Ok(state) = serde_json::from_value::<CommentHighlightState>(payload) {
                        self.highlight.status(state);
                        cx.notify();
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
            let _ = this.update(cx, |pane, cx| {
                if layout.is_some() {
                    pane.overlay_layout = layout;
                }
                if let Some(state) = status {
                    pane.highlight.authoritative(state);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// `toggleCommentHighlight` for the message `id`: on stream, or off
    /// when it is the one on stream. False when no shown row is `id` or it
    /// can't go on stream.
    pub fn press_highlight(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let Some(message) = self
            .messages
            .iter()
            .find(|message| message.id == id)
            .cloned()
        else {
            return false;
        };
        let presentation = videorc_app_core::chat::highlight::presentation(
            id,
            &self.highlight.state,
            self.highlight.applying_id.as_deref(),
            self.highlight.failure.as_ref(),
        );
        if !videorc_app_core::stream_manager::rows::ManagerRow::new(
            &message,
            presentation,
            self.live,
            &self.mention_names,
        )
        .row
        .highlightable
        {
            return false;
        }
        let snapshot = self.studio.snapshot();
        let room_open = talk_show_room_in(&self.studio.cloud_now()).open;
        let canvas = driver::highlight_canvas(
            &snapshot.settings.capture_doc,
            room_open,
            self.overlay_layout.as_ref(),
        );
        let click = match self.highlight.click(
            &message,
            self.session_id.as_deref(),
            &canvas,
            self.anchor.id(),
        ) {
            Ok(click) => click,
            Err(mark) => {
                self.expire_later(mark, cx);
                self.read_backend(cx);
                cx.notify();
                return true;
            }
        };
        self.pending += 1;
        cx.notify();
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
            let answer = job.await;
            let _ = this.update(cx, |pane, cx| {
                pane.pending = pane.pending.saturating_sub(1);
                if let Ok((outcome, status)) = answer {
                    if let Some(mark) =
                        pane.highlight
                            .settle(click.intent, &click.message_id, outcome)
                    {
                        pane.expire_later(mark, cx);
                    }
                    if let Some(state) = status {
                        pane.highlight.authoritative(state);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        true
    }

    /// A failure's reason leaves its row after five seconds.
    fn expire_later(&self, mark: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FAILURE_SHOWN_FOR).await;
            let _ = this.update(cx, |pane, cx| {
                if pane.highlight.expire_failure(mark) {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn anchor(&self) -> HighlightAnchor {
        self.anchor
    }

    /// The status bar's corner pick: the card's rects at that corner, on
    /// both orientations, written to the overlay layout (a live card moves
    /// with it, as the backend redraws from the layout).
    pub fn pick_anchor(&mut self, anchor: HighlightAnchor, cx: &mut Context<Self>) {
        self.anchor = anchor;
        let mut layout = self.overlay_layout.clone().unwrap_or_else(|| json!({}));
        for vertical in [false, true] {
            let rect = overlay_snap_rect("highlight", vertical, anchor.id());
            layout = with_overlay_rect(&layout, "highlight", vertical, rect);
        }
        self.overlay_layout = Some(layout.clone());
        cx.notify();
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.set_overlay_layout(layout).await });
        cx.spawn(async move |this, cx| {
            if let Ok(Some(saved)) = job.await {
                let _ = this.update(cx, |pane, _| pane.overlay_layout = Some(saved));
            }
        })
        .detach();
    }

    /// `comments-window-reader-state`: the rows' words and each shown row's
    /// highlight phase and reason, as Electron's reader reads its window.
    pub fn smoke_reader_state(&self) -> Value {
        let shown = chat_pane_messages(&self.messages, &self.filter, &self.mention_names);
        let mut text = String::new();
        let mut phases = serde_json::Map::new();
        let mut reasons = serde_json::Map::new();
        for message in shown {
            let presentation = videorc_app_core::chat::highlight::presentation(
                &message.id,
                &self.highlight.state,
                self.highlight.applying_id.as_deref(),
                self.highlight.failure.as_ref(),
            );
            let row = videorc_app_core::stream_manager::rows::ManagerRow::new(
                message,
                presentation.clone(),
                self.live,
                &self.mention_names,
            );
            // Electron's reader reads the window's innerText, where an emote
            // is a picture: the name, then the words without the emotes.
            text.push_str(&row.row.author);
            text.push('\n');
            for piece in &row.pieces {
                match piece {
                    videorc_app_core::stream_manager::rows::Piece::Text(words) => {
                        text.push_str(words)
                    }
                    videorc_app_core::stream_manager::rows::Piece::Link(link) => {
                        text.push_str(&link.text)
                    }
                    videorc_app_core::stream_manager::rows::Piece::Emote { .. } => {}
                }
            }
            text.push('\n');
            phases.insert(message.id.clone(), json!(presentation.phase.as_str()));
            if let Some(reason) = presentation.reason {
                reasons.insert(message.id.clone(), json!(reason));
            }
        }
        json!({
            "text": text,
            "highlightPhases": phases,
            "highlightReasons": reasons,
            "highlightAnchor": self.anchor.id(),
        })
    }

    /// `comments-window-command-trace`: the clicks still in flight.
    pub fn smoke_command_trace(&self) -> Value {
        json!({ "pendingCount": self.pending })
    }

    fn apply_live_chat(&mut self, chat: &LiveChat, cx: &mut Context<Self>) {
        let (messages, platforms, mention_names, can_send) = view_from_chat(chat);
        let session_changed = self.session_id != chat.session_id;
        self.messages = messages;
        self.platforms = platforms;
        self.providers = chat.providers.clone();
        self.mention_names = mention_names;
        self.can_send = can_send;
        self.sign_in_rows = pane::chat_sign_in_rows(&chat.providers);
        self.session_id = chat.session_id.clone();
        // Electron's chat pane: `live = !inHistory && Boolean(snapshot.sessionId)`:
        // a chat with a session is live (composer, highlights, row actions,
        // times on hover), whether or not the stream is on air.
        self.live = !self.history && self.session_id.is_some();
        self.composer = self.live && can_send;
        if session_changed {
            self.requesting.clear();
        }
        let progress = chat.delivery.progress(Some(self.delivery_cursor));
        self.delivery_cursor = chat.delivery.cursor();
        if progress.reset || self.following {
            self.unread = 0;
            self.incomplete = false;
            if self.following {
                self.scroll.scroll_to_bottom();
                // Before the list's first layout the scroll has no extent
                // yet: scroll again on the next frames, once rows are laid
                // out (Electron opens on the newest message).
                self.settle_scroll = 2;
            }
        } else {
            self.unread = self.unread.saturating_add(progress.count);
            if progress.incomplete {
                self.incomplete = true;
            }
        }
        self.warm_media(cx);
        cx.notify();
    }

    /// Cache emote and GIF pictures for the rows on screen (P198).
    fn warm_media(&mut self, cx: &mut Context<Self>) {
        let mut wanted: Vec<(String, bool)> = Vec::new();
        for message in &self.messages {
            let row = videorc_app_core::stream_manager::rows::ManagerRow::new(
                message,
                videorc_app_core::chat::highlight::RowHighlight::default(),
                self.live,
                &self.mention_names,
            );
            for (url, as_gif) in chat_media::media_urls(&row.pieces, &row.gifs) {
                if !self.pictures.contains_key(&url)
                    && !wanted.iter().any(|(existing, _)| existing == &url)
                {
                    wanted.push((url, as_gif));
                }
            }
        }
        if self.pictures.len() + wanted.len() > MEDIA_CACHE {
            let keep: std::collections::HashSet<String> = self
                .messages
                .iter()
                .flat_map(|message| {
                    let row = videorc_app_core::stream_manager::rows::ManagerRow::new(
                        message,
                        videorc_app_core::chat::highlight::RowHighlight::default(),
                        self.live,
                        &self.mention_names,
                    );
                    chat_media::media_urls(&row.pieces, &row.gifs)
                        .into_iter()
                        .map(|(url, _)| url)
                })
                .collect();
            Rc::make_mut(&mut self.pictures).retain(|url, _| keep.contains(url));
        }
        for (url, as_gif) in wanted {
            self.load_picture(url, as_gif, cx);
        }
    }

    fn load_picture(&mut self, url: String, as_gif: bool, cx: &mut Context<Self>) {
        if self.pictures.contains_key(&url) {
            return;
        }
        Rc::make_mut(&mut self.pictures).insert(url.clone(), Picture::Loading);
        let backend = self.studio.backend().clone();
        let remote = url.clone();
        let kind = chat_media::cache_kind_for_url(&remote, as_gif);
        let job = self.runtime.spawn(async move {
            let local = driver::cache_image_as(&*backend, &remote, kind).await?;
            let bytes = images::read_route(&local).await.ok()?;
            Some(chat_media::picture_from_bytes(bytes))
        });
        cx.spawn(async move |this, cx| {
            let picture = job.await.ok().flatten().unwrap_or(Picture::Failed);
            let _ = this.update(cx, |pane, cx| {
                Rc::make_mut(&mut pane.pictures).insert(url, picture);
                cx.notify();
            });
        })
        .detach();
    }

    /// Whether a flagged message can still be removed (P1268).
    pub fn can_remove(&self, message_id: &str) -> bool {
        if !self.live {
            return false;
        }
        let Some(message) = self.messages.iter().find(|m| m.id == message_id) else {
            return false;
        };
        let latest = latest_by_message(&self.operations);
        let operation = latest.get(message_id).copied();
        let requesting = self.requesting.iter().any(|id| id == message_id);
        remove_from_chat_available(message, operation, requesting)
            && removal::remove_from_chat_blocked_reason(message, &self.providers).is_none()
    }

    /// Manual Remove from chat (⋯ menu or Co-host Shift+Backspace): 3 s Undo
    /// toast, then `liveChat.moderation.request`.
    pub fn remove_from_chat(
        &mut self,
        message_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_remove(message_id) || self.requesting.iter().any(|id| id == message_id) {
            return;
        }
        let Some(message) = self.messages.iter().find(|m| m.id == message_id).cloned() else {
            return;
        };
        self.requesting.push(message.id.clone());
        let toast_id = SharedString::from(removal::undo_toast_id(&message.id));
        let title = removal::undo_toast_title(&message.author_name);
        let message_id = message.id.clone();
        let toaster = self.toaster.clone();
        let entity = cx.entity();
        let mut toast = ToastData::new(ToastKind::Plain, title);
        toast.timeout = Some(Some(removal::REMOVE_UNDO));
        toast = toast.action(UNDO, {
            let message_id = message_id.clone();
            let toast_id = toast_id.clone();
            let toaster = toaster.clone();
            let entity = entity.clone();
            move |window, cx| {
                let _ = entity.update(cx, |pane, cx| {
                    pane.requesting.retain(|id| id != &message_id);
                    cx.notify();
                });
                toaster.update(cx, |toaster, cx| toaster.dismiss(&toast_id, window, cx));
            }
        });
        let flush = Rc::new({
            let message_id = message_id.clone();
            let entity = entity.clone();
            move |_: &mut Window, cx: &mut App| {
                let _ = entity.update(cx, |pane, cx| {
                    pane.flush_removal(&message_id, cx);
                });
            }
        });
        toast.on_auto_close = Some(flush.clone());
        toast.on_close = Some(flush);
        self.toaster.update(cx, |toaster, cx| {
            toaster.show(toast_id, toast, window, cx);
        });
        cx.notify();
    }

    fn flush_removal(&mut self, message_id: &str, cx: &mut Context<Self>) {
        if !self.requesting.iter().any(|id| id == message_id) {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let message_id = message_id.to_string();
        let job = {
            let message_id = message_id.clone();
            runtime.spawn(async move { studio.request_chat_removal(&message_id).await })
        };
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |pane, cx| {
                pane.requesting.retain(|id| id != &message_id);
                match result {
                    Ok(Ok(operation)) => {
                        if let Some((kind, text)) = removal_outcome_toast(&operation, false) {
                            let toast_kind = match kind {
                                OutcomeKind::Success => ToastKind::Success,
                                OutcomeKind::Warning => ToastKind::Warning,
                                OutcomeKind::Error => ToastKind::Error,
                                OutcomeKind::Message => ToastKind::Plain,
                            };
                            let id = format!("chat-removal:{}", operation.operation_id);
                            // Outcome toasts go through the notice store on
                            // the main window; the Stream Manager only needs
                            // the row chip from the ledger.
                            let _ = (toast_kind, text, id);
                        }
                    }
                    Ok(Err(error)) => {
                        let toast_id = format!("chat-removal:{message_id}");
                        if let Some(command) = toast_user_error(
                            Failure::Sentence {
                                text: &error.message,
                                warning: false,
                            },
                            REMOVE_THE_MESSAGE,
                            &toast_id,
                        ) {
                            pane.studio.post_notices(vec![command]);
                        }
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
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

    /// A past session's chat (`sessions.comments.history`), read-only: the
    /// renderer's `applyLiveChatSnapshot` over the transcript, in History
    /// mode (`openSessionCommentsWindow`).
    pub fn show_history(
        &mut self,
        session_id: String,
        messages: Vec<LiveChatMessage>,
        cx: &mut Context<Self>,
    ) {
        let mut chat = LiveChat::default();
        chat.apply_snapshot(
            videorc_app_core::chat::model::LiveChatSnapshotWire {
                session_id: Some(session_id),
                providers: Vec::new(),
                messages,
                updated_at: String::new(),
            },
            true,
        );
        self.history = true;
        self.following = true;
        self.apply_live_chat(&chat, cx);
        self.composer = false;
        cx.notify();
    }

    /// Back to live: the Studio's live chat again.
    pub fn leave_history(&mut self, cx: &mut Context<Self>) {
        if !self.history {
            return;
        }
        self.history = false;
        let chat = self.studio.live_chat_now();
        self.apply_live_chat(&chat, cx);
    }

    /// The window's on-air state. The pane's own `live` follows its chat's
    /// session (Electron's chat pane), so this only covers a pane that
    /// has no chat yet.
    pub fn set_live(&mut self, live: bool, cx: &mut Context<Self>) {
        let live = live || (!self.history && self.session_id.is_some());
        if self.live == live {
            return;
        }
        self.live = live;
        self.composer = live && self.can_send && !self.history;
        cx.notify();
    }

    /// Whether a send can go out (writable destinations + a session).
    pub fn can_send(&self) -> bool {
        self.can_send
    }

    fn apply_completion(&mut self, row: &ComposerCompletion, cx: &mut Context<Self>) {
        if row.value == EDIT_CHAT_COMMANDS {
            // Settings → Chat commands waits on that page's driver.
            self.completion_index = 0;
            cx.notify();
            return;
        }
        let value = if matches!(
            row.value,
            "/marker" | "/banner" | "/sound" | "/sidekick" | "/buddy"
        ) {
            format!("{} ", row.value)
        } else {
            row.value.to_string()
        };
        self.pending_draft = Some(value);
        self.completion_index = 0;
        cx.notify();
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

    /// A Sidekick reply or recap lands in the composer (`setPrefill`); the
    /// draft is replaced on the next render.
    pub fn prefill(&mut self, text: String, cx: &mut Context<Self>) {
        self.pending_draft = Some(text);
        cx.notify();
    }

    /// Sidekick's Jump to message: the row comes into view and the list
    /// stops following the newest. Nothing when no shown row is `id`.
    pub fn jump_to(&mut self, id: &str, cx: &mut Context<Self>) {
        let shown = chat_pane_messages(&self.messages, &self.filter, &self.mention_names);
        let Some(index) = shown.iter().position(|message| message.id == id) else {
            return;
        };
        self.following = false;
        self.scroll.scroll_to_item(index);
        cx.notify();
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
            // Questions shows while it is on (Electron also while Sidekick
            // holds open questions, which this pane doesn't read yet).
            .when(questions, |group| {
                group.item(ToggleItem::new("questions", pane::copy::QUESTIONS))
            })
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
            // `PlatformFilter`: each platform is its mark (`ChatPlatformIcon`),
            // named by its label.
            for p in &platforms {
                group = group.item(
                    ToggleItem::new(p.clone(), platform_label(p))
                        .child(
                            videorc_kit::platform_glyph::PlatformMark::new(
                                super::rows::chat_platform(p),
                            )
                            .id(SharedString::from(format!("chat-filter-mark-{p}")))
                            .size(20.),
                        )
                        .chip(true),
                );
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
        if let Some(value) = self.pending_draft.take() {
            self.draft
                .update(cx, |draft, cx| draft.set_value(&value, window, cx));
        }
        if self.settle_scroll > 0 {
            self.settle_scroll -= 1;
            if self.following {
                self.scroll.scroll_to_bottom();
            }
            cx.on_next_frame(window, |_, _, cx| cx.notify());
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
        let completions = composer_completions(&draft);
        if !completions.is_empty() {
            self.completion_index = self.completion_index.min(completions.len() - 1);
        } else {
            self.completion_index = 0;
        }
        let selected = self.completion_index;
        let can_send = self.can_send
            && !self.sending
            && validate_chat_draft(&draft, CHAT_SEND_MAX_CHARS).is_some();
        let filters = self.filters_bar(tier, labels, window, cx);
        let live = self.live;
        let this = cx.entity().downgrade();
        let on_highlight: OnHighlight = {
            let this = this.clone();
            Rc::new(move |id: &str, _: &mut Window, app: &mut App| {
                let id = id.to_string();
                let _ = this.update(app, |pane, cx| pane.press_highlight(&id, cx));
            })
        };
        let on_remove: OnRemove = {
            let this = this.clone();
            Rc::new(move |id: &str, window: &mut Window, app: &mut App| {
                let id = id.to_string();
                let _ = this.update(app, |pane, cx| pane.remove_from_chat(&id, window, cx));
            })
        };
        let highlight = self.highlight.clone();
        let mention_names = self.mention_names.clone();
        let providers = self.providers.clone();
        let latest = latest_by_message(&self.operations);
        let requesting = self.requesting.clone();
        let pictures = self.pictures.clone();
        let completion_scroll = ScrollHandle::new();
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
                        .children(shown.into_iter().map(|message| {
                            let presentation = videorc_app_core::chat::highlight::presentation(
                                &message.id,
                                &highlight.state,
                                highlight.applying_id.as_deref(),
                                highlight.failure.as_ref(),
                            );
                            let operation = latest.get(message.id.as_str()).copied();
                            let in_flight = requesting.iter().any(|id| id == &message.id);
                            chat_row(
                                message,
                                presentation,
                                live,
                                &mention_names,
                                &providers,
                                operation,
                                in_flight,
                                &pictures,
                                on_highlight.clone(),
                                on_remove.clone(),
                            )
                        })),
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
            .flex_1()
            .min_h(px(0.))
            .flex()
            .flex_col()
            .aria_label(CHAT_PANE)
            .child(filters)
            .children(sign_in_rows(&self.sign_in_rows, border, muted))
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
                        )
                        .when(!completions.is_empty(), |composer| {
                            let this = this.clone();
                            let rows = completions.clone();
                            composer.child(
                                CommandList::new("chat-completions", &completion_scroll).children(
                                    rows.into_iter().enumerate().map(|(index, row)| {
                                        let this = this.clone();
                                        let picked = row.clone();
                                        let title = if row.value == EDIT_CHAT_COMMANDS {
                                            "Edit chat commands…".into()
                                        } else {
                                            format!("{}{}", row.value, row.hint)
                                        };
                                        CommandItem::new(
                                            SharedString::from(format!("completion-{index}")),
                                            title,
                                        )
                                        .selected(index == selected)
                                        .on_click(
                                            move |_, _, app| {
                                                let _ = this.update(app, |pane, cx| {
                                                    pane.apply_completion(&picked, cx);
                                                });
                                            },
                                        )
                                    }),
                                ),
                            )
                        }),
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

/// "X chat needs Sign in" and "Sign in to Videorc to read X chat." (P962,
/// `ChatSignInRows`): one quiet row per destination over the chat, never a
/// failure, each with the one button that brings its chat. Sign in to
/// Videorc starts the account sign-in and brings the main window up; Use
/// Sign in opens the destination in Destinations → Setup there.
fn sign_in_rows(
    rows: &[pane::SignInRow],
    border: gpui::Hsla,
    muted: gpui::Hsla,
) -> Option<AnyElement> {
    if rows.is_empty() {
        return None;
    }
    let mut list = div()
        .id("chat-sign-in")
        .flex_none()
        .flex()
        .flex_col()
        .border_b_1()
        .border_color(border)
        .aria_label("Chat that needs a sign-in");
    for row in rows {
        let mut line = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .child(
                div()
                    .min_w(px(0.))
                    .flex_1()
                    .type_scale(videorc_kit::tokens::text::META)
                    .text_color(muted)
                    .child(row.message.clone()),
            );
        let button = Button::new(SharedString::from(format!("chat-sign-in-{}", row.id)))
            .size(ButtonSize::Xs)
            .variant(ButtonVariant::Outline)
            .accessibility_label(row.button_label());
        if row.videorc {
            line = line.child(button.label("Sign in to Videorc").on_click(|_, _, app| {
                crate::app::exit::ExitGuard::show_main_window(app);
                crate::app::accounts::sign_in(app);
            }));
        } else if let Some(target) = row.target_id.clone() {
            line = line.child(button.label("Use Sign in").on_click(move |_, _, app| {
                crate::app::shell::open_destination_in_main(target.clone(), app);
            }));
        }
        list = list.child(line);
    }
    Some(list.into_any_element())
}
