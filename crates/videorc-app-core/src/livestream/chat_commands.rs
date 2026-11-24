//! Plan 226's chat commands as the app's screens read them
//! (`shared/chat-commands.ts`, the half both screens share): the wire
//! types, the limits and the editor's validation in the words the backend
//! also uses. Pure: the Studio's `studio/chat_commands_store.rs` owns the
//! state and the requests, the Stream Manager's `!` rules are
//! [`crate::stream_manager::chat_commands`]'s, and the editor's own words
//! are the Livestream page's.
//!
//! A viewer types `!go` and Videorc answers as the streamer with the reply
//! saved on Livestream → Setup → Chat commands, starting with the viewer's
//! @name, in the chat they asked in. `!commands` (built in) lists them. The
//! backend posts the replies (`chat_commands.rs`); nothing here posts.

use serde::{Deserialize, Serialize};

/// The built-in command's name. Nobody can save a command with it.
pub const LIST_NAME: &str = "commands";
pub const NAME_MAX_CHARS: usize = 24;
pub const DESCRIPTION_MAX_CHARS: usize = 60;
/// 200 (Videorc's chat send) minus room for `@name ` (plan 226 D2).
pub const REPLY_MAX_CHARS: usize = 170;
pub const MAX_COUNT: usize = 100;
/// X takes 140 characters a post; a longer reply goes out in 2 posts there.
pub const X_POST_MAX_CHARS: usize = 140;
/// The most reply failures the Stream Manager carries for one live chat session.
pub const FAILURES_MAX: usize = 20;
/// The mention the editor's X note counts with: a typical `@name `.
pub const TYPICAL_MENTION: &str = "@viewer_name ";

/// `chatCommands.list`.
pub const LIST_METHOD: &str = "chatCommands.list";
pub const SAVE_METHOD: &str = "chatCommands.save";
pub const DELETE_METHOD: &str = "chatCommands.delete";
pub const SET_LIST_ENABLED_METHOD: &str = "chatCommands.setListEnabled";
pub const POST_METHOD: &str = "chatCommands.post";
/// Every change, with the whole state.
pub const CHANGED_EVENT: &str = "chatCommands.changed";
/// A reply that couldn't go out, once per chat and reason (plan 226 D12).
pub const REPLY_FAILED_EVENT: &str = "chatCommands.replyFailed";

/// One saved command, as the backend stores and sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommand {
    pub id: String,
    /// Lowercase, without the `!`: `go`.
    pub name: String,
    /// One line, shown by `!commands`: "why I'm learning Go".
    pub description: String,
    /// One line, sent as `@viewer <reply>`.
    pub reply: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `chatCommands.list`, every mutation's result and `chatCommands.changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandsState {
    /// A–Z by name.
    pub commands: Vec<ChatCommand>,
    /// Whether the built-in `!commands` answers.
    pub list_enabled: bool,
}

/// `chatCommands.save`: no `id` creates, an `id` replaces that command.
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

/// How many chats took the streamer's post and how many refused it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandPostResult {
    pub sent: u32,
    pub failed: u32,
}

/// `chatCommands.replyFailed` (plan 226 D12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandReplyFailed {
    pub session_id: String,
    pub destination_id: String,
    pub platform: String,
    /// Without the `!`.
    pub command: String,
    /// The words the Stream Manager shows after "!go couldn't answer on YouTube: ".
    pub reason: String,
}

/// What the Stream Manager carries: enabled commands only, A–Z.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatCommandSummary {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatCommandsSummary {
    pub commands: Vec<ChatCommandSummary>,
    pub list_enabled: bool,
}

/// `chatCommandsSummary`: the projection the Stream Manager reads.
pub fn summary(state: &ChatCommandsState) -> ChatCommandsSummary {
    ChatCommandsSummary {
        commands: state
            .commands
            .iter()
            .filter(|command| command.enabled)
            .map(|command| ChatCommandSummary {
                name: command.name.clone(),
                description: command.description.clone(),
            })
            .collect(),
        list_enabled: state.list_enabled,
    }
}

/// Length the way both languages count it: Unicode code points.
pub fn text_length(text: &str) -> usize {
    text.chars().count()
}

/// `!Go ` → `go`. Only one leading `!` is dropped.
pub fn normalize_name(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix('!')
        .unwrap_or(trimmed)
        .trim()
        .to_lowercase()
}

fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}')
}

/// A pasted line break becomes a space, the way the editor shows it.
pub fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '\n' | '\u{2028}' | '\u{2029}' => out.push(' '),
            c if is_control(c) => {}
            c => out.push(c),
        }
    }
    out
}

/// The editor's draft.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Draft {
    /// The command being edited; absent when adding.
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub reply: String,
}

/// The editor's fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Name,
    Description,
    Reply,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DraftErrors {
    pub name: Option<String>,
    pub description: Option<String>,
    pub reply: Option<String>,
}

impl DraftErrors {
    pub fn get(&self, field: Field) -> Option<&str> {
        match field {
            Field::Name => self.name.as_deref(),
            Field::Description => self.description.as_deref(),
            Field::Reply => self.reply.as_deref(),
        }
    }
}

/// The validation's words (`chatCommandNameError` and its siblings): the
/// backend writes the same ones, so a refusal lands under its field.
pub mod copy {
    pub const NAME_THE_COMMAND: &str = "Name the command.";
    pub const NAME_CHARACTERS: &str = "Use letters, numbers, _ and - only.";
    pub const ADD_A_DESCRIPTION: &str = "Add a short description.";
    pub const DESCRIPTION_ONE_LINE: &str = "Keep the description on one line.";
    pub const WRITE_THE_REPLY: &str = "Write the reply.";
    pub const REPLY_ONE_LINE: &str = "Keep the reply on one line.";

    pub fn keep_name(max: usize) -> String {
        format!("Keep the name to {max} characters.")
    }
    pub fn built_in(name: &str) -> String {
        format!("!{name} is built in.")
    }
    pub fn already_exists(name: &str) -> String {
        format!("!{name} already exists.")
    }
    pub fn keep_description(max: usize) -> String {
        format!("Keep the description to {max} characters.")
    }
    pub fn keep_reply(max: usize) -> String {
        format!("Keep the reply to {max} characters.")
    }
}

fn name_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
}

/// The name problem, in the words the editor and the backend both use.
pub fn name_error(raw: &str, existing: &[ChatCommand], id: Option<&str>) -> Option<String> {
    let name = normalize_name(raw);
    if name.is_empty() {
        return Some(copy::NAME_THE_COMMAND.to_string());
    }
    if text_length(&name) > NAME_MAX_CHARS {
        return Some(copy::keep_name(NAME_MAX_CHARS));
    }
    if !name.chars().all(name_char) {
        return Some(copy::NAME_CHARACTERS.to_string());
    }
    if name == LIST_NAME {
        return Some(copy::built_in(LIST_NAME));
    }
    if existing
        .iter()
        .any(|command| command.name == name && Some(command.id.as_str()) != id)
    {
        return Some(copy::already_exists(&name));
    }
    None
}

pub fn description_error(raw: &str) -> Option<String> {
    let description = raw.trim();
    if description.is_empty() {
        return Some(copy::ADD_A_DESCRIPTION.to_string());
    }
    if description.chars().any(is_control) {
        return Some(copy::DESCRIPTION_ONE_LINE.to_string());
    }
    if text_length(description) > DESCRIPTION_MAX_CHARS {
        return Some(copy::keep_description(DESCRIPTION_MAX_CHARS));
    }
    None
}

pub fn reply_error(raw: &str) -> Option<String> {
    let reply = raw.trim();
    if reply.is_empty() {
        return Some(copy::WRITE_THE_REPLY.to_string());
    }
    if reply.chars().any(is_control) {
        return Some(copy::REPLY_ONE_LINE.to_string());
    }
    if text_length(reply) > REPLY_MAX_CHARS {
        return Some(copy::keep_reply(REPLY_MAX_CHARS));
    }
    None
}

/// None when the draft can be saved.
pub fn validate_draft(draft: &Draft, existing: &[ChatCommand]) -> Option<DraftErrors> {
    let errors = DraftErrors {
        name: name_error(&draft.name, existing, draft.id.as_deref()),
        description: description_error(&draft.description),
        reply: reply_error(&draft.reply),
    };
    (errors.name.is_some() || errors.description.is_some() || errors.reply.is_some())
        .then_some(errors)
}

/// How many characters the reply has left; negative when it is over.
pub fn reply_room(reply: &str) -> i64 {
    REPLY_MAX_CHARS as i64 - text_length(reply.trim()) as i64
}

/// True when `@viewer_name <reply>` won't fit one X post, so X gets it in 2.
pub fn needs_two_x_posts(reply: &str) -> bool {
    text_length(TYPICAL_MENTION) + text_length(reply.trim()) > X_POST_MAX_CHARS
}

/// A `chatCommands.save` refusal the backend wrote in the editor's own words
/// ("!go already exists."), with the field it is about, so the dialog shows
/// it under that field. None for any other failure (`chatCommandRefusal`).
pub fn refusal(raw: &str) -> Option<(Field, String)> {
    let found = |needle: &str| raw.contains(needle).then(|| needle.to_string());
    let name_rules = [
        copy::NAME_THE_COMMAND.to_string(),
        copy::keep_name(NAME_MAX_CHARS),
        copy::NAME_CHARACTERS.to_string(),
        copy::built_in(LIST_NAME),
    ];
    for text in name_rules {
        if let Some(sentence) = found(&text) {
            return Some((Field::Name, sentence));
        }
    }
    // `REFUSALS`' fifth: "!<name> already exists.", before the other fields.
    if let Some(sentence) = already_exists_sentence(raw) {
        return Some((Field::Name, sentence));
    }
    for (field, text) in [
        (Field::Description, copy::ADD_A_DESCRIPTION.to_string()),
        (Field::Description, copy::DESCRIPTION_ONE_LINE.to_string()),
        (
            Field::Description,
            copy::keep_description(DESCRIPTION_MAX_CHARS),
        ),
        (Field::Reply, copy::WRITE_THE_REPLY.to_string()),
        (Field::Reply, copy::REPLY_ONE_LINE.to_string()),
        (Field::Reply, copy::keep_reply(REPLY_MAX_CHARS)),
    ] {
        if let Some(sentence) = found(&text) {
            return Some((field, sentence));
        }
    }
    None
}

/// `/![a-z0-9_-]+ already exists\./`: the first match in the message.
fn already_exists_sentence(raw: &str) -> Option<String> {
    let tail = copy::already_exists("");
    let tail = &tail[1..];
    let mut search = 0;
    while let Some(start) = raw[search..].find('!') {
        let start = search + start;
        let rest = &raw[start + 1..];
        let name_end = rest.find(|c: char| !name_char(c)).unwrap_or(rest.len());
        if name_end > 0 && rest[name_end..].starts_with(tail) {
            let end = start + 1 + name_end + tail.len();
            return Some(raw[start..end].to_string());
        }
        search = start + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(name: &str, enabled: bool) -> ChatCommand {
        ChatCommand {
            id: format!("id-{name}"),
            name: name.to_string(),
            description: format!("about {name}"),
            reply: "reply".to_string(),
            enabled,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn the_name_is_normalised_and_checked_in_the_shared_words() {
        assert_eq!(normalize_name(" !Go "), "go");
        assert_eq!(normalize_name("!!go"), "!go");
        let existing = [command("go", true)];
        assert_eq!(
            name_error("", &existing, None).as_deref(),
            Some("Name the command.")
        );
        assert_eq!(
            name_error("go now", &existing, None).as_deref(),
            Some("Use letters, numbers, _ and - only.")
        );
        assert_eq!(
            name_error("commands", &existing, None).as_deref(),
            Some("!commands is built in.")
        );
        assert_eq!(
            name_error("GO", &existing, None).as_deref(),
            Some("!go already exists.")
        );
        assert_eq!(name_error("GO", &existing, Some("id-go")), None);
        assert_eq!(
            name_error(&"a".repeat(25), &existing, None).as_deref(),
            Some("Keep the name to 24 characters.")
        );
        assert_eq!(
            description_error("two\nlines").as_deref(),
            Some("Keep the description on one line.")
        );
        assert_eq!(reply_error("  ").as_deref(), Some("Write the reply."));
        assert_eq!(
            reply_error(&"x".repeat(171)).as_deref(),
            Some("Keep the reply to 170 characters.")
        );
        let ok = Draft {
            id: None,
            name: "faq".into(),
            description: "most asked".into(),
            reply: "read the pin".into(),
        };
        assert_eq!(validate_draft(&ok, &existing), None);
        let bad = Draft {
            name: "go".into(),
            ..ok
        };
        assert_eq!(
            validate_draft(&bad, &existing).unwrap().name.as_deref(),
            Some("!go already exists.")
        );
    }

    #[test]
    fn a_line_break_becomes_a_space_and_the_room_counts_code_points() {
        assert_eq!(one_line("a\r\nb\nc\u{2028}d\u{7}e"), "a b c de");
        assert_eq!(reply_room(""), 170);
        assert_eq!(reply_room(&"é".repeat(172)), -2);
        assert!(!needs_two_x_posts(&"x".repeat(127)));
        assert!(needs_two_x_posts(&"x".repeat(128)));
    }

    #[test]
    fn a_name_that_exists_wins_over_the_other_fields_as_in_electron() {
        assert_eq!(
            refusal("!go already exists. Write the reply."),
            Some((Field::Name, "!go already exists.".to_string()))
        );
        assert_eq!(
            refusal("Add a short description. !go already exists."),
            Some((Field::Name, "!go already exists.".to_string()))
        );
        assert_eq!(
            refusal("Name the command. !go already exists."),
            Some((Field::Name, "Name the command.".to_string()))
        );
    }

    #[test]
    fn a_refusal_lands_under_its_field() {
        assert_eq!(
            refusal("chat-command-save-failed: !go already exists."),
            Some((Field::Name, "!go already exists.".to_string()))
        );
        assert_eq!(
            refusal("Keep the reply to 170 characters."),
            Some((
                Field::Reply,
                "Keep the reply to 170 characters.".to_string()
            ))
        );
        assert_eq!(
            refusal("Add a short description."),
            Some((Field::Description, "Add a short description.".to_string()))
        );
        assert_eq!(refusal("the database is locked"), None);
    }

    #[test]
    fn the_summary_keeps_enabled_commands_and_the_switch() {
        let state = ChatCommandsState {
            commands: vec![command("faq", true), command("go", false)],
            list_enabled: true,
        };
        let projected = summary(&state);
        assert_eq!(projected.commands.len(), 1);
        assert_eq!(projected.commands[0].name, "faq");
        assert!(projected.list_enabled);
    }
}
