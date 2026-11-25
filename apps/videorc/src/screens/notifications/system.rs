//! The stream watchdog's system notifications (plan 223 A7, D2, D3;
//! Electron's `watchdog-surface.ts` + main's `watchdog-notify.ts`), run by
//! the main window's notification centre: it knows whether the Studio is
//! in front and which toast is showing. The rules are app-core's
//! (`livestream::watchdog_notify`); this asks on every new alert list
//! after the first, arms the second ask at since + 60 s, and posts through
//! GPUI's system notification. Behind Destinations → Watchdog → System
//! notifications, never over the alert's own toast on screen. A click
//! brings the Studio forward on its page; it never runs a fix. While live
//! it also reports the system's idle time every 30 s (still-there).

use super::*;
use gpui::{App, SystemNotification};
use videorc_app_core::livestream::watchdog::WatchdogAlert;
use videorc_app_core::livestream::watchdog_notify::{self as wn, Ask, Reason};
use videorc_app_core::notices::sources::watchdog::subject_key;
use videorc_app_core::studio::session::session_is_live;
use videorc_app_core::studio::watchdog_alerts::idle_report_due;

/// One alert's second ask: armed under this number, or already asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StayedOpen {
    Armed(u64),
    Asked,
}

pub(super) struct WatchdogNotices {
    previous: Vec<WatchdogAlert>,
    ledger: wn::Ledger,
    stayed_open: HashMap<String, StayedOpen>,
    armed: u64,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Centre {
    /// The main window's centre only: the list as it stands is the first
    /// (it asks nothing), then every change asks.
    pub(super) fn start_watchdog_notices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let studio = self.hub.read(cx).studio.clone();
        self.watchdog_notices = Some(WatchdogNotices {
            previous: studio.watchdog_now().alerts,
            ledger: wn::Ledger::default(),
            stayed_open: HashMap::new(),
            armed: 0,
        });
        // The app's one response handler (GPUI keeps the last one): a
        // watchdog notification's click opens the Studio in front.
        let hub = self.hub.clone();
        let main = window.window_handle();
        cx.on_system_notification_response(move |response, cx| {
            if wn::alert_of_tag(&response.tag).is_none() {
                return;
            }
            cx.activate(true);
            let _ = main.update(cx, |_, window, _| window.activate_window());
            hub.update(cx, |_, cx| {
                cx.emit(Navigate::Action(NoticeAction::OpenPage(
                    videorc_app_core::nav::PageId::Studio,
                )))
            });
        });
        self.start_idle_reports(window, cx);
        let mut alerts = studio.watchdog();
        cx.spawn_in(window, async move |this, cx| {
            while alerts.changed().await.is_ok() {
                alerts.borrow_and_update();
                let alive = this.update_in(cx, |centre, window, cx| {
                    centre.watchdog_alerts_changed(window, cx)
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// `watchdogLive`: the session streams, or this computer's cloud room
    /// is on air. A record-only session's alerts are the recording's own
    /// notices, never a system notification.
    fn streaming(&self, cx: &App) -> bool {
        crate::app::exit::ExitGuard::livestream_on_air(cx)
            || session_is_live(&self.hub.read(cx).studio.snapshot().session.status)
    }

    /// `mountWatchdogSurface`'s idle tick (still-there): one report as live
    /// starts, then every 30 s while it lasts, of the system's idle time.
    /// Where the platform has no answer nothing goes, and the check stays
    /// quiet.
    fn start_idle_reports(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let mut last_report: Option<std::time::Instant> = None;
            loop {
                let alive = this.update(cx, |centre, cx| {
                    let live = centre.streaming(cx);
                    if !live {
                        last_report = None;
                        return;
                    }
                    let now = std::time::Instant::now();
                    if !idle_report_due(live, last_report, now) {
                        return;
                    }
                    last_report = Some(now);
                    let Some(idle) = crate::platform::idle::system_idle_seconds() else {
                        return;
                    };
                    let hub = centre.hub.read(cx);
                    let studio = hub.studio.clone();
                    hub.runtime
                        .spawn(async move { studio.report_system_idle(idle).await });
                });
                if alive.is_err() {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(1)).await;
            }
        })
        .detach();
    }

    /// `onWatchdogAlertsChanged`.
    fn watchdog_alerts_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.hub.read(cx).studio.watchdog_now().alerts;
        let live = self.streaming(cx);
        let now = now_ms();
        let Some(notices) = self.watchdog_notices.as_mut() else {
            return;
        };
        // Gone, hushed or seen: the second ask is off, and never re-armed
        // (an alert that comes back comes back under a new id).
        notices.stayed_open.retain(|id, _| {
            next.iter()
                .any(|alert| &alert.id == id && alert.state == "open")
        });
        let previous = std::mem::replace(&mut notices.previous, next.clone());
        if !live {
            return;
        }
        let asks: Vec<(WatchdogAlert, Reason)> = wn::notify_candidates(&previous, &next)
            .into_iter()
            .map(|(alert, reason)| (alert.clone(), reason))
            .collect();
        for (alert, reason) in &asks {
            self.ask_watchdog(alert, *reason, window, cx);
        }
        for alert in next
            .iter()
            .filter(|alert| alert.state == "open" && wn::notifies(alert))
        {
            self.arm_stayed_open(alert, now, window, cx);
        }
    }

    /// D2, D3: the second ask at since + 60 s for an alert still open then.
    fn arm_stayed_open(
        &mut self,
        alert: &WatchdogAlert,
        now: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(notices) = self.watchdog_notices.as_mut() else {
            return;
        };
        if notices.stayed_open.contains_key(&alert.id) {
            return;
        }
        notices.armed += 1;
        let armed = notices.armed;
        notices
            .stayed_open
            .insert(alert.id.clone(), StayedOpen::Armed(armed));
        let delay = Duration::from_millis(wn::stayed_open_delay_ms(alert, now));
        let id = alert.id.clone();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update_in(cx, |centre, window, cx| {
                centre.stayed_open_due(&id, armed, window, cx)
            });
        })
        .detach();
    }

    fn stayed_open_due(
        &mut self,
        id: &str,
        armed: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(notices) = self.watchdog_notices.as_mut() else {
            return;
        };
        // Dropped (gone, hushed, seen) or re-armed since: nothing to ask.
        if notices.stayed_open.get(id) != Some(&StayedOpen::Armed(armed)) {
            return;
        }
        notices
            .stayed_open
            .insert(id.to_string(), StayedOpen::Asked);
        let current = self
            .hub
            .read(cx)
            .studio
            .watchdog_now()
            .alerts
            .into_iter()
            .find(|alert| alert.id == id);
        let Some(current) = current.filter(|alert| alert.state == "open") else {
            return;
        };
        if !self.streaming(cx) {
            return;
        }
        self.ask_watchdog(&current, Reason::StayedOpen, window, cx);
    }

    /// One ask: main's decision, then the notification.
    fn ask_watchdog(
        &mut self,
        alert: &WatchdogAlert,
        reason: Reason,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // An unread setting (an older backend) is on, as Electron's.
        let enabled = self
            .hub
            .read(cx)
            .studio
            .watchdog_settings_now()
            .settings
            .as_ref()
            .is_none_or(|settings| settings.system_notifications);
        let key = subject_key(&alert.check, alert.target_id.as_deref());
        let toast_showing = self.toaster.read(cx).contains(&key.into());
        let now = now_ms();
        let Some(notices) = self.watchdog_notices.as_mut() else {
            return;
        };
        let ask = Ask {
            reason,
            critical: alert.severity == "critical",
            open_seconds: wn::open_seconds(alert, now),
            main_focused: window.is_window_active(),
            toast_showing,
            enabled,
            last_shown_at: notices.ledger.last_shown_at(&alert.id),
            now_ms: now,
        };
        if wn::decide(&ask).is_err() {
            return;
        }
        notices.ledger.mark(&alert.id, now);
        let (title, body) = wn::notification_words(alert);
        cx.show_system_notification(SystemNotification {
            tag: wn::tag(&alert.id).into(),
            title: title.into(),
            body: body.into(),
            actions: Vec::new(),
        });
    }
}
