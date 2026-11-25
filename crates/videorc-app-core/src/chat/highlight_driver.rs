//! A click that puts a chat message on stream, or takes it off (plan 260
//! Phase 3, P195): Electron's `toggleCommentHighlight` and
//! `applyCommentHighlight` (`hooks/use-studio.tsx`), and the
//! `comments.highlight.status` push that mirrors the backend's card.
//!
//! The backend owns the card and `On stream`. A surface owns only the click
//! in flight ("Applying…"), its intent (a newer click wins), and a failure's
//! reason for [`super::highlight::FAILURE_SHOWN_FOR`]. [`ChatHighlight`] is
//! that state, pure; [`send`] is the request it asks for, run on the client's
//! runtime.
//!
//! Not here yet: the Stream Manager's corner pick (`highlightAnchor`, only
//! the fallback when the overlay layout has no rect), the remotes' and
//! Sidekick's highlight requests, the Activity auto-show and the milestone
//! card. They join when their surfaces drive this state.

use serde_json::{Value, json};

use super::highlight::{self, HighlightFailure, copy};
use super::model::{CommentHighlightPhase, CommentHighlightState, LiveChatMessage};
use super::view::HighlightInput;
use crate::client::RpcError;
use crate::client::codes::REQUEST_OUTCOME_UNKNOWN;
use crate::livestream::{plan, targets};
use crate::studio::StudioBackend;

/// The backend's card as it changes.
pub const STATUS_EVENT: &str = "comments.highlight.status";
pub const STATUS_METHOD: &str = "comments.highlight.status";
pub const SET_METHOD: &str = "comments.highlight.set";
pub const CLEAR_METHOD: &str = "comments.highlight.clear";
/// `cacheChatAvatar`: a chat image cached for the card or a row.
pub const IMAGE_CACHE_METHOD: &str = "chatImages.cache";

/// The talk-show room's program canvas: the card is drawn for it while the
/// room is open (`cloudStatus.room.phase === 'open'`).
pub const ROOM_CANVAS: (u32, u32) = (1920, 1080);

/// Where the backend draws the card: the stream canvas, and the streamer's
/// placement on each orientation (plan 164).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HighlightCanvas {
    pub width: u32,
    pub height: u32,
    /// `overlayLayout.highlight[orientation of the canvas]`.
    pub rect: Option<Value>,
    /// `overlayLayout.highlight.vertical`: the vertical leg's card.
    pub vertical_rect: Option<Value>,
}

/// `streamOutputVideoSettings(captureConfig.video, streamEnabled ?
/// streaming : undefined)`, or the room's canvas, with the highlight's rects
/// from `overlays.layout.get` when it has been read.
pub fn highlight_canvas(
    capture: &Value,
    room_open: bool,
    overlay_layout: Option<&Value>,
) -> HighlightCanvas {
    let (width, height) = if room_open {
        ROOM_CANVAS
    } else {
        let recording = plan::recording_video(capture);
        let all = targets::targets(capture);
        let mut streaming = plan::streaming_of(capture, &all);
        if capture["streamEnabled"].as_bool() != Some(true) {
            streaming.enabled = false;
        }
        let video = plan::stream_output_video(&recording, &streaming);
        (video.width, video.height)
    };
    // `overlayOrientationForCanvas`.
    let orientation = if height > width {
        "vertical"
    } else {
        "horizontal"
    };
    let rect_of = |orientation: &str| {
        overlay_layout
            .map(|layout| &layout["highlight"][orientation])
            .filter(|rect| rect.is_object())
            .cloned()
    };
    HighlightCanvas {
        width,
        height,
        rect: rect_of(orientation),
        vertical_rect: rect_of("vertical"),
    }
}

/// `comments.highlight.set`'s params: the backend draws the card from the
/// message it holds, for this canvas, inside the streamer's rect.
pub fn set_params(session_id: &str, message_id: &str, canvas: &HighlightCanvas) -> Value {
    let mut params = json!({
        "sessionId": session_id,
        "messageId": message_id,
        "canvasWidth": canvas.width,
        "canvasHeight": canvas.height,
    });
    if let Some(rect) = &canvas.rect {
        params["rect"] = rect.clone();
    }
    if let Some(rect) = &canvas.vertical_rect {
        params["verticalRect"] = rect.clone();
    }
    params
}

/// What a click asks the backend for.
#[derive(Debug, Clone, PartialEq)]
pub enum HighlightRequest {
    /// The row on stream: take it off.
    Clear,
    /// Show it: cache the card's images (within the budget), then set.
    Set { params: Value, warm: Vec<String> },
}

/// One click, ready to send.
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightClick {
    pub intent: u64,
    pub session_id: String,
    pub message_id: String,
    pub request: HighlightRequest,
}

/// The highlight as a surface holds it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatHighlight {
    /// The backend's card.
    pub state: CommentHighlightState,
    /// The click on its way.
    pub applying_id: Option<String>,
    /// The last failure, for its five seconds.
    pub failure: Option<HighlightFailure>,
    intent: u64,
    failure_mark: u64,
}

impl ChatHighlight {
    /// What the rows read.
    pub fn input(&self) -> HighlightInput<'_> {
        HighlightInput {
            state: &self.state,
            applying_id: self.applying_id.as_deref(),
            failure: self.failure.as_ref(),
        }
    }

    /// `toggleCommentHighlight`: a new intent clears the last failure. A
    /// message from another livestream fails at once (the answer is the
    /// failure's mark, for [`Self::expire_failure`]); otherwise the row
    /// applies, and a click on the row on stream takes it off.
    pub fn click(
        &mut self,
        message: &LiveChatMessage,
        session_id: Option<&str>,
        canvas: &HighlightCanvas,
    ) -> Result<HighlightClick, u64> {
        self.intent += 1;
        self.failure = None;
        let Some(session_id) = session_id.filter(|session| *session == message.session_id) else {
            return Err(self.fail(&message.id, copy::WRONG_LIVESTREAM));
        };
        self.applying_id = Some(message.id.clone());
        let on_stream = self.state.phase == CommentHighlightPhase::Live
            && self.state.message_id.as_deref() == Some(message.id.as_str());
        let request = if on_stream {
            HighlightRequest::Clear
        } else {
            HighlightRequest::Set {
                params: set_params(session_id, &message.id, canvas),
                warm: highlight::card_image_urls(message),
            }
        };
        Ok(HighlightClick {
            intent: self.intent,
            session_id: session_id.to_string(),
            message_id: message.id.clone(),
            request,
        })
    }

    /// The click's answer. A newer click owns the row, so a stale answer
    /// changes nothing. A failure answers its mark.
    pub fn settle(
        &mut self,
        intent: u64,
        message_id: &str,
        outcome: Result<CommentHighlightState, String>,
    ) -> Option<u64> {
        if intent != self.intent {
            return None;
        }
        self.applying_id = None;
        match outcome {
            Ok(state) => {
                self.failure = None;
                self.state = state;
                None
            }
            Err(reason) => Some(self.fail(message_id, &reason)),
        }
    }

    /// `comments.highlight.status`: the backend's card, and no click in
    /// flight any more.
    pub fn status(&mut self, state: CommentHighlightState) {
        self.state = state;
        self.applying_id = None;
    }

    /// The status read after a failure: the truth, whatever the intent.
    pub fn authoritative(&mut self, state: CommentHighlightState) {
        self.state = state;
    }

    /// The failure's five seconds are up; a newer failure keeps its own.
    pub fn expire_failure(&mut self, mark: u64) -> bool {
        if mark != self.failure_mark || self.failure.is_none() {
            return false;
        }
        self.failure = None;
        true
    }

    fn fail(&mut self, message_id: &str, reason: &str) -> u64 {
        self.failure = Some(HighlightFailure {
            message_id: message_id.to_string(),
            reason: reason.to_string(),
        });
        self.failure_mark += 1;
        self.failure_mark
    }
}

/// `error instanceof Error ? error.message : 'Highlight failed.'`.
pub fn failure_reason(error: &RpcError) -> String {
    let message = error.message.trim();
    if message.is_empty() {
        copy::HIGHLIGHT_FAILED.to_string()
    } else {
        message.to_string()
    }
}

fn read_state(value: Value) -> Option<CommentHighlightState> {
    serde_json::from_value(value).ok()
}

/// `comments.highlight.status`, read again.
pub async fn read_status<B: StudioBackend>(backend: &B) -> Option<CommentHighlightState> {
    backend
        .chat_request(STATUS_METHOD, Value::Null)
        .await
        .ok()
        .and_then(read_state)
}

/// The status within the reconciliation deadline, after a request whose
/// outcome is unknown.
async fn reconcile<B: StudioBackend>(backend: &B) -> Option<CommentHighlightState> {
    tokio::time::timeout(highlight::RECONCILIATION, read_status(backend))
        .await
        .ok()
        .flatten()
}

/// `cacheChatAvatar(url)`: this run's loopback URL for a chat image, or
/// none for one the allowlist refuses.
pub async fn cache_image<B: StudioBackend>(backend: &B, url: &str) -> Option<String> {
    backend
        .chat_request(IMAGE_CACHE_METHOD, json!({ "url": url, "kind": "avatar" }))
        .await
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
}

/// `warmChatImages`: the card's files cached first, within the budget; the
/// card draws without the ones that miss it.
async fn warm<B: StudioBackend>(backend: &B, urls: &[String]) {
    if urls.is_empty() {
        return;
    }
    let all = futures_util::future::join_all(urls.iter().map(|url| cache_image(backend, url)));
    let _ = tokio::time::timeout(highlight::IMAGE_WARM_BUDGET, all).await;
}

/// Runs one click: set or clear, with Electron's reconciliation when the
/// outcome is unknown. The error is the row's reason.
pub async fn send<B: StudioBackend>(
    backend: &B,
    click: &HighlightClick,
) -> Result<CommentHighlightState, String> {
    let unread = || copy::HIGHLIGHT_FAILED.to_string();
    match &click.request {
        HighlightRequest::Clear => match backend.chat_request(CLEAR_METHOD, Value::Null).await {
            Ok(value) => read_state(value).ok_or_else(unread),
            Err(error) => {
                if error.code != REQUEST_OUTCOME_UNKNOWN {
                    return Err(failure_reason(&error));
                }
                match reconcile(backend).await {
                    Some(state) if highlight::clear_reconciles(Some(&state)) => Ok(state),
                    _ => Err(failure_reason(&error)),
                }
            }
        },
        HighlightRequest::Set { params, warm: urls } => {
            warm(backend, urls).await;
            match backend.chat_request(SET_METHOD, params.clone()).await {
                Ok(value) => read_state(value).ok_or_else(unread),
                Err(error) => {
                    if error.code != REQUEST_OUTCOME_UNKNOWN {
                        return Err(failure_reason(&error));
                    }
                    match reconcile(backend).await {
                        Some(state)
                            if highlight::set_reconciles(
                                Some(&state),
                                &click.session_id,
                                &click.message_id,
                            ) =>
                        {
                            Ok(state)
                        }
                        _ => Err(failure_reason(&error)),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, session: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: id.into(),
            session_id: session.into(),
            platform: "youtube".into(),
            author_name: "Ada".into(),
            author_avatar_url: Some("https://yt3.ggpht.com/a.png".into()),
            message_text: "Ship it!".into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        }
    }

    fn live(id: &str) -> CommentHighlightState {
        CommentHighlightState {
            session_id: Some("s".into()),
            message_id: Some(id.into()),
            generation: 3,
            phase: CommentHighlightPhase::Live,
            ..CommentHighlightState::default()
        }
    }

    fn canvas() -> HighlightCanvas {
        HighlightCanvas {
            width: 1920,
            height: 1080,
            ..HighlightCanvas::default()
        }
    }

    #[test]
    fn a_click_shows_a_row_and_a_click_on_the_live_row_takes_it_off() {
        let mut highlight = ChatHighlight::default();
        let click = highlight
            .click(&message("m1", "s"), Some("s"), &canvas())
            .unwrap();
        assert_eq!(highlight.applying_id.as_deref(), Some("m1"));
        let HighlightRequest::Set { params, warm } = &click.request else {
            panic!("a row off stream is set");
        };
        assert_eq!(
            params,
            &json!({
                "sessionId": "s",
                "messageId": "m1",
                "canvasWidth": 1920,
                "canvasHeight": 1080,
            })
        );
        assert_eq!(warm, &["https://yt3.ggpht.com/a.png".to_string()]);
        assert_eq!(highlight.settle(click.intent, "m1", Ok(live("m1"))), None);
        assert_eq!(highlight.applying_id, None);
        assert_eq!(highlight.state, live("m1"));

        let off = highlight
            .click(&message("m1", "s"), Some("s"), &canvas())
            .unwrap();
        assert_eq!(off.request, HighlightRequest::Clear);
    }

    #[test]
    fn a_message_from_another_livestream_fails_on_its_row() {
        let mut highlight = ChatHighlight::default();
        let mark = highlight
            .click(&message("m1", "old"), Some("s"), &canvas())
            .unwrap_err();
        assert_eq!(highlight.applying_id, None);
        assert_eq!(
            highlight.failure,
            Some(HighlightFailure {
                message_id: "m1".into(),
                reason: "That message doesn't belong to the active livestream.".into(),
            })
        );
        assert!(highlight.expire_failure(mark));
        assert_eq!(highlight.failure, None);
        // Between livestreams nothing goes on stream.
        assert!(
            highlight
                .click(&message("m1", "s"), None, &canvas())
                .is_err()
        );
    }

    #[test]
    fn a_newer_click_wins_and_a_failure_keeps_its_own_five_seconds() {
        let mut highlight = ChatHighlight::default();
        let first = highlight
            .click(&message("m1", "s"), Some("s"), &canvas())
            .unwrap();
        let second = highlight
            .click(&message("m2", "s"), Some("s"), &canvas())
            .unwrap();
        // The first answer is stale: the second row still applies.
        assert_eq!(highlight.settle(first.intent, "m1", Ok(live("m1"))), None);
        assert_eq!(highlight.applying_id.as_deref(), Some("m2"));
        let mark = highlight
            .settle(second.intent, "m2", Err("Highlight failed.".into()))
            .unwrap();
        assert_eq!(highlight.applying_id, None);
        assert_eq!(highlight.failure.as_ref().unwrap().message_id, "m2");
        // A newer failure outlives the older one's timer.
        let third = highlight
            .click(&message("m3", "s"), Some("s"), &canvas())
            .unwrap();
        let newer = highlight
            .settle(third.intent, "m3", Err("Highlight failed.".into()))
            .unwrap();
        assert!(!highlight.expire_failure(mark));
        assert!(highlight.expire_failure(newer));
    }

    #[test]
    fn the_status_push_is_the_card_and_ends_the_click() {
        let mut highlight = ChatHighlight::default();
        highlight
            .click(&message("m1", "s"), Some("s"), &canvas())
            .unwrap();
        highlight.status(live("m1"));
        assert_eq!(highlight.applying_id, None);
        assert_eq!(highlight.input().state, &live("m1"));
    }

    #[test]
    fn the_card_is_drawn_for_the_stream_canvas_inside_the_streamers_rect() {
        let rect = json!({ "x": 0.02, "y": 0.7, "w": 0.4, "h": 0.2 });
        let tall = json!({ "x": 0.05, "y": 0.6, "w": 0.9, "h": 0.2 });
        let layout =
            json!({ "highlight": { "horizontal": rect.clone(), "vertical": tall.clone() } });
        let capture = json!({ "video": { "width": 2560, "height": 1440 } });
        // Not streaming: the recording's canvas.
        let canvas = highlight_canvas(&capture, false, Some(&layout));
        assert_eq!((canvas.width, canvas.height), (2560, 1440));
        assert_eq!(canvas.rect.as_ref(), Some(&rect));
        assert_eq!(canvas.vertical_rect.as_ref(), Some(&tall));
        // The room's program is 1080p.
        let room = highlight_canvas(&capture, true, None);
        assert_eq!((room.width, room.height), ROOM_CANVAS);
        assert_eq!(room.rect, None);
        // A portrait canvas takes the vertical rect.
        let portrait = json!({ "video": { "width": 1080, "height": 1920 } });
        let canvas = highlight_canvas(&portrait, false, Some(&layout));
        assert_eq!(canvas.rect.as_ref(), Some(&tall));
        let params = set_params("s", "m1", &canvas);
        assert_eq!(params["rect"], tall);
        assert_eq!(params["verticalRect"], tall);
    }

    #[test]
    fn a_failure_reads_as_the_backends_words_or_highlight_failed() {
        let error = RpcError::new(SET_METHOD, "invalid-params", "  No such message.  ");
        assert_eq!(failure_reason(&error), "No such message.");
        let blank = RpcError::new(SET_METHOD, "internal", " ");
        assert_eq!(failure_reason(&blank), "Highlight failed.");
    }
}
