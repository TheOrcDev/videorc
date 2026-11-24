use super::*;
use sources::watchdog::{WatchdogAlert, WatchdogFix, WatchdogPress};
use videorc_app_core::studio::watchdog_alerts::SnoozeScope;

pub(super) enum Job {
    Unmute,
    Snooze(String),
    Reconnect(String),
}
impl Hub {
    pub(super) fn sync_watchdog(&mut self) {
        let view = self.studio.watchdog_now();
        let next: Vec<_> = view
            .alerts
            .iter()
            .map(|alert| WatchdogAlert {
                id: alert.id.clone(),
                check: alert.check.clone(),
                severity: alert.severity.clone(),
                state: alert.state.clone(),
                title: alert.title.clone(),
                detail: Some(alert.detail.clone()),
                target_id: alert.target_id.clone(),
                fixes: alert
                    .fixes
                    .iter()
                    .map(|fix| WatchdogFix {
                        kind: fix.kind.clone(),
                        label: fix.label.clone(),
                        url: fix.url.clone(),
                    })
                    .collect(),
            })
            .collect();
        sources::watchdog::sync_watchdog_alerts(
            &mut self.store,
            &self.watchdog,
            &next,
            &view.withdrawn,
            now(),
        );
        self.watchdog = next;
    }
    pub(super) fn acknowledge(&self, key: &str) {
        let ids: Vec<_> = sources::watchdog::alerts_to_acknowledge(key, &self.watchdog)
            .into_iter()
            .map(|a| a.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            for id in ids {
                studio.acknowledge_watchdog_alert(&id).await;
            }
        });
    }
    pub(super) fn watchdog_job(&self, key: &str, id: &str) -> Option<Job> {
        match sources::watchdog::watchdog_press(key, id, &self.watchdog)? {
            WatchdogPress::SnoozeForStream { alert } => Some(Job::Snooze(alert.id.clone())),
            WatchdogPress::Fix { alert, fix } => match fix.kind.as_str() {
                "unmute" => Some(Job::Unmute),
                "reconnect-destination" => alert.target_id.clone().map(Job::Reconnect),
                _ => None,
            },
        }
    }
    pub(super) fn run_watchdog(&mut self, job: Job, key: &str, cx: &mut Context<Self>) {
        let key = key.to_owned();
        self.busy.insert(key.clone());
        cx.notify();
        let studio = self.studio.clone();
        let task = self.runtime.spawn(async move {
            match job {
                Job::Unmute => {
                    studio.request_microphone_mute(false).await;
                }
                Job::Snooze(id) => studio.snooze_watchdog_alert(&id, SnoozeScope::Stream).await,
                Job::Reconnect(id) => studio.reconnect_watchdog_destination(&id).await,
            }
        });
        cx.spawn(async move |entity, cx| {
            let _ = task.await;
            let _ = entity.update(cx, |this, cx| {
                this.busy.remove(&key);
                cx.notify();
            });
        })
        .detach();
    }
}
