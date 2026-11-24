//! The Clips ring's controller (use-studio's replay controller), over the
//! rules in [`super::clips`]. Sans-IO: the Studio driver feeds it what
//! happened and runs the [`ClipsCommand`]s it answers with, so every
//! ordering is tested without a backend.
//!
//! - **Arming:** once per launch, on the first `replay.status`, the saved
//!   switch arms the ring (on by default). The switch arms and disarms it.
//! - **A pass** ([`ClipsRing::pass`]) runs the one decision: start the
//!   buffer-only session (`session.start` with the ring attached, no file,
//!   no stream), stop it, or nothing. A start waits, without trying, while
//!   Record is blocked or a grant, a screen, a portal share or a preview's
//!   first frame is missing; the wait's end passes again.
//! - **A refused start:** the software encoder guard turns the switch off
//!   with its reason; a camera with no frame waits for its live edge, and a
//!   camera that says live and sends nothing is asked on a backoff, then
//!   waited for (#1683, the bell says so once); any other refusal retries
//!   with a backoff and gives up after three, once a launch with "Clips
//!   couldn't start".
//! - **Sources and shape:** a source change while only the ring runs stops
//!   it and, for a screen or camera, reloads the scene before the ring
//!   comes back; a change during the ring's own start restarts it once the
//!   start answers. A change of the Output quality, the orientation or a
//!   smoke's ring stops a buffer-only ring.
//! - **#1640's ring half (the scene race):** the ring never starts while a
//!   layout transaction awaits its proof (the start would commit the scene
//!   it is leaving), and that transaction's end passes again; a layout
//!   transaction asked for while the ring's start is in flight waits for
//!   that start ([`ClipsRing::start_in_flight`]), then runs as a change to
//!   the session that started. The start's params are built from the scene
//!   the Studio holds as the request goes out (#1697).
//! - **A ring that died** (`error`) disarms until a session's end, a source
//!   change, a wait that clears or the switch re-arms it.

use std::time::Duration;

use serde_json::Value;
use videorc_protocol::{RecordingState, ReplayBufferState, ReplayStateEvent};

use super::clips::{
    self, CameraReport, CameraWait, ClipsWait, ReconcileAction, ReconcileInput,
    SourcesNotReadyNext, copy,
};

/// `scheduleReplayReconcile`'s default delay.
pub const PASS_DELAY: Duration = Duration::from_millis(150);

/// What the driver does for the ring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipsCommand {
    /// Pass again after the delay. One timer: a later schedule replaces it.
    Schedule(Duration),
    /// Start the buffer-only session: params from the capture config and the
    /// scene as they are now ([`clips::buffer_only_params`]), the recordings
    /// folder's capability, then [`ClipsRing::start_answered`].
    Start,
    /// `session.stop` of the buffer-only session, then
    /// [`ClipsRing::stop_answered`] (a failure says "turn off clips").
    Stop,
    /// A source change: stop the ring first when `stop_ring`, then reload the
    /// scene from the capture config when `reload_scene` and nothing records,
    /// then [`ClipsRing::restart_done`].
    RestartForSources { stop_ring: bool, reload_scene: bool },
    /// The bell's Clips entry, "Clips couldn't start", with this detail
    /// (`crate::notices`). Once a launch.
    NotifyCouldNotStart(String),
}

/// What the ring reads from the Studio at a pass.
#[derive(Debug, Clone)]
pub struct StudioFacts {
    pub recording_state: RecordingState,
    /// `sessionIsReplayOnly`: the running session exists for the ring.
    pub recording_replay_only: bool,
    /// A Record or Go Live is in flight (its start or its lifecycle).
    pub start_pending: bool,
    pub stop_pending: bool,
    /// A layout transaction awaits its proof (#1640).
    pub layout_awaiting_proof: bool,
    /// A performance check needs an idle studio.
    pub performance_check_hold: bool,
    /// A talk show's room holds the camera (plan 224 D6).
    pub room_holds_camera: bool,
    /// `recordBlockedReason` is set: a start would be refused.
    pub record_blocked: bool,
    /// `replayGrantWait`: [`clips::wait`].
    pub wait: Option<ClipsWait>,
}

/// How the ring's own start ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    Started,
    Refused {
        code: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcesMoved {
    Visual,
    Audio,
}

/// What the Output page's Clips section reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipsView {
    /// The switch reads on: the setting is on and nothing blocked it.
    pub on: bool,
    pub armed: bool,
    pub blocked_reason: Option<String>,
    pub wait_reason: Option<&'static str>,
    pub state: ReplayBufferState,
    /// The ring is on or starting.
    pub running: bool,
    pub switch_description: String,
}

/// `REPLAY_STATE_OFF`.
fn ring_off() -> ReplayStateEvent {
    ReplayStateEvent {
        state: ReplayBufferState::Off,
        session_id: None,
        seconds: 30,
        buffered_seconds: 0.0,
        replay_only: false,
        reason: None,
        segment_files: None,
    }
}

fn active(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    )
}

/// The ring's bookkeeping (use-studio's replay refs).
#[derive(Debug, Clone)]
pub struct ClipsRing {
    replay: ReplayStateEvent,
    armed: bool,
    launch_armed: bool,
    blocked_reason: Option<String>,
    /// The ring's own start has not answered (`replayStartPromiseRef`).
    starting: bool,
    /// The ring's own stop has not answered.
    stopping: bool,
    failed_starts: u32,
    waiting_for_camera: bool,
    camera_wait: CameraWait,
    /// A live camera's refusal watches its status for a first frame.
    watching_camera: bool,
    last_camera_state: Option<String>,
    /// The once-a-launch guard both Clips notices share.
    notified: bool,
    sources_moved: Option<SourcesMoved>,
    scene_reloads: u32,
    /// An orientation change stops a buffer-only ring and holds it.
    hold: bool,
    last_session_ring_only: bool,
    sources_key: Option<String>,
    visual_key: Option<String>,
    shape_key: Option<String>,
    gate_key: Option<(bool, Option<ClipsWait>)>,
    portal_share: Option<String>,
}

impl Default for ClipsRing {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipsRing {
    pub fn new() -> Self {
        Self {
            replay: ring_off(),
            armed: false,
            launch_armed: false,
            blocked_reason: None,
            starting: false,
            stopping: false,
            failed_starts: 0,
            waiting_for_camera: false,
            camera_wait: CameraWait::default(),
            watching_camera: false,
            last_camera_state: None,
            notified: false,
            sources_moved: None,
            scene_reloads: 0,
            hold: false,
            last_session_ring_only: false,
            sources_key: None,
            visual_key: None,
            shape_key: None,
            gate_key: None,
            portal_share: None,
        }
    }

    /// The last `replay.state` (the clip action reads it).
    pub fn replay(&self) -> &ReplayStateEvent {
        &self.replay
    }

    pub fn armed(&self) -> bool {
        self.armed
    }

    pub fn blocked_reason(&self) -> Option<&str> {
        self.blocked_reason.as_deref()
    }

    /// #1640: a layout transaction asked for now waits for the ring's start
    /// to answer, then runs as a change to the session it started.
    pub fn start_in_flight(&self) -> bool {
        self.starting
    }

    /// The Linux portal share this run granted, for [`clips::WaitInput`].
    pub fn portal_share_granted(&self) -> Option<&str> {
        self.portal_share.as_deref()
    }

    fn reset_attempts(&mut self) {
        self.failed_starts = 0;
        self.waiting_for_camera = false;
        self.camera_wait = CameraWait::default();
    }

    /// `setReplayArmed`.
    fn set_armed(&mut self, armed: bool) -> ClipsCommand {
        self.armed = armed;
        self.reset_attempts();
        ClipsCommand::Schedule(Duration::ZERO)
    }

    /// `rearmReplayAfterError`.
    fn rearm_after_error(&mut self, switch_on: bool) -> Option<ClipsCommand> {
        clips::should_rearm_after_error(
            self.armed,
            self.replay.state,
            switch_on,
            self.blocked_reason.is_some(),
        )
        .then(|| {
            self.armed = true;
            ClipsCommand::Schedule(PASS_DELAY)
        })
    }

    // --- The backend's news ---------------------------------------------

    /// The bootstrap's `replay.status`: the launch's arming, once.
    pub fn on_replay_status(
        &mut self,
        event: ReplayStateEvent,
        switch_on: bool,
    ) -> Vec<ClipsCommand> {
        self.replay = event;
        if self.launch_armed {
            return Vec::new();
        }
        self.launch_armed = true;
        self.set_armed(switch_on);
        vec![ClipsCommand::Schedule(PASS_DELAY)]
    }

    /// `replay.state`. A ring that died with its session disarms (the switch
    /// stays on; its "Clips stopped" and "Clips are on again" are the
    /// notices').
    pub fn on_replay_state(&mut self, event: ReplayStateEvent) -> Vec<ClipsCommand> {
        if event.state == ReplayBufferState::Error {
            self.armed = false;
        }
        self.replay = event;
        vec![ClipsCommand::Schedule(PASS_DELAY)]
    }

    /// `recording.status`. A session that ran and ended (`ran_to_idle`) is
    /// proof a start can work: the count begins again; a refused start's
    /// idle is not. A ring that died with its own session comes back after
    /// the next recording or livestream, not after itself.
    pub fn on_recording_status(
        &mut self,
        state: &RecordingState,
        replay_only: bool,
        ran_to_idle: bool,
        switch_on: bool,
    ) -> Vec<ClipsCommand> {
        if active(state) {
            self.last_session_ring_only = replay_only;
        }
        if ran_to_idle {
            self.failed_starts = 0;
        }
        let mut commands = Vec::new();
        if matches!(state, RecordingState::Idle | RecordingState::Failed)
            && !self.last_session_ring_only
        {
            commands.extend(self.rearm_after_error(switch_on));
        }
        commands.push(ClipsCommand::Schedule(PASS_DELAY));
        commands
    }

    /// `preview.camera.status`: the live edge starts a ring that waited for
    /// it; a first frame clears a silent camera's count and starts a ring
    /// that stopped asking.
    pub fn on_camera_status(&mut self, camera: &CameraReport) -> Vec<ClipsCommand> {
        let mut commands = Vec::new();
        if self.watching_camera && camera.delivers() {
            self.watching_camera = false;
            let waited = self.camera_wait.frames;
            self.camera_wait = CameraWait::default();
            if waited {
                self.waiting_for_camera = false;
                commands.push(ClipsCommand::Schedule(Duration::ZERO));
            }
        }
        let edge = camera.state == "live" && self.last_camera_state.as_deref() != Some("live");
        self.last_camera_state = Some(camera.state.clone());
        if edge && self.waiting_for_camera {
            self.waiting_for_camera = false;
            commands.push(ClipsCommand::Schedule(PASS_DELAY));
        }
        commands
    }

    /// `preview.screen.status`: Linux's portal share latch.
    pub fn on_screen_status(&mut self, status: &Value) {
        self.portal_share = clips::next_portal_share_grant(self.portal_share.take(), status);
    }

    // --- The Studio's changes -------------------------------------------

    /// The record block or the wait changed (and once at first): a clean
    /// count, a died ring re-armed, a pass.
    pub fn note_gate(
        &mut self,
        record_blocked: bool,
        wait: Option<ClipsWait>,
        switch_on: bool,
    ) -> Vec<ClipsCommand> {
        let key = Some((record_blocked, wait));
        if self.gate_key == key {
            return Vec::new();
        }
        self.gate_key = key;
        self.failed_starts = 0;
        self.waiting_for_camera = false;
        let mut commands: Vec<ClipsCommand> =
            self.rearm_after_error(switch_on).into_iter().collect();
        commands.push(ClipsCommand::Schedule(PASS_DELAY));
        commands
    }

    /// The capture config's sources changed. `visual_key` is the screen,
    /// window and camera with their off switches; `sources_key` adds the
    /// microphone (Linux cannot swap it mid-session). The first call only
    /// remembers them.
    pub fn note_sources(
        &mut self,
        sources_key: &str,
        visual_key: &str,
        facts: &StudioFacts,
        switch_on: bool,
    ) -> Vec<ClipsCommand> {
        let Some(previous) = self.sources_key.replace(sources_key.to_string()) else {
            self.visual_key = Some(visual_key.to_string());
            return Vec::new();
        };
        if previous == sources_key {
            return Vec::new();
        }
        let visual = self.visual_key.as_deref() != Some(visual_key);
        self.visual_key = Some(visual_key.to_string());
        self.reset_attempts();
        let mut commands: Vec<ClipsCommand> =
            self.rearm_after_error(switch_on).into_iter().collect();
        if clips::should_restart_for_sources(facts.recording_replay_only, &facts.recording_state) {
            commands.push(self.restart_for_sources(visual, true));
            return commands;
        }
        if self.starting {
            // The ring's own start carries the old sources: restart once it
            // answers.
            self.sources_moved = Some(
                if visual || self.sources_moved == Some(SourcesMoved::Visual) {
                    SourcesMoved::Visual
                } else {
                    SourcesMoved::Audio
                },
            );
        } else if visual && self.armed && !active(&facts.recording_state) {
            // Between two sessions: the re-armed ring would overtake the
            // scene reload and start on the old scene.
            commands.push(self.restart_for_sources(true, false));
            return commands;
        }
        commands.push(ClipsCommand::Schedule(PASS_DELAY));
        commands
    }

    /// `restartReplayForSources`.
    fn restart_for_sources(&mut self, visual: bool, stop_ring: bool) -> ClipsCommand {
        if visual {
            self.scene_reloads += 1;
        }
        ClipsCommand::RestartForSources {
            stop_ring,
            reload_scene: visual,
        }
    }

    /// A [`ClipsCommand::RestartForSources`] finished (the stop, the reload,
    /// or a failure of either).
    pub fn restart_done(&mut self, reload_scene: bool) -> Vec<ClipsCommand> {
        if reload_scene {
            self.scene_reloads = self.scene_reloads.saturating_sub(1);
        }
        vec![ClipsCommand::Schedule(PASS_DELAY)]
    }

    /// The session's shape changed: the Output quality, the orientation, a
    /// smoke's ring. A buffer-only ring stops and comes back with it; a
    /// recording keeps its shape. The first call only remembers it.
    pub fn note_shape(&mut self, shape_key: &str, facts: &StudioFacts) -> Vec<ClipsCommand> {
        let Some(previous) = self.shape_key.replace(shape_key.to_string()) else {
            return Vec::new();
        };
        if previous == shape_key {
            return Vec::new();
        }
        self.stop(facts).into_iter().collect()
    }

    /// The layout preset changed: a ring that waited for a camera the new
    /// layout no longer shows can start.
    pub fn note_layout_preset(&mut self) -> Vec<ClipsCommand> {
        if !self.waiting_for_camera {
            return Vec::new();
        }
        self.waiting_for_camera = false;
        vec![ClipsCommand::Schedule(PASS_DELAY)]
    }

    /// #1640: a layout transaction's proof came (or it ended): the ring held
    /// back for it passes again, and starts with the scene it left.
    pub fn layout_transaction_ended(&mut self) -> Vec<ClipsCommand> {
        if self.armed {
            vec![ClipsCommand::Schedule(PASS_DELAY)]
        } else {
            Vec::new()
        }
    }

    /// A layout transaction that crosses the orientation while only the
    /// ring runs: hold the ring and stop it before the transaction; call
    /// [`Self::release_hold`] when the transaction is done.
    pub fn hold_for_orientation(&mut self, facts: &StudioFacts) -> Vec<ClipsCommand> {
        if !facts.recording_replay_only {
            return Vec::new();
        }
        self.hold = true;
        self.stop(facts).into_iter().collect()
    }

    pub fn release_hold(&mut self) -> Vec<ClipsCommand> {
        if !self.hold {
            return Vec::new();
        }
        self.hold = false;
        vec![ClipsCommand::Schedule(PASS_DELAY)]
    }

    /// Output → Clips → Keep the last seconds. The driver persists
    /// `replayBuffer: { enabled, explicit: true }`: a default the backend
    /// refused is overridden on purpose, never silently.
    pub fn set_enabled(&mut self, enabled: bool) -> Vec<ClipsCommand> {
        self.blocked_reason = None;
        vec![self.set_armed(enabled)]
    }

    /// A smoke arms the ring the way the switch does.
    pub fn smoke_set_armed(&mut self, armed: bool) -> Vec<ClipsCommand> {
        vec![self.set_armed(armed)]
    }

    // --- The pass and its requests ---------------------------------------

    fn reconcile_input(&self, facts: &StudioFacts) -> ReconcileInput {
        ReconcileInput {
            armed: self.armed,
            replay_state: self.replay.state,
            replay_only_buffer: self.replay.replay_only,
            recording_state: facts.recording_state.clone(),
            recording_replay_only: facts.recording_replay_only,
            start_pending: facts.start_pending,
            stop_pending: facts.stop_pending,
            start_in_flight: self.starting
                || self.stopping
                || facts.layout_awaiting_proof
                || self.hold
                || self.scene_reloads > 0
                || facts.performance_check_hold,
            failed_starts: self.failed_starts,
            waiting_for_camera: self.waiting_for_camera,
            room_holds_camera: facts.room_holds_camera,
        }
    }

    /// One pass (`reconcileReplayBuffer`): the start or the stop to send, if
    /// any. A start that must wait sends nothing; the wait's end (via
    /// [`Self::note_gate`]) or the transaction's end passes again. Three
    /// failed starts give up until a source change, a session's end or the
    /// switch resets the count.
    pub fn pass(&mut self, facts: &StudioFacts) -> Option<ClipsCommand> {
        match clips::reconcile_action(&self.reconcile_input(facts))? {
            ReconcileAction::Start => self.start(facts),
            ReconcileAction::Stop => self.stop(facts),
            ReconcileAction::GiveUp => None,
        }
    }

    /// `startReplayBuffer`'s guards.
    fn start(&mut self, facts: &StudioFacts) -> Option<ClipsCommand> {
        if self.starting || !self.armed {
            return None;
        }
        // Not yet: the switch stays on and the ring starts once the reason
        // clears, so a launch before Sources settle never turns clips off.
        if facts.record_blocked || facts.wait.is_some() {
            return None;
        }
        // #1640: a scene change awaiting its proof has not reached the
        // Studio's scene yet; a start now would commit the scene it leaves.
        if facts.layout_awaiting_proof {
            return None;
        }
        self.starting = true;
        self.sources_moved = None;
        Some(ClipsCommand::Start)
    }

    /// `stopReplayBuffer`: only a buffer-only session.
    fn stop(&mut self, facts: &StudioFacts) -> Option<ClipsCommand> {
        if !facts.recording_replay_only || self.stopping {
            return None;
        }
        self.stopping = true;
        Some(ClipsCommand::Stop)
    }

    pub fn stop_answered(&mut self) {
        self.stopping = false;
    }

    /// The ring's start answered. `camera` and `chosen_camera` are the
    /// camera's last status and the scene's camera, for a
    /// `replay-sources-not-ready` refusal.
    pub fn start_answered(
        &mut self,
        outcome: StartOutcome,
        camera: &CameraReport,
        chosen_camera: Option<&str>,
    ) -> Vec<ClipsCommand> {
        let mut commands = Vec::new();
        let started = outcome == StartOutcome::Started;
        match outcome {
            StartOutcome::Started => {
                self.failed_starts = 0;
                self.blocked_reason = None;
            }
            StartOutcome::Refused { code, message } => {
                self.start_refused(
                    code.as_deref(),
                    message,
                    camera,
                    chosen_camera,
                    &mut commands,
                );
            }
        }
        self.starting = false;
        if let Some(moved) = self.sources_moved.take()
            && started
        {
            commands.push(self.restart_for_sources(moved == SourcesMoved::Visual, true));
        }
        commands
    }

    fn start_refused(
        &mut self,
        code: Option<&str>,
        message: String,
        camera: &CameraReport,
        chosen_camera: Option<&str>,
        commands: &mut Vec<ClipsCommand>,
    ) {
        if code == Some(clips::SOFTWARE_ENCODER_REFUSAL) {
            // The default start on a software encoder path: no retry, no
            // notice; the Output page shows the switch off and why.
            self.armed = false;
            self.blocked_reason = Some(message);
            return;
        }
        if code == Some(clips::SOURCES_NOT_READY)
            && self.sources_not_ready(camera, chosen_camera, commands)
        {
            return;
        }
        // A camera that failed, is missing or was denied brings no live edge:
        // the start counts as failed, like any other.
        self.failed_starts += 1;
        if self.failed_starts >= clips::RETRY_LIMIT {
            if !self.notified {
                self.notified = true;
                commands.push(ClipsCommand::NotifyCouldNotStart(message));
            }
        } else {
            commands.push(ClipsCommand::Schedule(clips::retry_delay(
                self.failed_starts,
            )));
        }
    }

    /// `replaySourcesNotReadyStep`: false when the start counts as failed.
    fn sources_not_ready(
        &mut self,
        camera: &CameraReport,
        chosen_camera: Option<&str>,
        commands: &mut Vec<ClipsCommand>,
    ) -> bool {
        let live = camera.state == "live";
        let refusals = self.camera_wait.refusals + u32::from(live);
        let next = clips::after_sources_not_ready(camera, chosen_camera, refusals);
        let waits = next == SourcesNotReadyNext::WaitForFrames;
        let first = waits && !self.camera_wait.frames;
        self.camera_wait = CameraWait {
            refusals,
            frames: self.camera_wait.frames || waits,
        };
        if live {
            self.watching_camera = true;
        }
        match next {
            SourcesNotReadyNext::Failed => return false,
            SourcesNotReadyNext::Retry(delay) => commands.push(ClipsCommand::Schedule(delay)),
            SourcesNotReadyNext::WaitForLive | SourcesNotReadyNext::WaitForFrames => {
                self.waiting_for_camera = true;
            }
        }
        if first && !self.notified {
            self.notified = true;
            commands.push(ClipsCommand::NotifyCouldNotStart(
                copy::CAMERA_SENDS_NO_PICTURE.to_string(),
            ));
        }
        true
    }

    // --- The view --------------------------------------------------------

    /// The Output page's Clips section. `record_blocked` is the Studio's
    /// `recordBlockedReason`, which the switch's line names before the wait.
    pub fn view(
        &self,
        switch_on: bool,
        record_blocked: Option<&str>,
        wait: Option<ClipsWait>,
    ) -> ClipsView {
        let on = switch_on && self.blocked_reason.is_none();
        let running = matches!(
            self.replay.state,
            ReplayBufferState::On | ReplayBufferState::Starting
        );
        let wait_reason = wait.and_then(ClipsWait::reason);
        ClipsView {
            on,
            armed: self.armed,
            blocked_reason: self.blocked_reason.clone(),
            wait_reason,
            state: self.replay.state,
            running,
            switch_description: clips::switch_description(
                self.blocked_reason.as_deref(),
                on,
                running,
                record_blocked.or(wait_reason),
            ),
        }
    }
}

#[cfg(test)]
#[path = "clips_ring_tests.rs"]
mod tests;
