//! Devices and the app's own state as notifications (plan 250 S7,
//! Electron's `sources/app.ts`): Videorc Camera, global shortcuts, the
//! engine's lifecycle, what failed on its own, live captions, Sidekick, and
//! the small things Videorc does on its own. A device that came back is
//! `super::devices`'.
//!
//! Where Electron runs a closure on a button, [`app_press`] says what the
//! press asks for, and the app does it.

use super::OPEN_HEALTH_LABEL;
use crate::notices::Store;
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// `VIDEORC_CAMERA_KEY`.
pub const VIDEORC_CAMERA_KEY: &str = "videorc-camera";
/// `GLOBAL_SHORTCUTS_KEY`.
pub const GLOBAL_SHORTCUTS_KEY: &str = "global-shortcuts";
/// `BACKEND_KEY`.
pub const BACKEND_KEY: &str = "backend";
/// `BACKEND_ERROR_KEY` and its title.
pub const BACKEND_ERROR_KEY: &str = "backend-error";
pub const BACKEND_ERROR_TITLE: &str = "Videorc hit a problem";
/// `CAPTIONS_KEY`.
pub const CAPTIONS_KEY: &str = "captions";
/// `OUTPUT_TOO_HEAVY_KEY`.
pub const OUTPUT_TOO_HEAVY_KEY: &str = "output-too-heavy";
/// The Sidekick entry's key.
pub const SIDEKICK_KEY: &str = "sidekick";

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

fn open_health() -> Action {
    action("open-health", OPEN_HEALTH_LABEL, ActionKind::Door)
}

// --- Videorc Camera ---------------------------------------------------------

/// `publishVideorcCameraStopped`, with Open Output.
pub fn videorc_camera_stopped(title: &str, description: &str) -> Input {
    Input {
        key: VIDEORC_CAMERA_KEY.into(),
        kind: "videorc-camera".into(),
        title: title.into(),
        detail: Some(description.into()),
        actions: vec![action("open-output", "Open Output", ActionKind::Door)],
        ..Input::default()
    }
}

/// `resolveVideorcCamera`: pass to `Store::resolve(VIDEORC_CAMERA_KEY, …)`.
pub fn videorc_camera_back() -> Resolution {
    Resolution {
        title: Some("Videorc Camera is back".into()),
        was: Some("It was stopped".into()),
        ..Resolution::default()
    }
}

// --- Global shortcuts -------------------------------------------------------

/// `publishGlobalShortcutsProblem`, with Open Shortcuts.
pub fn global_shortcuts_problem(title: &str, description: &str) -> Input {
    Input {
        key: GLOBAL_SHORTCUTS_KEY.into(),
        kind: "global-shortcuts".into(),
        title: title.into(),
        detail: Some(description.into()),
        actions: vec![action("open-shortcuts", "Open Shortcuts", ActionKind::Door)],
        ..Input::default()
    }
}

/// `resolveGlobalShortcuts`. (`withdrawGlobalShortcuts` is
/// `Store::withdraw(GLOBAL_SHORTCUTS_KEY, None, now)`: no key is set any
/// more, so the problem went without a fix.)
pub fn global_shortcuts_registered() -> Resolution {
    Resolution {
        title: Some("Global shortcuts registered".into()),
        ..Resolution::default()
    }
}

// --- The engine -------------------------------------------------------------

/// `BackendLifecycleEvent.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendLifecycle {
    Running,
    Restarting { attempt: Option<u32> },
    Failed,
    Lost,
}

/// `publishBackendLifecycle` (F-014): a backend crash is said, never a
/// zombie with a Ready badge.
pub fn publish_backend_lifecycle(store: &mut Store, state: BackendLifecycle, now: u64) {
    match state {
        BackendLifecycle::Running => store.resolve(
            BACKEND_KEY,
            Resolution {
                title: Some("Videorc recovered".into()),
                was: Some("It was restarting".into()),
                ..Resolution::default()
            },
            now,
        ),
        BackendLifecycle::Restarting { attempt } => store.publish(
            Input {
                key: BACKEND_KEY.into(),
                kind: "backend".into(),
                title: "Videorc is recovering".into(),
                detail: Some(format!(
                    "Restarting automatically (attempt {})…",
                    attempt.unwrap_or(1)
                )),
                ..Input::default()
            },
            now,
        ),
        BackendLifecycle::Failed | BackendLifecycle::Lost => store.publish(
            Input {
                key: BACKEND_KEY.into(),
                kind: "backend".into(),
                tone: Some(Tone::Urgent),
                title: if state == BackendLifecycle::Failed {
                    "Videorc can't recover on its own".into()
                } else {
                    "Videorc needs a restart".into()
                },
                detail: Some("Quit and reopen Videorc.".into()),
                ..Input::default()
            },
            now,
        ),
    }
}

/// `publishBackendError`: a backend `error` event nobody can explain. It can
/// repeat on every reconnect, so it is one counted entry.
pub fn backend_error() -> Input {
    Input {
        key: BACKEND_ERROR_KEY.into(),
        kind: "backend-error".into(),
        title: BACKEND_ERROR_TITLE.into(),
        detail: Some("Export a support bundle from Health if it repeats.".into()),
        actions: vec![open_health()],
        ..Input::default()
    }
}

/// `publishBackgroundProblem`: something Videorc tried on its own failed;
/// it waits behind the bell, and the same failure again is one counted
/// entry. One Videorc cannot explain joins the backend's own.
pub fn background_problem(title: &str, description: Option<&str>) -> Input {
    Input {
        key: if title == BACKEND_ERROR_TITLE {
            BACKEND_ERROR_KEY.into()
        } else {
            format!("background-problem:{title}")
        },
        kind: "backend-error".into(),
        title: title.into(),
        detail: description.map(str::to_string),
        actions: vec![open_health()],
        ..Input::default()
    }
}

// --- Live captions ----------------------------------------------------------

/// `publishCaptionsProblem`: captions start on their own with a session, so
/// a start that failed is an entry with its Retry (when there is one),
/// never a toast.
pub fn captions_problem(title: &str, description: Option<&str>, retryable: bool) -> Input {
    Input {
        key: CAPTIONS_KEY.into(),
        kind: "captions".into(),
        title: title.into(),
        detail: description.map(str::to_string),
        actions: if retryable {
            vec![action("retry", "Retry", ActionKind::Fix)]
        } else {
            Vec::new()
        },
        ..Input::default()
    }
}

/// `publishCaptionsOutputUnsupported`: the output cannot carry caption
/// pixels.
pub fn captions_output_unsupported(description: Option<&str>) -> Input {
    captions_problem(
        "Live captions can't start in this session",
        Some(description.unwrap_or("The active output configuration can't carry caption pixels.")),
        false,
    )
}

// --- Sidekick ---------------------------------------------------------------

/// The press a Sidekick status offers (`CohostStatusToast.action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidekickFix {
    SignIn,
    ViewPremium,
}

/// `publishSidekickStatus`: Sidekick stopped or failed on its own (a lapse
/// of Premium, a sign-out, a quota). A plain message is news, else a
/// warning; one entry, with the press that fixes it.
pub fn sidekick_status(title: &str, message: bool, fix: Option<SidekickFix>) -> Input {
    Input {
        key: SIDEKICK_KEY.into(),
        kind: "sidekick".into(),
        tone: Some(if message { Tone::News } else { Tone::Warning }),
        title: title.into(),
        actions: match fix {
            Some(SidekickFix::SignIn) => vec![action("sign-in", "Sign in", ActionKind::Fix)],
            Some(SidekickFix::ViewPremium) => {
                vec![action("view-premium", "View Premium", ActionKind::Door)]
            }
            None => Vec::new(),
        },
        ..Input::default()
    }
}

// --- What Videorc did on its own ---------------------------------------------

/// `publishAppNews`: news with nothing to do, never a pop-up, never
/// counted. `action` is a button the caller names.
pub fn app_news(key: &str, title: &str, detail: Option<&str>, action: Option<Action>) -> Input {
    Input {
        key: key.into(),
        kind: "app-news".into(),
        title: title.into(),
        detail: detail.map(str::to_string),
        actions: action.into_iter().collect(),
        once: true,
        ..Input::default()
    }
}

/// `publishAgentNotice` (plan 233 D11): an agent did something on air, and
/// where agents are set up.
pub fn agent_notice(id: &str, title: &str) -> Input {
    Input {
        key: id.into(),
        kind: "app-news".into(),
        title: title.into(),
        actions: vec![action("open-settings", "Open Settings", ActionKind::Door)],
        ..Input::default()
    }
}

/// The event the agents' D11 notices ride on (an Activity row, with the
/// backend's filled `notice` sentence for a successful `onAir` call).
pub const AGENTS_ACTIVITY_EVENT: &str = "agents.activity";

/// `startAgentNotices`' one step: the bell entry for one `agents.activity`
/// payload, or `None` for a row without a notice. The title is the
/// backend's sentence without its period (`agentNoticeTitle`); the key is
/// one per agent and tool, so a newer notice replaces the older
/// (`agentNoticeId`).
pub fn agent_activity_notice(payload: &serde_json::Value) -> Option<Input> {
    let notice = payload["notice"].as_str()?.trim();
    if notice.is_empty() {
        return None;
    }
    let title = notice.strip_suffix('.').unwrap_or(notice);
    let id = format!(
        "agent-notice:{}:{}",
        payload["agentId"].as_str().unwrap_or_default(),
        payload["tool"].as_str().unwrap_or_default()
    );
    Some(agent_notice(&id, title))
}

/// `publishOutputTooHeavy`: a finished check found the output too heavy;
/// the lighter preset is one press. After it runs, the app clears the entry
/// (`Store::clear(OUTPUT_TOO_HEAVY_KEY, now)`): nothing is left to say.
pub fn output_too_heavy(title: &str, description: &str, action_label: &str) -> Input {
    Input {
        key: OUTPUT_TOO_HEAVY_KEY.into(),
        kind: "output-too-heavy".into(),
        title: title.into(),
        detail: Some(description.into()),
        actions: vec![action("use-preset", action_label, ActionKind::Fix)],
        ..Input::default()
    }
}

// --- Buttons ----------------------------------------------------------------

/// What a pressed app button asks the app to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppPress {
    /// Output, at Videorc Camera.
    OpenOutputVideorcCamera,
    /// Settings, at Shortcuts.
    OpenShortcuts,
    OpenHealth,
    /// Live captions' start again.
    RetryCaptions,
    SignIn,
    /// `openVideorcWebLink(VIDEORC_PREMIUM_URL)`.
    ViewPremium,
    /// Settings, at Remote (where agents are set up).
    OpenRemoteSettings,
    /// The lighter output preset; then the entry is cleared.
    UseLighterPreset,
}

/// The press for an entry's button; `None` when it is not this source's.
pub fn app_press(key: &str, action_id: &str) -> Option<AppPress> {
    Some(match (key, action_id) {
        (VIDEORC_CAMERA_KEY, "open-output") => AppPress::OpenOutputVideorcCamera,
        (GLOBAL_SHORTCUTS_KEY, "open-shortcuts") => AppPress::OpenShortcuts,
        (_, "open-health") => AppPress::OpenHealth,
        (CAPTIONS_KEY, "retry") => AppPress::RetryCaptions,
        (SIDEKICK_KEY, "sign-in") => AppPress::SignIn,
        (SIDEKICK_KEY, "view-premium") => AppPress::ViewPremium,
        (_, "open-settings") => AppPress::OpenRemoteSettings,
        (OUTPUT_TOO_HEAVY_KEY, "use-preset") => AppPress::UseLighterPreset,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_activity_row_with_a_notice_becomes_one_entry_per_agent_and_tool() {
        let entry = agent_activity_notice(&serde_json::json!({
            "id": "a1",
            "agentId": "claude",
            "agentName": "Claude Desktop",
            "tool": "stop",
            "outcome": "ok",
            "summary": "",
            "at": "2026-11-25T12:00:00Z",
            "notice": " Claude Desktop ended the livestream. ",
        }))
        .unwrap();
        assert_eq!(entry.key, "agent-notice:claude:stop");
        assert_eq!(entry.kind, "app-news");
        assert_eq!(entry.title, "Claude Desktop ended the livestream");
        assert_eq!(entry.actions[0].id, "open-settings");
        assert!(agent_activity_notice(&serde_json::json!({ "tool": "status" })).is_none());
        assert!(agent_activity_notice(&serde_json::json!({ "notice": "  " })).is_none());
    }
    use crate::notices::Effect;
    use crate::notices::types::State;

    #[test]
    fn the_engine_restarts_then_recovers_or_needs_a_restart() {
        let mut store = Store::new(0, 0);
        publish_backend_lifecycle(
            &mut store,
            BackendLifecycle::Restarting { attempt: Some(2) },
            1_000,
        );
        assert_eq!(
            store.snapshot()[0].detail.as_deref(),
            Some("Restarting automatically (attempt 2)…")
        );
        publish_backend_lifecycle(&mut store, BackendLifecycle::Running, 4_000);
        assert_eq!(store.snapshot()[0].state, State::Resolved);
        assert_eq!(store.snapshot()[0].title, "Videorc recovered");

        let mut lost = Store::new(0, 0);
        publish_backend_lifecycle(&mut lost, BackendLifecycle::Lost, 1_000);
        assert_eq!(lost.snapshot()[0].tone, Tone::Urgent);
        assert_eq!(lost.snapshot()[0].title, "Videorc needs a restart");
    }

    #[test]
    fn a_problem_videorc_cannot_explain_is_one_counted_entry() {
        let mut store = Store::new(0, 0);
        store.publish(backend_error(), 1_000);
        store.publish(background_problem(BACKEND_ERROR_TITLE, None), 2_000);
        store.publish(
            background_problem("Couldn't load your scenes", Some("Try again.")),
            3_000,
        );
        assert_eq!(store.snapshot().len(), 2);
        let error = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == BACKEND_ERROR_KEY)
            .unwrap();
        assert_eq!(error.occurrences, 2);
        // Nobody pressed anything: behind the bell.
        assert!(
            !store
                .take_effects()
                .iter()
                .any(|effect| matches!(effect, Effect::Show { .. }))
        );
    }

    #[test]
    fn captions_sidekick_and_the_lighter_output() {
        assert!(
            captions_problem("Couldn't start live captions", None, false)
                .actions
                .is_empty()
        );
        assert_eq!(
            captions_output_unsupported(None).detail.as_deref(),
            Some("The active output configuration can't carry caption pixels.")
        );
        let lapse = sidekick_status(
            "Sidekick stopped: Premium ended",
            false,
            Some(SidekickFix::ViewPremium),
        );
        assert_eq!(lapse.tone, Some(Tone::Warning));
        assert_eq!(lapse.actions[0].kind, ActionKind::Door);
        assert_eq!(
            sidekick_status("Sidekick is resting", true, None).tone,
            Some(Tone::News)
        );
        assert_eq!(
            app_press(SIDEKICK_KEY, "view-premium"),
            Some(AppPress::ViewPremium)
        );
        assert_eq!(
            app_press(OUTPUT_TOO_HEAVY_KEY, "use-preset"),
            Some(AppPress::UseLighterPreset)
        );
        assert_eq!(app_press("clips", "use-preset"), None);
        assert!(
            app_news(
                "closed-window",
                "Closed a window for the recording",
                None,
                None
            )
            .once
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const APP: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/app.ts"
        );
        for words in [
            "title: 'Videorc Camera is back', was: 'It was stopped'",
            "label: 'Open Shortcuts'",
            "title: 'Global shortcuts registered'",
            "title: 'Videorc recovered', was: 'It was restarting'",
            "title: 'Videorc is recovering'",
            "`Restarting automatically (attempt ${event.attempt ?? 1})…`",
            "\"Videorc can't recover on its own\"",
            "'Videorc needs a restart'",
            "detail: 'Quit and reopen Videorc.'",
            "BACKEND_ERROR_TITLE = 'Videorc hit a problem'",
            "detail: 'Export a support bundle from Health if it repeats.'",
            "title: \"Live captions can't start in this session\"",
            "\"The active output configuration can't carry caption pixels.\"",
            "label: 'View Premium'",
            "label: 'Open Settings'",
        ] {
            assert!(APP.contains(words), "app.ts lacks {words}");
        }
    }
}
