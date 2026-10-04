//! Chat you haven't acknowledged (plan 068 D9).
//!
//! Local and pure: an author ledger per Orcle session (who chatted, who is new
//! here, who the streamer already greeted and how), the fuzzy name matcher
//! behind "greeted by voice" and "greeted in chat", and the dead-air nudge
//! decision. Nothing here talks to the network or the audio thread; the
//! co-host engine owns one ledger and one nudge lane per session and drops
//! both with it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::cohost::{
    CohostDeadAirNudge, CohostPriority, CohostQuestion, CohostSayHi, VoiceActivity,
};
use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::streaming::{StreamPlatform, stream_platform_id};

/// "Say hi" keeps a first-time chatter this long after their first message;
/// a voice greeting matches authors who chatted within the same window.
pub(crate) const SAY_HI_WINDOW: Duration = Duration::from_secs(15 * 60);
pub(crate) const SAY_HI_MAX: usize = 5;
/// Authors remembered per session; the oldest leave first past it.
const LEDGER_CAP: usize = 5000;
/// A chat row repeating the streamer's own send this soon after it is the
/// send's echo: its author is the streamer on that platform (X marks no
/// broadcaster role). Short texts ("gg", "lol") never prove anything.
const OWN_SEND_ECHO_WINDOW: Duration = Duration::from_secs(120);
const OWN_SEND_ECHO_MIN_CHARS: usize = 6;
const OWN_SENDS_CAP: usize = 20;
const GREETED_LOG_CAP: usize = 20;
/// Display names on the wire, in UTF-16 units (the renderer contract caps
/// them at 512).
const AUTHOR_NAME_MAX_CHARS: usize = 120;
/// The nudge text on the wire, in UTF-16 units (`cohostDeadAirNudgeSchema`).
const DEAD_AIR_TEXT_MAX_UNITS: usize = 1024;

/// The streamer has been quiet this long (plan 068 D9).
pub(crate) const DEAD_AIR_SILENCE: Duration = Duration::from_secs(20);
/// Frames older than this mean the caption task is not hearing anything: no
/// signal, so no nudge.
pub(crate) const VOICE_FRAME_STALE: Duration = Duration::from_secs(3);
/// At most one nudge per this long.
pub(crate) const DEAD_AIR_NUDGE_GAP: Duration = Duration::from_secs(120);
/// A nudge rides the state this long; the renderer toasts it once by key.
pub(crate) const DEAD_AIR_NUDGE_TTL: Duration = Duration::from_secs(30);
const DEAD_AIR_QUOTE_MAX_CHARS: usize = 80;

// --- Name matching --------------------------------------------------------------

/// Common words that never count as a name match, in either direction: a
/// name made only of them has no voice form, and a spoken one never matches
/// a name by edit distance. Sorted (a test keeps it that way) for the binary
/// search.
const STOP_WORDS: &[&str] = &[
    "a",
    "about",
    "again",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "awesome",
    "back",
    "be",
    "because",
    "been",
    "best",
    "bit",
    "bro",
    "but",
    "by",
    "can",
    "chat",
    "cheers",
    "come",
    "cool",
    "could",
    "day",
    "did",
    "do",
    "does",
    "done",
    "dont",
    "dude",
    "even",
    "every",
    "everybody",
    "everyone",
    "fine",
    "first",
    "folks",
    "for",
    "friend",
    "friends",
    "from",
    "fun",
    "game",
    "games",
    "gaming",
    "get",
    "gg",
    "go",
    "going",
    "gonna",
    "good",
    "got",
    "great",
    "guy",
    "guys",
    "had",
    "has",
    "have",
    "he",
    "hello",
    "her",
    "here",
    "hey",
    "hi",
    "him",
    "his",
    "how",
    "i",
    "if",
    "im",
    "in",
    "is",
    "it",
    "its",
    "just",
    "know",
    "let",
    "like",
    "live",
    "lol",
    "look",
    "lot",
    "love",
    "man",
    "me",
    "more",
    "much",
    "music",
    "my",
    "new",
    "nice",
    "no",
    "not",
    "now",
    "of",
    "official",
    "oh",
    "ok",
    "okay",
    "on",
    "one",
    "or",
    "our",
    "out",
    "people",
    "play",
    "playing",
    "real",
    "really",
    "right",
    "say",
    "see",
    "she",
    "so",
    "some",
    "sorry",
    "stream",
    "streamer",
    "streaming",
    "streams",
    "sub",
    "subs",
    "subscribe",
    "sure",
    "thank",
    "thanks",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "they",
    "thing",
    "think",
    "this",
    "time",
    "to",
    "today",
    "too",
    "ttv",
    "tv",
    "two",
    "up",
    "us",
    "very",
    "video",
    "viewer",
    "viewers",
    "wanna",
    "want",
    "was",
    "watch",
    "watching",
    "way",
    "we",
    "welcome",
    "well",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "wow",
    "xd",
    "yeah",
    "yes",
    "yo",
    "you",
    "your",
    "yt",
];

fn is_stop_word(word: &str) -> bool {
    STOP_WORDS.binary_search(&word).is_ok()
}

/// Everyday words people also use as a whole handle ("Pizza", "Python",
/// "Rust"). Said on their own they are usually just the word: a name that is
/// only one of them needs a greeting close by. Sorted (a test keeps it that
/// way) for the binary search; never a stop word.
const COMMON_NAME_WORDS: &[&str] = &[
    "angel", "apple", "arrow", "ash", "baby", "bacon", "banana", "bear", "beast", "bird", "blade",
    "blaze", "blue", "boss", "bread", "bug", "bunny", "butter", "byte", "cake", "candy", "captain",
    "cat", "chaos", "cheese", "chef", "cherry", "chicken", "chill", "chip", "cloud", "clown",
    "code", "coder", "coffee", "cookie", "crazy", "crow", "crystal", "cyber", "daddy", "dark",
    "data", "demon", "dev", "doc", "doctor", "dog", "dragon", "dream", "duck", "eagle", "echo",
    "fan", "fire", "fish", "flash", "fox", "frog", "frost", "fury", "gamer", "ghost", "gold",
    "golden", "green", "happy", "hawk", "hero", "honey", "hunter", "ice", "iron", "java", "jelly",
    "joker", "king", "knight", "lady", "lazy", "legend", "lemon", "light", "linux", "lion", "lord",
    "lover", "lucky", "magic", "mango", "master", "max", "metal", "mint", "monkey", "moon",
    "ninja", "noob", "nova", "ocean", "orange", "owl", "panda", "peach", "pepper", "phoenix",
    "pickle", "pilot", "pixel", "pizza", "player", "potato", "prince", "pro", "python", "queen",
    "quiet", "rabbit", "rain", "raven", "rebel", "red", "robot", "rock", "rocket", "rogue", "ruby",
    "rust", "salt", "shadow", "shark", "silver", "sky", "snake", "sniper", "snow", "soul", "space",
    "spark", "spider", "star", "steel", "storm", "sugar", "sun", "swift", "taco", "tiger", "toast",
    "turtle", "vibes", "viper", "wizard", "wolf", "zero",
];

fn is_common_word(word: &str) -> bool {
    COMMON_NAME_WORDS.binary_search(&word).is_ok()
}

/// Greetings that make a common-word name a greeting ("hey pizza"), as name
/// tokens: "what's up" is `what s up`.
const GREETING_CUES: &[&[&str]] = &[
    &["hi"],
    &["hey"],
    &["hello"],
    &["hiya"],
    &["howdy"],
    &["welcome"],
    &["thanks"],
    &["thank", "you"],
    &["thx"],
    &["yo"],
    &["sup"],
    &["wassup"],
    &["whats", "up"],
    &["what", "s", "up"],
    &["shout", "out"],
    &["shoutout"],
    &["good", "to", "see"],
];

/// How many words away a greeting may be from a common-word name.
const GREETING_CUE_WINDOW: usize = 3;

/// Lowercased word tokens: split on anything that is not a letter or digit,
/// on camelCase ("DarkKnight", "XMLParser"), and between letters and digits;
/// digit runs are dropped ("Gamer99" is "gamer"). Names and spoken text use
/// the same tokens, so "x_Dark_Knight_x" and "dark knight" meet.
pub(crate) fn name_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for run in text.split(|c: char| !c.is_alphanumeric()) {
        let chars: Vec<char> = run.chars().collect();
        let mut start = 0;
        for index in 1..=chars.len() {
            let boundary = index == chars.len() || {
                let prev = chars[index - 1];
                let current = chars[index];
                let next = chars.get(index + 1).copied();
                prev.is_numeric() != current.is_numeric()
                    || (prev.is_lowercase() && current.is_uppercase())
                    || (prev.is_uppercase()
                        && current.is_uppercase()
                        && next.is_some_and(char::is_lowercase))
            };
            if !boundary {
                continue;
            }
            let token: String = chars[start..index].iter().collect();
            start = index;
            if token.chars().all(char::is_numeric) {
                continue;
            }
            tokens.push(token.to_lowercase());
        }
    }
    tokens
}

/// How a display name is recognised in what the streamer said or typed
/// (plan 068 D9).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct NameForms {
    /// Forms that name the viewer by themselves: a distinctive one-word name,
    /// and a longer name joined whole ("rustlover") or as two neighbouring
    /// words in order (speech splits "rust lover"; the candidates glue it).
    pub(crate) plain: Vec<String>,
    /// A one-word name that is also an everyday word ("pizza"): it names the
    /// viewer only with a greeting within three words.
    pub(crate) cued: Vec<String>,
}

impl NameForms {
    fn push_plain(&mut self, form: String) {
        if !self.plain.contains(&form) {
            self.plain.push(form);
        }
    }

    /// A name that comes down to one word: plain, or cued when everyday.
    fn push_word(&mut self, word: &str) {
        if word.chars().count() < 2 || is_stop_word(word) {
            return;
        }
        if is_common_word(word) {
            if !self.cued.iter().any(|form| form == word) {
                self.cued.push(word.to_string());
            }
        } else {
            self.push_plain(word.to_string());
        }
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.plain.is_empty() && self.cued.is_empty()
    }
}

/// The forms of a display name (plan 068 D9). A one-token name is that token
/// (two chars or more, never a stop word; an everyday word needs a greeting
/// cue), so "bo" matches only as the whole name. A longer name drops its
/// decorations (stop words, one- and two-char tokens like the "x" in
/// "x_Dark_Knight_x"): what is left of one word follows the one-token rule;
/// two or more words match only as neighbours in order ("rust lover" for
/// "RustLover", never "rust" alone). The whole name joined is a form too
/// ("iceman"), unless every token is a stop word.
pub(crate) fn name_match_forms(display_name: &str) -> NameForms {
    let tokens = name_tokens(display_name);
    let mut forms = NameForms::default();
    match tokens.as_slice() {
        [] => {}
        [only] => forms.push_word(only),
        many => {
            let significant: Vec<&String> = many
                .iter()
                .filter(|token| token.chars().count() >= 3 && !is_stop_word(token))
                .collect();
            match significant.as_slice() {
                [] => {}
                [one] => forms.push_word(one),
                several => {
                    for pair in several.windows(2) {
                        forms.push_plain(format!("{}{}", pair[0], pair[1]));
                    }
                }
            }
            let joined: String = many.concat();
            if joined.chars().count() >= 4
                && many.iter().any(|token| !is_stop_word(token))
                && !is_stop_word(&joined)
                && !is_common_word(&joined)
            {
                forms.push_plain(joined);
            }
        }
    }
    forms
}

/// What a name form is compared against: every word that is not a stop word,
/// and each pair of neighbours glued together (speech splits "DarkKnight"),
/// unless both are stop words ("the stream" is never "TheStream").
fn match_candidates(words: &[String]) -> Vec<String> {
    let mut candidates: Vec<String> = words
        .iter()
        .filter(|word| !is_stop_word(word))
        .cloned()
        .collect();
    for pair in words.windows(2) {
        if is_stop_word(&pair[0]) && is_stop_word(&pair[1]) {
            continue;
        }
        candidates.push(format!("{}{}", pair[0], pair[1]));
    }
    candidates
}

/// Exact for forms under six chars, edit distance one from six on.
fn forms_match(candidates: &[String], forms: &[String]) -> bool {
    forms.iter().any(|form| {
        let fuzzy = form.chars().count() >= 6;
        candidates
            .iter()
            .any(|candidate| candidate == form || (fuzzy && within_one_edit(form, candidate)))
    })
}

/// Whether a greeting ends within `GREETING_CUE_WINDOW` words before `at`,
/// or starts within that many words after it.
fn greeting_cue_near(words: &[String], at: usize) -> bool {
    GREETING_CUES.iter().any(|cue| {
        if words.len() < cue.len() {
            return false;
        }
        (0..=words.len() - cue.len()).any(|start| {
            let end = start + cue.len() - 1;
            let near = (end < at && at - end <= GREETING_CUE_WINDOW)
                || (start > at && start - at <= GREETING_CUE_WINDOW);
            near && words[start..=end]
                .iter()
                .zip(cue.iter())
                .all(|(word, expected)| word == expected)
        })
    })
}

/// Whether `words` (the name tokens of what was said or typed) name a viewer
/// with `forms`; `candidates` is `match_candidates(words)`, computed once per
/// text.
fn name_forms_match(words: &[String], candidates: &[String], forms: &NameForms) -> bool {
    forms_match(candidates, &forms.plain)
        || forms.cued.iter().any(|form| {
            words
                .iter()
                .enumerate()
                .any(|(at, word)| word == form && greeting_cue_near(words, at))
        })
}

/// Levenshtein distance <= 1 (one insert, delete or substitution). No
/// allocation: it runs for every recent author on every transcript final,
/// under the engine lock.
fn within_one_edit(left: &str, right: &str) -> bool {
    let (left_len, right_len) = (left.chars().count(), right.chars().count());
    if left_len.abs_diff(right_len) > 1 {
        return false;
    }
    let mut left_rest = left.chars();
    let mut right_rest = right.chars();
    loop {
        match (left_rest.clone().next(), right_rest.clone().next()) {
            (Some(l), Some(r)) if l == r => {
                left_rest.next();
                right_rest.next();
            }
            _ => break,
        }
    }
    let (left_rest, right_rest) = (left_rest.as_str(), right_rest.as_str());
    fn tail(value: &str) -> &str {
        let mut chars = value.chars();
        chars.next();
        chars.as_str()
    }
    match left_len.cmp(&right_len) {
        std::cmp::Ordering::Equal => left_rest.is_empty() || tail(left_rest) == tail(right_rest),
        std::cmp::Ordering::Greater => tail(left_rest) == right_rest,
        std::cmp::Ordering::Less => left_rest == tail(right_rest),
    }
}

/// Whether words the streamer said (or typed) name this viewer (plan 068 D9):
/// case, `@`, underscores, camelCase and trailing digits normalised; exact for
/// short forms, one edit for long ones; never on a stop word; a long name only
/// as neighbouring words; an everyday-word name only with a greeting. The
/// ledger runs the same halves with each author's forms computed once.
#[cfg(test)]
pub(crate) fn transcript_mentions_name(transcript_words: &[String], display_name: &str) -> bool {
    name_forms_match(
        transcript_words,
        &match_candidates(transcript_words),
        &name_match_forms(display_name),
    )
}

/// `@handle` mentions in a typed message, lowercased and without trailing
/// punctuation.
fn at_mentions(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|piece| piece.strip_prefix('@'))
        .map(|handle| {
            handle
                .trim_end_matches(|c: char| !(c.is_alphanumeric() || c == '_'))
                .to_lowercase()
        })
        .filter(|handle| !handle.is_empty())
        .collect()
}

/// A display name as an `@handle` would spell it.
fn handle_form(display_name: &str) -> String {
    display_name
        .trim()
        .trim_start_matches('@')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

// --- Author ledger ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GreetedHow {
    Voice,
    Chat,
    Highlight,
    Manual,
}

impl GreetedHow {
    fn label(self) -> &'static str {
        match self {
            Self::Voice => "by voice",
            Self::Chat => "in chat",
            Self::Highlight => "on stream",
            Self::Manual => "by hand",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Greeting {
    pub(crate) at: Instant,
    pub(crate) how: GreetedHow,
}

/// One viewer this session, never the streamer.
#[derive(Debug, Clone)]
pub(crate) struct LedgerAuthor {
    pub(crate) name: String,
    pub(crate) platform: StreamPlatform,
    pub(crate) first_seen_at: Instant,
    /// The backend's receive time of their first row here, for the wire.
    first_seen_iso: String,
    pub(crate) last_seen_at: Instant,
    /// Their first message in the channel (plan 055 detection) was seen this
    /// session.
    pub(crate) first_message: bool,
    pub(crate) message_count: u64,
    pub(crate) greeted: Option<Greeting>,
    /// `name_match_forms(name)`, computed once.
    name_forms: NameForms,
}

/// How the session's chatters were greeted, for the Orcle report (plan 119).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct GreetingCounts {
    /// Authors whose first message in the channel landed this session.
    pub(crate) first_timers: u64,
    pub(crate) first_timers_greeted: u64,
    pub(crate) by_voice: u64,
    pub(crate) by_chat: u64,
    pub(crate) on_stream: u64,
    pub(crate) manual: u64,
}

/// Every chatter of one Orcle session, keyed like alert corroboration
/// (`alert_author_key`). Lives in the session and leaves with it.
#[derive(Debug, Default)]
pub(crate) struct AuthorLedger {
    authors: HashMap<String, LedgerAuthor>,
    /// First-seen order, for the cap.
    order: VecDeque<String>,
    /// Keys of first-time chatters, first-seen order ("Say hi" reads these).
    first_timers: VecDeque<String>,
    /// Keys that turned out to be the streamer: never enter again.
    self_keys: HashSet<String>,
    own_sends: VecDeque<(Instant, String)>,
    /// "Say hi" keys as last published, so an entry aging out is news.
    published_say_hi: Vec<String>,
    /// Greeting lines for the backend log, drained by the engine.
    log: Vec<String>,
}

impl AuthorLedger {
    /// Note one delivered chat row. Chat and tips count; tombstones, notices
    /// and custom RTMP rows do not. The streamer never enters: an owner or
    /// broadcaster row, or the echo of their own send, marks the key as the
    /// streamer's for the rest of the session.
    pub(crate) fn note_message(
        &mut self,
        key: &str,
        message: &LiveChatMessage,
        owner: bool,
        now: Instant,
    ) {
        if message.is_deleted
            || !matches!(
                message.event_type,
                LiveChatEventType::Message | LiveChatEventType::Paid
            )
            || message.platform == StreamPlatform::Custom
            || self.self_keys.contains(key)
        {
            return;
        }
        if owner || self.is_own_echo(&message.message_text, now) {
            self.self_keys.insert(key.to_string());
            self.forget(key);
            return;
        }
        let name = crate::cohost::truncate_utf16(message.author_name.trim(), AUTHOR_NAME_MAX_CHARS);
        if name.is_empty() {
            return;
        }
        if let Some(author) = self.authors.get_mut(key) {
            author.last_seen_at = now;
            author.message_count = author.message_count.saturating_add(1);
            if message.first_message && !author.first_message {
                author.first_message = true;
                self.first_timers.push_back(key.to_string());
            }
            return;
        }
        self.authors.insert(
            key.to_string(),
            LedgerAuthor {
                name_forms: name_match_forms(&name),
                name,
                platform: message.platform,
                first_seen_at: now,
                first_seen_iso: message.received_at.clone(),
                last_seen_at: now,
                first_message: message.first_message,
                message_count: 1,
                greeted: None,
            },
        );
        self.order.push_back(key.to_string());
        if message.first_message {
            self.first_timers.push_back(key.to_string());
        }
        while self.order.len() > LEDGER_CAP {
            if let Some(oldest) = self.order.pop_front() {
                self.authors.remove(&oldest);
                self.first_timers.retain(|key| *key != oldest);
            }
        }
    }

    fn forget(&mut self, key: &str) {
        if self.authors.remove(key).is_some() {
            self.order.retain(|known| known != key);
            self.first_timers.retain(|known| known != key);
        }
    }

    /// Remember the streamer's own send (its echo proves who they are).
    pub(crate) fn note_own_send(&mut self, text: &str, now: Instant) {
        let text = collapse_whitespace(text);
        if text.chars().count() < OWN_SEND_ECHO_MIN_CHARS {
            return;
        }
        self.own_sends
            .retain(|(at, _)| now.saturating_duration_since(*at) < OWN_SEND_ECHO_WINDOW);
        self.own_sends.push_back((now, text));
        while self.own_sends.len() > OWN_SENDS_CAP {
            self.own_sends.pop_front();
        }
    }

    fn is_own_echo(&self, text: &str, now: Instant) -> bool {
        let text = collapse_whitespace(text);
        text.chars().count() >= OWN_SEND_ECHO_MIN_CHARS
            && self.own_sends.iter().any(|(at, sent)| {
                now.saturating_duration_since(*at) < OWN_SEND_ECHO_WINDOW && *sent == text
            })
    }

    /// Mark one author greeted. False when unknown or already greeted.
    pub(crate) fn greet(&mut self, key: &str, how: GreetedHow, now: Instant) -> bool {
        let Some(author) = self.authors.get_mut(key) else {
            return false;
        };
        if author.greeted.is_some() {
            return false;
        }
        author.greeted = Some(Greeting { at: now, how });
        let line = describe_greeting(author);
        if self.log.len() < GREETED_LOG_CAP {
            self.log.push(line);
        }
        true
    }

    /// A transcript final: every ungreeted author who chatted in the last
    /// `SAY_HI_WINDOW` (and before the words were said) and whose name the
    /// streamer said. Returns how many were greeted.
    pub(crate) fn greet_by_voice(&mut self, text: &str, at: Instant) -> usize {
        let words = name_tokens(text);
        if words.is_empty() {
            return 0;
        }
        let candidates = match_candidates(&words);
        let keys: Vec<String> = self
            .authors
            .iter()
            .filter(|(_, author)| {
                author.greeted.is_none()
                    && at >= author.first_seen_at
                    && at.saturating_duration_since(author.last_seen_at) < SAY_HI_WINDOW
                    && name_forms_match(&words, &candidates, &author.name_forms)
            })
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter()
            .filter(|key| self.greet(key, GreetedHow::Voice, at))
            .count()
    }

    /// The streamer's own chat send: `@handle` or the name in the text.
    pub(crate) fn greet_by_chat(&mut self, text: &str, now: Instant) -> usize {
        let words = name_tokens(text);
        let candidates = match_candidates(&words);
        let mentions = at_mentions(text);
        let keys: Vec<String> = self
            .authors
            .iter()
            .filter(|(_, author)| {
                author.greeted.is_none()
                    && (name_forms_match(&words, &candidates, &author.name_forms)
                        || mentions.contains(&handle_form(&author.name)))
            })
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter()
            .filter(|key| self.greet(key, GreetedHow::Chat, now))
            .count()
    }

    /// First-time chatters nobody greeted yet, first seen within
    /// `SAY_HI_WINDOW`, oldest first, at most `SAY_HI_MAX`.
    pub(crate) fn say_hi(&self, now: Instant) -> Vec<CohostSayHi> {
        let mut waiting: Vec<(&String, &LedgerAuthor)> = self
            .first_timers
            .iter()
            .filter_map(|key| self.authors.get(key).map(|author| (key, author)))
            .filter(|(_, author)| {
                author.greeted.is_none()
                    && now.saturating_duration_since(author.first_seen_at) < SAY_HI_WINDOW
            })
            .collect();
        waiting.sort_by(|(left_key, left), (right_key, right)| {
            (left.first_seen_at, *left_key).cmp(&(right.first_seen_at, *right_key))
        });
        waiting.dedup_by(|(left, _), (right, _)| left == right);
        waiting
            .into_iter()
            .take(SAY_HI_MAX)
            .map(|(key, author)| CohostSayHi {
                author_key: key.clone(),
                name: author.name.clone(),
                platform: author.platform,
                first_seen_at: author.first_seen_iso.clone(),
            })
            .collect()
    }

    /// True when "Say hi" differs from what was last published (a new
    /// first-timer, a greeting, an entry aging out). Drops first-timers that
    /// can never show again.
    pub(crate) fn say_hi_changed(&mut self, now: Instant) -> bool {
        let authors = &self.authors;
        self.first_timers.retain(|key| {
            authors.get(key).is_some_and(|author| {
                author.greeted.is_none()
                    && now.saturating_duration_since(author.first_seen_at) < SAY_HI_WINDOW
            })
        });
        let keys: Vec<String> = self
            .say_hi(now)
            .into_iter()
            .map(|entry| entry.author_key)
            .collect();
        if keys == self.published_say_hi {
            return false;
        }
        self.published_say_hi = keys;
        true
    }

    pub(crate) fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }

    /// Sign-out: a greeting heard in speech goes with the purged transcript
    /// (the viewer may show in "Say hi" again), and so does the unread
    /// greeting log. Chat, highlight and manual greetings stay.
    pub(crate) fn forget_voice(&mut self) {
        for author in self.authors.values_mut() {
            if author
                .greeted
                .as_ref()
                .is_some_and(|greeting| greeting.how == GreetedHow::Voice)
            {
                author.greeted = None;
            }
        }
        self.log.clear();
    }

    /// Greeting totals for the Orcle report (plan 119 S1), over every author
    /// of the session. Never the "Say hi" list: that one is pruned as entries
    /// age out or get greeted.
    pub(crate) fn greeting_counts(&self) -> GreetingCounts {
        let mut counts = GreetingCounts::default();
        for author in self.authors.values() {
            if author.first_message {
                counts.first_timers += 1;
                if author.greeted.is_some() {
                    counts.first_timers_greeted += 1;
                }
            }
            match author.greeted.as_ref().map(|greeting| greeting.how) {
                Some(GreetedHow::Voice) => counts.by_voice += 1,
                Some(GreetedHow::Chat) => counts.by_chat += 1,
                Some(GreetedHow::Highlight) => counts.on_stream += 1,
                Some(GreetedHow::Manual) => counts.manual += 1,
                None => {}
            }
        }
        counts
    }

    #[cfg(test)]
    pub(crate) fn author(&self, key: &str) -> Option<&LedgerAuthor> {
        self.authors.get(key)
    }

    #[cfg(test)]
    pub(crate) fn author_greeted_by_voice_for_test(&self) -> bool {
        self.authors.values().any(|author| {
            author
                .greeted
                .as_ref()
                .is_some_and(|greeting| greeting.how == GreetedHow::Voice)
        })
    }
}

fn describe_greeting(author: &LedgerAuthor) -> String {
    let (after, how) = author
        .greeted
        .as_ref()
        .map(|greeting| {
            (
                greeting.at.saturating_duration_since(author.first_seen_at),
                greeting.how.label(),
            )
        })
        .unwrap_or((Duration::ZERO, "somehow"));
    format!(
        "Orcle: {} ({}) was greeted {how}, {} s after their first message here ({} message(s){}).",
        author.name,
        stream_platform_id(author.platform),
        after.as_secs(),
        author.message_count,
        if author.first_message {
            ", first time in the channel"
        } else {
            ""
        }
    )
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- Dead-air nudge ------------------------------------------------------------------

/// Whether the dead-air nudge fires now (plan 068 D9). It needs a signal:
/// frames reaching the caption task, and not exact digital silence (a muted
/// microphone is zeros after the post-mute tap, and so is a lost device). The
/// quiet stretch counts from the later of the last voiced frame and the start
/// of the current live signal, so unmuting never nudges at once. Something
/// must be waiting (an open question, a first-timer to greet), and the
/// previous nudge is at least `DEAD_AIR_NUDGE_GAP` old.
pub(crate) fn dead_air_due(
    voice: VoiceActivity,
    has_candidate: bool,
    last_nudge_at: Option<Instant>,
    now: Instant,
) -> bool {
    if !has_candidate {
        return false;
    }
    if last_nudge_at.is_some_and(|last| now.saturating_duration_since(last) < DEAD_AIR_NUDGE_GAP) {
        return false;
    }
    let fresh = |at: Option<Instant>| {
        at.is_some_and(|at| now.saturating_duration_since(at) <= VOICE_FRAME_STALE)
    };
    if !fresh(voice.last_frame_at) || !fresh(voice.last_signal_at) {
        return false;
    }
    let Some(live_since) = voice.live_since else {
        return false;
    };
    let quiet_since = voice
        .last_voice_at
        .map_or(live_since, |voiced| voiced.max(live_since));
    now.saturating_duration_since(quiet_since) >= DEAD_AIR_SILENCE
}

fn nudge_rank(priority: CohostPriority) -> u8 {
    match priority {
        CohostPriority::High => 0,
        CohostPriority::Normal => 1,
        CohostPriority::Unknown => 2,
        CohostPriority::Low => 3,
    }
}

/// What the nudge suggests: the most pressing open question (high before
/// normal, on topic first, oldest first), else the longest-waiting
/// first-timer, else a low-priority question. `None` with nothing waiting.
pub(crate) fn dead_air_text(
    questions: &[CohostQuestion],
    say_hi: &[CohostSayHi],
) -> Option<String> {
    let best = |include_low: bool| {
        questions
            .iter()
            .filter(|question| include_low || question.priority != CohostPriority::Low)
            .filter(|question| !question.text.trim().is_empty())
            .min_by(|left, right| {
                (
                    nudge_rank(left.priority),
                    !left.on_topic,
                    &left.first_seen_at,
                )
                    .cmp(&(
                        nudge_rank(right.priority),
                        !right.on_topic,
                        &right.first_seen_at,
                    ))
            })
    };
    let text = if let Some(question) = best(false) {
        question_nudge(question)
    } else if let Some(entry) = say_hi.first() {
        format!(
            "Dead air: say hi to {}, it's their first chat.",
            entry.name.trim()
        )
    } else {
        question_nudge(best(true)?)
    };
    Some(crate::cohost::truncate_utf16(
        &text,
        DEAD_AIR_TEXT_MAX_UNITS,
    ))
}

fn question_nudge(question: &CohostQuestion) -> String {
    let text = question
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let quote = if text.encode_utf16().count() > DEAD_AIR_QUOTE_MAX_CHARS {
        let head = crate::cohost::truncate_utf16(&text, DEAD_AIR_QUOTE_MAX_CHARS - 1);
        format!("{}…", head.trim_end())
    } else {
        text
    };
    let askers: Vec<String> = question
        .askers
        .iter()
        .map(|asker| crate::cohost::truncate_utf16(asker.trim(), AUTHOR_NAME_MAX_CHARS))
        .filter(|asker| !asker.is_empty())
        .collect();
    match askers.as_slice() {
        [] => format!("Dead air: answer this question: “{quote}”"),
        [one] => format!("Dead air: answer {one}'s question: “{quote}”"),
        many => format!(
            "Dead air: answer the question {} people asked: “{quote}”",
            many.len()
        ),
    }
}

/// The session's nudge memory: the current nudge (until its TTL), when the
/// last one fired, and the counter behind fresh keys.
#[derive(Debug, Default)]
pub(crate) struct DeadAirLane {
    current: Option<(CohostDeadAirNudge, Instant)>,
    last_at: Option<Instant>,
    seq: u64,
}

impl DeadAirLane {
    pub(crate) fn last_at(&self) -> Option<Instant> {
        self.last_at
    }

    /// The nudge as the wire sees it: `None` once its TTL passed.
    pub(crate) fn current(&self, now: Instant) -> Option<CohostDeadAirNudge> {
        self.current
            .as_ref()
            .filter(|(_, expires_at)| now < *expires_at)
            .map(|(nudge, _)| nudge.clone())
    }

    /// Fire a nudge with a key no earlier nudge (of any session) used.
    pub(crate) fn fire(
        &mut self,
        generation: u64,
        text: String,
        now: Instant,
        now_iso: &str,
    ) -> &CohostDeadAirNudge {
        self.seq = self.seq.saturating_add(1);
        self.last_at = Some(now);
        let nudge = CohostDeadAirNudge {
            key: format!("dead-air-{generation}-{}", self.seq),
            text,
            at: now_iso.to_string(),
        };
        &self.current.insert((nudge, now + DEAD_AIR_NUDGE_TTL)).0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        name_tokens(text)
    }

    fn mentions(said: &str, name: &str) -> bool {
        transcript_mentions_name(&words(said), name)
    }

    #[test]
    fn stop_words_are_sorted_lowercase_and_unique() {
        let mut sorted = STOP_WORDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, STOP_WORDS);
        assert!(STOP_WORDS.iter().all(|word| word.to_lowercase() == *word));
    }

    #[test]
    fn name_tokens_split_camel_case_separators_and_digits() {
        assert_eq!(name_tokens("x_Dark_Knight_x"), ["x", "dark", "knight", "x"]);
        assert_eq!(
            name_tokens("xXShadowHunterXx"),
            ["x", "x", "shadow", "hunter", "xx"]
        );
        assert_eq!(name_tokens("Gamer99"), ["gamer"]);
        assert_eq!(name_tokens("@TheLegend27"), ["the", "legend"]);
        assert_eq!(name_tokens("XMLParser"), ["xml", "parser"]);
        assert_eq!(name_tokens("Sam's here"), ["sam", "s", "here"]);
        assert_eq!(name_tokens("12345"), Vec::<String>::new());
        assert_eq!(name_tokens("ZOË-Río"), ["zoë", "río"]);
    }

    fn forms(plain: &[&str], cued: &[&str]) -> NameForms {
        NameForms {
            plain: plain.iter().map(|form| form.to_string()).collect(),
            cued: cued.iter().map(|form| form.to_string()).collect(),
        }
    }

    #[test]
    fn name_forms_follow_the_short_name_and_stop_word_rules() {
        assert_eq!(name_match_forms("Bo"), forms(&["bo"], &[]));
        assert_eq!(name_match_forms("Bo99"), forms(&["bo"], &[]));
        // A short token counts only as the whole name.
        assert_eq!(
            name_match_forms("Bo_Jangles"),
            forms(&["jangles", "bojangles"], &[])
        );
        // Two real words: only as neighbours in order, never one alone.
        assert_eq!(
            name_match_forms("x_Dark_Knight_x"),
            forms(&["darkknight", "xdarkknightx"], &[])
        );
        assert_eq!(name_match_forms("RustLover"), forms(&["rustlover"], &[]));
        assert_eq!(
            name_match_forms("xXShadowHunterXx"),
            forms(&["shadowhunter", "xxshadowhunterxx"], &[])
        );
        // An everyday word as the name (alone, or all that is left of it)
        // needs a greeting.
        assert_eq!(name_match_forms("Pizza"), forms(&[], &["pizza"]));
        assert_eq!(
            name_match_forms("TheLegend27"),
            forms(&["thelegend"], &["legend"])
        );
        assert_eq!(name_match_forms("IceMan"), forms(&["iceman"], &["ice"]));
        // Stop words never make a form, alone or glued.
        assert!(name_match_forms("Chat").is_empty());
        assert!(name_match_forms("Everyone").is_empty());
        assert!(name_match_forms("TheGame").is_empty());
        assert_eq!(
            name_match_forms("StreamerFan"),
            forms(&["streamerfan"], &["fan"])
        );
        assert!(name_match_forms("J").is_empty());
        assert!(name_match_forms("@").is_empty());
    }

    #[test]
    fn common_name_words_are_sorted_lowercase_unique_and_never_stop_words() {
        let mut sorted = COMMON_NAME_WORDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, COMMON_NAME_WORDS);
        assert!(
            COMMON_NAME_WORDS
                .iter()
                .all(|word| word.to_lowercase() == *word && !is_stop_word(word))
        );
    }

    /// The matcher's table (plan 068 D9): mangled speech, short names, the
    /// stop list, camelCase, digits, and false positives it must avoid.
    #[test]
    fn transcript_mentions_name_table() {
        let cases: &[(&str, &str, bool)] = &[
            // Plain and case-insensitive.
            ("Welcome in Sam!", "Sam", true),
            ("hey SAM how are you", "sam", true),
            ("thanks for the follow, sam's here", "Sam", true),
            // `@`, underscores, camelCase, trailing digits.
            ("welcome gamer", "@Gamer99", true),
            ("hey dark knight welcome in", "x_Dark_Knight_x", true),
            ("shadow hunter is here", "xXShadowHunterXx", true),
            ("what's up legend", "TheLegend27", true),
            // Mangled STT: one edit on a long token, a split long name.
            ("thanks jonathon", "Jonathan", true),
            ("welcome shadow hunner", "ShadowHunter", true),
            ("hi dark night", "darkknight", true),
            ("hi ice man", "IceMan", true),
            // Short names only as the whole name, and only exactly.
            ("hey bo", "Bo", true),
            ("hey bob", "Bo", false),
            ("hey bo", "Bo_Jangles", false),
            ("hey bo jangles", "Bo_Jangles", true),
            ("same thing", "Sam", false),
            ("hey al", "Al", true),
            // Four and five chars: exact only.
            ("hi ana", "Anna", false),
            ("hi anna", "Anna", true),
            ("hi gamers", "Gamer99", false),
            // False positives to avoid: stop words and stop-word glue.
            ("hello chat", "Chat", false),
            ("thanks everyone for coming", "Everyone", false),
            ("welcome to the stream", "StreamerFan", false),
            ("welcome to the stream", "TheStream", false),
            ("let's play the game", "TheGame", false),
            ("thanks guys", "Thankz", false),
            ("good stuff", "GoodVibes", false),
            ("nothing about you", "Jonathan", false),
            ("", "Sam", false),
            ("sam", "", false),
            // A long name is never one of its words alone.
            ("rust", "RustLover", false),
            ("I love rust, it is so fast", "RustLover", false),
            ("rust lover", "RustLover", true),
            ("hey rust lover, welcome", "RustLover", true),
            ("that knight was dark", "x_Dark_Knight_x", false),
            // An everyday word names someone only with a greeting close by.
            ("I love pizza", "Pizza", false),
            ("pizza is ready", "Pizza", false),
            ("hey pizza", "Pizza", true),
            ("pizza, thanks for the follow", "Pizza", true),
            ("good to see you pizza", "Pizza", true),
            ("we write python all day", "Python", false),
            ("welcome in python", "Python", true),
            ("you're a legend", "TheLegend27", false),
            ("the legend is here", "TheLegend27", true),
        ];
        for (said, name, expected) in cases {
            assert_eq!(
                mentions(said, name),
                *expected,
                "said {said:?}, name {name:?}"
            );
        }
    }

    #[test]
    fn within_one_edit_counts_single_edits_only() {
        assert!(within_one_edit("hunter", "hunter"));
        assert!(within_one_edit("hunter", "hunner"));
        assert!(within_one_edit("hunter", "hunters"));
        assert!(within_one_edit("hunters", "hunter"));
        assert!(within_one_edit("jonathan", "jonathon"));
        assert!(!within_one_edit("jonathan", "jonahtan"));
        assert!(!within_one_edit("hunter", "hunt"));
        assert!(!within_one_edit("kaitlyn", "caitlin"));
        assert!(within_one_edit("hunter", "xunter"));
        assert!(within_one_edit("hunter", "hunte"));
        assert!(within_one_edit("renée", "renee"));
        assert!(within_one_edit("", "a"));
        assert!(!within_one_edit("hunter", "uhnter"));
        assert!(!within_one_edit("hunter", "hunterss"));
    }

    fn row(key_seq: u32, name: &str, text: &str, first: bool) -> LiveChatMessage {
        LiveChatMessage {
            id: format!("session-1:twitch:{key_seq}"),
            provider_message_id: format!("m-{key_seq}"),
            platform: StreamPlatform::Twitch,
            target_id: None,
            session_id: "session-1".to_string(),
            author_id: Some(format!("id-{name}")),
            author_name: name.to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: Vec::new(),
            published_at: "2026-09-27T10:00:00Z".to_string(),
            received_at: format!("2026-09-27T10:00:{:02}Z", key_seq % 60),
            message_text: text.to_string(),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: None,
            details: None,
            reply: None,
            first_message: first,
            author_affiliation: None,
        }
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn ledger_lists_ungreeted_first_timers_oldest_first_and_drops_them_after_fifteen_minutes() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message("k:sam", &row(1, "Sam", "hi!", true), false, start);
        ledger.note_message(
            "k:old",
            &row(2, "Regular", "back again", false),
            false,
            start,
        );
        for (index, name) in ["Ann", "Bea", "Cy", "Dee", "Eve", "Fay"].iter().enumerate() {
            ledger.note_message(
                &format!("k:{name}"),
                &row(10 + index as u32, name, "first!", true),
                false,
                start + secs(1 + index as u64),
            );
        }
        // A second message never duplicates or re-orders an entry.
        ledger.note_message(
            "k:sam",
            &row(30, "Sam", "anyone?", false),
            false,
            start + secs(9),
        );
        let names: Vec<String> = ledger
            .say_hi(start + secs(10))
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["Sam", "Ann", "Bea", "Cy", "Dee"]);
        let sam = ledger.author("k:sam").unwrap();
        assert_eq!(sam.message_count, 2);
        assert!(sam.first_message);
        assert_eq!(sam.last_seen_at, start + secs(9));
        let entry = &ledger.say_hi(start + secs(10))[0];
        assert_eq!(entry.author_key, "k:sam");
        assert_eq!(entry.platform, StreamPlatform::Twitch);
        assert_eq!(entry.first_seen_at, "2026-09-27T10:00:01Z");

        // Greeting by hand frees a slot; greeting twice is not news.
        assert!(ledger.greet("k:sam", GreetedHow::Manual, start + secs(11)));
        assert!(!ledger.greet("k:sam", GreetedHow::Voice, start + secs(12)));
        assert!(!ledger.greet("k:nobody", GreetedHow::Manual, start + secs(12)));
        assert_eq!(
            ledger.author("k:sam").unwrap().greeted,
            Some(Greeting {
                at: start + secs(11),
                how: GreetedHow::Manual
            })
        );
        let names: Vec<String> = ledger
            .say_hi(start + secs(12))
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["Ann", "Bea", "Cy", "Dee", "Eve"]);
        assert_eq!(ledger.take_log().len(), 1);
        assert!(ledger.take_log().is_empty());

        // Change detection: first call publishes, the same list is quiet,
        // aging out is news.
        assert!(ledger.say_hi_changed(start + secs(12)));
        assert!(!ledger.say_hi_changed(start + secs(13)));
        assert!(ledger.say_hi_changed(start + SAY_HI_WINDOW + secs(1)));
        assert_eq!(
            ledger
                .say_hi(start + SAY_HI_WINDOW + secs(1))
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>(),
            ["Bea", "Cy", "Dee", "Eve", "Fay"]
        );
        assert!(ledger.say_hi(start + SAY_HI_WINDOW + secs(10)).is_empty());
    }

    #[test]
    fn greeting_counts_walk_every_author_not_the_pruned_say_hi_list() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message("k:sam", &row(1, "Sam", "hi!", true), false, start);
        ledger.note_message("k:ann", &row(2, "Ann", "first!", true), false, start);
        ledger.note_message("k:old", &row(3, "Regular", "back", false), false, start);
        ledger.note_message("k:quiet", &row(4, "Quiet", "...", true), false, start);
        assert_eq!(
            ledger.greeting_counts(),
            GreetingCounts {
                first_timers: 3,
                ..GreetingCounts::default()
            }
        );

        assert!(ledger.greet("k:sam", GreetedHow::Manual, start + secs(1)));
        assert!(ledger.greet("k:ann", GreetedHow::Highlight, start + secs(2)));
        assert!(ledger.greet("k:old", GreetedHow::Chat, start + secs(3)));
        // A second greeting of the same author never counts twice.
        assert!(!ledger.greet("k:old", GreetedHow::Voice, start + secs(4)));
        let counts = ledger.greeting_counts();
        assert_eq!(counts.first_timers, 3);
        assert_eq!(counts.first_timers_greeted, 2);
        assert_eq!((counts.manual, counts.on_stream, counts.by_chat), (1, 1, 1));
        assert_eq!(counts.by_voice, 0);

        // "Say hi" publishes the one ungreeted first-timer, then, long after
        // the window, forgets everyone; the totals still stand.
        assert!(ledger.say_hi_changed(start + secs(5)));
        assert!(ledger.say_hi_changed(start + SAY_HI_WINDOW + secs(1)));
        assert!(ledger.say_hi(start + SAY_HI_WINDOW + secs(1)).is_empty());
        assert_eq!(ledger.greeting_counts(), counts);
    }

    #[test]
    fn the_streamer_never_enters_the_ledger() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        // A broadcaster row, by role.
        ledger.note_message(
            "k:me",
            &row(1, "Streamer", "welcome all", true),
            true,
            start,
        );
        assert!(ledger.author("k:me").is_none());
        // An X echo of the streamer's own send marks that key for good.
        ledger.note_own_send("  Welcome   in, Sam! ", start);
        ledger.note_message(
            "k:x-me",
            &row(2, "StreamerOnX", "Welcome in, Sam!", true),
            false,
            start + secs(3),
        );
        assert!(ledger.author("k:x-me").is_none());
        ledger.note_message(
            "k:x-me",
            &row(3, "StreamerOnX", "later", true),
            false,
            start + secs(4),
        );
        assert!(ledger.author("k:x-me").is_none());
        // Short texts and old sends prove nothing.
        ledger.note_own_send("gg", start);
        ledger.note_message(
            "k:gg",
            &row(4, "Viewer", "gg", true),
            false,
            start + secs(5),
        );
        assert!(ledger.author("k:gg").is_some());
        ledger.note_message(
            "k:late",
            &row(5, "Copycat", "Welcome in, Sam!", true),
            false,
            start + OWN_SEND_ECHO_WINDOW + secs(1),
        );
        assert!(ledger.author("k:late").is_some());
        // Notices, tombstones and custom rows never count.
        let mut notice = row(6, "System", "raid incoming", true);
        notice.event_type = LiveChatEventType::System;
        ledger.note_message("k:sys", &notice, false, start);
        let mut deleted = row(7, "Gone", "bye", true);
        deleted.is_deleted = true;
        ledger.note_message("k:gone", &deleted, false, start);
        let mut custom = row(8, "Rtmp", "hello there", true);
        custom.platform = StreamPlatform::Custom;
        ledger.note_message("k:rtmp", &custom, false, start);
        assert!(ledger.author("k:sys").is_none());
        assert!(ledger.author("k:gone").is_none());
        assert!(ledger.author("k:rtmp").is_none());
        // A tip counts as chat.
        let mut tip = row(9, "Tipper", "", true);
        tip.event_type = LiveChatEventType::Paid;
        ledger.note_message("k:tip", &tip, false, start);
        assert!(ledger.author("k:tip").is_some());
    }

    #[test]
    fn voice_greets_recent_authors_named_after_they_chatted() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message(
            "k:knight",
            &row(1, "x_Dark_Knight_x", "first time here", true),
            false,
            start + secs(10),
        );
        ledger.note_message("k:bo", &row(2, "Bo", "yo", true), false, start + secs(10));
        ledger.note_message("k:quiet", &row(3, "QuietOne", "hi", true), false, start);
        // Said before they chatted: not a greeting to them.
        assert_eq!(ledger.greet_by_voice("hey dark knight", start + secs(5)), 0);
        // Chatted more than 15 minutes before the words: out of the window.
        assert_eq!(
            ledger.greet_by_voice(
                "quiet one, you still there?",
                start + SAY_HI_WINDOW + secs(1)
            ),
            0
        );
        assert_eq!(
            ledger.greet_by_voice("Oh hey Dark Night, welcome in", start + secs(20)),
            1
        );
        assert_eq!(
            ledger
                .author("k:knight")
                .unwrap()
                .greeted
                .as_ref()
                .map(|g| g.how),
            Some(GreetedHow::Voice)
        );
        assert_eq!(
            ledger.greet_by_voice("thanks for the bob-omb", start + secs(21)),
            0
        );
        assert_eq!(ledger.greet_by_voice("thanks bo", start + secs(22)), 1);
        // Greeted authors never match again.
        assert_eq!(
            ledger.greet_by_voice("dark knight again", start + secs(23)),
            0
        );
        let log = ledger.take_log();
        assert_eq!(log.len(), 2);
        assert!(log[0].contains("x_Dark_Knight_x (twitch) was greeted by voice, 10 s"));
    }

    #[test]
    fn chat_greets_by_name_or_handle() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message("k:chat", &row(1, "Chat", "hi", true), false, start);
        ledger.note_message("k:sam", &row(2, "Sam Smith", "hi", true), false, start);
        ledger.note_message("k:ann", &row(3, "Anna", "hi", true), false, start);
        // A name made of stop words only answers to its handle.
        assert_eq!(ledger.greet_by_chat("hello chat!", start), 0);
        assert_eq!(ledger.greet_by_chat("@Chat, welcome!", start), 1);
        assert_eq!(ledger.greet_by_chat("welcome @samsmith.", start), 1);
        assert_eq!(ledger.greet_by_chat("thanks anna", start), 1);
        assert_eq!(
            ledger
                .author("k:sam")
                .unwrap()
                .greeted
                .as_ref()
                .map(|g| g.how),
            Some(GreetedHow::Chat)
        );
    }

    fn voice(
        now: Instant,
        frame_ago: Option<u64>,
        signal_ago: Option<u64>,
        live_for: Option<u64>,
        voice_ago: Option<u64>,
    ) -> VoiceActivity {
        let ago = |value: Option<u64>| value.map(|value| now - secs(value));
        VoiceActivity {
            last_voice_at: ago(voice_ago),
            last_frame_at: ago(frame_ago),
            last_signal_at: ago(signal_ago),
            live_since: ago(live_for),
        }
    }

    #[test]
    fn dead_air_matrix() {
        let now = Instant::now() + secs(3600);
        // Quiet 20 s with frames and a live signal, something waiting: fires.
        assert!(dead_air_due(
            voice(now, Some(0), Some(0), Some(600), Some(20)),
            true,
            None,
            now
        ));
        assert!(!dead_air_due(
            voice(now, Some(0), Some(0), Some(600), Some(19)),
            true,
            None,
            now
        ));
        // Nothing waiting: never.
        assert!(!dead_air_due(
            voice(now, Some(0), Some(0), Some(600), Some(60)),
            false,
            None,
            now
        ));
        // No frames (listening and captions off): no signal, no nudge.
        assert!(!dead_air_due(
            voice(now, None, None, None, None),
            true,
            None,
            now
        ));
        assert!(!dead_air_due(
            voice(now, Some(4), Some(4), Some(600), Some(60)),
            true,
            None,
            now
        ));
        // Frames of exact digital silence (muted): never.
        assert!(!dead_air_due(
            voice(now, Some(0), Some(30), Some(600), Some(60)),
            true,
            None,
            now
        ));
        // Never voiced since the signal started: counts from its start.
        assert!(!dead_air_due(
            voice(now, Some(0), Some(0), Some(19), None),
            true,
            None,
            now
        ));
        assert!(dead_air_due(
            voice(now, Some(0), Some(0), Some(20), None),
            true,
            None,
            now
        ));
        // Unmuted 5 s ago after a long mute: the old voice does not count.
        assert!(!dead_air_due(
            voice(now, Some(0), Some(0), Some(5), Some(300)),
            true,
            None,
            now
        ));
        // At most once per two minutes.
        let quiet = voice(now, Some(0), Some(0), Some(600), Some(300));
        assert!(!dead_air_due(quiet, true, Some(now - secs(119)), now));
        assert!(dead_air_due(quiet, true, Some(now - secs(120)), now));
    }

    fn question(id: &str, text: &str, askers: &[&str], priority: CohostPriority) -> CohostQuestion {
        CohostQuestion {
            id: id.to_string(),
            text: text.to_string(),
            message_ids: Vec::new(),
            askers: askers.iter().map(|asker| asker.to_string()).collect(),
            platforms: vec![StreamPlatform::Twitch],
            priority,
            suggested_reply: String::new(),
            from_notes: false,
            first_seen_at: format!("2026-09-27T10:00:0{}Z", id.len() % 10),
            updated_at: "2026-09-27T10:00:00Z".to_string(),
            on_topic: false,
        }
    }

    fn hi(name: &str) -> CohostSayHi {
        CohostSayHi {
            author_key: format!("k:{name}"),
            name: name.to_string(),
            platform: StreamPlatform::Youtube,
            first_seen_at: "2026-09-27T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn dead_air_text_suggests_the_best_waiting_thing() {
        assert_eq!(dead_air_text(&[], &[]), None);
        assert_eq!(
            dead_air_text(&[], &[hi("Sam"), hi("Ann")]).as_deref(),
            Some("Dead air: say hi to Sam, it's their first chat.")
        );
        let normal = question(
            "q1",
            "What keyboard is that?",
            &["Sam"],
            CohostPriority::Normal,
        );
        let high = question(
            "q22",
            "Is the giveaway still on?",
            &["A", "B"],
            CohostPriority::High,
        );
        let low = question("q333", "lol?", &[], CohostPriority::Low);
        assert_eq!(
            dead_air_text(&[normal.clone(), low.clone()], &[hi("Ann")]).as_deref(),
            Some("Dead air: answer Sam's question: “What keyboard is that?”")
        );
        assert_eq!(
            dead_air_text(&[normal.clone(), high], &[]).as_deref(),
            Some("Dead air: answer the question 2 people asked: “Is the giveaway still on?”")
        );
        // A low-priority question loses to a first-timer, but beats nothing.
        assert_eq!(
            dead_air_text(std::slice::from_ref(&low), &[hi("Ann")]).as_deref(),
            Some("Dead air: say hi to Ann, it's their first chat.")
        );
        assert_eq!(
            dead_air_text(&[low], &[]).as_deref(),
            Some("Dead air: answer this question: “lol?”")
        );
        // On topic first within a priority.
        let mut on_topic = question("q4444", "Which switches?", &["Cy"], CohostPriority::Normal);
        on_topic.on_topic = true;
        assert_eq!(
            dead_air_text(&[normal, on_topic], &[]).as_deref(),
            Some("Dead air: answer Cy's question: “Which switches?”")
        );
        // Long questions are quoted short.
        let long = question("q5", &"word ".repeat(40), &["Dee"], CohostPriority::High);
        let text = dead_air_text(&[long], &[]).unwrap();
        assert!(text.ends_with("…”"), "{text}");
        assert!(text.chars().count() < 140, "{text}");
    }

    #[test]
    fn dead_air_lane_keys_are_fresh_and_the_nudge_expires() {
        let now = Instant::now();
        let mut lane = DeadAirLane::default();
        assert_eq!(lane.current(now), None);
        let first = lane
            .fire(7, "one".into(), now, "2026-09-27T10:00:00Z")
            .key
            .clone();
        assert_eq!(lane.last_at(), Some(now));
        assert_eq!(
            lane.current(now).map(|nudge| nudge.text),
            Some("one".into())
        );
        let second = lane
            .fire(7, "two".into(), now + secs(120), "2026-09-27T10:02:00Z")
            .key
            .clone();
        assert_ne!(first, second);
        assert_eq!(lane.current(now + secs(120) + DEAD_AIR_NUDGE_TTL), None);
    }

    /// Finding 4: sign-out forgets greetings heard in speech (and the unread
    /// log naming them); chat and manual greetings stay.
    #[test]
    fn forgetting_voice_keeps_chat_and_manual_greetings() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message("k:jon", &row(1, "Jonathan", "hi", true), false, start);
        ledger.note_message("k:ann", &row(2, "Anna", "hi", true), false, start);
        ledger.note_message("k:cy", &row(3, "Cyrus", "hi", true), false, start);
        assert_eq!(
            ledger.greet_by_voice("welcome jonathan", start + secs(1)),
            1
        );
        assert_eq!(ledger.greet_by_chat("thanks anna", start + secs(2)), 1);
        assert!(ledger.greet("k:cy", GreetedHow::Manual, start + secs(3)));
        ledger.forget_voice();
        assert!(ledger.author("k:jon").unwrap().greeted.is_none());
        assert!(ledger.author("k:ann").unwrap().greeted.is_some());
        assert!(ledger.author("k:cy").unwrap().greeted.is_some());
        assert!(ledger.take_log().is_empty());
        assert!(!ledger.author_greeted_by_voice_for_test());
    }

    /// Finding 9: names and the nudge stay inside the renderer contract in
    /// UTF-16 units, cut on a char, whatever the emoji.
    #[test]
    fn names_and_nudges_are_bounded_in_utf16_units() {
        let start = Instant::now();
        let mut ledger = AuthorLedger::default();
        ledger.note_message("k:e", &row(1, &"😀".repeat(300), "hi", true), false, start);
        let name = &ledger.say_hi(start)[0].name;
        assert_eq!(name.encode_utf16().count(), AUTHOR_NAME_MAX_CHARS);
        let long = question(
            "q1",
            &"😀".repeat(200),
            &["😀".repeat(300).as_str()],
            CohostPriority::High,
        );
        let text = dead_air_text(&[long], &[]).unwrap();
        assert!(text.encode_utf16().count() <= DEAD_AIR_TEXT_MAX_UNITS);
        assert!(text.ends_with("…”"), "{text}");
    }
}
