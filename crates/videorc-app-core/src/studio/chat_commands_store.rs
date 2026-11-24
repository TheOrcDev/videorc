//! S3.2f: plan 226's chat commands as the Studio runs them
//! (`lib/chat-commands-store.ts` and `lib/chat-commands-host.ts`): the
//! saved list read on each connection and kept current by
//! `chatCommands.changed`, the replies that couldn't go out
//! (`chatCommands.replyFailed`), the editor's mutations (each answered with
//! the whole state), the streamer's `!go` from the Stream Manager
//! (`chatCommands.post`, the live session only) and the editor's door.
//!
//! The state lives apart from the snapshot ([`ChatCommandsStore`] on its own
//! watch): a saved command redraws the section and the composer, never the
//! Studio. Nothing here posts on its own: the backend answers viewers, and
//! `post_chat_command` runs only for the streamer's Return.

use serde_json::{Value, json};

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::chat_commands::{
    self, CHANGED_EVENT, ChatCommandPostResult, ChatCommandReplyFailed, ChatCommandSaveParams,
    ChatCommandsState, ChatCommandsSummary, DELETE_METHOD, Field, LIST_METHOD, POST_METHOD,
    REPLY_FAILED_EVENT, SAVE_METHOD, SET_LIST_ENABLED_METHOD, next_failures,
};
use crate::user_error::{Failure, UserErrorContext, user_error_message};

/// `ChatCommandsSnapshot`: what the section and the Stream Manager read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatCommandsStore {
    /// None until `chatCommands.list` first answers: never "No commands
    /// yet" before.
    pub state: Option<ChatCommandsState>,
    /// The list couldn't be read on this connection, and nothing has
    /// arrived since.
    pub load_failed: bool,
    /// Replies that couldn't go out in the newest live chat session: one
    /// per chat and reason.
    pub failures: Vec<ChatCommandReplyFailed>,
    /// The Stream Manager asked for the section; the page scrolls there
    /// once and says so.
    pub reveal_pending: bool,
    /// Bumped by every state that arrives, so a `chatCommands.list` answer
    /// older than a `chatCommands.changed` never wins.
    revision: u64,
}

impl ChatCommandsStore {
    /// What the Stream Manager carries: the enabled commands, A–Z.
    pub fn summary(&self) -> Option<ChatCommandsSummary> {
        self.state.as_ref().map(chat_commands::summary)
    }
}

/// Why a save didn't happen: under a field when it is about one, else for
/// the dialog (`ChatCommandSaveRefusal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveRefusal {
    pub field: Option<Field>,
    pub message: String,
}

/// `inlineUserError`'s text: "Couldn't {action} {object}. {next step}".
fn inline_error(error: &RpcError, action: &str, object: &str) -> String {
    let copy = user_error_message(
        Failure::Rpc(error),
        Some(UserErrorContext {
            action: "save",
            object: "",
        }),
    );
    format!("Couldn't {action} {object}. {}", copy.description)
}

impl<B: StudioBackend> Studio<B> {
    /// S3.2f: the chat commands, as they change.
    pub fn chat_commands(&self) -> tokio::sync::watch::Receiver<ChatCommandsStore> {
        self.chat_commands_tx.subscribe()
    }

    pub fn chat_commands_now(&self) -> ChatCommandsStore {
        self.chat_commands_tx.borrow().clone()
    }

    fn edit_chat_commands(&self, edit: impl FnOnce(&mut ChatCommandsStore)) {
        self.chat_commands_tx.send_if_modified(|store| {
            let before = store.clone();
            edit(store);
            *store != before
        });
    }

    fn accept_chat_commands_state(&self, state: ChatCommandsState) {
        self.edit_chat_commands(|store| {
            store.revision += 1;
            store.state = Some(state);
            store.load_failed = false;
        });
    }

    /// The bootstrap's `chatCommands.list`. A list older than a
    /// `chatCommands.changed` that arrived meanwhile never wins.
    pub(super) async fn read_chat_commands(&self) {
        let revision = self.chat_commands_now().revision;
        match self
            .backend
            .livestream_request(LIST_METHOD, Value::Null)
            .await
            .and_then(|value| super::backend::read_json::<ChatCommandsState>(LIST_METHOD, value))
        {
            Ok(state) => {
                if self.chat_commands_now().revision == revision {
                    self.accept_chat_commands_state(state);
                }
            }
            Err(error) => {
                self.config
                    .logger
                    .warn(format!("Studio: chatCommands.list did not read ({error})."));
                if self.chat_commands_now().revision == revision {
                    self.edit_chat_commands(|store| store.load_failed = true);
                }
            }
        }
    }

    /// Reads the list again after a failed read (the section's Try again).
    pub async fn reload_chat_commands(&self) {
        self.edit_chat_commands(|store| store.load_failed = false);
        self.read_chat_commands().await;
    }

    /// `chatCommands.changed` and `chatCommands.replyFailed`. True when the
    /// event was theirs.
    pub(super) fn handle_chat_commands_event(&self, event: &str, payload: &Value) -> bool {
        if event == CHANGED_EVENT {
            match serde_json::from_value::<ChatCommandsState>(payload.clone()) {
                Ok(state) => self.accept_chat_commands_state(state),
                Err(error) => self
                    .config
                    .logger
                    .warn(format!("Studio: \"{event}\" did not read ({error}).")),
            }
            return true;
        }
        if event == REPLY_FAILED_EVENT {
            match serde_json::from_value::<ChatCommandReplyFailed>(payload.clone()) {
                Ok(failure) => self.edit_chat_commands(|store| {
                    if let Some(next) = next_failures(&store.failures, failure) {
                        store.failures = next;
                    }
                }),
                Err(error) => self
                    .config
                    .logger
                    .warn(format!("Studio: \"{event}\" did not read ({error}).")),
            }
            return true;
        }
        false
    }

    async fn chat_commands_mutation(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<(), RpcError> {
        let value = self.backend.livestream_request(method, params).await?;
        let state = super::backend::read_json::<ChatCommandsState>(method, value)?;
        self.accept_chat_commands_state(state);
        Ok(())
    }

    /// `chatCommands.save`: None when saved, else why not. A refusal the
    /// backend wrote in the editor's words goes under its field; anything
    /// else is the usual "Couldn't …" line.
    pub async fn save_chat_command(&self, params: &ChatCommandSaveParams) -> Option<SaveRefusal> {
        let value = serde_json::to_value(params).unwrap_or(Value::Null);
        match self.chat_commands_mutation(SAVE_METHOD, value).await {
            Ok(()) => None,
            Err(error) => Some(match chat_commands::refusal(&error.message) {
                Some((field, sentence)) => SaveRefusal {
                    field: Some(field),
                    message: sentence,
                },
                None => SaveRefusal {
                    field: None,
                    message: inline_error(&error, "save", "the command"),
                },
            }),
        }
    }

    /// `chatCommands.delete`: None when deleted, else the section's line.
    pub async fn delete_chat_command(&self, id: &str, name: &str) -> Option<String> {
        match self
            .chat_commands_mutation(DELETE_METHOD, json!({ "id": id }))
            .await
        {
            Ok(()) => None,
            Err(error) => Some(inline_error(&error, "delete", &format!("!{name}"))),
        }
    }

    /// `chatCommands.setListEnabled`: None when done, else the section's line.
    pub async fn set_chat_commands_list_enabled(&self, enabled: bool) -> Option<String> {
        match self
            .chat_commands_mutation(SET_LIST_ENABLED_METHOD, json!({ "enabled": enabled }))
            .await
        {
            Ok(()) => None,
            Err(error) => Some(inline_error(
                &error,
                if enabled { "turn on" } else { "turn off" },
                "!commands",
            )),
        }
    }

    /// The streamer's `!go` in the Stream Manager (plan 226 D9): the reply
    /// to every chat that takes posts in `session_id`, without a mention.
    /// The counts, or the composer's line.
    pub async fn post_chat_command(
        &self,
        session_id: &str,
        name: &str,
    ) -> Result<ChatCommandPostResult, String> {
        self.backend
            .livestream_request(
                POST_METHOD,
                json!({ "sessionId": session_id, "name": name }),
            )
            .await
            .and_then(|value| {
                super::backend::read_json::<ChatCommandPostResult>(POST_METHOD, value)
            })
            .map_err(|error| inline_error(&error, "post", &format!("the !{name} reply")))
    }

    /// ⋯ Chat commands…: the section scrolls itself into view once it is on
    /// screen (the app shows the main window and opens Livestream → Setup).
    pub fn request_chat_commands_reveal(&self) {
        self.edit_chat_commands(|store| store.reveal_pending = true);
    }

    pub fn chat_commands_reveal_handled(&self) {
        self.edit_chat_commands(|store| store.reveal_pending = false);
    }
}
