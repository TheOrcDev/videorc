//! Plan 260 S1.6a part 6c: the Clips ring in the Studio driver, from
//! `videorc-rust`'s `studio/clips_actions.rs` (plan 220 S3.6a), moved onto
//! #1830's sans-IO controller ([`super::clips_ring::ClipsRing`]).
//!
//! The driver feeds the controller what happened and runs the
//! [`ClipsCommand`]s it answers with (use-studio's replay controller):
//!
//! - **The launch:** the bootstrap reads `replay.status`; its answer arms the
//!   ring once a launch with the saved switch (on by default). A backend that
//!   doesn't answer it (a test fake) never arms the ring, as Electron's
//!   `() => undefined`.
//! - **What it hears:** `replay.state`, `recording.status` (with whether a
//!   session ran to Idle), the camera's and the screen's preview status, and
//!   from every publish the record block and the wait, the sources, the
//!   session's shape and the layout preset; a layout transaction's end
//!   ([`super::scene_switch`]).
//! - **What it runs:** [`ClipsCommand::Schedule`] is the pass's one timer
//!   (`clips.due`, which `drive` waits on like the live switch's and the
//!   low-light read's); the other commands queue for the pass, which runs on
//!   its own task so a buffer-only `session.start` never holds the events up.
//! - **The start** (`startBufferOnlySession`): the recordings folder's
//!   capability first, then the params built from the capture config and the
//!   scene the Studio holds as the request goes out (#1697), with no file, no
//!   stream and the ring attached.
//! - **#1640's ring half:** the pass tells the controller a transaction
//!   awaits its proof (the ring then waits for it); a transaction asked for
//!   while the ring's start is in flight waits for its answer
//!   ([`super::scene_switch`]'s gate), and a transaction that crosses the
//!   orientation while only the ring runs stops it first.
//! - **The Output page:** the switch ([`Studio::set_clips_enabled`]), the
//!   snapshot's [`ClipsView`], and the one clip action ([`Studio::mark_clip`],
//!   30 s or the minute).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::Value;
use videorc_protocol::{
    ClipMarkParams, ClipMarkedEvent, RecordingStatus, ReplayBufferState, ReplayStateEvent,
    SessionStopParams,
};

use super::backend::StudioBackend;
use super::clips::{self, CameraReport, ClipsWait, WaitInput};
use super::clips_ring::{self, ClipsCommand, ClipsRing, ClipsView, StudioFacts};
use super::inspector::{self, StartGates};
use super::scene_switch::{ReloadMark, is_scene_reload_superseded};
use super::session::idle_ends_session_that_ran;
use super::settings::keys;
use super::{
    Connection, Inner, SessionStartIntent, Studio, StudioSnapshot, build_start_params,
    capture_config, health, preview_scene, session_is_replay_only,
};
use crate::desktop::permissions::MediaAccessSnapshot;
use crate::notices::{self, NoticeCommand};
use crate::user_error::{
    UserErrorContext, backend_error_toast, backend_error_toast_without_context, toast_offline,
};

/// `replay.status`: the ring's state, read at the bootstrap.
pub const REPLAY_STATUS_METHOD: &str = "replay.status";
/// `clip.mark`: the one clip action (plan 181 R4, plan 199).
pub const CLIP_MARK_METHOD: &str = "clip.mark";
/// `scene.load_from_capture_config`: the scene reload a source change waits
/// for before the ring comes back (`reloadSceneFromCaptureConfig`).
pub const SCENE_LOAD_METHOD: &str = "scene.load_from_capture_config";

/// `waitForRecordingIdle(recordingRef, 5_000)`: how long a transaction that
/// crosses the orientation waits for the ring it stopped.
pub const RING_STEP_ASIDE_WAIT: Duration = Duration::from_secs(5);
const IDLE_POLL: Duration = Duration::from_millis(50);

/// `reportError(error, {action: 'turn off', object: 'clips'})`.
const TURN_OFF_CLIPS: UserErrorContext = UserErrorContext {
    action: "turn off",
    object: "clips",
};
/// `{action: 'save', object: 'the clip'}`.
const SAVE_THE_CLIP: UserErrorContext = UserErrorContext {
    action: "save",
    object: "the clip",
};

/// The ring's memory in the Studio: the controller, its timer and queue,
/// and what the app tells it that app-core doesn't hold.
pub(super) struct ClipsCore {
    pub(super) ring: ClipsRing,
    /// The pass's one timer (`replayReconcileTimerRef`).
    pub(super) due: Option<Instant>,
    /// Commands the pass runs (a stop, a restart), queued where they came
    /// from (a publish, an event) because they await requests.
    queued: Vec<ClipsCommand>,
    /// `recordBlockedReason` and `replayGrantWait` at the last publish.
    record_blocked: Option<String>,
    wait: Option<ClipsWait>,
    /// The layout preset last seen (`replayLayoutPreset`'s effect).
    layout_preset: Option<String>,
    /// The start-block table's facts the app works out ([`StartGates`]).
    gates: StartGates,
    /// The OS's grants (macOS; `None` until the app reads them).
    media: Option<MediaAccessSnapshot>,
    first_run_setup_open: bool,
    /// `replayAutoPreviewStarts`: the app starts the previews itself (off in
    /// a preview smoke).
    auto_preview: bool,
    /// A smoke's shorter ring (`replayBuffer.smokeRingSeconds`).
    smoke_seconds: Option<u32>,
}

impl Default for ClipsCore {
    fn default() -> Self {
        Self {
            ring: ClipsRing::new(),
            due: None,
            queued: Vec::new(),
            record_blocked: None,
            wait: None,
            layout_preset: None,
            gates: StartGates::default(),
            media: None,
            first_run_setup_open: false,
            auto_preview: true,
            smoke_seconds: None,
        }
    }
}

/// The capture config's sources as text, `undefined` as empty.
fn source_text(sources: &Value, key: &str) -> String {
    sources
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn source_off(sources: &Value, key: &str, word: &str) -> String {
    if sources.get(key) == Some(&Value::Bool(true)) {
        word.to_string()
    } else {
        String::new()
    }
}

/// `replayVisualSources` and `replaySources`.
fn sources_keys(sources: &Value) -> (String, String) {
    let visual = [
        source_text(sources, "screenId"),
        source_text(sources, "windowId"),
        source_text(sources, "cameraId"),
        source_off(sources, "cameraOff", "camera-off"),
        source_off(sources, "captureOff", "capture-off"),
    ]
    .join("|");
    let all = [
        visual.clone(),
        source_text(sources, "microphoneId"),
        source_off(sources, "microphoneOff", "microphone-off"),
    ]
    .join("|");
    (all, visual)
}

fn clips_state(state: ReplayBufferState) -> notices::ClipsState {
    match state {
        ReplayBufferState::Off => notices::ClipsState::Off,
        ReplayBufferState::Starting => notices::ClipsState::Starting,
        ReplayBufferState::On => notices::ClipsState::On,
        ReplayBufferState::Error => notices::ClipsState::Error,
    }
}

impl Inner {
    /// The saved switch (Output → Clips → Keep the last seconds).
    fn clips_switch_on(&self) -> bool {
        self.capture.view.config.replay_buffer.enabled
    }

    /// Schedules the pass for `Schedule`, queues every other command for it.
    /// True when the driver's timer must look again.
    pub(super) fn queue_clips(&mut self, commands: Vec<ClipsCommand>) -> bool {
        if commands.is_empty() {
            return false;
        }
        let now = Instant::now();
        for command in commands {
            match command {
                // One timer: a later schedule replaces it.
                ClipsCommand::Schedule(delay) => self.clips.due = Some(now + delay),
                other => self.clips.queued.push(other),
            }
        }
        if !self.clips.queued.is_empty() {
            self.clips.due = Some(now);
        }
        true
    }

    /// `replayGrantWait` over the capture config as the Studio holds it and
    /// the previews' last status.
    fn clips_wait(&self, camera: Option<&Value>, screen: Option<&Value>) -> Option<ClipsWait> {
        let capture = &self.capture.view.config;
        clips::wait(&WaitInput {
            first_run_setup_open: self.clips.first_run_setup_open,
            media: self.clips.media.as_ref(),
            grants_apply: cfg!(target_os = "macos"),
            sources: &self.capture.config["sources"],
            layout_preset: &capture.layout.layout_preset,
            arrangement: &capture.layout.arrangement_mode,
            portal_share_granted: self.clips.ring.portal_share_granted(),
            preview_camera: camera,
            preview_screen: screen,
            auto_preview: self.clips.auto_preview,
        })
    }

    /// What the controller reads at a pass. `start_in_flight` and
    /// `stop_in_flight` are read before the Studio's lock (the lock order).
    pub(super) fn clips_facts(&self, start_in_flight: bool, stop_in_flight: bool) -> StudioFacts {
        let status = self.session.status();
        StudioFacts {
            recording_state: status.state.clone(),
            recording_replay_only: session_is_replay_only(status),
            start_pending: start_in_flight || self.session.start_pending(),
            stop_pending: stop_in_flight || self.session.stop_pending(),
            layout_awaiting_proof: self.scenes.switch.awaits_proof(),
            // No talk show room in app-core yet.
            performance_check_hold: self.performance.hold,
            room_holds_camera: false,
            record_blocked: self.clips.record_blocked.is_some(),
            wait: self.clips.wait,
        }
    }

    /// The Output page's Clips section.
    pub(super) fn clips_view(&self) -> ClipsView {
        self.clips.ring.view(
            self.clips_switch_on(),
            self.clips.record_blocked.as_deref(),
            self.clips.wait,
        )
    }

    /// Under the publish's lock: the ring's effects (the record block and
    /// the wait, the sources, the shape, the layout preset), once the
    /// settings are in. `snapshot` gets the view. True when the driver's
    /// timer must look again.
    pub(super) fn clips_note(
        &mut self,
        snapshot: &mut StudioSnapshot,
        start_in_flight: bool,
        stop_in_flight: bool,
        previews: &(Option<Value>, Option<Value>),
    ) -> bool {
        if !self.settings.hydrated() {
            return false;
        }
        let switch_on = self.clips_switch_on();
        let record_blocked = inspector::record_blocked_reason(snapshot, &self.clips.gates);
        let wait = self.clips_wait(previews.0.as_ref(), previews.1.as_ref());
        self.clips.record_blocked = record_blocked;
        self.clips.wait = wait;
        let facts = self.clips_facts(start_in_flight, stop_in_flight);
        let mut commands = self
            .clips
            .ring
            .note_gate(facts.record_blocked, facts.wait, switch_on);
        let (sources_key, visual_key) = sources_keys(&self.capture.config["sources"]);
        commands.extend(
            self.clips
                .ring
                .note_sources(&sources_key, &visual_key, &facts, switch_on),
        );
        let capture = &self.capture.view.config;
        let shape_key = format!(
            "{}|{}|{}|{}|{}|{:?}",
            capture.video.width,
            capture.video.height,
            capture.video.fps,
            capture.video.bitrate_kbps,
            capture.layout.layout_preset.is_vertical(),
            self.clips.smoke_seconds,
        );
        let preset = format!("{:?}", capture.layout.layout_preset);
        commands.extend(self.clips.ring.note_shape(&shape_key, &facts));
        if self.clips.layout_preset.as_deref() != Some(preset.as_str()) {
            let first = self.clips.layout_preset.is_none();
            self.clips.layout_preset = Some(preset);
            if !first {
                commands.extend(self.clips.ring.note_layout_preset());
            }
        }
        snapshot.clips = self.clips_view();
        self.queue_clips(commands)
    }

    /// `recording.status`, once applied: the session that ran to Idle, the
    /// ring that died re-armed after the next session, a pass.
    pub(super) fn clips_on_recording_status(
        &mut self,
        previous: &videorc_protocol::RecordingState,
    ) -> bool {
        let status = self.session.status().clone();
        let ran_to_idle = idle_ends_session_that_ran(Some(previous), &status.state);
        let switch_on = self.clips_switch_on();
        let commands = self.clips.ring.on_recording_status(
            &status.state,
            session_is_replay_only(&status),
            ran_to_idle,
            switch_on,
        );
        self.queue_clips(commands)
    }

    /// `replay.state`: the ring as the backend reports it (its toasts are
    /// the notices').
    pub(super) fn clips_on_replay_state(&mut self, event: &ReplayStateEvent) -> bool {
        let commands = self.clips.ring.on_replay_state(event.clone());
        self.queue_clips(commands)
    }
}

/// A transaction that crosses the orientation while only the ring runs
/// holds the ring (`replayReconcileHoldRef`) until it is done, however it
/// ends.
pub(super) struct ClipsOrientationHold<'a, B: StudioBackend>(pub(super) &'a Studio<B>);

impl<B: StudioBackend> Drop for ClipsOrientationHold<'_, B> {
    fn drop(&mut self) {
        let woke = {
            let mut inner = self.0.lock();
            let commands = inner.clips.ring.release_hold();
            inner.queue_clips(commands)
        };
        if woke {
            self.0.settings_retry.notify_one();
        }
    }
}

/// The ring's Stop is answered (`stop_answered`) however its request ends:
/// answered, failed, or dropped with the future that ran it. Electron's
/// promise can't be dropped; a Rust future can, and a "stopping" left set
/// counts as a start in flight forever.
struct ClipsStopAnswer<'a, B: StudioBackend>(&'a Studio<B>);

impl<B: StudioBackend> Drop for ClipsStopAnswer<'_, B> {
    fn drop(&mut self) {
        self.0.lock().clips.ring.stop_answered();
    }
}

impl<B: StudioBackend> Studio<B> {
    /// The previews' last status, read apart from the Studio's lock.
    pub(super) fn clips_previews(&self) -> (Option<Value>, Option<Value>) {
        let telemetry = self.telemetry.borrow();
        (
            telemetry.preview_camera.clone(),
            telemetry.preview_screen.clone(),
        )
    }

    /// `stopSessionInFlightPromiseRef !== null`.
    pub(super) fn stop_in_flight_now(&self) -> bool {
        self.stop_in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// Commands the controller answered with outside a pass: the timer
    /// moves, the rest wait for the pass.
    pub(super) fn schedule_clips(&self, commands: Vec<ClipsCommand>) {
        if self.lock().queue_clips(commands) {
            self.settings_retry.notify_one();
        }
    }

    /// The bootstrap's `replay.status` (Electron reads it beside the other
    /// reads): the ring's state, and the launch's arming once. A read that
    /// fails arms nothing.
    pub(super) async fn read_replay_status(&self, generation: u64) {
        let answer = self
            .backend
            .clips_request(REPLAY_STATUS_METHOD, Value::Null)
            .await;
        let Ok(value) = answer else {
            return;
        };
        let event = match serde_json::from_value::<ReplayStateEvent>(value) {
            Ok(event) => event,
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: \"{REPLAY_STATUS_METHOD}\" did not read ({error})."
                ));
                return;
            }
        };
        let woke = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if inner.bootstrap_generation != generation {
                return;
            }
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let switch_on = inner.clips_switch_on();
            let mut commands = inner.clips.ring.on_replay_status(event, switch_on);
            // A reconnect after the launch's arming passes again.
            if commands.is_empty() {
                commands.push(ClipsCommand::Schedule(clips_ring::PASS_DELAY));
            }
            inner.queue_clips(commands)
        };
        if woke {
            self.settings_retry.notify_one();
        }
        self.publish();
    }

    /// `preview.camera.status` and `preview.screen.status` (the telemetry
    /// already holds them): the camera's live edge and first frame, the
    /// portal share's latch, and the wait they change.
    pub(super) fn clips_preview_status(&self, event: &str, payload: &Value) {
        let previews = self.clips_previews();
        let (woke, changed) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let mut commands = Vec::new();
            if event == health::PREVIEW_CAMERA_STATUS_EVENT {
                commands.extend(
                    inner
                        .clips
                        .ring
                        .on_camera_status(&CameraReport::from_status(payload)),
                );
            } else {
                inner.clips.ring.on_screen_status(payload);
            }
            let mut changed = false;
            if inner.settings.hydrated() {
                inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
                let wait = inner.clips_wait(previews.0.as_ref(), previews.1.as_ref());
                if wait != inner.clips.wait {
                    inner.clips.wait = wait;
                    changed = true;
                    let blocked = inner.clips.record_blocked.is_some();
                    let switch_on = inner.clips_switch_on();
                    commands.extend(inner.clips.ring.note_gate(blocked, wait, switch_on));
                }
            }
            (inner.queue_clips(commands), changed)
        };
        if woke {
            self.settings_retry.notify_one();
        }
        if changed {
            self.publish();
        }
    }

    /// When the ring's next pass is due, if one is scheduled.
    pub fn clips_due_at(&self) -> Option<Instant> {
        self.lock().clips.due
    }

    /// `drive`'s timer fell due: the pass runs on its own task, so a
    /// buffer-only start the backend holds never holds the events up.
    pub(super) fn spawn_clips_pass(self: &std::sync::Arc<Self>) {
        self.lock().clips.due = None;
        let studio = self.clone();
        tokio::spawn(async move { studio.clips_due().await });
    }

    /// One pass of the ring (what `drive`'s timer runs): the queued commands
    /// (a stop, a source restart), then `reconcileReplayBuffer`'s start or
    /// stop, and what each answers with.
    pub async fn clips_due(&self) {
        let queued = std::mem::take(&mut self.lock().clips.queued);
        self.run_clips(queued).await;
        // The lock order: `in_flight` and `stop_in_flight` before `Inner`.
        let start_in_flight = self.start_in_flight();
        let stop_in_flight = self.stop_in_flight_now();
        let command = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let facts = inner.clips_facts(start_in_flight, stop_in_flight);
            inner.clips.ring.pass(&facts)
        };
        self.run_clips(command.into_iter().collect()).await;
    }

    /// Runs the controller's commands and the ones they answer with, in
    /// order.
    pub(super) async fn run_clips(&self, commands: Vec<ClipsCommand>) {
        let mut queue: VecDeque<ClipsCommand> = commands.into();
        while let Some(command) = queue.pop_front() {
            let next = match command {
                ClipsCommand::Schedule(delay) => {
                    self.schedule_clips(vec![ClipsCommand::Schedule(delay)]);
                    Vec::new()
                }
                ClipsCommand::Start => self.start_ring().await,
                ClipsCommand::Stop => {
                    // The ring's "stopping" clears however the Stop ends,
                    // the caller's future dropped during `session.stop`
                    // included (a layout transaction's step-aside runs it
                    // inline); left set, the ring would never start again.
                    let _answered = ClipsStopAnswer(self);
                    self.stop_buffer_only_session().await;
                    Vec::new()
                }
                ClipsCommand::RestartForSources {
                    stop_ring,
                    reload_scene,
                } => self.restart_ring_for_sources(stop_ring, reload_scene).await,
                ClipsCommand::NotifyCouldNotStart(detail) => {
                    self.post(vec![NoticeCommand::Show(notices::clips_could_not_start(
                        &detail,
                    ))]);
                    Vec::new()
                }
            };
            queue.extend(next);
        }
    }

    /// `startReplayBuffer`'s request (`startBufferOnlySession`): the folder's
    /// capability, then the params from the capture config and the scene as
    /// the request goes out (#1697), then the controller's answer. A
    /// transaction held for this start runs once it is answered.
    async fn start_ring(&self) -> Vec<ClipsCommand> {
        let answer: Result<RecordingStatus, (Option<String>, String)> =
            match self.recordings_folder_capability().await {
                Err(message) => Err((None, message)),
                Ok(folder) => {
                    let params = {
                        let mut guard = self.lock();
                        let inner = &mut *guard;
                        let view = inner.settings_view();
                        build_start_params(
                            &view.capture,
                            &view.studio,
                            SessionStartIntent::RECORD,
                            None,
                        )
                        .map(|params| {
                            clips::buffer_only_params(
                                params,
                                inner.clips.smoke_seconds,
                                view.capture.replay_buffer.explicit,
                            )
                        })
                    };
                    match params {
                        Err(message) => Err((None, message)),
                        Ok(params) => self
                            .backend
                            .session_start_into(params, folder)
                            .await
                            .map_err(|error| (Some(error.code), error.message)),
                    }
                }
            };
        let camera = self
            .clips_previews()
            .0
            .map(|status| CameraReport::from_status(&status))
            .unwrap_or_default();
        let (effects, commands) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let (outcome, effects) = match answer {
                Ok(status) => (
                    clips_ring::StartOutcome::Started,
                    inner.session.apply_reported_status(status, Instant::now()),
                ),
                Err((code, message)) => {
                    self.config.logger.warn(format!(
                        "[replay-buffer] start failed: {message} ({})",
                        code.as_deref().unwrap_or("no code")
                    ));
                    (
                        clips_ring::StartOutcome::Refused { code, message },
                        Vec::new(),
                    )
                }
            };
            let chosen = inner.capture.view.config.sources.camera_id.clone();
            let commands = inner
                .clips
                .ring
                .start_answered(outcome, &camera, chosen.as_deref());
            // #1640: a layout transaction held for this start runs now, as
            // a change to the session it started.
            inner.scenes.switch.wake_waiters();
            (effects, commands)
        };
        self.publish();
        self.emit_all(effects);
        commands
    }

    /// `stopReplayBuffer`'s request: only a buffer-only session; a failure
    /// says "Couldn't turn off clips".
    pub(super) async fn stop_buffer_only_session(&self) {
        let replay_only = session_is_replay_only(self.lock().session.status());
        if !replay_only {
            return;
        }
        let answer = self
            .backend
            .session_stop(SessionStopParams {
                requested_at_ms: None,
            })
            .await;
        let effects = match answer {
            Ok(status) => self
                .lock()
                .session
                .apply_reported_status(status, Instant::now()),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[replay-buffer] stop failed: {} ({})",
                    error.message, error.code
                ));
                let connected = self.is_connected();
                if let Some(command) = backend_error_toast(&error, connected, TURN_OFF_CLIPS) {
                    self.post(vec![command]);
                }
                Vec::new()
            }
        };
        self.publish();
        self.emit_all(effects);
    }

    /// `restartReplayForSources`: the ring stopped first when asked, then
    /// the scene reloaded from the capture config when the picture changed
    /// and nothing records, then the controller passes again.
    async fn restart_ring_for_sources(
        &self,
        stop_ring: bool,
        reload_scene: bool,
    ) -> Vec<ClipsCommand> {
        if stop_ring {
            self.stop_buffer_only_session().await;
        }
        let active = self.lock().session.is_active();
        if reload_scene && !active {
            self.reload_scene_for_ring().await;
        }
        self.lock().clips.ring.restart_done(reload_scene)
    }

    /// `reloadSceneFromCaptureConfig` (`loadScene`): the capture config's
    /// scene with the working background, committed; the reload a switch
    /// overtook persists nothing.
    async fn reload_scene_for_ring(&self) {
        match self.load_scene_from_capture_config().await {
            Ok(()) => {}
            Err(error) if is_scene_reload_superseded(&error) => {}
            Err(error) => self.report_ring_reload_failure(&error),
        }
    }

    /// `loadScene` with the capture config (`reloadSceneFromCaptureConfig`):
    /// the capture config's scene with the working background is committed
    /// (`scene.load_from_capture_config`, `applyCommittedScene`), and the
    /// working setup it confirms is saved (`persistWorkingVisual`); a reload
    /// a key or switch overtook saves nothing. Nothing is asked while the
    /// backend is away. S1.6b part 5e: the Clips ring's reload and the scene
    /// editor's reload after an idle pick share it.
    pub(super) async fn load_scene_from_capture_config(
        &self,
    ) -> Result<(), crate::client::RpcError> {
        let mark: ReloadMark = self.scene_reload_mark();
        let request = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if !matches!(inner.connection, Connection::Connected { .. }) {
                return Ok(());
            }
            let view = inner.settings_view();
            let params = preview_scene::studio_scene_params(&view.capture, &view.studio, false);
            let Ok(mut params) = serde_json::to_value(&params) else {
                return Ok(());
            };
            if let Some(background) = inner.scenes.switch.working_background.clone() {
                params["background"] = background;
            }
            (
                params,
                view.capture_doc["layout"].clone(),
                view.capture_doc["sources"].clone(),
            )
        };
        let (params, layout, sources) = request;
        let status = self
            .backend
            .scene_request(SCENE_LOAD_METHOD, params)
            .await?;
        let scene = status.get("scene").cloned();
        if let Some(committed) = scene
            .clone()
            .and_then(|scene| serde_json::from_value::<videorc_protocol::Scene>(scene).ok())
        {
            self.lock().sources.set_scene(committed);
            self.publish();
        }
        let background = scene
            .as_ref()
            .and_then(|scene| scene.get("background"))
            .filter(|background| background.is_object())
            .cloned();
        self.note_scene_reloaded(mark, &layout, &sources, background)
            .await;
        Ok(())
    }

    /// `restartReplayForSources`'s `.catch`: the failed reload is logged,
    /// and reported when nothing records (`isActiveRecordingState`), so the
    /// scene doesn't silently stay on the old sources.
    fn report_ring_reload_failure(&self, error: &crate::client::RpcError) {
        self.config.logger.warn(format!(
            "[replay-buffer] the scene reload before the ring failed: {} ({})",
            error.message, error.code
        ));
        if self.lock().session.is_active() {
            return;
        }
        let connected = self.is_connected();
        if let Some(command) = backend_error_toast_without_context(error, connected) {
            self.post(vec![command]);
        }
    }

    /// `waitForRecordingIdle`: true once nothing runs, false at the deadline.
    pub(super) async fn wait_for_recording_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let active = self.lock().session.is_active();
            if !active {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(IDLE_POLL).await;
        }
    }

    // --- The app's facts ---------------------------------------------------

    /// The start-block table's facts the app works out (the same
    /// [`StartGates`] the transport reads): the ring waits while Record would
    /// be refused.
    pub fn set_clips_start_gates(&self, gates: StartGates) {
        self.lock().clips.gates = gates;
        self.publish();
    }

    /// The OS's grants (macOS): the ring waits for a grant never asked.
    pub fn set_clips_media_access(&self, media: Option<MediaAccessSnapshot>) {
        self.lock().clips.media = media;
        self.publish();
    }

    /// First-run setup is open: it holds the preview back, so the ring waits.
    pub fn set_clips_first_run_setup_open(&self, open: bool) {
        self.lock().clips.first_run_setup_open = open;
        self.publish();
    }

    /// Whether the app starts the previews itself (`replayAutoPreviewStarts`;
    /// off in a preview smoke): then the ring waits for their first frames.
    pub fn set_clips_auto_preview(&self, on: bool) {
        self.lock().clips.auto_preview = on;
        self.publish();
    }

    // --- The Output page and the clip action -------------------------------

    /// Output → Clips → Keep the last seconds (`setReplayEnabled`): saved as
    /// the streamer's explicit choice, so a default the backend refused is
    /// overridden on purpose, never silently.
    pub async fn set_clips_enabled(&self, enabled: bool) {
        let commands = self.lock().clips.ring.set_enabled(enabled);
        self.schedule_clips(commands);
        if let Err(error) = self
            .update_capture_config(|config| {
                capture_config::set_path(
                    config,
                    &["replayBuffer", "enabled"],
                    Some(Value::Bool(enabled)),
                );
                capture_config::set_path(
                    config,
                    &["replayBuffer", "explicit"],
                    Some(Value::Bool(true)),
                );
            })
            .await
            && !super::settings_write_kept(&error)
        {
            self.config.logger.warn(format!(
                "Studio: the Clips switch was not saved: {}",
                error.message
            ));
        }
    }

    /// The smokes' `__videorcSmokeSetReplayBuffer(armed, seconds)`: this
    /// run's arming with a shorter ring, never saved.
    pub fn set_clips_for_run(&self, armed: bool, seconds: Option<u32>) {
        let commands = {
            let mut inner = self.lock();
            inner.clips.smoke_seconds = seconds;
            inner.clips.ring.smoke_set_armed(armed)
        };
        self.schedule_clips(commands);
        self.publish();
    }

    /// `markClip(seconds)`, the one clip action (the Stream Manager's Clip,
    /// its keys, ⌘K, a deck key): 30 s ([`clips::DEFAULT_CLIP_SECONDS`]) or
    /// the minute ([`clips::LONG_CLIP_SECONDS`]); `None` is 30 s with no
    /// params, as before plan 199. With no ring holding frames and nothing
    /// recording, the toast says which switch to turn on and nothing is
    /// sent; a failed request says "Couldn't save the clip".
    pub async fn mark_clip(&self, seconds: Option<u32>) -> Option<ClipMarkedEvent> {
        let (connected, nothing) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let connected = matches!(inner.connection, Connection::Connected { .. });
            let ring = inner.clips.ring.replay().state;
            // No talk show room in app-core yet (plan 249).
            let has_target = clips::clip_has_target(ring, &inner.session.status().state, false);
            let nothing = (!has_target).then(|| {
                notices::nothing_to_clip(
                    clips_state(ring),
                    inner.clips_switch_on(),
                    inner.clips.ring.blocked_reason(),
                )
            });
            (connected, nothing)
        };
        if !connected {
            self.post(vec![toast_offline(SAVE_THE_CLIP)]);
            return None;
        }
        if let Some(notice) = nothing {
            self.post(vec![NoticeCommand::Show(notice)]);
            return None;
        }
        let error = match self.request_clip_mark(seconds).await {
            Ok(event) => return Some(event),
            Err(error) => error,
        };
        self.config.logger.warn(format!(
            "[clips] the clip was not saved: {} ({})",
            error.message, error.code
        ));
        let connected = self.is_connected();
        if let Some(command) = backend_error_toast(&error, connected, SAVE_THE_CLIP) {
            self.post(vec![command]);
        }
        None
    }

    /// `clip.mark` with the length, its answer read as the event. Says
    /// nothing itself: [`Self::mark_clip`] toasts, a remote's key answers
    /// with the words.
    pub(super) async fn request_clip_mark(
        &self,
        seconds: Option<u32>,
    ) -> Result<ClipMarkedEvent, crate::client::RpcError> {
        let params = serde_json::to_value(ClipMarkParams { seconds }).unwrap_or(Value::Null);
        let value = self.backend.clips_request(CLIP_MARK_METHOD, params).await?;
        serde_json::from_value::<ClipMarkedEvent>(value).map_err(|error| {
            crate::client::RpcError::new(
                CLIP_MARK_METHOD,
                crate::client::codes::INVALID_RESPONSE,
                format!("The {CLIP_MARK_METHOD} answer did not read: {error}"),
            )
        })
    }
}
