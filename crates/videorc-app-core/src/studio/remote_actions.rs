//! The remote intents past the session's (Stream Deck, the phone remote):
//! Electron's executors in `lib/studio-actions/` (`scene.ts`, `banners.ts`,
//! `sounds.ts`, `privacy.ts`, `clips.ts`, `comments.ts`) with the helpers
//! they call (`lib/banners.ts`'s `runBannerAction`, `lib/sounds.ts`'s
//! `runSoundAction`), on the Studio. [`super::remote`] matches the kind and
//! acks the answer.
//!
//! Each answers as Electron's does: accepted, or refused with the sentence
//! the remote shows (`REMOTE_INTENT_COPY`, or the backend's own refusal).
//! Where Electron reads a list the renderer holds (the takeovers, the
//! banners, the sounds), the Studio reads it from the backend at the press;
//! a read that fails is said as [`copy::FAILED`]. Nothing here toasts on the
//! computer, as in Electron, except Hide screen's refusal on a legacy
//! recording (`useScreenPrivacy`'s warning).

use std::sync::Arc;

use serde_json::{Value, json};
use videorc_protocol::ReplayBufferState;

use super::capture_config::{HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS};
use super::clips;
use super::remote::{IntentOutcome, accepted, copy, refused};
use super::scene_editor::{BANNERS_HIDE_METHOD, BANNERS_SHOW_METHOD, banner_refusal};
use super::scene_on_stream::{
    self, SCREEN_HIDE_UNAVAILABLE_CODE, SCREEN_PRIVACY_GET_METHOD, screen_privacy_request,
};
use super::scene_switch::ApplyOptions;
use super::screen_views::talk_show_room_in;
use super::source_selection::SourceKind;
use super::{Studio, StudioBackend};
use crate::chat::highlight::{self, copy as highlight_copy};
use crate::chat::highlight_driver::{self, HighlightClick, HighlightRequest};
use crate::chat::model::CommentHighlightPhase;
use crate::notices::{self, NoticeCommand, ToastRequest};
use crate::scenes::model::visual_sources;
use crate::scenes::v2::{SceneShows, shows_from_sources};
use crate::soundboard;

/// `sounds.press`: the sound's own mode, as a key press applies it.
pub const SOUNDS_PRESS_METHOD: &str = "sounds.press";
/// `sounds.stop`, with an id or (`{}`) every sound.
pub const SOUNDS_STOP_METHOD: &str = "sounds.stop";
/// A remote's comment card falls back to the bottom-left corner when the
/// layout has no rect (Studio's own click does the same; the Stream
/// Manager's corner pick is its own).
const HIGHLIGHT_ANCHOR: &str = "bottom-left";
/// `fields.sceneId.length > 128`: a JavaScript string's length.
const SCENE_ID_MAX_UNITS: usize = 128;
/// `markClip`'s catch when the error has no words.
const CLIP_MARK_FAILED: &str = "Couldn't mark the clip.";

/// `bannerShow`, `bannerHide`, `bannerToggle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BannerVerb {
    Show,
    Hide,
    Toggle,
}

/// `soundPlay` (a press) and `soundStop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SoundVerb {
    Press,
    Stop,
}

/// `screenHide`, `screenShow`, `screenHideToggle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PrivacyMode {
    Hide,
    Show,
    Toggle,
}

/// `context.knownLayoutPresets`: both orientations' presets.
fn is_known_layout_preset(preset: &str) -> bool {
    HORIZONTAL_LAYOUT_PRESETS
        .iter()
        .chain(VERTICAL_LAYOUT_PRESETS.iter())
        .any(|known| *known == preset)
}

/// A banner in `banners.list`'s answer: whether it shows, or `None` when the
/// list has no banner by that id.
fn listed_banner(list: &Value, id: &str) -> Option<bool> {
    list.as_array()?
        .iter()
        .find(|banner| banner.get("id").and_then(Value::as_str) == Some(id))
        .map(|banner| {
            banner
                .get("shown")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
}

impl<B: StudioBackend> Studio<B> {
    // --- the picture (`scene.ts`) ---

    /// `sceneApply`: a saved scene by its id, or the first scene with a
    /// layout (plan 231 D14), optionally with a screen; or a screen alone,
    /// which becomes the scene on stream's screen.
    pub(super) async fn remote_scene_apply(self: &Arc<Self>, intent: &Value) -> IntentOutcome {
        let switches = intent.get("sceneId").is_some() || intent.get("layoutPreset").is_some();
        let Some(screen_id) = intent.get("screenId") else {
            if !switches {
                return refused(copy::SCENE_MISSING);
            }
            return self.remote_switch_scene(intent, None).await;
        };
        let Some(sources) = screen_id
            .as_str()
            .and_then(|id| self.capture_sources_for(id))
        else {
            return refused(copy::SCREEN_MISSING);
        };
        // Plan 231 D2: a scene and a screen together are one switch; the
        // scene it names goes on showing that screen, and keeps it.
        if switches {
            let shows = shows_from_sources(&visual_sources(&sources));
            return self.remote_switch_scene(intent, Some(shows)).await;
        }
        // The picker is off with this reason; the switch would only toast it.
        if let Some(blocked) = self.source_switch_reason(SourceKind::Capture) {
            return refused(blocked);
        }
        match self
            .switch_source_device_live(SourceKind::Capture, sources)
            .await
        {
            Ok(()) => accepted(),
            Err(message) => refused(message),
        }
    }

    /// `switchScene`: the scene by id (`applySavedSceneResult`), else the
    /// layout (`switchToSceneWithLayout`); a refusal keeps its own words.
    async fn remote_switch_scene(
        self: &Arc<Self>,
        intent: &Value,
        shows: Option<SceneShows>,
    ) -> IntentOutcome {
        let result = if let Some(scene_id) = intent.get("sceneId").and_then(Value::as_str) {
            if scene_id.trim().is_empty() || scene_id.encode_utf16().count() > SCENE_ID_MAX_UNITS {
                return refused(copy::SCENE_MISSING);
            }
            let options = ApplyOptions {
                shows,
                ..ApplyOptions::default()
            };
            self.apply_saved_scene(scene_id, None, options).await
        } else {
            let Some(preset) = intent
                .get("layoutPreset")
                .and_then(Value::as_str)
                .filter(|preset| is_known_layout_preset(preset))
            else {
                return refused(copy::SCENE_MISSING);
            };
            self.switch_to_scene_with_layout(preset, shows).await
        };
        if result.ok {
            return accepted();
        }
        refused(
            result
                .message
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| copy::SCENE_FAILED.to_string()),
        )
    }

    /// `takeoverShow`: a takeover `screens.list` has goes on air.
    pub(super) async fn remote_takeover_show(&self, asset_id: Option<&str>) -> IntentOutcome {
        let Some(asset_id) = asset_id.filter(|id| !id.is_empty()) else {
            return refused(copy::TAKEOVER_MISSING);
        };
        let screens = match self.backend.screens_list().await {
            Ok(screens) => screens,
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] the takeovers did not read: {} ({})",
                    error.message, error.code
                ));
                return refused(copy::FAILED);
            }
        };
        if !screens.iter().any(|screen| screen.id == asset_id) {
            return refused(copy::TAKEOVER_MISSING);
        }
        match self.backend.screens_activate(asset_id).await {
            Ok(_) => {
                self.commit_takeover_from_action(true).await;
                accepted()
            }
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] the takeover did not show: {} ({})",
                    error.message, error.code
                ));
                refused(copy::TAKEOVER_SHOW)
            }
        }
    }

    /// `takeoverHide`: back to the scene (`screens.clear`).
    pub(super) async fn remote_takeover_hide(&self) -> IntentOutcome {
        match self.backend.screens_clear().await {
            Ok(()) => {
                self.commit_takeover_from_action(false).await;
                accepted()
            }
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] the takeover did not hide: {} ({})",
                    error.message, error.code
                ));
                refused(copy::TAKEOVER_HIDE)
            }
        }
    }

    // --- banners (`banners.ts`, `runBannerAction`) ---

    /// `runBannerIntent`: a banner by id; a toggle shows a hidden one and
    /// hides a shown one; a hide without an id hides them all.
    pub(super) async fn remote_banner(
        &self,
        verb: BannerVerb,
        banner_id: Option<&str>,
    ) -> IntentOutcome {
        let Some(banner_id) = banner_id else {
            if verb != BannerVerb::Hide {
                return refused(copy::BANNER_MISSING);
            }
            return self
                .remote_banner_call(BANNERS_HIDE_METHOD, json!({}), copy::BANNERS_HIDE)
                .await;
        };
        let list = match self.banners().await {
            Ok(list) => list,
            Err(error) => {
                self.config.logger.warn(format!(
                    "[banners] the list did not read: {} ({})",
                    error.message, error.code
                ));
                return refused(copy::FAILED);
            }
        };
        let Some(shown) = listed_banner(&list, banner_id) else {
            return refused(copy::BANNER_MISSING);
        };
        let show = verb == BannerVerb::Show || (verb == BannerVerb::Toggle && !shown);
        if show {
            self.remote_banner_call(
                BANNERS_SHOW_METHOD,
                json!({ "id": banner_id }),
                copy::BANNER_SHOW,
            )
            .await
        } else {
            self.remote_banner_call(
                BANNERS_HIDE_METHOD,
                json!({ "id": banner_id }),
                copy::BANNER_HIDE,
            )
            .await
        }
    }

    /// One show or hide: a refusal's own sentence comes back verbatim, any
    /// other failure the plain one.
    async fn remote_banner_call(
        &self,
        method: &'static str,
        params: Value,
        failure: &'static str,
    ) -> IntentOutcome {
        match self.backend.scene_request(method, params).await {
            Ok(_) => accepted(),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[banners] show or hide failed: {} ({})",
                    error.message, error.code
                ));
                refused(banner_refusal(&error.message).unwrap_or(failure))
            }
        }
    }

    // --- sounds (`sounds.ts`, `runSoundAction`) ---

    /// `runSoundIntent`: a press applies the sound's own mode, like a key;
    /// a stop without an id stops every sound.
    pub(super) async fn remote_sound(
        &self,
        verb: SoundVerb,
        sound_id: Option<&str>,
    ) -> IntentOutcome {
        let (method, params, failure) = match (verb, sound_id) {
            (SoundVerb::Press, None) => return refused(copy::SOUND_MISSING),
            (SoundVerb::Stop, None) => (
                SOUNDS_STOP_METHOD,
                json!({}),
                soundboard::SOUND_ACTION_STOP_ALL,
            ),
            (SoundVerb::Press, Some(id)) => (
                SOUNDS_PRESS_METHOD,
                json!({ "id": id }),
                soundboard::SOUND_ACTION_PLAY,
            ),
            (SoundVerb::Stop, Some(id)) => (
                SOUNDS_STOP_METHOD,
                json!({ "id": id }),
                soundboard::SOUND_ACTION_STOP,
            ),
        };
        if let Some(sound_id) = sound_id {
            match self.backend.sounds_list().await {
                Ok(board) if board.sounds.iter().any(|sound| sound.id == sound_id) => {}
                Ok(_) => return refused(copy::SOUND_MISSING),
                Err(error) => {
                    self.config.logger.warn(format!(
                        "[sounds] the board did not read: {} ({})",
                        error.message, error.code
                    ));
                    return refused(copy::FAILED);
                }
            }
        }
        match self.backend.sounds_request(method, params).await {
            Ok(_) => accepted(),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[sounds] {method} failed: {} ({})",
                    error.message, error.code
                ));
                refused(soundboard::sound_refusal(&error.message).unwrap_or(failure))
            }
        }
    }

    // --- Hide screen (`privacy.ts`, `screenPrivacyAction`) ---

    /// `screenPrivacyAction(client, mode, 'remote')`: a toggle reads the
    /// backend's state first; a remote may show the screen again. A legacy
    /// recording refuses the hide with its own sentence (and the computer
    /// says it too); any other failure is the plain one.
    pub(super) async fn remote_screen_privacy(&self, mode: PrivacyMode) -> IntentOutcome {
        let showing = match mode {
            PrivacyMode::Show => true,
            PrivacyMode::Hide => false,
            PrivacyMode::Toggle => {
                match self
                    .backend
                    .scene_request(SCREEN_PRIVACY_GET_METHOD, Value::Null)
                    .await
                {
                    Ok(privacy) => privacy
                        .get("hidden")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "[remote-control] Hide screen's state did not read: {} ({})",
                            error.message, error.code
                        ));
                        return refused(copy::FAILED);
                    }
                }
            }
        };
        // `screen.show` while hidden, `screen.hide {reason: 'you'}` while not.
        let (method, params) = screen_privacy_request(showing);
        match self.backend.scene_request(method, params).await {
            Ok(_) => accepted(),
            Err(error) if error.code == SCREEN_HIDE_UNAVAILABLE_CODE => {
                self.post(vec![NoticeCommand::Show(
                    ToastRequest::warning(scene_on_stream::copy::SCREEN_HIDE_UNAVAILABLE)
                        .id(scene_on_stream::copy::SCREEN_HIDE_UNAVAILABLE_ID)
                        .finish(),
                )]);
                refused(scene_on_stream::copy::SCREEN_HIDE_UNAVAILABLE)
            }
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] {method} failed: {} ({})",
                    error.message, error.code
                ));
                refused(copy::FAILED)
            }
        }
    }

    // --- the clip (`clips.ts`, the context's `markClip`) ---

    /// `clipMark`: 30 s, the minute, or no length (30 s); any other length
    /// is refused with the backend's sentence. With no session and the
    /// Clips ring off, nothing is sent. A press that kept nothing says so.
    pub(super) async fn remote_clip_mark(&self, seconds: Option<&Value>) -> IntentOutcome {
        let seconds = match clips::parse_clip_length(seconds) {
            Ok(seconds) => seconds,
            Err(message) => return refused(message),
        };
        let replay_on = self.snapshot().clips.state == ReplayBufferState::On;
        // No talk show room in app-core yet (plan 249): its open room is
        // never a target here.
        if let Some(refusal) =
            clips::clip_action_refusal(seconds, self.session_owns_transport(), replay_on, false)
        {
            return refused(refusal);
        }
        match self.request_clip_mark(seconds).await {
            // Plan 181 R4: a saved clip is a success for a key, mark or not.
            Ok(event)
                if event.saved
                    || event.reason.as_deref() == Some(notices::CLIP_MARK_CLIP_SAVED_REASON) =>
            {
                accepted()
            }
            // `clipMarkedToast(event).title`.
            Ok(_) => refused(notices::copy::CLIPS_OFF_NOTHING_RECORDING),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] clip.mark failed: {} ({})",
                    error.message, error.code
                ));
                let message = error.message.trim();
                refused(if message.is_empty() {
                    CLIP_MARK_FAILED
                } else {
                    message
                })
            }
        }
    }

    // --- a comment on stream (`comments.ts`, the context's handlers) ---

    /// `showCommentHighlight`: the message from the Studio's live chat goes
    /// on stream, always as a set (a remote's show restarts the card's
    /// lifetime), for the stream canvas inside the streamer's rect. The
    /// backend's reason comes back verbatim.
    pub(super) async fn remote_comment_highlight(&self, message_id: &str) -> IntentOutcome {
        let (message, chat_session) = {
            let chat = self.live_chat_now();
            let message = chat
                .message(message_id)
                .filter(|message| !message.is_deleted)
                .cloned();
            (message, chat.session_id.clone())
        };
        let Some(message) = message else {
            return refused(highlight_copy::COMMENT_UNAVAILABLE);
        };
        // `applyCommentHighlight`: never a message from another livestream.
        let Some(session_id) = chat_session.filter(|session| *session == message.session_id) else {
            return refused(highlight_copy::WRONG_LIVESTREAM);
        };
        let room_open = talk_show_room_in(&self.cloud_now()).open;
        let layout = self.current_overlay_layout().await;
        let canvas = {
            let snapshot = self.snapshot();
            highlight_driver::highlight_canvas(
                &snapshot.settings.capture_doc,
                room_open,
                layout.as_ref(),
            )
        };
        let click = HighlightClick {
            intent: 0,
            session_id: session_id.clone(),
            message_id: message.id.clone(),
            request: HighlightRequest::Set {
                params: highlight_driver::set_params(
                    &session_id,
                    &message.id,
                    &canvas,
                    HIGHLIGHT_ANCHOR,
                ),
                warm: highlight::card_image_urls(&message),
            },
        };
        match highlight_driver::send(&*self.backend, &click).await {
            Ok(state) if state.phase == CommentHighlightPhase::Live => accepted(),
            Ok(state) => refused(
                state
                    .reason
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| highlight_copy::DID_NOT_REACH_STREAM.to_string()),
            ),
            Err(reason) => refused(reason),
        }
    }

    /// `clearCommentHighlight`: the card comes off the stream.
    pub(super) async fn remote_comment_highlight_clear(&self) -> IntentOutcome {
        match self
            .backend
            .chat_request(highlight_driver::CLEAR_METHOD, Value::Null)
            .await
        {
            Ok(_) => accepted(),
            Err(error) => {
                let message = error.message.trim();
                refused(if message.is_empty() {
                    highlight_copy::CLEAR_FAILED
                } else {
                    message
                })
            }
        }
    }
}
