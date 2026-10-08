//! Golem voice commands (plan 140 S2): the pure command detector.
//!
//! Transcript finals arrive as text (fixed 3 s listen chunks, or realtime
//! completions). The detector keeps a rolling ten-second word window across
//! them, so a command split over two finals still matches, and returns a typed
//! [`DetectedCommand`] when the newest final completes one. It knows nothing
//! of chat, sessions or the clock: `observe_final` takes the arrival instant
//! and a [`DetectContext`] (what the engine is waiting for) and returns a
//! command or nothing. Resolving names and acting is S3's
//! (`cohost::dispatch_detected_command`).
//!
//! Grammar (plan 140 decisions 2 and 3; plan 164 D2). The wake word "golem",
//! or a word of the persona's own name (`wake_words`), starts a command;
//! words before it are ignored. The old "Orcle" spellings stay as hidden
//! aliases for one release. Two structured phrases work
//! without the wake word unless `require_wake_word` is set: a removal that
//! points at a message ("remove it from our chat", "delete that message",
//! "this one is toxic, remove it") and a highlight by name with a comment noun
//! ("highlight the comment from coders x"). The noun decides clear versus
//! remove: screen, stream, overlay and highlight clear the on-stream card; chat
//! removes the message. Answers ("yes", "no", "remove it") count without the
//! wake word only while a removal card is open, and choices ("the first one")
//! only while a chooser is open. `Unknown` is rare on purpose: only a clearly
//! addressed "Golem" followed by a closed sentence that matches nothing. When
//! unsure, the detector says nothing.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use crate::cohost_ack::is_stop_word;

/// Words older than this leave the window: a command split over two finals
/// still matches, a sentence from a minute ago never completes one.
pub const COMMAND_WINDOW: Duration = Duration::from_secs(10);
/// The same command (kind and target) within this long is the same request.
pub const COMMAND_DEDUPE: Duration = Duration::from_secs(10);
/// `(session_client_id, seq)` pairs remembered to drop a replayed final.
const SEEN_FINALS_CAP: usize = 64;
/// A spoken name is at most this many words.
const NAME_MAX_WORDS: usize = 4;
/// A name that started in one final may take this many words from the next.
const NAME_CARRY_MAX_WORDS: usize = 2;
/// Only when that next final followed this closely.
const NAME_CARRY_MAX_GAP: Duration = Duration::from_secs(4);
/// The longest `heard` text handed on.
const HEARD_MAX_CHARS: usize = 140;

// --- Vocabulary -----------------------------------------------------------------

/// The wake word that always works (plan 164 D2), then the "Orcle" spellings
/// speech models produce, kept as hidden aliases for one release (remove
/// after 0.9.140). The weak "oracle"/"orca" entries are gone: a real word
/// never wakes the Golem. The persona's own name is added per process by
/// `set_persona_wake_tokens`.
const WAKE_WORDS: &[&str] = &["golem", "orcle", "orkle", "orcel", "orkel", "orcl", "orcal"];
/// The shortest name word that can wake the Golem.
const NAME_TOKEN_MIN_LETTERS: usize = 3;

/// The persona name's word tokens as the current wake words (plan 164 S-A7).
/// The engine sets them whenever the settings change, so the detector and
/// the marker grammar read the current name on every utterance.
static PERSONA_WAKE_TOKENS: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

/// Fold a letter to plain ASCII where a speech model would: Latin-1 accents
/// drop their marks, everything else keeps its lowercase form.
fn fold_ascii(ch: char) -> Option<char> {
    let folded = match ch {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è'..='ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì'..='ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù'..='ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ß' => 's',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        'ď' => 'd',
        'ł' => 'l',
        'ř' => 'r',
        'ť' => 't',
        other => other,
    };
    folded.is_ascii_alphabetic().then_some(folded)
}

/// The words of a persona name that wake the Golem (plan 164 D2): split like
/// chat names (camelCase, separators, digits dropped), lowercased and
/// ASCII-folded, three letters or more, and never a wake word already.
/// "Grum the Goblin" gives `["grum", "the", "goblin"]` minus "the" (a stop
/// word), so "Grum, highlight the last comment" and "Goblin, take it down"
/// both work.
pub fn wake_name_tokens(persona_name: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for token in crate::cohost_ack::name_tokens(persona_name) {
        let folded: String = token.chars().filter_map(fold_ascii).collect();
        if folded.chars().count() < NAME_TOKEN_MIN_LETTERS
            || is_stop_word(&folded)
            || WAKE_WORDS.contains(&folded.as_str())
            || tokens.contains(&folded)
        {
            continue;
        }
        tokens.push(folded);
    }
    tokens
}

/// Make the persona's name wake the Golem from now on (plan 164 S-A7).
pub fn set_persona_wake_tokens(persona_name: &str) {
    let tokens = wake_name_tokens(persona_name);
    if let Ok(mut current) = PERSONA_WAKE_TOKENS.write() {
        *current = tokens;
    }
}

fn is_persona_wake_token(text: &str) -> bool {
    PERSONA_WAKE_TOKENS
        .read()
        .is_ok_and(|tokens| tokens.iter().any(|token| token == text))
}
/// Words that introduce an address: "hey Golem", "okay Golem".
const LEAD_INS: &[&str] = &[
    "hey", "ok", "okay", "hi", "yo", "so", "um", "uh", "and", "now", "alright", "oh", "right",
];
/// After the wake word, these mean Golem is the subject of a sentence, not
/// being addressed: "Golem is great tonight".
const SUBJECT_CONTINUATIONS: &[&str] = &[
    "is", "isnt", "was", "wasnt", "has", "hasnt", "had", "will", "wont", "would", "wouldnt", "can",
    "cant", "could", "couldnt", "does", "doesnt", "did", "didnt", "just", "also", "really",
    "always", "never", "said", "says", "thinks", "thought", "told", "keeps", "kept", "got", "gets",
    "needs", "wants", "seems", "seemed", "looks", "looked", "sounds", "works", "worked", "crashed",
    "stopped", "went", "goes", "likes", "loves", "hates", "and", "or", "but", "too", "as", "for",
    "with", "in",
];
/// Words between "Golem" and the verb that carry no meaning of their own.
const FILLERS: &[&str] = &[
    "please", "can", "could", "would", "will", "you", "i", "we", "just", "now", "um", "uh", "hey",
    "so", "and", "then", "also", "maybe", "quickly", "kindly", "go", "ahead", "lets", "let", "us",
    "me", "to", "want", "need", "like", "think", "should", "gonna", "wanna", "actually", "yeah",
    "ok", "okay", "oh", "well", "hmm", "uhm", "er",
];
const HIGHLIGHT_VERBS: &[&str] = &[
    "highlight",
    "show",
    "display",
    "feature",
    "spotlight",
    "pin",
    "put",
    "bring",
    "pull",
    "throw",
];
const CLEAR_VERBS: &[&str] = &["clear", "unhighlight", "unpin", "dismiss", "hide", "take"];
const REMOVE_VERBS: &[&str] = &["remove", "delete", "erase", "nuke", "get"];
/// Verbs that may start a structured phrase without the wake word.
const STRUCTURED_VERBS: &[&str] = &["remove", "delete", "highlight"];
const SCREEN_NOUNS: &[&str] = &[
    "screen",
    "stream",
    "overlay",
    "highlight",
    "card",
    "display",
    "air",
    "view",
    "canvas",
    "scene",
];
const CHAT_NOUNS: &[&str] = &["chat", "chats", "channel", "room"];
const COMMENT_NOUNS: &[&str] = &[
    "comment",
    "comments",
    "message",
    "messages",
    "msg",
    "post",
    "question",
    "questions",
    "reply",
    "text",
];
const DEIXIS: &[&str] = &[
    "it", "this", "that", "these", "those", "him", "her", "them", "his", "their", "hers",
];
const LAST_WORDS: &[&str] = &["last", "latest", "newest", "recent", "previous"];
const NAME_MARKERS: &[&str] = &["from", "by"];
const SPEECH_VERBS: &[&str] = &[
    "said", "says", "asked", "asking", "wrote", "posted", "typed", "sent",
];
/// Particles that complete a verb ("put ... up", "take ... down", "get rid").
const TAIL_PARTICLES: &[&str] = &[
    "up", "down", "off", "on", "onto", "out", "rid", "of", "away",
];
/// Small words a command may carry without changing it.
const PARTICLES: &[&str] = &[
    "the", "a", "an", "our", "my", "your", "their", "in", "to", "for", "me", "please", "now",
    "again", "one", "whole", "entire", "there", "here", "at", "with", "into", "right", "just",
    "quickly", "too", "as", "well", "most", "top", "bottom", "middle", "first", "second", "third",
    "1st", "2nd", "3rd", "next", "other", "another", "same", "both", "each", "every",
];

/// Decisive cancel words, with or without the wake word. While a removal
/// card is open, any of these anywhere in a sentence cancels it: "Yeah I
/// don't think so" is a no, never a yes.
const CANCEL_DECISIVE: &[&str] = &[
    "no",
    "nope",
    "nah",
    "cancel",
    "nevermind",
    "stop",
    "dont",
    "abort",
    "wait",
    "negative",
    "forget",
    "leave",
    "keep",
    "never",
    "not",
    "hold",
];
/// Negated verbs ("can't", "won't"): a sentence that negates anything while a
/// card is open is never consent.
const NEGATIONS: &[&str] = &[
    "cant", "wont", "shouldnt", "doesnt", "didnt", "isnt", "wouldnt", "couldnt", "arent", "wasnt",
    "werent", "aint", "havent", "hasnt", "mustnt", "neednt",
];
/// The words that consent on their own, and only in a pure answer sentence.
/// Deleting chat is irreversible, so fillers that also mean "I heard you"
/// ("okay", "right", "sure", "yeah") never confirm.
const CONFIRM_WORDS: &[&str] = &["yes", "confirm", "confirmed", "affirmative", "proceed"];
/// Every word a pure answer may contain.
const ANSWER_VOCAB: &[&str] = &[
    "no",
    "nope",
    "nah",
    "cancel",
    "nevermind",
    "stop",
    "dont",
    "abort",
    "wait",
    "negative",
    "forget",
    "leave",
    "keep",
    "never",
    "not",
    "hold",
    "yes",
    "confirm",
    "confirmed",
    "affirmative",
    "proceed",
    "go",
    "it",
    "that",
    "this",
    "one",
    "the",
    "do",
    "ahead",
    "now",
    "thanks",
    "thank",
    "you",
    "remove",
    "delete",
    "mind",
    "rid",
    "of",
    "get",
    "and",
    "me",
    "for",
    "a",
    "all",
    "good",
    "lets",
    "them",
    "him",
    "her",
    "comment",
    "message",
    "on",
];
/// Words stripped before an answer is read. Fillers that acknowledge without
/// consenting ("okay", "right", "yeah") are stripped, so "Okay." alone is
/// nothing and "Okay, yes." is a yes.
const ANSWER_SKIP: &[&str] = &[
    "hey", "um", "uh", "oh", "well", "please", "so", "and", "then", "just", "ok", "okay",
    "alright", "right", "sure", "fine", "yeah", "yea", "ya", "yep", "yup", "hmm", "uhm", "er",
];
/// Words stripped before a choice is read ("I'll take the first one").
const CHOICE_SKIP: &[&str] = &[
    "the", "number", "pick", "choose", "take", "select", "option", "comment", "message", "please",
    "go", "with", "yeah", "yes", "ok", "okay", "ill", "lets", "do", "it", "id", "want", "use",
    "prefer", "say",
];
/// Pronoun contractions that end in "'s" but are not possessives.
const CONTRACTION_BASES: &[&str] = &[
    "it",
    "that",
    "this",
    "what",
    "there",
    "here",
    "he",
    "she",
    "who",
    "let",
    "where",
    "how",
    "everything",
    "something",
    "nothing",
    "everyone",
    "someone",
];

// --- Public types -----------------------------------------------------------------

/// What the engine is waiting for when a final arrives (S3 wires these).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DetectContext {
    /// The "Commands need 'Golem' first" setting: structured phrases are off.
    pub require_wake_word: bool,
    /// A removal card is open, waiting for yes or no.
    pub awaiting_answer: bool,
    /// A chooser is open, waiting for 1 to 3.
    pub awaiting_choice: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Highlight,
    Clear,
    Remove,
    Confirm,
    Cancel,
    /// A chooser pick, 0 to 2.
    Choose(u8),
    /// Golem was clearly addressed and understood nothing.
    Unknown,
}

impl CommandKind {
    /// Plain words for logs and the command strip.
    pub fn label(&self) -> String {
        match self {
            Self::Highlight => "highlight".to_string(),
            Self::Clear => "clear".to_string(),
            Self::Remove => "remove".to_string(),
            Self::Confirm => "confirm".to_string(),
            Self::Cancel => "cancel".to_string(),
            Self::Choose(index) => format!("choose {}", *index + 1),
            Self::Unknown => "unknown".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandTarget {
    /// The raw spoken name phrase, normalised ("coders x"); S3 resolves it with
    /// `cohost_ack::name_match_forms` and `name_forms_match`.
    Name(String),
    /// "this one", "that", "it".
    Deixis,
    /// "the last comment".
    Last,
    None,
}

impl CommandTarget {
    /// Plain words for logs and the command strip.
    pub fn describe(&self) -> String {
        match self {
            Self::Name(name) => format!("the viewer named '{name}'"),
            Self::Deixis => "the one being talked about".to_string(),
            Self::Last => "the last comment".to_string(),
            Self::None => "nothing in particular".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedCommand {
    pub kind: CommandKind,
    pub target: CommandTarget,
    /// "Question" phrasing: "show coders x's question", "what coders x asked".
    pub question: bool,
    /// The audit reason heard near the command ("toxic", "spam").
    pub reason: Option<String>,
    /// The normalised words of the command, wake word included when heard.
    pub heard: String,
    /// The command was addressed with the wake word (or an alias).
    pub wake_word: bool,
}

/// The Golem engine session the detector serves (plan 140 S2): set when a
/// session starts, or hears again after sign-in, and cleared with the
/// transcript. S3 checks the generation under the engine lock before acting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSession {
    pub session_id: String,
    pub generation: u64,
}

/// The detector and the session it serves, behind one std mutex on `AppState`.
#[derive(Debug, Default)]
pub struct CommandDetectorState {
    pub detector: CommandDetector,
    /// `None` while no Golem session hears the streamer: nothing is detected.
    pub session: Option<CommandSession>,
    /// What the engine waits for, and the wake-word setting (plan 140 S3).
    /// The engine mirrors it here after every change, so the caption task
    /// reads it without the engine lock.
    pub context: DetectContext,
    /// The voice removal waiting for an answer, mirrored with `context`
    /// (plan 140 S3). Every session boundary that disarms the detector
    /// (`cohost::clear_transcript`) cancels it: no removal outlives the
    /// session, consent or sign-in it was asked under.
    pub pending_operation: Option<String>,
}

pub type CommandDetectorSlot = Arc<StdMutex<CommandDetectorState>>;

pub fn new_command_detector_slot() -> CommandDetectorSlot {
    Arc::new(StdMutex::new(CommandDetectorState::default()))
}

// --- Detector ---------------------------------------------------------------------

/// One normalised transcript word with where and when it was heard.
#[derive(Debug, Clone)]
struct Word {
    text: String,
    /// The raw token ended in "'s" ("coders X's question").
    possessive: bool,
    /// First word of its final, or the previous token ended a sentence.
    sentence_start: bool,
    /// The raw token ended with a comma, colon, semicolon or sentence mark.
    pause_after: bool,
    /// The raw token ended with ".", "!" or "?".
    sentence_end: bool,
    final_index: u64,
    at: Instant,
    /// Stable identity across window trims (the Unknown dedupe key).
    ordinal: u64,
}

/// The rolling word window, the replayed-final dedupe and the recent-command
/// dedupe. Pure: no I/O, no clock of its own.
#[derive(Debug, Default)]
pub struct CommandDetector {
    words: Vec<Word>,
    final_index: u64,
    next_ordinal: u64,
    seen: VecDeque<(String, u64)>,
    recent: Vec<(String, Instant)>,
}

struct Detection {
    command: DetectedCommand,
    /// The recent-command dedupe key; `None` for answers and choices, which
    /// the engine consumes as they come.
    dedupe: Option<String>,
    /// Index in the window of the last word the detection consumed.
    end: usize,
}

impl CommandDetector {
    /// Feed one settled final. Returns a command when the newest final
    /// completes one that is not a repeat.
    pub fn observe_final(
        &mut self,
        session_client_id: &str,
        seq: u64,
        text: &str,
        now: Instant,
        ctx: &DetectContext,
    ) -> Option<DetectedCommand> {
        if self
            .seen
            .iter()
            .any(|(id, seen_seq)| *seen_seq == seq && id == session_client_id)
        {
            return None;
        }
        if self.seen.len() >= SEEN_FINALS_CAP {
            self.seen.pop_front();
        }
        self.seen.push_back((session_client_id.to_string(), seq));
        self.words
            .retain(|word| now.saturating_duration_since(word.at) <= COMMAND_WINDOW);
        self.recent
            .retain(|(_, at)| now.saturating_duration_since(*at) <= COMMAND_DEDUPE);
        self.final_index += 1;
        let words = tokenize(text, self.final_index, now, &mut self.next_ordinal);
        if words.is_empty() {
            return None;
        }
        self.words.extend(words);
        let Detection {
            command,
            dedupe,
            end,
        } = detect(&self.words, self.final_index, ctx)?;
        // A command closed by a sentence mark is finished: its words never
        // start or extend a later command. Without this, "Golem, clear the
        // highlight." followed by "This one is toxic. Remove it from our
        // chat." read the second sentence as the clear's target and lost the
        // removal. An unclosed command keeps its words, so a name cut by a
        // final boundary still grows into the next final.
        if dedupe.is_some() && self.words[end].sentence_end {
            let through = self.words[end].ordinal;
            self.words.retain(|word| word.ordinal > through);
        }
        if let Some(key) = dedupe {
            if self.recent.iter().any(|(seen, _)| *seen == key) {
                return None;
            }
            self.recent.push((key, now));
        }
        Some(command)
    }

    /// A session boundary or sign-out forgets every word and every recent
    /// command; replayed-final identities are kept, since a final never
    /// becomes new again.
    pub fn clear(&mut self) {
        self.words.clear();
        self.recent.clear();
    }
}

// --- Normalisation ----------------------------------------------------------------

fn is_apostrophe(c: char) -> bool {
    matches!(c, '\'' | '\u{2019}' | '\u{2018}' | '`')
}

/// "coders X's" is a possessive of "coders X"; "it's" is a contraction and
/// stays one word ("its"). A plural possessive ("coders'") drops its mark.
fn split_possessive(core: &str) -> (&str, bool) {
    for suffix in ["'s", "\u{2019}s", "'S", "\u{2019}S"] {
        if let Some(base) = core.strip_suffix(suffix) {
            if base.is_empty() || CONTRACTION_BASES.contains(&base.to_lowercase().as_str()) {
                return (core, false);
            }
            return (base, true);
        }
    }
    let trimmed = core.trim_end_matches(is_apostrophe);
    if trimmed.len() < core.len() && trimmed.ends_with(['s', 'S']) {
        return (trimmed, true);
    }
    (core, false)
}

/// Unicode-aware lowercase words with their punctuation flags: "Golem," →
/// `orcle` with a pause after it; "coders_x" is two words; "don't" is "dont".
fn tokenize(text: &str, final_index: u64, at: Instant, next_ordinal: &mut u64) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    let mut sentence_start = true;
    for raw in text.split_whitespace() {
        let trailing: Vec<char> = raw
            .chars()
            .rev()
            .take_while(|c| !c.is_alphanumeric() && !is_apostrophe(*c))
            .collect();
        let sentence_end = trailing
            .iter()
            .any(|c| matches!(c, '.' | '!' | '?' | '\u{2026}'));
        let pause_after = sentence_end
            || trailing
                .iter()
                .any(|c| matches!(c, ',' | ';' | ':' | '\u{2014}' | '\u{2013}' | '-'));
        let core = raw.trim_matches(|c: char| !c.is_alphanumeric() && !is_apostrophe(c));
        let (core, possessive) = split_possessive(core);
        let parts: Vec<String> = core
            .split(|c: char| !c.is_alphanumeric() && !is_apostrophe(c))
            .map(|part| {
                part.chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
                    .to_lowercase()
            })
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            // A lone "..." or dash: its punctuation belongs to the word before.
            if let Some(last) = words.last_mut() {
                last.pause_after |= pause_after;
                last.sentence_end |= sentence_end;
            }
            if sentence_end {
                sentence_start = true;
            }
            continue;
        }
        let count = parts.len();
        for (index, part) in parts.into_iter().enumerate() {
            let last = index + 1 == count;
            *next_ordinal += 1;
            words.push(Word {
                text: part,
                possessive: possessive && last,
                sentence_start: sentence_start && index == 0,
                pause_after: pause_after && last,
                sentence_end: sentence_end && last,
                final_index,
                at,
                ordinal: *next_ordinal,
            });
        }
        sentence_start = sentence_end;
    }
    words
}

fn text_of(words: &[Word]) -> String {
    let mut text = String::new();
    for word in words {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&word.text);
    }
    if text.chars().count() > HEARD_MAX_CHARS {
        text = text.chars().take(HEARD_MAX_CHARS).collect();
    }
    text
}

/// Sentences of a final, split after each ".", "!" or "?".
fn sentences(words: &[Word]) -> Vec<&[Word]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, word) in words.iter().enumerate() {
        if word.sentence_end {
            out.push(&words[start..=index]);
            start = index + 1;
        }
    }
    if start < words.len() {
        out.push(&words[start..]);
    }
    out
}

// --- Word classes -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerbClass {
    Highlight,
    Clear,
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Noun {
    Screen,
    Chat,
    Comment,
}

pub(crate) fn is_command_negation(text: &str) -> bool {
    let normalized = text.replace(['\'', '’'], "");
    CANCEL_DECISIVE.contains(&normalized.as_str()) || NEGATIONS.contains(&normalized.as_str())
}

pub(crate) fn is_any_wake_word(text: &str) -> bool {
    WAKE_WORDS.contains(&text) || is_persona_wake_token(text)
}

fn verb_class(text: &str) -> Option<VerbClass> {
    if HIGHLIGHT_VERBS.contains(&text) {
        Some(VerbClass::Highlight)
    } else if CLEAR_VERBS.contains(&text) {
        Some(VerbClass::Clear)
    } else if REMOVE_VERBS.contains(&text) {
        Some(VerbClass::Remove)
    } else {
        None
    }
}

fn noun_class(text: &str) -> Option<Noun> {
    if SCREEN_NOUNS.contains(&text) {
        Some(Noun::Screen)
    } else if CHAT_NOUNS.contains(&text) {
        Some(Noun::Chat)
    } else if COMMENT_NOUNS.contains(&text) {
        Some(Noun::Comment)
    } else {
        None
    }
}

/// Some verbs mean nothing without their particle: "put ... up", "take ...
/// down", "get rid". Without it the command is still being said.
fn required_particle_present(verb: &str, particles: &[&str]) -> bool {
    match verb {
        "put" | "bring" | "pull" | "throw" => particles
            .iter()
            .any(|particle| matches!(*particle, "up" | "on" | "onto")),
        "take" => particles
            .iter()
            .any(|particle| matches!(*particle, "down" | "off")),
        "get" => particles.contains(&"rid"),
        _ => true,
    }
}

/// The audit reason a word carries, canonical and short.
fn reason_for(word: &str) -> Option<&'static str> {
    Some(match word {
        "toxic" | "toxicity" => "toxic",
        "spam" | "spamming" | "spammer" | "spammy" => "spam",
        "rude" => "rude",
        "hate" | "hateful" => "hate",
        "harassment" | "harassing" | "harass" => "harassment",
        "scam" | "scammer" | "scamming" => "scam",
        "bot" | "bots" => "bot",
        "racist" | "racism" => "racist",
        "slur" | "slurs" => "slur",
        "offensive" => "offensive",
        "abusive" | "abuse" => "abusive",
        "troll" | "trolling" => "troll",
        "nsfw" => "nsfw",
        "threat" | "threats" | "threatening" => "threat",
        "insult" | "insults" | "insulting" => "insult",
        "phishing" | "phish" => "phishing",
        "sexist" | "sexism" => "sexist",
        "homophobic" | "homophobia" => "homophobic",
        "transphobic" => "transphobic",
        "advertising" | "advertisement" | "promo" | "promotion" | "selfpromo" => "advertising",
        "doxxing" | "doxing" | "dox" => "doxxing",
        "inappropriate" => "inappropriate",
        "disgusting" => "disgusting",
        "nasty" => "nasty",
        "vulgar" => "vulgar",
        "profanity" | "swearing" | "cursing" => "profanity",
        "bigot" | "bigoted" | "bigotry" => "bigotry",
        "misinformation" => "misinformation",
        "creepy" => "creepy",
        "hostile" => "hostile",
        "bullying" | "bully" => "bullying",
        _ => return None,
    })
}

/// Plan 140 S3: the engine strips command words from a spoken name before
/// it matches authors, with the same vocabulary the grammar uses.
pub(crate) fn is_command_word(text: &str) -> bool {
    is_grammar_word(text)
}

/// Anything the grammar knows is never part of a name.
fn is_grammar_word(text: &str) -> bool {
    is_any_wake_word(text)
        || verb_class(text).is_some()
        || noun_class(text).is_some()
        || DEIXIS.contains(&text)
        || LAST_WORDS.contains(&text)
        || NAME_MARKERS.contains(&text)
        || SPEECH_VERBS.contains(&text)
        || TAIL_PARTICLES.contains(&text)
        || PARTICLES.contains(&text)
        || FILLERS.contains(&text)
        || LEAD_INS.contains(&text)
        || reason_for(text).is_some()
        || text == "what"
}

// --- Detection --------------------------------------------------------------------

/// The newest final decides: a command must end inside it (the clip-phrase
/// rule), so one spoken command is reported once, when it completes.
fn detect(words: &[Word], newest: u64, ctx: &DetectContext) -> Option<Detection> {
    let newest_start = words.iter().position(|word| word.final_index == newest)?;
    let newest_words = &words[newest_start..];
    let newest_has_wake = newest_words.iter().any(|word| is_any_wake_word(&word.text));
    if ctx.awaiting_choice
        && let Some((index, heard)) = detect_choice(newest_words)
    {
        return Some(Detection {
            command: DetectedCommand {
                kind: CommandKind::Choose(index),
                target: CommandTarget::None,
                question: false,
                reason: None,
                heard,
                wake_word: newest_has_wake,
            },
            dedupe: None,
            end: words.len() - 1,
        });
    }
    if !ctx.awaiting_answer {
        return scan_commands(words, newest, ctx, false);
    }
    // A new command beats an answer (plan 140 review): "Yes Golem, delete
    // the comment from bob" is a new removal, never a yes to the open card,
    // wherever in the final the command sits.
    if let Some(detection) = scan_commands(words, newest, ctx, true) {
        return Some(detection);
    }
    if let Some((kind, heard)) = detect_answer(newest_words) {
        return Some(Detection {
            command: DetectedCommand {
                kind,
                target: CommandTarget::None,
                question: false,
                reason: None,
                heard,
                wake_word: newest_has_wake,
            },
            dedupe: None,
            end: words.len() - 1,
        });
    }
    scan_commands(words, newest, ctx, false)
}

/// Wake-word commands and structured phrases ending in the newest final.
/// Latest start wins: scan wake words and structured verbs from the end.
/// With `actions_only`, only a highlight, clear or removal counts: answers
/// and unknowns are skipped, so an earlier command in the final still wins.
fn scan_commands(
    words: &[Word],
    newest: u64,
    ctx: &DetectContext,
    actions_only: bool,
) -> Option<Detection> {
    let accept = |detection: &Detection| {
        !actions_only
            || matches!(
                detection.command.kind,
                CommandKind::Highlight | CommandKind::Clear | CommandKind::Remove
            )
    };
    let mut unknown: Option<Detection> = None;
    let mut index = words.len();
    while index > 0 {
        index -= 1;
        let text = words[index].text.as_str();
        if is_any_wake_word(text) {
            match parse_wake(words, index, newest, ctx) {
                WakeOutcome::Command(detection) if accept(&detection) => {
                    return Some(detection);
                }
                WakeOutcome::Command(_) => {}
                WakeOutcome::Unknown(detection) => {
                    if unknown.is_none() && !actions_only {
                        unknown = Some(detection);
                    }
                }
                WakeOutcome::Nothing => {}
            }
            continue;
        }
        if ctx.require_wake_word || !STRUCTURED_VERBS.contains(&text) {
            continue;
        }
        // A wake word earlier in the window owns this verb when its own
        // parse works and reaches it ("Golem, this one is toxic, remove it
        // from our chat"). A command that ended before this verb ("Golem,
        // clear the highlight. This one is toxic, remove it") does not.
        if let Some(wake) = nearest_wake_before(words, index)
            && let WakeOutcome::Command(detection) = parse_wake(words, wake, newest, ctx)
            && detection.end >= index
            && accept(&detection)
        {
            return Some(detection);
        }
        if let Some(detection) = parse_structured(words, index, newest)
            && accept(&detection)
        {
            return Some(detection);
        }
    }
    unknown
}

fn nearest_wake_before(words: &[Word], index: usize) -> Option<usize> {
    (0..index)
        .rev()
        .find(|&candidate| is_any_wake_word(&words[candidate].text))
}

/// The index of the next wake word at or after `from`, else the end.
fn next_strict_wake(words: &[Word], from: usize) -> usize {
    words
        .iter()
        .enumerate()
        .skip(from)
        .find(|(_, word)| is_any_wake_word(&word.text))
        .map(|(index, _)| index)
        .unwrap_or(words.len())
}

/// The index of the first sentence end in `from..end`, else the last word.
fn first_sentence_end(words: &[Word], from: usize, end: usize) -> usize {
    (from..end)
        .find(|&index| words[index].sentence_end)
        .unwrap_or(end - 1)
}

enum WakeOutcome {
    Command(Detection),
    Unknown(Detection),
    Nothing,
}

/// Whether the wake word at `wake` addresses Golem: at the start of an
/// utterance or sentence, after a lead-in ("hey"), or followed by a comma,
/// and not as the subject of a sentence ("Golem is great tonight").
fn addressed(words: &[Word], wake: usize) -> bool {
    let word = &words[wake];
    if word.possessive {
        return false;
    }
    let lead_in = wake > 0 && LEAD_INS.contains(&words[wake - 1].text.as_str());
    if !(word.sentence_start || lead_in || word.pause_after) {
        return false;
    }
    match words.get(wake + 1) {
        None => false,
        Some(next) => !SUBJECT_CONTINUATIONS.contains(&next.text.as_str()),
    }
}

fn parse_wake(words: &[Word], wake: usize, newest: u64, ctx: &DetectContext) -> WakeOutcome {
    let from = wake + 1;
    let span_end = next_strict_wake(words, from);
    if from >= span_end {
        return WakeOutcome::Nothing;
    }
    // Answers through the wake word: "Golem, yes", "Golem, cancel".
    let sentence_end = first_sentence_end(words, from, span_end);
    if let Some(kind) = answer_kind(&words[from..=sentence_end], ctx.awaiting_answer) {
        if words[sentence_end].final_index != newest {
            return WakeOutcome::Nothing;
        }
        return WakeOutcome::Command(Detection {
            command: DetectedCommand {
                kind,
                target: CommandTarget::None,
                question: false,
                reason: None,
                heard: text_of(&words[wake..=sentence_end]),
                wake_word: true,
            },
            dedupe: None,
            end: sentence_end,
        });
    }
    match parse_command(words, from, span_end, false) {
        Some(parsed) => {
            if words[parsed.end].final_index != newest {
                return WakeOutcome::Nothing;
            }
            let dedupe = Some(dedupe_key(&parsed));
            WakeOutcome::Command(Detection {
                command: DetectedCommand {
                    kind: parsed.kind,
                    target: parsed.target,
                    question: parsed.question,
                    reason: parsed.reason,
                    heard: text_of(&words[wake..=parsed.end]),
                    wake_word: true,
                },
                dedupe,
                end: parsed.end,
            })
        }
        None => {
            if addressed(words, wake)
                && let Some(detection) = unknown_detection(words, wake, from, span_end, newest)
            {
                WakeOutcome::Unknown(detection)
            } else {
                WakeOutcome::Nothing
            }
        }
    }
}

/// A structured phrase without the wake word, starting at its verb.
fn parse_structured(words: &[Word], verb: usize, newest: u64) -> Option<Detection> {
    let span_end = next_strict_wake(words, verb + 1);
    let parsed = parse_command(words, verb, span_end, true)?;
    if words[parsed.end].final_index != newest {
        return None;
    }
    let dedupe = Some(dedupe_key(&parsed));
    Some(Detection {
        command: DetectedCommand {
            kind: parsed.kind,
            target: parsed.target,
            question: parsed.question,
            reason: parsed.reason,
            heard: text_of(&words[verb..=parsed.end]),
            wake_word: false,
        },
        dedupe,
        end: parsed.end,
    })
}

/// Golem was addressed and nothing matched. Only once the sentence is closed
/// (a sentence mark, or another wake word) and only when it holds a content
/// word and no verb or reason: "Golem, this one is toxic" is a removal still
/// being said, "Golem, um" is nothing yet.
fn unknown_detection(
    words: &[Word],
    wake: usize,
    from: usize,
    end: usize,
    newest: u64,
) -> Option<Detection> {
    let span = &words[from..end];
    let last = span.last()?;
    let closed = last.sentence_end || end < words.len();
    if !closed || last.final_index != newest {
        return None;
    }
    if span
        .iter()
        .any(|word| verb_class(&word.text).is_some() || reason_for(&word.text).is_some())
    {
        return None;
    }
    let content = span.iter().any(|word| {
        let text = word.text.as_str();
        !FILLERS.contains(&text)
            && !DEIXIS.contains(&text)
            && !PARTICLES.contains(&text)
            && !TAIL_PARTICLES.contains(&text)
            && !LEAD_INS.contains(&text)
            && !is_stop_word(text)
    });
    if !content {
        return None;
    }
    Some(Detection {
        command: DetectedCommand {
            kind: CommandKind::Unknown,
            target: CommandTarget::None,
            question: false,
            reason: None,
            heard: text_of(span),
            wake_word: true,
        },
        dedupe: Some(format!("unknown|{}", words[wake].ordinal)),
        end: end - 1,
    })
}

// --- Commands ---------------------------------------------------------------------

struct Parsed {
    kind: CommandKind,
    target: CommandTarget,
    question: bool,
    reason: Option<String>,
    /// Index of the last word the command consumed.
    end: usize,
}

fn dedupe_key(parsed: &Parsed) -> String {
    format!("{:?}|{:?}|{}", parsed.kind, parsed.target, parsed.question)
}

/// Parse one command in `words[from..end]`. With the wake word the verb may
/// come later in the span ("Golem, this one is toxic, remove it"); a
/// structured phrase starts at its verb and must point at a message.
fn parse_command(words: &[Word], from: usize, end: usize, structured: bool) -> Option<Parsed> {
    let verb = if structured {
        from
    } else {
        (from..end).find(|&index| verb_class(&words[index].text).is_some())?
    };
    let class = verb_class(&words[verb].text)?;
    let verb_text = words[verb].text.as_str();
    let pre_deixis = !structured
        && words[from..verb]
            .iter()
            .any(|word| DEIXIS.contains(&word.text.as_str()));
    let walk = walk_after_verb(words, verb, end);
    if !required_particle_present(verb_text, &walk.particles) {
        return None;
    }
    let target = if let Some(name) = walk.name {
        CommandTarget::Name(name)
    } else if walk.last {
        CommandTarget::Last
    } else if walk.deixis || pre_deixis {
        CommandTarget::Deixis
    } else {
        CommandTarget::None
    };
    let has_chat = walk.nouns.contains(&Noun::Chat);
    let has_screen = walk.nouns.contains(&Noun::Screen);
    let has_comment = walk.nouns.contains(&Noun::Comment);
    let kind = match class {
        VerbClass::Highlight => CommandKind::Highlight,
        VerbClass::Clear => {
            if has_chat && !has_screen {
                // "clear the chat" would be a whole-chat clear: refused.
                if verb_text == "clear" {
                    CommandKind::Unknown
                } else {
                    CommandKind::Remove
                }
            } else {
                CommandKind::Clear
            }
        }
        VerbClass::Remove => {
            if has_screen && !has_chat {
                CommandKind::Clear
            } else {
                CommandKind::Remove
            }
        }
    };
    if matches!(kind, CommandKind::Highlight | CommandKind::Remove) && target == CommandTarget::None
    {
        // "highlight the comment" or "remove the message": the target is
        // still being said.
        return None;
    }
    let reason = nearest_reason(words, verb, end);
    if structured {
        let pointed = match kind {
            CommandKind::Remove => {
                target == CommandTarget::Deixis && (has_chat || has_comment || reason.is_some())
            }
            CommandKind::Highlight => matches!(target, CommandTarget::Name(_)) && has_comment,
            _ => false,
        };
        if !pointed {
            return None;
        }
    }
    Some(Parsed {
        kind,
        target,
        question: walk.question,
        reason,
        end: walk.end,
    })
}

struct Walk<'a> {
    particles: Vec<&'a str>,
    nouns: Vec<Noun>,
    deixis: bool,
    last: bool,
    name: Option<String>,
    question: bool,
    end: usize,
}

/// Read the words after the verb: nouns, pointing words, a name, particles
/// and a reason, until the sentence or the next command.
fn walk_after_verb(words: &[Word], verb: usize, end: usize) -> Walk<'_> {
    let mut walk = Walk {
        particles: Vec::new(),
        nouns: Vec::new(),
        deixis: false,
        last: false,
        name: None,
        question: false,
        end: verb,
    };
    let mut crossed_sentence = false;
    let mut index = verb + 1;
    while index < end {
        let word = &words[index];
        let text = word.text.as_str();
        if is_any_wake_word(text) {
            break;
        }
        if let Some(noun) = noun_class(text) {
            walk.nouns.push(noun);
            if text.starts_with("question") {
                walk.question = true;
            }
            walk.end = index;
        } else if DEIXIS.contains(&text) {
            walk.deixis = true;
            walk.end = index;
        } else if LAST_WORDS.contains(&text) {
            walk.last = true;
            walk.end = index;
        } else if SPEECH_VERBS.contains(&text) {
            if text.starts_with("ask") {
                walk.question = true;
            }
            walk.end = index;
        } else if NAME_MARKERS.contains(&text) || text == "what" {
            match collect_name(words, index + 1, end) {
                Some((name, last)) if walk.name.is_none() => {
                    walk.name = Some(name);
                    walk.end = last;
                    index = last + 1;
                    continue;
                }
                // A second name is another command.
                Some(_) => break,
                // "from" with nothing behind it yet: the name is still coming.
                None => walk.end = index,
            }
        } else if TAIL_PARTICLES.contains(&text) {
            walk.particles.push(text);
            walk.end = index;
        } else if PARTICLES.contains(&text)
            || FILLERS.contains(&text)
            || LEAD_INS.contains(&text)
            || is_stop_word(text)
        {
            // "this one": the match ends on "one".
            if text == "one" && walk.deixis {
                walk.end = index;
            }
        } else if reason_for(text).is_some() {
            walk.end = index;
        } else if verb_class(text).is_some() {
            break;
        } else if walk.name.is_none() && !walk.deixis && !walk.last && walk.nouns.is_empty() {
            // A bare name right after the verb: "highlight coders x",
            // "show coders x's question".
            match collect_name(words, index, end) {
                Some((name, last)) => {
                    walk.name = Some(name);
                    walk.end = last;
                    index = last + 1;
                    continue;
                }
                None => break,
            }
        } else {
            break;
        }
        if word.sentence_end {
            let has_target = walk.name.is_some() || walk.deixis || walk.last;
            if has_target || crossed_sentence {
                break;
            }
            // Speech models insert a period mid-command; cross one sentence
            // end while the target is still missing.
            crossed_sentence = true;
        }
        index += 1;
    }
    walk
}

/// The spoken name starting at `from`: up to four words that are neither
/// grammar nor stop words, ending at a possessive, a comma or a sentence end.
/// Leading stop words are skipped ("from the real slim"). A name that began in
/// one final may take two words from the next, when it followed closely.
/// Returns the name and the index of its last word.
fn collect_name(words: &[Word], from: usize, end: usize) -> Option<(String, usize)> {
    let mut parts: Vec<&str> = Vec::new();
    let mut last = from;
    let mut skipped_leading = 0;
    let mut carried = 0;
    let mut start_final = None;
    let mut index = from;
    while index < end && parts.len() < NAME_MAX_WORDS {
        let word = &words[index];
        let text = word.text.as_str();
        if is_stop_word(text) || PARTICLES.contains(&text) {
            if parts.is_empty() && skipped_leading < 2 {
                skipped_leading += 1;
                index += 1;
                continue;
            }
            break;
        }
        if is_grammar_word(text) {
            break;
        }
        match start_final {
            None => start_final = Some(word.final_index),
            Some(started) if word.final_index != started => {
                carried += 1;
                if carried > NAME_CARRY_MAX_WORDS
                    || word.at.saturating_duration_since(words[last].at) > NAME_CARRY_MAX_GAP
                {
                    break;
                }
            }
            Some(_) => {}
        }
        parts.push(text);
        last = index;
        if word.possessive || word.sentence_end || word.pause_after {
            break;
        }
        index += 1;
    }
    if parts.is_empty() {
        None
    } else {
        Some((parts.join(" "), last))
    }
}

/// The reason word nearest the verb anywhere in the window before the span
/// ends: "This one is toxic. Remove it from our chat." carries "toxic".
fn nearest_reason(words: &[Word], verb: usize, end: usize) -> Option<String> {
    let mut best: Option<(usize, &'static str)> = None;
    for (index, word) in words[..end].iter().enumerate() {
        let Some(reason) = reason_for(&word.text) else {
            continue;
        };
        let distance = index.abs_diff(verb);
        if best.is_none_or(|(best_distance, _)| distance < best_distance) {
            best = Some((distance, reason));
        }
    }
    best.map(|(_, reason)| reason.to_string())
}

// --- Answers and choices ----------------------------------------------------------

/// Read one sentence as an answer. Deleting chat is irreversible, so consent
/// must be unambiguous (plan 140 review):
///
/// - While a card is open, a cancel or negation word anywhere in the
///   sentence cancels ("Yeah I don't think so", "I'd rather not").
/// - Otherwise only a pure answer decides: every word answer vocabulary, six
///   words at most, after fillers are stripped ("Yes.", "Yes, remove it.",
///   "Do it", "Go ahead"). A longer sentence that merely starts with "yes"
///   or "okay" is talk, never consent.
fn answer_kind(words: &[Word], awaiting: bool) -> Option<CommandKind> {
    let stripped: Vec<&str> = words
        .iter()
        .map(|word| word.text.as_str())
        .filter(|text| !is_any_wake_word(text) && !ANSWER_SKIP.contains(text))
        .collect();
    if stripped.is_empty() {
        return None;
    }
    if awaiting && stripped.iter().any(|text| is_cancel_word(text)) {
        return Some(CommandKind::Cancel);
    }
    let pure = stripped.len() <= 6 && stripped.iter().all(|text| ANSWER_VOCAB.contains(text));
    if pure {
        return answer_from_pure(&stripped, awaiting);
    }
    None
}

fn is_cancel_word(text: &str) -> bool {
    CANCEL_DECISIVE.contains(&text) || NEGATIONS.contains(&text)
}

/// Cancel wins over confirm ("no wait, yes" stays safe). "Remove it" and
/// "delete it" confirm only while a removal card is open.
fn answer_from_pure(stripped: &[&str], awaiting: bool) -> Option<CommandKind> {
    if stripped.iter().any(|text| is_cancel_word(text)) {
        return Some(CommandKind::Cancel);
    }
    if stripped.iter().any(|text| CONFIRM_WORDS.contains(text)) {
        return Some(CommandKind::Confirm);
    }
    let has = |word: &str| stripped.contains(&word);
    if (has("do") && has("it")) || (has("go") && has("ahead")) {
        return Some(CommandKind::Confirm);
    }
    if awaiting && (has("remove") || has("delete") || has("rid")) {
        return Some(CommandKind::Confirm);
    }
    None
}

/// A bare answer in the newest final. Each sentence is read on its own, and
/// a cancel in any of them wins: "Yes. No, wait." never deletes.
fn detect_answer(newest: &[Word]) -> Option<(CommandKind, String)> {
    let mut confirm: Option<String> = None;
    for sentence in sentences(newest).into_iter().rev() {
        match answer_kind(sentence, true) {
            Some(CommandKind::Cancel) => return Some((CommandKind::Cancel, text_of(sentence))),
            Some(kind) if confirm.is_none() => {
                debug_assert_eq!(kind, CommandKind::Confirm);
                confirm = Some(text_of(sentence));
            }
            _ => {}
        }
    }
    confirm.map(|heard| (CommandKind::Confirm, heard))
}

fn ordinal_index(text: &str) -> Option<u8> {
    match text {
        "first" | "1st" | "top" => Some(0),
        "second" | "2nd" | "middle" => Some(1),
        "third" | "3rd" => Some(2),
        _ => None,
    }
}

fn number_index(text: &str) -> Option<u8> {
    match text {
        "one" | "1" => Some(0),
        "two" | "2" => Some(1),
        "three" | "3" => Some(2),
        _ => None,
    }
}

/// A chooser pick in the newest final: "the first one", "number two", "two".
fn detect_choice(newest: &[Word]) -> Option<(u8, String)> {
    for sentence in sentences(newest).into_iter().rev() {
        let rest: Vec<&str> = sentence
            .iter()
            .map(|word| word.text.as_str())
            .filter(|text| {
                !is_any_wake_word(text)
                    && !CHOICE_SKIP.contains(text)
                    && !FILLERS.contains(text)
                    && !LEAD_INS.contains(text)
            })
            .collect();
        let index = match rest.as_slice() {
            [only] => ordinal_index(only).or_else(|| number_index(only)),
            [ordinal, "one"] => ordinal_index(ordinal),
            _ => None,
        };
        if let Some(index) = index {
            return Some((index, text_of(sentence)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: DetectContext = DetectContext {
        require_wake_word: false,
        awaiting_answer: false,
        awaiting_choice: false,
    };
    const ANSWERING: DetectContext = DetectContext {
        require_wake_word: false,
        awaiting_answer: true,
        awaiting_choice: false,
    };
    const CHOOSING: DetectContext = DetectContext {
        require_wake_word: false,
        awaiting_answer: false,
        awaiting_choice: true,
    };
    const WAKE_REQUIRED: DetectContext = DetectContext {
        require_wake_word: true,
        awaiting_answer: false,
        awaiting_choice: false,
    };

    type Shape = (CommandKind, CommandTarget, bool, Option<String>);

    fn shape(command: &DetectedCommand) -> Shape {
        (
            command.kind,
            command.target.clone(),
            command.question,
            command.reason.clone(),
        )
    }

    fn name(text: &str) -> CommandTarget {
        CommandTarget::Name(text.to_string())
    }

    fn detect_one(text: &str, ctx: &DetectContext) -> Option<DetectedCommand> {
        CommandDetector::default().observe_final("client", 1, text, Instant::now(), ctx)
    }

    #[test]
    fn phrase_table() {
        use CommandKind::{Cancel, Choose, Clear, Confirm, Highlight, Remove, Unknown};
        use CommandTarget::{Deixis, Last, None as NoTarget};
        let hit =
            |kind: CommandKind, target: CommandTarget, question: bool, reason: Option<&str>| {
                Some((kind, target, question, reason.map(str::to_string)))
            };
        let cases = [
            // Highlight (decision 3).
            (
                "Golem, highlight the comment from coders X",
                &PLAIN,
                hit(Highlight, name("coders x"), false, None),
            ),
            (
                "Golem, show coders X's question",
                &PLAIN,
                hit(Highlight, name("coders x"), true, None),
            ),
            (
                "Golem, put this one up",
                &PLAIN,
                hit(Highlight, Deixis, false, None),
            ),
            (
                "Golem, show the last comment",
                &PLAIN,
                hit(Highlight, Last, false, None),
            ),
            (
                "Golem highlight CodersX",
                &PLAIN,
                hit(Highlight, name("codersx"), false, None),
            ),
            (
                "Golem, highlight the message from coders_x",
                &PLAIN,
                hit(Highlight, name("coders x"), false, None),
            ),
            (
                "Golem, show what coders X asked",
                &PLAIN,
                hit(Highlight, name("coders x"), true, None),
            ),
            (
                "Golem, highlight that question",
                &PLAIN,
                hit(Highlight, Deixis, true, None),
            ),
            (
                "Golem, put it on stream",
                &PLAIN,
                hit(Highlight, Deixis, false, None),
            ),
            (
                "Golem, bring up the comment from dark knight 99",
                &PLAIN,
                hit(Highlight, name("dark knight 99"), false, None),
            ),
            (
                "Hey Golem, can you show the last question please?",
                &PLAIN,
                hit(Highlight, Last, true, None),
            ),
            (
                "Oracle, highlight the comment from coders X",
                &PLAIN,
                hit(Highlight, name("coders x"), false, None),
            ),
            (
                "Orkle show me the latest comment",
                &PLAIN,
                hit(Highlight, Last, false, None),
            ),
            (
                "Orcel, pin coders x's message",
                &PLAIN,
                hit(Highlight, name("coders x"), false, None),
            ),
            (
                "Golem, show the question from Gamer_42",
                &PLAIN,
                hit(Highlight, name("gamer 42"), true, None),
            ),
            // "orca" is a real word, not a wake word (plan 164 D2).
            ("Orca, show the last comment", &PLAIN, None),
            // Structured highlight: a comment noun and a name, no wake word.
            (
                "highlight the comment from coders X",
                &PLAIN,
                hit(Highlight, name("coders x"), false, None),
            ),
            ("highlight coders X", &PLAIN, None),
            ("highlight the comment from coders X", &WAKE_REQUIRED, None),
            // Clear (decision 3): the noun decides.
            (
                "Golem, take it down",
                &PLAIN,
                hit(Clear, Deixis, false, None),
            ),
            (
                "Golem, clear the highlight",
                &PLAIN,
                hit(Clear, NoTarget, false, None),
            ),
            (
                "Golem, remove it from the screen",
                &PLAIN,
                hit(Clear, Deixis, false, None),
            ),
            (
                "Golem, take that off the stream",
                &PLAIN,
                hit(Clear, Deixis, false, None),
            ),
            ("Golem, clear it", &PLAIN, hit(Clear, Deixis, false, None)),
            (
                "Golem, hide the overlay",
                &PLAIN,
                hit(Clear, NoTarget, false, None),
            ),
            (
                "Golem, remove this from the stream",
                &PLAIN,
                hit(Clear, Deixis, false, None),
            ),
            (
                "Golem, dismiss the card",
                &PLAIN,
                hit(Clear, NoTarget, false, None),
            ),
            (
                "Golem, take the highlight down",
                &PLAIN,
                hit(Clear, NoTarget, false, None),
            ),
            ("remove it from the screen", &PLAIN, None),
            // A whole-chat clear is refused: Golem did not catch that.
            (
                "Golem, clear the chat",
                &PLAIN,
                hit(Unknown, NoTarget, false, None),
            ),
            // Remove (decision 3): reasons become the audit reason.
            (
                "Golem, remove this one, it's toxic",
                &PLAIN,
                hit(Remove, Deixis, false, Some("toxic")),
            ),
            (
                "This one is toxic. Remove it from our chat.",
                &PLAIN,
                hit(Remove, Deixis, false, Some("toxic")),
            ),
            (
                "Golem, delete the comment from coders X",
                &PLAIN,
                hit(Remove, name("coders x"), false, None),
            ),
            (
                "remove it from our chat",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            (
                "delete that message, it's spam",
                &PLAIN,
                hit(Remove, Deixis, false, Some("spam")),
            ),
            (
                "Golem, get rid of this one",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            (
                "Golem, remove the last message from chat",
                &PLAIN,
                hit(Remove, Last, false, None),
            ),
            (
                "Golem, delete coders X's message",
                &PLAIN,
                hit(Remove, name("coders x"), false, None),
            ),
            (
                "Golem this one is toxic, remove it from our chat",
                &PLAIN,
                hit(Remove, Deixis, false, Some("toxic")),
            ),
            (
                "That guy is a scammer. Golem, remove his message.",
                &PLAIN,
                hit(Remove, Deixis, false, Some("scam")),
            ),
            (
                "Golem, take it down from chat",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            (
                "Golem, hide it from chat",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            (
                "Golem, remove this one",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            (
                "Golem, that comment is harassment, delete it",
                &PLAIN,
                hit(Remove, Deixis, false, Some("harassment")),
            ),
            (
                "remove this comment",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            ("remove it", &PLAIN, None),
            ("let me remove it from the array", &PLAIN, None),
            (
                "I'll delete the comment from the database later",
                &PLAIN,
                None,
            ),
            ("remove it from our chat", &WAKE_REQUIRED, None),
            (
                "Golem, remove it from our chat",
                &WAKE_REQUIRED,
                hit(Remove, Deixis, false, None),
            ),
            // Answers count without the wake word only while a card is open.
            ("yes", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            (
                "Yes, do it.",
                &ANSWERING,
                hit(Confirm, NoTarget, false, None),
            ),
            ("remove it", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            ("do it", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            ("confirm", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            ("go ahead", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            // Fillers acknowledge, they never consent (plan 140 review).
            ("okay", &ANSWERING, None),
            ("ok", &ANSWERING, None),
            ("sure", &ANSWERING, None),
            ("right", &ANSWERING, None),
            ("yeah", &ANSWERING, None),
            ("Yes.", &ANSWERING, hit(Confirm, NoTarget, false, None)),
            (
                "Yes, remove it.",
                &ANSWERING,
                hit(Confirm, NoTarget, false, None),
            ),
            (
                "Okay, yes.",
                &ANSWERING,
                hit(Confirm, NoTarget, false, None),
            ),
            // A cancel or negation anywhere is a no.
            (
                "Yeah I don't think so",
                &ANSWERING,
                hit(Cancel, NoTarget, false, None),
            ),
            (
                "I'd rather not",
                &ANSWERING,
                hit(Cancel, NoTarget, false, None),
            ),
            (
                "Yes, I can't decide",
                &ANSWERING,
                hit(Cancel, NoTarget, false, None),
            ),
            // A sentence that only starts like an answer is talk.
            ("Okay. Let's read the next question.", &ANSWERING, None),
            ("Right. So anyway", &ANSWERING, None),
            ("Yes, that is a great point from bob", &ANSWERING, None),
            ("no", &ANSWERING, hit(Cancel, NoTarget, false, None)),
            ("cancel", &ANSWERING, hit(Cancel, NoTarget, false, None)),
            ("never mind", &ANSWERING, hit(Cancel, NoTarget, false, None)),
            ("stop", &ANSWERING, hit(Cancel, NoTarget, false, None)),
            (
                "don't do it",
                &ANSWERING,
                hit(Cancel, NoTarget, false, None),
            ),
            (
                "No, keep it.",
                &ANSWERING,
                hit(Cancel, NoTarget, false, None),
            ),
            (
                "Golem, yes",
                &ANSWERING,
                hit(Confirm, NoTarget, false, None),
            ),
            (
                "Golem, remove it",
                &ANSWERING,
                hit(Confirm, NoTarget, false, None),
            ),
            // A new command while a card is open is still a command.
            (
                "Golem, remove the comment from coders X",
                &ANSWERING,
                hit(Remove, name("coders x"), false, None),
            ),
            ("yes", &PLAIN, None),
            ("no", &PLAIN, None),
            // With the wake word an answer is always read; S3 ignores it
            // without an open card.
            ("Golem, cancel", &PLAIN, hit(Cancel, NoTarget, false, None)),
            ("Golem, stop", &PLAIN, hit(Cancel, NoTarget, false, None)),
            // Choices count only while a chooser is open.
            (
                "the first one",
                &CHOOSING,
                hit(Choose(0), NoTarget, false, None),
            ),
            ("second", &CHOOSING, hit(Choose(1), NoTarget, false, None)),
            (
                "number two",
                &CHOOSING,
                hit(Choose(1), NoTarget, false, None),
            ),
            ("two", &CHOOSING, hit(Choose(1), NoTarget, false, None)),
            (
                "the third one",
                &CHOOSING,
                hit(Choose(2), NoTarget, false, None),
            ),
            (
                "Golem, the second one",
                &CHOOSING,
                hit(Choose(1), NoTarget, false, None),
            ),
            ("three", &CHOOSING, hit(Choose(2), NoTarget, false, None)),
            (
                "I'll take the first one",
                &CHOOSING,
                hit(Choose(0), NoTarget, false, None),
            ),
            ("the first one", &PLAIN, None),
            ("one more thing before we start", &CHOOSING, None),
            // Talking about Golem, oracles and orcas. "oracle" and "orca" are
            // real words, never wake words (plan 164 D2).
            ("Oracle database is slow", &PLAIN, None),
            ("Oracle, take it down", &PLAIN, None),
            ("Orca, take it down", &PLAIN, None),
            // "the oracle said" is a sentence about an oracle; the structured
            // phrase inside it still counts unless the wake word is required.
            (
                "the oracle said remove it from chat",
                &PLAIN,
                hit(Remove, Deixis, false, None),
            ),
            ("the oracle said remove it from chat", &WAKE_REQUIRED, None),
            ("Golem is great tonight", &PLAIN, None),
            ("I built Golem", &PLAIN, None),
            ("I built Golem.", &PLAIN, None),
            ("the orcle integration is done", &PLAIN, None),
            ("orca whales are cool", &PLAIN, None),
            ("Golem.", &PLAIN, None),
            ("Golem highlight", &PLAIN, None),
            ("Golem, can you do a backflip.", &PLAIN, None),
            // Addressed, closed, and understood nothing.
            (
                "Golem, you are amazing.",
                &PLAIN,
                hit(Unknown, NoTarget, false, None),
            ),
            (
                "Golem, ban him.",
                &PLAIN,
                hit(Unknown, NoTarget, false, None),
            ),
            // Non-English: nothing without the wake word; addressed in
            // another language, Golem says it did not catch that.
            ("resalta el comentario de coders x", &PLAIN, None),
            (
                "Golem, resalta el comentario.",
                &PLAIN,
                hit(Unknown, NoTarget, false, None),
            ),
            // Coding talk.
            (
                "we should highlight the comment in the code review",
                &PLAIN,
                None,
            ),
            ("clear that up for me", &PLAIN, None),
            ("take it down a notch", &PLAIN, None),
            ("", &PLAIN, None),
        ];
        assert!(
            cases.len() >= 60,
            "the table must cover at least 60 phrases"
        );
        for (text, ctx, expected) in cases {
            let found = detect_one(text, ctx);
            assert_eq!(
                found.as_ref().map(shape),
                expected,
                "text: {text:?}, context: {ctx:?}, found: {found:?}"
            );
        }
    }

    #[test]
    fn a_new_command_beats_an_answer_while_a_card_is_open() {
        let bob = name("bob");
        let cases: [(&str, Option<(CommandKind, CommandTarget)>); 6] = [
            (
                "Yes Golem, delete the comment from bob",
                Some((CommandKind::Remove, bob.clone())),
            ),
            (
                "Yeah, Golem, remove bob's comment",
                Some((CommandKind::Remove, bob.clone())),
            ),
            (
                "Golem, remove bob's comment. Golem, yes.",
                Some((CommandKind::Remove, bob.clone())),
            ),
            (
                "Yes. Golem, highlight the comment from bob.",
                Some((CommandKind::Highlight, bob.clone())),
            ),
            // A structured removal also wins over the answer around it.
            (
                "Yes, remove it from our chat",
                Some((CommandKind::Remove, CommandTarget::Deixis)),
            ),
            // A pure answer is still an answer.
            (
                "Golem, remove it",
                Some((CommandKind::Confirm, CommandTarget::None)),
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(
                detect_one(text, &ANSWERING).map(|command| (command.kind, command.target)),
                expected,
                "text: {text:?}"
            );
        }
    }

    #[test]
    fn a_cancel_anywhere_in_the_final_beats_a_yes() {
        for text in ["Yes. No, wait.", "No. Yes.", "Yes. I don't want that."] {
            assert_eq!(
                detect_one(text, &ANSWERING).map(|command| command.kind),
                Some(CommandKind::Cancel),
                "text: {text:?}"
            );
        }
        // A confirm is only taken from a pure sentence.
        assert_eq!(
            detect_one("So that was the last question. Yes.", &ANSWERING)
                .map(|command| (command.kind, command.heard)),
            Some((CommandKind::Confirm, "yes".to_string()))
        );
    }

    #[test]
    fn heard_and_wake_word_describe_what_was_said() {
        let command = detect_one("Golem, highlight the comment from coders X!", &PLAIN).unwrap();
        assert_eq!(command.heard, "golem highlight the comment from coders x");
        assert!(command.wake_word);
        let command = detect_one("This one is toxic. Remove it from our chat.", &PLAIN).unwrap();
        assert_eq!(command.heard, "remove it from our chat");
        assert!(!command.wake_word);
        // Plan 164 D2: the hidden alias still works for one release; a real
        // word ("oracle") no longer does.
        let command = detect_one("Orcle, take it down", &PLAIN).unwrap();
        assert_eq!(command.heard, "orcle take it down");
        assert!(command.wake_word);
        assert!(detect_one("Oracle, take it down", &PLAIN).is_none());
        let command = detect_one("Golem, you are amazing.", &PLAIN).unwrap();
        assert_eq!(command.heard, "you are amazing");
        let command = detect_one("Golem, yes", &ANSWERING).unwrap();
        assert_eq!(command.heard, "golem yes");
        assert!(command.wake_word);
        let command = detect_one("yes", &ANSWERING).unwrap();
        assert!(!command.wake_word);
    }

    #[test]
    fn a_command_split_over_two_finals_matches_once_it_completes() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert_eq!(
            detector.observe_final("c", 1, "Golem, highlight the comment", start, &PLAIN),
            None
        );
        let found = detector
            .observe_final(
                "c",
                2,
                "from coders X.",
                start + Duration::from_secs(3),
                &PLAIN,
            )
            .expect("the second final completes the command");
        assert_eq!(found.kind, CommandKind::Highlight);
        assert_eq!(found.target, name("coders x"));
        assert_eq!(found.heard, "golem highlight the comment from coders x");
        assert!(found.wake_word);
        // A later final with other words never re-matches it.
        assert_eq!(
            detector.observe_final(
                "c",
                3,
                "okay so the build is broken",
                start + Duration::from_secs(6),
                &PLAIN
            ),
            None
        );
    }

    #[test]
    fn a_closed_command_never_extends_into_the_next_sentence() {
        // Plan 140 S9 (smoke:orcle-commands): the clear's words used to read
        // the next final as its target, firing a second clear and losing the
        // removal.
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        let clear = detector
            .observe_final("c", 1, "Golem, clear the highlight.", start, &PLAIN)
            .expect("the clear");
        assert_eq!(clear.kind, CommandKind::Clear);
        let removal = detector
            .observe_final(
                "c",
                2,
                "This one is toxic. Remove it from our chat.",
                start + Duration::from_secs(1),
                &PLAIN,
            )
            .expect("the removal is heard, not a second clear");
        assert_eq!(removal.kind, CommandKind::Remove);
        assert_eq!(removal.target, CommandTarget::Deixis);
        assert_eq!(removal.reason.as_deref(), Some("toxic"));
        assert!(!removal.wake_word);

        // A sentence with no command of its own fires nothing.
        let mut detector = CommandDetector::default();
        assert!(
            detector
                .observe_final("c", 1, "Golem, clear the highlight.", start, &PLAIN)
                .is_some()
        );
        assert_eq!(
            detector.observe_final(
                "c",
                2,
                "This one is toxic.",
                start + Duration::from_secs(1),
                &PLAIN
            ),
            None
        );
    }

    #[test]
    fn a_wake_word_owns_a_later_verb_only_when_its_command_reaches_it() {
        // One final, two sentences: the latest start wins, and the clear that
        // ended before "remove" does not swallow it.
        let command = detect_one(
            "Golem, clear the highlight. This one is toxic, remove it from our chat.",
            &PLAIN,
        )
        .expect("a command");
        assert_eq!(command.kind, CommandKind::Remove);
        assert_eq!(command.target, CommandTarget::Deixis);
        // The wake word still owns a verb its own command reaches.
        let owned = detect_one("Golem, this one is toxic, remove it from our chat.", &PLAIN)
            .expect("a command");
        assert_eq!(owned.kind, CommandKind::Remove);
        assert!(owned.wake_word);
    }

    #[test]
    fn a_structured_removal_split_over_two_finals_reports_once() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        let found = detector
            .observe_final("c", 1, "This one is toxic. Remove it", start, &PLAIN)
            .expect("the reason completes the structured removal");
        assert_eq!(found.kind, CommandKind::Remove);
        assert_eq!(found.target, CommandTarget::Deixis);
        assert_eq!(found.reason.as_deref(), Some("toxic"));
        assert_eq!(
            detector.observe_final(
                "c",
                2,
                "from our chat.",
                start + Duration::from_secs(3),
                &PLAIN
            ),
            None,
            "the same removal, now with its noun, is the same request"
        );
    }

    #[test]
    fn a_name_cut_by_a_final_boundary_is_reported_again_when_it_grows() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        let first = detector
            .observe_final(
                "c",
                1,
                "Golem, highlight the comment from coders",
                start,
                &PLAIN,
            )
            .expect("the name so far");
        assert_eq!(first.target, name("coders"));
        let grown = detector
            .observe_final("c", 2, "X please", start + Duration::from_secs(3), &PLAIN)
            .expect("the name grew into the next final");
        assert_eq!(grown.target, name("coders x"));
        assert_eq!(
            detector.observe_final("c", 3, "and then", start + Duration::from_secs(6), &PLAIN),
            None
        );
    }

    #[test]
    fn a_name_never_grows_across_a_long_gap() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert!(
            detector
                .observe_final(
                    "c",
                    1,
                    "Golem, highlight the comment from coders",
                    start,
                    &PLAIN
                )
                .is_some()
        );
        // Five seconds of silence: "x" is a new sentence, not the name.
        assert_eq!(
            detector.observe_final(
                "c",
                2,
                "x marks the spot",
                start + Duration::from_secs(8),
                &PLAIN
            ),
            None
        );
    }

    #[test]
    fn repeats_dedupe_by_final_and_by_command_for_ten_seconds() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert!(
            detector
                .observe_final("c", 1, "Golem, take it down", start, &PLAIN)
                .is_some()
        );
        // The same final again (a replayed completion) is ignored.
        assert!(
            detector
                .observe_final("c", 1, "Golem, take it down", start, &PLAIN)
                .is_none()
        );
        // The same command within ten seconds is the same request.
        assert!(
            detector
                .observe_final(
                    "c",
                    2,
                    "Golem, take it down",
                    start + Duration::from_secs(5),
                    &PLAIN
                )
                .is_none()
        );
        // A different command passes.
        assert!(
            detector
                .observe_final(
                    "c",
                    3,
                    "Golem, show the last comment",
                    start + Duration::from_secs(6),
                    &PLAIN
                )
                .is_some()
        );
        // The first one is new again after the window.
        assert!(
            detector
                .observe_final(
                    "c",
                    4,
                    "Golem, take it down",
                    start + Duration::from_secs(11),
                    &PLAIN
                )
                .is_some()
        );
    }

    #[test]
    fn the_window_forgets_words_after_ten_seconds() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert_eq!(
            detector.observe_final("c", 1, "Golem, highlight the comment", start, &PLAIN),
            None
        );
        assert_eq!(
            detector.observe_final(
                "c",
                2,
                "from coders X",
                start + Duration::from_secs(11),
                &PLAIN
            ),
            None,
            "the first final left the window"
        );
    }

    #[test]
    fn answers_and_choices_are_never_deduped() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert_eq!(
            detector
                .observe_final("c", 1, "yes", start, &ANSWERING)
                .map(|command| command.kind),
            Some(CommandKind::Confirm)
        );
        assert_eq!(
            detector
                .observe_final("c", 2, "yes", start + Duration::from_secs(3), &ANSWERING)
                .map(|command| command.kind),
            Some(CommandKind::Confirm),
            "a second card gets its own yes"
        );
        assert_eq!(
            detector
                .observe_final(
                    "c",
                    3,
                    "the first one",
                    start + Duration::from_secs(4),
                    &CHOOSING
                )
                .map(|command| command.kind),
            Some(CommandKind::Choose(0))
        );
        assert_eq!(
            detector
                .observe_final(
                    "c",
                    4,
                    "the first one",
                    start + Duration::from_secs(6),
                    &CHOOSING
                )
                .map(|command| command.kind),
            Some(CommandKind::Choose(0))
        );
    }

    #[test]
    fn clearing_forgets_a_half_said_command() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        assert_eq!(
            detector.observe_final("c", 1, "Golem, highlight the comment", start, &PLAIN),
            None
        );
        detector.clear();
        assert_eq!(
            detector.observe_final(
                "c",
                2,
                "from coders X",
                start + Duration::from_secs(3),
                &PLAIN
            ),
            None
        );
        // Cleared words are gone; a replayed final stays known.
        assert_eq!(
            detector.observe_final(
                "c",
                1,
                "Golem, take it down",
                start + Duration::from_secs(4),
                &PLAIN
            ),
            None
        );
    }

    #[test]
    fn an_unknown_is_noted_once_per_address() {
        let mut detector = CommandDetector::default();
        let start = Instant::now();
        let unknown = detector
            .observe_final("c", 1, "Golem, you are amazing.", start, &PLAIN)
            .expect("addressed and not understood");
        assert_eq!(unknown.kind, CommandKind::Unknown);
        assert_eq!(unknown.heard, "you are amazing");
        assert_eq!(
            detector.observe_final("c", 2, "lol.", start + Duration::from_secs(3), &PLAIN),
            None,
            "the same address is not noted again"
        );
        // An address whose sentence is still open says nothing yet.
        assert_eq!(
            detector.observe_final(
                "c",
                3,
                "Golem, this one",
                start + Duration::from_secs(6),
                &PLAIN
            ),
            None
        );
    }

    #[test]
    fn words_normalise_case_punctuation_and_possessives() {
        let mut ordinal = 0;
        let words = tokenize(
            "Hey Golem, show CodersX's question! It's coders_x.",
            1,
            Instant::now(),
            &mut ordinal,
        );
        let texts: Vec<&str> = words.iter().map(|word| word.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "hey", "golem", "show", "codersx", "question", "its", "coders", "x"
            ]
        );
        assert!(words[1].pause_after && !words[1].sentence_end);
        assert!(words[3].possessive);
        assert!(words[4].sentence_end);
        assert!(words[5].sentence_start && !words[5].possessive);
        assert!(words[7].sentence_end);
        assert_eq!(ordinal, 8);
        assert_eq!(split_possessive("coders'"), ("coders", true));
        assert_eq!(split_possessive("X\u{2019}s"), ("X", true));
        assert_eq!(split_possessive("that's"), ("that's", false));
    }

    #[test]
    fn reasons_are_canonical_and_nearest_the_verb() {
        let command = detect_one(
            "That was spam earlier. Anyway this one is hateful, Golem remove it from chat",
            &PLAIN,
        )
        .unwrap();
        assert_eq!(command.reason.as_deref(), Some("hate"));
        let command = detect_one("Golem, delete that message, he's a scammer", &PLAIN).unwrap();
        assert_eq!(command.reason.as_deref(), Some("scam"));
        assert_eq!(
            detect_one("Golem, take it down", &PLAIN).unwrap().reason,
            None
        );
    }

    #[test]
    fn the_wake_words_are_golem_the_persona_name_and_the_hidden_orcle_aliases() {
        assert_eq!(
            wake_name_tokens("Grum the Goblin"),
            vec!["grum".to_string(), "goblin".to_string()]
        );
        // Lowercased, ASCII-folded, three letters or more, digits dropped,
        // never a duplicate of a wake word.
        assert_eq!(wake_name_tokens("Bö Golem99"), Vec::<String>::new());
        assert_eq!(wake_name_tokens("Bö Vexlar99"), vec!["vexlar".to_string()]);
        assert_eq!(wake_name_tokens("Zoë"), vec!["zoe".to_string()]);
        assert_eq!(wake_name_tokens("Golem"), Vec::<String>::new());
        assert_eq!(wake_name_tokens("Al"), Vec::<String>::new());
        // "golem" always works; the "Orcle" spellings stay as hidden aliases
        // for one release; the weak real words are gone.
        assert_eq!(WAKE_WORDS[0], "golem");
        assert!(WAKE_WORDS.contains(&"orcle"));
        assert!(WAKE_WORDS.contains(&"orkle"));
        assert!(!WAKE_WORDS.contains(&"oracle"));
        assert!(!WAKE_WORDS.contains(&"orca"));
    }

    #[test]
    fn golem_and_the_persona_name_wake_the_detector_and_oracle_does_not() {
        let highlight =
            |text: &str| detect_one(text, &PLAIN).map(|command| (command.kind, command.wake_word));
        assert_eq!(
            highlight("Golem, highlight the last comment"),
            Some((CommandKind::Highlight, true))
        );
        // The hidden alias, one release more (plan 164 D2).
        assert_eq!(
            highlight("Orcle, highlight the last comment"),
            Some((CommandKind::Highlight, true))
        );
        assert_eq!(highlight("Oracle, highlight the last comment"), None);
        // A name the persona does not have is talk.
        assert_eq!(highlight("Zarquon, highlight the last comment"), None);
        set_persona_wake_tokens("Zarquon the Goblin");
        assert_eq!(
            highlight("Zarquon, highlight the last comment"),
            Some((CommandKind::Highlight, true))
        );
        let heard = detect_one("Zarquon, take it down", &PLAIN).unwrap();
        assert_eq!(heard.heard, "zarquon take it down");
        assert!(heard.wake_word);
        // A new name forgets the old one.
        set_persona_wake_tokens("Golem");
        assert_eq!(highlight("Zarquon, highlight the last comment"), None);
    }
}
