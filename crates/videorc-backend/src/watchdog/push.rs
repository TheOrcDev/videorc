//! The phone push (plan 223 D2, D11): what the desktop posts to
//! `POST /api/alerts/notify`, and nothing more. The body is the alert's own
//! words only: no chat text, no stream key, no URL, no media (the web
//! refuses any of them, `docs/alerts.md`). `chat-says` sends a count and a
//! class instead of words. Notices and `still-there` never push.

use serde_json::{Value, json};

use super::alerts::{
    AlertSeverity, Transition, WatchdogAlert, WatchdogCheck, cleared_toast, destination_label,
};

/// `POST /api/alerts/notify`.
pub const ALERTS_NOTIFY_PATH: &str = "/api/alerts/notify";
/// `GET /api/alerts/devices`.
pub const ALERTS_DEVICES_PATH: &str = "/api/alerts/devices";

/// Whether this transition reaches the phone (D3): critical and warning
/// alerts, once on open and once on clear, and only while the session
/// streams (L5): a record-only session's silent microphone (the 1064
/// adoption) is the recording's own notice, never a phone alert (plan 221
/// Q7: nothing warns while only recording).
pub fn pushes(transition: &Transition, live: bool) -> bool {
    if !live {
        return false;
    }
    let alert = transition.alert();
    if !alert.severity.interrupts() || alert.check == WatchdogCheck::StillThere {
        return false;
    }
    matches!(transition, Transition::Opened(_) | Transition::Cleared(_))
}

/// The push's title and body (plan 223, "Phone push form"): the card's
/// words without the livestream suffix, and the clock line. A destination
/// label the streamer typed as a host ("rtmp.example.com", "my.server.tv")
/// would read as an address to the web and fail the push with a 400 (L7):
/// the push names the platform instead, in the title and the body.
pub fn push_words(alert: &WatchdogAlert, resolved: bool) -> (String, String) {
    let (title, body) = push_card_words(alert, resolved);
    match host_shaped_label(alert) {
        Some(label) => {
            let name = platform_name(alert.platform.as_deref());
            (title.replace(&label, name), body.replace(&label, name))
        }
        None => (title, body),
    }
}

/// The destination's label on the card when it is shaped like a host.
fn host_shaped_label(alert: &WatchdogAlert) -> Option<String> {
    if !matches!(
        alert.check,
        WatchdogCheck::DestinationDown | WatchdogCheck::PlatformHealth
    ) {
        return None;
    }
    let label = destination_label(&alert.title);
    (!label.is_empty() && label != alert.title && looks_like_host(&label)).then_some(label)
}

/// The web's bare-host rule (`lib/alerts/push.ts`): dotted labels with a
/// letter-only last part of two or more characters, an IPv4 address, or
/// a port suffix. "Twitch (main)" and "My server" are not hosts.
fn looks_like_host(label: &str) -> bool {
    let lower = label.trim().to_ascii_lowercase();
    if lower.contains("://")
        || lower.contains("rtmp:")
        || lower.contains("rtmps:")
        || lower.contains("www.")
    {
        return true;
    }
    let bare = lower.split(':').next().unwrap_or("");
    let parts: Vec<&str> = bare.split('.').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    let ipv4 = parts.len() == 4 && parts.iter().all(|part| part.parse::<u8>().is_ok());
    let last = parts[parts.len() - 1];
    let domain = last.len() >= 2
        && last.chars().all(|ch| ch.is_ascii_alphabetic())
        && parts.iter().all(|part| {
            part.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        });
    ipv4 || domain
}

/// The platform's name for a push, from the alert's platform id.
fn platform_name(platform: Option<&str>) -> &'static str {
    match platform {
        Some("youtube") => "YouTube",
        Some("twitch") => "Twitch",
        Some("kick") => "Kick",
        Some("x") => "X",
        Some("facebook") => "Facebook",
        Some("tiktok") => "TikTok",
        Some("instagram") => "Instagram",
        _ => "Custom destination",
    }
}

fn push_card_words(alert: &WatchdogAlert, resolved: bool) -> (String, String) {
    if resolved {
        return (cleared_toast(alert), "Cleared.".to_string());
    }
    let title = alert
        .title
        .strip_suffix(" on the livestream")
        .unwrap_or(&alert.title)
        .to_string();
    let body = match alert.check {
        WatchdogCheck::MicMuted => {
            let clock = alert
                .detail
                .strip_prefix("Muted for ")
                .and_then(|rest| rest.split('.').next())
                .unwrap_or("a while");
            format!("Muted for {clock} on the livestream.")
        }
        // The platform's own description may carry an address; the push
        // never does (the web would refuse it, and the card has it).
        WatchdogCheck::PlatformHealth if looks_like_address(&alert.detail) => {
            "Check the platform's live dashboard.".to_string()
        }
        _ => alert.detail.clone(),
    };
    (title, scrub_quotes(&body))
}

fn looks_like_address(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("://")
        || lower.contains("www.")
        || lower.contains("rtmp")
        || lower.contains(".com")
        || lower.contains(".tv")
}

/// The web refuses quoted text (it would be chat); a card detail never
/// quotes anything but chat, and chat never takes this path. Belt and
/// braces: strip the quote marks if one ever slips in.
fn scrub_quotes(text: &str) -> String {
    text.replace(
        [
            '"', '\u{201c}', '\u{201d}', '\u{201e}', '\u{00ab}', '\u{00bb}', '\u{2018}',
            '\u{201a}', '\u{2039}', '\u{203a}', '\u{300c}', '\u{300d}', '\u{300e}', '\u{300f}',
        ],
        "",
    )
}

/// `chat-says` as the record keeps it (L4): the count and the class, never
/// a viewer's words. The card's detail quotes chat ("3 people in the last 2
/// minutes: “no sound??”, …"); the health event, the session log and the
/// support bundle carry "Chat says they can't hear you. 3 people in the
/// last 2 minutes (audio)." and nothing of what anyone typed.
pub fn chat_says_record(alert: &WatchdogAlert) -> String {
    let class = alert.target_id.as_deref().unwrap_or("audio");
    let people = chat_says_people(alert);
    let people = match people {
        1 => "1 person".to_string(),
        n => format!("{n} people"),
    };
    format!(
        "{}. {people} in the last 2 minutes ({class}).",
        alert.title.trim_end_matches('.')
    )
}

/// The distinct authors a `chat-says` detail counts ("3 people …").
fn chat_says_people(alert: &WatchdogAlert) -> u64 {
    alert
        .detail
        .split(' ')
        .next()
        .and_then(|count| count.parse::<u64>().ok())
        .unwrap_or(1)
        .clamp(1, 999)
}

/// The notify body for a transition, or None when it never pushes.
pub fn notify_body(transition: &Transition, live: bool) -> Option<Value> {
    if !pushes(transition, live) {
        return None;
    }
    let alert = transition.alert();
    let resolved = matches!(transition, Transition::Cleared(_));
    let severity = match alert.severity {
        AlertSeverity::Critical => "critical",
        AlertSeverity::Warning => "warning",
        AlertSeverity::Notice => return None,
    };
    let mut body = json!({
        "alertId": alert.id,
        "check": alert.check.id(),
        "severity": severity,
        "since": alert.since,
        "resolved": resolved,
    });
    if let Some(platform) = &alert.platform {
        body["platform"] = json!(platform);
    }
    if alert.check == WatchdogCheck::ChatSays {
        // A count and a class, never words (docs/alerts.md).
        let class = alert
            .target_id
            .clone()
            .unwrap_or_else(|| "audio".to_string());
        body["chat"] = json!({ "class": class, "people": chat_says_people(alert) });
    } else {
        let (title, text) = push_words(alert, resolved);
        body["title"] = json!(title);
        body["body"] = json!(text);
    }
    Some(body)
}

/// One device from `GET /api/alerts/devices`: never an endpoint.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertDevice {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<String>,
}

/// `watchdog.phone.devices`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertDevicesView {
    pub devices: Vec<AlertDevice>,
}

/// Per-stream push bookkeeping: failures are logged once per stream and
/// never shown as a toast (the phone is the fallback, not the primary).
#[derive(Debug, Default)]
pub struct PushLedger {
    pub failure_logged: bool,
    pub sent: u32,
}

/// Whether the desktop sends at all: the switch and the Premium gate (D5).
pub fn push_enabled(phone_push: bool, premium: bool) -> bool {
    phone_push && premium
}

#[cfg(test)]
mod tests {
    use super::super::alerts::{AlertFix, AlertSource, AlertState, FixKind};
    use super::*;

    fn alert(
        check: WatchdogCheck,
        severity: AlertSeverity,
        title: &str,
        detail: &str,
    ) -> WatchdogAlert {
        WatchdogAlert {
            id: format!("watchdog:{}:1", check.id()),
            check,
            severity,
            state: AlertState::Open,
            since: "2026-11-08T12:04:00.000Z".to_string(),
            last_repeat_at: None,
            title: title.to_string(),
            detail: detail.to_string(),
            source: AlertSource::Desktop,
            platform: None,
            target_id: None,
            fixes: vec![AlertFix::new(FixKind::Unmute, "Unmute")],
            snoozed_until: None,
            meant_to: None,
        }
    }

    #[test]
    fn the_body_carries_the_alerts_words_only() {
        let muted = alert(
            WatchdogCheck::MicMuted,
            AlertSeverity::Critical,
            "Your microphone is muted on the livestream",
            "Muted for 0:42. Viewers hear no voice.",
        );
        let body = notify_body(&Transition::Opened(muted.clone()), true).unwrap();
        assert_eq!(
            body,
            json!({
                "alertId": "watchdog:mic-muted:1",
                "check": "mic-muted",
                "severity": "critical",
                "since": "2026-11-08T12:04:00.000Z",
                "resolved": false,
                "title": "Your microphone is muted",
                "body": "Muted for 0:42 on the livestream."
            })
        );
        let cleared = notify_body(&Transition::Cleared(muted), true).unwrap();
        assert_eq!(cleared["resolved"], true);
        assert_eq!(cleared["title"], "Microphone unmuted");
        let keys: Vec<&String> = cleared.as_object().unwrap().keys().collect();
        for key in keys {
            assert!(
                [
                    "alertId", "check", "severity", "since", "resolved", "title", "body"
                ]
                .contains(&key.as_str()),
                "{key} is not an alert word"
            );
        }
    }

    #[test]
    fn chat_says_sends_a_count_and_a_class_and_never_a_word() {
        let mut chat = alert(
            WatchdogCheck::ChatSays,
            AlertSeverity::Warning,
            "Chat says they can't hear you",
            "3 people in the last 2 minutes: \u{201c}no sound??\u{201d}, \u{201c}sin audio\u{201d}.",
        );
        chat.target_id = Some("audio".to_string());
        chat.platform = Some("youtube".to_string());
        let body = notify_body(&Transition::Opened(chat.clone()), true).unwrap();
        assert_eq!(body["chat"], json!({ "class": "audio", "people": 3 }));
        assert!(body.get("title").is_none() && body.get("body").is_none());
        assert_eq!(body["platform"], "youtube");
        assert!(!body.to_string().contains("no sound"));
        // L4: the record keeps the same form.
        assert_eq!(
            chat_says_record(&chat),
            "Chat says they can't hear you. 3 people in the last 2 minutes (audio)."
        );
        let mut one = chat.clone();
        one.detail = "1 person in the last 2 minutes: \u{201c}lag\u{201d}.".to_string();
        one.target_id = Some("lag".to_string());
        assert_eq!(
            chat_says_record(&one),
            "Chat says they can't hear you. 1 person in the last 2 minutes (lag)."
        );
    }

    #[test]
    fn notices_repeats_and_still_there_never_push() {
        let notice = alert(
            WatchdogCheck::BrbLong,
            AlertSeverity::Notice,
            "Be right back",
            "x",
        );
        assert_eq!(notify_body(&Transition::Opened(notice), true), None);
        let still = alert(
            WatchdogCheck::StillThere,
            AlertSeverity::Warning,
            "Still there?",
            "x",
        );
        assert_eq!(notify_body(&Transition::Opened(still), true), None);
        let muted = alert(
            WatchdogCheck::MicMuted,
            AlertSeverity::Critical,
            "x",
            "Muted for 0:42.",
        );
        assert_eq!(
            notify_body(&Transition::Repeated(muted.clone()), true),
            None
        );
        assert_eq!(
            notify_body(&Transition::Acknowledged(muted.clone()), true),
            None
        );
        // L5: a record-only session never pushes (the 1064 adoption).
        assert_eq!(notify_body(&Transition::Opened(muted.clone()), false), None);
        assert!(
            !pushes(&Transition::Withdrawn(muted), true),
            "a withdrawal is not a recovery"
        );
    }

    #[test]
    fn a_platform_description_with_an_address_or_quotes_never_leaves() {
        let mut health = alert(
            WatchdogCheck::PlatformHealth,
            AlertSeverity::Warning,
            "YouTube reports a problem",
            "Check rtmp://a.rtmp.youtube.com/live2 and \"the key\".",
        );
        health.platform = Some("youtube".to_string());
        let body = notify_body(&Transition::Opened(health), true).unwrap();
        assert_eq!(body["body"], "Check the platform's live dashboard.");
        let quoted = alert(
            WatchdogCheck::NoVoice,
            AlertSeverity::Warning,
            "No voice",
            "Said \u{201c}hi\u{201d}.",
        );
        assert_eq!(push_words(&quoted, false).1, "Said hi.");
    }

    /// L7: a custom destination labelled with its host would be refused by
    /// the web as an address; the push names the platform, in the title,
    /// the all-down detail and the clear. Labels that are names stay.
    #[test]
    fn a_host_shaped_label_becomes_the_platform_name_in_the_push() {
        let mut down = alert(
            WatchdogCheck::DestinationDown,
            AlertSeverity::Warning,
            "rtmp.example.com has been down for 0:20",
            "Videorc is retrying every 2 seconds. Viewers there see nothing until it's back.",
        );
        down.platform = Some("custom".to_string());
        down.target_id = Some("custom-1".to_string());
        let body = notify_body(&Transition::Opened(down.clone()), true).unwrap();
        assert_eq!(body["title"], "Custom destination has been down for 0:20");
        assert!(!body.to_string().contains("example.com"));
        let cleared = notify_body(&Transition::Cleared(down), true).unwrap();
        assert_eq!(cleared["title"], "Custom destination is back");

        let mut all = alert(
            WatchdogCheck::DestinationDown,
            AlertSeverity::Critical,
            "Nobody is receiving your stream",
            "Every destination is down. Videorc can't reconnect my.server.tv:1935 without a gap on the others. Keep going, or end the livestream and go live again.",
        );
        all.target_id = Some("all".to_string());
        let body = notify_body(&Transition::Opened(all), true).unwrap();
        assert_eq!(body["title"], "Nobody is receiving your stream");
        assert!(
            !body["body"].as_str().unwrap().contains("my.server.tv"),
            "{body}"
        );

        let mut stopped = alert(
            WatchdogCheck::DestinationDown,
            AlertSeverity::Warning,
            "Streaming to 192.168.1.20 stopped",
            "Videorc can't reconnect 192.168.1.20 without a gap on the others. Keep going, or end the livestream and go live again.",
        );
        stopped.platform = Some("custom".to_string());
        let body = notify_body(&Transition::Opened(stopped), true).unwrap();
        assert_eq!(body["title"], "Streaming to Custom destination stopped");
        assert!(!body["body"].as_str().unwrap().contains("192.168"));

        let named = alert(
            WatchdogCheck::DestinationDown,
            AlertSeverity::Warning,
            "Twitch (main) has been down for 0:20",
            "Videorc is retrying every 2 seconds.",
        );
        let body = notify_body(&Transition::Opened(named), true).unwrap();
        assert_eq!(body["title"], "Twitch (main) has been down for 0:20");
        let mut named_custom = alert(
            WatchdogCheck::DestinationDown,
            AlertSeverity::Warning,
            "My server has been down for 0:20",
            "x",
        );
        named_custom.platform = Some("custom".to_string());
        let body = notify_body(&Transition::Opened(named_custom), true).unwrap();
        assert_eq!(body["title"], "My server has been down for 0:20");
        assert!(looks_like_host("a.rtmp.youtube.com"));
        assert!(looks_like_host("live.twitch.tv"));
        assert!(looks_like_host("10.0.0.5"));
        assert!(!looks_like_host("Twitch (main)"));
        assert!(!looks_like_host("Studio B"));
        assert!(!looks_like_host("v2.0"));
    }

    #[test]
    fn the_switch_and_the_premium_gate_both_hold() {
        assert!(push_enabled(true, true));
        assert!(!push_enabled(false, true));
        assert!(!push_enabled(true, false));
    }
}
