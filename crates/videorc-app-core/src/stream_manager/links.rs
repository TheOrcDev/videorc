//! Links in chat text (plan 151, D7; `lib/chat-links.ts`,
//! `shared/chat-link.ts`). No platform sends a link fragment, so the Stream
//! Manager finds them itself: `http(s)://` URLs, `www.` hosts, and bare
//! `host.tld` names on a short list of TLDs people actually paste in chat.
//! Anything else (`javascript:`, `mailto:`, `file:`, an email address) stays
//! text. Opening checks the URL again ([`openable_chat_link`]) before the
//! browser gets it; the app itself never navigates to a chat link.

use std::sync::OnceLock;

use regex::Regex;

/// `MAX_CHAT_LINK_LENGTH`: longer is not a link anyone pasted on purpose.
pub const MAX_CHAT_LINK_LENGTH: usize = 2048;

/// The most links one row's ⋯ menu offers (plan 151, D12).
pub const MAX_MENU_LINKS: usize = 3;

/// A link in a viewer's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatLink {
    /// What the viewer wrote, shown as is.
    pub text: String,
    /// What Open and Copy use: the text, with `https://` when it had none.
    pub href: String,
    /// Where it goes, shown above Open link: "videorc.com".
    pub host: String,
}

/// The text in order, with each link it holds as its own piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextPiece {
    Text(String),
    Link(ChatLink),
}

/// Bare `host.tld` names become links only on these TLDs; `node.js` and
/// `file.txt` stay text. A scheme or `www.` needs no list.
const BARE_TLDS: [&str; 17] = [
    "com", "net", "org", "io", "gg", "tv", "dev", "app", "co", "me", "ly", "be", "fm", "to", "sh",
    "xyz", "live",
];

/// A scheme or `www.` URL to whitespace, a quote, an angle bracket or an
/// emoji; or a bare name: ASCII labels and a TLD with an optional path. The
/// renderer's lookbehind (not inside a word, a path or an email address) is
/// [`bare_start_allowed`], checked where a bare name starts.
fn candidate() -> &'static Regex {
    static CANDIDATE: OnceLock<Regex> = OnceLock::new();
    CANDIDATE.get_or_init(|| {
        Regex::new(
            r#"(?iu)(?:https?://|www\.)[^\s<>"\p{Extended_Pictographic}]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,6}(?:[/?#][^\s<>"\p{Extended_Pictographic}]*)?"#,
        )
        .expect("the link pattern compiles")
    })
}

/// `(?<![\p{L}\p{N}_@./:-])`.
fn bare_start_allowed(text: &str, start: usize) -> bool {
    match text[..start].chars().next_back() {
        None => true,
        Some(previous) => {
            !(previous.is_alphanumeric() || matches!(previous, '_' | '@' | '.' | '/' | ':' | '-'))
        }
    }
}

const TRAILING: [char; 13] = [
    '.', ',', '!', '?', ';', ':', '\'', '"', '。', '，', '、', '！', '？',
];

fn opener_of(closer: char) -> Option<char> {
    match closer {
        ')' => Some('('),
        ']' => Some('['),
        '}' => Some('{'),
        _ => None,
    }
}

/// Sentence punctuation after a link is not part of it; a closing bracket
/// is, when the link opened it ("Foo_(bar)").
fn trim_trailing(candidate: &str) -> &str {
    let mut end = candidate.len();
    while let Some(last) = candidate[..end].chars().next_back() {
        if TRAILING.contains(&last) {
            end -= last.len_utf8();
            continue;
        }
        if let Some(opener) = opener_of(last) {
            let head = &candidate[..end];
            let closers = head.chars().filter(|c| *c == last).count();
            let openers = head.chars().filter(|c| *c == opener).count();
            if closers > openers {
                end -= last.len_utf8();
                continue;
            }
        }
        break;
    }
    &candidate[..end]
}

/// `openableChatLink`: the URL to open, or none. Only `http:` and `https:`,
/// never with a username or password, never longer than
/// [`MAX_CHAT_LINK_LENGTH`].
pub fn openable_chat_link(value: &str) -> Option<String> {
    let length = value.encode_utf16().count();
    if length == 0 || length > MAX_CHAT_LINK_LENGTH {
        return None;
    }
    let parsed = url::Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return None;
    }
    Some(parsed.to_string())
}

/// `chatLinkFrom`: the link a candidate names, or none when it is not one
/// Videorc opens.
pub fn chat_link_from(raw: &str) -> Option<ChatLink> {
    if raw.encode_utf16().count() > MAX_CHAT_LINK_LENGTH {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let schemed = lower.starts_with("http://") || lower.starts_with("https://");
    let href = if schemed {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let openable = openable_chat_link(&href)?;
    let host = url::Url::parse(&openable).ok()?.host_str()?.to_string();
    if !host.contains('.') {
        return None;
    }
    if !schemed && !lower.starts_with("www.") {
        let tld = host.rsplit('.').next().unwrap_or_default().to_lowercase();
        if !BARE_TLDS.contains(&tld.as_str()) {
            return None;
        }
    }
    Some(ChatLink {
        text: raw.to_string(),
        href,
        host: host.strip_prefix("www.").unwrap_or(&host).to_string(),
    })
}

/// `splitLinks`: the text in order, each link its own piece.
pub fn split_links(text: &str) -> Vec<TextPiece> {
    let mut pieces: Vec<TextPiece> = Vec::new();
    let push_text = |pieces: &mut Vec<TextPiece>, value: &str| {
        if value.is_empty() {
            return;
        }
        if let Some(TextPiece::Text(last)) = pieces.last_mut() {
            last.push_str(value);
        } else {
            pieces.push(TextPiece::Text(value.to_string()));
        }
    };
    let pattern = candidate();
    let mut cursor = 0;
    let mut at = 0;
    while at <= text.len() {
        let Some(found) = pattern.find_at(text, at) else {
            break;
        };
        let start = found.start();
        let lower = found.as_str().to_ascii_lowercase();
        let schemed = lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("www.");
        if !schemed && !bare_start_allowed(text, start) {
            // The renderer's lookbehind fails here: look again one letter on.
            at = start + text[start..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        let raw = trim_trailing(found.as_str());
        if let Some(link) = (!raw.is_empty()).then(|| chat_link_from(raw)).flatten() {
            push_text(&mut pieces, &text[cursor..start]);
            pieces.push(TextPiece::Link(link));
            cursor = start + raw.len();
        }
        at = found.end().max(start + 1);
    }
    push_text(&mut pieces, &text[cursor..]);
    pieces
}

/// `chatLinksIn`: the distinct links in a text, first seen first.
pub fn chat_links_in(text: &str) -> Vec<ChatLink> {
    let mut links: Vec<ChatLink> = Vec::new();
    for piece in split_links(text) {
        if let TextPiece::Link(link) = piece
            && !links.iter().any(|seen| seen.href == link.href)
        {
            links.push(link);
        }
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hrefs(text: &str) -> Vec<String> {
        chat_links_in(text)
            .into_iter()
            .map(|link| link.href)
            .collect()
    }

    // `chat-links.test.ts`.
    #[test]
    fn schemes_www_and_bare_names_on_the_list_are_links() {
        assert_eq!(
            hrefs("see https://videorc.com/x."),
            ["https://videorc.com/x"]
        );
        assert_eq!(hrefs("www.videorc.com"), ["https://www.videorc.com"]);
        assert_eq!(hrefs("go to videorc.com now"), ["https://videorc.com"]);
        assert!(hrefs("node.js and file.txt").is_empty());
        assert!(hrefs("mail me@videorc.com").is_empty());
        assert!(hrefs("javascript:alert(1)").is_empty());
        assert!(hrefs("https://user:pw@videorc.com").is_empty());
        // A bracket the link opened stays; a sentence's does not.
        assert_eq!(
            hrefs("(https://en.wikipedia.org/wiki/Foo_(bar))"),
            ["https://en.wikipedia.org/wiki/Foo_(bar)"]
        );
        let link = &chat_links_in("https://www.Videorc.com/a")[0];
        assert_eq!(link.host, "videorc.com");
        assert_eq!(link.text, "https://www.Videorc.com/a");
    }

    #[test]
    fn the_pieces_keep_the_text_around_each_link() {
        let pieces = split_links("hi videorc.com, bye");
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces[0], TextPiece::Text("hi ".into()));
        assert!(matches!(&pieces[1], TextPiece::Link(link) if link.text == "videorc.com"));
        assert_eq!(pieces[2], TextPiece::Text(", bye".into()));
        assert_eq!(split_links("plain"), [TextPiece::Text("plain".into())]);
        // Twice the same link is one menu entry.
        assert_eq!(hrefs("videorc.com videorc.com").len(), 1);
        assert!(openable_chat_link("file:///etc/passwd").is_none());
        assert!(openable_chat_link(&format!("https://a.com/{}", "x".repeat(2100))).is_none());
    }
}
