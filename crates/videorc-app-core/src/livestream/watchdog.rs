//! The stream watchdog's ranks and short words (plan 223 A5, A6:
//! `lib/watchdog-rank.ts`): which alert leads, and the few words the
//! Studio's Stream fact and the Stream Manager's chip say.
//!
//! The alerts are the backend's (`watchdog.alerts`); they are read leniently
//! here until the protocol carries their type.

use serde::Deserialize;

/// `WatchdogAlert`, the fields the ranks and the chip read.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchdogAlert {
    pub id: String,
    pub check: String,
    /// `critical`, `warning` or `notice`.
    pub severity: String,
    /// `open` or `snoozed` (D3).
    pub state: String,
    /// RFC 3339: when it opened.
    pub since: String,
    pub title: String,
    pub platform: Option<String>,
    pub target_id: Option<String>,
}

/// `SEVERITY_RANK`; a severity the app does not know sorts last.
fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 0,
        "warning" => 1,
        "notice" => 2,
        _ => 3,
    }
}

/// `visibleWatchdogAlerts`: snoozed alerts hidden, the worst first, then the
/// oldest.
pub fn visible_watchdog_alerts(alerts: &[WatchdogAlert]) -> Vec<&WatchdogAlert> {
    let mut visible: Vec<&WatchdogAlert> = alerts
        .iter()
        .filter(|alert| alert.state != "snoozed")
        .collect();
    visible.sort_by(|left, right| {
        severity_rank(&left.severity)
            .cmp(&severity_rank(&right.severity))
            .then_with(|| left.since.cmp(&right.since))
    });
    visible
}

/// `topWatchdogAlert`: the alert the Stream fact and the chip name.
pub fn top_watchdog_alert(alerts: &[WatchdogAlert]) -> Option<&WatchdogAlert> {
    visible_watchdog_alerts(alerts).into_iter().next()
}

/// `watchdogChipLabel`: the check's name in two or three words, with the
/// destination's label where there is one ("YouTube down"). A check the app
/// does not know says its title.
pub fn watchdog_chip_label(alert: &WatchdogAlert) -> String {
    let target = alert.target_id.as_deref();
    match alert.check.as_str() {
        "mic-muted" => "Microphone muted".into(),
        "mic-silent" => "Microphone silent".into(),
        "no-voice" => "No voice".into(),
        "program-silent" => "Viewers hear nothing".into(),
        "picture-black" => "Black picture".into(),
        "picture-stopped" => "Picture stopped".into(),
        "destination-down" if target == Some("all") => "Nobody receiving".into(),
        "destination-down" => format!("{} down", destination_of(alert)),
        "platform-health" => alert.title.clone(),
        "bitrate-floor" => "Connection too slow".into(),
        "av-drift" => "Sound and picture drifting".into(),
        "chat-says" => match target {
            Some("video") => "Chat says frozen".into(),
            Some("lag") => "Chat says lagging".into(),
            _ => "Chat says no sound".into(),
        },
        "brb-long" => "Be right back".into(),
        "still-there" => "Still there?".into(),
        "program-unreported" => "Program not reporting".into(),
        "contribution-missing" => match target {
            Some("host-microphone") => "Mic not in the room".into(),
            Some("host-camera") => "Camera not on program".into(),
            _ => "Not in the room".into(),
        },
        _ => alert.title.clone(),
    }
}

/// `PLATFORM_NAMES`: plan 223's platform ids as the chip may name them.
fn platform_name(platform: &str) -> Option<&'static str> {
    Some(match platform {
        "youtube" => "YouTube",
        "twitch" => "Twitch",
        "kick" => "Kick",
        "x" => "X",
        "facebook" => "Facebook",
        "tiktok" => "TikTok",
        "instagram" => "Instagram",
        "custom" => "Custom destination",
        _ => return None,
    })
}

/// `destinationOf`: the destination's label from the card's title in every
/// shape the backend writes, else the platform's name, else the title.
fn destination_of(alert: &WatchdogAlert) -> String {
    let title = alert.title.as_str();
    if let Some(label) = title
        .strip_prefix("Streaming to ")
        .and_then(|rest| rest.strip_suffix(" stopped"))
        .filter(|label| !label.is_empty())
    {
        return label.to_string();
    }
    // `/^(.+?) (has been down|isn't receiving|ended the broadcast|reports )/`:
    // the shortest label before any of the phrases.
    let phrases = [
        " has been down",
        " isn't receiving",
        " ended the broadcast",
        " reports ",
    ];
    let earliest = phrases
        .iter()
        .filter_map(|phrase| {
            title
                .char_indices()
                .skip(1)
                .find(|(at, _)| title[*at..].starts_with(phrase))
                .map(|(at, _)| at)
        })
        .min();
    if let Some(at) = earliest {
        return title[..at].to_string();
    }
    alert
        .platform
        .as_deref()
        .and_then(platform_name)
        .map(str::to_string)
        .unwrap_or_else(|| title.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert(check: &str, title: &str, target: Option<&str>) -> WatchdogAlert {
        WatchdogAlert {
            id: format!("{check}-1"),
            check: check.into(),
            severity: "warning".into(),
            state: "open".into(),
            since: "2026-11-24T10:00:00Z".into(),
            title: title.into(),
            platform: None,
            target_id: target.map(str::to_string),
        }
    }

    #[test]
    fn the_worst_oldest_open_alert_leads() {
        let mut notice = alert("mic-silent", "", None);
        notice.severity = "notice".into();
        let mut late = alert("picture-black", "", None);
        late.since = "2026-11-24T10:05:00Z".into();
        let early = alert("program-silent", "", None);
        let mut critical = alert("destination-down", "YouTube has been down for 0:20", None);
        critical.severity = "critical".into();
        critical.state = "snoozed".into();
        let alerts = [notice, late, early, critical];
        let order: Vec<&str> = visible_watchdog_alerts(&alerts)
            .iter()
            .map(|a| a.check.as_str())
            .collect();
        assert_eq!(order, ["program-silent", "picture-black", "mic-silent"]);
        assert_eq!(
            top_watchdog_alert(&alerts).map(|a| a.check.as_str()),
            Some("program-silent"),
            "a snoozed alert is hidden even when it is the worst"
        );
        assert_eq!(top_watchdog_alert(&[]), None);
    }

    #[test]
    fn the_chip_names_the_check_and_the_destination() {
        let label = |check: &str, title: &str, target: Option<&str>| {
            watchdog_chip_label(&alert(check, title, target))
        };
        assert_eq!(label("mic-muted", "", None), "Microphone muted");
        assert_eq!(label("program-silent", "", None), "Viewers hear nothing");
        assert_eq!(
            label("destination-down", "", Some("all")),
            "Nobody receiving"
        );
        assert_eq!(
            label(
                "destination-down",
                "Streaming to Twitch stopped",
                Some("t1")
            ),
            "Twitch down"
        );
        assert_eq!(
            label("destination-down", "YouTube has been down for 0:20", None),
            "YouTube down"
        );
        assert_eq!(
            label("destination-down", "Kick isn't receiving your stream", None),
            "Kick down"
        );
        assert_eq!(
            label("destination-down", "X ended the broadcast", None),
            "X down"
        );
        assert_eq!(
            label("platform-health", "YouTube reports poor health", None),
            "YouTube reports poor health"
        );
        assert_eq!(label("chat-says", "", Some("video")), "Chat says frozen");
        assert_eq!(label("chat-says", "", Some("lag")), "Chat says lagging");
        assert_eq!(label("chat-says", "", None), "Chat says no sound");
        assert_eq!(
            label("contribution-missing", "", Some("host-camera")),
            "Camera not on program"
        );
        assert_eq!(
            label("contribution-missing", "", Some("guest")),
            "Not in the room"
        );
    }

    #[test]
    fn a_title_with_no_label_falls_back_to_the_platform_then_the_title() {
        let mut down = alert("destination-down", "Something odd", None);
        down.platform = Some("custom".into());
        assert_eq!(watchdog_chip_label(&down), "Custom destination down");
        down.platform = Some("mystery".into());
        assert_eq!(watchdog_chip_label(&down), "Something odd down");
    }

    #[test]
    fn an_alert_reads_leniently() {
        let read: WatchdogAlert = serde_json::from_value(serde_json::json!({
            "id": "a", "check": "mic-muted", "severity": "critical", "state": "open",
            "since": "2026-11-24T10:00:00Z", "title": "Your microphone is muted",
            "detail": "…", "source": "local", "fixes": [], "targetId": "mic"
        }))
        .unwrap();
        assert_eq!(read.target_id.as_deref(), Some("mic"));
        assert_eq!(read.platform, None);
    }
}
