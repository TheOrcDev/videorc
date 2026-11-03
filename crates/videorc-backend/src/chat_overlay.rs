//! The chat box on stream (plan 215 G, D5): the last five chat messages,
//! painted by the renderer (`lib/chat-overlay.ts`) and pushed here as a PNG
//! per orientation. The backend holds each in a slot the compositor reads
//! every tick and draws on every leg the overlay layout's `chat` switches
//! carry, the way the comment highlight travels (`comment_highlight.rs`).
//! The backend has no font crate, so no text is drawn here; and the legacy
//! FFmpeg graph carries no chat box, as it carries no highlight card.
//!
//! The box is off by default (it shows viewers' names). Unlike the highlight
//! it has no lifetime and no eligibility of its own: the renderer repaints it
//! when chat changes and clears it when the session ends, and the leg plan
//! decides whether any output draws it.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::captions::{OverlayFallbackPlacement, OverlayPlacement};
use crate::comment_highlight::{CommentHighlightCanvas, CommentHighlightCanvases};
use crate::overlay_layout::{CHAT_DEFAULT_SNAP, OverlayItem, OverlayRect};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatOverlayParams {
    pub png_base64: String,
    /// The chat rect for the horizontal canvas (the overlay layout's
    /// `chat.horizontal`). Missing => the top-left corner snap.
    #[serde(default)]
    pub rect: Option<OverlayRect>,
    /// The box rasterized for the vertical simulcast leg's portrait canvas
    /// (`chat.overlay.canvases`). Missing => the vertical leg streams without
    /// the box.
    #[serde(default)]
    pub vertical_png_base64: Option<String>,
    /// The chat rect for the vertical leg. Missing => the corner snap.
    #[serde(default)]
    pub vertical_rect: Option<OverlayRect>,
}

/// What `chat.overlay.set` and `chat.overlay.clear` answer: the horizontal
/// slot's state and whether a vertical raster is installed beside it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatOverlayInfo {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub revision: u64,
    pub vertical: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChatOverlayError {
    #[error("pngBase64 is required.")]
    InvalidParams,
    #[error("The chat box image is invalid: {0}")]
    InvalidImage(String),
}

impl ChatOverlayError {
    pub fn code(&self) -> &'static str {
        "chat-overlay-invalid"
    }
}

/// Where an installed chat box lands: the streamer's rect, or the default
/// corner when the push carried none.
pub fn chat_overlay_placement(rect: Option<OverlayRect>) -> OverlayPlacement {
    OverlayPlacement::new(
        rect,
        OverlayFallbackPlacement {
            item: OverlayItem::Chat,
            snap: CHAT_DEFAULT_SNAP,
        },
    )
}

struct PreparedChatOverlay {
    horizontal: crate::captions::PreparedCaptionOverlay,
    vertical: Option<crate::captions::PreparedCaptionOverlay>,
}

/// `chat.overlay.set`: decode off the runtime, then one bounded swap per
/// slot. A replacement without a vertical raster clears the vertical slot,
/// so the portrait leg never keeps an older box than the landscape one.
pub async fn set_chat_overlay(
    state: &AppState,
    params: SetChatOverlayParams,
) -> Result<ChatOverlayInfo, ChatOverlayError> {
    if params.png_base64.trim().is_empty() {
        return Err(ChatOverlayError::InvalidParams);
    }
    let png_base64 = params.png_base64;
    let vertical_png_base64 = params
        .vertical_png_base64
        .filter(|value| !value.trim().is_empty());
    let prepared = tokio::task::spawn_blocking(move || {
        let horizontal = crate::captions::prepare_caption_overlay(&png_base64)?;
        let vertical = vertical_png_base64
            .as_deref()
            .map(crate::captions::prepare_caption_overlay)
            .transpose()?;
        anyhow::Ok(PreparedChatOverlay {
            horizontal,
            vertical,
        })
    })
    .await
    .map_err(|error| {
        ChatOverlayError::InvalidImage(format!("overlay preparation task stopped: {error}"))
    })?
    .map_err(|error| ChatOverlayError::InvalidImage(error.to_string()))?;
    Ok(install_prepared_chat_overlay(
        state,
        prepared,
        params.rect,
        params.vertical_rect,
    ))
}

fn install_prepared_chat_overlay(
    state: &AppState,
    prepared: PreparedChatOverlay,
    rect: Option<OverlayRect>,
    vertical_rect: Option<OverlayRect>,
) -> ChatOverlayInfo {
    let info = crate::captions::install_prepared_caption_overlay(
        &state.chat_overlay,
        prepared.horizontal,
        chat_overlay_placement(rect),
    );
    let vertical = match prepared.vertical {
        Some(vertical) => {
            crate::captions::install_prepared_caption_overlay(
                &state.simulcast_chat_overlay,
                vertical,
                chat_overlay_placement(vertical_rect),
            );
            true
        }
        None => {
            crate::captions::clear_caption_overlay(&state.simulcast_chat_overlay);
            false
        }
    };
    ChatOverlayInfo {
        active: true,
        width: info.width,
        height: info.height,
        revision: info.revision,
        vertical,
    }
}

/// `chat.overlay.clear`, and the session boundaries (`recording.rs`): both
/// slots empty. Idempotent.
pub fn clear_chat_overlay(state: &AppState) -> ChatOverlayInfo {
    let info = crate::captions::clear_caption_overlay(&state.chat_overlay);
    crate::captions::clear_caption_overlay(&state.simulcast_chat_overlay);
    ChatOverlayInfo {
        active: false,
        width: 0,
        height: 0,
        revision: info.revision,
        vertical: false,
    }
}

/// `chat.overlay.canvases`: the extra canvas the renderer rasterizes a second
/// box for, the vertical simulcast leg's, while the running session has one.
/// Unlike the highlight's, it does not wait for the chat switch: the box is
/// cheap, and a switch flipped mid-session then lands on the next repaint.
pub async fn chat_overlay_canvases(state: &AppState) -> CommentHighlightCanvases {
    let recording = state.recording.lock().await;
    CommentHighlightCanvases {
        vertical: recording
            .as_ref()
            .and_then(|active| active.simulcast_vertical_canvas)
            .map(|(width, height)| CommentHighlightCanvas { width, height }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_layout::{OverlayOrientation, OverlaySnap, overlay_snap_rect};
    use crate::storage::Database;
    use tokio::sync::broadcast;

    const TEST_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn set_params_take_the_png_alone_and_every_optional_field() {
        let minimal: SetChatOverlayParams =
            serde_json::from_value(serde_json::json!({ "pngBase64": TEST_PNG })).unwrap();
        assert!(minimal.rect.is_none());
        assert!(minimal.vertical_png_base64.is_none());
        assert!(minimal.vertical_rect.is_none());
        let full: SetChatOverlayParams = serde_json::from_value(serde_json::json!({
            "pngBase64": TEST_PNG,
            "rect": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4 },
            "verticalPngBase64": TEST_PNG,
            "verticalRect": { "x": 0.05, "y": 0.1, "w": 0.8, "h": 0.3 },
        }))
        .unwrap();
        assert_eq!(full.rect, Some(OverlayRect::new(0.1, 0.2, 0.3, 0.4)));
        assert_eq!(full.vertical_rect, Some(OverlayRect::new(0.05, 0.1, 0.8, 0.3)));
        assert!(full.vertical_png_base64.is_some());
    }

    #[test]
    fn a_push_without_a_rect_lands_in_the_default_corner_on_each_orientation() {
        let placement = chat_overlay_placement(None);
        assert_eq!(
            placement.rect_for_canvas(1920, 1080),
            overlay_snap_rect(
                OverlayItem::Chat,
                OverlayOrientation::Horizontal,
                OverlaySnap::TopLeft
            )
        );
        assert_eq!(
            placement.rect_for_canvas(1080, 1920),
            overlay_snap_rect(
                OverlayItem::Chat,
                OverlayOrientation::Vertical,
                OverlaySnap::TopLeft
            )
        );
        let placed = chat_overlay_placement(Some(OverlayRect::new(0.6, 0.1, 0.3, 0.5)));
        assert_eq!(
            placed.rect_for_canvas(1920, 1080),
            OverlayRect::new(0.6, 0.1, 0.3, 0.5)
        );
    }

    #[tokio::test]
    async fn set_installs_both_slots_and_a_replacement_without_a_vertical_clears_it() {
        let state = test_state();
        let info = set_chat_overlay(
            &state,
            SetChatOverlayParams {
                png_base64: TEST_PNG.to_string(),
                rect: Some(OverlayRect::new(0.6, 0.1, 0.3, 0.5)),
                vertical_png_base64: Some(TEST_PNG.to_string()),
                vertical_rect: Some(OverlayRect::new(0.1, 0.1, 0.8, 0.3)),
            },
        )
        .await
        .unwrap();
        assert!(info.active && info.vertical);
        assert_eq!((info.width, info.height), (1, 1));
        let horizontal = crate::captions::current_caption_overlay(&state.chat_overlay).unwrap();
        assert_eq!(
            horizontal.blit_rect(1920, 1080),
            OverlayRect::new(0.6, 0.1, 0.3, 0.5)
        );
        let vertical =
            crate::captions::current_caption_overlay(&state.simulcast_chat_overlay).unwrap();
        assert_eq!(
            vertical.blit_rect(1080, 1920),
            OverlayRect::new(0.1, 0.1, 0.8, 0.3)
        );

        let again = set_chat_overlay(
            &state,
            SetChatOverlayParams {
                png_base64: TEST_PNG.to_string(),
                rect: None,
                vertical_png_base64: None,
                vertical_rect: None,
            },
        )
        .await
        .unwrap();
        assert!(again.active && !again.vertical);
        assert!(again.revision > info.revision, "revisions never go back");
        assert!(crate::captions::current_caption_overlay(&state.chat_overlay).is_some());
        assert!(
            crate::captions::current_caption_overlay(&state.simulcast_chat_overlay).is_none(),
            "a replacement without a portrait raster leaves no stale box on the vertical leg"
        );

        let cleared = clear_chat_overlay(&state);
        assert!(!cleared.active && !cleared.vertical);
        assert!(crate::captions::current_caption_overlay(&state.chat_overlay).is_none());
        assert_eq!(clear_chat_overlay(&state).revision, 0, "idempotent");
    }

    #[tokio::test]
    async fn set_refuses_an_empty_or_undecodable_image_and_keeps_the_box() {
        let state = test_state();
        assert_eq!(
            set_chat_overlay(
                &state,
                SetChatOverlayParams {
                    png_base64: "  ".to_string(),
                    rect: None,
                    vertical_png_base64: None,
                    vertical_rect: None,
                },
            )
            .await
            .unwrap_err(),
            ChatOverlayError::InvalidParams
        );
        set_chat_overlay(
            &state,
            SetChatOverlayParams {
                png_base64: TEST_PNG.to_string(),
                rect: None,
                vertical_png_base64: None,
                vertical_rect: None,
            },
        )
        .await
        .unwrap();
        let before = crate::captions::current_caption_overlay(&state.chat_overlay).unwrap();
        let error = set_chat_overlay(
            &state,
            SetChatOverlayParams {
                png_base64: "not-an-image".to_string(),
                rect: None,
                vertical_png_base64: None,
                vertical_rect: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ChatOverlayError::InvalidImage(_)));
        assert_eq!(error.code(), "chat-overlay-invalid");
        let after = crate::captions::current_caption_overlay(&state.chat_overlay).unwrap();
        assert_eq!(after.revision, before.revision, "a bad push changes nothing");
    }

    #[tokio::test]
    async fn canvases_name_the_vertical_simulcast_leg_only_while_a_session_has_one() {
        let state = test_state();
        assert_eq!(
            chat_overlay_canvases(&state).await,
            CommentHighlightCanvases::default()
        );
        let mut active = crate::recording::test_active_recording_stub("session-1");
        active.simulcast_vertical_canvas = Some((1080, 1920));
        *state.recording.lock().await = Some(active);
        assert_eq!(
            chat_overlay_canvases(&state).await,
            CommentHighlightCanvases {
                vertical: Some(CommentHighlightCanvas {
                    width: 1080,
                    height: 1920
                }),
            }
        );
    }
}
