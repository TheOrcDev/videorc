//! The registry (plan 250, Electron's `lib/notifications/kinds.ts`): one row
//! per kind of notification, with its tone and its life. The urgent list is
//! short on purpose and lives here: a new urgent kind is a decision, not a
//! default (the test pins the list).

use super::types::{Life, Tone};

/// `NotificationKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kind {
    pub tone: Tone,
    pub life: Life,
    /// Other tones a report may carry (a watchdog alert's severity decides).
    pub may_be: &'static [Tone],
    /// The late answer to a press (a clip saved by a hotkey): it is an entry
    /// and it still pops up, briefly, because the streamer is waiting for it.
    pub answers_a_press: bool,
    /// News Videorc tells once, outside a session. It never pops up, so it
    /// counts on the bell, or nobody would see it.
    pub announcement: bool,
    /// Its urgent report says a livestream the streamer started has failed,
    /// and may arrive after the session ended.
    pub fails_a_session: bool,
    /// How long that pop-up stays, when not the default.
    pub pop_up_ms: Option<u64>,
}

const fn kind(tone: Tone, life: Life) -> Kind {
    Kind {
        tone,
        life,
        may_be: &[],
        answers_a_press: false,
        announcement: false,
        fails_a_session: false,
        pop_up_ms: None,
    }
}

use Life::{Condition, Event, Progress};
use Tone::{Done, News, Urgent, Warning};

/// Every kind, in Electron's order.
pub const KINDS: &[(&str, Kind)] = &[
    // The stream watchdog (plan 223): the alert's severity is its tone.
    (
        "watchdog",
        Kind {
            may_be: &[Urgent, News],
            ..kind(Warning, Condition)
        },
    ),
    // The live output and the connection (`health` events).
    ("stream-output", kind(Urgent, Condition)),
    ("stream-output-failed", kind(Urgent, Event)),
    ("recording-output-failed", kind(Urgent, Event)),
    ("stream-delivery", kind(Warning, Condition)),
    ("stream-uplink", kind(Warning, Condition)),
    (
        "screen-capture",
        Kind {
            may_be: &[Urgent],
            ..kind(Warning, Condition)
        },
    ),
    ("host-overloaded", kind(Warning, Condition)),
    ("disk-space", kind(Warning, Condition)),
    // What the session said at its start and holds true until it ends.
    ("session-notice", kind(Warning, Condition)),
    ("recording-quality", kind(Warning, Event)),
    ("separate-file", kind(Warning, Event)),
    ("recording-failed", kind(Urgent, Event)),
    ("source-fallback", kind(Warning, Event)),
    // Audio.
    (
        "microphone",
        Kind {
            may_be: &[Urgent],
            ..kind(Warning, Condition)
        },
    ),
    ("audio-blip", kind(News, Event)),
    ("system-audio-echo", kind(Warning, Condition)),
    ("audio-output-failed", kind(Urgent, Event)),
    // Destinations, platforms and Videorc Cloud. Urgent when no other
    // destination is on air: viewers see nothing.
    (
        "stream-target",
        Kind {
            may_be: &[Urgent],
            ..kind(Warning, Condition)
        },
    ),
    ("chat", kind(Warning, Condition)),
    ("account-sign-in", kind(Warning, Condition)),
    // A step on a platform that failed while the stream goes on.
    ("platform-step", kind(Warning, Event)),
    // What Go Live did or still needs, said while the streamer waits for it.
    (
        "go-live-step",
        Kind {
            answers_a_press: true,
            pop_up_ms: Some(8_000),
            ..kind(News, Event)
        },
    ),
    // Urgent when X ended the broadcast itself.
    (
        "x-playback",
        Kind {
            may_be: &[Urgent],
            fails_a_session: true,
            ..kind(Warning, Condition)
        },
    ),
    (
        "x-live",
        Kind {
            answers_a_press: true,
            ..kind(Done, Event)
        },
    ),
    ("platform-news", kind(News, Event)),
    ("youtube-thumbnail", kind(Warning, Condition)),
    ("cloud-status", kind(Warning, Condition)),
    ("cloud-news", kind(News, Event)),
    (
        "cloud-announce",
        Kind {
            announcement: true,
            ..kind(News, Event)
        },
    ),
    (
        "cloud-controller",
        Kind {
            answers_a_press: true,
            pop_up_ms: Some(8_000),
            ..kind(News, Condition)
        },
    ),
    // Back in the room by itself after a backend restart.
    ("cloud-rejoin", kind(News, Progress)),
    // Devices, the app and finished work. The session runs without the
    // device, so it counts until it is used.
    ("source-return", kind(Warning, Condition)),
    ("videorc-camera", kind(Warning, Condition)),
    ("global-shortcuts", kind(Warning, Condition)),
    // Urgent when the engine cannot come back on its own.
    (
        "backend",
        Kind {
            may_be: &[Urgent],
            ..kind(Warning, Condition)
        },
    ),
    ("backend-error", kind(Warning, Event)),
    ("output-too-heavy", kind(Warning, Event)),
    // Sidekick stopped or failed on its own (a lapse, a quota, a sign-out).
    (
        "sidekick",
        Kind {
            may_be: &[News],
            ..kind(Warning, Event)
        },
    ),
    // Live captions the Studio starts on its own with a session could not start.
    ("captions", kind(Warning, Event)),
    ("app-news", kind(News, Event)),
    // The late answer to Stop: the take is saved, with Play and the Library.
    (
        "recording-saved",
        Kind {
            answers_a_press: true,
            pop_up_ms: Some(8_000),
            ..kind(Done, Event)
        },
    ),
    ("mp4", kind(News, Progress)),
    ("work-done", kind(Done, Event)),
    ("work-failed", kind(Warning, Event)),
    // The answer to the Clip key, wherever the streamer is.
    (
        "clip",
        Kind {
            answers_a_press: true,
            pop_up_ms: Some(4_000),
            ..kind(Done, Event)
        },
    ),
    (
        "clip-failed",
        Kind {
            answers_a_press: true,
            ..kind(Warning, Event)
        },
    ),
    ("clips", kind(Warning, Condition)),
];

/// The kind for an id; none for an id the registry lacks.
pub fn find(id: &str) -> Option<&'static Kind> {
    KINDS
        .iter()
        .find(|(each, _)| *each == id)
        .map(|(_, kind)| kind)
}

/// `urgentKinds`: the kinds whose own tone is urgent, the short list.
pub fn urgent_kinds() -> Vec<&'static str> {
    KINDS
        .iter()
        .filter(|(_, kind)| kind.tone == Urgent)
        .map(|(id, _)| *id)
        .collect()
}

/// `kindTone`: the tone a report takes, the kind's own or one it allows.
pub fn kind_tone(kind: &Kind, asked: Option<Tone>) -> Tone {
    match asked {
        Some(tone) if tone == kind.tone || kind.may_be.contains(&tone) => tone,
        _ => kind.tone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The urgent list is pinned: a new urgent kind is a decision.
    #[test]
    fn the_urgent_kinds_are_the_short_list() {
        assert_eq!(
            urgent_kinds(),
            [
                "stream-output",
                "stream-output-failed",
                "recording-output-failed",
                "recording-failed",
                "audio-output-failed"
            ]
        );
    }

    #[test]
    fn a_report_takes_its_kinds_tone_or_one_it_allows() {
        let watchdog = find("watchdog").unwrap();
        assert_eq!(kind_tone(watchdog, Some(Urgent)), Urgent);
        assert_eq!(kind_tone(watchdog, Some(Done)), Warning);
        assert_eq!(kind_tone(watchdog, None), Warning);
        assert!(find("nope").is_none());
        assert!(find("clip").unwrap().answers_a_press);
        assert!(find("x-playback").unwrap().fails_a_session);
        assert!(find("cloud-announce").unwrap().announcement);
    }

    /// Every kind in Electron's registry is here, and nothing else.
    #[test]
    fn the_registry_is_electrons() {
        const ELECTRON: &str =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/notifications/kinds.ts");
        let block = ELECTRON
            .split("const kinds = {")
            .nth(1)
            .unwrap()
            .split("} satisfies")
            .next()
            .unwrap();
        let mut electron: Vec<String> = block
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with("//") && line.contains(": {"))
            .map(|line| {
                line.split(':')
                    .next()
                    .unwrap()
                    .trim()
                    .trim_matches('\'')
                    .to_string()
            })
            .collect();
        let mut rust: Vec<String> = KINDS.iter().map(|(id, _)| id.to_string()).collect();
        electron.sort();
        rust.sort();
        assert_eq!(rust, electron);
    }
}
