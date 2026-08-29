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
use crate::live_chat::HighlightMessageEligibility;
#[cfg(test)]
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
    #[cfg(test)]
    #[serde(skip)]
    preparation_blocker: Option<CommentHighlightPreparationBlocker>,
    #[cfg(test)]
    #[serde(skip)]
    commit_blocker: Option<CommentHighlightCommitBlocker>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct CommentHighlightPreparationBlocker {
    entered: Arc<std::sync::atomic::AtomicBool>,
    release: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

#[cfg(test)]
impl CommentHighlightPreparationBlocker {
    fn new() -> Self {
        Self {
            entered: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            release: Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
        }
    }

    fn block(&self) {
        use std::sync::atomic::Ordering;

        self.entered.store(true, Ordering::Release);
        let (release, condition) = &*self.release;
        let mut released = release
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*released {
            released = condition
                .wait(released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn entered(&self) -> bool {
        self.entered.load(std::sync::atomic::Ordering::Acquire)
    }

    fn release(&self) {
        let (release, condition) = &*self.release;
        *release
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        condition.notify_all();
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct CommentHighlightCommitBlocker {
    entered: Arc<std::sync::atomic::AtomicBool>,
    released: Arc<std::sync::atomic::AtomicBool>,
    release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
impl CommentHighlightCommitBlocker {
    fn new() -> Self {
        Self {
            entered: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            released: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            release: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn block(&self) {
        use std::sync::atomic::Ordering;

        self.entered.store(true, Ordering::Release);
        while !self.released.load(Ordering::Acquire) {
            self.release.notified().await;
        }
    }

    fn entered(&self) -> bool {
        self.entered.load(std::sync::atomic::Ordering::Acquire)
    }

    fn release(&self) {
        self.released
            .store(true, std::sync::atomic::Ordering::Release);
        self.release.notify_waiters();
    }
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
    message: HighlightMessageEligibility,
}

fn validate_eligibility(
    params: &SetCommentHighlightParams,
    eligibility: &HighlightEligibility,
) -> Result<(), CommentHighlightError> {
    if params.session_id.trim().is_empty() || params.message_id.trim().is_empty() {
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
    match eligibility.message {
        HighlightMessageEligibility::Eligible => {}
        HighlightMessageEligibility::WrongSession => {
            return Err(CommentHighlightError::WrongSession);
        }
        HighlightMessageEligibility::Missing => {
            return Err(CommentHighlightError::MessageNotFound);
        }
        HighlightMessageEligibility::Ineligible => {
            return Err(CommentHighlightError::IneligibleMessage);
        }
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
    mut params: SetCommentHighlightParams,
    ttl: Duration,
) -> Result<CommentHighlightState, CommentHighlightError> {
    if params.session_id.trim().is_empty()
        || params.message_id.trim().is_empty()
        || params.png_base64.trim().is_empty()
    {
        return Err(CommentHighlightError::InvalidParams);
    }

    let png_base64 = std::mem::take(&mut params.png_base64);
    #[cfg(test)]
    let preparation_blocker = params.preparation_blocker.take();
    #[cfg(test)]
    let commit_blocker = params.commit_blocker.take();
    // Decode and BGRA conversion are the only unbounded-CPU portion of this
    // command. They must finish before recording -> highlight lifecycle locks
    // are acquired, otherwise Stop cannot publish its finalization intent.
    let prepared = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        if let Some(blocker) = preparation_blocker.as_ref() {
            blocker.block();
        }
        crate::captions::prepare_caption_overlay(&png_base64)
    })
    .await
    .map_err(|error| {
        CommentHighlightError::InvalidImage(format!("overlay preparation task stopped: {error}"))
    })?
    .map_err(|error| CommentHighlightError::InvalidImage(error.to_string()))?;

    #[cfg(test)]
    if let Some(blocker) = commit_blocker.as_ref() {
        blocker.block().await;
    }

    // Keep the recording guard through the bounded commit fence and Arc swap.
    // Stop takes recording -> highlight-commit too, so it cannot clear the old
    // card and then race a new install onto a stopping session.
    let recording = state.recording.lock().await;
    let _commit = state.comment_highlight_commit.lock().await;
    // Hold compositor authority through the install itself. A Live ->
    // non-Live transition can therefore either happen first (and reject this
    // request) or happen afterward and clear it through the same commit fence.
    let compositor = state.compositor.lock().await;
    let compositor_live = compositor.status.state == CompositorState::Live;
    let message = state
        .live_chat
        .lock()
        .await
        .highlight_message_eligibility(&params.session_id, &params.message_id);
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
        message,
    };
    validate_eligibility(&params, &eligibility)?;

    let mut highlight = state.comment_highlight.lock().await;
    let snapshot = install_validated_highlight(state, &mut highlight, params, prepared, ttl);
    let generation = snapshot.generation;
    emit_state(state, &snapshot);
    drop(highlight);
    drop(compositor);
    drop(_commit);
    drop(recording);

    schedule_expiry(state.clone(), generation, ttl);
    Ok(snapshot)
}

/// Install and publish the already-decoded overlay as one bounded synchronous
/// critical section. Preparation failure returned before these locks preserves
/// both the old pixels and the matching generation/state.
fn install_validated_highlight(
    state: &AppState,
    highlight: &mut CommentHighlightState,
    params: SetCommentHighlightParams,
    prepared: crate::captions::PreparedCaptionOverlay,
    ttl: Duration,
) -> CommentHighlightState {
    crate::captions::install_prepared_caption_overlay(
        &state.highlight_overlay,
        prepared,
        params.position,
    );

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
    highlight.clone()
}

fn schedule_expiry(state: AppState, generation: u64, ttl: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        let _ = expire_generation(&state, generation).await;
    })
}

async fn expire_generation(state: &AppState, generation: u64) -> bool {
    let _commit = state.comment_highlight_commit.lock().await;
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
    let _commit = state.comment_highlight_commit.lock().await;
    clear_internal_under_commit_fence(state, expected_session_id, expected_message_id, reason).await
}

async fn clear_internal_under_commit_fence(
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

/// Tombstone delivery already owns `comment_highlight_commit` while it checks
/// the authoritative live-chat generation. Re-entering the mutex here would
/// deadlock, so this narrow helper makes the required ownership explicit.
pub(crate) async fn clear_comment_highlight_for_message_under_commit_fence(
    state: &AppState,
    session_id: &str,
    message_id: &str,
) -> CommentHighlightState {
    clear_internal_under_commit_fence(state, Some(session_id), Some(message_id), "message-deleted")
        .await
}

/// Clear a viewer card only when the compositor is authoritatively non-Live.
/// A stale stop completion cannot clear a card installed on a replacement run.
pub(crate) async fn invalidate_comment_highlight_for_compositor_non_live(
    state: &AppState,
    reason: &str,
) -> CommentHighlightState {
    let _commit = state.comment_highlight_commit.lock().await;
    if state.compositor.lock().await.status.state == CompositorState::Live {
        return state.comment_highlight.lock().await.clone();
    }
    clear_internal_under_commit_fence(state, None, None, reason).await
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

    fn persist_session(state: &AppState, session_id: &str) {
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: session_id.to_string(),
                title: "Comment highlight test".to_string(),
                started_at: "2026-07-10T10:00:00Z".to_string(),
                mode: "record+stream".to_string(),
                output_path: None,
                container: Some("mkv".to_string()),
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: crate::protocol::default_layout_settings(),
                output: serde_json::from_value(serde_json::json!({
                    "recordEnabled": true,
                    "streamEnabled": true,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();
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
            preparation_blocker: None,
            commit_blocker: None,
        }
    }

    struct PreparationReleaseGuard(CommentHighlightPreparationBlocker);

    impl Drop for PreparationReleaseGuard {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    struct CommitReleaseGuard(CommentHighlightCommitBlocker);

    impl Drop for CommitReleaseGuard {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    fn eligibility(message: HighlightMessageEligibility) -> HighlightEligibility {
        HighlightEligibility {
            recording_session_id: Some("session-1".to_string()),
            recording_mode: Some("record+stream".to_string()),
            recording_stopping: false,
            viewer_overlay_available: true,
            compositor_live: true,
            message,
        }
    }

    #[test]
    fn eligibility_requires_live_session_message_and_viewer_compositor_path() {
        assert!(
            validate_eligibility(
                &params(),
                &eligibility(HighlightMessageEligibility::Eligible)
            )
            .is_ok()
        );

        let mut case = eligibility(HighlightMessageEligibility::Eligible);
        case.recording_mode = Some("record".to_string());
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::NotStreaming)
        );

        let mut case = eligibility(HighlightMessageEligibility::Eligible);
        case.recording_session_id = Some("session-2".to_string());
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::WrongSession)
        );

        let mut case = eligibility(HighlightMessageEligibility::Eligible);
        case.viewer_overlay_available = false;
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::UnsupportedOutput)
        );
        assert_eq!(
            CommentHighlightError::UnsupportedOutput.code(),
            "highlight-unavailable"
        );

        let mut case = eligibility(HighlightMessageEligibility::Eligible);
        case.compositor_live = false;
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::UnsupportedOutput)
        );

        let case = eligibility(HighlightMessageEligibility::Missing);
        assert_eq!(
            validate_eligibility(&params(), &case),
            Err(CommentHighlightError::MessageNotFound)
        );
    }

    #[test]
    fn eligibility_rejects_deleted_system_and_moderation_rows() {
        assert_eq!(
            validate_eligibility(
                &params(),
                &eligibility(HighlightMessageEligibility::Ineligible)
            ),
            Err(CommentHighlightError::IneligibleMessage)
        );
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
        let error = set_comment_highlight(&state, replacement)
            .await
            .unwrap_err();

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
    async fn highlight_image_preparation_does_not_block_recording_finalization_intent() {
        let state = test_state();
        state.compositor.lock().await.status.state = CompositorState::Live;
        {
            let mut chat = state.live_chat.lock().await;
            chat.start_session("session-1".to_string(), Vec::new());
            chat.ingest(message(LiveChatEventType::Message, false));
        }
        let mut active = crate::recording::test_active_recording_stub("session-1");
        active.mode = "record+stream".to_string();
        active.comment_highlight_available = true;
        *state.recording.lock().await = Some(active);

        let blocker = CommentHighlightPreparationBlocker::new();
        let _release_on_panic = PreparationReleaseGuard(blocker.clone());
        let mut request = params();
        request.preparation_blocker = Some(blocker.clone());
        let set_state = state.clone();
        let setting = tokio::spawn(async move {
            set_comment_highlight_with_ttl(&set_state, request, COMMENT_HIGHLIGHT_TTL).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !blocker.entered() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("highlight preparation must reach the deterministic blocker");

        let stop_state = state.clone();
        let stopping =
            tokio::spawn(async move { crate::recording::stop_recording(stop_state).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let recording = state.recording.lock().await;
                if recording.as_ref().is_some_and(|active| {
                    active.stop_requested
                        && active.pipeline.status().finalization
                            == crate::protocol::RecordingFinalizationState::Finalizing
                }) {
                    break;
                }
                drop(recording);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Stop must publish finalization intent before image preparation is released");

        blocker.release();
        let error = tokio::time::timeout(Duration::from_secs(1), setting)
            .await
            .expect("highlight request must settle after preparation is released")
            .expect("highlight task")
            .expect_err("a request prepared across Stop must be rejected");
        assert_eq!(error, CommentHighlightError::NotStreaming);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());

        stopping.abort();
        let _ = stopping.await;
        state.recording.lock().await.take();
    }

    #[tokio::test]
    async fn tombstone_between_decode_and_commit_prevents_stale_highlight_install() {
        let state = test_state();
        persist_session(&state, "session-1");
        state.compositor.lock().await.status.state = CompositorState::Live;
        {
            let mut chat = state.live_chat.lock().await;
            chat.start_session("session-1".to_string(), Vec::new());
            chat.ingest(message(LiveChatEventType::Message, false));
        }
        let mut active = crate::recording::test_active_recording_stub("session-1");
        active.mode = "record+stream".to_string();
        active.comment_highlight_available = true;
        *state.recording.lock().await = Some(active);

        let blocker = CommentHighlightCommitBlocker::new();
        let _release_on_panic = CommitReleaseGuard(blocker.clone());
        let mut request = params();
        request.commit_blocker = Some(blocker.clone());
        let set_state = state.clone();
        let setting = tokio::spawn(async move {
            set_comment_highlight_with_ttl(&set_state, request, COMMENT_HIGHLIGHT_TTL).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !blocker.entered() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("decoded highlight must reach the pre-commit seam");

        assert!(
            crate::live_chat::deliver_message(&state, message(LiveChatEventType::Deleted, true),)
                .await,
            "the authoritative tombstone must commit while image installation is paused"
        );
        blocker.release();

        let error = tokio::time::timeout(Duration::from_secs(1), setting)
            .await
            .expect("highlight request must settle after commit release")
            .expect("highlight task")
            .expect_err("a tombstoned message cannot become viewer-visible");
        assert_eq!(error, CommentHighlightError::IneligibleMessage);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());
        assert_eq!(
            comment_highlight_status(&state).await.phase,
            CommentHighlightPhase::Idle
        );
    }

    #[tokio::test]
    async fn compositor_non_live_between_decode_and_commit_prevents_install() {
        let state = test_state();
        state.compositor.lock().await.status.state = CompositorState::Live;
        {
            let mut chat = state.live_chat.lock().await;
            chat.start_session("session-1".to_string(), Vec::new());
            chat.ingest(message(LiveChatEventType::Message, false));
        }
        let mut active = crate::recording::test_active_recording_stub("session-1");
        active.mode = "record+stream".to_string();
        active.comment_highlight_available = true;
        *state.recording.lock().await = Some(active);

        let blocker = CommentHighlightCommitBlocker::new();
        let _release_on_panic = CommitReleaseGuard(blocker.clone());
        let mut request = params();
        request.commit_blocker = Some(blocker.clone());
        let set_state = state.clone();
        let setting = tokio::spawn(async move {
            set_comment_highlight_with_ttl(&set_state, request, COMMENT_HIGHLIGHT_TTL).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !blocker.entered() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("decoded highlight must reach the pre-commit seam");

        state.compositor.lock().await.status.state = CompositorState::Stopped;
        invalidate_comment_highlight_for_compositor_non_live(&state, "compositor-stopped").await;
        blocker.release();

        let error = tokio::time::timeout(Duration::from_secs(1), setting)
            .await
            .expect("highlight request must settle after commit release")
            .expect("highlight task")
            .expect_err("a non-Live compositor cannot receive a highlight");
        assert_eq!(error, CommentHighlightError::UnsupportedOutput);
        assert!(crate::captions::current_caption_overlay(&state.highlight_overlay).is_none());
        assert_eq!(
            comment_highlight_status(&state).await.phase,
            CommentHighlightPhase::Idle
        );
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
