//! S1.6c: Videorc Cloud in the Studio: the status `cloud.state` keeps current
//! (`commitCloudStatus` in `use-studio.tsx`) and the user's actions on it
//! (`lib/cloud-notices.ts`). What the cloud reports on its own (a fallback,
//! a lost show, a restart, the cap, the announcement) is a notification since
//! plan 250 and lands with the notification centre (S1.6e).

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::cloud_outputs::{self, CloudTestOutput};
use crate::livestream::cloud_show::HAND_OFF_UNCONFIRMED;
use crate::livestream::cloud_status::CloudStatus;
use crate::livestream::cloud_view::{CLOUD_TOAST_ID, UploadPlan};
use crate::notices::{NoticeCommand, ToastRequest};
use crate::user_error::{UserErrorContext, backend_error_toast};

/// The backend's push of the whole status.
pub const CHANGED_EVENT: &str = "cloud.state";
/// Plan 243 D10: focus asks videorc.com at most this often.
pub const CHECK_INTERVAL_MS: u64 = 10_000;

const STATUS: &str = "cloud.status";
const SETTINGS_SET: &str = "cloud.settings.set";
const ALLOWANCE_REFRESH: &str = "cloud.allowance.refresh";
const SHOW_END: &str = "cloud.show.end";
const SHOW_HAND_OFF: &str = "cloud.show.handOff";
const SHOW_CHECK: &str = "cloud.show.check";
const SELFTEST_RUN: &str = "cloud.selftest.run";

/// What the Destinations' cloud section and the Studio read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloudState {
    /// `None` until the backend answered; an older one has no cloud and the
    /// section stays away.
    pub status: Option<CloudStatus>,
    /// Plan 243 D7: the session, recording and show ids a hand-off stopped.
    /// Their platform cleanup is the other device's (`latchHandOff`).
    pub handed_off: Vec<String>,
    checked_at_ms: u64,
}

/// `here`: this computer is on air, not waiting for a device.
fn on_air_here(status: Option<&CloudStatus>) -> bool {
    status
        .and_then(|status| status.on_air.as_ref())
        .is_some_and(|on_air| on_air.this_device && !on_air.waiting)
}

/// `checkCloudShow`'s gate: a clock set back never blocks the check.
pub fn cloud_check_due(checked_at_ms: u64, now_ms: u64) -> bool {
    now_ms < checked_at_ms || now_ms - checked_at_ms >= CHECK_INTERVAL_MS
}

impl<B: StudioBackend> Studio<B> {
    pub fn cloud(&self) -> watch::Receiver<CloudState> {
        self.cloud_tx.subscribe()
    }

    pub fn cloud_now(&self) -> CloudState {
        self.cloud_tx.borrow().clone()
    }

    fn edit_cloud(&self, edit: impl FnOnce(&mut CloudState) -> bool) {
        self.cloud_tx.send_if_modified(edit);
    }

    /// `cloudUploadPlan(captureConfig)`: the section's upload line.
    pub fn cloud_upload_plan(&self) -> Option<UploadPlan> {
        cloud_outputs::cloud_upload_plan(&self.snapshot().settings.capture_doc)
    }

    /// `cloudTestOutputs(captureConfig)`: what Test pushes.
    pub fn cloud_test_outputs(&self) -> Vec<CloudTestOutput> {
        cloud_outputs::cloud_test_outputs(&self.snapshot().settings.capture_doc)
    }

    /// `commitCloudStatus`: a hand-off (`stoppedBy` new) latches the ids it
    /// stopped, sent before the session stops so its stop completes nothing;
    /// this computer back on air (Continue here) ends the latch.
    pub(super) fn commit_cloud_status(&self, next: CloudStatus) {
        let recording_session = self.lock().session.status().session_id.clone();
        self.edit_cloud(|state| {
            let previous = state.status.take();
            let stopped_before = previous
                .as_ref()
                .is_some_and(|previous| previous.stopped_by.is_some());
            if next.stopped_by.is_some() && !stopped_before {
                state.handed_off = [
                    next.session_id.clone(),
                    recording_session,
                    next.show.as_ref().map(|show| show.id.clone()),
                ]
                .into_iter()
                .flatten()
                .filter(|id| !id.is_empty())
                .collect();
            } else if on_air_here(Some(&next)) && !on_air_here(previous.as_ref()) {
                state.handed_off.clear();
            }
            state.status = Some(next);
            true
        });
    }

    /// The status once per connection; an older backend has no cloud.
    pub(super) async fn read_cloud(&self) {
        if let Ok(status) = self.cloud_request(STATUS, Value::Null).await {
            self.commit_cloud_status(status);
        }
    }

    pub(super) fn handle_cloud_event(&self, event: &str, payload: &Value) -> bool {
        if event != CHANGED_EVENT {
            return false;
        }
        match CloudStatus::from_value(payload) {
            Some(status) => self.commit_cloud_status(status),
            None => self
                .config
                .logger
                .warn(format!("Studio: \"{CHANGED_EVENT}\" did not read.")),
        }
        true
    }

    async fn cloud_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<CloudStatus, RpcError> {
        let answer = self.backend.livestream_request(method, params).await?;
        CloudStatus::from_value(&answer).ok_or_else(|| {
            RpcError::new(method, "unreadable", "Videorc Cloud's answer did not read.")
        })
    }

    /// `toastUserError(error, context, { id: CLOUD_TOAST_ID })`.
    fn toast_cloud_error(&self, error: &RpcError, action: &'static str, object: &'static str) {
        let connected = self.is_connected();
        if let Some(NoticeCommand::Show(mut notice)) =
            backend_error_toast(error, connected, UserErrorContext { action, object })
        {
            notice.id = Some(CLOUD_TOAST_ID.to_string());
            self.post(vec![NoticeCommand::Show(notice)]);
        }
    }

    /// An action that answers with the status: committed, or its error
    /// toasted.
    async fn cloud_action(
        &self,
        method: &'static str,
        params: Value,
        action: &'static str,
        object: &'static str,
    ) {
        match self.cloud_request(method, params).await {
            Ok(status) => self.commit_cloud_status(status),
            Err(error) => self.toast_cloud_error(&error, action, object),
        }
    }

    /// `setCloudSettings`: a `CloudSettingsPatch` (`enabled`,
    /// `holdMaxSeconds`, `holdImageScreenId`).
    pub async fn set_cloud_settings(&self, patch: Value) {
        self.cloud_action(SETTINGS_SET, patch, "save", "the Videorc Cloud setting")
            .await;
    }

    /// `refreshCloudAllowance`: silent; the section keeps the hours it last
    /// had, and signed out says so itself.
    pub async fn refresh_cloud_allowance(&self) {
        if let Ok(status) = self.cloud_request(ALLOWANCE_REFRESH, Value::Null).await {
            self.commit_cloud_status(status);
        }
    }

    /// `endCloudShow`.
    pub async fn end_cloud_show(&self) {
        self.cloud_action(SHOW_END, Value::Null, "end", "the stream on Videorc Cloud")
            .await;
    }

    /// `handOffCloudShow` (plan 243 C5): true when this computer stopped
    /// feeding, so a leaving app may go. An answer videorc.com did not
    /// confirm is still a hand-off, said once; only an error keeps the app.
    pub async fn hand_off_cloud_show(&self) -> bool {
        match self
            .backend
            .livestream_request(SHOW_HAND_OFF, Value::Null)
            .await
        {
            Ok(answer) => {
                if !answer["confirmed"].as_bool().unwrap_or(false) {
                    self.post(vec![NoticeCommand::Show(
                        ToastRequest::info(HAND_OFF_UNCONFIRMED)
                            .id(CLOUD_TOAST_ID)
                            .finish(),
                    )]);
                }
                true
            }
            Err(error) => {
                self.toast_cloud_error(&error, "continue on another device", "");
                false
            }
        }
    }

    /// `checkCloudShow` (plan 243 D10): on focus, a show live from another
    /// device, at most once per 10 s. The caller skips it while this
    /// computer is live.
    pub async fn check_cloud_show(&self, now_ms: u64) {
        let mut due = false;
        self.edit_cloud(|state| {
            due = cloud_check_due(state.checked_at_ms, now_ms);
            if due {
                state.checked_at_ms = now_ms;
            }
            false
        });
        if due {
            let _ = self
                .backend
                .livestream_request(SHOW_CHECK, Value::Null)
                .await;
        }
    }

    /// `runCloudTest`: the row shows the result; only a refused click
    /// toasts.
    pub async fn run_cloud_test(&self) {
        let outputs = self.cloud_test_outputs();
        self.cloud_action(
            SELFTEST_RUN,
            json!({ "outputs": outputs }),
            "test",
            "Videorc Cloud",
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_focus_check_waits_ten_seconds_unless_the_clock_went_back() {
        assert!(cloud_check_due(0, 10_000));
        assert!(!cloud_check_due(10_000, 19_999));
        assert!(cloud_check_due(10_000, 20_000));
        assert!(cloud_check_due(10_000, 5_000));
    }
}
