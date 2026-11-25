//! Live chat in the Studio driver (plan 260 S1.6e): folds `liveChat.*`
//! events into [`crate::chat::LiveChat`], exposes a watch for the Stream
//! Manager, and sends through `liveChat.send`.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::Studio;
use super::backend::StudioBackend;
use crate::chat::model::{LiveChatMessage, LiveChatProviderState, LiveChatSnapshotWire};
use crate::chat::store::LiveChat;
use crate::chat::view::studio_chat_counts;
use crate::client::RpcError;
use crate::stream_manager::send::{
    CHAT_SEND_MAX_CHARS, CommentsSendOperation, validate_chat_draft, writable_providers,
};

/// `liveChat.message`.
pub const MESSAGE_EVENT: &str = "liveChat.message";
/// `liveChat.snapshot`.
pub const SNAPSHOT_EVENT: &str = "liveChat.snapshot";
/// `liveChat.cleared`.
pub const CLEARED_EVENT: &str = "liveChat.cleared";
/// `liveChat.providerStatus`.
pub const PROVIDER_EVENT: &str = "liveChat.providerStatus";
/// Bootstrap / recover: `liveChat.status`.
pub const STATUS_METHOD: &str = "liveChat.status";
/// Send to every writable destination: `liveChat.send`.
pub const SEND_METHOD: &str = "liveChat.send";

impl<B: StudioBackend> Studio<B> {
    /// The live chat as it changes (Stream Manager's chat pane).
    pub fn live_chat(&self) -> watch::Receiver<LiveChat> {
        self.live_chat_tx.subscribe()
    }

    pub fn live_chat_now(&self) -> LiveChat {
        self.live_chat_tx.borrow().clone()
    }

    fn publish_live_chat(&self, chat: LiveChat) {
        self.live_chat_tx.send_replace(chat);
    }

    pub(super) fn handle_live_chat_event(&self, event: &str, payload: &Value) -> bool {
        let mut chat = self.live_chat_tx.borrow().clone();
        let changed = match event {
            MESSAGE_EVENT => match serde_json::from_value::<LiveChatMessage>(payload.clone()) {
                Ok(message) => {
                    let counts = studio_chat_counts(&message);
                    chat.apply_message(message, counts)
                }
                Err(error) => {
                    self.config.logger.warn(format!(
                        "Studio: live chat \"{event}\" did not read ({error})."
                    ));
                    return true;
                }
            },
            SNAPSHOT_EVENT => match serde_json::from_value::<LiveChatSnapshotWire>(payload.clone())
            {
                Ok(snapshot) => {
                    chat.apply_snapshot(snapshot, false);
                    true
                }
                Err(error) => {
                    self.config.logger.warn(format!(
                        "Studio: live chat \"{event}\" did not read ({error})."
                    ));
                    return true;
                }
            },
            CLEARED_EVENT => {
                match serde_json::from_value::<LiveChatSnapshotWire>(payload.clone()) {
                    Ok(snapshot) => {
                        chat.apply_snapshot(snapshot, true);
                        self.clear_moderation_operations();
                        true
                    }
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "Studio: live chat \"{event}\" did not read ({error})."
                        ));
                        return true;
                    }
                }
            }
            PROVIDER_EVENT => {
                match serde_json::from_value::<LiveChatProviderState>(payload.clone()) {
                    Ok(provider) => {
                        chat.apply_provider(provider);
                        true
                    }
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "Studio: live chat \"{event}\" did not read ({error})."
                        ));
                        return true;
                    }
                }
            }
            _ => return false,
        };
        if changed {
            self.publish_live_chat(chat);
        }
        true
    }

    /// Bootstrap / recover: `liveChat.status` replaces the view.
    pub(super) async fn read_live_chat(&self) {
        let answer = self.backend.chat_request(STATUS_METHOD, Value::Null).await;
        let snapshot = match answer {
            Ok(value) => match serde_json::from_value::<LiveChatSnapshotWire>(value) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.config
                        .logger
                        .warn(format!("Studio: {STATUS_METHOD} did not read ({error})."));
                    return;
                }
            },
            Err(error) => {
                if error.code != crate::client::codes::NOT_CONNECTED {
                    self.config.logger.warn(format!(
                        "Studio: {STATUS_METHOD} failed ({}).",
                        error.message
                    ));
                }
                return;
            }
        };
        let mut chat = self.live_chat_tx.borrow().clone();
        chat.apply_snapshot(snapshot, true);
        self.publish_live_chat(chat);
        self.read_moderation_operations().await;
    }

    /// Send text to every writable chat destination (`liveChat.send`).
    /// Returns `None` when the draft is empty or over the cap, or when no
    /// livestream session is known yet.
    pub async fn send_chat(&self, text: &str) -> Result<Option<CommentsSendOperation>, RpcError> {
        let Some(text) = validate_chat_draft(text, CHAT_SEND_MAX_CHARS) else {
            return Ok(None);
        };
        let chat = self.live_chat_now();
        let Some(session_id) = chat.session_id.clone() else {
            return Ok(None);
        };
        if writable_providers(&chat.providers).is_empty() {
            return Ok(None);
        }
        let operation_id = uuid::Uuid::new_v4().to_string();
        let params = json!({
            "operationId": operation_id,
            "sessionId": session_id,
            "text": text,
        });
        let value = self.backend.chat_request(SEND_METHOD, params).await?;
        match serde_json::from_value::<CommentsSendOperation>(value) {
            Ok(operation) => Ok(Some(operation)),
            Err(error) => Err(RpcError::new(
                SEND_METHOD,
                crate::client::codes::INVALID_RESPONSE,
                format!("The {SEND_METHOD} answer did not read: {error}"),
            )),
        }
    }
}
