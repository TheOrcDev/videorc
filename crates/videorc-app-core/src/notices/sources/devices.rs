//! Devices and audio as notifications (plan 250 S7; Electron's
//! `sources/app.ts` for a source that came back, `sources/health.ts` and
//! `health-kinds.ts` for the microphone and the echo guard). S1.6a's toasts
//! raised these three as toasts; under the owner's rules they are entries:
//!
//! - "{device} is back" is news found while the session runs without it: a
//!   bell entry with "Use it", never a toast.
//! - The echo guard's pause is a warning: a bell entry with Resume and Open
//!   Sources, which pops up only when the store's rule says so.
//! - A lost microphone is urgent in a session the streamer started, and
//!   the store pops it up then (and only then); idle it waits behind the
//!   bell like everything else.
//!
//! The store's pop-up rule decides each of those; nothing here shows a toast.

use super::{Door, HealthPage, Transport};
use crate::notices::toasts::{MicrophoneNotice, microphone_notice_title};
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// `HEALTH_SOURCE`: a `health` event's report.
pub const HEALTH_SOURCE: &str = "health";
/// `MICROPHONE_LOST_SOURCE`: the lost or silent input's report.
pub const MICROPHONE_LOST_SOURCE: &str = "health:lost";
/// `MICROPHONE_SILENT_SOURCE`: no sound (`mic-silent`).
pub const MICROPHONE_SILENT_SOURCE: &str = "health:silent";
/// `CURRENT_SESSION`: the session id when the report names none.
pub const CURRENT_SESSION: &str = "session";
/// The microphone's subject.
pub const MICROPHONE_KEY: &str = "microphone";
/// The echo guard's subject.
pub const SYSTEM_AUDIO_ECHO_KEY: &str = "system-audio-echo";

/// `OPEN_AUDIO_LABEL` (`lib/section-doors.ts`).
pub const OPEN_AUDIO_LABEL: &str = "Open Audio";

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

// --- A source that came back ------------------------------------------------

/// `sourceReturnKey`.
pub fn source_return_key(key: &str) -> String {
    format!("source-return:{key}")
}

/// `publishSourceReturn`: a source unplugged mid-session is connected again.
/// The session runs without it, so it counts; "Use it" switches to it. Not
/// bound to the session: the Studio withdraws it when the session ends, as
/// it does when the device is used or unplugged
/// (`Store::withdraw(&source_return_key(key), None, now)`).
pub fn source_return(key: &str, device_name: &str) -> Input {
    Input {
        key: source_return_key(key),
        kind: "source-return".into(),
        title: format!("{device_name} is back"),
        detail: Some("This session is running without it.".into()),
        actions: vec![action("use-it", "Use it", ActionKind::Fix)],
        ..Input::default()
    }
}

// --- The microphone ---------------------------------------------------------

/// `publishMicrophoneLoss`: a lost or silent input, in the session's own
/// words (they change with the activity and the phase), urgent. System
/// audio alone keeps its mixer state and raises nothing: `None`. A notice
/// that names no lost input still raises the entry (Electron's `every` on an
/// empty list would not, but here an absent and an empty list read the same,
/// and an urgent problem is never dropped on that guess).
pub fn microphone_loss(notice: &MicrophoneNotice) -> Option<Input> {
    if !notice.audio_issues.is_empty()
        && notice
            .audio_issues
            .iter()
            .all(|issue| issue.code == "system-audio-lost")
    {
        return None;
    }
    Some(Input {
        key: MICROPHONE_KEY.into(),
        kind: "microphone".into(),
        source: MICROPHONE_LOST_SOURCE.into(),
        tone: Some(Tone::Urgent),
        title: microphone_notice_title(notice),
        detail: (!notice.message.is_empty()).then(|| notice.message.clone()),
        actions: vec![action("open-audio", OPEN_AUDIO_LABEL, ActionKind::Door)],
        session_id: Some(
            notice
                .session_id
                .clone()
                .unwrap_or_else(|| CURRENT_SESSION.into()),
        ),
        ..Input::default()
    })
}

/// `microphone-input-recovered` and `microphone-timeline-recovered`: the
/// lost input's report clears ("Microphone is back"). Each resolution goes
/// to `Store::resolve(MICROPHONE_KEY, …)`.
pub fn microphone_back() -> Vec<Resolution> {
    vec![Resolution {
        source: Some(MICROPHONE_LOST_SOURCE.into()),
        title: Some("Microphone is back".into()),
        ..Resolution::default()
    }]
}

/// `microphone-signal-recovered`: both microphone reports clear.
pub fn microphone_has_sound_again() -> Vec<Resolution> {
    [MICROPHONE_LOST_SOURCE, MICROPHONE_SILENT_SOURCE]
        .into_iter()
        .map(|source| Resolution {
            source: Some(source.into()),
            title: Some("Your microphone has sound again".into()),
            was: Some("It was silent".into()),
            ..Resolution::default()
        })
        .collect()
}

// --- The echo guard ---------------------------------------------------------

/// `system-audio-echo-paused`: the guard paused System audio because the
/// stream was echoing. Resume, and Sources at System audio. It belongs to
/// the session (`session_id`, else the current one) and ends with it.
pub fn system_audio_echo_paused(message: Option<&str>, session_id: Option<&str>) -> Input {
    Input {
        key: SYSTEM_AUDIO_ECHO_KEY.into(),
        kind: "system-audio-echo".into(),
        source: HEALTH_SOURCE.into(),
        title: "System audio paused: your stream was echoing".into(),
        detail: message.filter(|text| !text.is_empty()).map(str::to_string),
        actions: vec![
            action("resume", "Resume", ActionKind::Fix),
            action("open-sources", "Open Sources", ActionKind::Door),
        ],
        session_id: Some(session_id.unwrap_or(CURRENT_SESSION).to_string()),
        ..Input::default()
    }
}

// --- Buttons ----------------------------------------------------------------

/// Runs a device entry's button, as the store handed it back. False for a
/// key or a button that is not this source's.
pub fn run_action(
    key: &str,
    action_id: &str,
    transport: &mut dyn Transport,
    pages: &mut dyn HealthPage,
) -> bool {
    if let Some(source) = key.strip_prefix("source-return:") {
        if action_id != "use-it" {
            return false;
        }
        transport.use_returned_source(source);
        return true;
    }
    match (key, action_id) {
        (MICROPHONE_KEY, "open-audio") => pages.open(Door::Audio),
        (SYSTEM_AUDIO_ECHO_KEY, "resume") => transport.resume_system_audio(),
        (SYSTEM_AUDIO_ECHO_KEY, "open-sources") => pages.open(Door::SystemAudio),
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::toasts::{AudioIssue, MicrophonePhase, RuntimeActivity};
    use crate::notices::types::State;
    use crate::notices::{Effect, Store};

    fn shown(store: &mut Store) -> Vec<String> {
        store
            .take_effects()
            .into_iter()
            .filter_map(|effect| match effect {
                Effect::Show { entry, .. } => Some(entry.key),
                _ => None,
            })
            .collect()
    }

    fn lost(issues: &[&str]) -> MicrophoneNotice {
        MicrophoneNotice {
            audio_issues: issues
                .iter()
                .map(|code| AudioIssue {
                    code: (*code).into(),
                    message: String::new(),
                })
                .collect(),
            activity: RuntimeActivity::Recording,
            phase: MicrophonePhase::Active,
            message: "Videorc stopped hearing your microphone.".into(),
            session_id: Some("take-1".into()),
        }
    }

    /// Idle, a returned device is a bell entry: news, never a toast.
    #[test]
    fn a_device_that_came_back_waits_behind_the_bell() {
        let mut store = Store::new(0, 0);
        store.publish(source_return("camera:1", "FaceTime HD Camera"), 1_000);
        let entry = &store.snapshot()[0];
        assert_eq!(entry.title, "FaceTime HD Camera is back");
        assert_eq!(
            entry.detail.as_deref(),
            Some("This session is running without it.")
        );
        assert_eq!(entry.actions[0].id, "use-it");
        assert!(shown(&mut store).is_empty());
        assert_eq!(store.count().unread, 1);
        store.withdraw(&source_return_key("camera:1"), None, 2_000);
        assert!(store.snapshot().is_empty());
    }

    /// A lost microphone pops up while recording, and stays behind the bell
    /// when nothing runs.
    #[test]
    fn a_lost_microphone_pops_up_only_in_a_session() {
        let mut live = Store::new(0, 0);
        live.set_live(true);
        live.set_pressed();
        live.publish(
            microphone_loss(&lost(&["microphone-input-lost"])).unwrap(),
            1_000,
        );
        assert_eq!(shown(&mut live), ["microphone"]);
        let entry = &live.snapshot()[0];
        assert_eq!(entry.tone, Tone::Urgent);
        assert_eq!(entry.session_id.as_deref(), Some("take-1"));
        assert_eq!(entry.actions[0].label, OPEN_AUDIO_LABEL);

        for resolution in microphone_back() {
            live.resolve(MICROPHONE_KEY, resolution, 5_000);
        }
        let back = &live.snapshot()[0];
        assert_eq!(back.state, State::Resolved);
        assert_eq!(back.title, "Microphone is back");

        let mut idle = Store::new(0, 0);
        idle.publish(
            microphone_loss(&lost(&["microphone-input-lost"])).unwrap(),
            1_000,
        );
        assert!(shown(&mut idle).is_empty());
        assert_eq!(idle.count().unread, 1);
    }

    #[test]
    fn system_audio_alone_raises_nothing() {
        assert_eq!(microphone_loss(&lost(&["system-audio-lost"])), None);
        assert!(microphone_loss(&lost(&["system-audio-lost", "microphone-input-lost"])).is_some());
        assert_eq!(microphone_has_sound_again().len(), 2);
    }

    /// The echo guard's pause is a warning entry: idle, behind the bell.
    #[test]
    fn the_echo_guard_pause_is_an_entry_with_resume() {
        let mut store = Store::new(0, 0);
        store.publish(system_audio_echo_paused(None, None), 1_000);
        assert!(shown(&mut store).is_empty());
        let entry = &store.snapshot()[0];
        assert_eq!(entry.kind, "system-audio-echo");
        assert_eq!(entry.tone, Tone::Warning);
        assert_eq!(entry.session_id.as_deref(), Some(CURRENT_SESSION));
        assert_eq!(
            entry
                .actions
                .iter()
                .map(|action| action.id.as_str())
                .collect::<Vec<_>>(),
            ["resume", "open-sources"]
        );
    }

    #[derive(Default)]
    struct Studio {
        calls: Vec<String>,
    }

    impl Transport for Studio {
        fn reveal_session(&mut self, _: &str) {}
        fn retry_mp4_export(&mut self, _: &str) {}
        fn reveal_cloud_download(&mut self, _: &str) {}
        fn use_returned_source(&mut self, key: &str) {
            self.calls.push(format!("use {key}"));
        }
        fn resume_system_audio(&mut self) {
            self.calls.push("resume".into());
        }
    }

    impl HealthPage for Studio {
        fn open(&mut self, door: Door) {
            self.calls.push(format!("{door:?}"));
        }
    }

    #[test]
    fn a_pressed_button_reaches_the_studio() {
        let mut transport = Studio::default();
        let mut pages = Studio::default();
        assert!(run_action(
            "source-return:camera:1",
            "use-it",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            SYSTEM_AUDIO_ECHO_KEY,
            "resume",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            SYSTEM_AUDIO_ECHO_KEY,
            "open-sources",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            MICROPHONE_KEY,
            "open-audio",
            &mut transport,
            &mut pages
        ));
        assert!(!run_action(
            "source-return:camera:1",
            "resume",
            &mut transport,
            &mut pages
        ));
        assert!(!run_action("clips", "use-it", &mut transport, &mut pages));
        assert_eq!(transport.calls, ["use camera:1", "resume"]);
        assert_eq!(pages.calls, ["SystemAudio", "Audio"]);
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const APP: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/app.ts"
        );
        const KINDS: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/health-kinds.ts"
        );
        const DOORS: &str =
            include_str!("../../../../../apps/desktop/src/renderer/src/lib/section-doors.ts");
        assert!(APP.contains("title: `${deviceName} is back`"));
        assert!(APP.contains("detail: 'This session is running without it.'"));
        assert!(APP.contains("label: 'Use it'"));
        for words in [
            "MICROPHONE_LOST_SOURCE = 'health:lost'",
            "MICROPHONE_SILENT_SOURCE = 'health:silent'",
            "HEALTH_SOURCE = 'health'",
            "title: 'System audio paused: your stream was echoing'",
            "title: 'Microphone is back'",
            "title: 'Your microphone has sound again'",
            "was: 'It was silent'",
        ] {
            assert!(KINDS.contains(words), "health-kinds.ts lacks {words}");
        }
        assert!(DOORS.contains(&format!("OPEN_AUDIO_LABEL = '{OPEN_AUDIO_LABEL}'")));
    }
}
