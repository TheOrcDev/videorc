//! S1.6c: Videorc Cloud in the Studio: the status `cloud.state` keeps current
//! (`commitCloudStatus` in `use-studio.tsx`) and the user's actions on it
//! (`lib/cloud-notices.ts`). What the cloud reports on its own (a fallback,
//! a lost show, a restart, the cap, the announcement) is a notification since
//! plan 250 and lands with the notification centre (S1.6e).
//!
//! Back in the room by itself after a backend restart (owner call
//! 2026-11-19; `use-talk-show-room.ts`' rejoin effect over
//! `lib/talk-show-auto-rejoin.ts`, here `guests::session::run_auto_rejoin`):
//! the room this app had open is asked for again once per connection, and
//! [`CloudState::talk_rejoining`] (`talkShow.rejoining`) says so meanwhile.
//!
//! The status also drives the platform cleanup (`platform_lifecycle`): a
//! hand-off drops the session's owner, and the show's end settles its
//! cleanup unless the show was handed off (`cloudTerminalOwner`).

use serde_json::{Value, json};
use tokio::sync::watch;

use super::screen_views::cloud_recording_active;
use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::guests::session::{
    AutoRejoinFailure, AutoRejoinHeld, AutoRejoinIo, AutoRejoinOutcome, TalkShowFacts,
    run_auto_rejoin,
};
use crate::livestream::cloud_outputs::{self, CloudTestOutput};
use crate::livestream::cloud_provider::cloud_terminal_owner;
use crate::livestream::cloud_show::HAND_OFF_UNCONFIRMED;
use crate::livestream::cloud_status::CloudStatus;
use crate::livestream::cloud_view::{CLOUD_TOAST_ID, UploadPlan};
use crate::livestream::platform_owner::Owner;
use crate::notices::{NoticeCommand, ToastRequest};
use crate::user_error::{Failure, UserErrorContext, backend_error_toast, toast_user_error};

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
const RECORDING_STOP: &str = "cloud.recording.stop";
const ROOM_RESUME: &str = "cloud.room.resume";
/// `stopCloudRecording`'s failure: "Couldn't stop the cloud recording".
const STOP_THE_CLOUD_RECORDING: UserErrorContext = UserErrorContext {
    action: "stop the cloud recording",
    object: "",
};

/// What the Destinations' cloud section and the Studio read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloudState {
    /// `None` until the backend answered; an older one has no cloud and the
    /// section stays away.
    pub status: Option<CloudStatus>,
    /// Plan 243 D7: the session, recording and show ids a hand-off stopped.
    /// Their platform cleanup is the other device's (`latchHandOff`).
    pub handed_off: Vec<String>,
    /// Stop recording's `cloud.recording.stop` is out (`stopRequestPending`
    /// in a talk show): Record reads "Stopping…" and a second click waits.
    pub recording_stop_pending: bool,
    /// `talkShow.rejoining`: the Studio is going back into its talk show's
    /// room by itself after a backend restart. The Resume notice reads
    /// "Reconnecting to your show…" and its Resume waits.
    pub talk_rejoining: bool,
    /// Gallery/smoke only (`gallery-seed-show-stage`): synthetic room media
    /// so Show stage tiles and the host camera-off avatar paint without a
    /// LiveKit room. Cleared when the seed is `closed`. Never set from a
    /// real `cloud.room.presentation`.
    pub gallery_room_media: Option<crate::studio::room_media::RoomMedia>,
    /// `heldRoomRef`: the show whose room this app has open, and the
    /// connection (the bootstrap generation) that held it.
    held_room: Option<(String, u64)>,
    /// `autoResumedRef`: the connection this app already sent its own
    /// resume to.
    auto_resumed: Option<u64>,
    checked_at_ms: u64,
}

/// Ends `talk_rejoining` however the rejoin ends, a replaced (dropped)
/// attempt included (the effect's cleanup: `setRejoining(false)`).
struct TalkRejoining<'a>(&'a watch::Sender<CloudState>);

impl Drop for TalkRejoining<'_> {
    fn drop(&mut self) {
        self.0
            .send_if_modified(|state| std::mem::take(&mut state.talk_rejoining));
    }
}

/// `cloudStatus.room.phase === 'open'`.
fn room_open(status: &CloudStatus) -> bool {
    status
        .room
        .as_ref()
        .and_then(|room| room.get("phase"))
        .and_then(Value::as_str)
        == Some("open")
}

/// What one connection's rejoin needs from the Studio (`runAutoRejoin`'s
/// callbacks).
struct RejoinIo<'a, B: StudioBackend> {
    studio: &'a Studio<B>,
    generation: u64,
    /// The resume's answer, for the commit after it.
    resumed: Option<CloudStatus>,
}

impl<B: StudioBackend> RejoinIo<'_, B> {
    async fn ask(&mut self, method: &'static str) -> anyhow::Result<(Value, TalkShowFacts)> {
        let answer = self
            .studio
            .backend
            .livestream_request(method, Value::Null)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let facts = serde_json::from_value::<TalkShowFacts>(answer.clone())?;
        Ok((answer, facts))
    }
}

impl<B: StudioBackend> AutoRejoinIo for RejoinIo<'_, B> {
    async fn read_status(&mut self) -> anyhow::Result<TalkShowFacts> {
        let (answer, facts) = self.ask(STATUS).await?;
        // `onStatus`: each status the backend answered, for the Studio to
        // show (never one a newer connection overtook).
        if !self.cancelled()
            && let Some(status) = CloudStatus::from_value(&answer)
        {
            self.studio.commit_cloud(status).await;
        }
        Ok(facts)
    }

    async fn resume(&mut self) -> anyhow::Result<TalkShowFacts> {
        let generation = self.generation;
        self.studio.edit_cloud(|state| {
            state.auto_resumed = Some(generation);
            false
        });
        let (answer, facts) = self.ask(ROOM_RESUME).await?;
        self.resumed = CloudStatus::from_value(&answer);
        Ok(facts)
    }

    async fn sleep(&mut self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }

    fn cancelled(&self) -> bool {
        self.studio.lock().bootstrap_generation != self.generation
    }

    fn on_reconnecting(&mut self) {
        self.studio.edit_cloud(|state| {
            let changed = !state.talk_rejoining;
            state.talk_rejoining = true;
            changed
        });
    }
}

/// Clears `recording_stop_pending` however the stop ends, a dropped future
/// included.
struct RecordingStopPending<'a>(&'a watch::Sender<CloudState>);

impl Drop for RecordingStopPending<'_> {
    fn drop(&mut self) {
        self.0
            .send_if_modified(|state| std::mem::take(&mut state.recording_stop_pending));
    }
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
    /// stopped, sent before the session stops so its stop completes nothing,
    /// and drops the session's platform owner; this computer back on air
    /// (Continue here) ends the latch. A show that ended (not handed off,
    /// no stop running) gives its owner back to be settled.
    fn commit_cloud_status(&self, next: CloudStatus) -> Option<Owner> {
        let (recording_session, stopping, generation) = {
            let inner = self.lock();
            (
                inner.session.status().session_id.clone(),
                inner.session.stop_pending(),
                inner.bootstrap_generation,
            )
        };
        // `heldRoomRef`: the room this app has open, under this connection.
        let open_show = next
            .show
            .as_ref()
            .map(|show| show.id.clone())
            .filter(|id| !id.is_empty() && room_open(&next));
        let mut latched = None;
        let mut terminal = None;
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
                latched = Some(state.handed_off.clone());
            } else if on_air_here(Some(&next)) && !on_air_here(previous.as_ref()) {
                state.handed_off.clear();
            }
            terminal = cloud_terminal_owner(previous.as_ref(), &next)
                .filter(|id| !state.handed_off.contains(id));
            match open_show {
                Some(show) => state.held_room = Some((show, generation)),
                // Closed, ended or taken over under the connection that held
                // it: nothing is owed to a later restart.
                None => {
                    if state
                        .held_room
                        .as_ref()
                        .is_some_and(|(_, held)| *held == generation)
                    {
                        state.held_room = None;
                    }
                }
            }
            state.status = Some(next);
            true
        });
        if let Some(handed_off) = latched {
            self.platform.drop_handed_off(&handed_off);
        }
        let terminal = terminal.filter(|_| !stopping)?;
        self.platform.next_run();
        self.platform.claim(&terminal)
    }

    /// `commitCloudStatus`, then the ended show's platform cleanup.
    pub(super) async fn commit_cloud(&self, next: CloudStatus) {
        self.feed_dashboard_cloud(&next);
        if let Some(owner) = self.commit_cloud_status(next) {
            self.settle_cloud_terminal(owner).await;
        }
    }

    /// The status once per connection; an older backend has no cloud.
    pub(super) async fn read_cloud(&self) {
        if let Ok(status) = self.cloud_request(STATUS, Value::Null).await {
            self.commit_cloud(status).await;
        }
    }

    /// The show whose room an earlier connection held and this one was not
    /// asked to resume yet (`held.client !== client && autoResumedRef.current
    /// !== client`): the rejoin's work.
    pub(super) fn talk_room_rejoin_due(&self) -> Option<(String, u64)> {
        let generation = self.lock().bootstrap_generation;
        let state = self.cloud_tx.borrow();
        match &state.held_room {
            Some((show, held)) if *held != generation && state.auto_resumed != Some(generation) => {
                Some((show.clone(), generation))
            }
            _ => None,
        }
    }

    /// Back in the room by itself after a backend restart: a restarted
    /// backend takes the host out of the room and holds the show as
    /// resumable until someone asks for it. This asks, once per connection,
    /// when the room it had open is still this computer's
    /// (`auto_rejoin_decision`); the resume it sends is the one the notice's
    /// button sends. [`Studio::drive`] runs it beside the events, and a
    /// newer connection's attempt replaces (drops) it.
    pub(super) async fn rejoin_talk_room(&self) {
        let Some((show_id, generation)) = self.talk_room_rejoin_due() else {
            return;
        };
        let _rejoining = TalkRejoining(&self.cloud_tx);
        let mut io = RejoinIo {
            studio: self,
            generation,
            resumed: None,
        };
        let outcome = run_auto_rejoin(&AutoRejoinHeld { show_id }, &mut io).await;
        let resumed = io.resumed.take();
        match outcome {
            AutoRejoinOutcome::Cancelled => {}
            AutoRejoinOutcome::Resumed(_) => {
                self.edit_cloud(|state| std::mem::take(&mut state.talk_rejoining));
                if let Some(status) = resumed {
                    self.commit_cloud(status).await;
                }
            }
            ended => {
                // Whatever ended it, this room is not asked for again by
                // itself.
                self.edit_cloud(|state| {
                    if state
                        .held_room
                        .as_ref()
                        .is_some_and(|(_, held)| *held != generation)
                    {
                        state.held_room = None;
                    }
                    std::mem::take(&mut state.talk_rejoining)
                });
                if let AutoRejoinOutcome::Failed(failure) = ended {
                    let reason = match failure {
                        AutoRejoinFailure::Unconfirmed => {
                            "the show was not confirmed as this computer's".to_string()
                        }
                        AutoRejoinFailure::ResumeFailed(reason) => {
                            reason.unwrap_or_else(|| "the resume failed".to_string())
                        }
                    };
                    self.config.logger.warn(format!(
                        "[talk-show] could not rejoin the room by itself: {reason}"
                    ));
                }
            }
        }
    }

    pub(super) async fn handle_cloud_event(&self, event: &str, payload: &Value) -> bool {
        if event != CHANGED_EVENT {
            return false;
        }
        match CloudStatus::from_value(payload) {
            Some(status) => self.commit_cloud(status).await,
            None => self
                .config
                .logger
                .warn(format!("Studio: \"{CHANGED_EVENT}\" did not read.")),
        }
        true
    }

    pub(super) async fn cloud_request(
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
            Ok(status) => self.commit_cloud(status).await,
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
            self.commit_cloud(status).await;
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

    /// `talkShow.stopCloudRecording`: Record's Stop recording while the room
    /// is open (`stopOutput('recording')` in a talk show). True once the
    /// answer says this show's cloud recording stopped.
    ///
    /// As in Electron, a stop that did not happen (not recording, the show
    /// handed off, an error or an answer that still records) ends on one
    /// toast under the cloud's id: "Couldn't stop the cloud recording". A
    /// click while the request is out does nothing.
    pub async fn stop_cloud_recording(&self) -> bool {
        let mut waiting = false;
        let mut began = false;
        let mut show_id = None;
        self.edit_cloud(|state| {
            if state.recording_stop_pending {
                waiting = true;
                return false;
            }
            show_id = state
                .status
                .as_ref()
                .and_then(|status| status.show.as_ref())
                .map(|show| show.id.clone())
                .filter(|id| !id.is_empty());
            began = cloud_recording_active(state.status.as_ref())
                && show_id
                    .as_ref()
                    .is_some_and(|id| !state.handed_off.contains(id));
            state.recording_stop_pending = began;
            began
        });
        if waiting {
            return false;
        }
        if !began {
            self.toast_recording_not_stopped();
            return false;
        }
        let _pending = RecordingStopPending(&self.cloud_tx);
        let stopped = match self.cloud_request(RECORDING_STOP, Value::Null).await {
            Ok(status) => {
                let stopped = status.show.as_ref().map(|show| &show.id) == show_id.as_ref()
                    && !cloud_recording_active(Some(&status));
                self.commit_cloud(status).await;
                stopped
            }
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: \"{RECORDING_STOP}\" failed ({}).",
                    error.message
                ));
                false
            }
        };
        if !stopped {
            self.toast_recording_not_stopped();
        }
        stopped
    }

    /// `onError(new Error('The cloud recording has not stopped.'), …)`: the
    /// generic reason, under the cloud's id.
    fn toast_recording_not_stopped(&self) {
        let error = RpcError::new(
            RECORDING_STOP,
            "not-stopped",
            "The cloud recording has not stopped.",
        );
        if let Some(command) = toast_user_error(
            Failure::Rpc(&error),
            STOP_THE_CLOUD_RECORDING,
            CLOUD_TOAST_ID,
        ) {
            self.post(vec![command]);
        }
    }

    /// `cloud.room.open` (Guests ⌘7).
    ///
    /// Plan 249 S17 (`talkShowOutputs`): the room opens with the outputs
    /// `talk_show_output_plan` decides from the saved settings, and a plan
    /// with a problem refuses before anything is created, toasted like any
    /// refusal.
    pub async fn open_talk_room(&self, title: Option<String>, platforms: Vec<String>) {
        let plan = crate::livestream::talk_show_outputs::talk_show_output_plan(
            &self.snapshot().settings.capture_doc,
        );
        if let Some(problem) = plan.problem {
            // The plan's problem is already Videorc's sentence.
            let failure = Failure::Sentence {
                text: &problem,
                warning: false,
            };
            let context = UserErrorContext {
                action: "open",
                object: "the room",
            };
            if let Some(command) = toast_user_error(failure, context, CLOUD_TOAST_ID) {
                self.post(vec![command]);
            }
            return;
        }
        let mut params = json!({ "platforms": platforms, "outputs": plan.outputs });
        if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
            params["title"] = json!(title);
        }
        self.cloud_action("cloud.room.open", params, "open", "the room")
            .await;
    }

    /// `talkShow.resumeRoom` (plan 224 C-G8): the Studio's Resume notice for
    /// a talk show rejoins its room (`cloud.room.resume`). No local session
    /// starts, so no local source can block it.
    pub async fn resume_talk_room(&self) {
        self.cloud_action("cloud.room.resume", Value::Null, "resume", "the show")
            .await;
    }

    /// `cloud.room.close`.
    pub async fn close_talk_room(&self) {
        self.cloud_action("cloud.room.close", Value::Null, "close", "the room")
            .await;
    }

    /// Gallery/smoke only: commit a synthetic talk-show `CloudStatus` and
    /// optional room media (plan 260 C4). No LiveKit, X or YouTube.
    ///
    /// Room media is written **before** the status commit so the host's
    /// cloud watch applies tiles / camera-off on the same open pulse (a
    /// media-after-commit race left open/screens/host-camera-off identical).
    pub async fn seed_gallery_show_stage(
        &self,
        kind: crate::studio::gallery_show_stage::GalleryShowStage,
    ) {
        let status = crate::studio::gallery_show_stage::gallery_cloud_status(kind);
        let media = crate::studio::gallery_show_stage::gallery_room_media(kind);
        self.edit_cloud(|state| {
            let changed = state.gallery_room_media != media;
            state.gallery_room_media = media;
            changed
        });
        self.commit_cloud(status).await;
    }

    /// `cloud.room.invite.rotate`.
    pub async fn rotate_talk_invite(&self) {
        self.cloud_action(
            "cloud.room.invite.rotate",
            Value::Null,
            "make",
            "a new link",
        )
        .await;
    }

    /// `cloud.room.door.set`.
    pub async fn set_talk_door(&self, open: bool) {
        self.cloud_action(
            "cloud.room.door.set",
            json!({ "open": open }),
            "change",
            "the door",
        )
        .await;
    }

    /// `cloud.guest.decide` (`let-in` / `decline`).
    pub async fn decide_talk_guest(&self, request_id: &str, decision: &str) {
        let action = if decision == "let-in" {
            "let the guest in"
        } else {
            "decline the guest"
        };
        self.cloud_action(
            "cloud.guest.decide",
            json!({ "requestId": request_id, "decision": decision }),
            action,
            "",
        )
        .await;
    }

    /// `cloud.guest.act` (mute / unmute / remove / ban / rename /
    /// allow-screen-share / disallow-screen-share). True once the web
    /// answers; false when toasted.
    pub async fn act_talk_guest(&self, guest_id: &str, action: &str, name: Option<String>) -> bool {
        let mut params = json!({ "guestId": guest_id, "action": action });
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            params["name"] = json!(name);
        }
        let (verb, object) = match action {
            "mute" => ("mute", "the guest"),
            "unmute" => ("unmute", "the guest"),
            "remove" => ("remove", "the guest"),
            "ban" => ("ban", "the guest"),
            "rename" => ("rename", "the guest"),
            "allow-screen-share" => ("allow", "screen sharing"),
            "disallow-screen-share" => ("stop", "screen sharing"),
            _ => ("change", "the guest"),
        };
        match self.cloud_request("cloud.guest.act", params).await {
            Ok(status) => {
                self.commit_cloud(status).await;
                true
            }
            Err(error) => {
                self.toast_cloud_error(&error, verb, object);
                false
            }
        }
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
