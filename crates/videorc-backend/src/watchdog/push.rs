//! The phone push (plan 223 D2, D11): what the desktop posts to
//! `POST /api/alerts/notify`, and nothing more. The body is the alert's own
//! words only: no chat text, no stream key, no URL, no media (the web
//! refuses any of them, `docs/alerts.md`). `chat-says` sends a count and a
//! class instead of words. Notices and `still-there` never push.

use serde_json::{Value, json};

use super::alerts::{AlertSeverity, Transition, WatchdogAlert, WatchdogCheck, cleared_toast};

/// `POST /api/alerts/notify`.
pub const ALERTS_NOTIFY_PATH: &str = "/api/alerts/notify";
/// `GET /api/alerts/devices`.
pub const ALERTS_DEVICES_PATH: &str = "/api/alerts/devices";

/// Whether this transition reaches the phone (D3): critical and warning
/// alerts, once on open and once on clear.
pub fn pushes(transition: &Transition) -> bool {
    let alert = transition.alert();
    if !alert.severity.interrupts() || alert.check == WatchdogCheck::StillThere {
        return false;
    }
    matches!(transition, Transition::Opened(_) | Transition::Cleared(_))
}

/// The push's title and body (plan 223, "Phone push form"): the card's
/// words without the livestream suffix, and the clock line.
pub fn push_words(alert: &WatchdogAlert, resolved: bool) -> (String, String) {
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

/// The notify body for a transition, or None when it never pushes.
pub fn notify_body(transition: &Transition) -> Option<Value> {
    if !pushes(transition) {
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
        let people = alert
            .detail
            .split(' ')
            .next()
            .and_then(|count| count.parse::<u64>().ok())
            .unwrap_or(1)
            .clamp(1, 999);
        body["chat"] = json!({ "class": class, "people": people });
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
        let body = notify_body(&Transition::Opened(muted.clone())).unwrap();
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
        let cleared = notify_body(&Transition::Cleared(muted)).unwrap();
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
        let body = notify_body(&Transition::Opened(chat)).unwrap();
        assert_eq!(body["chat"], json!({ "class": "audio", "people": 3 }));
        assert!(body.get("title").is_none() && body.get("body").is_none());
        assert_eq!(body["platform"], "youtube");
        assert!(!body.to_string().contains("no sound"));
    }

    #[test]
    fn notices_repeats_and_still_there_never_push() {
        let notice = alert(
            WatchdogCheck::BrbLong,
            AlertSeverity::Notice,
            "Be right back",
            "x",
        );
        assert_eq!(notify_body(&Transition::Opened(notice)), None);
        let still = alert(
            WatchdogCheck::StillThere,
            AlertSeverity::Warning,
            "Still there?",
            "x",
        );
        assert_eq!(notify_body(&Transition::Opened(still)), None);
        let muted = alert(
            WatchdogCheck::MicMuted,
            AlertSeverity::Critical,
            "x",
            "Muted for 0:42.",
        );
        assert_eq!(notify_body(&Transition::Repeated(muted.clone())), None);
        assert_eq!(notify_body(&Transition::Acknowledged(muted)), None);
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
        let body = notify_body(&Transition::Opened(health)).unwrap();
        assert_eq!(body["body"], "Check the platform's live dashboard.");
        let quoted = alert(
            WatchdogCheck::NoVoice,
            AlertSeverity::Warning,
            "No voice",
            "Said \u{201c}hi\u{201d}.",
        );
        assert_eq!(push_words(&quoted, false).1, "Said hi.");
    }

    #[test]
    fn the_switch_and_the_premium_gate_both_hold() {
        assert!(push_enabled(true, true));
        assert!(!push_enabled(false, true));
        assert!(!push_enabled(true, false));
    }
}
