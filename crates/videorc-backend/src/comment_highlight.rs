//! Backend-authoritative livestream comment highlight state.
//!
//! The renderer supplies a pre-rendered PNG, but the backend decides whether
//! that card is eligible for the active livestream, owns its ten-second
//! lifetime, and emits the state that renderers may call "On stream".

use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::captions::CaptionOverlayPosition;
use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::protocol::CompositorState;
use crate::state::AppState;

const COMMENT_HIGHLIGHT_TTL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentHighlightPhase {
    Idle,
    Live,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentHighlightState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub generation: u64,
    pub phase: CommentHighlightPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Default for CommentHighlightState {
    fn default() -> Self {
        Self {
            session_id: None,
            message_id: None,
            generation: 0,
            phase: CommentHighlightPhase::Idle,
            expires_at: None,
            reason: None,
        }
    }
}

pub type CommentHighlightSlot = Arc<Mutex<CommentHighlightState>>;

pub fn new_comment_highlight_slot() -> CommentHighlightSlot {
    Arc::new(Mutex::new(CommentHighlightState::default()))
}

fn default_highlight_position() -> CaptionOverlayPosition {
    CaptionOverlayPosition::Top
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCommentHighlightParams {
    pub session_id: String,
    pub message_id: String,
    pub png_base64: String,
    #[serde(default = "default_highlight_position")]
    pub position: CaptionOverlayPosition,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommentHighlightError {
    #[error("sessionId, messageId, and pngBase64 are required.")]
    InvalidParams,
    #[error("Comment highlighting requires an active livestream.")]
    NotStreaming,
    #[error("The comment belongs to a stale or different livestream session.")]
    WrongSession,
    #[error("The selected comment was not found in the active livestream session.")]
    MessageNotFound,
    #[error("Deleted, system, and moderation events cannot be highlighted.")]
    IneligibleMessage,
    #[error("Comment highlighting is unavailable for this livestream output path.")]
    UnsupportedOutput,
    #[error("The comment highlight image is invalid: {0}")]
    InvalidImage(String),
}

impl CommentHighlightError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidParams => "comments-highlight-invalid",
            Self::NotStreaming => "comments-highlight-not-streaming",
            Self::WrongSession => "comments-highlight-wrong-session",
            Self::MessageNotFound => "comments-highlight-message-not-found",
            Self::IneligibleMessage => "comments-highlight-ineligible-message",
            Self::UnsupportedOutput => "highlight-unavailable",
            Self::InvalidImage(_) => "comments-highlight-invalid",
        }
    }
}

#[derive(Debug, Clone)]
struct HighlightEligibility {
    recording_session_id: Option<String>,
    recording_mode: Option<String>,
    recording_stopping: bool,
    viewer_overlay_available: bool,
    compositor_live: bool,
    chat_session_id: Option<String>,
    message: Option<LiveChatMessage>,
}

fn validate_eligibility(
    params: &SetCommentHighlightParams,
    eligibility: &HighlightEligibility,
) -> Result<(), CommentHighlightError> {
    if params.session_id.trim().is_empty()
        || params.message_id.trim().is_empty()
        || params.png_base64.trim().is_empty()
    {
        return Err(CommentHighlightError::InvalidParams);
    }

    let Some(recording_session_id) = eligibility.recording_session_id.as_deref() else {
        return Err(CommentHighlightError::NotStreaming);
    };
    if recording_session_id != params.session_id {
        return Err(CommentHighlightError::WrongSession);
    }
    if eligibility.recording_stopping
        || !eligibility
            .recording_mode
            .as_deref()
            .is_some_and(|mode| mode.contains("stream"))
    {
        return Err(CommentHighlightError::NotStreaming);
    }
    if !eligibility.viewer_overlay_available || !eligibility.compositor_live {
        return Err(CommentHighlightError::UnsupportedOutput);
    }
    if eligibility.chat_session_id.as_deref() != Some(params.session_id.as_str()) {
        return Err(CommentHighlightError::WrongSession);
    }

    let Some(message) = eligibility.message.as_ref() else {
        return Err(CommentHighlightError::MessageNotFound);
    };
    if message.id != params.message_id || message.session_id != params.session_id {
        return Err(CommentHighlightError::WrongSession);
    }
    if message.is_deleted
        || matches!(
            message.event_type,
            LiveChatEventType::Deleted | LiveChatEventType::System | LiveChatEventType::Moderation
        )
    {
        return Err(CommentHighlightError::IneligibleMessage);
    }
    Ok(())
}

fn next_generation(generation: u64) -> u64 {
    generation.wrapping_add(1).max(1)
}

fn emit_state(state: &AppState, highlight: &CommentHighlightState) {
    state.emit_event("comments.highlight.status", highlight.clone());
}

pub async fn comment_highlight_status(state: &AppState) -> CommentHighlightState {
    state.comment_highlight.lock().await.clone()
}

pub async fn set_comment_highlight(
    state: &AppState,
    params: SetCommentHighlightParams,
) -> Result<CommentHighlightState, CommentHighlightError> {
    set_comment_highlight_with_ttl(state, params, COMMENT_HIGHLIGHT_TTL).await
}

async fn set_comment_highlight_with_ttl(
    state: &AppState,
    params: SetCommentHighlightParams,
    ttl: Duration,
) -> Result<CommentHighlightState, CommentHighlightError> {
    if params.session_id.trim().is_empty()
        || params.message_id.trim().is_empty()
        || params.png_base64.trim().is_empty()
    {
        return Err(CommentHighlightError::InvalidParams);
    }

    let compositor_live = state.compositor.lock().await.status.state == CompositorState::Live;
    let chat = crate::live_chat::current_status(state).await;
    let message = chat
        .messages
        .iter()
        .find(|message| message.id == params.message_id)
        .cloned();

    // Keep the recording guard through installation. stop_recording takes the
    // same recording -> highlight lock order, so a stop cannot clear the old
    // card and then race a new install onto a stopping session.
    let recording = state.recording.lock().await;
    let eligibility = HighlightEligibility {
        recording_session_id: recording.as_ref().map(|active| active.session_id.clone()),
        recording_mode: recording.as_ref().map(|active| active.mode.clone()),
        recording_stopping: recording
            .as_ref()
            .is_some_and(|active| active.stop_requested),
        viewer_overlay_available: recording
            .as_ref()
            .is_some_and(|active| active.comment_highlight_available),
        compositor_live,
        chat_session_id: chat.session_id,
        message,
    };
    validate_eligibility(&params, &eligibility)?;

    let mut highlight = state.comment_highlight.lock().await;
    let snapshot = install_validated_highlight(state, &mut highlight, params, ttl)?;
    let generation = snapshot.generation;
    drop(highlight);
    drop(recording);

    emit_state(state, &snapshot);
    schedule_expiry(state.clone(), generation, ttl);
    Ok(snapshot)
}

/// Install and publish the next live state as one synchronous critical
/// section. `install_caption_overlay` preserves the old pixels on decode
/// failure; returning before state mutation preserves the matching old
/// generation/state as well.
fn install_validated_highlight(
    state: &AppState,
    highlight: &mut CommentHighlightState,
    params: SetCommentHighlightParams,
    ttl: Duration,
) -> Result<CommentHighlightState, CommentHighlightError> {
    crate::captions::install_caption_overlay(
        &state.highlight_overlay,
        &params.png_base64,
        params.position,
    )
    .map_err(|error| CommentHighlightError::InvalidImage(error.to_string()))?;

    let generation = next_generation(highlight.generation);
    let expires_at =
        Utc::now() + ChronoDuration::from_std(ttl).unwrap_or_else(|_| ChronoDuration::seconds(10));
    *highlight = CommentHighlightState {
        session_id: Some(params.session_id),
        message_id: Some(params.message_id),
        generation,
        phase: CommentHighlightPhase::Live,
        expires_at: Some(expires_at.to_rfc3339()),
        reason: None,
    };
    Ok(highlight.clone())
}

fn schedule_expiry(state: AppState, generation: u64, ttl: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        let _ = expire_generation(&state, generation).await;
    })
}

async fn expire_generation(state: &AppState, generation: u64) -> bool {
    let mut highlight = state.comment_highlight.lock().await;
    if highlight.phase != CommentHighlightPhase::Live || highlight.generation != generation {
        return false;
    }

    crate::captions::clear_caption_overlay(&state.highlight_overlay);
    *highlight = CommentHighlightState {
        generation: next_generation(highlight.generation),
        reason: Some("expired".to_string()),
        ..CommentHighlightState::default()
    };
    let snapshot = highlight.clone();
    drop(highlight);
    emit_state(state, &snapshot);
    true
}

async fn clear_internal(
    state: &AppState,
    expected_session_id: Option<&str>,
    expected_message_id: Option<&str>,
    reason: &str,
) -> CommentHighlightState {
    let mut highlight = state.comment_highlight.lock().await;
    if expected_session_id.is_some() && highlight.session_id.as_deref() != expected_session_id {
        return highlight.clone();
    }
    if expected_message_id.is_some() && highlight.message_id.as_deref() != expected_message_id {
        return highlight.clone();
    }

    let overlay_active =
        crate::captions::current_caption_overlay(&state.highlight_overlay).is_some();
    if highlight.phase == CommentHighlightPhase::Idle
        && highlight.session_id.is_none()
        && highlight.message_id.is_none()
        && !overlay_active
    {
        return highlight.clone();
    }

    crate::captions::clear_caption_overlay(&state.highlight_overlay);
    *highlight = CommentHighlightState {
        generation: next_generation(highlight.generation),
        reason: Some(reason.to_string()),
        ..CommentHighlightState::default()
    };
    let snapshot = highlight.clone();
    drop(highlight);
    emit_state(state, &snapshot);
    snapshot
}

/// Explicit user action: clear whichever comment is currently on stream.
pub async fn clear_comment_highlight(state: &AppState) -> CommentHighlightState {
    clear_internal(state, None, None, "cleared").await
}

/// New-session boundary: clear any state or legacy overlay left by the prior
/// session and invalidate its expiry generation.
pub async fn clear_comment_highlight_for_session_start(state: &AppState) -> CommentHighlightState {
    clear_internal(state, None, None, "session-start").await
}

/// End one specific session without letting a late monitor task clear a newer
/// session's highlight.
pub async fn clear_comment_highlight_for_session_end(
    state: &AppState,
    session_id: &str,
) -> CommentHighlightState {
    clear_internal(state, Some(session_id), None, "session-ended").await
}

/// Provider deletion event: remove the overlay only when it still represents
/// this exact message. A late tombstone must not clear a newer selection.
pub async fn clear_comment_highlight_for_message(
    state: &AppState,
    session_id: &str,
    message_id: &str,
) -> CommentHighlightState {
    clear_internal(state, Some(session_id), Some(message_id), "message-deleted").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    use crate::live_chat::LiveChatMessageFragment;
    use crate::storage::Database;
    use crate::streaming::StreamPlatform;

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

    fn message(event_type: LiveChatEventType, is_deleted: bool) -> LiveChatMessage {
        LiveChatMessage {
            id: "session-1:x:x-target:message-1".to_string(),
            provider_message_id: "message-1".to_string(),
            platform: StreamPlatform::X,
            target_id: Some("x-target".to_string()),
            session_id: "session-1".to_string(),
            author_id: Some("viewer-1".to_string()),
            author_name: "Viewer".to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: Vec::new(),
            published_at: "2026-07-10T10:00:00Z".to_string(),
            received_at: "2026-07-10T10:00:00Z".to_string(),
            message_text: "Highlight me".to_string(),
            fragments: Vec::<LiveChatMessageFragment>::new(),
            event_type,
            amount_text: None,
            is_deleted,
            raw_provider_type: Some("x-chat".to_string()),
        }
    }

    fn params() -> SetCommentHighlightParams {
        SetCommentHighlightParams {
            session_id: "session-1".to_string(),
            message_id: "session-1:x:x-target:message-1".to_string(),
            png_base64: TEST_PNG.to_string(),
            position: CaptionOverlayPosition::Top,
        }
    }

    fn eligibility(message: Option<LiveChatMessage>) -> HighlightEligibility {
        HighlightEligibility {
            recording_session_id: Some("session-1".to_string()),
            recording_mode: Some("record+stream".to_string()),
            recording_stopping: false,
            viewer_overlay_available: true,
            compositor_live: true,
            chat_session_id: Some("session-1".to_string()),
            message,
        }
    }

    #[test]
    fn eligibility_requires_live_session_message_and_viewer_compositor_path() {
        assert!(
            validate_eligibility(
                &params(),
                &eligibility(Some(message(LiveChatEventType::Message, false)))
            )
            .is_ok()
        );

        let mut case = eligibility(Some(message(LiveChatEventType::Message, false)));
        case.recording_mode = Some("record".to_string());
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::NotStreaming)
        );

        let mut case = eligibility(Some(message(LiveChatEventType::Message, false)));
        case.recording_session_id = Some("session-2".to_string());
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::WrongSession)
        );

        let mut case = eligibility(Some(message(LiveChatEventType::Message, false)));
        case.viewer_overlay_available = false;
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::UnsupportedOutput)
        );
        assert_eq!(
            CommentHighlightError::UnsupportedOutput.code(),
            "highlight-unavailable"
        );

        let mut case = eligibility(Some(message(LiveChatEventType::Message, false)));
        case.compositor_live = false;
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::UnsupportedOutput)
        );

        let case = eligibility(None);
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::MessageNotFound)
        );
    }

    #[test]
    fn eligibility_rejects_deleted_system_and_moderation_rows() {
        for (event_type, deleted) in [
            (LiveChatEventType::Message, true),
            (LiveChatEventType::Deleted, false),
            (LiveChatEventType::System, false),
            (LiveChatEventType::Moderation, false),
        ] {
            assert_eq!(
                validate_eligibility(&params(), &eligibility(Some(message(event_type, deleted)))),
                Err(CommentHighlightError::IneligibleMessage)
            );
        }
    }

    #[tokio::test]
    async fn off_stream_set_is_rejected_without_installing_or_claiming_live() {
        let state = test_state();
        let error = set_comment_highlight(&state, params()).await.unwrap_err();

        assert_eq!(error, CommentHighlightError::NotStreaming);
        assert_eq!(error.code(), "comments-highlight-not-streaming");
        assert_eq!(
            comment_highlight_status(&state).await,
            CommentHighlightState::default()
        );
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());
    }

    #[tokio::test]
    async fn invalid_replacement_preserves_existing_live_state_and_overlay() {
        let state = test_state();
        crate::captions::install_caption_overlay(
            &state.highlight_overlay,
            TEST_PNG,
            CaptionOverlayPosition::Top,
        )
        .unwrap();
        let previous = CommentHighlightState {
            session_id: Some("session-1".to_string()),
            message_id: Some("message-existing".to_string()),
            generation: 7,
            phase: CommentHighlightPhase::Live,
            expires_at: Some(Utc::now().to_rfc3339()),
            reason: None,
        };
        *state.comment_highlight.lock().await = previous.clone();
        let previous_overlay =
            crate::captions::current_caption_overlay(&state.highlight_overlay).unwrap();

        let mut replacement = params();
        replacement.message_id = "message-new".to_string();
        replacement.png_base64 = "not-an-image".to_string();
        let error = {
            let mut highlight = state.comment_highlight.lock().await;
            install_validated_highlight(&state, &mut highlight, replacement, COMMENT_HIGHLIGHT_TTL)
                .unwrap_err()
        };

        assert!(matches!(error, CommentHighlightError::InvalidImage(_)));
        assert_eq!(comment_highlight_status(&state).await, previous);
        let surviving_overlay =
            crate::captions::current_caption_overlay(&state.highlight_overlay).unwrap();
        assert_eq!(surviving_overlay.revision, previous_overlay.revision);
        assert_eq!(surviving_overlay.width, previous_overlay.width);
        assert_eq!(surviving_overlay.height, previous_overlay.height);
        assert_eq!(surviving_overlay.rgba, previous_overlay.rgba);
    }

    #[tokio::test]
    async fn stale_expiry_cannot_clear_a_newer_highlight_generation() {
        let state = test_state();
        crate::captions::install_caption_overlay(
            &state.highlight_overlay,
            TEST_PNG,
            CaptionOverlayPosition::Top,
        )
        .unwrap();
        *state.comment_highlight.lock().await = CommentHighlightState {
            session_id: Some("session-1".to_string()),
            message_id: Some("message-new".to_string()),
            generation: 2,
            phase: CommentHighlightPhase::Live,
            expires_at: Some(Utc::now().to_rfc3339()),
            reason: None,
        };

        schedule_expiry(state.clone(), 1, Duration::from_millis(5))
            .await
            .unwrap();
        assert_eq!(comment_highlight_status(&state).await.generation, 2);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_some());

        schedule_expiry(state.clone(), 2, Duration::from_millis(5))
            .await
            .unwrap();
        let expired = comment_highlight_status(&state).await;
        assert_eq!(expired.phase, CommentHighlightPhase::Idle);
        assert_eq!(expired.generation, 3);
        assert_eq!(expired.reason.as_deref(), Some("expired"));
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());
    }

    #[tokio::test]
    async fn late_session_end_cannot_clear_a_new_session_highlight() {
        let state = test_state();
        crate::captions::install_caption_overlay(
            &state.highlight_overlay,
            TEST_PNG,
            CaptionOverlayPosition::Top,
        )
        .unwrap();
        *state.comment_highlight.lock().await = CommentHighlightState {
            session_id: Some("session-2".to_string()),
            message_id: Some("message-2".to_string()),
            generation: 4,
            phase: CommentHighlightPhase::Live,
            expires_at: Some(Utc::now().to_rfc3339()),
            reason: None,
        };

        let untouched = clear_comment_highlight_for_session_end(&state, "session-1").await;
        assert_eq!(untouched.phase, CommentHighlightPhase::Live);
        assert_eq!(untouched.generation, 4);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_some());

        let cleared = clear_comment_highlight_for_session_end(&state, "session-2").await;
        assert_eq!(cleared.phase, CommentHighlightPhase::Idle);
        assert_eq!(cleared.generation, 5);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());
    }
}
