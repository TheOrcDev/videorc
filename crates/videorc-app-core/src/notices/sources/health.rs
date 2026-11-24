//! The session's `health` events as notifications (plan 250 S5, Electron's
//! `sources/health.ts`). [`super::super::health_kinds`] says what each code
//! does; this builds the entry (its words, its door, the session it ends
//! with) and hands it to the store. It raises no toast: the store's pop-up
//! rule decides, and only an urgent entry in a session the streamer started
//! pops up.
//!
//! The quality notice, the lost microphone (`super::devices`) and the take's
//! failure keep their own functions, as in Electron.

use std::collections::HashMap;

use videorc_protocol::{HealthEvent, HealthLevel};

use super::devices::{CURRENT_SESSION, OPEN_AUDIO_LABEL, SYSTEM_AUDIO_ECHO_KEY};
use super::{Door, HealthPage, OPEN_HEALTH_LABEL, Transport};
use crate::notices::Store;
use crate::notices::health_kinds::{HEALTH_SOURCE, HealthDoor, HealthRow, health_kind_for};
use crate::notices::toasts::{
    NoticeKind, recording_startup_health_toast, separate_file_failed_copy, separate_file_role,
};
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// `SEPARATE_FILES_SHED_WORDS`.
pub const SEPARATE_FILES_SHED_TITLE: &str = "Separate files stopped so the main recording keeps up";
pub const SEPARATE_FILES_SHED_DESCRIPTION: &str = "Your Mac fell behind encoding the separate files. The separate files keep what they recorded, and your Combined recording keeps going.";
/// `DISK_FULL_WORDS`.
pub const DISK_FULL_TITLE: &str = "Recording stopped: the recordings folder is full";
pub const DISK_FULL_DESCRIPTION: &str =
    "The recording up to that point is kept. Free some space before you record again.";

/// `HealthNotificationContext`: the session the Studio is running, or last
/// ran.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HealthContext {
    pub session_id: Option<String>,
    /// `RecordingStatus.state` (`recording`, `streaming` …).
    pub state: Option<String>,
}

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

/// `door`: the button that opens the page.
fn door(to: HealthDoor) -> Action {
    match to {
        HealthDoor::Health => action("open-health", OPEN_HEALTH_LABEL, ActionKind::Door),
        HealthDoor::Audio => action("open-audio", OPEN_AUDIO_LABEL, ActionKind::Door),
        HealthDoor::Sources | HealthDoor::SystemAudio => {
            action("open-sources", "Open Sources", ActionKind::Door)
        }
        HealthDoor::Output => action("open-output", "Open Output", ActionKind::Door),
    }
}

fn open_permissions() -> Action {
    action("open-permissions", "Open Permissions", ActionKind::Door)
}

fn open_in_library() -> Action {
    action("open-library", "Open in Library", ActionKind::Door)
}

fn session_of(event: &HealthEvent, context: &HealthContext) -> String {
    event
        .session_id
        .clone()
        .or_else(|| context.session_id.clone())
        .unwrap_or_else(|| CURRENT_SESSION.to_string())
}

/// `isDiskFullMessage`.
pub fn is_disk_full_message(message: Option<&str>) -> bool {
    message.is_some_and(|text| text.contains("ran out of space"))
}

/// `publishDiskFull`: the take that died on a full disk, on the failed
/// recording's entry.
pub fn disk_full(session_id: Option<&str>) -> Input {
    Input {
        key: format!("recording-failed:{}", session_id.unwrap_or(CURRENT_SESSION)),
        kind: "recording-failed".into(),
        title: DISK_FULL_TITLE.into(),
        detail: Some(DISK_FULL_DESCRIPTION.into()),
        actions: vec![door(HealthDoor::Output), open_in_library()],
        once: true,
        ..Input::default()
    }
}

/// `publishHealthEvent`: one `health` event into the store. False for a code
/// with no row, a silent one, and one that needs its own function.
pub fn publish_health_event(
    store: &mut Store,
    event: &HealthEvent,
    context: &HealthContext,
    now: u64,
) -> bool {
    let Some(row) = health_kind_for(&event.code) else {
        return false;
    };
    let session_id = session_of(event, context);
    match row {
        HealthRow::Ignore { .. } => false,
        HealthRow::Open {
            key,
            kind,
            source,
            title,
            error_title,
            urgent_on_error,
            door: row_door,
        } => {
            let urgent = urgent_on_error && matches!(event.level, HealthLevel::Error);
            let actions = if key == SYSTEM_AUDIO_ECHO_KEY {
                vec![
                    action("resume", "Resume", ActionKind::Fix),
                    door(HealthDoor::SystemAudio),
                ]
            } else if key == "screen-capture" && event.permission_pane.is_some() {
                // Screen capture that stopped for want of access opens
                // Permissions.
                vec![open_permissions()]
            } else {
                row_door.map(door).into_iter().collect()
            };
            store.publish(
                Input {
                    key: key.into(),
                    kind: kind.into(),
                    source: source.unwrap_or(HEALTH_SOURCE).into(),
                    tone: urgent.then_some(Tone::Urgent),
                    title: match (urgent, error_title) {
                        (true, Some(words)) => words.into(),
                        _ => title.into(),
                    },
                    detail: words(&event.message),
                    actions,
                    session_id: Some(session_id),
                    ..Input::default()
                },
                now,
            );
            true
        }
        HealthRow::Resolve {
            key,
            sources,
            title,
            was,
        } => {
            let sources: &[&str] = if sources.is_empty() {
                &[HEALTH_SOURCE]
            } else {
                sources
            };
            for source in sources {
                store.resolve(
                    key,
                    Resolution {
                        source: Some((*source).into()),
                        title: Some(title.into()),
                        was: was.map(str::to_string),
                        ..Resolution::default()
                    },
                    now,
                );
            }
            true
        }
        HealthRow::Event {
            key,
            kind,
            title,
            detail,
            door: row_door,
        } => {
            store.publish(
                Input {
                    key: key.into(),
                    kind: kind.into(),
                    title: title.into(),
                    detail: detail.map(str::to_string).or_else(|| words(&event.message)),
                    actions: row_door.map(door).into_iter().collect(),
                    ..Input::default()
                },
                now,
            );
            true
        }
        HealthRow::Custom => publish_custom(store, event, context, session_id, now),
    }
}

/// The codes that need more than their row.
fn publish_custom(
    store: &mut Store,
    event: &HealthEvent,
    context: &HealthContext,
    session_id: String,
    now: u64,
) -> bool {
    match event.code.as_str() {
        "recording-disk-full" => {
            let session = event
                .session_id
                .as_deref()
                .or(context.session_id.as_deref());
            store.publish(disk_full(session), now);
            true
        }
        "separate-source-recordings-role-failed" => {
            let take_running = context.session_id == event.session_id
                && matches!(context.state.as_deref(), Some("recording" | "streaming"));
            let (title, description) = separate_file_failed_copy(&event.message, take_running);
            let role = separate_file_role(&event.message).unwrap_or("file");
            store.publish(
                Input {
                    key: format!(
                        "separate-file:{}:{role}",
                        event.session_id.as_deref().unwrap_or("take")
                    ),
                    kind: "separate-file".into(),
                    title,
                    detail: Some(description),
                    actions: vec![door(HealthDoor::Health)],
                    once: true,
                    ..Input::default()
                },
                now,
            );
            true
        }
        "separate-source-recordings-shed" => {
            store.publish(
                Input {
                    key: format!(
                        "separate-files-shed:{}",
                        event.session_id.as_deref().unwrap_or("take")
                    ),
                    kind: "separate-file".into(),
                    title: SEPARATE_FILES_SHED_TITLE.into(),
                    detail: Some(SEPARATE_FILES_SHED_DESCRIPTION.into()),
                    actions: vec![door(HealthDoor::Health)],
                    once: true,
                    ..Input::default()
                },
                now,
            );
            true
        }
        _ => {
            // What the session said at its start, and holds true until it
            // ends.
            match recording_startup_health_toast(event) {
                Some(startup) if startup.kind == NoticeKind::Warning => {
                    store.publish(
                        Input {
                            key: format!("session-notice:{}", event.code),
                            kind: "session-notice".into(),
                            title: startup.title,
                            detail: startup.description,
                            session_id: Some(session_id),
                            ..Input::default()
                        },
                        now,
                    );
                    true
                }
                _ => false,
            }
        }
    }
}

fn words(message: &str) -> Option<String> {
    (!message.is_empty()).then(|| message.to_string())
}

/// `lastHealthWords` (plan 250 S9): the last word on each subject from a
/// session's stored events. A `health` event is sent once, so a window that
/// reconnects mid-session missed what opened and cleared meanwhile. Only
/// conditions are read; things that happened once are not replayed.
pub fn last_health_words(events: &[HealthEvent]) -> Vec<&HealthEvent> {
    let mut ordered: Vec<&HealthEvent> = events.iter().collect();
    // RFC 3339 times from one backend sort as text, then by id.
    ordered.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    let mut last: HashMap<String, &str> = HashMap::new();
    for event in ordered.iter().copied() {
        match health_kind_for(&event.code) {
            Some(HealthRow::Open { key, source, .. }) => {
                last.insert(
                    format!("{key}\n{}", source.unwrap_or(HEALTH_SOURCE)),
                    &event.id,
                );
            }
            Some(HealthRow::Resolve { key, sources, .. }) => {
                let sources: &[&str] = if sources.is_empty() {
                    &[HEALTH_SOURCE]
                } else {
                    sources
                };
                for source in sources {
                    last.insert(format!("{key}\n{source}"), &event.id);
                }
            }
            _ => {
                if recording_startup_health_toast(event)
                    .is_some_and(|startup| startup.kind == NoticeKind::Warning)
                {
                    last.insert(
                        format!("session-notice:{}\n{HEALTH_SOURCE}", event.code),
                        &event.id,
                    );
                }
            }
        }
    }
    ordered
        .into_iter()
        .filter(|event| last.values().any(|id| *id == event.id))
        .collect()
}

/// `rebuildHealthNotifications`: the session's open conditions rebuilt in
/// the list from its stored events.
pub fn rebuild_health_notifications(
    store: &mut Store,
    events: &[HealthEvent],
    context: &HealthContext,
    now: u64,
) {
    for event in last_health_words(events) {
        publish_health_event(store, event, context, now);
    }
}

/// Runs a health entry's button, as the store handed it back: its door, or
/// the failed take's reveal. False for another source's entry (work's Clips,
/// the echo guard, a device that came back) or another button.
pub fn run_action(
    key: &str,
    action_id: &str,
    transport: &mut dyn Transport,
    pages: &mut dyn HealthPage,
) -> bool {
    // Other sources' entries use the same ids for other pages: work's Clips
    // (`open-output` is Output → Clips), the echo guard (`open-sources` is
    // System audio) and a device that came back.
    if key == SYSTEM_AUDIO_ECHO_KEY
        || key == super::work::CLIPS_KEY
        || key.starts_with("source-return:")
    {
        return false;
    }
    // `recording-failed:{take}`, `recording-quality:{take}`: the take, unless
    // the report named none.
    let session = key
        .split_once(':')
        .map(|(_, id)| id)
        .filter(|id| !id.is_empty() && *id != CURRENT_SESSION);
    let door = match action_id {
        "open-health" => Door::Health,
        "open-audio" => Door::Audio,
        "open-sources" => Door::Sources,
        "open-output" => Door::OutputRecordings,
        "open-permissions" => Door::Permissions,
        // `openInLibrary(sessionId)`: the take, or the Library tab.
        "open-library" => Door::Library {
            session_id: session.map(str::to_string),
        },
        // The failed take's file in Finder or Explorer.
        "reveal" if key.starts_with("recording-failed:") => {
            let Some(session) = session else {
                return false;
            };
            transport.reveal_session(session);
            return true;
        }
        _ => return false,
    };
    pages.open(door);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::Effect;
    use crate::notices::types::State;

    fn health(id: &str, code: &str, level: HealthLevel, at: &str) -> HealthEvent {
        HealthEvent {
            id: id.into(),
            session_id: Some("take-1".into()),
            level,
            code: code.into(),
            message: "The backend's line.".into(),
            permission_pane: None,
            created_at: at.into(),
        }
    }

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
    fn a_condition_opens_then_resolves_with_how_it_was() {
        let mut store = Store::new(0, 0);
        let context = HealthContext::default();
        assert!(publish_health_event(
            &mut store,
            &health("1", "stream-delivery-degraded", HealthLevel::Warn, "a"),
            &context,
            1_000
        ));
        let open = &store.snapshot()[0];
        assert_eq!(open.title, "Your stream is choppy");
        assert_eq!(open.session_id.as_deref(), Some("take-1"));
        assert_eq!(open.actions[0].label, OPEN_HEALTH_LABEL);
        // Idle, it waits behind the bell.
        assert!(shown(&mut store).is_empty());
        assert!(publish_health_event(
            &mut store,
            &health("2", "stream-delivery-recovered", HealthLevel::Info, "b"),
            &context,
            39_000
        ));
        let back = &store.snapshot()[0];
        assert_eq!(back.state, State::Resolved);
        assert_eq!(back.title, "Your stream is smooth again");
    }

    #[test]
    fn an_error_level_makes_an_urgent_row_urgent_with_its_error_words() {
        let mut store = Store::new(0, 0);
        store.set_live(true);
        store.set_pressed();
        publish_health_event(
            &mut store,
            &health("1", "mic-silent", HealthLevel::Error, "a"),
            &HealthContext::default(),
            1_000,
        );
        let entry = &store.snapshot()[0];
        assert_eq!(entry.tone, Tone::Urgent);
        assert_eq!(entry.title, "Recording has no sound");
        assert_eq!(shown(&mut store), ["microphone"]);
        let mut calm = Store::new(0, 0);
        publish_health_event(
            &mut calm,
            &health("1", "mic-silent", HealthLevel::Warn, "a"),
            &HealthContext::default(),
            1_000,
        );
        assert_eq!(calm.snapshot()[0].title, "Microphone is silent");
    }

    #[test]
    fn screen_capture_without_access_opens_permissions_and_the_echo_offers_resume() {
        let mut store = Store::new(0, 0);
        let mut stopped = health("1", "screen-capture-stopped", HealthLevel::Warn, "a");
        stopped.permission_pane = Some(videorc_protocol::PermissionPane::ScreenRecording);
        publish_health_event(&mut store, &stopped, &HealthContext::default(), 1_000);
        assert_eq!(store.snapshot()[0].actions[0].id, "open-permissions");
        publish_health_event(
            &mut store,
            &health("2", "system-audio-echo-paused", HealthLevel::Warn, "b"),
            &HealthContext::default(),
            1_000,
        );
        let echo = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == SYSTEM_AUDIO_ECHO_KEY)
            .unwrap();
        assert_eq!(echo.actions[0].id, "resume");
        assert_eq!(echo.actions[1].id, "open-sources");
    }

    #[test]
    fn silent_unknown_and_watchdog_codes_raise_nothing() {
        let mut store = Store::new(0, 0);
        let context = HealthContext::default();
        for code in [
            "stream-dropped-frames",
            "nope",
            "watchdog-stream-health-cleared",
        ] {
            assert!(!publish_health_event(
                &mut store,
                &health("1", code, HealthLevel::Warn, "a"),
                &context,
                1_000
            ));
        }
        assert!(store.snapshot().is_empty());
    }

    #[derive(Default)]
    struct Studio {
        calls: Vec<String>,
    }

    impl Transport for Studio {
        fn reveal_session(&mut self, session_id: &str) {
            self.calls.push(format!("reveal {session_id}"));
        }
        fn retry_mp4_export(&mut self, _: &str) {}
        fn reveal_cloud_download(&mut self, _: &str) {}
        fn use_returned_source(&mut self, _: &str) {}
        fn resume_system_audio(&mut self) {}
    }

    impl HealthPage for Studio {
        fn open(&mut self, door: Door) {
            self.calls.push(format!("{door:?}"));
        }
    }

    #[test]
    fn the_library_and_the_reveal_reach_the_take_and_other_keys_are_refused() {
        let mut transport = Studio::default();
        let mut pages = Studio::default();
        assert!(run_action(
            "recording-failed:take-1",
            "open-library",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            "recording-failed:take-1",
            "reveal",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            "recording-quality:session",
            "open-library",
            &mut transport,
            &mut pages
        ));
        assert!(!run_action(
            "recording-failed:session",
            "reveal",
            &mut transport,
            &mut pages
        ));
        // Work's Clips and the echo guard keep their own pages.
        assert!(!run_action(
            "clips",
            "open-output",
            &mut transport,
            &mut pages
        ));
        assert!(!run_action(
            SYSTEM_AUDIO_ECHO_KEY,
            "open-sources",
            &mut transport,
            &mut pages
        ));
        assert!(run_action(
            "screen-capture",
            "open-sources",
            &mut transport,
            &mut pages
        ));
        assert_eq!(transport.calls, ["reveal take-1"]);
        assert_eq!(
            pages.calls,
            [
                "Library { session_id: Some(\"take-1\") }",
                "Library { session_id: None }",
                "Sources"
            ]
        );
    }

    #[test]
    fn a_full_disk_lands_on_the_failed_recording() {
        let mut store = Store::new(0, 0);
        publish_health_event(
            &mut store,
            &health("1", "recording-disk-full", HealthLevel::Error, "a"),
            &HealthContext::default(),
            1_000,
        );
        let entry = &store.snapshot()[0];
        assert_eq!(entry.key, "recording-failed:take-1");
        assert_eq!(entry.title, DISK_FULL_TITLE);
        assert!(is_disk_full_message(Some("The disk ran out of space.")));
        assert!(!is_disk_full_message(None));
    }

    #[test]
    fn the_last_words_replay_only_what_is_still_true() {
        let events = vec![
            health(
                "1",
                "stream-delivery-degraded",
                HealthLevel::Warn,
                "2026-11-24T10:00:00Z",
            ),
            health(
                "2",
                "host-overloaded",
                HealthLevel::Warn,
                "2026-11-24T10:00:01Z",
            ),
            health(
                "3",
                "stream-delivery-recovered",
                HealthLevel::Info,
                "2026-11-24T10:00:02Z",
            ),
            health(
                "4",
                "audio-output-stalled",
                HealthLevel::Warn,
                "2026-11-24T10:00:03Z",
            ),
        ];
        let ids: Vec<&str> = last_health_words(&events)
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        // The overload is still open; the choppy stream cleared (its resolve
        // is the last word); a blip is never replayed.
        assert_eq!(ids, ["2", "3"]);
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const HEALTH: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/health.ts"
        );
        for words in [
            SEPARATE_FILES_SHED_TITLE,
            SEPARATE_FILES_SHED_DESCRIPTION,
            DISK_FULL_TITLE,
            DISK_FULL_DESCRIPTION,
            "label: 'Open Permissions'",
            "label: 'Open in Library'",
            "label: 'Open Sources'",
            "label: 'Open Output'",
            "export const CURRENT_SESSION = 'session'",
            "/ran out of space/",
        ] {
            assert!(HEALTH.contains(words), "health.ts lacks {words}");
        }
    }
}
