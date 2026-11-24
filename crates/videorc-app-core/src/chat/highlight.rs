//! A chat message on stream (plans 055, 095, 164; plan 220 S1.2c): the
//! highlight as a row shows it, and what the card is drawn from.
//!
//! The backend owns the card and `On stream` (`comments.highlight.*`); the
//! Studio owns only the moment between a click and the answer ("Applying…")
//! and a failure's reason for five seconds. Ported from
//! `components/comment-row.tsx` (`commentHighlightPresentationForMessage`,
//! `highlightProblem`, `HighlightStatus`, `commentRowDescription`),
//! `lib/comment-highlight-layout.ts` (`commentHighlightImageUrls`,
//! `highlightEmoteImageUrl`), `lib/comment-highlight.ts`
//! (`commentHighlightExpiryDelay`) and `lib/command-failure-policy.ts`.

use chrono::{DateTime, Utc};

use super::model::{CommentHighlightPhase, CommentHighlightState, LiveChatMessage};

/// The words a row and the remotes say about the highlight.
pub mod copy {
    /// `HighlightStatus`: the click is on its way.
    pub const APPLYING: &str = "Applying…";
    /// The `chrome` chip on the row on stream.
    pub const ON_STREAM: &str = "On stream";
    /// Beside On stream when the action on it failed.
    pub const ACTION_FAILED: &str = "Action failed";
    /// The destructive chip of a failed show.
    pub const FAILED: &str = "Failed";
    /// `commentRowDescription`: what a click does.
    pub const SHOWS_IT: &str = "Shows it on stream";
    pub const TAKES_IT_OFF: &str = "Takes it off the stream";
    /// `applyCommentHighlight`: a message from another livestream.
    pub const WRONG_LIVESTREAM: &str = "That message doesn't belong to the active livestream.";
    /// `toggleCommentHighlight`'s fallback reason (the remotes' too).
    pub const HIGHLIGHT_FAILED: &str = "Highlight failed.";
    /// `showCommentHighlight` (a remote): the message is gone.
    pub const COMMENT_UNAVAILABLE: &str = "That comment is no longer available.";
    /// `showCommentHighlight`: a newer click won.
    pub const NEWER_COMMENT: &str = "A newer comment replaced this one.";
    /// `showCommentHighlight`: the backend answered without the card on air.
    pub const DID_NOT_REACH_STREAM: &str = "The comment didn't reach the stream.";
    /// `clearCommentHighlight`'s fallback reason.
    pub const CLEAR_FAILED: &str = "Couldn't clear the comment.";
}

/// How long a failed show keeps its reason on the row (the renderer's
/// `commentHighlightFailure` effect).
pub const FAILURE_SHOWN_FOR: std::time::Duration = std::time::Duration::from_millis(5_000);
/// `COMMENTS_HIGHLIGHT_TIMING_CONTRACT.avatarFetchMs`: the images a card is
/// drawn from are cached within this, or drawn without (the monogram, the
/// emote's name).
pub const IMAGE_WARM_BUDGET: std::time::Duration = std::time::Duration::from_millis(4_000);
/// `COMMENTS_HIGHLIGHT_TIMING_CONTRACT.reconciliationMs`: the status read
/// after a request whose outcome is unknown.
pub const RECONCILIATION: std::time::Duration = std::time::Duration::from_millis(2_000);
/// `HIGHLIGHT_MAX_EMOTES`: distinct emote images one card loads.
pub const MAX_EMOTES: usize = 20;

/// A row's highlight (`CommentHighlightPhase` in `comment-row.tsx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowPhase {
    #[default]
    Idle,
    Applying,
    Live,
    Failed,
}

impl RowPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Applying => "applying",
            Self::Live => "live",
            Self::Failed => "failed",
        }
    }
}

/// `CommentHighlightPresentation`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RowHighlight {
    pub phase: RowPhase,
    pub reason: Option<String>,
    /// The failed action on a message already on stream.
    pub command_error: Option<String>,
}

/// The Studio's own failure, for its five seconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightFailure {
    pub message_id: String,
    pub reason: String,
}

/// `commentHighlightPresentationForMessage`: the click in flight first,
/// then the backend's card (with a failed action beside it), then the
/// Studio's failure, then the backend's own failure or idle.
pub fn presentation(
    message_id: &str,
    state: &CommentHighlightState,
    applying_id: Option<&str>,
    failure: Option<&HighlightFailure>,
) -> RowHighlight {
    if applying_id == Some(message_id) {
        return RowHighlight {
            phase: RowPhase::Applying,
            ..RowHighlight::default()
        };
    }
    let live = state.phase == CommentHighlightPhase::Live;
    let highlighted_id = live.then_some(state.message_id.as_deref()).flatten();
    let authoritative_id = state.message_id.as_deref().or(highlighted_id);
    let failed_here = failure.filter(|failure| failure.message_id == message_id);
    if authoritative_id == Some(message_id) && (live || highlighted_id == Some(message_id)) {
        return RowHighlight {
            phase: RowPhase::Live,
            reason: state.reason.clone(),
            command_error: failed_here.map(|failure| failure.reason.clone()),
        };
    }
    if let Some(failure) = failed_here {
        return RowHighlight {
            phase: RowPhase::Failed,
            reason: Some(failure.reason.clone()),
            command_error: None,
        };
    }
    if authoritative_id != Some(message_id) {
        return RowHighlight::default();
    }
    RowHighlight {
        phase: match state.phase {
            CommentHighlightPhase::Failed => RowPhase::Failed,
            CommentHighlightPhase::Live => RowPhase::Live,
            CommentHighlightPhase::Idle => RowPhase::Idle,
        },
        reason: state.reason.clone(),
        command_error: None,
    }
}

/// `highlightProblem`: why a highlight did not land, as the row's own line.
pub fn problem(highlight: &RowHighlight) -> Option<String> {
    let text = match highlight.phase {
        RowPhase::Failed => highlight.reason.as_deref(),
        RowPhase::Live => highlight.command_error.as_deref(),
        _ => None,
    }?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `commentRowDescription(highlight, null, false)`: what a click does, then
/// what the row's own lines say.
pub fn row_description(highlight: &RowHighlight) -> String {
    let action = if highlight.phase == RowPhase::Live {
        copy::TAKES_IT_OFF
    } else {
        copy::SHOWS_IT
    };
    match problem(highlight) {
        Some(problem) => format!("{action}. {problem}"),
        None => action.to_string(),
    }
}

/// `HighlightStatus`: the chips a row shows (the chip and the "Action
/// failed" beside On stream), none while idle.
pub fn status_chips(highlight: &RowHighlight) -> Vec<(&'static str, StatusChip)> {
    match highlight.phase {
        RowPhase::Idle => Vec::new(),
        RowPhase::Applying => vec![(copy::APPLYING, StatusChip::Neutral)],
        RowPhase::Live => {
            let mut chips = vec![(copy::ON_STREAM, StatusChip::Chrome)];
            if highlight.command_error.is_some() {
                chips.push((copy::ACTION_FAILED, StatusChip::Destructive));
            }
            chips
        }
        RowPhase::Failed => vec![(copy::FAILED, StatusChip::Destructive)],
    }
}

/// A chip's Badge variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusChip {
    Neutral,
    Chrome,
    Destructive,
}

/// `commentHighlightExpiryDelay` and `expireCommentHighlightState`: the
/// backend expires a card and says so; this only stops a Studio that lost
/// the connection from claiming On stream past `expiresAt`.
pub fn expired(state: &CommentHighlightState, now: DateTime<Utc>) -> bool {
    state.phase == CommentHighlightPhase::Live
        && state
            .expires_at
            .as_deref()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at.with_timezone(&Utc) <= now)
}

/// When a live card's `expiresAt` comes, if it has one that reads.
pub fn expires_at(state: &CommentHighlightState) -> Option<DateTime<Utc>> {
    (state.phase == CommentHighlightPhase::Live)
        .then_some(state.expires_at.as_deref())
        .flatten()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&Utc))
}

/// `highlightEmoteImageUrl`: a Twitch emote at the card's size (`/3.0`,
/// not the row's `/1.0`); every other URL as it is.
pub fn emote_image_url(url: &str) -> String {
    const PREFIX: &str = "https://static-cdn.jtvnw.net/emoticons/v2/";
    if let Some(rest) = url.strip_prefix(PREFIX)
        && let Some(head) = rest.strip_suffix("1.0")
    {
        let parts: Vec<&str> = head.split('/').collect();
        // `[^/]+/[^/]+/[^/]+/` before `1.0`: three non-empty segments.
        if parts.len() == 4 && parts[..3].iter().all(|part| !part.is_empty()) && parts[3].is_empty()
        {
            return format!("{PREFIX}{head}3.0");
        }
    }
    url.to_string()
}

/// `commentHighlightImageUrls`: the files the backend draws a message's
/// card from, cached before the card is asked for: the avatar, then the
/// card's emotes at the card's size. An activity card (with `details`) stays
/// text; a GIF is never painted (the card says its title).
///
/// The emotes are the image fragments in order (a zero-width 7TV emote
/// follows the emote it sits on, as `groupEmoteOverlays` stacks them),
/// distinct, at most [`MAX_EMOTES`].
pub fn card_image_urls(message: &LiveChatMessage) -> Vec<String> {
    let mut urls: Vec<String> = message.author_avatar_url.iter().cloned().collect();
    if message.details.is_none() {
        let mut emotes: Vec<&str> = Vec::new();
        for fragment in &message.fragments {
            if fragment.fragment_type == "gif" {
                continue;
            }
            if let Some(url) = fragment.image_url.as_deref()
                && !emotes.contains(&url)
            {
                if emotes.len() >= MAX_EMOTES {
                    break;
                }
                emotes.push(url);
            }
        }
        urls.extend(emotes.into_iter().map(emote_image_url));
    }
    urls
}

/// `commentHighlightSetFailureCanReconcile`: a set whose outcome is unknown
/// counts as done when the backend says this message is on stream.
pub fn set_reconciles(
    status: Option<&CommentHighlightState>,
    session_id: &str,
    message_id: &str,
) -> bool {
    status.is_some_and(|status| {
        status.phase == CommentHighlightPhase::Live
            && status.session_id.as_deref() == Some(session_id)
            && status.message_id.as_deref() == Some(message_id)
    })
}

/// `commentHighlightClearFailureCanReconcile`: a clear whose outcome is
/// unknown counts as done when nothing is on stream.
pub fn clear_reconciles(status: Option<&CommentHighlightState>) -> bool {
    status.is_some_and(|status| status.phase == CommentHighlightPhase::Idle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words the remotes and the rows share are Electron's, byte for byte.
    #[test]
    fn the_highlight_words_are_electrons() {
        const CONTEXT_TS: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts"
        );
        for words in [
            copy::HIGHLIGHT_FAILED,
            copy::COMMENT_UNAVAILABLE,
            copy::NEWER_COMMENT,
            copy::DID_NOT_REACH_STREAM,
            copy::CLEAR_FAILED,
        ] {
            assert!(
                CONTEXT_TS.contains(words),
                "studio-context.ts no longer says {words:?}"
            );
        }
    }
    use crate::chat::model::LiveChatFragment;

    fn state(phase: CommentHighlightPhase, message: Option<&str>) -> CommentHighlightState {
        CommentHighlightState {
            session_id: Some("s".into()),
            message_id: message.map(str::to_string),
            generation: 1,
            phase,
            expires_at: None,
            reason: None,
        }
    }

    fn failure(id: &str, reason: &str) -> HighlightFailure {
        HighlightFailure {
            message_id: id.into(),
            reason: reason.into(),
        }
    }

    // `comment-row.test.ts`'s presentation cases.
    #[test]
    fn the_click_in_flight_then_the_backends_card_then_the_failure() {
        let idle = CommentHighlightState::default();
        assert_eq!(
            presentation("a", &idle, Some("a"), None).phase,
            RowPhase::Applying
        );
        let live = state(CommentHighlightPhase::Live, Some("a"));
        assert_eq!(presentation("a", &live, None, None).phase, RowPhase::Live);
        assert_eq!(presentation("b", &live, None, None).phase, RowPhase::Idle);
        // A failed action on the live row keeps it live with its error.
        let both = presentation("a", &live, None, Some(&failure("a", "No")));
        assert_eq!(both.phase, RowPhase::Live);
        assert_eq!(both.command_error.as_deref(), Some("No"));
        assert_eq!(problem(&both).as_deref(), Some("No"));
        assert_eq!(row_description(&both), "Takes it off the stream. No");
        // The Studio's failure on another row.
        let failed = presentation("b", &live, None, Some(&failure("b", "Not live.")));
        assert_eq!(failed.phase, RowPhase::Failed);
        assert_eq!(row_description(&failed), "Shows it on stream. Not live.");
        // The backend's own failure.
        let mut backend_failed = state(CommentHighlightPhase::Failed, Some("c"));
        backend_failed.reason = Some("The card could not be drawn.".into());
        let row = presentation("c", &backend_failed, None, None);
        assert_eq!(row.phase, RowPhase::Failed);
        assert_eq!(
            problem(&row).as_deref(),
            Some("The card could not be drawn.")
        );
        // Idle keeps the last message id: still idle.
        let after = state(CommentHighlightPhase::Idle, Some("a"));
        assert_eq!(presentation("a", &after, None, None).phase, RowPhase::Idle);
        assert_eq!(
            row_description(&RowHighlight::default()),
            "Shows it on stream"
        );
    }

    #[test]
    fn the_chips_say_applying_on_stream_and_failed() {
        assert!(status_chips(&RowHighlight::default()).is_empty());
        let applying = RowHighlight {
            phase: RowPhase::Applying,
            ..RowHighlight::default()
        };
        assert_eq!(
            status_chips(&applying),
            [("Applying…", StatusChip::Neutral)]
        );
        let live = RowHighlight {
            phase: RowPhase::Live,
            command_error: Some("x".into()),
            ..RowHighlight::default()
        };
        assert_eq!(
            status_chips(&live),
            [
                ("On stream", StatusChip::Chrome),
                ("Action failed", StatusChip::Destructive)
            ]
        );
    }

    #[test]
    fn a_live_card_past_its_expiry_reads_as_gone() {
        let mut live = state(CommentHighlightPhase::Live, Some("a"));
        live.expires_at = Some("2026-11-10T10:00:10.000Z".into());
        let before = DateTime::parse_from_rfc3339("2026-11-10T10:00:09Z")
            .unwrap()
            .with_timezone(&Utc);
        let after = DateTime::parse_from_rfc3339("2026-11-10T10:00:11Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(!expired(&live, before));
        assert!(expired(&live, after));
        assert!(expires_at(&live).is_some());
        live.expires_at = None;
        assert!(
            !expired(&live, after),
            "no expiry: the backend's word stands"
        );
    }

    // `comment-highlight-layout.test.ts`: the files the card is drawn from.
    #[test]
    fn the_card_caches_the_avatar_then_its_emotes_at_the_card_size() {
        let fragment =
            |kind: &str, text: &str, url: Option<&str>, zero_width: bool| LiveChatFragment {
                fragment_type: kind.into(),
                text: text.into(),
                image_url: url.map(str::to_string),
                zero_width,
            };
        let message = LiveChatMessage {
            author_avatar_url: Some("https://yt3.ggpht.com/a.png".into()),
            fragments: vec![
                fragment("text", "hi ", None, false),
                fragment(
                    "emote",
                    "Kappa",
                    Some("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"),
                    false,
                ),
                fragment(
                    "emote",
                    "RainTime",
                    Some("https://cdn.7tv.app/emote/x/4x.webp"),
                    true,
                ),
                fragment(
                    "emote",
                    "Kappa",
                    Some("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"),
                    false,
                ),
                fragment("gif", "dance", Some("https://media.giphy.com/x.gif"), false),
            ],
            ..LiveChatMessage::default()
        };
        assert_eq!(
            card_image_urls(&message),
            [
                "https://yt3.ggpht.com/a.png",
                "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0",
                "https://cdn.7tv.app/emote/x/4x.webp",
            ]
        );
        // An activity card stays text.
        let activity = LiveChatMessage {
            details: Some(serde_json::json!({"kind": "subscription"})),
            ..message.clone()
        };
        assert_eq!(card_image_urls(&activity), ["https://yt3.ggpht.com/a.png"]);
        // A Kick URL has no size to swap.
        assert_eq!(
            emote_image_url("https://files.kick.com/emotes/1/fullsize"),
            "https://files.kick.com/emotes/1/fullsize"
        );
        assert_eq!(
            emote_image_url("https://static-cdn.jtvnw.net/emoticons/v2/25/default/1.0"),
            "https://static-cdn.jtvnw.net/emoticons/v2/25/default/1.0",
            "two segments before the size: not Twitch's shape"
        );
    }

    #[test]
    fn an_unknown_outcome_reconciles_only_on_the_matching_state() {
        let live = state(CommentHighlightPhase::Live, Some("a"));
        assert!(set_reconciles(Some(&live), "s", "a"));
        assert!(!set_reconciles(Some(&live), "s", "b"));
        assert!(!set_reconciles(None, "s", "a"));
        assert!(clear_reconciles(Some(&CommentHighlightState::default())));
        assert!(!clear_reconciles(Some(&live)));
    }
}
