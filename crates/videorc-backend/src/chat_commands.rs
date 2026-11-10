//! Plan 226: chat commands. A viewer types `!go` in chat and Videorc answers
//! as the streamer with the reply they saved, starting with the viewer's
//! @name, in the chat the viewer asked in. `!commands` (built in) lists them.
//!
//! This is the Rust half of the contract `shared/chat-commands.ts` holds for
//! the editor: the wire types, the limits and the validation, with the same
//! words. `protocol-fixtures/chat-commands.json` pins the cases both languages
//! agree on; `protocol-fixtures/high-risk-contracts.json` (`chatCommand`)
//! pins the wire shapes. Lengths count Unicode code points in both.
//!
//! The reply engine (S2) runs at the end of chat delivery: it matches in
//! memory under its own short mutex, gates each message (new, not deleted,
//! not an echo of a Videorc post, fresh, not answered, off cooldown) and
//! spawns each send through `live_chat::send_live_chat_message`, so delivery
//! never waits on a reply.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::live_chat::{
    ChatSenderConfig, CommentsSendOperation, CommentsSendParams, CommentsWriteState,
    DestinationDelivery, DestinationDeliveryPhase, LiveChatEventType, LiveChatMessage,
    comments_destination_id, send_live_chat_message,
};
use crate::protocol::HealthLevel;
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::{StreamPlatform, stream_platform_id, stream_platform_label};
use crate::youtube_quota::BudgetCall;

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

/// `chatCommands.post`: the streamer typed `!go` (or `!commands`) in the
/// Stream Manager (D9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandPostParams {
    pub session_id: String,
    /// Without the `!`, any case. `commands` is the built-in list.
    pub name: String,
}

/// How many chats took the post and how many refused it (each refusal also
/// arrives as `chatCommands.replyFailed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandPostResult {
    pub sent: u32,
    pub failed: u32,
}

/// `chatCommands.replyFailed`: a reply that couldn't go out (D12), once per
/// destination and reason per live chat session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandReplyFailed {
    pub session_id: String,
    pub destination_id: String,
    pub platform: StreamPlatform,
    /// Without the `!`.
    pub command: String,
    /// The words the Stream Manager shows after "!go couldn't answer on
    /// YouTube: ".
    pub reason: String,
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
    /// The live chat session's answered ids, cooldowns, reported failures
    /// and Videorc's own recent posts. Held only for in-memory work.
    engine: StdMutex<Engine>,
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
            engine: StdMutex::new(Engine::default()),
        }
    }

    fn engine(&self) -> MutexGuard<'_, Engine> {
        self.engine
            .lock()
            .unwrap_or_else(|error| error.into_inner())
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

// --- The text a reply goes out as (pinned in chat-commands.json) -----------

/// Videorc's chat send takes 200 characters.
pub(crate) const SEND_MAX_CHARS: usize = 200;
/// X takes 140 a post; a longer reply goes out there in 2 posts.
pub(crate) const X_POST_MAX_CHARS: usize = crate::x_live::X_CHAT_MESSAGE_MAX_CHARS;

/// `@name ` for a viewer; nothing for the streamer (D10) or a name with
/// nothing in it. A name that already starts with `@` (a YouTube handle)
/// isn't doubled.
pub(crate) fn mention_prefix(author_name: &str, owner: bool) -> String {
    if owner {
        return String::new();
    }
    let name = author_name.trim().trim_start_matches('@').trim();
    if name.is_empty() {
        String::new()
    } else {
        format!("@{name} ")
    }
}

/// `@name reply`, or the reply alone when the mention would take it past
/// 200 characters (a name over 28): never cut.
pub(crate) fn compose_reply(prefix: &str, reply: &str) -> String {
    let text = format!("{prefix}{reply}");
    if char_count(&text) <= SEND_MAX_CHARS {
        text
    } else {
        reply.to_string()
    }
}

/// The built-in `!commands` answer for `(name, description)` A–Z: every
/// command with its description; when that doesn't fit, the names only; when
/// those don't fit either, as many names as fit and "and N more".
pub(crate) fn list_text(prefix: &str, commands: &[(&str, &str)]) -> String {
    let head = format!("{prefix}Commands: ");
    let full = format!(
        "{head}{}",
        commands
            .iter()
            .map(|(name, description)| format!("!{name} ({description})"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    if char_count(&full) <= SEND_MAX_CHARS {
        return full;
    }
    let names: Vec<String> = commands
        .iter()
        .map(|(name, _)| format!("!{name}"))
        .collect();
    let short = format!("{head}{}", names.join(" "));
    if char_count(&short) <= SEND_MAX_CHARS {
        return short;
    }
    let overflow =
        |taken: &[String], left: usize| format!("{head}{} and {left} more", taken.join(" "));
    let mut taken = 0;
    while taken < names.len()
        && char_count(&overflow(&names[..=taken], names.len() - taken - 1)) <= SEND_MAX_CHARS
    {
        taken += 1;
    }
    let text = overflow(&names[..taken], names.len() - taken);
    if char_count(&text) > SEND_MAX_CHARS && !prefix.is_empty() {
        // A mention so long that nothing fits: the list without it, the way
        // a reply drops it.
        return list_text("", commands);
    }
    text
}

/// X's posts for one message: the text when it fits 140, else 2 parts split
/// at the last space at or before 140 (when that space is past the middle),
/// else hard at 140. The mention stays on the first part.
pub(crate) fn x_split(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= X_POST_MAX_CHARS {
        return vec![text.to_string()];
    }
    let last = X_POST_MAX_CHARS.min(chars.len() - 1);
    let space = (0..=last).rev().find(|&index| chars[index] == ' ');
    let (first, second): (String, String) = match space {
        Some(index) if index >= X_POST_MAX_CHARS / 2 => (
            chars[..index]
                .iter()
                .collect::<String>()
                .trim_end()
                .to_string(),
            chars[index + 1..]
                .iter()
                .collect::<String>()
                .trim_start()
                .to_string(),
        ),
        _ => (
            chars[..X_POST_MAX_CHARS].iter().collect(),
            chars[X_POST_MAX_CHARS..].iter().collect(),
        ),
    };
    [first, second]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect()
}

/// The posts one destination gets for `text`: X splits, everyone else
/// takes it whole.
fn parts_for(platform: StreamPlatform, text: &str) -> Vec<String> {
    if platform == StreamPlatform::X {
        x_split(text)
    } else {
        vec![text.to_string()]
    }
}

// --- Matching (D5, D8) --------------------------------------------------------

/// The command a message's first word names, any case: `!GO please` → `go`.
/// `why !go` and a bare `!` name nothing.
pub(crate) fn first_word_command(text: &str) -> Option<String> {
    let word = text.split_whitespace().next()?;
    let name = word.strip_prefix('!')?;
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// What Videorc answers `!name` with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Resolved<'a> {
    Reply(&'a ChatCommand),
    /// The built-in `!commands`.
    List,
}

/// An enabled command by name; `commands` is the built-in list while its
/// switch is on and at least one command is enabled (D8: silent otherwise).
pub(crate) fn resolve<'a>(state: &'a ChatCommandsState, name: &str) -> Option<Resolved<'a>> {
    if name == LIST_NAME {
        return (state.list_enabled && state.commands.iter().any(|command| command.enabled))
            .then_some(Resolved::List);
    }
    state
        .commands
        .iter()
        .find(|command| command.enabled && command.name == name)
        .map(Resolved::Reply)
}

/// Whether Videorc answers this text itself. Buddy leaves such a message
/// alone (plan 226: the bubble never answers the same thing twice).
pub(crate) fn answers(state: &ChatCommandsState, text: &str) -> bool {
    first_word_command(text).is_some_and(|name| resolve(state, &name).is_some())
}

fn answer_text(state: &ChatCommandsState, resolved: Resolved<'_>, prefix: &str) -> String {
    match resolved {
        Resolved::Reply(command) => compose_reply(prefix, &command.reply),
        Resolved::List => {
            let mut enabled: Vec<(&str, &str)> = state
                .commands
                .iter()
                .filter(|command| command.enabled)
                .map(|command| (command.name.as_str(), command.description.as_str()))
                .collect();
            enabled.sort_by(|left, right| left.0.cmp(right.0));
            list_text(prefix, &enabled)
        }
    }
}

/// The streamer: YouTube's and X's `owner`, Twitch's and Kick's
/// `broadcaster` (the roles `cohost::normalize_role` reads as the owner).
pub(crate) fn is_streamer(message: &LiveChatMessage) -> bool {
    message.author_roles.iter().any(|role| {
        matches!(
            role.trim().to_ascii_lowercase().as_str(),
            "owner" | "broadcaster"
        )
    })
}

/// The name an @-mention needs: X's username; Twitch's login when the
/// display name is localized (it equals the login, ignoring case, for every
/// other name, and reads better); else the name chat shows.
pub(crate) fn mention_name(message: &LiveChatMessage) -> &str {
    let handle = message
        .author_handle
        .as_deref()
        .map(str::trim)
        .filter(|handle| !handle.is_empty());
    match handle {
        Some(handle)
            if !(message.platform == StreamPlatform::Twitch
                && message.author_name.trim().eq_ignore_ascii_case(handle)) =>
        {
            handle
        }
        _ => message.author_name.as_str(),
    }
}

// --- The engine (S2) ----------------------------------------------------------

pub(crate) const REPLY_FAILED_EVENT: &str = "chatCommands.replyFailed";
pub(crate) const REFUSAL_SESSION_ENDED: &str = "This chat session ended.";
/// D11: chat older than this never fires a command.
const FRESH_SECS: i64 = 60;
/// D6: once per command per chat in this long; YouTube's sends cost quota.
const COOLDOWN_SECS: i64 = 30;
const YOUTUBE_COOLDOWN_SECS: i64 = 60;
/// D10: how long a Videorc post's text marks its echo.
const OWN_SEND_ECHO_SECS: i64 = 120;
const OWN_SENDS_CAP: usize = 32;
const ANSWERED_CAP: usize = 2_048;
const ANSWERED_LOG_CODE: &str = "chat-command-answered";

/// The reasons the Stream Manager shows after "!go couldn't answer on
/// YouTube: " (D12). Stable words, so each is reported once.
pub(crate) const YOUTUBE_RUNG_REASON: &str =
    "command replies on YouTube are paused for today to save Videorc's daily YouTube limit.";
const YOUTUBE_LIMIT_REASON: &str =
    "chat posts are paused until Videorc's daily YouTube limit resets.";
const NOT_TAKING_POSTS_REASON: &str = "the chat isn't taking posts right now.";
const SEND_FAILED_REASON: &str = "Videorc couldn't send the post.";

fn reconnect_reason(platform: StreamPlatform) -> String {
    format!(
        "reconnect {} to allow chat posts.",
        stream_platform_label(platform)
    )
}

fn cooldown(platform: StreamPlatform) -> chrono::Duration {
    chrono::Duration::seconds(if platform == StreamPlatform::Youtube {
        YOUTUBE_COOLDOWN_SECS
    } else {
        COOLDOWN_SECS
    })
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A reply the gates let through, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedReply {
    session_id: String,
    destination_id: String,
    platform: StreamPlatform,
    /// Without the `!`.
    command: String,
    /// Mention included; X splits it at send.
    text: String,
}

#[derive(Debug, Default)]
struct Engine {
    session: Option<EngineSession>,
}

impl Engine {
    /// The live chat session's book; a new session starts a clean one.
    fn session(&mut self, session_id: &str) -> &mut EngineSession {
        if self
            .session
            .as_ref()
            .is_none_or(|session| session.session_id != session_id)
        {
            self.session = Some(EngineSession::new(session_id));
        }
        self.session
            .get_or_insert_with(|| EngineSession::new(session_id))
    }
}

/// One live chat session's bookkeeping, all bounded.
#[derive(Debug, Default)]
struct EngineSession {
    session_id: String,
    answered: HashSet<String>,
    answered_order: VecDeque<String>,
    /// `(destination, command)` → when it last fired.
    last_fired: HashMap<(String, String), DateTime<Utc>>,
    /// `(destination, reason)` already reported this session.
    reported: HashSet<(String, String)>,
    /// Videorc's own recent posts, whitespace collapsed.
    own_sends: VecDeque<(DateTime<Utc>, String)>,
}

impl EngineSession {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            ..Self::default()
        }
    }

    fn note_own_send(&mut self, text: &str, now: DateTime<Utc>) {
        let window = chrono::Duration::seconds(OWN_SEND_ECHO_SECS);
        self.own_sends
            .retain(|(at, _)| now.signed_duration_since(*at) < window);
        self.own_sends.push_back((now, collapse_whitespace(text)));
        while self.own_sends.len() > OWN_SENDS_CAP {
            self.own_sends.pop_front();
        }
    }

    fn is_own_echo(&self, text: &str, now: DateTime<Utc>) -> bool {
        let window = chrono::Duration::seconds(OWN_SEND_ECHO_SECS);
        let text = collapse_whitespace(text);
        self.own_sends
            .iter()
            .any(|(at, sent)| now.signed_duration_since(*at) < window && *sent == text)
    }

    fn remember_answered(&mut self, id: &str) {
        if self.answered.insert(id.to_string()) {
            self.answered_order.push_back(id.to_string());
        }
        while self.answered_order.len() > ANSWERED_CAP {
            if let Some(oldest) = self.answered_order.pop_front() {
                self.answered.remove(&oldest);
            }
        }
    }

    /// The match, then the gates in the plan's order: a new message (never
    /// a tombstone update), not deleted, not an echo of a Videorc post,
    /// published after the chat session started and within 60 s (D11), not
    /// answered already, and the `(destination, command)` cooldown free (D6).
    /// A message that passes is answered and starts the cooldown.
    fn plan(
        &mut self,
        commands: &ChatCommandsState,
        message: &LiveChatMessage,
        is_new: bool,
        started_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Option<PlannedReply> {
        if !matches!(
            message.event_type,
            LiveChatEventType::Message | LiveChatEventType::Paid
        ) {
            return None;
        }
        let name = first_word_command(&message.message_text)?;
        let resolved = resolve(commands, &name)?;
        if !is_new || message.is_deleted || self.is_own_echo(&message.message_text, now) {
            return None;
        }
        let published = DateTime::parse_from_rfc3339(message.published_at.trim())
            .ok()?
            .with_timezone(&Utc);
        if started_at.is_none_or(|started| published < started)
            || now.signed_duration_since(published) > chrono::Duration::seconds(FRESH_SECS)
        {
            return None;
        }
        if self.answered.contains(&message.id) {
            return None;
        }
        let destination_id =
            comments_destination_id(message.platform, message.target_id.as_deref());
        let key = (destination_id.clone(), name.clone());
        if self
            .last_fired
            .get(&key)
            .is_some_and(|at| now.signed_duration_since(*at) < cooldown(message.platform))
        {
            return None;
        }
        self.remember_answered(&message.id);
        self.last_fired.insert(key, now);
        let prefix = mention_prefix(mention_name(message), is_streamer(message));
        Some(PlannedReply {
            session_id: message.session_id.clone(),
            destination_id,
            platform: message.platform,
            command: name,
            text: answer_text(commands, resolved, &prefix),
        })
    }
}

/// Delivery hook, the last step of `live_chat::try_deliver_messages`, with
/// no lock held: match the persisted rows against the list in memory and
/// spawn one task per reply. Only rows that were new at ingest
/// (`new_message_ids`) can fire.
pub(crate) fn note_delivered_messages(
    state: &AppState,
    session_id: &str,
    started_at: Option<DateTime<Utc>>,
    messages: &[LiveChatMessage],
    new_message_ids: &HashSet<String>,
) {
    if !messages
        .iter()
        .any(|message| first_word_command(&message.message_text).is_some())
    {
        return;
    }
    let commands = state.chat_commands.snapshot();
    if commands.commands.is_empty() {
        return;
    }
    let now = Utc::now();
    let planned: Vec<PlannedReply> = {
        let mut engine = state.chat_commands.engine();
        let book = engine.session(session_id);
        messages
            .iter()
            .filter(|message| message.session_id == session_id)
            .filter_map(|message| {
                book.plan(
                    &commands,
                    message,
                    new_message_ids.contains(&message.id),
                    started_at,
                    now,
                )
            })
            .collect()
    };
    for reply in planned {
        let state = state.clone();
        tokio::spawn(async move { answer(&state, reply).await });
    }
}

/// Send hook (`execute_send_live_chat_message`): every Videorc post, so its
/// echo never fires a command (D10).
pub(crate) fn note_own_send(state: &AppState, session_id: &str, text: &str) {
    state
        .chat_commands
        .engine()
        .session(session_id)
        .note_own_send(text, Utc::now());
}

/// One destination as the running session has it.
#[derive(Debug, Clone)]
struct PostTarget {
    destination_id: String,
    platform: StreamPlatform,
    write: CommentsWriteState,
    /// A real YouTube sender: its posts spend the install's YouTube budget.
    /// Fake destinations never touch it.
    spends_youtube_quota: bool,
}

/// The running session's destinations, or `None` when `session_id` isn't
/// the running live chat session.
async fn post_targets(state: &AppState, session_id: &str) -> Option<Vec<PostTarget>> {
    let coordinator = state.live_chat.lock().await;
    if coordinator.session_id() != Some(session_id) {
        return None;
    }
    Some(
        coordinator
            .providers()
            .iter()
            .map(|provider| PostTarget {
                destination_id: provider.id.clone(),
                platform: provider.platform,
                write: provider.write,
                spends_youtube_quota: matches!(
                    coordinator.sender(&provider.id),
                    Some(ChatSenderConfig::YouTube { .. })
                ),
            })
            .collect(),
    )
}

/// One viewer reply, on its own task: only to the chat the viewer asked in.
async fn answer(state: &AppState, reply: PlannedReply) {
    let Some(target) = post_targets(state, &reply.session_id)
        .await
        .and_then(|targets| {
            targets
                .into_iter()
                .find(|target| target.destination_id == reply.destination_id)
        })
    else {
        return;
    };
    let outcome = match target.write {
        // A chat Videorc can read but not post to is skipped quietly; the
        // Stream Manager's chat strip already says so.
        CommentsWriteState::ReadOnly => return,
        CommentsWriteState::MissingScope => Err(reconnect_reason(reply.platform)),
        CommentsWriteState::Failed | CommentsWriteState::Unavailable => {
            Err(NOT_TAKING_POSTS_REASON.to_string())
        }
        // D7: viewer replies stop at 80% of the day's YouTube budget.
        CommentsWriteState::Ready
            if target.spends_youtube_quota
                && crate::youtube_quota::budget_refuses(state, BudgetCall::CommandReply)
                    .is_some() =>
        {
            Err(YOUTUBE_RUNG_REASON.to_string())
        }
        CommentsWriteState::Ready => {
            post_to(
                state,
                &reply.session_id,
                &reply.destination_id,
                reply.platform,
                &reply.text,
            )
            .await
        }
    };
    match outcome {
        Ok(()) => log_answered(state, &reply),
        Err(reason) => {
            report_failure(
                state,
                &reply.session_id,
                &reply.destination_id,
                reply.platform,
                &reply.command,
                &reason,
            )
            .await;
        }
    }
}

fn send_params(session_id: &str, text: String, destination_ids: Vec<String>) -> CommentsSendParams {
    CommentsSendParams {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        text,
        in_reply_to_question_id: None,
        destination_ids: Some(destination_ids),
    }
}

/// Posts `text` to one destination, in parts on X: each part waits for the
/// one before it, and a part that fails stops the rest.
async fn post_to(
    state: &AppState,
    session_id: &str,
    destination_id: &str,
    platform: StreamPlatform,
    text: &str,
) -> std::result::Result<(), String> {
    for part in parts_for(platform, text) {
        let operation = send_live_chat_message(
            state,
            send_params(session_id, part, vec![destination_id.to_string()]),
        )
        .await
        .map_err(|_| SEND_FAILED_REASON.to_string())?;
        delivery_outcome(&operation, destination_id, platform)?;
    }
    Ok(())
}

/// `chatCommands.post`'s path to one destination. The RPC is a mutation, and
/// the backend restarts on one that runs past its 10 s contract, so it waits
/// for the first post only (one provider deadline, 8 s). X's second part
/// follows in the background and reports its own failure.
async fn post_first_part(
    state: &AppState,
    session_id: &str,
    destination_id: &str,
    platform: StreamPlatform,
    command: &str,
    text: &str,
) -> std::result::Result<(), String> {
    let mut parts = parts_for(platform, text).into_iter();
    let Some(first) = parts.next() else {
        return Ok(());
    };
    let operation = send_live_chat_message(
        state,
        send_params(session_id, first, vec![destination_id.to_string()]),
    )
    .await
    .map_err(|_| SEND_FAILED_REASON.to_string())?;
    delivery_outcome(&operation, destination_id, platform)?;
    let rest: Vec<String> = parts.collect();
    if !rest.is_empty() {
        let state = state.clone();
        let session_id = session_id.to_string();
        let destination_id = destination_id.to_string();
        let command = command.to_string();
        tokio::spawn(async move {
            for part in rest {
                let outcome = match send_live_chat_message(
                    &state,
                    send_params(&session_id, part, vec![destination_id.clone()]),
                )
                .await
                {
                    Ok(operation) => delivery_outcome(&operation, &destination_id, platform),
                    Err(_) => Err(SEND_FAILED_REASON.to_string()),
                };
                if let Err(reason) = outcome {
                    report_failure(
                        &state,
                        &session_id,
                        &destination_id,
                        platform,
                        &command,
                        &reason,
                    )
                    .await;
                    break;
                }
            }
        });
    }
    Ok(())
}

fn delivery_outcome(
    operation: &CommentsSendOperation,
    destination_id: &str,
    platform: StreamPlatform,
) -> std::result::Result<(), String> {
    match operation
        .destinations
        .iter()
        .find(|delivery| delivery.destination_id == destination_id)
    {
        Some(delivery) if delivery.phase == DestinationDeliveryPhase::Sent => Ok(()),
        Some(delivery) => Err(failure_reason(platform, delivery)),
        None => Err(NOT_TAKING_POSTS_REASON.to_string()),
    }
}

/// A failed delivery in the Stream Manager's words: stable, so the same
/// cause is reported once per chat.
fn failure_reason(platform: StreamPlatform, delivery: &DestinationDelivery) -> String {
    let label = stream_platform_label(platform);
    match delivery.phase {
        DestinationDeliveryPhase::TimedOutUnknown => format!("{label} didn't answer in time."),
        DestinationDeliveryPhase::Failed
            if delivery.reason.as_deref().is_some_and(|reason| {
                reason == crate::youtube_quota::SEND_SHED_MESSAGE
                    || reason == crate::youtube_quota::SEND_PAUSED_MESSAGE
            }) =>
        {
            YOUTUBE_LIMIT_REASON.to_string()
        }
        DestinationDeliveryPhase::Failed => format!("{label} refused the post."),
        DestinationDeliveryPhase::Pending
        | DestinationDeliveryPhase::Sent
        | DestinationDeliveryPhase::ReadOnly
        | DestinationDeliveryPhase::Unavailable => NOT_TAKING_POSTS_REASON.to_string(),
    }
}

/// `chatCommands.replyFailed`, once per destination and reason per session.
/// A session that already ended has nobody to tell.
async fn report_failure(
    state: &AppState,
    session_id: &str,
    destination_id: &str,
    platform: StreamPlatform,
    command: &str,
    reason: &str,
) {
    if state.live_chat.lock().await.session_id() != Some(session_id) {
        return;
    }
    let first = state
        .chat_commands
        .engine()
        .session(session_id)
        .reported
        .insert((destination_id.to_string(), reason.to_string()));
    if !first {
        return;
    }
    tracing::info!(
        "[chat-commands] !{command} couldn't answer on {}: {reason}",
        stream_platform_id(platform)
    );
    state.emit_event(
        REPLY_FAILED_EVENT,
        ChatCommandReplyFailed {
            session_id: session_id.to_string(),
            destination_id: destination_id.to_string(),
            platform,
            command: command.to_string(),
            reason: reason.to_string(),
        },
    );
}

/// The session log line for an answered command. Never the viewer's text or
/// the reply.
fn log_answered(state: &AppState, reply: &PlannedReply) {
    let line = format!(
        "chat-command: !{} answered on {}",
        reply.command,
        stream_platform_id(reply.platform)
    );
    tracing::info!("{line}");
    if crate::replay_buffer::is_rowless_session(state, &reply.session_id) {
        return;
    }
    match state.database.add_session_log(
        &reply.session_id,
        HealthLevel::Info,
        ANSWERED_LOG_CODE,
        &line,
        None,
    ) {
        Ok(entry) => state.emit_event("session.log", entry),
        Err(error) => tracing::warn!("[chat-commands] could not log an answered command: {error}"),
    }
}

/// `chatCommands.post`: the streamer's `!go` in the Stream Manager (D9). The
/// reply (or the `!commands` list) goes out without a mention, once to every
/// chat that can take posts, under the ordinary send rules (never the 80%
/// rung, never a cooldown). X gets its parts. Each refusal also arrives as
/// `chatCommands.replyFailed`, once per chat and reason.
pub(crate) async fn post(
    state: &AppState,
    params: &ChatCommandPostParams,
) -> Result<ChatCommandPostResult> {
    let Some(targets) = post_targets(state, &params.session_id).await else {
        bail!(REFUSAL_SESSION_ENDED);
    };
    let name = normalize_name(&params.name);
    let commands = state.chat_commands.snapshot();
    let Some(resolved) = resolve(&commands, &name) else {
        bail!("No command called !{name}.");
    };
    let text = answer_text(&commands, resolved, "");
    let session_id = params.session_id.as_str();
    // Every chat that takes the text whole shares one post; X's parts go on
    // their own, and the RPC waits for X's first part only (`post_first_part`).
    let (whole, split): (Vec<PostTarget>, Vec<PostTarget>) = targets
        .into_iter()
        .filter(|target| target.write == CommentsWriteState::Ready)
        .partition(|target| parts_for(target.platform, &text).len() == 1);
    let post_whole = async {
        if whole.is_empty() {
            return Vec::new();
        }
        let ids = whole
            .iter()
            .map(|target| target.destination_id.clone())
            .collect();
        match send_live_chat_message(state, send_params(session_id, text.clone(), ids)).await {
            Ok(operation) => whole
                .iter()
                .map(|target| {
                    (
                        target.clone(),
                        delivery_outcome(&operation, &target.destination_id, target.platform),
                    )
                })
                .collect::<Vec<_>>(),
            Err(_) => whole
                .iter()
                .map(|target| (target.clone(), Err(SEND_FAILED_REASON.to_string())))
                .collect::<Vec<_>>(),
        }
    };
    let post_split = futures_util::future::join_all(split.iter().map(|target| async {
        let outcome = post_first_part(
            state,
            session_id,
            &target.destination_id,
            target.platform,
            &name,
            &text,
        )
        .await;
        (target.clone(), outcome)
    }));
    let (whole_outcomes, split_outcomes) = tokio::join!(post_whole, post_split);
    let mut result = ChatCommandPostResult { sent: 0, failed: 0 };
    for (target, outcome) in whole_outcomes.into_iter().chain(split_outcomes) {
        match outcome {
            Ok(()) => result.sent += 1,
            Err(reason) => {
                result.failed += 1;
                report_failure(
                    state,
                    session_id,
                    &target.destination_id,
                    target.platform,
                    &name,
                    &reason,
                )
                .await;
            }
        }
    }
    Ok(result)
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

    // --- S2: the reply engine ------------------------------------------------

    use crate::live_chat::{
        ChatSenderConfig, CommentsReadState, FakeChatSendBehavior, LiveChatProviderConnectionState,
        LiveChatProviderState, fake_message, live_chat_message_id, try_deliver_message,
    };
    use crate::protocol::ServerEvent;
    use std::time::Duration;

    const SESSION: &str = "session-1";

    fn command(name: &str, reply: &str, enabled: bool) -> ChatCommand {
        ChatCommand {
            id: format!("id-{name}"),
            name: name.to_string(),
            description: format!("about {name}"),
            reply: reply.to_string(),
            enabled,
            created_at: "2026-11-10T18:00:00Z".to_string(),
            updated_at: "2026-11-10T18:00:00Z".to_string(),
        }
    }

    fn commands_of(commands: Vec<ChatCommand>, list_enabled: bool) -> ChatCommandsState {
        ChatCommandsState {
            commands,
            list_enabled,
        }
    }

    /// The fake clock: seconds after the chat session started.
    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-10T18:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::seconds(seconds)
    }

    fn viewer(
        platform: StreamPlatform,
        target: &str,
        id: &str,
        author: &str,
        text: &str,
        published: DateTime<Utc>,
    ) -> LiveChatMessage {
        let mut message = fake_message(SESSION, platform, Some(target), 0);
        message.provider_message_id = id.to_string();
        message.id = live_chat_message_id(SESSION, platform, Some(target), id);
        message.author_id = Some(format!("author-{author}"));
        message.author_name = author.to_string();
        message.author_verified = None;
        message.message_text = text.to_string();
        message.published_at = published.to_rfc3339();
        message.received_at = published.to_rfc3339();
        message
    }

    fn twitch(id: &str, author: &str, text: &str, seconds: i64) -> LiveChatMessage {
        viewer(
            StreamPlatform::Twitch,
            "twitch-target",
            id,
            author,
            text,
            at(seconds),
        )
    }

    /// The reply one fresh message gets, or `None`.
    fn reply_to(commands: &ChatCommandsState, message: &LiveChatMessage) -> Option<String> {
        let published = DateTime::parse_from_rfc3339(&message.published_at)
            .unwrap()
            .with_timezone(&Utc);
        EngineSession::new(SESSION)
            .plan(commands, message, true, Some(at(0)), published)
            .map(|reply| reply.text)
    }

    #[test]
    fn chat_command_texts_follow_the_pinned_cases() {
        let fixture = rules();
        assert_eq!(fixture["limits"]["sendMaxChars"], json!(SEND_MAX_CHARS));
        assert_eq!(fixture["limits"]["xPostMaxChars"], json!(X_POST_MAX_CHARS));
        for case in fixture["mentions"].as_array().unwrap() {
            assert_eq!(
                mention_prefix(
                    case["authorName"].as_str().unwrap(),
                    case["owner"].as_bool().unwrap()
                ),
                case["prefix"].as_str().unwrap(),
                "mention {case}"
            );
        }
        for case in fixture["replyTexts"].as_array().unwrap() {
            assert_eq!(
                compose_reply(
                    case["prefix"].as_str().unwrap(),
                    case["reply"].as_str().unwrap()
                ),
                case["text"].as_str().unwrap()
            );
        }
        for case in fixture["lists"].as_array().unwrap() {
            let commands: Vec<(&str, &str)> = case["commands"]
                .as_array()
                .unwrap()
                .iter()
                .map(|command| {
                    (
                        command["name"].as_str().unwrap(),
                        command["description"].as_str().unwrap(),
                    )
                })
                .collect();
            let text = list_text(case["prefix"].as_str().unwrap(), &commands);
            assert_eq!(text, case["text"].as_str().unwrap());
            assert!(char_count(&text) <= SEND_MAX_CHARS);
        }
        for case in fixture["xPosts"].as_array().unwrap() {
            let posts = x_split(case["text"].as_str().unwrap());
            let expected: Vec<String> = serde_json::from_value(case["posts"].clone()).unwrap();
            assert_eq!(posts, expected);
            assert!(posts.len() <= 2);
            assert!(
                posts
                    .iter()
                    .all(|post| char_count(post) <= X_POST_MAX_CHARS)
            );
        }
        // Only X splits.
        let long = "word ".repeat(39).trim_end().to_string();
        assert_eq!(parts_for(StreamPlatform::Twitch, &long), vec![long.clone()]);
        assert_eq!(parts_for(StreamPlatform::X, &long).len(), 2);
    }

    #[test]
    fn chat_command_post_and_failure_wire_shapes_match_the_pinned_fixture() {
        let fixture = wire();
        let post: ChatCommandPostParams =
            serde_json::from_value(fixture["postParams"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&post).unwrap(), fixture["postParams"]);
        let result: ChatCommandPostResult =
            serde_json::from_value(fixture["postResult"].clone()).unwrap();
        assert_eq!(result, ChatCommandPostResult { sent: 2, failed: 1 });
        assert_eq!(serde_json::to_value(result).unwrap(), fixture["postResult"]);
        let failed: ChatCommandReplyFailed =
            serde_json::from_value(fixture["replyFailed"].clone()).unwrap();
        assert_eq!(failed.platform, StreamPlatform::Youtube);
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            fixture["replyFailed"]
        );
        assert_eq!(
            reconnect_reason(StreamPlatform::Youtube),
            fixture["replyFailed"]["reason"].as_str().unwrap()
        );
    }

    #[test]
    fn chat_commands_match_the_first_word_only() {
        let state = commands_of(
            vec![
                command("go", "Go is fast.", true),
                command("off", "Not today.", false),
            ],
            true,
        );
        assert_eq!(first_word_command("!GO please").as_deref(), Some("go"));
        assert_eq!(first_word_command("  !go").as_deref(), Some("go"));
        assert_eq!(first_word_command("why !go"), None);
        assert_eq!(first_word_command("!"), None);
        assert_eq!(first_word_command("go"), None);
        assert_eq!(first_word_command(""), None);
        assert!(answers(&state, "!go"));
        assert!(answers(&state, "!Go now"));
        assert!(!answers(&state, "!golang"));
        assert!(!answers(&state, "!!go"));
        assert!(!answers(&state, "!go,"));
        assert!(!answers(&state, "!nope"));
        assert!(!answers(&state, "I love !go"));
        assert!(!answers(&state, "!off"), "a disabled command never fires");
        assert!(answers(&state, "!commands"));
        assert!(!answers(
            &commands_of(state.commands.clone(), false),
            "!commands"
        ));
        assert!(
            !answers(
                &commands_of(vec![command("off", "r", false)], true),
                "!commands"
            ),
            "the list stays silent while no command is enabled"
        );
        assert!(!answers(&commands_of(Vec::new(), true), "!commands"));
        // The list leaves disabled commands out.
        let list = reply_to(&state, &twitch("m1", "dee", "!commands", 1)).unwrap();
        assert_eq!(list, "@dee Commands: !go (about go)");
    }

    #[test]
    fn chat_command_gates_hold_in_order_with_a_fake_clock() {
        let commands = commands_of(
            vec![
                command("go", "Go is fast.", true),
                command("faq", "Read the pin.", true),
            ],
            true,
        );
        let started = Some(at(0));
        let mut book = EngineSession::new(SESSION);
        let plan = |book: &mut EngineSession, message: &LiveChatMessage, new: bool, now: i64| {
            book.plan(&commands, message, new, started, at(now))
        };
        // An update (a tombstone replacing a row) never fires.
        assert!(plan(&mut book, &twitch("m1", "a", "!go", 10), false, 10).is_none());
        // A deletion never fires.
        let mut deleted = twitch("m2", "a", "!go", 10);
        deleted.is_deleted = true;
        assert!(plan(&mut book, &deleted, true, 10).is_none());
        // A system row never fires.
        let mut system = twitch("m2b", "a", "!go", 10);
        system.event_type = LiveChatEventType::System;
        assert!(plan(&mut book, &system, true, 10).is_none());
        // History: published before the chat session started.
        assert!(plan(&mut book, &twitch("m3", "a", "!go", -1), true, 1).is_none());
        // Older than 60 s.
        assert!(plan(&mut book, &twitch("m4", "a", "!go", 10), true, 71).is_none());
        // No session start known: nothing fires.
        assert!(
            book.plan(
                &commands,
                &twitch("m4b", "a", "!go", 10),
                true,
                None,
                at(10)
            )
            .is_none()
        );
        // An echo of a Videorc post, whitespace aside, for 120 s.
        book.note_own_send("!go   is the answer", at(10));
        assert!(
            plan(
                &mut book,
                &twitch("m5", "You", "!go is the answer", 11),
                true,
                11
            )
            .is_none()
        );
        let fired = plan(
            &mut book,
            &twitch("m6", "a", "!go is the answer", 130),
            true,
            130,
        )
        .expect("the echo ledger forgets after 120 s");
        assert_eq!(
            fired,
            PlannedReply {
                session_id: SESSION.to_string(),
                destination_id: "twitch-target".to_string(),
                platform: StreamPlatform::Twitch,
                command: "go".to_string(),
                text: "@a Go is fast.".to_string(),
            }
        );
        // The same message id again (a re-fetch) never fires twice.
        assert!(plan(&mut book, &twitch("m6", "a", "!go", 175), true, 175).is_none());
        // Twitch's cooldown: 29 s after is ignored, 31 s after fires.
        assert!(plan(&mut book, &twitch("m7", "b", "!GO now", 159), true, 159).is_none());
        // Another command and another chat each have their own cooldown.
        assert!(plan(&mut book, &twitch("m8", "b", "!faq", 159), true, 159).is_some());
        let kick = viewer(
            StreamPlatform::Kick,
            "kick-target",
            "k1",
            "b",
            "!go",
            at(159),
        );
        assert_eq!(
            plan(&mut book, &kick, true, 159).unwrap().destination_id,
            "kick-target"
        );
        assert!(plan(&mut book, &twitch("m9", "c", "!go", 161), true, 161).is_some());
        // YouTube's cooldown is 60 s.
        let youtube = |id: &str, seconds: i64| {
            viewer(
                StreamPlatform::Youtube,
                "youtube-target",
                id,
                "@viewer",
                "!go",
                at(seconds),
            )
        };
        assert!(plan(&mut book, &youtube("y1", 300), true, 300).is_some());
        assert!(plan(&mut book, &youtube("y2", 331), true, 331).is_none());
        assert!(plan(&mut book, &youtube("y3", 359), true, 359).is_none());
        assert!(plan(&mut book, &youtube("y4", 361), true, 361).is_some());
    }

    #[test]
    fn chat_command_replies_mention_the_viewer_the_way_their_chat_does() {
        let commands = commands_of(vec![command("go", "Go is fast.", true)], true);
        let reply = |message: LiveChatMessage| reply_to(&commands, &message).unwrap();
        assert_eq!(
            reply(twitch("m1", "coder_x", "!go", 1)),
            "@coder_x Go is fast."
        );
        // The streamer gets no mention: YouTube's owner, Twitch's broadcaster.
        for role in ["owner", "broadcaster", "Broadcaster"] {
            let mut own = twitch("m2", "TheStreamer", "!go", 1);
            own.author_roles = vec![role.to_string()];
            assert_eq!(reply(own), "Go is fast.", "{role}");
        }
        let mut moderator = twitch("m3", "mod_person", "!go", 1);
        moderator.author_roles = vec!["moderator".to_string()];
        assert_eq!(reply(moderator), "@mod_person Go is fast.");
        // A YouTube handle is never doubled.
        let handle = viewer(
            StreamPlatform::Youtube,
            "youtube-target",
            "y1",
            "@YouTubeViewer",
            "!go",
            at(1),
        );
        assert_eq!(reply(handle), "@YouTubeViewer Go is fast.");
        // A name that would take the reply past 200 drops the mention.
        let long_reply = commands_of(vec![command("go", &"r".repeat(170), true)], true);
        let long_name = twitch("m4", &"n".repeat(30), "!go", 1);
        assert_eq!(reply_to(&long_reply, &long_name).unwrap(), "r".repeat(170));
        let fits = twitch("m5", &"n".repeat(28), "!go", 1);
        assert_eq!(
            reply_to(&long_reply, &fits).unwrap(),
            format!("@{} {}", "n".repeat(28), "r".repeat(170))
        );
        // Twitch: the display name when it is the login; the login when the
        // display name is localized.
        let mut ascii = twitch("m6", "CoolViewer", "!go", 1);
        ascii.author_handle = Some("coolviewer".to_string());
        assert_eq!(reply(ascii), "@CoolViewer Go is fast.");
        let mut localized = twitch("m7", "表示名", "!go", 1);
        localized.author_handle = Some("hyoujimei".to_string());
        assert_eq!(reply(localized), "@hyoujimei Go is fast.");
        // X: the username, never the display name.
        let mut x = viewer(
            StreamPlatform::X,
            "x-target",
            "x1",
            "Viewer Name",
            "!go",
            at(1),
        );
        x.author_handle = Some("viewer".to_string());
        assert_eq!(reply(x), "@viewer Go is fast.");
    }

    fn provider(id: &str, platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            id: id.to_string(),
            platform,
            target_id: Some(id.to_string()),
            account_id: None,
            account_label: None,
            read: CommentsReadState::Ready,
            write: CommentsWriteState::Ready,
            moderate: None,
            state: LiveChatProviderConnectionState::Connected,
            message: "Comments connected.".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    async fn live_state(destinations: Vec<(&str, StreamPlatform, ChatSenderConfig)>) -> AppState {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session(SESSION)
            .unwrap();
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(
            SESSION.to_string(),
            destinations
                .iter()
                .map(|(id, platform, _)| provider(id, *platform))
                .collect(),
        );
        for (id, _, sender) in destinations {
            coordinator.register_sender(id.to_string(), sender);
        }
        drop(coordinator);
        state
    }

    fn fake(behavior: FakeChatSendBehavior) -> ChatSenderConfig {
        ChatSenderConfig::Fake(behavior)
    }

    async fn deliver(state: &AppState, message: LiveChatMessage) {
        let generation = state.live_chat.lock().await.session_generation();
        try_deliver_message(state, generation, message)
            .await
            .expect("delivered");
    }

    /// The next event `matches` takes within `within`, skipping the rest.
    async fn wait_for(
        events: &mut broadcast::Receiver<ServerEvent>,
        within: Duration,
        matches: impl Fn(&ServerEvent) -> bool,
    ) -> Option<Value> {
        tokio::time::timeout(within, async {
            loop {
                match events.recv().await {
                    Ok(event) if matches(&event) => return Some(event.payload),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    fn sent_operation(event: &ServerEvent) -> bool {
        event.event == "liveChat.sendOperation" && event.payload["phase"] == "sent"
    }

    fn now_message(
        platform: StreamPlatform,
        target: &str,
        id: &str,
        author: &str,
        text: &str,
    ) -> LiveChatMessage {
        viewer(platform, target, id, author, text, Utc::now())
    }

    #[tokio::test]
    async fn chat_command_reply_goes_only_to_the_asking_chat_and_never_holds_delivery() {
        let state = live_state(vec![
            (
                "twitch-target",
                StreamPlatform::Twitch,
                fake(FakeChatSendBehavior::Sent),
            ),
            (
                "kick-target",
                StreamPlatform::Kick,
                fake(FakeChatSendBehavior::Sent),
            ),
        ])
        .await;
        save(
            &state,
            &params(None, "go", "why I'm learning Go", "Go is fast."),
        )
        .unwrap();
        let mut events = state.events.subscribe();
        deliver(
            &state,
            now_message(
                StreamPlatform::Twitch,
                "twitch-target",
                "m1",
                "coder_x",
                "!GO please",
            ),
        )
        .await;
        // This test's runtime has one thread and the hook only spawns, so the
        // delivery is back before the reply's task ever ran.
        let mut early = Vec::new();
        while let Ok(event) = events.try_recv() {
            early.push(event.event);
        }
        assert!(
            early.iter().any(|event| event == "liveChat.message"),
            "{early:?}"
        );
        assert!(
            !early.iter().any(|event| event == "liveChat.sendOperation"),
            "delivery waited on the reply: {early:?}"
        );
        let sent = wait_for(&mut events, Duration::from_secs(5), sent_operation)
            .await
            .expect("the reply goes out");
        assert_eq!(sent["text"], "@coder_x Go is fast.");
        let destinations = sent["destinations"].as_array().unwrap();
        assert_eq!(destinations.len(), 1, "{sent}");
        assert_eq!(destinations[0]["destinationId"], "twitch-target");
        let log = wait_for(&mut events, Duration::from_secs(5), |event| {
            event.event == "session.log"
        })
        .await
        .expect("the answer is logged");
        assert_eq!(log["message"], "chat-command: !go answered on twitch");
        // Inside the cooldown, nothing more goes out; the other chat answers.
        deliver(
            &state,
            now_message(StreamPlatform::Twitch, "twitch-target", "m2", "ada", "!go"),
        )
        .await;
        deliver(
            &state,
            now_message(StreamPlatform::Kick, "kick-target", "k1", "bob", "!go"),
        )
        .await;
        let sent = wait_for(&mut events, Duration::from_secs(5), sent_operation)
            .await
            .expect("Kick answers");
        assert_eq!(sent["text"], "@bob Go is fast.");
        assert_eq!(sent["destinations"][0]["destinationId"], "kick-target");
        assert!(
            wait_for(&mut events, Duration::from_millis(300), sent_operation)
                .await
                .is_none()
        );
        assert_eq!(
            state
                .database
                .list_chat_send_operations(SESSION)
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn chat_command_youtube_replies_stop_at_the_80_percent_rung() {
        let state = live_state(vec![
            (
                "youtube-target",
                StreamPlatform::Youtube,
                ChatSenderConfig::YouTube {
                    access_token: "token".to_string(),
                    api_base_url: None,
                    live_chat_id: None,
                    token_source: crate::session_token::SessionTokenSource::Fixed,
                },
            ),
            (
                "youtube-fake",
                StreamPlatform::Youtube,
                fake(FakeChatSendBehavior::Sent),
            ),
        ])
        .await;
        save(
            &state,
            &params(None, "go", "why I'm learning Go", "Go is fast."),
        )
        .unwrap();
        save(
            &state,
            &params(None, "faq", "most asked question", "Read the pin."),
        )
        .unwrap();
        crate::youtube_quota::set_daily_budget_limit(&state, Some(60));
        crate::youtube_quota::record_call(
            &state,
            crate::youtube_quota::YouTubeEndpoint::LiveChatMessagesInsert,
        );
        assert_eq!(
            crate::youtube_quota::budget_status(&state).step,
            crate::youtube_quota::BudgetStep::ShedExtras
        );
        let mut events = state.events.subscribe();
        let is_failure = |event: &ServerEvent| event.event == REPLY_FAILED_EVENT;
        deliver(
            &state,
            now_message(
                StreamPlatform::Youtube,
                "youtube-target",
                "y1",
                "@YouTubeViewer",
                "!go",
            ),
        )
        .await;
        let failed = wait_for(&mut events, Duration::from_secs(5), is_failure)
            .await
            .expect("the rung is reported");
        assert_eq!(
            failed,
            json!({
                "sessionId": SESSION,
                "destinationId": "youtube-target",
                "platform": "youtube",
                "command": "go",
                "reason": YOUTUBE_RUNG_REASON,
            })
        );
        // The same chat and reason are reported once a session.
        deliver(
            &state,
            now_message(
                StreamPlatform::Youtube,
                "youtube-target",
                "y2",
                "@Other",
                "!faq",
            ),
        )
        .await;
        assert!(
            wait_for(&mut events, Duration::from_millis(300), is_failure)
                .await
                .is_none()
        );
        assert!(
            state
                .database
                .list_chat_send_operations(SESSION)
                .unwrap()
                .is_empty(),
            "nothing was posted past the rung"
        );
        // A fake YouTube chat never asks the budget, and never spends it.
        deliver(
            &state,
            now_message(
                StreamPlatform::Youtube,
                "youtube-fake",
                "f1",
                "@YouTubeViewer",
                "!go",
            ),
        )
        .await;
        let sent = wait_for(&mut events, Duration::from_secs(5), sent_operation)
            .await
            .expect("the fake answers");
        assert_eq!(sent["text"], "@YouTubeViewer Go is fast.");
        assert_eq!(sent["destinations"][0]["destinationId"], "youtube-fake");
        assert_eq!(crate::youtube_quota::daily_usage(&state).units, 50);
        // The streamer's own `!go` is a send, not a reply: the rung never
        // stops it (this YouTube chat then fails on its own: no chat id).
        let result = post(
            &state,
            &ChatCommandPostParams {
                session_id: SESSION.to_string(),
                name: "!GO".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result, ChatCommandPostResult { sent: 1, failed: 1 });
        let failed = wait_for(&mut events, Duration::from_secs(5), is_failure)
            .await
            .expect("a new reason is reported");
        assert_eq!(failed["reason"], "YouTube refused the post.");
        assert_eq!(failed["destinationId"], "youtube-target");
    }

    #[tokio::test]
    async fn chat_command_post_reaches_every_chat_and_its_echo_is_never_answered() {
        let state = live_state(vec![
            (
                "twitch-target",
                StreamPlatform::Twitch,
                fake(FakeChatSendBehavior::Sent),
            ),
            (
                "kick-target",
                StreamPlatform::Kick,
                fake(FakeChatSendBehavior::Failed),
            ),
        ])
        .await;
        save(
            &state,
            &params(None, "faq", "most asked question", "Read the pin."),
        )
        .unwrap();
        save(
            &state,
            &params(
                None,
                "links",
                "where to find me",
                "!faq has more, and the links are in the panel.",
            ),
        )
        .unwrap();
        let mut events = state.events.subscribe();
        let is_failure = |event: &ServerEvent| event.event == REPLY_FAILED_EVENT;

        // A viewer reply that fails is reported once for its chat and reason.
        deliver(
            &state,
            now_message(StreamPlatform::Kick, "kick-target", "k1", "viewer", "!faq"),
        )
        .await;
        let failed = wait_for(&mut events, Duration::from_secs(5), is_failure)
            .await
            .expect("the failure is reported");
        assert_eq!(failed["destinationId"], "kick-target");
        assert_eq!(failed["platform"], "kick");
        assert_eq!(failed["command"], "faq");
        assert_eq!(failed["reason"], "Kick refused the post.");

        // The streamer's post goes to every chat, without a mention.
        let result = post(
            &state,
            &ChatCommandPostParams {
                session_id: SESSION.to_string(),
                name: "links".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result, ChatCommandPostResult { sent: 1, failed: 1 });
        let operations = state.database.list_chat_send_operations(SESSION).unwrap();
        let posted = operations
            .iter()
            .find(|operation| operation.text.starts_with("!faq has more"))
            .expect("the post");
        assert_eq!(posted.destinations.len(), 2);
        // Kick failed again for the same reason: no second notice.
        assert!(
            wait_for(&mut events, Duration::from_millis(300), is_failure)
                .await
                .is_none()
        );

        // Its echo (the streamer's own row, first word `!faq`) never fires.
        let before = state
            .database
            .list_chat_send_operations(SESSION)
            .unwrap()
            .len();
        let mut echo = now_message(
            StreamPlatform::Twitch,
            "twitch-target",
            "echo-1",
            "You",
            "!faq has more, and the links are in the panel.",
        );
        echo.author_roles = vec!["broadcaster".to_string()];
        deliver(&state, echo).await;
        assert!(
            wait_for(&mut events, Duration::from_millis(300), sent_operation)
                .await
                .is_none()
        );
        assert_eq!(
            state
                .database
                .list_chat_send_operations(SESSION)
                .unwrap()
                .len(),
            before
        );
        // The streamer typing `!faq` on the platform's own site is answered,
        // without a mention (D10).
        let mut typed = now_message(
            StreamPlatform::Twitch,
            "twitch-target",
            "own-1",
            "You",
            "!faq",
        );
        typed.author_roles = vec!["broadcaster".to_string()];
        deliver(&state, typed).await;
        let sent = wait_for(&mut events, Duration::from_secs(5), sent_operation)
            .await
            .expect("the streamer's own !faq is answered");
        assert_eq!(sent["text"], "Read the pin.");
    }

    #[tokio::test]
    async fn chat_command_post_refuses_an_ended_session_and_an_unknown_name() {
        let state = live_state(vec![(
            "twitch-target",
            StreamPlatform::Twitch,
            fake(FakeChatSendBehavior::Sent),
        )])
        .await;
        save(&state, &params(None, "go", "d", "Go is fast.")).unwrap();
        let post_named = |session: &str, name: &str| ChatCommandPostParams {
            session_id: session.to_string(),
            name: name.to_string(),
        };
        assert_eq!(
            post(&state, &post_named("session-2", "go"))
                .await
                .unwrap_err()
                .to_string(),
            REFUSAL_SESSION_ENDED
        );
        assert_eq!(
            post(&state, &post_named(SESSION, "nope"))
                .await
                .unwrap_err()
                .to_string(),
            "No command called !nope."
        );
        set_list_enabled(&state, false).unwrap();
        assert_eq!(
            post(&state, &post_named(SESSION, "commands"))
                .await
                .unwrap_err()
                .to_string(),
            "No command called !commands."
        );
        set_list_enabled(&state, true).unwrap();
        let result = post(&state, &post_named(SESSION, "!Commands"))
            .await
            .unwrap();
        assert_eq!(result, ChatCommandPostResult { sent: 1, failed: 0 });
        let operations = state.database.list_chat_send_operations(SESSION).unwrap();
        assert_eq!(operations[0].text, "Commands: !go (d)");
        crate::live_chat::stop_live_chat(&state).await;
        assert_eq!(
            post(&state, &post_named(SESSION, "go"))
                .await
                .unwrap_err()
                .to_string(),
            REFUSAL_SESSION_ENDED
        );
    }
}
