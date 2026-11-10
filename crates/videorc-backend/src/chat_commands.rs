//! Plan 226: chat commands. A viewer types `!go` in chat and Videorc answers
//! as the streamer with the reply they saved, starting with the viewer's
//! @name, in the chat the viewer asked in. `!commands` (built in) lists them.
//!
//! This is the Rust half of the contract `shared/chat-commands.ts` holds for
//! the editor: the wire types, the limits and the validation, with the same
//! words. `protocol-fixtures/chat-commands.json` pins the cases both languages
//! agree on; `protocol-fixtures/high-risk-contracts.json` (`chatCommand`)
//! pins the wire shapes. Lengths count Unicode code points in both.

use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::storage::Database;

/// The built-in command's name. Nobody can save a command with it.
pub(crate) const LIST_NAME: &str = "commands";
pub(crate) const NAME_MAX_CHARS: usize = 24;
pub(crate) const DESCRIPTION_MAX_CHARS: usize = 60;
/// 200 (Videorc's chat send) minus room for `@name ` (plan 226 D2).
pub(crate) const REPLY_MAX_CHARS: usize = 170;
pub(crate) const MAX_COUNT: usize = 100;

/// The `app_settings` key of the `!commands` switch (default on).
pub(crate) const LIST_ENABLED_SETTING_KEY: &str = "chatCommandsListEnabled";
pub(crate) const CHANGED_EVENT: &str = "chatCommands.changed";

pub(crate) const REFUSAL_TOO_MANY: &str = "You can have up to 100 commands.";
pub(crate) const REFUSAL_GONE: &str = "That command no longer exists.";

/// One saved command, as the backend stores and sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommand {
    /// Opaque UUID.
    pub id: String,
    /// Lowercase, without the `!`: `go`.
    pub name: String,
    /// One line, shown by `!commands`.
    pub description: String,
    /// One line, sent as `@viewer <reply>`.
    pub reply: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `chatCommands.list`, every mutation's result and `chatCommands.changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandsState {
    /// A–Z by name.
    pub commands: Vec<ChatCommand>,
    /// Whether the built-in `!commands` answers.
    pub list_enabled: bool,
}

impl Default for ChatCommandsState {
    fn default() -> Self {
        Self {
            commands: Vec::new(),
            list_enabled: true,
        }
    }
}

/// `chatCommands.save`: no `id` creates, an `id` replaces that command. The
/// name is normalized here (trim, one leading `!`, lowercase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandSaveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub reply: String,
    pub enabled: bool,
}

/// `chatCommands.delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandIdParams {
    pub id: String,
}

/// `chatCommands.setListEnabled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandsListEnabledParams {
    pub enabled: bool,
}

/// A save that passed every rule a single draft can break. The name's
/// uniqueness, the count cap and an unknown id are the store's to check,
/// inside its transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChatCommandDraft {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) reply: String,
    pub(crate) enabled: bool,
}

// --- Rules (the editor's, with its words) -----------------------------------

fn char_count(text: &str) -> usize {
    text.chars().count()
}

/// C0, C1 (DEL included) and the Unicode line and paragraph separators: what
/// "one line" forbids.
fn has_control(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
}

/// `!Go ` → `go`. Only one leading `!` is dropped.
pub(crate) fn normalize_name(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix('!')
        .unwrap_or(trimmed)
        .trim()
        .to_lowercase()
}

fn name_pattern_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
}

/// "!go already exists." The store says it too, from its transaction.
pub(crate) fn duplicate_name_error(name: &str) -> String {
    format!("!{name} already exists.")
}

/// The name problem, in the words the editor uses. `existing` is `(id, name)`
/// of every saved command; `id` is the command being edited.
pub(crate) fn name_error(raw: &str, existing: &[(&str, &str)], id: Option<&str>) -> Option<String> {
    let name = normalize_name(raw);
    if name.is_empty() {
        return Some("Name the command.".to_string());
    }
    if char_count(&name) > NAME_MAX_CHARS {
        return Some(format!("Keep the name to {NAME_MAX_CHARS} characters."));
    }
    if !name_pattern_ok(&name) {
        return Some("Use letters, numbers, _ and - only.".to_string());
    }
    if name == LIST_NAME {
        return Some(format!("!{LIST_NAME} is built in."));
    }
    if existing
        .iter()
        .any(|(other_id, other_name)| *other_name == name && Some(*other_id) != id)
    {
        return Some(duplicate_name_error(&name));
    }
    None
}

pub(crate) fn description_error(raw: &str) -> Option<String> {
    let description = raw.trim();
    if description.is_empty() {
        return Some("Add a short description.".to_string());
    }
    if has_control(description) {
        return Some("Keep the description on one line.".to_string());
    }
    if char_count(description) > DESCRIPTION_MAX_CHARS {
        return Some(format!(
            "Keep the description to {DESCRIPTION_MAX_CHARS} characters."
        ));
    }
    None
}

pub(crate) fn reply_error(raw: &str) -> Option<String> {
    let reply = raw.trim();
    if reply.is_empty() {
        return Some("Write the reply.".to_string());
    }
    if has_control(reply) {
        return Some("Keep the reply on one line.".to_string());
    }
    if char_count(reply) > REPLY_MAX_CHARS {
        return Some(format!("Keep the reply to {REPLY_MAX_CHARS} characters."));
    }
    None
}

/// The draft a save stores, or the first refusal (name, then description,
/// then reply). Uniqueness is checked again by the store, so a draft built
/// from a stale list can never duplicate a name.
pub(crate) fn validate_save(params: &ChatCommandSaveParams) -> Result<ChatCommandDraft> {
    if let Some(error) = name_error(&params.name, &[], None)
        .or_else(|| description_error(&params.description))
        .or_else(|| reply_error(&params.reply))
    {
        bail!(error);
    }
    Ok(ChatCommandDraft {
        name: normalize_name(&params.name),
        description: params.description.trim().to_string(),
        reply: params.reply.trim().to_string(),
        enabled: params.enabled,
    })
}

// --- The in-memory list and the RPCs ----------------------------------------

/// The commands and the switch as last saved. Loaded at startup and replaced
/// after every change, so chat delivery matches against memory and never
/// reads SQLite (plan 223's record-only tick trap: no sync SQLite on a tokio
/// worker on the hot path).
pub struct ChatCommandsRuntime {
    cache: StdMutex<Arc<ChatCommandsState>>,
    /// Serializes a state read with its `chatCommands.changed`, so the events
    /// leave in the order the changes happened.
    publication: StdMutex<()>,
}

impl ChatCommandsRuntime {
    /// The saved commands at startup. A read failure starts empty with the
    /// switch on and says so in the log; the next change reloads.
    pub(crate) fn load(database: &Database) -> Self {
        let state = database.chat_commands_state().unwrap_or_else(|error| {
            tracing::warn!("[chat-commands] could not load the saved commands: {error}");
            ChatCommandsState::default()
        });
        Self {
            cache: StdMutex::new(Arc::new(state)),
            publication: StdMutex::new(()),
        }
    }

    /// What delivery matches against: a cheap clone of the current list.
    pub(crate) fn snapshot(&self) -> Arc<ChatCommandsState> {
        self.cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn install(&self, state: ChatCommandsState) {
        *self.cache.lock().unwrap_or_else(|error| error.into_inner()) = Arc::new(state);
    }
}

/// `chatCommands.list`: read from the store, the authority.
pub(crate) fn list(state: &AppState) -> Result<ChatCommandsState> {
    state.database.chat_commands_state()
}

/// `chatCommands.save`: create or replace one command, then publish.
pub(crate) fn save(state: &AppState, params: &ChatCommandSaveParams) -> Result<ChatCommandsState> {
    let draft = validate_save(params)?;
    state
        .database
        .save_chat_command(params.id.as_deref(), &draft)?;
    on_chat_commands_changed(state)
}

/// `chatCommands.delete`.
pub(crate) fn delete(state: &AppState, id: &str) -> Result<ChatCommandsState> {
    state.database.delete_chat_command(id)?;
    on_chat_commands_changed(state)
}

/// `chatCommands.setListEnabled`: the `!commands` switch.
pub(crate) fn set_list_enabled(state: &AppState, enabled: bool) -> Result<ChatCommandsState> {
    state
        .database
        .save_setting(LIST_ENABLED_SETTING_KEY, &enabled)?;
    on_chat_commands_changed(state)
}

/// After every change: reload the list delivery matches against and send
/// `chatCommands.changed` with the whole state.
pub(crate) fn on_chat_commands_changed(state: &AppState) -> Result<ChatCommandsState> {
    let _publication = state
        .chat_commands
        .publication
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let current = state.database.chat_commands_state()?;
    state.chat_commands.install(current.clone());
    state.emit_event(CHANGED_EVENT, &current);
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::sync::broadcast;

    fn rules() -> Value {
        serde_json::from_str(include_str!(
            "../../../protocol-fixtures/chat-commands.json"
        ))
        .unwrap()
    }

    fn wire() -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .unwrap();
        fixture["chatCommand"].clone()
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn params(
        id: Option<&str>,
        name: &str,
        description: &str,
        reply: &str,
    ) -> ChatCommandSaveParams {
        ChatCommandSaveParams {
            id: id.map(str::to_string),
            name: name.to_string(),
            description: description.to_string(),
            reply: reply.to_string(),
            enabled: true,
        }
    }

    fn error_text(result: Result<ChatCommandsState>) -> String {
        result.expect_err("the save must be refused").to_string()
    }

    #[test]
    fn chat_commands_use_the_pinned_limits() {
        let limits = &rules()["limits"];
        assert_eq!(limits["nameMaxChars"], json!(NAME_MAX_CHARS));
        assert_eq!(limits["descriptionMaxChars"], json!(DESCRIPTION_MAX_CHARS));
        assert_eq!(limits["replyMaxChars"], json!(REPLY_MAX_CHARS));
        assert_eq!(limits["maxCount"], json!(MAX_COUNT));
        assert_eq!(limits["listName"], json!(LIST_NAME));
        assert!(REFUSAL_TOO_MANY.contains(&MAX_COUNT.to_string()));
    }

    #[test]
    fn chat_command_names_follow_the_pinned_cases() {
        let cases = rules()["names"].as_array().unwrap().clone();
        assert!(!cases.is_empty());
        for case in cases {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                normalize_name(input),
                case["normalized"].as_str().unwrap(),
                "normalized {input:?}"
            );
            let existing: Vec<(String, String)> = case["existing"]
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            (
                                row["id"].as_str().unwrap().to_string(),
                                row["name"].as_str().unwrap().to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let existing: Vec<(&str, &str)> = existing
                .iter()
                .map(|(id, name)| (id.as_str(), name.as_str()))
                .collect();
            assert_eq!(
                name_error(input, &existing, case["id"].as_str()),
                case["error"].as_str().map(str::to_string),
                "error for {input:?}"
            );
        }
    }

    #[test]
    fn chat_command_descriptions_and_replies_follow_the_pinned_cases() {
        let fixture = rules();
        for case in fixture["descriptions"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                description_error(input),
                case["error"].as_str().map(str::to_string),
                "description {input:?}"
            );
        }
        for case in fixture["replies"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                reply_error(input),
                case["error"].as_str().map(str::to_string),
                "reply {input:?}"
            );
        }
        // One line means no C1 controls and no Unicode separators either.
        assert!(reply_error("a\u{0085}b").is_some());
        assert!(reply_error("a\u{2028}b").is_some());
        assert!(description_error("tab\there").is_some());
    }

    #[test]
    fn chat_command_wire_shapes_match_the_pinned_fixture() {
        let fixture = wire();
        for key in ["command", "disabled"] {
            let command: ChatCommand = serde_json::from_value(fixture[key].clone()).unwrap();
            assert_eq!(
                serde_json::to_value(&command).unwrap(),
                fixture[key],
                "{key}"
            );
        }
        let command: ChatCommand = serde_json::from_value(fixture["command"].clone()).unwrap();
        let disabled: ChatCommand = serde_json::from_value(fixture["disabled"].clone()).unwrap();
        let state = ChatCommandsState {
            commands: vec![disabled, command],
            list_enabled: fixture["listEnabled"].as_bool().unwrap(),
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({
                "commands": [fixture["disabled"], fixture["command"]],
                "listEnabled": fixture["listEnabled"],
            })
        );
        assert_eq!(
            serde_json::to_value(ChatCommandsState::default()).unwrap(),
            json!({ "commands": [], "listEnabled": true })
        );
        let save: ChatCommandSaveParams =
            serde_json::from_value(fixture["saveParams"].clone()).unwrap();
        assert_eq!(save.id, None);
        assert_eq!(save.name, "!Go");
        // No id goes out as an absent key, never `null`.
        assert_eq!(serde_json::to_value(&save).unwrap(), fixture["saveParams"]);
        let with_id: ChatCommandSaveParams = serde_json::from_value(json!({
            "id": "8f14e45f-ceea-467a-9b1e-4f6c2d1a7b30",
            "name": "go", "description": "d", "reply": "r", "enabled": false
        }))
        .unwrap();
        assert_eq!(
            with_id.id.as_deref(),
            Some("8f14e45f-ceea-467a-9b1e-4f6c2d1a7b30")
        );
        let delete: ChatCommandIdParams =
            serde_json::from_value(json!({ "id": fixture["command"]["id"] })).unwrap();
        assert_eq!(delete.id, fixture["command"]["id"].as_str().unwrap());
        let toggle: ChatCommandsListEnabledParams =
            serde_json::from_value(json!({ "enabled": false })).unwrap();
        assert!(!toggle.enabled);
    }

    #[test]
    fn chat_commands_store_create_rename_and_list_a_to_z() {
        let state = test_state();
        let mut events = state.events.subscribe();
        assert_eq!(list(&state).unwrap(), ChatCommandsState::default());

        let saved = save(
            &state,
            &params(
                None,
                "!Stream ",
                " what today's stream is about ",
                "Building a chat bot.",
            ),
        )
        .unwrap();
        assert_eq!(saved.commands.len(), 1);
        let stream = saved.commands[0].clone();
        assert_eq!(stream.name, "stream");
        assert_eq!(stream.description, "what today's stream is about");
        assert!(uuid::Uuid::parse_str(&stream.id).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&stream.created_at).is_ok());
        let event = events.try_recv().unwrap();
        assert_eq!(event.event, CHANGED_EVENT);
        assert_eq!(event.payload, serde_json::to_value(&saved).unwrap());

        save(
            &state,
            &params(None, "go", "why I'm learning Go", "Go is fast."),
        )
        .unwrap();
        let listed = save(
            &state,
            &params(
                None,
                "FAQ",
                "most asked question",
                "Read the pinned message.",
            ),
        )
        .unwrap();
        let names: Vec<&str> = listed.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["faq", "go", "stream"]);
        assert!(listed.list_enabled);
        // The cache delivery matches against follows every change.
        assert_eq!(*state.chat_commands.snapshot(), listed);

        // Rename keeps the id and the creation time, and the order follows.
        let renamed = save(
            &state,
            &ChatCommandSaveParams {
                enabled: false,
                ..params(
                    Some(&stream.id),
                    "about",
                    "what today's stream is about",
                    "Building a bot.",
                )
            },
        )
        .unwrap();
        let about = renamed.commands.iter().find(|c| c.id == stream.id).unwrap();
        assert_eq!(about.name, "about");
        assert_eq!(about.reply, "Building a bot.");
        assert!(!about.enabled);
        assert_eq!(about.created_at, stream.created_at);
        let names: Vec<&str> = renamed.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["about", "faq", "go"]);
        // A command saved under its own name is not a duplicate of itself.
        save(&state, &params(Some(&stream.id), "About", "d", "r")).unwrap();
    }

    #[test]
    fn chat_commands_store_refuses_with_the_editors_words() {
        let state = test_state();
        let first = save(
            &state,
            &params(None, "go", "why I'm learning Go", "Go is fast."),
        )
        .unwrap();
        let go_id = first.commands[0].id.clone();
        let mut events = state.events.subscribe();

        assert_eq!(
            error_text(save(&state, &params(None, "!GO", "d", "r"))),
            "!go already exists."
        );
        let other = save(&state, &params(None, "faq", "d", "r")).unwrap();
        let faq_id = other.commands[0].id.clone();
        assert_eq!(other.commands[0].name, "faq");
        let _ = events.try_recv();
        assert_eq!(
            error_text(save(&state, &params(Some(&faq_id), "Go", "d", "r"))),
            "!go already exists."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "commands", "d", "r"))),
            "!commands is built in."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "", "d", "r"))),
            "Name the command."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "go now", "d", "r"))),
            "Use letters, numbers, _ and - only."
        );
        assert_eq!(
            error_text(save(&state, &params(None, &"a".repeat(25), "d", "r"))),
            "Keep the name to 24 characters."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", " ", "r"))),
            "Add a short description."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", &"d".repeat(61), "r"))),
            "Keep the description to 60 characters."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", "a\nb", "r"))),
            "Keep the description on one line."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", "d", ""))),
            "Write the reply."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", "d", "a\r\nb"))),
            "Keep the reply on one line."
        );
        assert_eq!(
            error_text(save(&state, &params(None, "x", "d", &"r".repeat(171)))),
            "Keep the reply to 170 characters."
        );
        assert_eq!(
            error_text(save(&state, &params(Some("not-a-saved-id"), "x", "d", "r"))),
            REFUSAL_GONE
        );
        // A refusal changes nothing and publishes nothing.
        assert!(events.try_recv().is_err());
        assert_eq!(list(&state).unwrap().commands.len(), 2);

        let after_delete = delete(&state, &go_id).unwrap();
        assert_eq!(after_delete.commands.len(), 1);
        assert_eq!(events.try_recv().unwrap().event, CHANGED_EVENT);
        assert_eq!(
            delete(&state, &go_id).unwrap_err().to_string(),
            REFUSAL_GONE
        );
        // The name is free again.
        save(&state, &params(None, "go", "d", "r")).unwrap();
    }

    #[test]
    fn chat_commands_store_caps_the_count_and_keeps_the_switch() {
        let state = test_state();
        for index in 0..MAX_COUNT {
            save(&state, &params(None, &format!("cmd{index:03}"), "d", "r")).unwrap();
        }
        assert_eq!(
            error_text(save(&state, &params(None, "one_more", "d", "r"))),
            REFUSAL_TOO_MANY
        );
        // Editing one of the hundred is still fine.
        let listed = list(&state).unwrap();
        assert_eq!(listed.commands.len(), MAX_COUNT);
        let first = listed.commands[0].clone();
        save(&state, &params(Some(&first.id), "renamed", "d", "r")).unwrap();

        let off = set_list_enabled(&state, false).unwrap();
        assert!(!off.list_enabled);
        assert!(!list(&state).unwrap().list_enabled);
        assert!(!state.chat_commands.snapshot().list_enabled);
        // A relaunch reads the same state back.
        let reloaded = ChatCommandsRuntime::load(&state.database);
        assert_eq!(*reloaded.snapshot(), list(&state).unwrap());
        assert!(set_list_enabled(&state, true).unwrap().list_enabled);
    }
}
