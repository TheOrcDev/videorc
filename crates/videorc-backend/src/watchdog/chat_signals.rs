//! Chat says there is a problem (plan 223 B1, D6): pure.
//!
//! A message matches one class (`audio`, `video`, `lag`) when it carries a
//! negation-bearing phrase from the fourteen tables below, case-folded, with
//! emotes stripped. One person opens nothing: two distinct authors with the
//! same class inside 90 s do. The streamer's own lines and Buddy's never
//! count. The Premium AI read (B2) adds a decision from one author plus a
//! confident typed answer; the window is the same.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Two distinct authors inside this window open the alert.
pub const CHAT_WINDOW: Duration = Duration::from_secs(90);
/// The card's "in the last 2 minutes", and B2's "at least one candidate in
/// the last two minutes".
pub const CHAT_RECENT: Duration = Duration::from_secs(120);
/// B2 sends the last this many messages (text, platform, author index).
pub const AI_READ_MESSAGES: usize = 20;
/// B2: at most one AI call every two minutes per stream.
pub const AI_READ_INTERVAL: Duration = Duration::from_secs(120);
/// B2: the probability that opens `chat-says` from one author. The web's
/// reference threshold is 0.7 and UNVALIDATED; the desktop owns its own.
pub const AI_READ_THRESHOLD: f64 = 0.7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatClass {
    Audio,
    Video,
    Lag,
}

impl ChatClass {
    pub const ALL: [ChatClass; 3] = [ChatClass::Audio, ChatClass::Video, ChatClass::Lag];

    pub fn id(self) -> &'static str {
        match self {
            ChatClass::Audio => "audio",
            ChatClass::Video => "video",
            ChatClass::Lag => "lag",
        }
    }
}

/// Phrases per class, every language together: all are negation-bearing
/// ("no sound", "can't hear"), never a bare noun ("sound"). Lowercase; the
/// match is on the case-folded message with emotes stripped.
const AUDIO_PHRASES: &[&str] = &[
    // en
    "no sound",
    "no audio",
    "can't hear",
    "cant hear",
    "cannot hear",
    "you're muted",
    "youre muted",
    "ur muted",
    "you are muted",
    "mic is muted",
    "mic muted",
    "no mic",
    // es
    "sin audio",
    "sin sonido",
    "no se oye",
    "no se escucha",
    "no te oigo",
    "no te escucho",
    // pt
    "não ouço",
    "nao ouco",
    "sem som",
    "sem áudio",
    "sem audio",
    "não escuto",
    // de
    "kein ton",
    "hör dich nicht",
    "hoer dich nicht",
    "kein audio",
    // fr
    "pas de son",
    "on t'entend pas",
    "on t entend pas",
    "pas d'audio",
    // it
    "niente audio",
    "non ti sento",
    "senza audio",
    // nl
    "geen geluid",
    "hoor je niet",
    "geen audio",
    // pl
    "brak dźwięku",
    "brak dzwieku",
    "nie słyszę",
    "nie slysze",
    // ru
    "нет звука",
    "не слышно",
    "без звука",
    // tr
    "ses yok",
    "sesin gelmiyor",
    "ses gelmiyor",
    // ja
    "音がない",
    "聞こえない",
    "音声がない",
    // ko
    "소리가 안",
    "안 들려",
    "소리 안",
    // zh
    "没有声音",
    "听不到",
    "没声音",
    // sv
    "inget ljud",
    "hör inte",
];

const VIDEO_PHRASES: &[&str] = &[
    // en
    "frozen",
    "froze",
    "black screen",
    "no video",
    "stream is stuck",
    "stream stuck",
    "no picture",
    // es
    "congelado",
    "congelada",
    "pantalla negra",
    "sin video",
    "sin imagen",
    // pt
    "travou",
    "tela preta",
    "sem vídeo",
    "sem video",
    // de
    "eingefroren",
    "schwarzer bildschirm",
    "kein bild",
    // fr
    "figé",
    "figée",
    "écran noir",
    "ecran noir",
    "pas d'image",
    // it
    "bloccato",
    "schermo nero",
    "niente video",
    // nl
    "bevroren",
    "zwart scherm",
    "geen beeld",
    // pl
    "zawiesił",
    "zawiesil",
    "czarny ekran",
    // ru
    "завис",
    "чёрный экран",
    "черный экран",
    // tr
    "dondu",
    "siyah ekran",
    // ja
    "固まって",
    "画面が黒",
    "映像がない",
    // ko
    "멈췄",
    "화면이 검",
    "화면 안",
    // zh
    "卡住",
    "黑屏",
    "没画面",
    // sv
    "fryst",
    "svart skärm",
];

const LAG_PHRASES: &[&str] = &[
    // en
    "lagging",
    "laggy",
    "buffering",
    "stuttering",
    "stream lag",
    "so much lag",
    "keeps loading",
    // es
    "se traba",
    "va con lag",
    "se corta",
    // pt
    "lageando",
    "travando",
    "lagando",
    // de
    "ruckelt",
    "laggt",
    // fr
    "ça lag",
    "ca lag",
    "ça rame",
    "ca rame",
    // it
    "scatta",
    "lagga",
    // nl
    "hapert",
    "lagt",
    // pl
    "laguje",
    "przycina",
    // ru
    "лагает",
    "тормозит",
    // tr
    "takılıyor",
    "takiliyor",
    "donuyor",
    // ja
    "ラグ",
    "カクカク",
    // ko
    "렉",
    "끊겨",
    "버퍼링",
    // zh
    "卡了",
    "很卡",
    "缓冲",
    // sv
    "laggar",
    "hackar",
];

/// What a message says, if it says one of the three things.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub class: ChatClass,
    pub phrase: &'static str,
}

/// Strips `:emote:` codes, `[emote]` and `<emote>` tags and Twitch-style
/// `name123` emote words are left alone: only bracketed and colon codes go,
/// so an emote-only message folds to nothing.
pub fn strip_emotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut skipping: Option<char> = None;
    for ch in text.chars() {
        match skipping {
            Some(close) => {
                if ch == close {
                    skipping = None;
                    out.push(' ');
                }
            }
            None => match ch {
                '[' => skipping = Some(']'),
                '<' => skipping = Some('>'),
                _ => out.push(ch),
            },
        }
    }
    // `:kappa:` style codes.
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(start) = rest.find(':') {
        let after = &rest[start + 1..];
        match after.find(':') {
            Some(end)
                if end > 0
                    && after[..end]
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '_') =>
            {
                cleaned.push_str(&rest[..start]);
                cleaned.push(' ');
                rest = &after[end + 1..];
            }
            _ => {
                cleaned.push_str(&rest[..=start]);
                rest = after;
            }
        }
    }
    cleaned.push_str(rest);
    cleaned
}

/// Unicode case folding for the match: lowercase, with the straight and
/// curly apostrophes one character.
fn fold(text: &str) -> String {
    text.to_lowercase()
        .replace(['\u{2019}', '\u{2018}', '`', '\u{00B4}'], "'")
}

/// One message against the tables. Emote-only messages never match; a bare
/// "sound" never does; "can you hear me?" is a question, not a report, and
/// no table holds it.
pub fn match_message(text: &str) -> Option<Match> {
    let folded = fold(&strip_emotes(text));
    let folded = folded.trim();
    if folded.is_empty() {
        return None;
    }
    let find = |class: ChatClass, phrases: &[&'static str]| {
        phrases
            .iter()
            .find(|phrase| folded.contains(*phrase))
            .map(|phrase| Match { class, phrase })
    };
    find(ChatClass::Audio, AUDIO_PHRASES)
        .or_else(|| find(ChatClass::Video, VIDEO_PHRASES))
        .or_else(|| find(ChatClass::Lag, LAG_PHRASES))
}

/// Who wrote it, for the window: a stable author key (the platform plus
/// the author id, or the name when the platform gives none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatLine {
    pub author: String,
    pub text: String,
    pub platform: String,
    pub at: Instant,
    pub class: Option<ChatClass>,
}

/// A decision the checks turn into `chat-says`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSignal {
    pub class: ChatClass,
    pub people: usize,
    pub quotes: Vec<String>,
    pub ai: bool,
}

/// The rolling window of recent chat (the last 20 lines, 2 minutes).
#[derive(Debug, Default)]
pub struct ChatWindow {
    lines: Vec<ChatLine>,
    /// B2: a confident AI answer, held until the window goes quiet.
    ai_decision: Option<(ChatClass, Instant)>,
    ai_last_call: Option<Instant>,
}

impl ChatWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a line. `excluded` lines (the streamer, Buddy) are dropped
    /// before they reach here.
    pub fn push(&mut self, line: ChatLine) {
        self.lines.push(line);
        if self.lines.len() > AI_READ_MESSAGES * 2 {
            let drop = self.lines.len() - AI_READ_MESSAGES * 2;
            self.lines.drain(..drop);
        }
    }

    fn prune(&mut self, now: Instant) {
        self.lines
            .retain(|line| now.saturating_duration_since(line.at) <= CHAT_RECENT);
        if let Some((_, at)) = self.ai_decision
            && now.saturating_duration_since(at) > CHAT_RECENT
        {
            self.ai_decision = None;
        }
    }

    /// The decisions as of `now`: a class with at least two distinct
    /// authors inside 90 s, or the AI's confident class.
    pub fn decide(&mut self, now: Instant) -> Vec<ChatSignal> {
        self.prune(now);
        let mut out = Vec::new();
        for class in ChatClass::ALL {
            let matched: Vec<&ChatLine> = self
                .lines
                .iter()
                .filter(|line| line.class == Some(class))
                .collect();
            let mut authors: BTreeMap<&str, &ChatLine> = BTreeMap::new();
            for line in &matched {
                authors.entry(line.author.as_str()).or_insert(line);
            }
            let recent_authors = authors
                .values()
                .filter(|line| now.saturating_duration_since(line.at) <= CHAT_WINDOW)
                .count();
            let two_people = {
                // Two distinct authors inside 90 s of each other.
                let mut times: Vec<(Instant, &str)> = matched
                    .iter()
                    .map(|line| (line.at, line.author.as_str()))
                    .collect();
                times.sort_by_key(|(at, _)| *at);
                times.iter().enumerate().any(|(index, (at, author))| {
                    times[index + 1..].iter().any(|(later, other)| {
                        other != author && later.saturating_duration_since(*at) <= CHAT_WINDOW
                    })
                })
            };
            let ai = self
                .ai_decision
                .is_some_and(|(decided, _)| decided == class);
            if (two_people && recent_authors >= 2) || (ai && !matched.is_empty()) {
                let quotes: Vec<String> = authors
                    .values()
                    .map(|line| truncate(&line.text, 60))
                    .take(3)
                    .collect();
                out.push(ChatSignal {
                    class,
                    people: authors.len().max(1),
                    quotes,
                    ai: ai && !two_people,
                });
            }
        }
        out
    }

    /// B2: the window has a candidate inside the last two minutes and the
    /// last call was two minutes ago or more; returns the last 20 lines.
    pub fn ai_read_due(&mut self, now: Instant) -> Option<Vec<&ChatLine>> {
        self.prune(now);
        if !self.lines.iter().any(|line| line.class.is_some()) {
            return None;
        }
        if self
            .ai_last_call
            .is_some_and(|last| now.saturating_duration_since(last) < AI_READ_INTERVAL)
        {
            return None;
        }
        self.ai_last_call = Some(now);
        let start = self.lines.len().saturating_sub(AI_READ_MESSAGES);
        Some(self.lines[start..].iter().collect())
    }

    /// B2: the answer. A class above the threshold holds for two minutes;
    /// "none" clears any held answer.
    pub fn ai_answered(&mut self, probabilities: &[(ChatClass, f64)], now: Instant) {
        let best = probabilities
            .iter()
            .filter(|(_, probability)| *probability >= AI_READ_THRESHOLD)
            .max_by(|(_, left), (_, right)| left.total_cmp(right));
        self.ai_decision = best.map(|(class, _)| (*class, now));
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max_chars - 1).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(author: &str, text: &str, at: Instant) -> ChatLine {
        ChatLine {
            author: author.to_string(),
            text: text.to_string(),
            platform: "twitch".to_string(),
            at,
            class: match_message(text).map(|m| m.class),
        }
    }

    #[test]
    fn one_positive_and_one_negative_per_language() {
        let cases: [(&str, &str, ChatClass, &str); 14] = [
            ("en", "NO SOUND??", ChatClass::Audio, "can you hear me?"),
            ("es", "sin audio", ChatClass::Audio, "el sonido está bien"),
            ("pt", "travou a tela", ChatClass::Video, "que som bom"),
            ("de", "kein Ton!!", ChatClass::Audio, "der Ton ist super"),
            ("fr", "écran noir", ChatClass::Video, "le son est bon"),
            ("it", "scatta tutto", ChatClass::Lag, "audio perfetto"),
            ("nl", "geen geluid", ChatClass::Audio, "geluid is prima"),
            ("pl", "brak dźwięku", ChatClass::Audio, "dźwięk jest ok"),
            ("ru", "Нет звука", ChatClass::Audio, "звук отличный"),
            ("tr", "ses yok", ChatClass::Audio, "ses harika"),
            ("ja", "聞こえないよ", ChatClass::Audio, "音いいね"),
            ("ko", "안 들려요", ChatClass::Audio, "소리 좋다"),
            ("zh", "黑屏了", ChatClass::Video, "画质不错"),
            ("sv", "det laggar", ChatClass::Lag, "ljudet är bra"),
        ];
        for (language, positive, class, negative) in cases {
            assert_eq!(
                match_message(positive).map(|m| m.class),
                Some(class),
                "{language}: {positive:?}"
            );
            assert_eq!(match_message(negative), None, "{language}: {negative:?}");
        }
    }

    #[test]
    fn bare_nouns_questions_and_emotes_never_match() {
        assert_eq!(match_message("sound"), None, "never a bare noun");
        assert_eq!(match_message("the audio is great"), None);
        assert_eq!(
            match_message("can you hear me?"),
            None,
            "a question, not a report"
        );
        assert_eq!(match_message("Kappa PogChamp"), None);
        assert_eq!(
            match_message(":no_sound: :kappa:"),
            None,
            "an emote-only message"
        );
        assert_eq!(
            match_message("[no sound GIF]"),
            None,
            "a bracketed emote name"
        );
        assert_eq!(
            match_message("I CAN’T HEAR YOU :kappa:").map(|m| m.class),
            Some(ChatClass::Audio),
            "curly apostrophe and case fold"
        );
        assert_eq!(
            match_message("pantalla negra").map(|m| m.class),
            Some(ChatClass::Video)
        );
        assert_eq!(
            match_message("so laggy today").map(|m| m.class),
            Some(ChatClass::Lag)
        );
    }

    #[test]
    fn two_people_inside_ninety_seconds_open_and_one_person_does_not() {
        let start = Instant::now();
        let mut window = ChatWindow::new();
        window.push(line("a", "can you hear me?", start));
        window.push(line(
            "a",
            "can you hear me?",
            start + Duration::from_secs(5),
        ));
        window.push(line(
            "a",
            "can you hear me?",
            start + Duration::from_secs(9),
        ));
        assert!(window.decide(start + Duration::from_secs(10)).is_empty());
        window.push(line("a", "no sound??", start + Duration::from_secs(12)));
        window.push(line("a", "NO SOUND", start + Duration::from_secs(20)));
        assert!(
            window.decide(start + Duration::from_secs(21)).is_empty(),
            "one person twice is still one person"
        );
        window.push(line("b", "sin audio", start + Duration::from_secs(30)));
        let decisions = window.decide(start + Duration::from_secs(31));
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].class, ChatClass::Audio);
        assert_eq!(decisions[0].people, 2);
        assert_eq!(decisions[0].quotes, vec!["no sound??", "sin audio"]);
        assert!(!decisions[0].ai);
        // Two minutes later the window has gone quiet about it.
        assert!(window.decide(start + Duration::from_secs(160)).is_empty());
    }

    #[test]
    fn two_people_more_than_ninety_seconds_apart_do_not_open() {
        let start = Instant::now();
        let mut window = ChatWindow::new();
        window.push(line("a", "no sound", start));
        window.push(line("b", "cant hear u", start + Duration::from_secs(100)));
        assert!(window.decide(start + Duration::from_secs(101)).is_empty());
    }

    #[test]
    fn the_ai_read_opens_from_one_author_only_when_confident() {
        let start = Instant::now();
        let mut window = ChatWindow::new();
        assert!(window.ai_read_due(start).is_none(), "no candidate, no call");
        window.push(line("a", "hello", start));
        window.push(line("a", "no sound??", start + Duration::from_secs(1)));
        let lines = window.ai_read_due(start + Duration::from_secs(2)).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(
            window
                .ai_read_due(start + Duration::from_secs(60))
                .is_none(),
            "at most one call every two minutes"
        );
        window.ai_answered(
            &[
                (ChatClass::Audio, 0.3),
                (ChatClass::Video, 0.2),
                (ChatClass::Lag, 0.1),
            ],
            start + Duration::from_secs(3),
        );
        assert!(
            window.decide(start + Duration::from_secs(4)).is_empty(),
            "\"none\" opens nothing"
        );
        window.ai_answered(
            &[
                (ChatClass::Audio, 0.92),
                (ChatClass::Video, 0.1),
                (ChatClass::Lag, 0.05),
            ],
            start + Duration::from_secs(5),
        );
        let decisions = window.decide(start + Duration::from_secs(6));
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].class, ChatClass::Audio);
        assert_eq!(decisions[0].people, 1);
        assert!(decisions[0].ai);
        // Two minutes on, a fresh candidate may be read again.
        window.push(line("c", "cant hear u", start + Duration::from_secs(124)));
        assert!(
            window
                .ai_read_due(start + Duration::from_secs(125))
                .is_some()
        );
    }
}
