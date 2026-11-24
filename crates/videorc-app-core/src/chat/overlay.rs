//! Chat on stream (plan 215 G, D5): the last five chat messages as one box
//! the backend draws on every leg the overlay layout's `chat` switches carry
//! (`chat.overlay.set`; since plan 220 S1.2c the backend paints it from the
//! messages named here). The pure half of `lib/chat-overlay.ts`: which
//! messages the box shows, the images and initials a paint needs, and what a
//! paint depends on; the driver is the Studio's (lands with S1.6a's Studio).

use serde_json::{Value, json};

use super::model::LiveChatMessage;

/// `CHAT_OVERLAY_MAX_MESSAGES`.
pub const MAX_MESSAGES: usize = 5;
/// `CHAT_OVERLAY_REPAINT_MS`: it repaints at most twice a second.
pub const REPAINT: std::time::Duration = std::time::Duration::from_millis(500);

/// The requests.
pub mod methods {
    pub const SET: &str = "chat.overlay.set";
    pub const CLEAR: &str = "chat.overlay.clear";
    pub const CANVASES: &str = "chat.overlay.canvases";
}

/// The overlay layout's push (`overlays.layout`).
pub const LAYOUT_EVENT: &str = "overlays.layout";

/// `chatOverlayEligible`: a viewer's chat or paid message with words or
/// emotes; never a deleted one, a notice, a moderation row or activity.
pub fn eligible(message: &LiveChatMessage) -> bool {
    if message.is_deleted {
        return false;
    }
    if message.event_type != "message" && message.event_type != "paid" {
        return false;
    }
    if !message.message_text.trim().is_empty() {
        return true;
    }
    message
        .fragments
        .iter()
        .any(|fragment| fragment.image_url.is_some() || !fragment.text.trim().is_empty())
}

/// `chatOverlayMessages`: the newest eligible messages of this livestream,
/// oldest first, at most [`MAX_MESSAGES`].
pub fn messages<'a>(
    all: impl DoubleEndedIterator<Item = &'a LiveChatMessage>,
    session_id: Option<&str>,
) -> Vec<&'a LiveChatMessage> {
    let Some(session_id) = session_id else {
        return Vec::new();
    };
    let mut window: Vec<&LiveChatMessage> = all
        .rev()
        .filter(|message| message.session_id == session_id && eligible(message))
        .take(MAX_MESSAGES)
        .collect();
    window.reverse();
    window
}

/// A canvas the box lands on, with its placed rect.
#[derive(Debug, Clone, PartialEq)]
pub struct Canvas {
    pub width: u64,
    pub height: u64,
    pub rect: Value,
}

/// `chatOverlaySignature`: the same twice means the box on stream is already
/// this one.
pub fn signature(
    messages: &[&LiveChatMessage],
    stream: &Canvas,
    vertical: Option<&Canvas>,
) -> String {
    let canvas = |entry: &Canvas| {
        format!(
            "{}x{}@{}",
            entry.width,
            entry.height,
            serde_json::to_string(&entry.rect).unwrap_or_default()
        )
    };
    json!([
        messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        canvas(stream),
        vertical.map(canvas),
    ])
    .to_string()
}

/// The box's images, cached before the backend draws it: each viewer's
/// picture and the emotes at the card's size (Electron #1281: every row shows
/// the viewer's avatar between the platform icon and the name; a viewer with
/// no picture, or one that fails, gets [`monogram_initials`]).
pub fn image_urls(messages: &[&LiveChatMessage]) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for message in messages {
        for url in super::highlight::card_image_urls(message) {
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    urls
}

/// `monogramInitials` (`lib/chat-avatar.tsx`): the first letters of up to two
/// words, upper-cased. A leading symbol is skipped (`@ramxcodes` is R, not
/// @); a word of symbols alone (an emoji) keeps its first glyph; nothing at
/// all is `?`. The box paints it in the avatar circle when there is no
/// picture, from the author's name or `Viewer`.
pub fn monogram_initials(name: &str) -> String {
    let initials: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|word| {
            word.chars()
                .find(|glyph| glyph.is_alphanumeric())
                .or_else(|| word.chars().next())
        })
        .flat_map(char::to_uppercase)
        .collect();
    if initials.is_empty() {
        "?".to_owned()
    } else {
        initials
    }
}

/// Whether one of the box's switches is on in the overlay layout.
pub fn switched_on(layout: Option<&Value>) -> bool {
    let switch = |name: &str| {
        layout
            .and_then(|layout| layout.pointer(&format!("/chat/{name}")))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    switch("showOnStream") || switch("showInRecording")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::LiveChatFragment;

    fn message(id: &str, session: &str, kind: &str, text: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: id.into(),
            session_id: session.into(),
            event_type: kind.into(),
            message_text: text.into(),
            ..LiveChatMessage::default()
        }
    }

    // `chat-overlay.test.ts`.
    #[test]
    fn the_box_takes_the_newest_five_eligible_messages_of_this_livestream() {
        let mut all: Vec<LiveChatMessage> = (0..7)
            .map(|i| message(&format!("m{i}"), "s", "message", "hi"))
            .collect();
        all.push(message("other", "t", "message", "elsewhere"));
        all.push(message("sys", "s", "system", "Ada subscribed"));
        let mut deleted = message("gone", "s", "message", "bye");
        deleted.is_deleted = true;
        all.push(deleted);
        let mut emote_only = message("emote", "s", "paid", "");
        emote_only.fragments = vec![LiveChatFragment {
            fragment_type: "emote".into(),
            text: "Kappa".into(),
            image_url: Some("https://files.kick.com/emotes/1/fullsize".into()),
            zero_width: false,
        }];
        all.push(emote_only);
        let ids: Vec<&str> = messages(all.iter(), Some("s"))
            .iter()
            .map(|message| message.id.as_str())
            .collect();
        assert_eq!(ids, ["m3", "m4", "m5", "m6", "emote"]);
        assert!(messages(all.iter(), None).is_empty());
        let shown = messages(all.iter(), Some("s"));
        assert_eq!(
            image_urls(&shown),
            ["https://files.kick.com/emotes/1/fullsize"]
        );
        let stream = Canvas {
            width: 1920,
            height: 1080,
            rect: json!({"x": 0.1}),
        };
        assert_eq!(
            signature(&shown, &stream, None),
            signature(&shown, &stream, None)
        );
        assert_ne!(
            signature(&shown[1..], &stream, None),
            signature(&shown, &stream, None)
        );
        assert!(switched_on(Some(&json!({"chat": {"showOnStream": true}}))));
        assert!(!switched_on(Some(
            &json!({"chat": {"showOnStream": false}})
        )));
        assert!(!switched_on(None));
    }

    #[test]
    fn the_box_caches_each_viewers_picture_and_names_the_rest_by_initials() {
        let mut with_picture = message("a", "s", "message", "hi");
        with_picture.author_avatar_url = Some("https://example.com/a.png".into());
        let urls = image_urls(&[&with_picture]);
        assert!(
            urls.contains(&"https://example.com/a.png".to_owned()),
            "{urls:?}"
        );
        assert_eq!(monogram_initials("@ramxcodes"), "R");
        assert_eq!(monogram_initials("mia  rose"), "MR");
        assert_eq!(monogram_initials("ana maria lopez"), "AM");
        assert_eq!(monogram_initials("\u{1F600}"), "\u{1F600}");
        assert_eq!(monogram_initials("   "), "?");
    }
}
