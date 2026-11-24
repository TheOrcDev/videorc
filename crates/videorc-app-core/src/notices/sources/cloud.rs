//! Videorc Cloud's own news as notifications (plan 250 S6, Electron's
//! `sources/cloud.ts`). What is wrong with the cloud show is one condition,
//! `cloud-status`, updated in place (the watchdog's cloud checks land on the
//! same subject); the rest is news.
//!
//! Electron compares two cloud statuses here with the cloud toasts' rules
//! (`cloud-toasts.ts`, `cloud-notices.ts`). Those belong to the cloud's own
//! port, so [`CloudChange`] carries what they decided, and this turns it
//! into entries.

use super::devices::CURRENT_SESSION;
use crate::notices::Store;
use crate::notices::types::{Action, ActionKind, Input, ProgressState};

/// `CLOUD_STATUS_KEY`.
pub const CLOUD_STATUS_KEY: &str = "cloud-status";
/// `CLOUD_SOURCE`.
pub const CLOUD_SOURCE: &str = "cloud";
/// `CLOUD_SESSION_PREFIX`: a cloud show's problems end with the show.
pub const CLOUD_SESSION_PREFIX: &str = "cloud:";
/// `CLOUD_CONTROLLER_KEY`.
pub const CLOUD_CONTROLLER_KEY: &str = "cloud-controller";
/// `CLOUD_REJOIN_KEY`.
pub const CLOUD_REJOIN_KEY: &str = "cloud-rejoin";
/// `CLOUD_ANNOUNCE_TOAST`.
pub const CLOUD_ANNOUNCE_TITLE: &str = "Videorc Cloud is on";
pub const CLOUD_ANNOUNCE_DESCRIPTION: &str =
    "Your stream stays on air if this computer drops. Set it up in Destinations.";

fn action(id: &str, label: &str, kind: ActionKind) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        kind,
    }
}

/// `OPEN_CLOUD`: Destinations, at Videorc Cloud.
fn open_cloud() -> Action {
    action("open-destinations", "Open Destinations", ActionKind::Door)
}

fn open_studio() -> Action {
    action("open-studio", "Open Studio", ActionKind::Door)
}

/// `asTitle`: a toast was one sentence; an entry's title has no period, and
/// the sentences after the first are its detail.
pub fn as_title(sentence: &str) -> (String, Option<String>) {
    let mut parts = Vec::new();
    let mut start = 0;
    let bytes = sentence.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'.' {
            let mut end = index + 1;
            while end < bytes.len() && (bytes[end] as char).is_ascii_whitespace() {
                end += 1;
            }
            if end > index + 1 {
                parts.push(&sentence[start..=index]);
                start = end;
                index = end;
                continue;
            }
        }
        index += 1;
    }
    parts.push(&sentence[start..]);
    let first = parts[0];
    let title = first.strip_suffix('.').unwrap_or(first).to_string();
    let rest = parts[1..].join(" ");
    (title, (!rest.is_empty()).then_some(rest))
}

/// What the cloud's rules found in one status change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudChange<'a> {
    /// The show before, and now (`status.show.id`).
    pub previous_show: Option<&'a str>,
    pub next_show: Option<&'a str>,
    /// `endReason` just became `ended-elsewhere`.
    pub ended_elsewhere: bool,
    /// The one problem sentence that speaks, in Electron's order: the show
    /// cap, the restart, the loss, the fallback.
    pub problem: Option<&'a str>,
    /// `cloudAllowancePastToast` when the allowance is past: its words.
    pub allowance_past: Option<(&'a str, &'a str)>,
    /// `stoppedBy` just became `taken-over`: the device now on air.
    pub taken_over_by: Option<&'a str>,
}

/// `cloudSession`: the show's, or the local one.
fn cloud_session(show: Option<&str>) -> String {
    match show {
        Some(id) => format!("{CLOUD_SESSION_PREFIX}{id}"),
        None => CURRENT_SESSION.into(),
    }
}

/// `publishCloudStatus`, from what the rules found.
pub fn publish_cloud_change(store: &mut Store, change: &CloudChange<'_>, now: u64) {
    // A show that is gone takes its open problem with it.
    if let Some(gone) = change.previous_show
        && change.next_show != Some(gone)
    {
        store.session_ended(true, Some(&cloud_session(Some(gone))), now);
    }
    if change.ended_elsewhere {
        // One row per show: the next show ended from the web is its own news.
        let show = change.next_show.or(change.previous_show);
        store.publish(
            Input {
                key: match show {
                    Some(id) => format!("cloud-ended-elsewhere:{id}"),
                    None => "cloud-ended-elsewhere".into(),
                },
                kind: "cloud-news".into(),
                title: "The show was ended from videorc.com".into(),
                once: true,
                ..Input::default()
            },
            now,
        );
    }
    if let Some(problem) = change.problem {
        let (title, detail) = as_title(problem);
        store.publish(
            Input {
                key: CLOUD_STATUS_KEY.into(),
                kind: "cloud-status".into(),
                source: CLOUD_SOURCE.into(),
                title,
                detail,
                actions: vec![open_cloud()],
                session_id: Some(cloud_session(change.next_show)),
                ..Input::default()
            },
            now,
        );
    }
    // Plan 222 U5: past the month's hours is news, never a cut (D18).
    if let Some((title, description)) = change.allowance_past {
        store.publish(
            Input {
                key: "cloud-allowance".into(),
                kind: "cloud-news".into(),
                title: title.into(),
                detail: Some(description.into()),
                once: true,
                ..Input::default()
            },
            now,
        );
    }
    // Plan 243 C5: another device continued the show. A device's name is
    // the streamer's own text, so it skips the raw-text guard.
    if let Some(device) = change.taken_over_by {
        store.publish(
            Input {
                key: "cloud-taken-over".into(),
                kind: "cloud-news".into(),
                title: format!("Your show continues on {device}"),
                own_words: true,
                actions: vec![open_studio()],
                ..Input::default()
            },
            now,
        );
    }
}

/// `announceCloud`'s entry (plan 222 U1): "Videorc Cloud is on", once per
/// account, never during a session. The app tells the backend it showed
/// (`cloud.announce.seen`).
pub fn cloud_announce() -> Input {
    Input {
        key: "cloud-announce".into(),
        kind: "cloud-announce".into(),
        title: CLOUD_ANNOUNCE_TITLE.into(),
        detail: Some(CLOUD_ANNOUNCE_DESCRIPTION.into()),
        actions: vec![open_cloud()],
        once: true,
        ..Input::default()
    }
}

/// `publishCloudController` (plan 249): this device controls a show another
/// started; its camera and microphone stay off until turned on.
pub fn cloud_controller(needs: &[&str]) -> Input {
    let also: Vec<&str> = needs
        .iter()
        .copied()
        .filter(|need| *need != "camera" && *need != "microphone")
        .collect();
    let detail = if needs.is_empty() {
        "Camera and microphone stay off here until you turn them on.".to_string()
    } else {
        format!(
            "Camera and microphone stay off here until you turn them on. Also off: {}.",
            if also.is_empty() {
                "nothing else".to_string()
            } else {
                also.join(", ")
            }
        )
    };
    Input {
        key: CLOUD_CONTROLLER_KEY.into(),
        kind: "cloud-controller".into(),
        title: "You control this show here now".into(),
        detail: Some(detail),
        actions: vec![action("turn-on", "Turn on", ActionKind::Fix)],
        ..Input::default()
    }
}

/// `publishCloudRejoin`: the backend restarted while the room was open and
/// the Studio goes back in by itself. One entry: it runs, then says the
/// host is back, or that Resume is theirs to press.
pub fn cloud_rejoin(state: ProgressState) -> Input {
    let (title, detail, actions) = match state {
        ProgressState::Running => ("Reconnecting to your show", None, Vec::new()),
        ProgressState::Done => (
            "Back in your show",
            Some("Videorc restarted and put you back in the room."),
            Vec::new(),
        ),
        ProgressState::Failed => (
            "Couldn't reconnect to your show",
            Some("Press Resume in the Studio to go back in."),
            vec![open_studio()],
        ),
    };
    Input {
        key: CLOUD_REJOIN_KEY.into(),
        kind: "cloud-rejoin".into(),
        progress: Some(state),
        title: title.into(),
        detail: detail.map(str::to_string),
        actions,
        ..Input::default()
    }
}

/// `withdrawCloudRejoin`: nothing to go back to after all; the running
/// entry goes, one that already said how it ended stays.
pub fn withdraw_cloud_rejoin(store: &mut Store, now: u64) {
    let running = store.snapshot().iter().any(|entry| {
        entry.key == CLOUD_REJOIN_KEY && entry.state == crate::notices::types::State::Running
    });
    if running {
        store.clear(CLOUD_REJOIN_KEY, now);
    }
}

/// What a pressed cloud button asks the app to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudPress {
    /// Destinations, at Videorc Cloud.
    OpenCloud,
    OpenStudio,
    /// The controller's "Turn on".
    TurnOn,
}

/// The press for an entry's button; `None` when it is not this source's.
pub fn cloud_press(key: &str, action_id: &str) -> Option<CloudPress> {
    let cloud_key = matches!(
        key,
        CLOUD_STATUS_KEY | "cloud-announce" | "cloud-taken-over" | CLOUD_REJOIN_KEY
    ) || key == CLOUD_CONTROLLER_KEY;
    if !cloud_key {
        return None;
    }
    match action_id {
        "open-destinations" => Some(CloudPress::OpenCloud),
        "open-studio" => Some(CloudPress::OpenStudio),
        "turn-on" => Some(CloudPress::TurnOn),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::types::State;

    #[test]
    fn a_toast_sentence_becomes_a_title_and_its_detail() {
        assert_eq!(
            as_title("Videorc Cloud took over. Your stream stays on air."),
            (
                "Videorc Cloud took over".to_string(),
                Some("Your stream stays on air.".to_string())
            )
        );
        assert_eq!(
            as_title("One sentence."),
            ("One sentence".to_string(), None)
        );
        assert_eq!(as_title("v1.2 shipped"), ("v1.2 shipped".to_string(), None));
    }

    #[test]
    fn a_cloud_problem_is_one_condition_on_the_show() {
        let mut store = Store::new(0, 0);
        publish_cloud_change(
            &mut store,
            &CloudChange {
                next_show: Some("s1"),
                problem: Some("Videorc Cloud lost your stream. It shows Be right back."),
                ..CloudChange::default()
            },
            1_000,
        );
        let entry = &store.snapshot()[0];
        assert_eq!(entry.key, CLOUD_STATUS_KEY);
        assert_eq!(entry.title, "Videorc Cloud lost your stream");
        assert_eq!(entry.session_id.as_deref(), Some("cloud:s1"));
        // The show goes: its open problem ends with it.
        publish_cloud_change(
            &mut store,
            &CloudChange {
                previous_show: Some("s1"),
                next_show: None,
                ended_elsewhere: true,
                ..CloudChange::default()
            },
            2_000,
        );
        assert!(
            store
                .snapshot()
                .iter()
                .any(|entry| entry.key == "cloud-ended-elsewhere:s1")
        );
        let problem = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == CLOUD_STATUS_KEY);
        assert!(problem.is_none_or(|entry| entry.state != State::Open));
    }

    #[test]
    fn news_about_the_show_and_the_device() {
        let mut store = Store::new(0, 0);
        publish_cloud_change(
            &mut store,
            &CloudChange {
                next_show: Some("s1"),
                allowance_past: Some((
                    "You're 0:12 past this month's cloud hours",
                    "The show keeps going.",
                )),
                taken_over_by: Some("Studio <b>Mac</b>"),
                ..CloudChange::default()
            },
            1_000,
        );
        let taken = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == "cloud-taken-over")
            .unwrap();
        // The device's own name is kept as it is.
        assert_eq!(taken.title, "Your show continues on Studio <b>Mac</b>");
        assert!(
            store
                .snapshot()
                .iter()
                .any(|entry| entry.key == "cloud-allowance")
        );
    }

    #[test]
    fn the_controller_and_the_rejoin() {
        assert_eq!(
            cloud_controller(&["camera", "microphone", "captions"])
                .detail
                .as_deref(),
            Some("Camera and microphone stay off here until you turn them on. Also off: captions.")
        );
        assert_eq!(
            cloud_controller(&["camera"]).detail.as_deref(),
            Some(
                "Camera and microphone stay off here until you turn them on. Also off: nothing else."
            )
        );
        let mut store = Store::new(0, 0);
        store.publish(cloud_rejoin(ProgressState::Running), 1_000);
        withdraw_cloud_rejoin(&mut store, 2_000);
        assert!(store.snapshot().is_empty());
        store.publish(cloud_rejoin(ProgressState::Failed), 3_000);
        withdraw_cloud_rejoin(&mut store, 4_000);
        assert_eq!(store.snapshot()[0].actions[0].id, "open-studio");
        assert_eq!(
            cloud_press(CLOUD_REJOIN_KEY, "open-studio"),
            Some(CloudPress::OpenStudio)
        );
        assert_eq!(cloud_press("clips", "open-studio"), None);
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const SOURCE: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/cloud.ts"
        );
        const NOTICES: &str =
            include_str!("../../../../../apps/desktop/src/renderer/src/lib/cloud-notices.ts");
        for words in [
            "title: 'The show was ended from videorc.com'",
            "title: `Your show continues on ${onAirDeviceName(next.onAir)}`",
            "title: 'You control this show here now'",
            "'Camera and microphone stay off here until you turn them on.'",
            "Also off: ${also || 'nothing else'}.",
            "title: 'Reconnecting to your show'",
            "title: 'Back in your show', detail: 'Videorc restarted and put you back in the room.'",
            "title: \"Couldn't reconnect to your show\"",
            "detail: 'Press Resume in the Studio to go back in.'",
            "label: 'Turn on'",
            "label: 'Open Studio'",
            "CLOUD_STATUS_KEY = 'cloud-status'",
            "CLOUD_SOURCE = 'cloud'",
        ] {
            assert!(SOURCE.contains(words), "cloud.ts lacks {words}");
        }
        assert!(NOTICES.contains(&format!("title: '{CLOUD_ANNOUNCE_TITLE}'")));
        assert!(NOTICES.contains(&format!("description: '{CLOUD_ANNOUNCE_DESCRIPTION}'")));
        const HEALTH: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/health.ts"
        );
        assert!(HEALTH.contains(&format!("CLOUD_SESSION_PREFIX = '{CLOUD_SESSION_PREFIX}'")));
    }
}
