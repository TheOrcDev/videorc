//! The session state machine, as `use-studio.tsx` runs it, without React
//! (plan 260 S1.6a, from `videorc-rust`'s plan 220 S2.4a; caught up with
//! Electron's #1270 start intents and plan 184's cloud Resume).
//!
//! Everything here is pure: a [`SessionState`] takes the statuses the backend
//! reports (`recording.status` events, the answers to `session.start` and
//! `session.stop`) and the user's intents, and returns the [`SessionEffect`]s
//! a UI acts on. The transitions are the renderer's:
//!
//! - `applyRecordingStatus` (`use-studio.tsx`): remember what the
//!   running session does, drop the armed hotkey and the start intent when
//!   the session is no longer active, clear the stop overrun outside
//!   `stopping`.
//! - the `recording.status` event handler: fill a terminal push's
//!   missing session id from the session that was running, record statuses
//!   that overtake a `session.start` in flight, "Recording saved" when an
//!   Idle ends a session that ran, the persistent failure notice on
//!   `failed` (once per session), the session-started hook on the first
//!   `recording`/`streaming`.
//! - the start flow (`runStartSession`): an optimistic `starting` while the
//!   request runs, `reconcileSessionStartResponse` against the statuses the
//!   backend pushed meanwhile, and the failure path (the keyed start-failure
//!   notice with Retry, back to Idle when nothing started).
//! - the stop door (`requestStopSession`, `lib/session-stop.ts`): a
//!   recording stops at once, a livestream asks or arms a second hotkey
//!   press, remote intents stop at once.
//!
//! The pieces of `shared/capture-state.ts`, `lib/session-start-intent.ts`,
//! `lib/session-start-failure.ts` and `lib/session-stop.ts` live here under
//! their own names.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use videorc_protocol::{RecordingState, RecordingStatus};

/// Where the session is, for the UI. The backend's six states, with Go
/// Live's record+stream (reported as `recording` with a stream URL, plan 095
/// S5 / plan 174 B-6) and stream-only both read as [`SessionPhase::Live`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Idle,
    Starting,
    Recording,
    Live,
    Stopping,
    Failed,
}

impl SessionPhase {
    pub fn from_status(status: &RecordingStatus) -> Self {
        match status.state {
            RecordingState::Idle => SessionPhase::Idle,
            RecordingState::Starting => SessionPhase::Starting,
            RecordingState::Recording if session_is_live(status) => SessionPhase::Live,
            RecordingState::Recording => SessionPhase::Recording,
            RecordingState::Streaming => SessionPhase::Live,
            RecordingState::Stopping => SessionPhase::Stopping,
            RecordingState::Failed => SessionPhase::Failed,
        }
    }

    /// `isActiveRecordingState`: starting, recording, streaming or stopping.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            SessionPhase::Starting
                | SessionPhase::Recording
                | SessionPhase::Live
                | SessionPhase::Stopping
        )
    }
}

/// `isActiveRecordingState` on the wire state.
pub fn is_active_state(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    )
}

/// `sessionIsLive`: on air. A running status carries `streamUrl` exactly when
/// the session streams.
pub fn session_is_live(status: &RecordingStatus) -> bool {
    matches!(status.state, RecordingState::Streaming)
        || (matches!(status.state, RecordingState::Recording) && status.stream_url.is_some())
}

/// `sessionIsReplayOnly` (plan 181): the session exists for the Clips ring
/// only; no surface calls it a recording.
pub fn session_is_replay_only(status: &RecordingStatus) -> bool {
    status.replay_only
}

/// What a running session does (`sessionActivity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionActivity {
    Recording,
    LiveStream,
    RecordAndStream,
}

impl SessionActivity {
    pub fn of(status: &RecordingStatus) -> Self {
        if !session_is_live(status) {
            SessionActivity::Recording
        } else if matches!(status.state, RecordingState::Streaming) {
            SessionActivity::LiveStream
        } else {
            SessionActivity::RecordAndStream
        }
    }

    /// `activityIsLive`: viewers were watching.
    pub fn is_live(self) -> bool {
        self != SessionActivity::Recording
    }

    /// `activitySavesRecording`: a local file was being saved.
    pub fn saves_recording(self) -> bool {
        self != SessionActivity::LiveStream
    }
}

/// `idleEndsSessionThatRan` (plan 198): an Idle after recording, streaming or
/// stopping ends a session that ran. A refused start also ends in Idle but
/// proves nothing.
pub fn idle_ends_session_that_ran(
    previous: Option<&RecordingState>,
    next: &RecordingState,
) -> bool {
    matches!(next, RecordingState::Idle)
        && matches!(
            previous,
            Some(RecordingState::Recording | RecordingState::Streaming | RecordingState::Stopping)
        )
}

/// What a start asks for (`lib/session-start-intent.ts`): whether the
/// session writes a file and whether it streams. Neither writes the saved
/// `recordEnabled` / `streamEnabled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionStartIntent {
    pub record: bool,
    pub stream: bool,
}

impl SessionStartIntent {
    /// Record: a local take, never a stream, whatever the Output switch says.
    pub const RECORD: Self = Self {
        record: true,
        stream: false,
    };

    /// Go Live: a livestream, and a recording too only when the Output page's
    /// "Save local recording" is on (D19: the two are one session).
    pub fn livestream(also_record: bool) -> Self {
        Self {
            record: also_record,
            stream: true,
        }
    }

    /// The saved output mode as an intent (what the smokes' `startSession`
    /// starts).
    pub fn saved_mode(record_enabled: bool, stream_enabled: bool) -> Self {
        Self {
            record: record_enabled,
            stream: stream_enabled,
        }
    }
}

impl SessionActivity {
    /// `RUNNING_INTENTS`: what a running session of this activity asked for.
    pub fn intent(self) -> SessionStartIntent {
        match self {
            SessionActivity::Recording => SessionStartIntent::RECORD,
            SessionActivity::LiveStream => SessionStartIntent::livestream(false),
            SessionActivity::RecordAndStream => SessionStartIntent::livestream(true),
        }
    }
}

/// What `remoteOutputIntent` reads.
#[derive(Debug, Clone, Copy)]
pub struct RemoteOutputInput<'a> {
    pub session_active: bool,
    /// This app's own start's intent, while its session runs.
    pub start_intent: Option<SessionStartIntent>,
    pub status: &'a RecordingStatus,
    /// The saved `recordEnabled` and `streamEnabled`.
    pub record_enabled: bool,
    pub stream_enabled: bool,
    /// The last answer, which keeps what the session did through its stop.
    pub previous: Option<SessionStartIntent>,
}

/// `remoteOutputIntent` (`lib/session-start-intent.ts`): what remotes (the
/// Stream Deck, the phone) see as the session's outputs, so a Record take
/// never reads as live. The start's own intent; for a session this app did
/// not start, what its status says once the backend names it (a starting
/// status lists the file and the stream it opens); through the stop tail,
/// `previous`. Idle, or before anything is known, the saved mode a Go Live
/// would follow.
pub fn remote_output_intent(input: RemoteOutputInput<'_>) -> SessionStartIntent {
    let saved = SessionStartIntent::saved_mode(input.record_enabled, input.stream_enabled);
    if !input.session_active {
        return saved;
    }
    if let Some(intent) = input.start_intent {
        return intent;
    }
    let status = input.status;
    match status.state {
        RecordingState::Recording | RecordingState::Streaming => {
            SessionActivity::of(status).intent()
        }
        RecordingState::Starting
            if status
                .session_id
                .as_deref()
                .is_some_and(|id| !id.is_empty()) =>
        {
            SessionStartIntent {
                record: status
                    .output_path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty()),
                stream: status
                    .stream_url
                    .as_deref()
                    .is_some_and(|url| !url.is_empty()),
            }
        }
        _ => input.previous.unwrap_or(saved),
    }
}

/// `reconcileSessionStartResponse`: a stopping or terminal push for the same
/// session can overtake the answer to `session.start`; that push stays
/// authoritative so an older active answer cannot make the Studio believe
/// the ending session is live.
#[derive(Debug, Clone)]
pub struct StartResolution {
    pub status: RecordingStatus,
    pub superseded_by_authoritative_event: bool,
    pub session_active: bool,
}

pub fn reconcile_start_response(
    response: RecordingStatus,
    authoritative_during_request: Option<&RecordingStatus>,
) -> StartResolution {
    let response_is_active = matches!(
        response.state,
        RecordingState::Recording | RecordingState::Streaming
    );
    let authoritative = authoritative_during_request.filter(|authoritative| {
        response_is_active
            && response.session_id.is_some()
            && authoritative.session_id == response.session_id
            && matches!(
                authoritative.state,
                RecordingState::Stopping | RecordingState::Idle | RecordingState::Failed
            )
    });
    let superseded = authoritative.is_some();
    let status = authoritative.cloned().unwrap_or(response);
    let session_active = matches!(
        status.state,
        RecordingState::Recording | RecordingState::Streaming
    );
    StartResolution {
        status,
        superseded_by_authoritative_event: superseded,
        session_active,
    }
}

/// Where a stop request came from (`lib/session-stop.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOrigin {
    Button,
    Space,
    Palette,
    GlobalHotkey,
    RemoteControl,
    PhoneRemote,
    FailureBanner,
    /// The app is quitting while on air (⌘Q, the Dock).
    Quit,
    /// The main window is closing while on air (⌘W).
    CloseWindow,
}

/// What the app does once the livestream ended for a quit or close question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopExit {
    Quit,
    Close,
}

/// The exit a confirmed stop continues with, or none for an in-app stop.
pub fn exit_for_stop_origin(origin: StopOrigin) -> Option<StopExit> {
    match origin {
        StopOrigin::Quit => Some(StopExit::Quit),
        StopOrigin::CloseWindow => Some(StopExit::Close),
        _ => None,
    }
}

/// A second global-hotkey press inside this window ends the livestream.
pub const END_LIVESTREAM_ARM_WINDOW: Duration = Duration::from_millis(2_000);

/// The one keyed toast for an armed hotkey (plain: no success icon).
pub const END_LIVESTREAM_ARMED_TOAST: &str = "Press again to end the livestream";
/// The End livestream dialog's copy.
pub const END_LIVESTREAM_TITLE: &str = "End livestream?";
pub const KEEP_STREAMING_LABEL: &str = "Keep streaming";
pub const END_LIVESTREAM_LABEL: &str = "End livestream";
/// D19: Go Live and Stop are one session, said where the control is.
pub const RECORDING_STOPS_TOO: &str = "Your recording stops too.";

/// The dialog's title names the consequence when the app is leaving.
pub fn end_livestream_title(origin: StopOrigin) -> &'static str {
    match origin {
        StopOrigin::Quit => "End livestream and quit?",
        StopOrigin::CloseWindow => "End livestream and close?",
        _ => END_LIVESTREAM_TITLE,
    }
}

/// The destructive button says everything it does; "Keep streaming" never
/// changes.
pub fn end_livestream_confirm_label(origin: StopOrigin) -> &'static str {
    match origin {
        StopOrigin::Quit => "End livestream and quit",
        StopOrigin::CloseWindow => "End livestream and close",
        _ => END_LIVESTREAM_LABEL,
    }
}

/// `listNames`: "Twitch", "Twitch and YouTube", "Twitch, YouTube and Kick".
pub fn list_names(names: &[String]) -> String {
    let cleaned: Vec<&str> = names
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect();
    match cleaned.as_slice() {
        [] => String::new(),
        [one] => (*one).to_string(),
        [first, second] => format!("{first} and {second}"),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}

/// `endLivestreamBody`: who is disconnected, and what happens to the
/// recording.
pub fn end_livestream_body(confirmation: &StopConfirmation) -> String {
    let names = list_names(&confirmation.platforms);
    let audience = if names.is_empty() {
        "Your viewers are disconnected.".to_string()
    } else {
        format!("Viewers on {names} are disconnected.")
    };
    if confirmation.also_records {
        format!("{audience} Your recording stops too and is saved to the Library.")
    } else {
        audience
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopDecision {
    Stop,
    Confirm,
    Arm,
}

/// `stopDecision`: a recording that is not live stops at once from every
/// origin; while live, an in-app stop and the app leaving ask first, a
/// global hotkey arms and stops on a second press within the window, and
/// Stream Deck and phone intents stop at once.
pub fn stop_decision(
    origin: StopOrigin,
    live: bool,
    armed_at: Option<Instant>,
    now: Instant,
) -> StopDecision {
    if !live {
        return StopDecision::Stop;
    }
    match origin {
        StopOrigin::RemoteControl | StopOrigin::PhoneRemote => StopDecision::Stop,
        StopOrigin::GlobalHotkey => match armed_at {
            Some(armed_at)
                if now >= armed_at && now.duration_since(armed_at) <= END_LIVESTREAM_ARM_WINDOW =>
            {
                StopDecision::Stop
            }
            _ => StopDecision::Arm,
        },
        _ => StopDecision::Confirm,
    }
}

/// What the Studio holds while the End livestream dialog waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopConfirmation {
    pub origin: StopOrigin,
    /// The session the question is about; a later session never inherits it.
    pub session_id: Option<String>,
    /// The destinations the session streams to, by label.
    pub platforms: Vec<String>,
    /// Whether a local recording stops with the livestream (D19).
    pub also_records: bool,
}

/// What a stop request does right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopRequest {
    /// Stop now.
    Stop,
    /// The hotkey is armed; a second press within the window stops.
    Armed,
    /// Ask first; the confirmation is in the state.
    Confirm(StopConfirmation),
}

/// `SESSION_START_FAILED_TOAST_ID` and its copy (`lib/session-start-failure.ts`).
pub const SESSION_START_FAILED_TOAST_ID: &str = "session-start-failed";
pub const SESSION_START_FAILED_TOAST_TITLE: &str = "Couldn't start";

/// Which start failed (`SessionStartFailureKind`): Record, Go Live, or the
/// cloud's Resume (plan 184 C5b).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStartFailureKind {
    Record,
    Live,
    Resume,
}

impl SessionStartFailureKind {
    /// The kind a start of this intent reports: Go Live when it streams.
    pub fn of_intent(intent: SessionStartIntent) -> Self {
        if intent.stream {
            Self::Live
        } else {
            Self::Record
        }
    }
}

/// `sessionStartFailedTitle`: "Couldn't start recording", "Couldn't go
/// live" or "Couldn't resume the stream".
pub fn session_start_failed_title(kind: SessionStartFailureKind) -> &'static str {
    match kind {
        SessionStartFailureKind::Record => "Couldn't start recording",
        SessionStartFailureKind::Live => "Couldn't go live",
        SessionStartFailureKind::Resume => "Couldn't resume the stream",
    }
}

/// A refused start, shown persistently until the next attempt or a dismiss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStartFailure {
    /// The backend's or the preflight's reason, verbatim.
    pub message: String,
    /// Which start failed, for the toast's title.
    pub kind: SessionStartFailureKind,
    /// The intent that failed, so Retry re-runs the exact start.
    pub intent: SessionStartIntent,
    pub at: Instant,
}

/// `RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID`.
pub const RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID: &str = "recording-stopped-unexpectedly";

/// The persistent notice for a session that died (`SessionRuntimeNotice`,
/// kind `recording-failed`). The microphone-loss notice is Phase 3.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingFailedNotice {
    pub activity: SessionActivity,
    pub message: String,
    pub session_id: Option<String>,
    pub output_path: Option<String>,
    pub at: Instant,
}

impl RecordingFailedNotice {
    /// `sessionRuntimeNoticeTitle` for this kind.
    pub fn title(&self) -> &'static str {
        if self.activity.is_live() {
            crate::notices::copy::LIVESTREAM_STOPPED_UNEXPECTEDLY
        } else {
            crate::notices::copy::RECORDING_STOPPED_UNEXPECTEDLY
        }
    }
}

/// What the UI does about a status change. None of these is state: the
/// state is read from the snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEffect {
    /// A session reached recording or streaming (first time, or a new
    /// session id): the Library's running row is fresh.
    SessionStarted { session_id: Option<String> },
    /// The session went on air: "Open Stream Manager when you go live".
    WentLive,
    /// An Idle ended a session that ran and saved a file: the "Recording
    /// saved" toast with Play and Open in Library.
    RecordingSaved {
        session_id: Option<String>,
        output_path: Option<String>,
    },
    /// The session ended (idle or failed): stream targets and viewer chips
    /// clear, the Library refreshes.
    SessionEnded,
    /// S3.0f: an Idle ended a session that ran and was not the Clips ring
    /// alone (`showSessionFinished`): the live stream's news ends with it,
    /// the microphone notice moves to the past tense, and when the session
    /// saved a file, "Recording saved". `activity` is what it did.
    SessionFinished {
        session_id: Option<String>,
        activity: SessionActivity,
    },
    /// A persistent failure notice was raised (once per session).
    RecordingFailed(RecordingFailedNotice),
    /// A refused start was reported.
    StartFailed(SessionStartFailure),
}

/// Bookkeeping for a `session.start` in flight (`sessionStartLifecycle*Ref`
/// and `sessionStartAuthoritativeStatusesRef`).
#[derive(Debug, Clone, Default)]
struct StartLifecycle {
    /// Statuses the backend pushed while the request ran, by session id;
    /// only stopping, idle and failed are kept.
    authoritative: BTreeMap<String, RecordingStatus>,
}

/// The session as the Studio knows it.
#[derive(Debug, Clone)]
pub struct SessionState {
    status: RecordingStatus,
    /// `lastRecordingStateRef`: the last state the backend reported (not the
    /// optimistic one).
    last_reported_state: Option<RecordingState>,
    /// `lastRecordingSessionIdRef`.
    last_session_id: Option<String>,
    /// `lastSessionActivityRef`: what the running session did.
    last_activity: SessionActivity,
    /// `activeStartIntent`.
    active_intent: Option<SessionStartIntent>,
    /// `endLivestreamArmedAtRef`.
    armed_at: Option<Instant>,
    /// B-16: Force stop is explained while the stop drags on.
    stop_overrun: bool,
    stop_confirmation: Option<StopConfirmation>,
    start_failure: Option<SessionStartFailure>,
    runtime_notice: Option<RecordingFailedNotice>,
    /// `recordingFailureSessionRef`: one failure notice per session.
    failure_dedupe_key: Option<String>,
    start_lifecycle: Option<StartLifecycle>,
    /// The start in flight is the cloud's Resume (`rpc ===
    /// 'cloud.show.resume'`, plan 184 C5b): its failure reads "Couldn't
    /// resume the stream".
    start_resumes: bool,
    start_pending: bool,
    stop_pending: bool,
}

/// `idle_status()` on the backend, as the Studio starts.
pub fn initial_status() -> RecordingStatus {
    RecordingStatus {
        state: RecordingState::Idle,
        session_id: None,
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: Some("Ready.".to_string()),
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

/// The status the renderer shows after a start that never produced a
/// session.
pub const READY_TO_START_MESSAGE: &str = "Ready to start a capture session.";

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            status: initial_status(),
            last_reported_state: None,
            last_session_id: None,
            last_activity: SessionActivity::Recording,
            active_intent: None,
            armed_at: None,
            stop_overrun: false,
            stop_confirmation: None,
            start_failure: None,
            runtime_notice: None,
            failure_dedupe_key: None,
            start_lifecycle: None,
            start_resumes: false,
            start_pending: false,
            stop_pending: false,
        }
    }

    pub fn status(&self) -> &RecordingStatus {
        &self.status
    }

    pub fn phase(&self) -> SessionPhase {
        SessionPhase::from_status(&self.status)
    }

    pub fn is_active(&self) -> bool {
        is_active_state(&self.status.state)
    }

    pub fn is_live(&self) -> bool {
        session_is_live(&self.status)
    }

    /// What the running session does, or what the last one did.
    pub fn activity(&self) -> SessionActivity {
        self.last_activity
    }

    pub fn active_intent(&self) -> Option<SessionStartIntent> {
        self.active_intent
    }

    pub fn last_session_id(&self) -> Option<&str> {
        self.last_session_id.as_deref()
    }

    pub fn stop_overrun(&self) -> bool {
        self.stop_overrun
    }

    pub fn stop_confirmation(&self) -> Option<&StopConfirmation> {
        self.stop_confirmation.as_ref()
    }

    pub fn start_failure(&self) -> Option<&SessionStartFailure> {
        self.start_failure.as_ref()
    }

    pub fn runtime_notice(&self) -> Option<&RecordingFailedNotice> {
        self.runtime_notice.as_ref()
    }

    pub fn start_pending(&self) -> bool {
        self.start_pending
    }

    pub fn stop_pending(&self) -> bool {
        self.stop_pending
    }

    pub fn armed_at(&self) -> Option<Instant> {
        self.armed_at
    }

    // --- the recording.status event ---

    /// A status the backend pushed (`recording.status`), or read at
    /// bootstrap. The event handler's rules, then `applyRecordingStatus`.
    pub fn apply_reported_status(
        &mut self,
        incoming: RecordingStatus,
        now: Instant,
    ) -> Vec<SessionEffect> {
        // A `stopping` that arrives after the same session's terminal status
        // is the reordered tail of a stop (the event and the answer to
        // `session.stop` travel on different lanes): the terminal status
        // stays.
        if matches!(incoming.state, RecordingState::Stopping)
            && matches!(
                self.status.state,
                RecordingState::Idle | RecordingState::Failed
            )
            && incoming.session_id.is_some()
            && incoming.session_id == self.status.session_id
        {
            return Vec::new();
        }
        let previous_state = self.status.state.clone();
        let previously_live = session_is_live(&self.status);
        let previously_replay_only = session_is_replay_only(&self.status);
        let previous_session_id = self
            .status
            .session_id
            .clone()
            .or_else(|| self.last_session_id.clone());

        // Some terminal pushes omit the session id. The session that was
        // running is the one that ended.
        let mut status = incoming;
        if status.session_id.is_none()
            && matches!(status.state, RecordingState::Idle | RecordingState::Failed)
            && matches!(
                previous_state,
                RecordingState::Recording | RecordingState::Streaming | RecordingState::Stopping
            )
        {
            status.session_id = previous_session_id.clone();
        }

        self.note_authoritative(&status);

        self.last_reported_state = Some(status.state.clone());
        if let Some(session_id) = &status.session_id {
            self.last_session_id = Some(session_id.clone());
        }

        let mut effects = Vec::new();
        let ran_to_idle = idle_ends_session_that_ran(Some(&previous_state), &status.state);
        let became_active = matches!(
            status.state,
            RecordingState::Recording | RecordingState::Streaming
        ) && (!matches!(
            previous_state,
            RecordingState::Recording | RecordingState::Streaming
        ) || (status.session_id.is_some()
            && status.session_id != previous_session_id));
        let went_live = session_is_live(&status) && !previously_live;
        // A session ended: a terminal state after an active one. A repeated
        // terminal tick, or the Idle a bootstrap reads, ends nothing.
        let ended = is_active_state(&previous_state)
            && matches!(status.state, RecordingState::Idle | RecordingState::Failed);
        let finished_activity = self.last_activity;
        let finished_session_id = status
            .session_id
            .clone()
            .or_else(|| self.last_session_id.clone());

        self.apply_status(status.clone());

        if became_active {
            // A new session: the previous one's failure notice is stale.
            self.clear_runtime_notice();
            effects.push(SessionEffect::SessionStarted {
                session_id: status.session_id.clone(),
            });
        }
        if went_live {
            effects.push(SessionEffect::WentLive);
        }
        if ended {
            effects.push(SessionEffect::SessionEnded);
        }
        if ran_to_idle && !previously_replay_only {
            effects.push(SessionEffect::SessionFinished {
                session_id: finished_session_id.clone(),
                activity: finished_activity,
            });
        }
        if ran_to_idle && !previously_replay_only && finished_activity.saves_recording() {
            effects.push(SessionEffect::RecordingSaved {
                session_id: finished_session_id,
                output_path: status.output_path.clone(),
            });
        }
        if matches!(status.state, RecordingState::Failed)
            && !session_is_replay_only(&status)
            && let Some(notice) = self.raise_failure(&status, now)
        {
            effects.push(SessionEffect::RecordingFailed(notice));
        }
        effects
    }

    /// `applyRecordingStatus`: the status the Studio shows, and what follows
    /// from it alone.
    fn apply_status(&mut self, status: RecordingStatus) {
        if matches!(
            status.state,
            RecordingState::Recording | RecordingState::Streaming
        ) && !session_is_replay_only(&status)
        {
            self.last_activity = SessionActivity::of(&status);
        }
        // #1270: a session this app did not start replaced the one it did
        // (its end was missed): the old start intent says nothing about it.
        if let (Some(next), Some(replaced)) = (
            status.session_id.as_deref(),
            self.status.session_id.as_deref(),
        ) && next != replaced
            && !self.start_pending
            && self.start_lifecycle.is_none()
        {
            self.active_intent = None;
        }
        if !is_active_state(&status.state) {
            // Plan 174 S3.1: whatever ended the session, an armed hotkey press
            // means nothing now, and the next start brings its own intent.
            self.armed_at = None;
            self.active_intent = None;
        }
        if !matches!(status.state, RecordingState::Stopping) {
            self.stop_overrun = false;
        }
        // A question about a session that is over has no answer left.
        if let Some(confirmation) = &self.stop_confirmation
            && (!is_active_state(&status.state)
                || (confirmation.session_id.is_some()
                    && status.session_id.is_some()
                    && confirmation.session_id != status.session_id))
        {
            self.stop_confirmation = None;
        }
        self.status = status;
    }

    /// `publishRecordingFailure` with `recordingFailurePresentation`'s
    /// dedupe: one notice per session (or per "active session" without an
    /// id).
    fn raise_failure(
        &mut self,
        status: &RecordingStatus,
        now: Instant,
    ) -> Option<RecordingFailedNotice> {
        let session_id = status
            .session_id
            .clone()
            .or_else(|| self.last_session_id.clone());
        let dedupe_key = session_id
            .clone()
            .unwrap_or_else(|| "active-session".to_string());
        if self.failure_dedupe_key.as_deref() == Some(dedupe_key.as_str()) {
            return None;
        }
        let activity = self.last_activity;
        let message = status.message.clone().unwrap_or_else(|| {
            if activity.is_live() {
                crate::notices::copy::COULDNT_FINISH_LIVESTREAM.to_string()
            } else {
                crate::notices::copy::COULDNT_FINISH_RECORDING.to_string()
            }
        });
        let notice = RecordingFailedNotice {
            activity,
            message,
            session_id,
            output_path: status.output_path.clone(),
            at: now,
        };
        self.failure_dedupe_key = Some(dedupe_key);
        self.runtime_notice = Some(notice.clone());
        Some(notice)
    }

    /// A session the backend reports as failed after a reconnect, with what
    /// the Studio last saw it do (`recoverSessionRuntime`'s failed branch).
    pub fn recover_failure(
        &mut self,
        status: &RecordingStatus,
        activity: SessionActivity,
        now: Instant,
    ) -> Option<SessionEffect> {
        self.last_activity = activity;
        self.raise_failure(status, now)
            .map(SessionEffect::RecordingFailed)
    }

    /// `dismissSessionRuntimeNotice`.
    pub fn dismiss_runtime_notice(&mut self) {
        self.runtime_notice = None;
    }

    /// `clearSessionRuntimeState`: a new session makes the old notice stale.
    fn clear_runtime_notice(&mut self) {
        self.failure_dedupe_key = None;
        self.runtime_notice = None;
    }

    // --- the start flow ---

    /// `noteSessionStartAttempt` plus the optimistic `starting`: what the
    /// Studio shows the moment Record or Go Live is pressed, before the
    /// backend answers. Returns false when a session is already active or a
    /// start is in flight (the renderer joins the in-flight promise; here
    /// the caller reports it).
    pub fn begin_start(&mut self, intent: SessionStartIntent) -> bool {
        // S3.6a: a running buffer-only ring is no session to the streamer:
        // the start hands it over in the backend (plan 181).
        if self.start_pending || (self.is_active() && !self.status.replay_only) {
            return false;
        }
        self.start_pending = true;
        self.start_resumes = false;
        self.active_intent = Some(intent);
        self.start_failure = None;
        self.clear_runtime_notice();
        self.start_lifecycle = Some(StartLifecycle::default());
        let mut optimistic = initial_status();
        optimistic.state = RecordingState::Starting;
        optimistic.message = Some(if intent.stream {
            "Preparing livestream…".to_string()
        } else {
            "Preparing recording…".to_string()
        });
        self.apply_status(optimistic);
        true
    }

    /// Plan 184 C5b: the start in flight is the cloud's Resume
    /// (`cloud.show.resume`), so a refusal is reported as one
    /// (`reportSessionStartFailure(…, 'resume')`). Nothing without a start
    /// in flight.
    pub fn mark_start_resumes(&mut self) {
        if self.start_pending {
            self.start_resumes = true;
        }
    }

    /// The answer to `session.start`, reconciled against the statuses pushed
    /// while it ran. Returns the resolution and the effects of applying it.
    pub fn finish_start(
        &mut self,
        response: RecordingStatus,
        now: Instant,
    ) -> (StartResolution, Vec<SessionEffect>) {
        let authoritative = response.session_id.as_ref().and_then(|session_id| {
            self.start_lifecycle
                .as_ref()
                .and_then(|lifecycle| lifecycle.authoritative.get(session_id))
                .cloned()
        });
        let resolution = reconcile_start_response(response, authoritative.as_ref());
        let effects = self.apply_reported_status(resolution.status.clone(), now);
        self.start_pending = false;
        self.start_resumes = false;
        self.start_lifecycle = None;
        (resolution, effects)
    }

    /// `session.start` failed (`reportSessionStartFailure` and what follows
    /// it in the start flow's catch).
    pub fn fail_start(&mut self, message: String, now: Instant) -> Vec<SessionEffect> {
        let intent = self.active_intent.unwrap_or(SessionStartIntent::RECORD);
        let kind = if std::mem::take(&mut self.start_resumes) {
            SessionStartFailureKind::Resume
        } else {
            SessionStartFailureKind::of_intent(intent)
        };
        let failure = SessionStartFailure {
            message,
            kind,
            intent,
            at: now,
        };
        self.start_failure = Some(failure.clone());
        if matches!(self.status.state, RecordingState::Starting) && self.status.session_id.is_none()
        {
            let mut idle = initial_status();
            idle.message = Some(READY_TO_START_MESSAGE.to_string());
            self.apply_status(idle);
        }
        // #1270: nothing runs, or the session that runs is not this start's
        // (a refused `session.start` named none, so any session with an id
        // is another's).
        if !self.is_active() || self.status.session_id.is_some() {
            self.active_intent = None;
        }
        self.start_pending = false;
        self.start_lifecycle = None;
        vec![SessionEffect::StartFailed(failure)]
    }

    /// A start whose future was dropped before `session.start` answered (a
    /// Rust-only end: Electron's start promise always reaches its answer or
    /// its catch). The optimistic `starting` goes back to Idle with no
    /// failure, since nothing refused it; a session the request did start
    /// arrives with its own `recording.status`. False when no start was
    /// pending (the answer or the failure already ended it).
    pub fn abandon_start(&mut self) -> bool {
        if !self.start_pending {
            return false;
        }
        if matches!(self.status.state, RecordingState::Starting) && self.status.session_id.is_none()
        {
            let mut idle = initial_status();
            idle.message = Some(READY_TO_START_MESSAGE.to_string());
            self.apply_status(idle);
        }
        // A session pushed while the start ran is this start's: it keeps its
        // intent.
        if !self.is_active() {
            self.active_intent = None;
        }
        self.start_pending = false;
        self.start_resumes = false;
        self.start_lifecycle = None;
        true
    }

    /// S3.5c: a Go Live refused before its start (the preflight, platform
    /// setup): the same persistent failure, and Retry opens Go Live again.
    pub fn fail_go_live(
        &mut self,
        message: String,
        intent: SessionStartIntent,
        now: Instant,
    ) -> Vec<SessionEffect> {
        self.fail_before_start(message, SessionStartFailureKind::Live, intent, now)
    }

    /// A start refused before `session.start` (Go Live's preflight, or the
    /// cloud's Resume, plan 184 C5b): the persistent failure with its kind,
    /// and the session is left as it is.
    pub fn fail_before_start(
        &mut self,
        message: String,
        kind: SessionStartFailureKind,
        intent: SessionStartIntent,
        now: Instant,
    ) -> Vec<SessionEffect> {
        let failure = SessionStartFailure {
            message,
            kind,
            intent,
            at: now,
        };
        self.start_failure = Some(failure.clone());
        vec![SessionEffect::StartFailed(failure)]
    }

    /// `dismissSessionStartFailure`.
    pub fn dismiss_start_failure(&mut self) {
        self.start_failure = None;
    }

    /// A stopping or terminal status for a session while a start runs is
    /// kept, so the start's answer cannot resurrect it.
    fn note_authoritative(&mut self, status: &RecordingStatus) {
        if let Some(lifecycle) = self.start_lifecycle.as_mut()
            && let Some(session_id) = &status.session_id
            && matches!(
                status.state,
                RecordingState::Stopping | RecordingState::Idle | RecordingState::Failed
            )
        {
            lifecycle
                .authoritative
                .insert(session_id.clone(), status.clone());
        }
    }

    // --- the stop door ---

    /// `requestStopSession`: the one door to a stop for every origin.
    /// `platforms` are the enabled destinations' labels, for the question.
    pub fn request_stop(
        &mut self,
        origin: StopOrigin,
        platforms: Vec<String>,
        now: Instant,
    ) -> StopRequest {
        match stop_decision(origin, self.is_live(), self.armed_at, now) {
            StopDecision::Stop => {
                self.armed_at = None;
                StopRequest::Stop
            }
            StopDecision::Arm => {
                self.armed_at = Some(now);
                StopRequest::Armed
            }
            StopDecision::Confirm => {
                let confirmation = StopConfirmation {
                    origin,
                    session_id: self.status.session_id.clone(),
                    platforms,
                    also_records: matches!(self.status.state, RecordingState::Recording),
                };
                self.stop_confirmation = Some(confirmation.clone());
                StopRequest::Confirm(confirmation)
            }
        }
    }

    /// `confirmStopSession`: the answer "End livestream". Returns the exit
    /// the app continues with, if it was leaving.
    pub fn confirm_stop(&mut self) -> Option<StopExit> {
        let confirmation = self.stop_confirmation.take()?;
        exit_for_stop_origin(confirmation.origin)
    }

    /// `cancelStopSession`: "Keep streaming".
    pub fn cancel_stop(&mut self) {
        self.stop_confirmation = None;
    }

    /// `stopSession` begins: true when a stop may run (one at a time).
    pub fn begin_stop(&mut self) -> bool {
        if self.stop_pending {
            return false;
        }
        self.stop_pending = true;
        true
    }

    /// The answer to `session.stop`.
    pub fn finish_stop(&mut self, response: RecordingStatus, now: Instant) -> Vec<SessionEffect> {
        self.stop_pending = false;
        self.apply_reported_status(response, now)
    }

    /// `session.stop` failed, or was not needed.
    pub fn end_stop(&mut self) {
        self.stop_pending = false;
    }

    /// `health.event` `recording-stop-finalize-overrun` (B-16).
    pub fn note_stop_overrun(&mut self) {
        self.stop_overrun = true;
    }

    /// What the Studio last saw before a reconnect
    /// (`priorSessionState`, `priorSessionId`, `priorSessionActivity`).
    pub fn prior_session(&self) -> PriorSession {
        let state = self
            .last_reported_state
            .clone()
            .unwrap_or_else(|| self.status.state.clone());
        let activity = matches!(state, RecordingState::Recording | RecordingState::Streaming)
            .then_some(self.last_activity);
        PriorSession {
            was_active: is_active_state(&state),
            session_id: self
                .last_session_id
                .clone()
                .or_else(|| self.status.session_id.clone()),
            state,
            activity,
        }
    }
}

/// The session the Studio knew before a reconnect, for the recovery that
/// follows the bootstrap.
#[derive(Debug, Clone)]
pub struct PriorSession {
    pub was_active: bool,
    pub session_id: Option<String>,
    pub state: RecordingState,
    pub activity: Option<SessionActivity>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: RecordingState, session_id: Option<&str>) -> RecordingStatus {
        RecordingStatus {
            state,
            session_id: session_id.map(str::to_string),
            message: None,
            ..initial_status()
        }
    }

    fn live(session_id: &str) -> RecordingStatus {
        RecordingStatus {
            stream_url: Some("rtmp://localhost/live".to_string()),
            ..status(RecordingState::Recording, Some(session_id))
        }
    }

    #[test]
    fn phases_follow_the_backend_states_and_the_stream_url() {
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Idle, None)),
            SessionPhase::Idle
        );
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Starting, None)),
            SessionPhase::Starting
        );
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Recording, Some("s"))),
            SessionPhase::Recording
        );
        assert_eq!(SessionPhase::from_status(&live("s")), SessionPhase::Live);
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Streaming, Some("s"))),
            SessionPhase::Live
        );
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Stopping, Some("s"))),
            SessionPhase::Stopping
        );
        assert_eq!(
            SessionPhase::from_status(&status(RecordingState::Failed, Some("s"))),
            SessionPhase::Failed
        );
        assert!(SessionPhase::Stopping.is_active());
        assert!(!SessionPhase::Failed.is_active());
        assert_eq!(
            SessionActivity::of(&live("s")),
            SessionActivity::RecordAndStream
        );
        assert_eq!(
            SessionActivity::of(&status(RecordingState::Streaming, Some("s"))),
            SessionActivity::LiveStream
        );
        assert!(SessionActivity::RecordAndStream.saves_recording());
        assert!(!SessionActivity::LiveStream.saves_recording());
        assert!(!SessionActivity::Recording.is_live());
    }

    #[test]
    fn a_dropped_start_goes_back_to_idle_without_a_failure() {
        let now = Instant::now();
        let mut session = SessionState::new();
        assert!(session.begin_start(SessionStartIntent::RECORD));
        assert!(session.abandon_start());
        assert!(!session.start_pending());
        assert_eq!(session.phase(), SessionPhase::Idle);
        assert_eq!(session.active_intent(), None);
        assert!(session.start_failure().is_none(), "nothing refused it");
        assert!(!session.abandon_start(), "only once");
        // The next press starts again.
        assert!(session.begin_start(SessionStartIntent::RECORD));

        // A session pushed while the start ran stays, with its intent.
        session.apply_reported_status(status(RecordingState::Recording, Some("s1")), now);
        assert!(session.abandon_start());
        assert_eq!(session.phase(), SessionPhase::Recording);
        assert_eq!(session.active_intent(), Some(SessionStartIntent::RECORD));
        // An answered start leaves nothing to abandon.
        assert!(!session.abandon_start());
    }

    #[test]
    fn a_dropped_stop_lets_the_next_stop_run() {
        let mut session = SessionState::new();
        assert!(session.begin_stop());
        assert!(!session.begin_stop(), "one at a time");
        session.end_stop();
        assert!(session.begin_stop());
    }

    #[test]
    fn idle_to_recording_to_stopping_to_idle_saves_the_recording() {
        let now = Instant::now();
        let mut session = SessionState::new();
        assert!(session.begin_start(SessionStartIntent::RECORD));
        assert_eq!(session.phase(), SessionPhase::Starting);
        assert!(session.start_pending());
        assert_eq!(
            session.status().message.as_deref(),
            Some("Preparing recording…")
        );
        // A second press while the first runs is refused.
        assert!(!session.begin_start(SessionStartIntent::RECORD));

        let (resolution, effects) =
            session.finish_start(status(RecordingState::Recording, Some("s1")), now);
        assert!(resolution.session_active);
        assert!(!resolution.superseded_by_authoritative_event);
        assert_eq!(
            effects,
            vec![SessionEffect::SessionStarted {
                session_id: Some("s1".to_string())
            }]
        );
        assert_eq!(session.phase(), SessionPhase::Recording);
        assert_eq!(session.active_intent(), Some(SessionStartIntent::RECORD));
        assert!(!session.start_pending());

        // Repeated ticks of the same state are quiet.
        assert!(
            session
                .apply_reported_status(status(RecordingState::Recording, Some("s1")), now)
                .is_empty()
        );

        assert_eq!(
            session.request_stop(StopOrigin::Button, Vec::new(), now),
            StopRequest::Stop,
            "a recording stops at once"
        );
        assert!(session.begin_stop());
        assert!(!session.begin_stop(), "one stop at a time");
        let effects = session.finish_stop(status(RecordingState::Stopping, Some("s1")), now);
        assert!(effects.is_empty());
        assert_eq!(session.phase(), SessionPhase::Stopping);
        session.note_stop_overrun();
        assert!(session.stop_overrun());

        let mut saved = status(RecordingState::Idle, Some("s1"));
        saved.output_path = Some("/tmp/take.mkv".to_string());
        let effects = session.apply_reported_status(saved, now);
        assert_eq!(
            effects,
            vec![
                SessionEffect::SessionEnded,
                SessionEffect::SessionFinished {
                    session_id: Some("s1".to_string()),
                    activity: SessionActivity::Recording
                },
                SessionEffect::RecordingSaved {
                    session_id: Some("s1".to_string()),
                    output_path: Some("/tmp/take.mkv".to_string())
                }
            ]
        );
        assert_eq!(session.phase(), SessionPhase::Idle);
        assert!(!session.stop_overrun(), "cleared outside stopping");
        assert_eq!(session.active_intent(), None);
        assert_eq!(session.last_session_id(), Some("s1"));
    }

    #[test]
    fn a_terminal_push_without_a_session_id_names_the_session_that_ran() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.apply_reported_status(status(RecordingState::Recording, Some("s7")), now);
        let effects = session.apply_reported_status(status(RecordingState::Failed, None), now);
        assert_eq!(session.status().session_id.as_deref(), Some("s7"));
        assert!(matches!(
            &effects[..],
            [
                SessionEffect::SessionEnded,
                SessionEffect::RecordingFailed(RecordingFailedNotice { session_id: Some(id), .. })
            ] if id == "s7"
        ));
    }

    #[test]
    fn a_failed_session_raises_one_notice_until_the_next_session() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.apply_reported_status(live("s1"), now);
        assert_eq!(session.activity(), SessionActivity::RecordAndStream);
        let mut failed = status(RecordingState::Failed, Some("s1"));
        failed.message = Some("The encoder quit.".to_string());
        let effects = session.apply_reported_status(failed.clone(), now);
        let notice = match &effects[..] {
            [
                SessionEffect::SessionEnded,
                SessionEffect::RecordingFailed(notice),
            ] => notice.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(notice.message, "The encoder quit.");
        assert_eq!(notice.title(), "Livestream stopped unexpectedly");
        assert_eq!(session.runtime_notice(), Some(&notice));
        // The backend repeats the terminal state: no second notice, and
        // nothing ended again.
        assert!(session.apply_reported_status(failed, now).is_empty());
        // A later failure without a message gets the default copy, and the
        // live activity is remembered from the session that ran.
        session.dismiss_runtime_notice();
        assert_eq!(session.runtime_notice(), None);
        session.apply_reported_status(status(RecordingState::Recording, Some("s2")), now);
        assert_eq!(session.runtime_notice(), None, "a new session clears it");
        let effects =
            session.apply_reported_status(status(RecordingState::Failed, Some("s2")), now);
        assert!(matches!(
            &effects[..],
            [SessionEffect::SessionEnded, SessionEffect::RecordingFailed(notice)]
                if notice.message == "Videorc couldn't finish this recording."
                    && notice.title() == "Recording stopped unexpectedly"
        ));
    }

    #[test]
    fn remotes_see_what_the_session_does_not_the_saved_mode() {
        let idle = initial_status();
        let input = |status, active, start_intent, previous| RemoteOutputInput {
            session_active: active,
            start_intent,
            status,
            record_enabled: true,
            stream_enabled: true,
            previous,
        };
        let saved = SessionStartIntent::saved_mode(true, true);
        // Idle: the saved mode a Go Live would follow, whatever came before.
        assert_eq!(
            remote_output_intent(input(&idle, false, None, Some(SessionStartIntent::RECORD))),
            saved
        );
        // This app's own start wins while its session runs.
        let recording = status(RecordingState::Recording, Some("s1"));
        assert_eq!(
            remote_output_intent(input(
                &recording,
                true,
                Some(SessionStartIntent::RECORD),
                None
            )),
            SessionStartIntent::RECORD
        );
        // Another app's take: a Record take never reads as live.
        assert_eq!(
            remote_output_intent(input(&recording, true, None, None)),
            SessionStartIntent::RECORD
        );
        let mut live = status(RecordingState::Streaming, Some("s2"));
        live.stream_url = Some("rtmp://example/live".to_string());
        assert_eq!(
            remote_output_intent(input(&live, true, None, None)),
            SessionStartIntent::livestream(false)
        );
        let mut both = status(RecordingState::Recording, Some("s3"));
        both.stream_url = Some("rtmp://example/live".to_string());
        assert_eq!(
            remote_output_intent(input(&both, true, None, None)),
            SessionStartIntent::livestream(true)
        );
        // A starting status that names its session lists what it opens.
        let mut starting = status(RecordingState::Starting, Some("s4"));
        starting.output_path = Some("/tmp/take.mkv".to_string());
        assert_eq!(
            remote_output_intent(input(&starting, true, None, None)),
            SessionStartIntent::RECORD
        );
        // A starting status with no session yet, or the stop tail: the last
        // answer, else the saved mode.
        let unnamed = status(RecordingState::Starting, None);
        assert_eq!(
            remote_output_intent(input(&unnamed, true, None, None)),
            saved
        );
        let stopping = status(RecordingState::Stopping, Some("s3"));
        assert_eq!(
            remote_output_intent(input(
                &stopping,
                true,
                None,
                Some(SessionStartIntent::livestream(false))
            )),
            SessionStartIntent::livestream(false)
        );
    }

    #[test]
    fn a_session_another_app_started_drops_this_app_s_intent() {
        let now = Instant::now();
        let mut session = SessionState::new();
        assert!(session.begin_start(SessionStartIntent::RECORD));
        session.finish_start(status(RecordingState::Recording, Some("mine")), now);
        assert_eq!(session.active_intent(), Some(SessionStartIntent::RECORD));
        // The same session's statuses keep it.
        session.apply_reported_status(status(RecordingState::Recording, Some("mine")), now);
        assert_eq!(session.active_intent(), Some(SessionStartIntent::RECORD));
        // Its end was missed and another session runs now.
        session.apply_reported_status(status(RecordingState::Streaming, Some("theirs")), now);
        assert_eq!(session.active_intent(), None);

        // A refused start while another's session runs keeps no intent.
        let mut session = SessionState::new();
        session.apply_reported_status(status(RecordingState::Recording, Some("theirs")), now);
        session.apply_reported_status(status(RecordingState::Idle, Some("theirs")), now);
        assert!(session.begin_start(SessionStartIntent::livestream(false)));
        session.apply_reported_status(status(RecordingState::Recording, Some("theirs-2")), now);
        session.fail_start("Busy.".to_string(), now);
        assert_eq!(session.active_intent(), None);
    }

    #[test]
    fn a_failed_start_names_what_failed() {
        assert_eq!(
            session_start_failed_title(SessionStartFailureKind::Record),
            "Couldn't start recording"
        );
        assert_eq!(
            session_start_failed_title(SessionStartFailureKind::Live),
            "Couldn't go live"
        );
        assert_eq!(
            session_start_failed_title(SessionStartFailureKind::Resume),
            "Couldn't resume the stream"
        );
        let now = Instant::now();
        let mut session = SessionState::new();
        let effects = session.fail_before_start(
            "The cloud stream ended.".to_string(),
            SessionStartFailureKind::Resume,
            SessionStartIntent::livestream(false),
            now,
        );
        assert!(matches!(
            &effects[..],
            [SessionEffect::StartFailed(failure)] if failure.kind == SessionStartFailureKind::Resume
        ));
        assert_eq!(
            session.phase(),
            SessionPhase::Idle,
            "a refusal before the start leaves the session"
        );
    }

    #[test]
    fn a_refused_resume_is_reported_as_a_resume_and_the_next_start_is_its_own() {
        let now = Instant::now();
        let mut session = SessionState::new();
        // Nothing in flight: nothing to mark.
        session.mark_start_resumes();
        let intent = SessionStartIntent::livestream(false);
        assert!(session.begin_start(intent));
        session.mark_start_resumes();
        let effects = session.fail_start("The cloud stream ended.".to_string(), now);
        let failure = match &effects[..] {
            [SessionEffect::StartFailed(failure)] => failure.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(failure.kind, SessionStartFailureKind::Resume);
        assert_eq!(failure.intent, intent, "Retry runs the same start");
        assert_eq!(
            session_start_failed_title(failure.kind),
            "Couldn't resume the stream"
        );
        assert_eq!(session.phase(), SessionPhase::Idle);
        // A Go Live after it is a Go Live again.
        assert!(session.begin_start(intent));
        let effects = session.fail_start("No destination is enabled.".to_string(), now);
        assert!(matches!(
            &effects[..],
            [SessionEffect::StartFailed(failure)] if failure.kind == SessionStartFailureKind::Live
        ));
        // An answered resume leaves no mark behind for the start after it.
        assert!(session.begin_start(intent));
        session.mark_start_resumes();
        session.finish_start(live("s1"), now);
        session.apply_reported_status(status(RecordingState::Idle, Some("s1")), now);
        assert!(session.begin_start(intent));
        let effects = session.fail_start("Busy.".to_string(), now);
        assert!(matches!(
            &effects[..],
            [SessionEffect::StartFailed(failure)] if failure.kind == SessionStartFailureKind::Live
        ));
    }

    #[test]
    fn a_refused_start_goes_back_to_idle_with_the_reason() {
        let now = Instant::now();
        let mut session = SessionState::new();
        assert!(session.begin_start(SessionStartIntent::livestream(true)));
        let effects = session.fail_start("No destination is enabled.".to_string(), now);
        let failure = match &effects[..] {
            [SessionEffect::StartFailed(failure)] => failure.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(failure.kind, SessionStartFailureKind::Live);
        assert_eq!(failure.intent, SessionStartIntent::livestream(true));
        assert_eq!(session_start_failed_title(failure.kind), "Couldn't go live");
        assert_eq!(session.phase(), SessionPhase::Idle);
        assert_eq!(
            session.status().message.as_deref(),
            Some(READY_TO_START_MESSAGE)
        );
        assert_eq!(session.active_intent(), None);
        assert!(!session.start_pending());
        assert_eq!(session.start_failure(), Some(&failure));
        // The next attempt clears the line (noteSessionStartAttempt).
        assert!(session.begin_start(SessionStartIntent::RECORD));
        assert_eq!(session.start_failure(), None);
        session.dismiss_start_failure();
    }

    #[test]
    fn a_start_rejected_by_the_backend_answers_idle_and_ends_nothing() {
        // The backend's rejected start is an Idle with a session id and a
        // message (recording_start_rejected_status): not a failure notice,
        // not a saved recording.
        let now = Instant::now();
        let mut session = SessionState::new();
        session.begin_start(SessionStartIntent::RECORD);
        let mut rejected = status(RecordingState::Idle, Some("s3"));
        rejected.message = Some("Could not start: no video source.".to_string());
        let (resolution, effects) = session.finish_start(rejected, now);
        assert!(!resolution.session_active);
        assert_eq!(effects, vec![SessionEffect::SessionEnded]);
        assert_eq!(session.phase(), SessionPhase::Idle);
        assert_eq!(session.runtime_notice(), None);
    }

    #[test]
    fn a_terminal_push_during_the_start_overtakes_the_answer() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.begin_start(SessionStartIntent::RECORD);
        // The backend started s4 and it died before session.start answered.
        session.apply_reported_status(status(RecordingState::Recording, Some("s4")), now);
        let effects =
            session.apply_reported_status(status(RecordingState::Failed, Some("s4")), now);
        assert!(matches!(
            &effects[..],
            [
                SessionEffect::SessionEnded,
                SessionEffect::RecordingFailed(_)
            ]
        ));
        let (resolution, _) =
            session.finish_start(status(RecordingState::Recording, Some("s4")), now);
        assert!(resolution.superseded_by_authoritative_event);
        assert!(!resolution.session_active);
        assert_eq!(session.phase(), SessionPhase::Failed);
        // Another session's terminal status does not supersede.
        let mut again = SessionState::new();
        again.begin_start(SessionStartIntent::RECORD);
        again.apply_reported_status(status(RecordingState::Idle, Some("old")), now);
        let (resolution, _) =
            again.finish_start(status(RecordingState::Recording, Some("s5")), now);
        assert!(!resolution.superseded_by_authoritative_event);
        assert!(resolution.session_active);
    }

    #[test]
    fn going_live_asks_before_stopping_and_remembers_the_exit() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.begin_start(SessionStartIntent::livestream(true));
        let (_, effects) = session.finish_start(live("s6"), now);
        assert_eq!(
            effects,
            vec![
                SessionEffect::SessionStarted {
                    session_id: Some("s6".to_string())
                },
                SessionEffect::WentLive
            ]
        );
        assert_eq!(session.phase(), SessionPhase::Live);
        let request = session.request_stop(StopOrigin::Button, vec!["Twitch".to_string()], now);
        let StopRequest::Confirm(confirmation) = request else {
            panic!("{request:?}");
        };
        assert_eq!(confirmation.session_id.as_deref(), Some("s6"));
        assert_eq!(confirmation.platforms, ["Twitch"]);
        assert!(confirmation.also_records, "Go Live records too (D19)");
        assert_eq!(session.stop_confirmation(), Some(&confirmation));
        session.cancel_stop();
        assert_eq!(session.stop_confirmation(), None);

        let request = session.request_stop(StopOrigin::Quit, Vec::new(), now);
        assert!(matches!(request, StopRequest::Confirm(_)));
        assert_eq!(session.confirm_stop(), Some(StopExit::Quit));
        assert_eq!(session.stop_confirmation(), None);
        assert_eq!(session.confirm_stop(), None, "nothing left to confirm");

        // Stream Deck and the phone stop at once.
        assert_eq!(
            session.request_stop(StopOrigin::RemoteControl, Vec::new(), now),
            StopRequest::Stop
        );
        assert_eq!(
            session.request_stop(StopOrigin::PhoneRemote, Vec::new(), now),
            StopRequest::Stop
        );
        // Stream-only: no recording stops with it.
        let mut stream_only = SessionState::new();
        stream_only.apply_reported_status(status(RecordingState::Streaming, Some("s8")), now);
        let StopRequest::Confirm(confirmation) =
            stream_only.request_stop(StopOrigin::Space, Vec::new(), now)
        else {
            panic!("expected a question");
        };
        assert!(!confirmation.also_records);
        // The session ends on its own: the open question goes with it.
        stream_only.apply_reported_status(status(RecordingState::Idle, Some("s8")), now);
        assert_eq!(stream_only.stop_confirmation(), None);
    }

    #[test]
    fn a_global_hotkey_arms_and_a_second_press_within_the_window_stops() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.apply_reported_status(live("s9"), now);
        assert_eq!(
            session.request_stop(StopOrigin::GlobalHotkey, Vec::new(), now),
            StopRequest::Armed
        );
        assert_eq!(session.armed_at(), Some(now));
        let late = now + END_LIVESTREAM_ARM_WINDOW + Duration::from_millis(1);
        assert_eq!(
            session.request_stop(StopOrigin::GlobalHotkey, Vec::new(), late),
            StopRequest::Armed,
            "an expired arm starts over"
        );
        let within = late + Duration::from_millis(500);
        assert_eq!(
            session.request_stop(StopOrigin::GlobalHotkey, Vec::new(), within),
            StopRequest::Stop
        );
        assert_eq!(session.armed_at(), None);
        // The session ending drops an arm.
        session.request_stop(StopOrigin::GlobalHotkey, Vec::new(), within);
        session.apply_reported_status(status(RecordingState::Idle, Some("s9")), within);
        assert_eq!(session.armed_at(), None);
        // Not live: the hotkey stops a recording at once.
        let mut recording = SessionState::new();
        recording.apply_reported_status(status(RecordingState::Recording, Some("r")), now);
        assert_eq!(
            recording.request_stop(StopOrigin::GlobalHotkey, Vec::new(), now),
            StopRequest::Stop
        );
    }

    #[test]
    fn the_stop_decision_table_matches_session_stop_ts() {
        let now = Instant::now();
        for origin in [
            StopOrigin::Button,
            StopOrigin::Space,
            StopOrigin::Palette,
            StopOrigin::GlobalHotkey,
            StopOrigin::RemoteControl,
            StopOrigin::PhoneRemote,
            StopOrigin::FailureBanner,
            StopOrigin::Quit,
            StopOrigin::CloseWindow,
        ] {
            assert_eq!(stop_decision(origin, false, None, now), StopDecision::Stop);
        }
        assert_eq!(
            stop_decision(StopOrigin::FailureBanner, true, None, now),
            StopDecision::Confirm
        );
        assert_eq!(
            stop_decision(StopOrigin::CloseWindow, true, None, now),
            StopDecision::Confirm
        );
        assert_eq!(
            stop_decision(StopOrigin::GlobalHotkey, true, Some(now), now),
            StopDecision::Stop
        );
        assert_eq!(
            stop_decision(
                StopOrigin::GlobalHotkey,
                true,
                Some(now),
                now + END_LIVESTREAM_ARM_WINDOW
            ),
            StopDecision::Stop
        );
        assert_eq!(
            exit_for_stop_origin(StopOrigin::CloseWindow),
            Some(StopExit::Close)
        );
        assert_eq!(exit_for_stop_origin(StopOrigin::Button), None);
        assert_eq!(
            end_livestream_title(StopOrigin::Quit),
            "End livestream and quit?"
        );
        assert_eq!(
            end_livestream_title(StopOrigin::Palette),
            END_LIVESTREAM_TITLE
        );
        assert_eq!(
            end_livestream_confirm_label(StopOrigin::CloseWindow),
            "End livestream and close"
        );
    }

    #[test]
    fn the_end_livestream_body_names_the_audience_and_the_recording() {
        let names =
            |list: &[&str]| list_names(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(names(&[]), "");
        assert_eq!(names(&[" Twitch "]), "Twitch");
        assert_eq!(names(&["Twitch", "YouTube"]), "Twitch and YouTube");
        assert_eq!(
            names(&["Twitch", "", "YouTube", "Kick"]),
            "Twitch, YouTube and Kick"
        );
        let question = |platforms: &[&str], also_records: bool| StopConfirmation {
            origin: StopOrigin::Button,
            session_id: None,
            platforms: platforms.iter().map(|s| s.to_string()).collect(),
            also_records,
        };
        assert_eq!(
            end_livestream_body(&question(&["Twitch"], true)),
            "Viewers on Twitch are disconnected. Your recording stops too and is saved to the Library."
        );
        assert_eq!(
            end_livestream_body(&question(&[], false)),
            "Your viewers are disconnected."
        );
    }

    #[test]
    fn a_late_stopping_after_the_terminal_status_is_ignored() {
        let now = Instant::now();
        let mut session = SessionState::new();
        session.apply_reported_status(status(RecordingState::Recording, Some("s1")), now);
        session.begin_stop();
        let effects = session.finish_stop(status(RecordingState::Idle, Some("s1")), now);
        assert!(effects.contains(&SessionEffect::RecordingSaved {
            session_id: Some("s1".to_string()),
            output_path: None
        }));
        assert!(
            session
                .apply_reported_status(status(RecordingState::Stopping, Some("s1")), now)
                .is_empty()
        );
        assert_eq!(session.phase(), SessionPhase::Idle);
        // Another session's stopping is news.
        session.apply_reported_status(status(RecordingState::Stopping, Some("s2")), now);
        assert_eq!(session.phase(), SessionPhase::Stopping);
    }

    #[test]
    fn replay_only_sessions_never_count_as_recordings() {
        let now = Instant::now();
        let mut session = SessionState::new();
        let mut ring = status(RecordingState::Recording, Some("ring"));
        ring.replay_only = true;
        session.apply_reported_status(ring.clone(), now);
        assert_eq!(session.activity(), SessionActivity::Recording);
        let mut ended = status(RecordingState::Idle, Some("ring"));
        ended.replay_only = true;
        let effects = session.apply_reported_status(ended, now);
        assert_eq!(
            effects,
            vec![SessionEffect::SessionEnded],
            "no Recording saved"
        );
        session.apply_reported_status(ring, now);
        let mut died = status(RecordingState::Failed, Some("ring"));
        died.replay_only = true;
        let effects = session.apply_reported_status(died, now);
        assert_eq!(
            effects,
            vec![SessionEffect::SessionEnded],
            "no failure notice"
        );
    }

    #[test]
    fn the_prior_session_is_what_the_backend_last_reported() {
        let now = Instant::now();
        let mut session = SessionState::new();
        assert!(!session.prior_session().was_active);
        session.apply_reported_status(live("p1"), now);
        let prior = session.prior_session();
        assert!(prior.was_active);
        assert_eq!(prior.session_id.as_deref(), Some("p1"));
        assert_eq!(prior.activity, Some(SessionActivity::RecordAndStream));
        // The optimistic Starting is not a report.
        let mut fresh = SessionState::new();
        fresh.begin_start(SessionStartIntent::RECORD);
        let prior = fresh.prior_session();
        assert!(prior.was_active, "starting counts as active");
        assert_eq!(prior.activity, None);
        // A recovered failure raises the notice with the remembered activity.
        let mut back = SessionState::new();
        back.apply_reported_status(status(RecordingState::Streaming, Some("p2")), now);
        let effect = back.recover_failure(
            &status(RecordingState::Failed, Some("p2")),
            SessionActivity::LiveStream,
            now,
        );
        assert!(matches!(
            effect,
            Some(SessionEffect::RecordingFailed(notice)) if notice.activity == SessionActivity::LiveStream
        ));
    }
}
