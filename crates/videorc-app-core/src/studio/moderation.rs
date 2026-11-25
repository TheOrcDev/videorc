//! Chat removals through the Studio (plan 140 S6, P1268):
//! `liveChat.moderation.request` / `.list` / `.cancel` / `.confirm`, and the
//! `liveChat.moderationOperation` ledger the Stream Manager mirrors.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::Studio;
use super::backend::StudioBackend;
use crate::client::RpcError;
use crate::stream_manager::removal::{self, ModerationOperation, merge_operations};

/// `liveChat.moderationOperation`.
pub const OPERATION_EVENT: &str = "liveChat.moderationOperation";
/// `liveChat.moderation.request`.
pub const REQUEST_METHOD: &str = "liveChat.moderation.request";
/// `liveChat.moderation.confirm`.
pub const CONFIRM_METHOD: &str = "liveChat.moderation.confirm";
/// `liveChat.moderation.cancel`.
pub const CANCEL_METHOD: &str = "liveChat.moderation.cancel";
/// `liveChat.moderationOperations.list`.
pub const LIST_METHOD: &str = "liveChat.moderationOperations.list";

impl<B: StudioBackend> Studio<B> {
    /// The session's removal ledger, as it changes.
    pub fn moderation_operations(&self) -> watch::Receiver<Vec<ModerationOperation>> {
        self.moderation_tx.subscribe()
    }

    pub fn moderation_operations_now(&self) -> Vec<ModerationOperation> {
        self.moderation_tx.borrow().clone()
    }

    fn publish_moderation(&self, operations: Vec<ModerationOperation>) {
        self.moderation_tx.send_replace(operations);
    }

    /// Fold a backend event into the ledger.
    pub(super) fn handle_moderation_event(&self, event: &str, payload: &Value) -> bool {
        if event != OPERATION_EVENT {
            return false;
        }
        let Ok(operation) = serde_json::from_value::<ModerationOperation>(payload.clone()) else {
            self.config
                .logger
                .warn(format!("Studio: {OPERATION_EVENT} did not read."));
            return true;
        };
        let session = self.live_chat_now().session_id;
        if session.as_deref() != Some(operation.session_id.as_str()) && session.is_some() {
            return true;
        }
        let next = merge_operations(
            &self.moderation_operations_now(),
            vec![operation],
            session.as_deref(),
        );
        self.publish_moderation(next);
        true
    }

    pub(super) fn clear_moderation_operations(&self) {
        if !self.moderation_tx.borrow().is_empty() {
            self.publish_moderation(Vec::new());
        }
    }

    /// Seed the ledger for the live session (`liveChat.moderationOperations.list`).
    pub async fn read_moderation_operations(&self) {
        let Some(session_id) = self.live_chat_now().session_id else {
            self.publish_moderation(Vec::new());
            return;
        };
        match self.list_moderation_operations(&session_id).await {
            Ok(listed) => self.publish_moderation(listed),
            Err(error) => {
                if error.code != crate::client::codes::NOT_CONNECTED {
                    self.config
                        .logger
                        .warn(format!("Studio: {LIST_METHOD} failed ({}).", error.message));
                }
            }
        }
    }

    pub async fn list_moderation_operations(
        &self,
        session_id: &str,
    ) -> Result<Vec<ModerationOperation>, RpcError> {
        let value = self
            .backend
            .chat_request(LIST_METHOD, json!({ "sessionId": session_id }))
            .await?;
        match serde_json::from_value::<Vec<ModerationOperation>>(value) {
            Ok(listed) => Ok(merge_operations(&[], listed, Some(session_id))),
            Err(error) => Err(RpcError::new(
                LIST_METHOD,
                crate::client::codes::INVALID_RESPONSE,
                format!("The {LIST_METHOD} answer did not read: {error}"),
            )),
        }
    }

    /// Manual "Remove from chat": express consent; the UI waits 3 s for Undo
    /// before calling this (`removal::REMOVE_UNDO`).
    pub async fn request_chat_removal(
        &self,
        message_id: &str,
    ) -> Result<ModerationOperation, RpcError> {
        let operation_id = uuid::Uuid::new_v4().to_string();
        let params = json!({
            "operationId": operation_id,
            "messageId": message_id,
            "source": "manual",
        });
        let value = self.backend.chat_request(REQUEST_METHOD, params).await?;
        let operation = match serde_json::from_value::<ModerationOperation>(value) {
            Ok(operation) => operation,
            Err(error) => {
                return Err(RpcError::new(
                    REQUEST_METHOD,
                    crate::client::codes::INVALID_RESPONSE,
                    format!("The {REQUEST_METHOD} answer did not read: {error}"),
                ));
            }
        };
        let session = Some(operation.session_id.as_str());
        let next = merge_operations(
            &self.moderation_operations_now(),
            vec![operation.clone()],
            session,
        );
        self.publish_moderation(next);
        Ok(operation)
    }

    pub async fn confirm_chat_removal(
        &self,
        operation_id: &str,
    ) -> Result<ModerationOperation, RpcError> {
        self.answer_chat_removal(CONFIRM_METHOD, operation_id).await
    }

    pub async fn cancel_chat_removal(
        &self,
        operation_id: &str,
    ) -> Result<ModerationOperation, RpcError> {
        self.answer_chat_removal(CANCEL_METHOD, operation_id).await
    }

    async fn answer_chat_removal(
        &self,
        method: &'static str,
        operation_id: &str,
    ) -> Result<ModerationOperation, RpcError> {
        let value = self
            .backend
            .chat_request(method, json!({ "operationId": operation_id }))
            .await?;
        let operation = match serde_json::from_value::<ModerationOperation>(value) {
            Ok(operation) => operation,
            Err(error) => {
                return Err(RpcError::new(
                    method,
                    crate::client::codes::INVALID_RESPONSE,
                    format!("The {method} answer did not read: {error}"),
                ));
            }
        };
        let session = Some(operation.session_id.as_str());
        let next = merge_operations(
            &self.moderation_operations_now(),
            vec![operation.clone()],
            session,
        );
        self.publish_moderation(next);
        Ok(operation)
    }
}

/// Re-export so callers can name the undo window without reaching into
/// `stream_manager::removal` for the constant alone.
pub use removal::REMOVE_UNDO;
