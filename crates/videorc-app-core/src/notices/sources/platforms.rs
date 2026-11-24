//! Chat connections, platform steps and the Videorc account as
//! notifications (plan 250 S6, Electron's `sources/platforms.ts`). Each was
//! a toast of its own; each is one entry with its way out. The
//! browser-approval step and "Connected {platform}" stay toasts: they answer
//! Connect.
//!
//! Where Electron runs a closure on a button, [`platform_press`] says what
//! the press asks for, and the app does it.

use super::devices::CURRENT_SESSION;
use crate::notices::Store;
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// `X_MEDIA_STUDIO_URL` (`lib/studio-toasts.ts`).
pub const X_MEDIA_STUDIO_URL: &str = "https://studio.x.com";
/// `ACCOUNT_SESSION_KEY`.
pub const ACCOUNT_SESSION_KEY: &str = "account-session";
/// `X_PLAYBACK_KEY`.
pub const X_PLAYBACK_KEY: &str = "x-playback";

/// Words a caller's error copy gave (`userErrorMessage`, a toast's words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Words<'a> {
    pub title: &'a str,
    pub description: Option<&'a str>,
}

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

fn open_destinations() -> Action {
    action("open-destinations", "Open Destinations", ActionKind::Door)
}

fn open_discord_settings() -> Action {
    action(
        "open-destinations-discord",
        "Open Discord settings",
        ActionKind::Door,
    )
}

fn sign_in() -> Action {
    action("sign-in", "Sign in", ActionKind::Fix)
}

fn open_media_studio() -> Action {
    action("open-media-studio", "Open Media Studio", ActionKind::Fix)
}

/// The thumbnail's Retry. Its id carries the account and the target the
/// retry needs (`streamTargets.youtube.thumbnail.retry`), as JSON, so any id
/// is safe in it: `retry:{"accountId":…,"targetId":…}`.
fn retry(account_id: Option<&str>, target_id: Option<&str>) -> Action {
    let ids = serde_json::json!({ "accountId": account_id, "targetId": target_id });
    action(&format!("retry:{ids}"), "Retry", ActionKind::Fix)
}

fn base(key: String, kind: &str, title: impl Into<String>) -> Input {
    Input {
        key,
        kind: kind.into(),
        title: title.into(),
        ..Input::default()
    }
}

// --- Chat -------------------------------------------------------------------

/// `publishChatNotConnected`: a destination's chat did not connect at Go
/// Live. The stream is fine.
pub fn chat_not_connected(target_id: &str, message: &str, platform_label: &str) -> Input {
    Input {
        detail: Some(message.into()),
        actions: vec![open_destinations()],
        session_id: Some(CURRENT_SESSION.into()),
        ..base(
            format!("chat:{target_id}"),
            "chat",
            format!("{platform_label} chat isn't connected"),
        )
    }
}

/// `resolveChatNotConnected`: pass to `Store::resolve(&format!("chat:{id}"), …)`.
pub fn chat_connected(platform_label: &str) -> Resolution {
    Resolution {
        title: Some(format!("{platform_label} chat is connected")),
        ..Resolution::default()
    }
}

/// `publishXChatNotConnected`.
pub fn x_chat_not_connected(target_id: &str, target_label: &str) -> Input {
    Input {
        detail: Some("Your stream is fine. Check X in Destinations.".into()),
        actions: vec![open_destinations()],
        session_id: Some(CURRENT_SESSION.into()),
        ..base(
            format!("chat:{target_id}"),
            "chat",
            format!("X chat isn't connected for {target_label}"),
        )
    }
}

// --- The Videorc account ----------------------------------------------------

/// `chatSignInKey`.
pub fn chat_sign_in_key(platform_label: &str) -> String {
    format!("chat-sign-in:{platform_label}")
}

/// `publishChatNeedsSignIn` (plan 215 A3): the entry names the account,
/// never the platform. Sign in attaches chat without a restart.
pub fn chat_needs_sign_in(platform_label: &str) -> Input {
    Input {
        detail: Some("Your stream is fine. Sign in to read chat.".into()),
        actions: vec![sign_in()],
        ..base(
            chat_sign_in_key(platform_label),
            "account-sign-in",
            format!("{platform_label} chat needs your Videorc sign-in"),
        )
    }
}

/// `publishSignInExpired`: the server refused the stored session.
pub fn sign_in_expired() -> Input {
    Input {
        detail: Some("Sign in again.".into()),
        actions: vec![sign_in()],
        ..base(
            ACCOUNT_SESSION_KEY.into(),
            "account-sign-in",
            "Your Videorc sign-in expired",
        )
    }
}

/// `resolveSignedIn`: everything that waited on the sign-in resolves.
pub fn resolve_signed_in(store: &mut Store, platform_labels: &[&str], now: u64) {
    store.resolve(
        ACCOUNT_SESSION_KEY,
        Resolution {
            title: Some("Signed in to Videorc".into()),
            ..Resolution::default()
        },
        now,
    );
    for label in platform_labels {
        store.resolve(
            &chat_sign_in_key(label),
            Resolution {
                title: Some(format!("{label} chat is connected to your account")),
                ..Resolution::default()
            },
            now,
        );
    }
}

// --- X ----------------------------------------------------------------------

/// Which X broadcast step failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XStep {
    Start,
    End,
    Chat,
}

/// `publishXBroadcastProblem`: a step that failed while the stream goes on,
/// a warning. `words` is `userErrorMessage(error, {action, object: 'the X
/// broadcast'})` (`end` for the end step, `start` otherwise).
pub fn x_broadcast_problem(
    step: XStep,
    target_id: &str,
    target_label: &str,
    words: Words<'_>,
) -> Input {
    match step {
        XStep::Chat => x_chat_not_connected(target_id, target_label),
        XStep::End => Input {
            detail: Some("End it in X Media Studio.".into()),
            actions: vec![open_media_studio()],
            once: true,
            ..base(
                format!("x-broadcast-end:{target_id}"),
                "platform-step",
                words.title,
            )
        },
        XStep::Start => Input {
            detail: words.description.map(str::to_string),
            actions: vec![open_destinations()],
            once: true,
            ..base(
                format!("x-broadcast-start:{target_id}"),
                "platform-step",
                words.title,
            )
        },
    }
}

/// `publishXStartBroadcast`: a Stream key feed reached X; the broadcast
/// still has to be started there. Each Go Live's reminder is its own.
pub fn x_start_broadcast() -> Input {
    Input {
        detail: Some(
            "X doesn't go live from the RTMP feed alone: open Media Studio → Producer → Broadcasts, create a broadcast from your source, and press Broadcast."
                .into(),
        ),
        actions: vec![open_media_studio()],
        ..base(
            "x-start-broadcast".into(),
            "go-live-step",
            "X feed is connected: start the broadcast on X",
        )
    }
}

/// X's playback check (`XPlaybackEvent.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XPlayback {
    Verified,
    Pending,
    Unavailable,
}

/// `publishXPlayback`: preparing is a warning, "X ended your broadcast" is
/// urgent, and "viewers can watch" resolves either, or is the late answer
/// to Go Live when nothing was wrong.
pub fn publish_x_playback(store: &mut Store, status: XPlayback, share_url: Option<&str>, now: u64) {
    match status {
        XPlayback::Verified => {
            let title = "Viewers can watch your X broadcast";
            if store.has(X_PLAYBACK_KEY) {
                store.resolve(
                    X_PLAYBACK_KEY,
                    Resolution {
                        title: Some(title.into()),
                        was: Some("X was preparing it".into()),
                        ..Resolution::default()
                    },
                    now,
                );
            } else {
                store.publish(
                    Input {
                        detail: share_url.map(str::to_string),
                        once: true,
                        ..base("x-live".into(), "x-live", title)
                    },
                    now,
                );
            }
        }
        XPlayback::Pending => store.publish(
            Input {
                detail: Some(
                    "Viewers may see a loading spinner for a few minutes. Keep streaming. Videorc keeps checking."
                        .into(),
                ),
                session_id: Some(CURRENT_SESSION.into()),
                ..base(
                    X_PLAYBACK_KEY.into(),
                    "x-playback",
                    "X is still preparing your stream",
                )
            },
            now,
        ),
        // X's API exposes no playback URL any more: `unavailable` means X
        // ended the broadcast.
        XPlayback::Unavailable => store.publish(
            Input {
                tone: Some(Tone::Urgent),
                detail: Some(
                    "X stopped it while Videorc was still streaming, usually because no video reached X. Your local recording is unaffected."
                        .into(),
                ),
                actions: vec![open_media_studio()],
                session_id: Some(CURRENT_SESSION.into()),
                ..base(X_PLAYBACK_KEY.into(), "x-playback", "X ended your broadcast")
            },
            now,
        ),
    }
}

// --- YouTube and Discord ----------------------------------------------------

/// `publishYouTubeBroadcastProblem` (`start` or `end`).
pub fn youtube_broadcast_problem(step_is_end: bool, target_id: &str, words: Words<'_>) -> Input {
    let step = if step_is_end { "end" } else { "start" };
    Input {
        detail: words.description.map(str::to_string),
        actions: vec![open_destinations()],
        once: true,
        ..base(
            format!("youtube-broadcast-{step}:{target_id}"),
            "platform-step",
            words.title,
        )
    }
}

/// `publishYouTubeBudget`: one quiet notice per daily-budget step (plan 094).
pub fn youtube_budget(step: &str, words: Words<'_>) -> Input {
    Input {
        detail: words.description.map(str::to_string),
        once: true,
        ..base(
            format!("youtube-budget:{step}"),
            "platform-news",
            words.title,
        )
    }
}

/// `publishDiscordFailure`: a go-live post that failed, with Destinations →
/// Discord.
pub fn discord_failure(words: Words<'_>) -> Input {
    Input {
        detail: words.description.map(str::to_string),
        actions: vec![open_discord_settings()],
        ..base("discord-announce".into(), "platform-step", words.title)
    }
}

/// `youtubeThumbnailKey`.
pub fn youtube_thumbnail_key(broadcast_id: &str) -> String {
    format!("youtube-thumbnail:{broadcast_id}")
}

/// `publishYouTubeThumbnailFailure` (plan 083): one entry per broadcast,
/// with Retry while a retry can help (`message` is the failure's, or the
/// retry's error words).
pub fn youtube_thumbnail_failure(
    broadcast_id: &str,
    account_id: Option<&str>,
    target_id: Option<&str>,
    message: &str,
    retryable: bool,
) -> Input {
    Input {
        detail: Some(message.into()),
        actions: if retryable {
            vec![retry(account_id, target_id)]
        } else {
            Vec::new()
        },
        ..base(
            youtube_thumbnail_key(broadcast_id),
            "youtube-thumbnail",
            "Thumbnail not set on YouTube",
        )
    }
}

/// A retry that worked: pass to `Store::resolve(&youtube_thumbnail_key(…), …)`.
pub fn youtube_thumbnail_set() -> Resolution {
    Resolution {
        title: Some("Thumbnail set on YouTube".into()),
        detail: Some("The retry worked.".into()),
        ..Resolution::default()
    }
}

// --- Go Live's own notes ----------------------------------------------------

/// `publishStreamKeyMigration`: a key saved the old way could not move to
/// the keychain.
pub fn stream_key_migration(label: &str, target_id: &str) -> Input {
    Input {
        detail: Some(
            "Paste it in Destinations → Setup so Videorc can store it securely. It works for now."
                .into(),
        ),
        actions: vec![open_destinations()],
        once: true,
        ..base(
            format!("stream-key-migration:{target_id}"),
            "platform-step",
            format!("Save your {label} stream key again"),
        )
    }
}

/// `publishStreamOutputAdjusted`: Go Live changed the output to what the
/// destinations take.
pub fn stream_output_adjusted(words: Words<'_>) -> Input {
    Input {
        detail: words.description.map(str::to_string),
        ..base("stream-output-adjusted".into(), "go-live-step", words.title)
    }
}

// --- Buttons ----------------------------------------------------------------

/// What a pressed platform button asks the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformPress {
    /// Destinations, at the destination's card when the key names one.
    OpenDestinations { target_id: Option<String> },
    /// Destinations → Discord.
    OpenDiscordSettings,
    /// `beginVideorcSignIn`.
    SignIn,
    /// `openOAuthUrl`: X Media Studio in the browser.
    OpenUrl(&'static str),
    /// `streamTargets.youtube.thumbnail.retry` for this broadcast.
    RetryThumbnail {
        broadcast_id: String,
        account_id: Option<String>,
        target_id: Option<String>,
    },
}

/// Whether this source published the entry: other sources use the same
/// ids for other pages (a cloud entry's `open-destinations` is Destinations
/// → Cloud).
fn is_platform_key(key: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "chat:",
        "chat-sign-in:",
        "x-broadcast-start:",
        "x-broadcast-end:",
        "youtube-broadcast-start:",
        "youtube-broadcast-end:",
        "youtube-budget:",
        "youtube-thumbnail:",
        "stream-key-migration:",
    ];
    const KEYS: &[&str] = &[
        ACCOUNT_SESSION_KEY,
        "x-start-broadcast",
        X_PLAYBACK_KEY,
        "x-live",
        "discord-announce",
        "stream-output-adjusted",
    ];
    KEYS.contains(&key) || PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

/// The press for an entry's button; `None` when it is not this source's.
pub fn platform_press(key: &str, action_id: &str) -> Option<PlatformPress> {
    if !is_platform_key(key) {
        return None;
    }
    // `chat:{id}`, `x-broadcast-start:{id}`, `youtube-broadcast-…:{id}` and
    // `stream-key-migration:{id}` end in their destination.
    let target = || key.split_once(':').map(|(_, id)| id.to_string());
    if let Some(ids) = action_id.strip_prefix("retry:") {
        let ids: serde_json::Value = serde_json::from_str(ids).ok()?;
        let text = |name: &str| {
            ids.get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        return Some(PlatformPress::RetryThumbnail {
            broadcast_id: key.strip_prefix("youtube-thumbnail:")?.to_string(),
            account_id: text("accountId"),
            target_id: text("targetId"),
        });
    }
    Some(match action_id {
        "open-destinations" => PlatformPress::OpenDestinations {
            target_id: target(),
        },
        "open-destinations-discord" => PlatformPress::OpenDiscordSettings,
        "sign-in" => PlatformPress::SignIn,
        "open-media-studio" => PlatformPress::OpenUrl(X_MEDIA_STUDIO_URL),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::Effect;
    use crate::notices::types::State;

    fn shown(store: &mut Store) -> usize {
        store
            .take_effects()
            .iter()
            .filter(|effect| matches!(effect, Effect::Show { .. }))
            .count()
    }

    #[test]
    fn a_chat_that_did_not_connect_resolves_when_it_does() {
        let mut store = Store::new(0, 0);
        store.publish(chat_not_connected("tw", "Token expired.", "Twitch"), 1_000);
        assert_eq!(store.snapshot()[0].title, "Twitch chat isn't connected");
        store.resolve("chat:tw", chat_connected("Twitch"), 5_000);
        let entry = &store.snapshot()[0];
        assert_eq!(entry.state, State::Resolved);
        assert_eq!(entry.title, "Twitch chat is connected");
    }

    #[test]
    fn signing_in_resolves_everything_that_waited_on_it() {
        let mut store = Store::new(0, 0);
        store.publish(sign_in_expired(), 1_000);
        store.publish(chat_needs_sign_in("YouTube"), 1_000);
        resolve_signed_in(&mut store, &["YouTube"], 2_000);
        assert!(
            store
                .snapshot()
                .iter()
                .all(|entry| entry.state == State::Resolved)
        );
        assert!(
            store
                .snapshot()
                .iter()
                .any(|entry| entry.title == "YouTube chat is connected to your account")
        );
    }

    #[test]
    fn x_playback_warns_then_resolves_or_answers_go_live() {
        let mut store = Store::new(0, 0);
        publish_x_playback(&mut store, XPlayback::Pending, None, 1_000);
        assert_eq!(store.snapshot()[0].tone, Tone::Warning);
        publish_x_playback(&mut store, XPlayback::Verified, None, 2_000);
        assert_eq!(store.snapshot()[0].state, State::Resolved);
        assert_eq!(
            store.snapshot()[0].title,
            "Viewers can watch your X broadcast"
        );

        let mut fresh = Store::new(0, 0);
        fresh.set_pressed();
        publish_x_playback(
            &mut fresh,
            XPlayback::Verified,
            Some("https://x.com/i/broadcasts/1"),
            1_000,
        );
        assert_eq!(fresh.snapshot()[0].key, "x-live");
        assert_eq!(fresh.snapshot()[0].tone, Tone::Done);

        let mut ended = Store::new(0, 0);
        publish_x_playback(&mut ended, XPlayback::Unavailable, None, 1_000);
        let entry = &ended.snapshot()[0];
        assert_eq!(entry.tone, Tone::Urgent);
        assert_eq!(entry.actions[0].id, "open-media-studio");
        // X ended a livestream the streamer started: it may pop up even
        // after the session ended (`fails_a_session`); the store decides.
        let _ = shown(&mut ended);
    }

    #[test]
    fn x_steps_land_on_their_own_keys() {
        let words = Words {
            title: "Couldn't start the X broadcast",
            description: Some("X refused it."),
        };
        let start = x_broadcast_problem(XStep::Start, "x1", "Main", words);
        assert_eq!(start.key, "x-broadcast-start:x1");
        assert_eq!(start.detail.as_deref(), Some("X refused it."));
        let end = x_broadcast_problem(XStep::End, "x1", "Main", words);
        assert_eq!(end.detail.as_deref(), Some("End it in X Media Studio."));
        let chat = x_broadcast_problem(XStep::Chat, "x1", "Main", words);
        assert_eq!(chat.title, "X chat isn't connected for Main");
    }

    #[test]
    fn each_button_says_what_it_asks_for() {
        assert_eq!(
            platform_press("chat:tw", "open-destinations"),
            Some(PlatformPress::OpenDestinations {
                target_id: Some("tw".into())
            })
        );
        assert_eq!(
            platform_press("x-start-broadcast", "open-media-studio"),
            Some(PlatformPress::OpenUrl(X_MEDIA_STUDIO_URL))
        );
        // The retry goes to the account and the target that failed.
        let failed = youtube_thumbnail_failure(
            "b1",
            Some("youtube:acct-2"),
            Some("yt-main"),
            "Upload failed.",
            true,
        );
        assert_eq!(
            platform_press(&failed.key, &failed.actions[0].id),
            Some(PlatformPress::RetryThumbnail {
                broadcast_id: "b1".into(),
                account_id: Some("youtube:acct-2".into()),
                target_id: Some("yt-main".into()),
            })
        );
        assert_eq!(failed.actions[0].label, "Retry");
        assert_eq!(platform_press("clips", "retry:{}"), None);
        // Other sources' entries keep their own pages.
        assert_eq!(platform_press("cloud-status", "open-destinations"), None);
        assert_eq!(platform_press("sidekick", "sign-in"), None);
        assert_eq!(
            youtube_thumbnail_failure("b1", None, None, "Too big.", false).actions,
            Vec::new()
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const SOURCE: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/platforms.ts"
        );
        const TOASTS: &str =
            include_str!("../../../../../apps/desktop/src/renderer/src/lib/studio-toasts.ts");
        for words in [
            "title: `${platformLabel} chat isn't connected`",
            "`${platformLabel} chat is connected`",
            "title: `X chat isn't connected for ${target.label}`",
            "'Your stream is fine. Check X in Destinations.'",
            "title: `${platformLabel} chat needs your Videorc sign-in`",
            "'Your stream is fine. Sign in to read chat.'",
            "title: 'Your Videorc sign-in expired'",
            "'Signed in to Videorc'",
            "`${label} chat is connected to your account`",
            "'End it in X Media Studio.'",
            "title: 'X feed is connected: start the broadcast on X'",
            "'Viewers can watch your X broadcast'",
            "was: 'X was preparing it'",
            "title: 'X is still preparing your stream'",
            "title: 'X ended your broadcast'",
            "title: 'Thumbnail not set on YouTube'",
            "'Thumbnail set on YouTube', detail: 'The retry worked.'",
            "title: `Save your ${label} stream key again`",
            "label: 'Open Discord settings'",
            "label: 'Open Media Studio'",
        ] {
            assert!(SOURCE.contains(words), "platforms.ts lacks {words}");
        }
        assert!(TOASTS.contains(&format!("X_MEDIA_STUDIO_URL = '{X_MEDIA_STUDIO_URL}'")));
    }
}
