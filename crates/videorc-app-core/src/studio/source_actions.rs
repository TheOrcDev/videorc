//! Plan 260 S1.6b part 5a: the Studio's source choice, as `use-studio.tsx`
//! makes it (`switchSourceDeviceLive` ~12954, `sourceSwitchReason` ~5579,
//! the working sources' reconcile on every device list ~8130, the live
//! controller's `confirmed` ~5527, and a saved scene's microphone inside a
//! session ~12693), from `videorc-rust`'s plan 220 port, moved onto plan
//! 231's scenes.
//!
//! - Idle, a pick lands in the capture config at once (only its own kind's
//!   fields, `mergeSourceKind`). A Screen pick never leaves the scene on
//!   stream (plan 231 D2): idle it is that scene's screen at once
//!   ([`Studio::set_scene_on_stream_shows`]), and the working app goes.
//! - While a session runs, the pick goes through `session.source.switch`
//!   ([`super::live_sources`]); what the backend confirms lands in the
//!   capture config through [`Studio::note_session_sources_confirmed`]:
//!   only the microphone while a scene commit waits for its proof (#1543),
//!   and a confirmed screen saves into the scene on stream (D11).
//! - Every device list reconciles the working sources while nothing runs and
//!   no scene commit waits for its proof (`reconcileWorkingSceneSources`): a
//!   remembered device by UUID, id or name, a stand-in for one that is gone,
//!   the first device for a profile that never chose (unless the config
//!   withholds defaults). For a scene made for an app, what the resolver
//!   said is the scene's app state (`resolvedAppStates`, part 5e).
//! - Part 5e: an idle screen or camera pick made while the scene editor is
//!   open loads the scene (the editor holds the idle reload), and a start
//!   finds a picked window that was closed and reopened under its new id
//!   (plan 219 S3, `rebindRememberedWindow`).
//!
//! Not here: rooms (plan 249: the room's camera and microphone controls, and
//! "Use the room screen-share control."), Hide screen (plan 231 D8 moved it
//! to the scene on stream's Screen field, the scenes section's), and the bell
//! (a returned pick is still a toast here, not `publishSourceReturn`).

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::live_sources::{
    self, Accepted, SOURCE_SWITCH_METHOD, SOURCES_GET_METHOD, SessionSources, SwitchFailure,
    SwitchRequest,
};
use super::scene_switch::RESOLVE_APP_WINDOW_METHOD;
use super::source_selection::{
    ReconcileOptions, SourceKind, build_camera_sources, build_capture_sources,
    build_microphone_sources, camera_picker_devices, capture_picker_devices, merge_source_kind,
    microphone_picker_devices, rebind_remembered_window, reconcile_source_selection,
    returning_source_choices, should_refresh_window_list_before_start,
    source_selection_change_events,
};
use super::{Connection, Inner, SettingWrite, Studio, StudioBackend, capture_config, keys};
use crate::notices::{NoticeAction, NoticeCommand, NoticeLifetime, ToastRequest};
use crate::scenes::model::{SceneMicrophone, visual_sources, without_scene_app};
use crate::scenes::v2::shows_from_sources;
use crate::scenes::window::{AppWindowFailure, SceneAppState};
use crate::user_error::{self, Failure, UserErrorContext};

/// A live source read's `finally`, on drop. Electron's read promise always
/// settles; a Rust future can be dropped at an `.await` (a closed window, a
/// timeout), which would leave `reading` set and every later refresh
/// waiting. The read that still owns the flag clears it here, a refresh
/// asked for meanwhile goes to the driver's timer, and the waiters wake.
struct LiveRead<'a, B: StudioBackend> {
    studio: &'a Studio<B>,
    generation: u64,
}

impl<B: StudioBackend> Drop for LiveRead<'_, B> {
    fn drop(&mut self) {
        let kick = {
            let mut guard = self.studio.lock();
            let inner = &mut *guard;
            let live = &mut inner.live_sources;
            let mut kick = false;
            if live.reading && live.read_owner == self.generation {
                live.reading = false;
                if live.read_dirty {
                    live.read_dirty = false;
                    if inner.live_due.is_none() {
                        inner.live_due = Some((Instant::now(), live.epoch, false));
                    }
                    kick = true;
                }
            }
            kick
        };
        if kick {
            self.studio.settings_retry.notify_one();
        }
        self.studio.live_read_done.notify_waiters();
    }
}

/// The refusal toast's id (`source-switch-blocked`).
const BLOCKED_TOAST_ID: &str = "source-switch-blocked";

/// The scene's microphone could not switch now (`applySavedScene`).
pub const SCENE_KEPT_MICROPHONE: &str = "The scene kept your current microphone.";

const SWITCH_THE_SOURCE: UserErrorContext = UserErrorContext {
    action: "switch",
    object: "the source",
};
const SWITCH_THE_MICROPHONE: UserErrorContext = UserErrorContext {
    action: "switch",
    object: "the microphone",
};

/// The capture config's `sources` as the Studio holds them now.
fn working_sources(inner: &mut Inner) -> Value {
    inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
    inner.capture.config["sources"].clone()
}

/// A live switch's send whose future was dropped before the backend
/// answered (Electron's `send` always settles). Left alone, `sending` stays
/// set: Check again does nothing and a read never sends the lost request
/// again. The answer counts as lost (`send_lost`), the send ends, and a
/// read is due at once to find what the session did. The answered ways out
/// forget it. Dropped with the Studio's lock free.
struct SendDropped<'a, B: StudioBackend> {
    studio: &'a Studio<B>,
    epoch: u64,
    generation: u64,
}

impl<B: StudioBackend> Drop for SendDropped<'_, B> {
    fn drop(&mut self) {
        let abandoned = {
            let mut guard = self.studio.lock();
            let inner = &mut *guard;
            let live = &mut inner.live_sources;
            let current =
                live.sending && live.epoch == self.epoch && live.send_generation == self.generation;
            if current {
                live.send_lost();
                live.end_send(self.epoch, self.generation);
                if inner.live_due.is_none() {
                    inner.live_due = Some((Instant::now(), self.epoch, false));
                }
            }
            current
        };
        if abandoned {
            self.studio.settings_retry.notify_one();
            self.studio.publish();
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    // --- why a picker waits ---

    /// `sourceSwitchReason(kind)`: the session's first read, a scene on its
    /// way, a start on its way, then the live controller's own reasons.
    pub fn source_switch_reason(&self, kind: SourceKind) -> Option<String> {
        let start_in_flight = self.start_in_flight();
        let inner = self.lock();
        source_switch_reason_of(&inner, kind, start_in_flight)
    }

    /// `sessionStartInFlightRef`: a Record or Go Live start is on its way.
    pub(super) fn start_in_flight(&self) -> bool {
        self.in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    // --- a pick ---

    /// A picker's choice by device id (`None` for None or Off), built as
    /// the pickers build it (`buildCaptureSources`, `buildCameraSources`,
    /// `buildMicrophoneSources`) and switched (`switchSourceDeviceLive`).
    pub async fn select_source_device(
        &self,
        kind: SourceKind,
        device_id: Option<&str>,
    ) -> Result<(), String> {
        let picked = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let current = working_sources(inner);
            let devices = &inner.sources.devices.devices;
            match kind {
                SourceKind::Capture => {
                    build_capture_sources(&current, &capture_picker_devices(devices), device_id)
                }
                SourceKind::Camera => {
                    build_camera_sources(&current, &camera_picker_devices(devices), device_id)
                }
                SourceKind::Microphone => build_microphone_sources(
                    &current,
                    &microphone_picker_devices(devices),
                    device_id,
                ),
            }
        };
        self.switch_source_device_live(kind, picked).await
    }

    /// A remote's screen (`sceneApply` with `screenId`): the capture
    /// sources the Screen picker would write for that screen or window
    /// (`buildCaptureSources`), or `None` when the picker lists no screen
    /// or window by that id.
    pub(super) fn capture_sources_for(&self, device_id: &str) -> Option<Value> {
        let mut guard = self.lock();
        let inner = &mut *guard;
        let current = working_sources(inner);
        let devices = capture_picker_devices(&inner.sources.devices.devices);
        let listed = devices.iter().any(|device| {
            device.id == device_id
                && matches!(
                    device.kind,
                    videorc_protocol::DeviceKind::Screen | videorc_protocol::DeviceKind::Window
                )
        });
        listed.then(|| build_capture_sources(&current, &devices, Some(device_id)))
    }

    /// `switchSourceDeviceLive(kind, sources)`: refused with a warning while
    /// a picker must wait; a Screen pick is the scene on stream's screen
    /// (D2); idle, the capture config takes the pick; while a session runs,
    /// the live switch.
    pub async fn switch_source_device_live(
        &self,
        kind: SourceKind,
        picked: Value,
    ) -> Result<(), String> {
        if let Some(blocked) = self.source_switch_reason(kind) {
            // A refusal is "can't now", never an error (plan 174 S2.4).
            self.post(vec![NoticeCommand::Show(
                ToastRequest::warning(blocked.clone())
                    .id(BLOCKED_TOAST_ID)
                    .description(live_sources::copy::TRY_AGAIN)
                    .finish(),
            )]);
            return Err(blocked);
        }
        if kind == SourceKind::Capture {
            // Plan 231 D2: a Screen pick changes the screen of the scene on
            // stream. It never leaves the scene, and a scene made for an app
            // shows the picked screen from now on (the working app goes).
            // Idle, the pick is the scene's screen at once; a recording or
            // livestream confirms the switch first, and that commit saves it
            // (D11, `note_session_sources_confirmed`).
            self.set_scene_on_stream_shows(shows_from_sources(&visual_sources(&picked)))
                .await;
        }
        if !self.session_owns_transport() {
            return self.commit_idle_pick(kind, &picked).await;
        }
        // The Off, None and stand-in wishes are the app's: recorded before the
        // backend confirms only the device (plan 080 S4, plan 213 E1).
        let wish_fields: &[&str] = match kind {
            SourceKind::Camera => &["cameraOff", "wantedCameraId", "wantedCameraName"],
            SourceKind::Capture => &[
                "captureOff",
                "wantedScreenId",
                "wantedScreenName",
                "wantedScreenUuid",
                "wantedWindowId",
                "wantedWindowName",
            ],
            SourceKind::Microphone => &["microphoneOff"],
        };
        let wishes_changed = {
            let mut guard = self.lock();
            let current = working_sources(&mut guard);
            wish_fields
                .iter()
                .any(|field| current.get(*field) != picked.get(*field))
        };
        if wishes_changed {
            let wishes = picked.clone();
            let _ = self
                .update_capture_config(|config| {
                    let mut sources = config["sources"].clone();
                    if let Value::Object(map) = &mut sources {
                        for field in wish_fields {
                            match wishes.get(*field) {
                                Some(value) => map.insert((*field).to_string(), value.clone()),
                                None => map.remove(*field),
                            };
                        }
                    }
                    config["sources"] = sources;
                })
                .await;
        }
        let (device_id, target_name) = picked_device(kind, &picked);
        self.select_live_source(kind, device_id, target_name, SWITCH_THE_SOURCE)
            .await
    }

    /// The idle pick (`setCaptureConfig` with `mergeSourceKind`), written
    /// before anything awaits, so a chained layout commit reads it.
    async fn commit_idle_pick(&self, kind: SourceKind, picked: &Value) -> Result<(), String> {
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let mut next = inner.capture.config.clone();
            next["sources"] = merge_source_kind(&next["sources"], picked, kind);
            let stored = capture_config::stored_capture_config(&next);
            inner
                .stage_writes(
                    &[SettingWrite::Put {
                        key: keys::CAPTURE_CONFIG.to_string(),
                        value: stored.clone(),
                    }],
                    &self.config.logger,
                )
                .map_err(|error| error.message)?;
            inner.capture.set(next, Some(stored));
        }
        self.publish();
        let saved = match self.flush_settings().await {
            Ok(()) => Ok(()),
            Err(error) if super::settings_write_kept(&error) => Ok(()),
            Err(error) => Err(error.message),
        };
        // `ensureNativePreviewScreen`: the screen capture follows the pick,
        // or the preview keeps the screen captured before it.
        if kind == SourceKind::Capture {
            self.start_picked_screen_capture().await;
        }
        // Part 5e (`switchSourceDeviceLive`): the scene editor holds the idle
        // reload, so a screen or camera pick made while it is open loads the
        // scene with the pick (`loadScene`, failures reported).
        if kind != SourceKind::Microphone && self.lock().scene_edit_mode {
            self.reload_editor_scene().await;
        }
        saved
    }

    /// The editor's `loadScene(...).catch(reportError)`.
    async fn reload_editor_scene(&self) {
        let Err(error) = self.load_scene_from_capture_config().await else {
            return;
        };
        self.config.logger.warn(format!(
            "Studio: the scene editor's reload after a pick failed: {} ({})",
            error.message, error.code
        ));
        let connected = matches!(self.lock().connection, Connection::Connected { .. });
        if let Some(command) = user_error::backend_error_toast(&error, connected, SWITCH_THE_SOURCE)
        {
            self.post(vec![command]);
        }
    }

    /// `setSceneEditMode`: the Scene page's canvas editor opened or closed.
    pub fn set_scene_edit_mode(&self, on: bool) {
        let changed = {
            let mut inner = self.lock();
            let changed = inner.scene_edit_mode != on;
            inner.scene_edit_mode = on;
            changed
        };
        if changed {
            self.publish();
        }
    }

    // --- the live switch ---

    /// `sourceSelectionController.select`: the fence closes at once; the
    /// request carries the protected windows; a lost answer is checked.
    async fn select_live_source(
        &self,
        kind: SourceKind,
        device_id: Option<String>,
        target_name: Option<String>,
        context: UserErrorContext,
    ) -> Result<(), String> {
        let (request, epoch) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let protected = inner.exclusion.wanted.clone();
            let request = inner.live_sources.begin_select(
                kind,
                device_id,
                target_name,
                uuid::Uuid::new_v4().to_string(),
                protected,
            );
            // `select` clears the proof timer before its first await.
            if request.is_ok() {
                inner.live_due = None;
            }
            (request, inner.live_sources.epoch)
        };
        let request = match request {
            Ok(request) => request,
            Err(reason) => {
                self.post(
                    user_error::toast_user_error(
                        Failure::Sentence {
                            text: &reason,
                            warning: true,
                        },
                        context,
                        "source-switch",
                    )
                    .into_iter()
                    .collect(),
                );
                return Err(reason);
            }
        };
        self.publish();
        let refresh = self.send_source_switch(request.clone(), epoch).await;
        if refresh {
            self.refresh_live_sources().await;
        }
        let checking = {
            let inner = self.lock();
            inner.live_sources.epoch == epoch
                && inner.live_sources.request_id() == Some(request.request_id.as_str())
                && inner.live_sources.view.checking
        };
        if checking {
            self.reconcile_live_sources(epoch).await;
        }
        Ok(())
    }

    /// A saved scene's microphone inside a recording or livestream
    /// (`applySavedScene`'s live half): when it is not the session's, the
    /// session's sources are read again (twice: a read in flight may predate
    /// the scene's commit), then switched (`{switch, the microphone}` on a
    /// failure). A picker that must wait keeps the current microphone and
    /// says so.
    pub(super) async fn switch_scene_microphone(&self, microphone: SceneMicrophone) {
        let differs = {
            let mut guard = self.lock();
            let current = working_sources(&mut guard);
            current.get("microphoneId").and_then(Value::as_str)
                != microphone.microphone_id.as_deref()
        };
        if !differs || !self.session_owns_transport() {
            return;
        }
        self.refresh_live_sources().await;
        self.refresh_live_sources().await;
        let blocked = self.lock().live_sources.reason(SourceKind::Microphone);
        if let Some(blocked) = blocked {
            self.post(vec![NoticeCommand::Show(
                ToastRequest::warning(blocked)
                    .id(BLOCKED_TOAST_ID)
                    .description(SCENE_KEPT_MICROPHONE)
                    .finish(),
            )]);
            return;
        }
        // Plan 0027: the session confirms only the device; None is the
        // app's wish.
        if microphone.microphone_off {
            let _ = self
                .update_capture_config(|config| {
                    capture_config::set_path(
                        config,
                        &["sources", "microphoneOff"],
                        Some(Value::Bool(true)),
                    );
                })
                .await;
        }
        if let Err(reason) = self
            .select_live_source(
                SourceKind::Microphone,
                microphone.microphone_id,
                microphone.microphone_name,
                SWITCH_THE_MICROPHONE,
            )
            .await
        {
            self.config.logger.warn(format!(
                "[scenes] the scene's microphone did not switch: {reason}"
            ));
        }
    }

    /// `send`: answers whether a read must follow (a refusal).
    async fn send_source_switch(&self, request: SwitchRequest, epoch: u64) -> bool {
        // `closeVisualMicrophoneStreams` has nothing to close: app-core opens
        // no meter stream of its own (it reads the backend's levels).
        let generation = self.lock().live_sources.begin_send();
        let params = serde_json::to_value(&request).unwrap_or(Value::Null);
        let dropped = SendDropped {
            studio: self,
            epoch,
            generation,
        };
        let answer = self
            .backend
            .sources_request(SOURCE_SWITCH_METHOD, params)
            .await;
        std::mem::forget(dropped);
        let (accepted, failure, refresh) = {
            let mut inner = self.lock();
            if !inner
                .live_sources
                .send_current(epoch, generation, &request.request_id)
            {
                inner.live_sources.end_send(epoch, generation);
                return false;
            }
            let outcome = match answer.and_then(|value| {
                super::backend::read_json::<SessionSources>(SOURCE_SWITCH_METHOD, value)
            }) {
                Ok(snapshot) => {
                    inner.live_sources.read_generation += 1;
                    inner.live_sources.reading = false;
                    let accepted = inner.live_sources.accept(snapshot, epoch);
                    (Some(accepted), None, false)
                }
                Err(error)
                    if error.code.starts_with("source-switch-")
                        || error.code == "invalid-params" =>
                {
                    let failure =
                        inner
                            .live_sources
                            .send_rejected(&request, &error.code, &error.message);
                    (None, failure, true)
                }
                Err(error) => {
                    self.config.logger.warn(format!(
                        "Studio: session.source.switch did not answer ({}): {}",
                        error.code, error.message
                    ));
                    inner.live_sources.send_lost();
                    (None, None, false)
                }
            };
            inner.live_sources.end_send(epoch, generation);
            outcome
        };
        self.publish();
        if let Some(failure) = failure {
            self.toast_switch_failure(&failure);
        }
        if let Some(accepted) = accepted {
            self.after_accept(accepted, epoch).await;
        }
        refresh
    }

    /// `refresh`: the session's whole source authority, read again; a lost
    /// request found here is sent again with its own identity.
    /// A caller that awaits it waits for a read already in flight, as
    /// Electron's `refresh()` returns that read's promise.
    pub async fn refresh_live_sources(&self) {
        self.read_live_sources(true).await;
    }

    /// The driver's `void refresh()` (an event, the proof timer, a resync):
    /// a read already in flight only marks itself dirty, so the driver's
    /// loop never waits on another caller's read.
    pub(super) async fn kick_live_sources_read(&self) {
        self.read_live_sources(false).await;
    }

    async fn read_live_sources(&self, wait: bool) {
        loop {
            let started = {
                let mut inner = self.lock();
                let live = &mut inner.live_sources;
                if live.reading {
                    // Electron returns the read in flight: wait for it.
                    live.read_dirty = true;
                    Err(live.read_owner)
                } else if !live.readable() {
                    return;
                } else {
                    live.reading = true;
                    live.read_generation += 1;
                    live.read_owner = live.read_generation;
                    Ok((
                        live.session_id().unwrap_or_default().to_string(),
                        live.epoch,
                        live.read_generation,
                    ))
                }
            };
            let (session_id, epoch, generation) = match started {
                Ok(read) => read,
                Err(owner) => {
                    if wait {
                        self.wait_for_live_read(owner).await;
                    }
                    return;
                }
            };
            // A dropped refresh never leaves `reading` set: its guard clears
            // it, wakes the waiters and hands a pending re-read to the
            // driver.
            let read = LiveRead {
                studio: self,
                generation,
            };
            let answer = self
                .backend
                .sources_request(SOURCES_GET_METHOD, json!({ "sessionId": session_id }))
                .await
                .and_then(|value| {
                    super::backend::read_json::<SessionSources>(SOURCES_GET_METHOD, value)
                });
            let (accepted, resend) = {
                let mut inner = self.lock();
                let live = &mut inner.live_sources;
                let current = live.epoch == epoch && live.read_generation == generation;
                match answer {
                    Ok(snapshot) if current => {
                        let accepted = live.accept(snapshot, epoch);
                        let resend = accepted
                            .accepted
                            .then(|| live.resend_after_read())
                            .flatten();
                        (Some(accepted), resend)
                    }
                    Ok(_) => (None, None),
                    Err(error) => {
                        if current {
                            self.config.logger.info(format!(
                                "Studio: session.sources.get failed ({}): {}",
                                error.code, error.message
                            ));
                            live.read_failed();
                        }
                        (None, None)
                    }
                }
            };
            self.publish();
            if let Some(accepted) = accepted {
                self.after_accept(accepted, epoch).await;
            }
            let mut again = false;
            if let Some(request) = resend {
                again |= self.send_source_switch(request, epoch).await;
            }
            {
                let mut inner = self.lock();
                let live = &mut inner.live_sources;
                // `finally`: only the read that is still this one clears it
                // and runs the refresh asked for meanwhile; a read a send or
                // a select abandoned leaves the flags to the newer one.
                if live.reading && live.read_owner == generation {
                    live.reading = false;
                    if live.read_dirty {
                        live.read_dirty = false;
                        again = true;
                    }
                }
            }
            // The guard finds the flag settled and only wakes the waiters.
            drop(read);
            if !again {
                return;
            }
        }
    }

    /// A refresh that found a read running: wait until that read is over
    /// (Electron's `return this.read`). A read that is abandoned or dropped
    /// wakes the waiters as well.
    async fn wait_for_live_read(&self, owner: u64) {
        loop {
            let notified = self.live_read_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let running = {
                let inner = self.lock();
                inner.live_sources.reading && inner.live_sources.read_owner == owner
            };
            if !running {
                return;
            }
            notified.await;
        }
    }

    /// `reconcile`: up to three reads while the switch is unconfirmed, then
    /// it says so.
    async fn reconcile_live_sources(&self, epoch: u64) {
        for _ in 0..3 {
            let checking = {
                let inner = self.lock();
                inner.live_sources.epoch == epoch && inner.live_sources.view.checking
            };
            if !checking {
                break;
            }
            self.refresh_live_sources().await;
            if self.lock().live_sources.attempts() >= live_sources::MAX_ATTEMPTS {
                break;
            }
        }
        {
            let mut inner = self.lock();
            if inner.live_sources.epoch == epoch {
                inner.live_sources.give_up_confirming();
            }
        }
        self.publish();
    }

    /// `retryStatus`: Check again.
    pub async fn retry_source_status(&self) {
        let epoch = {
            let mut inner = self.lock();
            if !inner.live_sources.retry() {
                return;
            }
            inner.live_sources.epoch
        };
        self.publish();
        self.refresh_live_sources().await;
        self.reconcile_live_sources(epoch).await;
    }

    /// What an accepted answer brings: a failed switch's toast, the next
    /// proof read, and `confirmed(snapshot)`: what the session uses is the
    /// selection (only its microphone while a scene commit waits for its
    /// proof, #1543), and a confirmed screen saves into the scene on stream
    /// (D11).
    async fn after_accept(&self, accepted: Accepted, epoch: u64) {
        if !accepted.accepted {
            return;
        }
        if let Some(failure) = &accepted.failure {
            self.toast_switch_failure(failure);
        }
        if accepted.proof_due {
            {
                let mut inner = self.lock();
                let increments = inner.live_sources.view.output_pending;
                inner.live_due = Some((
                    Instant::now() + Duration::from_millis(live_sources::PROOF_INTERVAL_MS),
                    epoch,
                    increments,
                ));
            }
            self.settings_retry.notify_one();
        } else {
            // `accept` clears the proof timer before it sets the next one.
            self.lock().live_due = None;
        }
        let selected = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let Some(snapshot) = inner.live_sources.view.snapshot.clone() else {
                return;
            };
            let current = working_sources(inner);
            live_sources::confirmed_source_selection(
                &current,
                &snapshot,
                &inner.sources.devices.devices,
            )
        };
        self.note_session_sources_confirmed(selected).await;
    }

    fn toast_switch_failure(&self, failure: &SwitchFailure) {
        let devices = self.lock().sources.devices.devices.clone();
        self.post(vec![NoticeCommand::Show(
            ToastRequest::error(live_sources::switch_failed_title(failure, &devices))
                .id(format!("source-switch-{}", failure.request_id))
                .description(live_sources::switch_failed_description(&failure.message))
                .finish(),
        )]);
    }

    /// The driver's proof timer (`setTimeout(…, 250)`), and a new session's
    /// first read.
    pub(super) async fn live_sources_due(&self) {
        let due = {
            let mut inner = self.lock();
            let Some((_, epoch, increments)) = inner.live_due.take() else {
                return;
            };
            if epoch != inner.live_sources.epoch {
                return;
            }
            if increments {
                inner.live_sources.proof_reads += 1;
            }
            true
        };
        if due {
            self.kick_live_sources_read().await;
        }
    }

    // --- a pick that came back (plan 213 E1) ---

    /// `announcedSourceReturns`: while a session runs, a stand-in's pick that
    /// is connected again is offered ("{name} is back", Use it) and never
    /// switched on its own; a Clips ring alone switches back at once; a
    /// picker that waits holds the offer for later. An offer whose device is
    /// gone again closes. Electron moved the offer to the bell
    /// (`publishSourceReturn`, #1528); until the bell lands (S1.6e) it is a
    /// toast here.
    pub(super) async fn announce_returning_sources(&self) {
        let start_in_flight = self.start_in_flight();
        let (offers, restores, dismissed) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let sources = working_sources(inner);
            let session = &inner.session;
            // `isActiveRecordingState`: Stopping counts, so an offer stays
            // until the session has ended.
            let active = session.is_active();
            let returns = if inner.bootstrapped
                && !session.start_pending()
                && !session.stop_pending()
                && active
            {
                returning_source_choices(&sources, &inner.sources.devices.devices)
            } else {
                Vec::new()
            };
            let owns = session.is_active() && !super::session_is_replay_only(session.status());
            let mut keys: Vec<String> = returns
                .iter()
                .map(|(kind, device)| format!("{}:{}", kind.as_str(), device.id))
                .collect();
            let dismissed: Vec<String> = inner
                .announced_returns
                .iter()
                .filter(|old| !keys.contains(old))
                .cloned()
                .collect();
            let mut offers = Vec::new();
            let mut restores = Vec::new();
            for (kind, device) in &returns {
                let key = format!("{}:{}", kind.as_str(), device.id);
                if inner.announced_returns.contains(&key) {
                    continue;
                }
                if owns {
                    offers.push((key, *kind, device.clone()));
                } else if source_switch_reason_of(inner, *kind, start_in_flight).is_some() {
                    keys.retain(|held| held != &key);
                } else {
                    restores.push((*kind, device.id.clone()));
                }
            }
            inner.announced_returns = keys;
            (offers, restores, dismissed)
        };
        let mut commands: Vec<NoticeCommand> = dismissed
            .into_iter()
            .map(|key| NoticeCommand::Dismiss(format!("source-return:{key}")))
            .collect();
        for (key, kind, device) in offers {
            commands.push(NoticeCommand::Show(
                ToastRequest::message(format!("{} is back", device.name))
                    .id(format!("source-return:{key}"))
                    .duration(NoticeLifetime::UntilClosed)
                    .action(
                        "Use it",
                        NoticeAction::UseSource {
                            kind,
                            device_id: device.id.clone(),
                        },
                    )
                    .finish(),
            ));
        }
        self.post(commands);
        for (kind, device_id) in restores {
            let _ = self.use_returned_source(kind, &device_id).await;
        }
    }

    /// Use it: the device switched back, if it is still the pick's.
    pub async fn use_returned_source(
        &self,
        kind: SourceKind,
        device_id: &str,
    ) -> Result<(), String> {
        let still = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let sources = working_sources(inner);
            returning_source_choices(&sources, &inner.sources.devices.devices)
                .iter()
                .any(|(returned, device)| *returned == kind && device.id == device_id)
        };
        if !still {
            return Ok(());
        }
        self.select_source_device(kind, Some(device_id)).await
    }

    // --- a reopened window at Record (plan 219 S3) ---

    /// `shouldRefreshWindowListBeforeStart` and `rebindRememberedWindow`, on
    /// the sources a start was built from (`sessionCaptureConfig.sources`):
    /// a picked window the screen capture is not already live on gets one
    /// window-list read. A rebound window lands in the capture config and
    /// the list in the sources; the answer is its new id. A failed read or
    /// no match leaves the pick alone, and the backend names the refusal if
    /// the window is gone.
    pub(super) async fn rebind_window_before_start(&self, sources: &Value) -> Option<String> {
        let preview_screen = self.telemetry.borrow().preview_screen.clone();
        if !should_refresh_window_list_before_start(sources, preview_screen.as_ref()) {
            return None;
        }
        let devices = match self.backend.devices().await {
            Ok(devices) => devices,
            Err(error) => {
                self.config.logger.warn(format!(
                    "[session-start] window list read before start failed: {} ({})",
                    error.message, error.code
                ));
                return None;
            }
        };
        let (id, name) = rebind_remembered_window(sources, &devices.devices)?;
        self.lock().sources.set_devices(devices);
        if let Err(error) = self
            .update_capture_config(|config| {
                config["sources"]["windowId"] = json!(id);
                config["sources"]["windowName"] = json!(name);
            })
            .await
            && !super::settings_write_kept(&error)
        {
            // This start still goes to the window under its new id.
            self.config.logger.warn(format!(
                "[session-start] the rebound window was not saved: {}",
                error.message
            ));
        }
        self.config
            .logger
            .info(format!("[session-start] the picked window is back as {id}"));
        Some(id)
    }

    // --- every device list ---

    /// `reconcileWorkingSceneSources` on a device list, while nothing runs,
    /// no start is on its way and no scene commit waits for its proof: a
    /// scene made for an app finds its window first (a refusal holds Screen
    /// None with the scene still on), and what the resolver said is the
    /// scene on stream's app state (`resolvedAppStates`, plan 210 D1). A
    /// running camera that disconnected keeps its last frame until it
    /// returns. A resolver that fails changes nothing, and a newer device
    /// list drops the answer (its own reconcile runs).
    pub(super) async fn reconcile_working_sources(&self) {
        let disconnected_camera_id = self
            .telemetry
            .borrow()
            .preview_camera
            .as_ref()
            .filter(|status| status.get("state").and_then(Value::as_str) == Some("disconnected"))
            .and_then(|status| status.get("cameraId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let start_in_flight = self.start_in_flight();
        let (before, app, devices, revision) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if start_in_flight || !reconcile_allowed(inner) {
                return;
            }
            let before = working_sources(inner);
            (
                before,
                inner.scenes.switch.working_app_ref().cloned(),
                inner.sources.devices.devices.clone(),
                inner.sources.devices_revision,
            )
        };
        if devices.is_empty() {
            return;
        }
        let options = ReconcileOptions {
            withhold_defaults: self.config.withhold_device_defaults,
            disconnected_camera_id,
            ..ReconcileOptions::default()
        };
        let (next, app_state) = match app
            .as_ref()
            .and_then(|app| app.get("bundleId"))
            .and_then(Value::as_str)
        {
            None => (
                reconcile_source_selection(&before, &devices, &options),
                None,
            ),
            Some(bundle_id) => {
                let mut params = json!({ "bundleId": bundle_id });
                if let Some(window) = before.get("windowId").filter(|id| id.is_string()) {
                    params["preferWindowId"] = window.clone();
                }
                // A request that failed (offline, an older backend, a
                // timeout) changes nothing, as Electron's rejection reaches
                // only its `.catch`; only `{ ok: false }` holds Screen None.
                let answer = match self
                    .backend
                    .scene_request(RESOLVE_APP_WINDOW_METHOD, params)
                    .await
                {
                    Ok(answer) => answer,
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "[scenes] working window resolution failed ({}): {}",
                            error.code, error.message
                        ));
                        return;
                    }
                };
                let app_state = resolved_app_state(&answer);
                (
                    resolved_app_sources(&before, &devices, &options, answer),
                    app_state,
                )
            }
        };
        let next = without_scene_app(&next);
        let start_in_flight = self.start_in_flight();
        let (changed, app_state_changed) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            // A newer list disposed this reconcile (`disposed`).
            if start_in_flight
                || !reconcile_allowed(inner)
                || inner.sources.devices_revision != revision
            {
                return;
            }
            let same_app = inner.scenes.switch.working_app_ref() == app.as_ref();
            // Plan 210 D1: the scene list and the start reason say what the
            // resolver found ("Figma's window is minimized"), not the device
            // list's guess. The answers clear with each device list
            // (`sync_scenes`).
            let mut app_state_changed = false;
            if let (Some(state), Some(active), true) =
                (app_state, inner.scenes.on_stream.clone(), same_app)
            {
                app_state_changed = inner.scenes.resolved.insert(active, state) != Some(state);
            }
            let current = working_sources(inner);
            (
                current == before && same_app && next != before,
                app_state_changed,
            )
        };
        if !changed {
            if app_state_changed {
                self.publish();
            }
            return;
        }
        for event in source_selection_change_events(&before, &next) {
            self.config.logger.info(format!(
                "Studio: {} source {} ({} → {})",
                event.kind.as_str(),
                event.reason.as_str(),
                event.previous_name.as_deref().unwrap_or("none"),
                event.next_name.as_deref().unwrap_or("none"),
            ));
        }
        if let Err(error) = self
            .update_capture_config(|config| config["sources"] = next)
            .await
            && !super::settings_write_kept(&error)
        {
            self.config.logger.warn(format!(
                "Studio: the reconciled sources were not saved: {}",
                error.message
            ));
        }
    }
}

/// The device a pick names and the words for "Preparing …".
fn picked_device(kind: SourceKind, picked: &Value) -> (Option<String>, Option<String>) {
    let text = |key: &str| {
        picked
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    match kind {
        SourceKind::Camera => (text("cameraId"), text("cameraName")),
        SourceKind::Microphone => (text("microphoneId"), text("microphoneName")),
        SourceKind::Capture => (
            text("screenId").or_else(|| text("windowId")),
            text("screenName").or_else(|| text("windowName")),
        ),
    }
}

/// The reconcile's guard: the session's state is known, nothing runs or is
/// starting, and no scene commit waits for its proof.
fn reconcile_allowed(inner: &Inner) -> bool {
    inner.bootstrapped
        && !inner.session.is_active()
        && !inner.session.start_pending()
        && !inner.scenes.switch.awaits_proof()
}

/// `sourceSwitchReason`, over the Studio's state.
pub(super) fn source_switch_reason_of(
    inner: &Inner,
    kind: SourceKind,
    start_in_flight: bool,
) -> Option<String> {
    // Only a live socket can be mid-bootstrap.
    if !inner.bootstrapped && matches!(inner.connection, Connection::Connected { .. }) {
        return Some(live_sources::copy::CHECKING_SESSION.into());
    }
    let owns = inner.session.is_active() && !super::session_is_replay_only(inner.session.status());
    // An idle microphone is not part of the scene, so a scene change can't
    // race it (`layoutSwitchPending`).
    if inner.scenes.switch.pending_layout.is_some() && (kind != SourceKind::Microphone || owns) {
        return Some(live_sources::copy::SCENE_CHANGING.into());
    }
    if start_in_flight || inner.session.start_pending() {
        return Some(live_sources::copy::SESSION_STARTING.into());
    }
    inner.live_sources.reason(kind)
}

/// `reconcileWorkingSceneSources`' `appState`: `ready` with the app's
/// window, else the resolver's reason (`not-running`, `no-window`,
/// `minimized`).
fn resolved_app_state(answer: &Value) -> Option<SceneAppState> {
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return Some(SceneAppState::Ready);
    }
    answer
        .get("reason")
        .and_then(Value::as_str)
        .and_then(AppWindowFailure::parse)
        .map(SceneAppState::Failed)
}

/// The working sources after the app's window resolution
/// (`reconcileWorkingSceneSources`' resolver half).
fn resolved_app_sources(
    before: &Value,
    devices: &[videorc_protocol::Device],
    options: &ReconcileOptions,
    answer: Value,
) -> Value {
    let resolved = Some(answer).filter(|value| value.get("ok") == Some(&Value::Bool(true)));
    let mut next = before.clone();
    if let Value::Object(map) = &mut next {
        for key in ["screenId", "screenName", "screenUuid"] {
            map.remove(key);
        }
        match &resolved {
            Some(window) => {
                if let Some(id) = window.get("windowId") {
                    map.insert("windowId".into(), id.clone());
                }
                if let Some(title) = window.get("title") {
                    map.insert("windowName".into(), title.clone());
                }
                map.insert("captureOff".into(), json!(false));
                map.insert("testPattern".into(), json!(false));
            }
            None => {
                map.remove("windowId");
                map.remove("windowName");
                map.insert("captureOff".into(), json!(true));
            }
        }
    }
    let reconciled = reconcile_source_selection(&next, devices, options);
    if resolved.is_none() {
        return reconciled;
    }
    // The resolver may be newer than devices.list: its window stands.
    let mut out = reconciled.as_object().cloned().unwrap_or_default();
    if let Some(map) = next.as_object() {
        for (key, value) in map {
            out.insert(key.clone(), value.clone());
        }
    }
    for key in [
        "cameraId",
        "cameraName",
        "cameraOff",
        "wantedCameraId",
        "wantedCameraName",
        "microphoneId",
        "microphoneName",
        "microphoneOff",
    ] {
        match reconciled.get(key) {
            Some(value) => out.insert(key.to_string(), value.clone()),
            None => out.remove(key),
        };
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pick_names_its_device_and_its_words() {
        let capture = json!({"windowId": "window:7", "windowName": "Figma"});
        assert_eq!(
            picked_device(SourceKind::Capture, &capture),
            (Some("window:7".into()), Some("Figma".into()))
        );
        let off = json!({"cameraOff": true, "cameraName": ""});
        assert_eq!(picked_device(SourceKind::Camera, &off), (None, None));
    }

    #[test]
    fn a_resolved_app_window_stands_and_a_refusal_holds_screen_none() {
        let before = json!({"screenId": "screen:1", "screenName": "Built-in"});
        let ready = resolved_app_sources(
            &before,
            &[],
            &ReconcileOptions::default(),
            json!({"ok": true, "windowId": "window:9", "title": "Keynote"}),
        );
        assert_eq!(ready["windowId"], "window:9");
        assert_eq!(ready["windowName"], "Keynote");
        assert!(ready.get("screenId").is_none());
        assert_eq!(ready["captureOff"], false);
        let refused = resolved_app_sources(
            &before,
            &[],
            &ReconcileOptions::default(),
            json!({"ok": false, "reason": "minimized"}),
        );
        assert_eq!(refused["captureOff"], true);
        assert!(refused.get("windowId").is_none());
        assert!(refused.get("screenId").is_none());
    }

    #[test]
    fn the_resolver_says_the_app_state() {
        // Part 5e: `reconcileWorkingSceneSources`' `appState`.
        assert_eq!(
            resolved_app_state(&json!({"ok": true, "windowId": "window:9", "title": "Keynote"})),
            Some(SceneAppState::Ready)
        );
        for (reason, failure) in [
            ("not-running", AppWindowFailure::NotRunning),
            ("no-window", AppWindowFailure::NoWindow),
            ("minimized", AppWindowFailure::Minimized),
        ] {
            assert_eq!(
                resolved_app_state(&json!({"ok": false, "reason": reason})),
                Some(SceneAppState::Failed(failure))
            );
        }
        assert_eq!(resolved_app_state(&json!({"ok": false})), None);
    }
}
