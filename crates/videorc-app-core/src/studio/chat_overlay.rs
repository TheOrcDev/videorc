//! Chat on stream (plan 215 G, D5) on the Studio: Electron's
//! `createChatOverlayDriver` (`lib/chat-overlay.ts`) and its wiring in
//! `use-studio.tsx` (the `chatOverlayOn` effect). The pure half (which
//! messages, the signature, the images, the switches) is
//! [`crate::chat::overlay`]; this is the driver that tells the backend.
//!
//! While a livestream or a recording is on air and one of the chat box's
//! switches is on (`overlays.layout`'s `chat.showOnStream` /
//! `chat.showInRecording`), the box follows chat: `chat.overlay.set` names
//! the newest five eligible messages of this livestream, oldest first, with
//! the canvas and the streamer's rect, and the backend draws the box (since
//! plan 260 S1.2 it paints from the messages; the app never rasterizes). It
//! repaints at most twice a second ([`overlay::REPAINT`]), never the same
//! box twice, and clears (`chat.overlay.clear`) when chat empties, both
//! switches go off or the session ends. The vertical leg's canvas is read
//! once per livestream (`chat.overlay.canvases`). A failed push is logged and
//! retried on the next change. The box's avatars and emotes are cached first
//! (`chatImages.cache`), for at most [`WARM_DEADLINE`], so the backend draws
//! them from its cache.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use videorc_protocol::RecordingState;

use super::session::session_is_live;
use super::{Connection, Studio, StudioBackend, StudioSnapshot};
use crate::chat::LiveChat;
use crate::chat::highlight_driver::{cache_image, highlight_canvas};
use crate::chat::model::LiveChatMessage;
use crate::chat::overlay::{self, Canvas, methods};

/// `COMMENTS_HIGHLIGHT_TIMING_CONTRACT.avatarFetchMs`: how long the box
/// waits for its images before the backend draws it anyway (a file not
/// cached in time draws the monogram or the emote's name).
pub const WARM_DEADLINE: Duration = Duration::from_millis(4_000);

/// The driver's memory, apart from the Studio's state.
#[derive(Debug, Default)]
pub(super) struct ChatOverlayState {
    /// `overlays.layout`, as last read or pushed; `None` until read on this
    /// connection.
    layout: Option<Value>,
    /// `overlays.layout.get` was asked on this connection (once: the push
    /// keeps it current, and a failed read never repeats every pass).
    layout_asked: bool,
    /// The box is on stream.
    installed: bool,
    /// What the box on stream was painted from.
    painted: Option<String>,
    /// `chat.overlay.canvases`, read once per livestream.
    canvases: Option<(String, Option<Canvases>)>,
}

impl ChatOverlayState {
    /// A new connection: its backend holds no box and may hold another
    /// layout.
    pub(super) fn forget_connection(&mut self) {
        *self = Self::default();
    }
}

/// `ChatOverlayCanvases`: the canvases the session's legs draw on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Canvases {
    pub horizontal: Option<(u64, u64)>,
    pub vertical: Option<(u64, u64)>,
}

impl Canvases {
    /// `chat.overlay.canvases`'s answer.
    pub fn read(answer: &Value) -> Self {
        let size = |key: &str| {
            let canvas = answer.get(key)?;
            Some((
                canvas.get("width")?.as_u64()?,
                canvas.get("height")?.as_u64()?,
            ))
        };
        Self {
            horizontal: size("horizontal"),
            vertical: size("vertical"),
        }
    }
}

/// The output facts are fresh (the backend is connected) and a livestream
/// or a recording is on air (`outputSessionFacts`' `live || recording`,
/// never a Clips ring's replay-only session).
pub fn on_air(snapshot: &StudioSnapshot) -> bool {
    let connected = matches!(snapshot.connection, Connection::Connected { .. });
    let status = &snapshot.session.status;
    let owns = snapshot.session.phase.is_active() && !status.replay_only;
    let recording = owns && status.state == RecordingState::Recording;
    let live = !status.replay_only && session_is_live(status);
    connected && (live || recording)
}

/// `chatOverlayOn` (`use-studio.tsx`): [`on_air`], and one of the box's
/// switches is on.
pub fn overlay_on(snapshot: &StudioSnapshot, layout: Option<&Value>) -> bool {
    on_air(snapshot) && overlay::switched_on(layout)
}

/// The rect the streamer placed the box at for `orientation`, when the
/// layout has one.
fn rect_of(layout: Option<&Value>, orientation: &str) -> Option<Value> {
    layout
        .map(|layout| &layout["chat"][orientation])
        .filter(|rect| rect.is_object())
        .cloned()
}

/// What one paint sends: the landscape canvas with its rect, and the
/// vertical leg's rect when the session has that leg.
#[derive(Debug, Clone, PartialEq)]
pub struct Paint {
    pub stream: Canvas,
    pub vertical: Option<Canvas>,
}

/// The canvases a paint lands on: the session's landscape canvas (the
/// stream settings' when the session names none), the rect for its
/// orientation, and the vertical leg's canvas and rect.
pub fn paint_of(
    canvases: Option<&Canvases>,
    fallback: (u64, u64),
    layout: Option<&Value>,
) -> Paint {
    let (width, height) = canvases
        .and_then(|canvases| canvases.horizontal)
        .unwrap_or(fallback);
    // `overlayOrientationForCanvas`.
    let orientation = if height > width {
        "vertical"
    } else {
        "horizontal"
    };
    let stream = Canvas {
        width,
        height,
        rect: rect_of(layout, orientation).unwrap_or(Value::Null),
    };
    let vertical = canvases
        .and_then(|canvases| canvases.vertical)
        .map(|(width, height)| Canvas {
            width,
            height,
            rect: rect_of(layout, "vertical").unwrap_or(Value::Null),
        });
    Paint { stream, vertical }
}

/// `chat.overlay.set`'s params, as Electron sends them: the messages, oldest
/// first, the landscape canvas, its rect, and the vertical leg's rect when
/// the session has that leg. A rect the layout lacks is left out (the
/// backend falls back to the corner snap).
pub fn set_params(messages: &[&LiveChatMessage], paint: &Paint) -> Value {
    let mut params = json!({
        "messageIds": messages.iter().map(|message| message.id.as_str()).collect::<Vec<_>>(),
        "canvasWidth": paint.stream.width,
        "canvasHeight": paint.stream.height,
    });
    if paint.stream.rect.is_object() {
        params["rect"] = paint.stream.rect.clone();
    }
    if let Some(vertical) = &paint.vertical
        && vertical.rect.is_object()
    {
        params["verticalRect"] = vertical.rect.clone();
    }
    params
}

impl<B: StudioBackend> Studio<B> {
    fn chat_overlay_lock(&self) -> std::sync::MutexGuard<'_, ChatOverlayState> {
        self.chat_overlay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A new connection (or none): its backend holds no box, and the layout
    /// is read again.
    pub(super) fn forget_chat_overlay_connection(&self) {
        self.chat_overlay_lock().forget_connection();
        self.chat_overlay_kick.notify_one();
    }

    /// `overlays.layout`: the layout the backend pushed.
    pub(super) fn set_chat_overlay_layout(&self, layout: Value) {
        self.chat_overlay_lock().layout = Some(layout);
        self.chat_overlay_kick.notify_one();
    }

    /// The overlay layout as last read or pushed on this connection, else
    /// read now (`overlayLayoutRef.current`, for a remote's comment card).
    pub(super) async fn current_overlay_layout(&self) -> Option<Value> {
        let held = self.chat_overlay_lock().layout.clone();
        if held.is_some() {
            return held;
        }
        self.overlay_layout().await.ok()
    }

    /// Follows the session, chat and the layout, one pass at most every
    /// [`overlay::REPAINT`]: the first change at once, the rest folded into
    /// one pass at the interval's end. [`Self::drive`] runs it.
    pub(super) async fn drive_chat_overlay(self: &Arc<Self>) {
        let mut snapshots = self.snapshot.subscribe();
        let mut chat = self.live_chat_tx.subscribe();
        let mut last_start: Option<Instant> = None;
        loop {
            tokio::select! {
                changed = snapshots.changed() => if changed.is_err() { return },
                changed = chat.changed() => if changed.is_err() { return },
                () = self.chat_overlay_kick.notified() => {}
            }
            if let Some(started) = last_start {
                let due = started + overlay::REPAINT;
                if due > Instant::now() {
                    tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await;
                }
            }
            last_start = Some(Instant::now());
            snapshots.borrow_and_update();
            chat.borrow_and_update();
            self.chat_overlay_pass().await;
        }
    }

    /// One pass of `createChatOverlayDriver`'s `run`. Never holds a lock
    /// across a request. A test without a driver calls it.
    #[doc(hidden)]
    pub async fn chat_overlay_pass(&self) {
        let snapshot = self.snapshot();
        // The layout is read once per connection, only once something is on
        // air; `overlays.layout` keeps it current after that.
        let ask = on_air(&snapshot) && {
            let mut state = self.chat_overlay_lock();
            let ask = state.layout.is_none() && !state.layout_asked;
            state.layout_asked |= ask;
            ask
        };
        if ask {
            if let Ok(layout) = self.overlay_layout().await {
                let mut state = self.chat_overlay_lock();
                if state.layout.is_none() {
                    state.layout = Some(layout);
                }
            }
        }
        let layout = self.chat_overlay_lock().layout.clone();
        let live_chat: LiveChat = self.live_chat_tx.borrow().clone();
        let on = overlay_on(&snapshot, layout.as_ref());
        let session_id = live_chat.session_id.clone();
        let messages: Vec<&LiveChatMessage> = if on {
            overlay::messages(
                live_chat.messages.iter().map(|message| message.as_ref()),
                session_id.as_deref(),
            )
        } else {
            Vec::new()
        };
        let Some(session_id) = session_id.filter(|_| !messages.is_empty()) else {
            if !self.chat_overlay_lock().installed {
                return;
            }
            match self.backend.chat_request(methods::CLEAR, json!({})).await {
                Ok(_) => {
                    let mut state = self.chat_overlay_lock();
                    state.installed = false;
                    state.painted = None;
                }
                Err(error) => self.config.logger.warn(format!(
                    "Chat on stream: the box did not clear ({}).",
                    error.message
                )),
            }
            return;
        };
        let known = {
            let state = self.chat_overlay_lock();
            state
                .canvases
                .as_ref()
                .filter(|(read_for, _)| *read_for == session_id)
                .map(|(_, canvases)| *canvases)
        };
        let canvases = match known {
            Some(canvases) => canvases,
            None => {
                let read = self
                    .backend
                    .chat_request(methods::CANVASES, json!({}))
                    .await
                    .ok()
                    .map(|answer| Canvases::read(&answer));
                self.chat_overlay_lock().canvases = Some((session_id.clone(), read));
                read
            }
        };
        let fallback = {
            let canvas = highlight_canvas(&snapshot.settings.capture_doc, false, None);
            (u64::from(canvas.width), u64::from(canvas.height))
        };
        let paint = paint_of(canvases.as_ref(), fallback, layout.as_ref());
        let signature = overlay::signature(&messages, &paint.stream, paint.vertical.as_ref());
        if self.chat_overlay_lock().painted.as_deref() == Some(signature.as_str()) {
            return;
        }
        // The backend reads its chat image cache and never fetches.
        let urls = overlay::image_urls(&messages);
        if !urls.is_empty() {
            let warm = futures_util::future::join_all(
                urls.iter().map(|url| cache_image(&*self.backend, url)),
            );
            let _ = tokio::time::timeout(WARM_DEADLINE, warm).await;
        }
        let params = set_params(&messages, &paint);
        match self.backend.chat_request(methods::SET, params).await {
            Ok(_) => {
                let mut state = self.chat_overlay_lock();
                state.installed = true;
                state.painted = Some(signature);
            }
            Err(error) => self.config.logger.warn(format!(
                "Chat on stream: the box did not reach the stream ({}).",
                error.message
            )),
        }
    }
}

#[cfg(test)]
#[path = "chat_overlay_tests.rs"]
mod tests;
