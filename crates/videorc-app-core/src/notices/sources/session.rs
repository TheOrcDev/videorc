//! The session's own news (plan 250, Electron's `lib/session-runtime-
//! recovery.ts` since #1528): what the Studio says when a session ends, and
//! where each of its `health` events goes. Everything here is an entry; the
//! one toast left is a refused start, which answers Record or Go Live (plan
//! 250 D11), and S1.6a's toasts keep raising it.
//!
//! - [`session_finished`]: a lost microphone takes its ended words, the
//!   session's open problems end with it, and a take that saved a file is
//!   "Recording saved" with Play and Open in Library (D13: behind the bell,
//!   and briefly up while idle, because the streamer just pressed Stop).
//! - [`route_session_health_event`]: one `health` event of the running
//!   session, to the Clips ring, the toast, the quality notice or the table.
//! - [`noise_cleanup_completed`] and [`source_fallback`]: two finished things.
//! - [`session_press`]: what each of these entries' buttons asks the app to
//!   do (play or reveal a take, open it in the Library, open Sources).
//!
//! # The switch from S1.6a's toasts
//!
//! `SessionNotices` keeps microphone snapshot state and the refused-start /
//! Error barrier-timeout toast. The ended mic entry, "Recording saved",
//! separate-file warnings, destination transitions and the rest of the
//! health table are store entries from this module, `super::devices`,
//! `super::health` and `super::stream_targets` (#1859, #1865, #1869).

use videorc_protocol::{HealthEvent, HealthLevel};

use super::devices::{CURRENT_SESSION, microphone_loss};
use super::health::{
    HealthContext, publish_health_event, recording_quality, session_ended_notifications,
};
use super::reveal_label;
use super::work::clips_could_not_start;
use crate::notices::Store;
use crate::notices::toasts::{
    MicrophoneNotice, MicrophonePhase, Notice, NoticeKind, RuntimeActivity,
    recording_startup_health_toast,
};
use crate::notices::types::{Action, ActionKind, Input};

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

/// `recording-saved:{session}`.
pub fn recording_saved_key(session_id: Option<&str>) -> String {
    format!("recording-saved:{}", session_id.unwrap_or(CURRENT_SESSION))
}

/// The "Recording saved" entry: Play and Open in Library, once.
pub fn recording_saved(session_id: Option<&str>) -> Input {
    Input {
        key: recording_saved_key(session_id),
        kind: "recording-saved".into(),
        title: "Recording saved".into(),
        actions: vec![
            action("play", "Play", ActionKind::Fix),
            action("open-library", "Open in Library", ActionKind::Door),
        ],
        once: true,
        ..Input::default()
    }
}

/// `showSessionFinished`. `current_notice` is the session's microphone
/// notice, if one is up; its ended form is handed back for the Studio to
/// keep (`replaceNotice`).
pub fn session_finished(
    store: &mut Store,
    activity: RuntimeActivity,
    session_id: Option<&str>,
    current_notice: Option<&MicrophoneNotice>,
    now: u64,
) -> Option<MicrophoneNotice> {
    let mut ended = None;
    if let Some(notice) = current_notice
        && notice.phase != MicrophonePhase::Ended
    {
        let mut done = notice.clone();
        done.phase = MicrophonePhase::Ended;
        // The entry takes the ended words ("Microphone was silent during
        // the livestream") before it ends with the session.
        if let Some(input) = microphone_loss(&done) {
            store.publish(input, now);
        }
        ended = Some(done);
    }
    // Plan 218, plan 250: the session's open problems end with it.
    session_ended_notifications(store, activity.is_live(), now);
    if activity.saves_recording() {
        store.publish(recording_saved(session_id), now);
    }
    ended
}

/// The running session, as the routing needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunningSession {
    pub session_id: Option<String>,
    /// `RecordingStatus.state`.
    pub state: Option<String>,
    /// The Clips ring alone (`sessionIsReplayOnly`).
    pub replay_only: bool,
}

/// Where one `health` event went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionHealthOutcome {
    /// A refused start: the one toast left, for the app's toaster.
    Toast(Notice),
    /// The quality notice was shown; the caller remembers it, to show it once.
    QualityShown(String),
    /// An entry (or nothing, for a code nobody reports).
    Listed,
}

/// `showSessionHealthEvent`.
pub fn route_session_health_event(
    store: &mut Store,
    event: &HealthEvent,
    quality_already_shown: bool,
    running: Option<&RunningSession>,
    now: u64,
) -> SessionHealthOutcome {
    if let Some(startup) = recording_startup_health_toast(event)
        && startup.kind == NoticeKind::Error
    {
        if running.is_some_and(|session| session.replay_only) {
            // The Clips ring starts on its own at launch: nobody pressed
            // Record, so "Couldn't start" is the ring's entry, never a toast.
            let reason = startup.description.as_deref().unwrap_or(&startup.title);
            store.publish(clips_could_not_start(reason), now);
            return SessionHealthOutcome::Listed;
        }
        return SessionHealthOutcome::Toast(startup);
    }
    if event.code.starts_with("recording-quality-") {
        if event.code != "recording-quality-not-100"
            || !matches!(event.level, HealthLevel::Warn)
            || quality_already_shown
        {
            return SessionHealthOutcome::Listed;
        }
        store.publish(recording_quality(event), now);
        return SessionHealthOutcome::QualityShown(
            event
                .session_id
                .clone()
                .unwrap_or_else(|| event.message.clone()),
        );
    }
    let context = HealthContext {
        session_id: running.and_then(|session| session.session_id.clone()),
        state: Some(
            running
                .and_then(|session| session.state.clone())
                .unwrap_or_else(|| "idle".into()),
        ),
    };
    publish_health_event(store, event, &context, now);
    SessionHealthOutcome::Listed
}

/// `showNoiseCleanupCompleted`: a separate cleaned copy, with Play and the
/// reveal of the cleaned take (`outputSessionId`), which the buttons carry.
pub fn noise_cleanup_completed(job_id: &str, output_session_id: &str) -> Input {
    Input {
        key: format!("noise-cleanup:{job_id}"),
        kind: "work-done".into(),
        title: "Noise cleanup complete".into(),
        detail: Some("A separate cleaned copy is ready. The original wasn't changed.".into()),
        actions: vec![
            action(
                &format!("play:{output_session_id}"),
                "Play",
                ActionKind::Fix,
            ),
            action(
                &format!("reveal:{output_session_id}"),
                reveal_label(),
                ActionKind::Fix,
            ),
        ],
        once: true,
        ..Input::default()
    }
}

/// What the automatic source switch did (`AutomaticSourceFallbackEvent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceFallback<'a> {
    /// `capture`, `camera` or `microphone`.
    pub source_kind: &'a str,
    pub next_name: Option<&'a str>,
    pub next_id: Option<&'a str>,
}

/// `sourceFallbackTitle`: "Camera switched to FaceTime HD Camera", or
/// "Camera turned off".
pub fn source_fallback_title(event: Option<&SourceFallback<'_>>) -> String {
    let Some(event) = event else {
        return "A source changed".into();
    };
    let noun = match event.source_kind {
        "capture" => "Screen",
        "camera" => "Camera",
        "microphone" => "Microphone",
        _ => "A source",
    };
    match event
        .next_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(name) => format!("{noun} switched to {name}"),
        None if event.next_id.is_some() => format!("{noun} switched"),
        None => format!("{noun} turned off"),
    }
}

/// `showSourceFallbackActiveSession`, with Open Sources.
pub fn source_fallback(live: bool, event: Option<&SourceFallback<'_>>) -> Input {
    Input {
        key: format!(
            "source-fallback:{}",
            event.map_or("source", |event| event.source_kind)
        ),
        kind: "source-fallback".into(),
        title: source_fallback_title(event),
        detail: Some(if live {
            "Your stream uses it now. Check the output before you continue.".into()
        } else {
            "Your recording uses it now. Check the output before you continue.".into()
        }),
        actions: vec![action("open-sources", "Open Sources", ActionKind::Door)],
        ..Input::default()
    }
}

/// What a pressed session button asks the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionPress {
    /// `openSession(id)`: the take plays (the Library's player, or its
    /// problem as Electron's `showPlaybackProblem`).
    Play { session_id: String },
    /// `openLibrary(sessionId)`: the take in the Library, or the Library tab.
    OpenLibrary { session_id: Option<String> },
    /// `revealSession(id)`.
    Reveal { session_id: String },
    /// The Sources page (the automatic source switch).
    OpenSources,
}

/// The press for an entry's button; `None` when it is not this source's.
pub fn session_press(key: &str, action_id: &str) -> Option<SessionPress> {
    if let Some(take) = key.strip_prefix("recording-saved:") {
        let session_id = (take != CURRENT_SESSION).then(|| take.to_string());
        return match action_id {
            // Electron opens the Library when the take has no id.
            "play" => Some(match session_id {
                Some(session_id) => SessionPress::Play { session_id },
                None => SessionPress::OpenLibrary { session_id: None },
            }),
            "open-library" => Some(SessionPress::OpenLibrary { session_id }),
            _ => None,
        };
    }
    if key.starts_with("noise-cleanup:") {
        if let Some(session_id) = action_id.strip_prefix("play:") {
            return Some(SessionPress::Play {
                session_id: session_id.to_string(),
            });
        }
        return action_id
            .strip_prefix("reveal:")
            .map(|session_id| SessionPress::Reveal {
                session_id: session_id.to_string(),
            });
    }
    (key.starts_with("source-fallback:") && action_id == "open-sources")
        .then_some(SessionPress::OpenSources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::Effect;
    use crate::notices::toasts::AudioIssue;
    use crate::notices::types::State;

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

    #[test]
    fn stop_says_recording_saved_and_ends_the_open_problems() {
        let mut store = Store::new(0, 0);
        store.set_pressed();
        let lost = MicrophoneNotice {
            audio_issues: vec![AudioIssue {
                code: "microphone-input-lost".into(),
                message: String::new(),
            }],
            activity: RuntimeActivity::Recording,
            phase: MicrophonePhase::Active,
            message: "Videorc stopped hearing your microphone.".into(),
            session_id: Some("take-1".into()),
        };
        store.publish(microphone_loss(&lost).unwrap(), 1_000);
        let ended = session_finished(
            &mut store,
            RuntimeActivity::Recording,
            Some("take-1"),
            Some(&lost),
            5_000,
        );
        assert_eq!(
            ended.map(|notice| notice.phase),
            Some(MicrophonePhase::Ended)
        );
        let saved = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == "recording-saved:take-1")
            .unwrap();
        assert_eq!(saved.actions[0].id, "play");
        let microphone = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == "microphone")
            .unwrap();
        assert_ne!(microphone.state, State::Open);
        // "Recording saved" answers Stop: it pops up briefly while idle.
        assert!(shown(&mut store).contains(&"recording-saved:take-1".to_string()));

        // A livestream alone saves no file.
        let mut live = Store::new(0, 0);
        session_finished(&mut live, RuntimeActivity::LiveStream, None, None, 1_000);
        assert!(live.snapshot().is_empty());
    }

    fn health(code: &str, level: HealthLevel) -> HealthEvent {
        HealthEvent {
            id: "1".into(),
            session_id: Some("take-1".into()),
            level,
            code: code.into(),
            message: "The backend's line.".into(),
            permission_pane: None,
            created_at: "a".into(),
        }
    }

    #[test]
    fn the_quality_notice_is_said_once_and_the_rest_goes_to_the_table() {
        let mut store = Store::new(0, 0);
        let outcome = route_session_health_event(
            &mut store,
            &health("recording-quality-not-100", HealthLevel::Warn),
            false,
            None,
            1_000,
        );
        assert_eq!(outcome, SessionHealthOutcome::QualityShown("take-1".into()));
        assert_eq!(
            route_session_health_event(
                &mut store,
                &health("recording-quality-not-100", HealthLevel::Warn),
                true,
                None,
                2_000
            ),
            SessionHealthOutcome::Listed
        );
        assert_eq!(store.snapshot().len(), 1);
        route_session_health_event(
            &mut store,
            &health("host-overloaded", HealthLevel::Warn),
            false,
            None,
            3_000,
        );
        assert!(
            store
                .snapshot()
                .iter()
                .any(|entry| entry.key == "host-overloaded")
        );
    }

    #[test]
    fn finished_things_and_the_source_switch() {
        let cleaned = noise_cleanup_completed("j1", "take-9");
        assert_eq!(cleaned.actions[1].label, reveal_label());
        assert_eq!(
            session_press(&cleaned.key, &cleaned.actions[0].id),
            Some(SessionPress::Play {
                session_id: "take-9".into()
            })
        );
        assert_eq!(
            session_press(&cleaned.key, &cleaned.actions[1].id),
            Some(SessionPress::Reveal {
                session_id: "take-9".into()
            })
        );
        let saved = recording_saved(Some("take-1"));
        assert_eq!(
            session_press(&saved.key, "play"),
            Some(SessionPress::Play {
                session_id: "take-1".into()
            })
        );
        assert_eq!(
            session_press(&saved.key, "open-library"),
            Some(SessionPress::OpenLibrary {
                session_id: Some("take-1".into())
            })
        );
        assert_eq!(
            session_press(&recording_saved(None).key, "play"),
            Some(SessionPress::OpenLibrary { session_id: None })
        );
        assert_eq!(
            session_press("source-fallback:camera", "open-sources"),
            Some(SessionPress::OpenSources)
        );
        assert_eq!(session_press("clips", "play"), None);
        let camera = SourceFallback {
            source_kind: "camera",
            next_name: Some(" FaceTime HD Camera "),
            next_id: Some("cam-2"),
        };
        assert_eq!(
            source_fallback_title(Some(&camera)),
            "Camera switched to FaceTime HD Camera"
        );
        let off = SourceFallback {
            source_kind: "microphone",
            next_name: None,
            next_id: None,
        };
        assert_eq!(source_fallback_title(Some(&off)), "Microphone turned off");
        assert_eq!(source_fallback_title(None), "A source changed");
        let input = source_fallback(true, Some(&camera));
        assert_eq!(input.key, "source-fallback:camera");
        assert_eq!(
            input.detail.as_deref(),
            Some("Your stream uses it now. Check the output before you continue.")
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const RECOVERY: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/session-runtime-recovery.ts"
        );
        for words in [
            "title: 'Recording saved'",
            "{ id: 'play', label: 'Play', kind: 'fix', run: openFinishedRecording }",
            "title: 'Noise cleanup complete'",
            "detail: \"A separate cleaned copy is ready. The original wasn't changed.\"",
            "if (!event) return 'A source changed'",
            "capture: 'Screen'",
            "`${noun} switched to ${name}`",
            "`${noun} switched`",
            "`${noun} turned off`",
            "'Your stream uses it now. Check the output before you continue.'",
            "'Your recording uses it now. Check the output before you continue.'",
        ] {
            assert!(
                RECOVERY.contains(words),
                "session-runtime-recovery.ts lacks {words}"
            );
        }
    }
}
