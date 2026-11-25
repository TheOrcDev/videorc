//! The stream watchdog's system notification (plan 223 A7, D2, D3), as
//! Electron's `watchdog-surface.ts` asks and main's `watchdog-notify.ts`
//! decides. Pure; the GPUI app's main notification centre runs it.
//!
//! - An ask goes out when an alert opens, on each backend repeat, and once
//!   more at since + 60 s while it is still open ([`notify_candidates`],
//!   [`stayed_open_delay_ms`]); only while the session streams, and only
//!   for warning and critical alerts that are not still-there
//!   ([`notifies`]).
//! - [`decide`] answers from what only the window knows: the Destinations
//!   "System notifications" switch, whether the Studio is in front, what
//!   was shown already. A critical alert notifies at once when the Studio
//!   is not in front, and after 60 s open even when it is; a warning only
//!   after 60 s open and only when the Studio is not in front; the second
//!   ask never repeats what the first showed; one alert id is not shown
//!   twice inside 30 s.
//! - The GPUI app adds one rule of its own: never while the alert's toast
//!   is on screen (the Studio in front with that entry's toast showing),
//!   so a notification never doubles a toast the streamer can see.
//! - A click brings the Studio forward; it never runs a fix (a
//!   notification click is too easy to make by accident).

use std::collections::HashMap;

use super::watchdog::WatchdogAlert;

/// After this long open, a critical alert notifies even a focused Studio,
/// and a warning at all.
pub const NOTIFIES_AFTER_OPEN_SECONDS: u64 = 60;
/// The same alert id is not shown twice inside this window.
pub const NOTIFY_DEDUPE_MS: i64 = 30_000;
/// A notification's tag: the alert's id after this prefix, so a click can
/// name what it was about.
pub const TAG_PREFIX: &str = "watchdog-alert:";

/// `WatchdogNoticeReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Opened,
    Repeat,
    StayedOpen,
}

/// `watchdogNotificationWords`: "Videorc: your microphone is muted" /
/// "Muted for 0:42 on the livestream. Click to open the Studio."
pub fn notification_words(alert: &WatchdogAlert) -> (String, String) {
    let bare = alert
        .title
        .strip_suffix(" on the livestream")
        .unwrap_or(&alert.title);
    let mut chars = bare.chars();
    let title = match chars.next() {
        Some(first) => format!("Videorc: {}{}", first.to_lowercase(), chars.as_str()),
        None => "Videorc:".to_string(),
    };
    let body = match muted_clock(&alert.detail) {
        Some(clock) => format!("Muted for {clock} on the livestream. Click to open the Studio."),
        None => format!("{} Click to open the Studio.", alert.detail.trim_end()),
    };
    (title, body)
}

/// `/^Muted for (\d+:\d{2}(?::\d{2})?)\./`: the mute's live clock.
fn muted_clock(detail: &str) -> Option<&str> {
    let rest = detail.strip_prefix("Muted for ")?;
    let end = rest.find('.')?;
    let clock = &rest[..end];
    let parts: Vec<&str> = clock.split(':').collect();
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let shaped = match parts.as_slice() {
        [minutes, seconds] => digits(minutes) && seconds.len() == 2 && digits(seconds),
        [hours, minutes, seconds] => {
            digits(hours)
                && minutes.len() == 2
                && digits(minutes)
                && seconds.len() == 2
                && digits(seconds)
        }
        _ => false,
    };
    shaped.then_some(clock)
}

fn since_ms(alert: &WatchdogAlert) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(&alert.since)
        .ok()
        .map(|since| since.timestamp_millis())
}

/// `watchdogOpenSeconds`: seconds since the alert opened.
pub fn open_seconds(alert: &WatchdogAlert, now_ms: i64) -> u64 {
    since_ms(alert).map_or(0, |since| (now_ms - since).max(0) as u64 / 1000)
}

/// `watchdogNotifies` (D3): warning and critical, never still-there.
pub fn notifies(alert: &WatchdogAlert) -> bool {
    alert.severity != "notice" && alert.check != "still-there"
}

/// `watchdogNotifyCandidates`: the asks a new list means, opened or
/// repeated. A snoozed alert never asks.
pub fn notify_candidates<'a>(
    previous: &[WatchdogAlert],
    next: &'a [WatchdogAlert],
) -> Vec<(&'a WatchdogAlert, Reason)> {
    next.iter()
        .filter(|alert| notifies(alert) && alert.state != "snoozed")
        .filter_map(|alert| {
            let Some(known) = previous.iter().find(|known| known.id == alert.id) else {
                return Some((alert, Reason::Opened));
            };
            (alert.last_repeat_at.is_some() && alert.last_repeat_at != known.last_repeat_at)
                .then_some((alert, Reason::Repeat))
        })
        .collect()
}

/// `watchdogStayedOpenDelayMs`: until since + 60 s (0 once that passed).
pub fn stayed_open_delay_ms(alert: &WatchdogAlert, now_ms: i64) -> u64 {
    let Some(since) = since_ms(alert) else {
        return NOTIFIES_AFTER_OPEN_SECONDS * 1000;
    };
    (since + NOTIFIES_AFTER_OPEN_SECONDS as i64 * 1000 - now_ms).max(0) as u64
}

/// What [`decide`] reads for one ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ask {
    pub reason: Reason,
    pub critical: bool,
    pub open_seconds: u64,
    /// The Studio is the front window: its toasts and cards are seen.
    pub main_focused: bool,
    /// The alert's own toast is showing in that window.
    pub toast_showing: bool,
    /// Destinations → Watchdog → System notifications (on when unread).
    pub enabled: bool,
    /// When this alert id was last shown, if it was.
    pub last_shown_at: Option<i64>,
    pub now_ms: i64,
}

/// Why an ask shows nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quiet {
    Off,
    Duplicate,
    TooSoon,
    Shown,
    Focused,
    /// The alert's toast is on screen: the notification would double it.
    ToastOnScreen,
}

/// `watchdogNotifyDecision`, plus the on-screen toast rule: `Ok(())` to
/// show.
pub fn decide(ask: &Ask) -> Result<(), Quiet> {
    if !ask.enabled {
        return Err(Quiet::Off);
    }
    if let Some(at) = ask.last_shown_at
        && ask.now_ms >= at
        && ask.now_ms - at < NOTIFY_DEDUPE_MS
    {
        return Err(Quiet::Duplicate);
    }
    let stayed_open = ask.open_seconds >= NOTIFIES_AFTER_OPEN_SECONDS;
    let shown = match ask.reason {
        // D3: critical at once when the Studio is not in front; a warning
        // waits for the 60 s ask.
        Reason::Opened if !ask.critical => Err(Quiet::TooSoon),
        Reason::Opened if ask.main_focused => Err(Quiet::Focused),
        Reason::Opened => Ok(()),
        // Never a second notification for what the first ask showed.
        Reason::StayedOpen if ask.last_shown_at.is_some() => Err(Quiet::Shown),
        Reason::StayedOpen if !stayed_open => Err(Quiet::TooSoon),
        // D2: a critical alert open 60 s shows over a focused Studio; a
        // warning only when the Studio is not in front.
        Reason::StayedOpen if ask.critical || !ask.main_focused => Ok(()),
        Reason::StayedOpen => Err(Quiet::Focused),
        Reason::Repeat if !ask.main_focused || (ask.critical && stayed_open) => Ok(()),
        Reason::Repeat => Err(Quiet::Focused),
    };
    shown?;
    if ask.main_focused && ask.toast_showing {
        return Err(Quiet::ToastOnScreen);
    }
    Ok(())
}

/// `WatchdogNotifyLedger`: what was shown, by alert id, for this run.
#[derive(Debug, Clone, Default)]
pub struct Ledger {
    shown: HashMap<String, i64>,
}

impl Ledger {
    pub fn last_shown_at(&self, alert_id: &str) -> Option<i64> {
        self.shown.get(alert_id).copied()
    }

    pub fn mark(&mut self, alert_id: &str, now_ms: i64) {
        self.shown.insert(alert_id.to_string(), now_ms);
        // A long stream opens many alerts; keep the map small.
        if self.shown.len() > 200 {
            let mut by_age: Vec<(String, i64)> = self
                .shown
                .iter()
                .map(|(id, at)| (id.clone(), *at))
                .collect();
            by_age.sort_by_key(|(_, at)| *at);
            for (id, _) in by_age.into_iter().take(100) {
                self.shown.remove(&id);
            }
        }
    }
}

/// The notification's tag for an alert, and the alert id back from a tag.
pub fn tag(alert_id: &str) -> String {
    format!("{TAG_PREFIX}{alert_id}")
}

pub fn alert_of_tag(tag: &str) -> Option<&str> {
    tag.strip_prefix(TAG_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert(id: &str, severity: &str) -> WatchdogAlert {
        WatchdogAlert {
            id: id.into(),
            check: "mic-muted".into(),
            severity: severity.into(),
            state: "open".into(),
            since: "2026-11-25T12:00:00Z".into(),
            title: "Your microphone is muted on the livestream".into(),
            detail: "Muted for 0:42. Viewers hear nothing from you.".into(),
            ..WatchdogAlert::default()
        }
    }

    const SINCE_MS: i64 = 1_795_608_000_000;

    fn ask(reason: Reason, critical: bool) -> Ask {
        Ask {
            reason,
            critical,
            open_seconds: 0,
            main_focused: false,
            toast_showing: false,
            enabled: true,
            last_shown_at: None,
            now_ms: SINCE_MS,
        }
    }

    #[test]
    fn the_words_follow_electrons_form() {
        let (title, body) = notification_words(&alert("a", "critical"));
        assert_eq!(title, "Videorc: your microphone is muted");
        assert_eq!(
            body,
            "Muted for 0:42 on the livestream. Click to open the Studio."
        );
        let mut black = alert("b", "warning");
        black.title = "The stream is black".into();
        black.detail = "Viewers see black for 10 seconds.  ".into();
        assert_eq!(
            notification_words(&black),
            (
                "Videorc: the stream is black".to_string(),
                "Viewers see black for 10 seconds. Click to open the Studio.".to_string()
            )
        );
        assert_eq!(muted_clock("Muted for 1:02:03. x"), Some("1:02:03"));
        assert_eq!(muted_clock("Muted for 2:3. x"), None);
    }

    #[test]
    fn opens_and_repeats_ask_but_notices_snoozes_and_still_there_do_not() {
        let open = alert("a", "warning");
        let mut notice = alert("n", "notice");
        notice.check = "picture-black".into();
        let mut still = alert("s", "warning");
        still.check = "still-there".into();
        let mut snoozed = alert("z", "critical");
        snoozed.state = "snoozed".into();
        let next = vec![open.clone(), notice, still, snoozed];
        let asks = notify_candidates(&[], &next);
        assert_eq!(asks.len(), 1);
        assert_eq!((asks[0].0.id.as_str(), asks[0].1), ("a", Reason::Opened));
        assert!(notify_candidates(&next, &next).is_empty());
        let mut repeated = open.clone();
        repeated.last_repeat_at = Some("2026-11-25T12:05:00Z".into());
        let asks = notify_candidates(std::slice::from_ref(&open), std::slice::from_ref(&repeated));
        assert_eq!(asks[0].1, Reason::Repeat);
    }

    #[test]
    fn the_second_ask_comes_sixty_seconds_after_the_open() {
        let open = alert("a", "warning");
        assert_eq!(open_seconds(&open, SINCE_MS + 42_500), 42);
        assert_eq!(stayed_open_delay_ms(&open, SINCE_MS + 15_000), 45_000);
        assert_eq!(stayed_open_delay_ms(&open, SINCE_MS + 90_000), 0);
        let mut unknown = open;
        unknown.since = "soon".into();
        assert_eq!(stayed_open_delay_ms(&unknown, SINCE_MS), 60_000);
    }

    #[test]
    fn the_decision_is_mains() {
        // A critical open shows at once, unless the Studio is in front.
        assert_eq!(decide(&ask(Reason::Opened, true)), Ok(()));
        let focused = Ask {
            main_focused: true,
            ..ask(Reason::Opened, true)
        };
        assert_eq!(decide(&focused), Err(Quiet::Focused));
        // A warning waits for the 60 s ask.
        assert_eq!(decide(&ask(Reason::Opened, false)), Err(Quiet::TooSoon));
        let stayed = Ask {
            open_seconds: 60,
            ..ask(Reason::StayedOpen, false)
        };
        assert_eq!(decide(&stayed), Ok(()));
        let stayed_focused = Ask {
            main_focused: true,
            ..stayed
        };
        assert_eq!(decide(&stayed_focused), Err(Quiet::Focused));
        let critical_focused = Ask {
            critical: true,
            ..stayed_focused
        };
        assert_eq!(decide(&critical_focused), Ok(()));
        // Never twice for one alert.
        let after_open = Ask {
            last_shown_at: Some(SINCE_MS - 40_000),
            ..critical_focused
        };
        assert_eq!(decide(&after_open), Err(Quiet::Shown));
        let duplicate = Ask {
            last_shown_at: Some(SINCE_MS - 10_000),
            ..ask(Reason::Repeat, true)
        };
        assert_eq!(decide(&duplicate), Err(Quiet::Duplicate));
        let off = Ask {
            enabled: false,
            ..ask(Reason::Opened, true)
        };
        assert_eq!(decide(&off), Err(Quiet::Off));
        assert_eq!(decide(&ask(Reason::Repeat, false)), Ok(()));
        let repeat_focused = Ask {
            main_focused: true,
            ..ask(Reason::Repeat, false)
        };
        assert_eq!(decide(&repeat_focused), Err(Quiet::Focused));
    }

    #[test]
    fn never_over_the_alerts_own_toast_on_screen() {
        let critical_focused = Ask {
            open_seconds: 60,
            main_focused: true,
            toast_showing: true,
            ..ask(Reason::StayedOpen, true)
        };
        assert_eq!(decide(&critical_focused), Err(Quiet::ToastOnScreen));
        // A toast in a window behind another app is not on screen.
        let behind = Ask {
            toast_showing: true,
            ..ask(Reason::Opened, true)
        };
        assert_eq!(decide(&behind), Ok(()));
    }

    #[test]
    fn the_ledger_and_tags() {
        let mut ledger = Ledger::default();
        ledger.mark("a", 5);
        assert_eq!(ledger.last_shown_at("a"), Some(5));
        for index in 0..201 {
            ledger.mark(&format!("x{index}"), 10 + index);
        }
        assert!(ledger.shown.len() <= 200);
        assert_eq!(alert_of_tag(&tag("a1")), Some("a1"));
        assert_eq!(alert_of_tag("update-ready"), None);
    }
}
