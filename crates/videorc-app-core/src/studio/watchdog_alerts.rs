//! S1.6g: the stream watchdog's alerts in the Studio (plan 223, `use-studio.tsx`
//! and `lib/watchdog-surface.ts`): the list once per connection
//! (`watchdog.alerts.list`, so a relaunch mid-stream shows the open card),
//! kept current by `watchdog.alerts`, and the card's own requests: Got it,
//! I meant to, Snooze 10 min and Reconnect. The cards are
//! `screen_views::watchdog_cards`; the other fixes are the Studio screen's
//! doors (`screen_views::WatchdogFixAction`).
//!
//! The toasts, the system notification and the entries behind the bell are
//! the notification centre's (`notices::sources::watchdog`, lane L6); it
//! reads `WatchdogState::withdrawn` to tell a recovery from a withdrawal.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::watchdog::{WatchdogAlert, WatchdogAlertsView};
use crate::user_error::{UserErrorContext, backend_error_toast};

/// The backend's push of the whole list.
pub const CHANGED_EVENT: &str = "watchdog.alerts";
const LIST: &str = "watchdog.alerts.list";
const ACKNOWLEDGE: &str = "watchdog.alert.acknowledge";
const SNOOZE: &str = "watchdog.alert.snooze";
const RECONNECT_DESTINATION: &str = "cloud.show.reconnectDestination";
/// Plan 223 still-there: the system's idle time, from the window side.
pub const IDLE_REPORT: &str = "watchdog.idle.report";
/// `mountWatchdogSurface`: one report as live starts, then every 30 s.
pub const IDLE_REPORT_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// Whether an idle report is due: as live starts, then every
/// [`IDLE_REPORT_EVERY`] while it lasts; never while not live.
pub fn idle_report_due(
    live: bool,
    last_report: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    live && last_report.is_none_or(|at| now.saturating_duration_since(at) >= IDLE_REPORT_EVERY)
}

/// How long a snooze lasts (D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnoozeScope {
    /// The kebab's Snooze 10 min.
    TenMinutes,
    /// I meant to: the rest of this stream.
    Stream,
}

impl SnoozeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            SnoozeScope::TenMinutes => "ten-minutes",
            SnoozeScope::Stream => "stream",
        }
    }
}

/// The alerts as the backend last listed them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchdogState {
    /// Every alert, snoozed ones included; `visible_watchdog_alerts` orders
    /// and filters them.
    pub alerts: Vec<WatchdogAlert>,
    /// The ids the last event withdrew (not a recovery).
    pub withdrawn: Vec<String>,
    /// Bumped by every list, so a reader sees a repeat of the same list.
    pub revision: u64,
}

impl<B: StudioBackend> Studio<B> {
    pub fn watchdog(&self) -> watch::Receiver<WatchdogState> {
        self.watchdog_tx.subscribe()
    }

    pub fn watchdog_now(&self) -> WatchdogState {
        self.watchdog_tx.borrow().clone()
    }

    /// `reportSystemIdle`: the system's idle time for still-there, while
    /// live. Telemetry only: a failure is never a toast.
    pub async fn report_system_idle(&self, idle_seconds: u64) {
        let _ = self
            .backend
            .livestream_request(IDLE_REPORT, json!({ "idleSeconds": idle_seconds }))
            .await;
    }

    fn commit_watchdog(&self, view: WatchdogAlertsView) {
        self.feed_dashboard_alerts(&view);
        self.watchdog_tx.send_modify(|state| {
            state.alerts = view.alerts;
            state.withdrawn = view.withdrawn;
            state.revision += 1;
        });
    }

    /// The list once per connection; an older backend has no watchdog, and
    /// a failed read keeps the last list.
    pub(super) async fn read_watchdog(&self) {
        let Ok(answer) = self.backend.livestream_request(LIST, Value::Null).await else {
            return;
        };
        match serde_json::from_value::<WatchdogAlertsView>(answer) {
            Ok(mut view) => {
                view.withdrawn.clear();
                self.commit_watchdog(view);
            }
            Err(error) => self
                .config
                .logger
                .warn(format!("Studio: \"{LIST}\" did not read ({error}).")),
        }
    }

    pub(super) fn handle_watchdog_event(&self, event: &str, payload: &Value) -> bool {
        if event != CHANGED_EVENT {
            return false;
        }
        match serde_json::from_value::<WatchdogAlertsView>(payload.clone()) {
            Ok(view) => self.commit_watchdog(view),
            Err(error) => self.config.logger.warn(format!(
                "Studio: \"{CHANGED_EVENT}\" did not read ({error})."
            )),
        }
        true
    }

    /// `toastUserError(error, { action, object })`.
    fn toast_watchdog_error(&self, error: &RpcError, action: &'static str, object: &'static str) {
        let connected = self.is_connected();
        if let Some(command) =
            backend_error_toast(error, connected, UserErrorContext { action, object })
        {
            self.post(vec![command]);
        }
    }

    /// `acknowledgeWatchdogAlert`: Got it. The card reads Seen once the
    /// backend's next list says `acknowledged`.
    pub async fn acknowledge_watchdog_alert(&self, id: &str) {
        if let Err(error) = self
            .backend
            .livestream_request(ACKNOWLEDGE, json!({ "id": id }))
            .await
        {
            self.toast_watchdog_error(&error, "acknowledge", "the alert");
        }
    }

    /// `snoozeWatchdogAlert`: Snooze 10 min, or I meant to (the stream).
    pub async fn snooze_watchdog_alert(&self, id: &str, scope: SnoozeScope) {
        if let Err(error) = self
            .backend
            .livestream_request(SNOOZE, json!({ "id": id, "scope": scope.as_str() }))
            .await
        {
            self.toast_watchdog_error(&error, "snooze", "the alert");
        }
    }

    /// The `reconnect-destination` fix: the runner retries the platform leg.
    /// Its error says the fix's own word (`{ action: fix.label }`), with no
    /// object.
    pub async fn reconnect_watchdog_destination(&self, target_id: &str) {
        if let Err(error) = self
            .backend
            .livestream_request(RECONNECT_DESTINATION, json!({ "targetId": target_id }))
            .await
        {
            self.toast_watchdog_error(&error, "reconnect", "");
        }
    }
}

#[cfg(test)]
mod idle_tests {
    use super::*;

    #[test]
    fn idle_reports_go_as_live_starts_then_every_thirty_seconds() {
        let start = std::time::Instant::now();
        assert!(!idle_report_due(false, None, start));
        assert!(idle_report_due(true, None, start));
        let soon = start + std::time::Duration::from_secs(29);
        assert!(!idle_report_due(true, Some(start), soon));
        assert!(idle_report_due(
            true,
            Some(start),
            start + IDLE_REPORT_EVERY
        ));
    }
}
