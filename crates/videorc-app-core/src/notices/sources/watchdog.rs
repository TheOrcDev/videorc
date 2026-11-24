//! The stream watchdog's alerts as notifications (plan 250, Electron's
//! `sources/watchdog.ts`). The backend owns each alert and its words (plan
//! 223); this maps it onto its subject, so a silent microphone the watchdog
//! and a `health` event both report is one entry. The watchdog leads that
//! entry: it has the live clock and the fix.
//!
//! The alerts are read leniently here, with the fields the notifications
//! need (the detail and the fixes, which `livestream::watchdog`'s ranks do
//! not read), until the protocol carries their type.

use serde::Deserialize;

use crate::notices::Store;
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// One fix the backend offers on an alert (`WatchdogAlertFix`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchdogFix {
    /// `unmute`, `end-takeover`, `reconnect-destination`, `open-audio` …
    pub kind: String,
    pub label: String,
    /// `open-platform-dashboard`: the page to open (`AlertFix.url`).
    pub url: Option<String>,
}

/// `WatchdogAlert`, the fields the notifications read.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchdogAlert {
    pub id: String,
    pub check: String,
    /// `critical`, `warning` or `notice`.
    pub severity: String,
    /// `open`, or `snoozed` / `acknowledged`.
    pub state: String,
    pub title: String,
    pub detail: Option<String>,
    pub target_id: Option<String>,
    pub fixes: Vec<WatchdogFix>,
}

/// `watchdogSubjectKey`: the subject an alert is about, the entry it shares
/// with other reports.
pub fn watchdog_subject_key(alert: &WatchdogAlert) -> String {
    let target = alert.target_id.as_deref();
    match alert.check.as_str() {
        "mic-muted" | "mic-silent" | "no-voice" => "microphone".into(),
        "destination-down" => match target {
            Some(id) if id != "all" => format!("stream-target:{id}"),
            _ => "stream-targets".into(),
        },
        "bitrate-floor" => "stream-uplink".into(),
        "picture-stopped" => "stream-output".into(),
        "program-unreported" | "contribution-missing" => "cloud-status".into(),
        check => match target {
            Some(id) => format!("watchdog:{check}:{id}"),
            None => format!("watchdog:{check}"),
        },
    }
}

/// `watchdogReportSource`: one per check and target, so an alert that
/// returns under a new id is the same report.
pub fn watchdog_report_source(alert: &WatchdogAlert) -> String {
    match alert.target_id.as_deref() {
        Some(id) => format!("watchdog:{}:{id}", alert.check),
        None => format!("watchdog:{}", alert.check),
    }
}

/// `watchdogTone`.
pub fn watchdog_tone(alert: &WatchdogAlert) -> Tone {
    match alert.severity.as_str() {
        "critical" => Tone::Urgent,
        "warning" => Tone::Warning,
        _ => Tone::News,
    }
}

/// `IN_PLACE`: a fix that runs in place; every other fix opens the page
/// that owns the control.
const IN_PLACE: &[&str] = &["unmute", "end-takeover", "reconnect-destination"];

/// `watchdogActions`: the alert's fixes (`fix:{kind}`), with "I meant to"
/// second on a mute, at most two.
pub fn watchdog_actions(alert: &WatchdogAlert) -> Vec<Action> {
    let mut actions: Vec<Action> = alert
        .fixes
        .iter()
        .map(|fix| Action {
            id: format!("fix:{}", fix.kind),
            label: fix.label.clone(),
            kind: if IN_PLACE.contains(&fix.kind.as_str()) {
                ActionKind::Fix
            } else {
                ActionKind::Door
            },
        })
        .collect();
    if alert.check == "mic-muted" {
        let at = actions.len().min(1);
        actions.insert(
            at,
            Action {
                id: "meant-to".into(),
                label: "I meant to".into(),
                kind: ActionKind::Fix,
            },
        );
    }
    actions.truncate(2);
    actions
}

/// `destinationLabel` (`watchdog-view.ts`): the destination an alert's title
/// names. Its patterns are greedy, so the last marker wins.
fn destination_in_title(title: &str) -> Option<&str> {
    if let Some(label) = title
        .strip_prefix("Streaming to ")
        .and_then(|rest| rest.strip_suffix(" stopped"))
        .filter(|label| !label.is_empty())
    {
        return Some(label);
    }
    if let Some((label, _)) = title.rsplit_once(" has been down for")
        && !label.is_empty()
    {
        return Some(label);
    }
    [" reports", " isn't receiving", " ended"]
        .iter()
        .filter_map(|marker| title.rfind(marker))
        .filter(|at| *at > 0)
        .max()
        .map(|at| &title[..at])
}

/// `watchdogClearedToast`: the recovery's words when a check clears.
pub fn watchdog_cleared_words(alert: &WatchdogAlert) -> String {
    match alert.check.as_str() {
        "mic-muted" => "Microphone unmuted".into(),
        "mic-silent" | "no-voice" | "program-silent" => "Sound is back".into(),
        "picture-black" | "picture-stopped" => "Picture is back".into(),
        "destination-down" | "platform-health" => {
            match (
                destination_in_title(&alert.title),
                alert.target_id.as_deref(),
            ) {
                (Some(label), Some(id)) if !label.is_empty() && id != "all" => {
                    format!("{label} is back")
                }
                _ => "Destinations are back".into(),
            }
        }
        "bitrate-floor" => "Connection is back to speed".into(),
        "av-drift" => "Sound and picture are in step again".into(),
        "chat-says" => "Chat has gone quiet about it".into(),
        "brb-long" => "Takeover ended".into(),
        "still-there" => "Welcome back".into(),
        "program-unreported" => "The cloud program is reporting again".into(),
        "contribution-missing" => match alert.target_id.as_deref() {
            Some("host-microphone") => "Your microphone reaches the room again".into(),
            Some("host-camera") => "Your camera reaches the program again".into(),
            _ => "You're back in the room".into(),
        },
        // Electron's switch has no default: a check it does not name says
        // nothing of its own, and the store's resolved row keeps the title.
        _ => alert.title.clone(),
    }
}

/// `watchdogClearedAlerts`: the alerts that left the list on their own (not
/// withdrawn, snoozed or seen).
pub fn watchdog_cleared_alerts<'a>(
    previous: &'a [WatchdogAlert],
    next: &[WatchdogAlert],
    withdrawn: &[String],
) -> Vec<&'a WatchdogAlert> {
    previous
        .iter()
        .filter(|alert| {
            !next.iter().any(|each| each.id == alert.id) && !withdrawn.contains(&alert.id)
        })
        .collect()
}

/// `syncWatchdogAlerts`, with each `watchdog.alerts` list. An open alert is
/// a report on its subject; a cleared one resolves it with the watchdog's
/// recovery words; one withdrawn, snoozed or marked seen is taken back
/// without a resolved entry.
pub fn sync_watchdog_alerts(
    store: &mut Store,
    previous: &[WatchdogAlert],
    next: &[WatchdogAlert],
    withdrawn: &[String],
    now: u64,
) {
    for alert in watchdog_cleared_alerts(previous, next, withdrawn) {
        store.resolve(
            &watchdog_subject_key(alert),
            Resolution {
                source: Some(watchdog_report_source(alert)),
                title: Some(watchdog_cleared_words(alert)),
                ..Resolution::default()
            },
            now,
        );
    }
    for alert in previous {
        if !next.iter().any(|each| each.id == alert.id) && withdrawn.contains(&alert.id) {
            store.withdraw(
                &watchdog_subject_key(alert),
                Some(&watchdog_report_source(alert)),
                now,
            );
        }
    }
    for alert in next {
        let key = watchdog_subject_key(alert);
        let source = watchdog_report_source(alert);
        if alert.state != "open" {
            // Got it on the card, or a snooze: the report goes.
            store.withdraw(&key, Some(&source), now);
            continue;
        }
        store.publish(
            Input {
                key,
                kind: "watchdog".into(),
                source,
                lead: true,
                tone: Some(watchdog_tone(alert)),
                title: alert.title.clone(),
                detail: alert.detail.clone(),
                actions: watchdog_actions(alert),
                ..Input::default()
            },
            now,
        );
    }
}

/// Electron's `onClear`: the open alerts on a subject the streamer cleared
/// from the list, which the app acknowledges (`deps.acknowledge`).
pub fn alerts_to_acknowledge<'a>(key: &str, alerts: &'a [WatchdogAlert]) -> Vec<&'a WatchdogAlert> {
    alerts
        .iter()
        .filter(|alert| alert.state == "open" && watchdog_subject_key(alert) == key)
        .collect()
}

/// What a pressed watchdog button asks for: the backend's fix, or the
/// mute's "I meant to" for the rest of the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchdogPress<'a> {
    Fix {
        alert: &'a WatchdogAlert,
        fix: &'a WatchdogFix,
    },
    SnoozeForStream {
        alert: &'a WatchdogAlert,
    },
}

/// The press for an entry's button, among the open alerts; `None` for a
/// button that is not the watchdog's.
pub fn watchdog_press<'a>(
    key: &str,
    action_id: &str,
    alerts: &'a [WatchdogAlert],
) -> Option<WatchdogPress<'a>> {
    let mut on_subject = alerts_to_acknowledge(key, alerts).into_iter();
    if action_id == "meant-to" {
        return on_subject
            .find(|alert| alert.check == "mic-muted")
            .map(|alert| WatchdogPress::SnoozeForStream { alert });
    }
    let kind = action_id.strip_prefix("fix:")?;
    on_subject.find_map(|alert| {
        alert
            .fixes
            .iter()
            .find(|fix| fix.kind == kind)
            .map(|fix| WatchdogPress::Fix { alert, fix })
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::notices::Effect;
    use crate::notices::types::State;

    fn alert(id: &str, check: &str, severity: &str, title: &str) -> WatchdogAlert {
        serde_json::from_value(json!({
            "id": id,
            "check": check,
            "severity": severity,
            "state": "open",
            "title": title,
            "detail": "The backend's words.",
            "fixes": [{"kind": "unmute", "label": "Unmute"}, {"kind": "open-audio", "label": "Open Audio"}],
            "since": "2026-11-24T10:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn alerts_land_on_their_subjects() {
        let mut down = alert(
            "1",
            "destination-down",
            "critical",
            "Streaming to Twitch stopped",
        );
        down.target_id = Some("tw".into());
        assert_eq!(watchdog_subject_key(&down), "stream-target:tw");
        assert_eq!(
            watchdog_report_source(&down),
            "watchdog:destination-down:tw"
        );
        down.target_id = Some("all".into());
        assert_eq!(watchdog_subject_key(&down), "stream-targets");
        assert_eq!(
            watchdog_subject_key(&alert("2", "mic-silent", "warning", "x")),
            "microphone"
        );
        assert_eq!(
            watchdog_subject_key(&alert("3", "av-drift", "notice", "x")),
            "watchdog:av-drift"
        );
        assert_eq!(watchdog_tone(&alert("4", "x", "notice", "x")), Tone::News);
    }

    #[test]
    fn a_dashboard_fix_keeps_its_page() {
        let mut down = alert(
            "1",
            "platform-health",
            "warning",
            "Twitch reports a problem",
        );
        down.fixes = serde_json::from_value(json!([{
            "kind": "open-platform-dashboard",
            "label": "Open Twitch",
            "url": "https://dashboard.twitch.tv/"
        }]))
        .unwrap();
        let key = watchdog_subject_key(&down);
        match watchdog_press(
            &key,
            "fix:open-platform-dashboard",
            std::slice::from_ref(&down),
        ) {
            Some(WatchdogPress::Fix { fix, .. }) => {
                assert_eq!(fix.url.as_deref(), Some("https://dashboard.twitch.tv/"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_mute_offers_unmute_then_i_meant_to() {
        let muted = alert("1", "mic-muted", "critical", "Your microphone is muted");
        let actions = watchdog_actions(&muted);
        assert_eq!(
            actions
                .iter()
                .map(|each| each.id.as_str())
                .collect::<Vec<_>>(),
            ["fix:unmute", "meant-to"]
        );
        assert_eq!(actions[0].kind, ActionKind::Fix);
        let other = watchdog_actions(&alert("2", "mic-silent", "warning", "x"));
        assert_eq!(other[1].kind, ActionKind::Door, "open-audio opens a page");
        assert_eq!(
            watchdog_press("microphone", "meant-to", std::slice::from_ref(&muted)),
            Some(WatchdogPress::SnoozeForStream { alert: &muted })
        );
        assert!(matches!(
            watchdog_press("microphone", "fix:unmute", std::slice::from_ref(&muted)),
            Some(WatchdogPress::Fix { fix, .. }) if fix.kind == "unmute"
        ));
    }

    #[test]
    fn an_open_alert_leads_and_a_cleared_one_resolves_with_its_words() {
        let mut store = Store::new(0, 0);
        store.set_live(true);
        store.set_pressed();
        let muted = alert("1", "mic-muted", "critical", "Your microphone is muted");
        sync_watchdog_alerts(&mut store, &[], std::slice::from_ref(&muted), &[], 1_000);
        let entry = &store.snapshot()[0];
        assert_eq!(entry.key, "microphone");
        assert_eq!(entry.tone, Tone::Urgent);
        assert!(
            store
                .take_effects()
                .iter()
                .any(|effect| matches!(effect, Effect::Show { .. })),
            "urgent while live pops up"
        );
        sync_watchdog_alerts(&mut store, std::slice::from_ref(&muted), &[], &[], 9_000);
        let back = &store.snapshot()[0];
        assert_eq!(back.state, State::Resolved);
        assert_eq!(back.title, "Microphone unmuted");
    }

    #[test]
    fn a_withdrawn_or_snoozed_alert_goes_without_a_resolved_row() {
        let mut store = Store::new(0, 0);
        let drift = alert("1", "av-drift", "warning", "Sound and picture drifted");
        sync_watchdog_alerts(&mut store, &[], std::slice::from_ref(&drift), &[], 1_000);
        sync_watchdog_alerts(
            &mut store,
            std::slice::from_ref(&drift),
            &[],
            &["1".to_string()],
            2_000,
        );
        assert!(store.snapshot().is_empty());
        let mut snoozed = drift.clone();
        snoozed.state = "snoozed".into();
        sync_watchdog_alerts(&mut store, &[], std::slice::from_ref(&drift), &[], 3_000);
        sync_watchdog_alerts(
            &mut store,
            std::slice::from_ref(&drift),
            std::slice::from_ref(&snoozed),
            &[],
            4_000,
        );
        assert!(store.snapshot().is_empty());
    }

    #[test]
    fn the_recovery_names_the_destination_from_the_title() {
        let mut down = alert(
            "1",
            "destination-down",
            "critical",
            "Streaming to Twitch stopped",
        );
        down.target_id = Some("tw".into());
        assert_eq!(watchdog_cleared_words(&down), "Twitch is back");
        down.title = "YouTube has been down for 2 minutes".into();
        assert_eq!(watchdog_cleared_words(&down), "YouTube is back");
        down.title = "Kick isn't receiving your stream".into();
        assert_eq!(watchdog_cleared_words(&down), "Kick is back");
        down.target_id = Some("all".into());
        assert_eq!(watchdog_cleared_words(&down), "Destinations are back");
        let mut cloud = alert("2", "contribution-missing", "warning", "x");
        cloud.target_id = Some("host-camera".into());
        assert_eq!(
            watchdog_cleared_words(&cloud),
            "Your camera reaches the program again"
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const VIEW: &str =
            include_str!("../../../../../apps/desktop/src/renderer/src/lib/watchdog-view.ts");
        const SOURCE: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/watchdog.ts"
        );
        for words in [
            "'Microphone unmuted'",
            "'Sound is back'",
            "'Picture is back'",
            "'Destinations are back'",
            "'Connection is back to speed'",
            "'Sound and picture are in step again'",
            "'Chat has gone quiet about it'",
            "'Takeover ended'",
            "'Welcome back'",
            "'The cloud program is reporting again'",
            "'Your microphone reaches the room again'",
            "'Your camera reaches the program again'",
            "\"You're back in the room\"",
        ] {
            assert!(VIEW.contains(words), "watchdog-view.ts lacks {words}");
        }
        assert!(SOURCE.contains("'unmute',\n  'end-takeover',\n  'reconnect-destination'"));
        assert!(SOURCE.contains("label: 'I meant to'"));
    }
}
