//! Plan 220 S3.1c: a source change while a session runs, as the renderer's
//! `LiveSourceSelectionController` (`lib/live-source-selection.ts`) makes
//! it: one fence shared by every picker, `session.source.switch` with the
//! revision it read, the backend's answer accepted only for its session and
//! never older than the last, a lost request retried with its own identity,
//! the output's proof read every 250 ms, and what each picker's status line
//! says (`SourceSwitchStatus`). Pure: the Studio drives it
//! (`super::source_actions`).
//!
//! Plan 260 S1.6b part 5a: from `videorc-rust`, with #1543's confirmed merge
//! ([`confirmed_sources_for_commit`]): while a scene commit waits for its
//! proof, only the microphone of a confirmed snapshot is taken.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use videorc_protocol::{Device, RecordingState};

use super::source_selection::{SourceKind, merge_source_kind};

/// `session.sources.get`.
pub const SOURCES_GET_METHOD: &str = "session.sources.get";
/// `session.source.switch`.
pub const SOURCE_SWITCH_METHOD: &str = "session.source.switch";
/// `session.sources.changed`: read the whole authority again.
pub const SOURCES_CHANGED_EVENT: &str = "session.sources.changed";
/// The proof's cadence and its patience (`setTimeout(…, 250)`, 20 reads).
pub const PROOF_INTERVAL_MS: u64 = 250;
pub const PROOF_READS: u32 = 20;
/// A lost request is sent again at most three times.
pub const MAX_ATTEMPTS: u32 = 3;

/// The controller's sentences.
pub mod copy {
    pub const STARTING: &str = "Sources can change once the recording or livestream has started.";
    pub const STOPPING: &str = "Stopping…";
    pub const CHECKING_SOURCE: &str = "Checking source…";
    pub const CHANGING: &str = "Changing source…";
    pub const CHECKING_CONTROLS: &str = "Checking available source controls…";
    pub const COULD_NOT_CHANGE: &str = "The source couldn't be changed.";
    pub const REJECTED: &str = "The source change was rejected.";
    pub const UNCONFIRMED_OUTPUT: &str =
        "The source changed, but Videorc couldn't confirm the output. Check again.";
    pub const CANT_CHECK: &str = "Videorc couldn't check your sources. Check again to reconnect.";
    pub const CANT_CONFIRM: &str =
        "Videorc couldn't confirm the source change. Check again to reconnect.";
    pub const NO_SESSION: &str = "No running session.";
    /// `sourceSwitchReason`'s own two, before the controller's.
    pub const CHECKING_SESSION: &str = "Checking the current session…";
    pub const SCENE_CHANGING: &str = "The scene is changing.";
    pub const SESSION_STARTING: &str = "The session is starting.";
    /// `switchSourceDeviceLive`'s refusal toast.
    pub const TRY_AGAIN: &str = "Try again in a second.";
    /// `SourceSwitchStatus`'s lines.
    pub const RESTORING: &str = "Restoring previous source…";
    pub const TURNING_OFF: &str = "Turning off…";
    pub const UNAVAILABLE_RETRY: &str =
        "Source unavailable. Choose it again to retry, or choose another.";
    pub const UNAVAILABLE_STOP: &str =
        "Source unavailable. Stop, then choose it again or choose another.";
    pub const SUPERSEDED: &str = "Source selected. A newer scene is now active.";
    pub const CHECKING_OUTPUT: &str = "Source changed. Checking output…";
    pub const CHECK_AGAIN: &str = "Check again";
}

// ── The wire ─────────────────────────────────────────────────────────────

/// `SourceSwitchOperation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOperation {
    pub request_id: String,
    pub kind: String,
    #[serde(default)]
    pub device_id: Option<String>,
    /// `admitted`, `preparing`, `restoring`, `committing`, `applied`,
    /// `failed` or `cancelled`.
    pub stage: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub output_observed: bool,
    #[serde(default)]
    pub output_superseded: bool,
}

impl SwitchOperation {
    fn source_kind(&self) -> Option<SourceKind> {
        SourceKind::parse(&self.kind)
    }
    fn ended(&self) -> bool {
        matches!(self.stage.as_str(), "applied" | "failed" | "cancelled")
    }
}

/// One capability (`SourceSwitchCapability`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchCapability {
    pub kind: String,
    pub supported: bool,
    #[serde(default)]
    pub allows_none: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// One source's health (`SessionSourceHealth`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub kind: String,
    #[serde(default)]
    pub device_id: Option<String>,
    /// `none`, `starting`, `ready`, `unavailable` or `unknown`.
    pub health: String,
}

/// `SessionSources`: what the backend's session holds now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSources {
    pub session_id: String,
    pub source_revision: u64,
    #[serde(default)]
    pub output_process_id: Option<u32>,
    #[serde(default)]
    pub confirmed: Value,
    #[serde(default)]
    pub health: Vec<SourceHealth>,
    #[serde(default)]
    pub pending: Option<SwitchOperation>,
    #[serde(default)]
    pub last_operation: Option<SwitchOperation>,
    #[serde(default)]
    pub capabilities: Vec<SwitchCapability>,
}

impl SessionSources {
    pub fn capability(&self, kind: SourceKind) -> Option<&SwitchCapability> {
        self.capabilities
            .iter()
            .find(|capability| capability.kind == kind.as_str())
    }
}

/// `SourceSwitchParams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRequest {
    pub session_id: String,
    pub request_id: String,
    pub expected_source_revision: u64,
    pub kind: String,
    pub device_id: Option<String>,
    pub protected_overlay_window_ids: Vec<u32>,
}

// ── The state the pickers read ───────────────────────────────────────────

/// `LiveSourceSelectionState`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LiveSourcesView {
    pub snapshot: Option<SessionSources>,
    pub pending: Option<SourceKind>,
    pub checking: bool,
    pub error: Option<String>,
    pub error_kind: Option<SourceKind>,
    pub target_name: Option<String>,
    pub output_pending: bool,
}

/// A switch that failed, for its one toast (`failed`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchFailure {
    pub request_id: String,
    pub message: String,
    pub kind: Option<SourceKind>,
    pub device_id: Option<String>,
}

/// What [`LiveSources::accept`] did.
#[derive(Debug, Clone, Default)]
pub struct Accepted {
    pub accepted: bool,
    pub failure: Option<SwitchFailure>,
    /// Read again in 250 ms (a pending switch, or the output's proof).
    pub proof_due: bool,
}

/// The controller. See the module docs.
#[derive(Debug, Clone, Default)]
pub struct LiveSources {
    pub view: LiveSourcesView,
    pub epoch: u64,
    session_id: Option<String>,
    session_state: Option<RecordingState>,
    request_id: Option<String>,
    request: Option<SwitchRequest>,
    attempts: u32,
    proof_request: Option<String>,
    pub proof_reads: u32,
    pub sending: bool,
    pub send_generation: u64,
    /// A read is in flight (Electron's `read !== null`); `read_owner` is its
    /// generation, so only that read clears it (`if (this.read === read)`).
    pub reading: bool,
    pub read_owner: u64,
    pub read_dirty: bool,
    pub read_generation: u64,
    last_failure_request: Option<String>,
}

fn is_running(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Recording | RecordingState::Streaming | RecordingState::Starting
    )
}

impl LiveSources {
    /// `setSession`: a Clips ring alone reads as idle. Answers whether the
    /// session changed (the state reset, and a read is due).
    pub fn set_session(
        &mut self,
        session_id: Option<&str>,
        state: &RecordingState,
        replay_only: bool,
    ) -> bool {
        let effective = if replay_only {
            RecordingState::Idle
        } else {
            state.clone()
        };
        let identity = is_running(&effective)
            .then(|| session_id.map(str::to_string))
            .flatten();
        let same_state = self.session_state.as_ref().is_some_and(|state| {
            std::mem::discriminant(state) == std::mem::discriminant(&effective)
        });
        if identity == self.session_id && same_state {
            return false;
        }
        let reset = identity != self.session_id || !is_running(&effective);
        if reset {
            self.proof_request = None;
            self.proof_reads = 0;
            self.epoch += 1;
            self.session_id = identity;
            self.request_id = None;
            self.request = None;
            self.reading = false;
            self.read_dirty = false;
            self.read_generation += 1;
            self.sending = false;
            self.attempts = 0;
            self.view = LiveSourcesView::default();
        }
        self.session_state = Some(effective);
        true
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// The session can be read (`refresh`'s guard).
    pub fn readable(&self) -> bool {
        self.session_id.is_some()
            && matches!(
                self.session_state,
                Some(RecordingState::Recording | RecordingState::Streaming)
            )
    }

    /// `reason(kind)`: why this picker can't change the source now.
    pub fn reason(&self, kind: SourceKind) -> Option<String> {
        match self.session_state {
            None | Some(RecordingState::Idle | RecordingState::Failed) => return None,
            Some(RecordingState::Starting) => return Some(copy::STARTING.into()),
            Some(RecordingState::Stopping) => return Some(copy::STOPPING.into()),
            _ => {}
        }
        if self.view.pending.is_some() || self.view.checking {
            return Some(if self.view.checking {
                self.view
                    .error
                    .clone()
                    .unwrap_or_else(|| copy::CHECKING_SOURCE.into())
            } else {
                copy::CHANGING.into()
            });
        }
        let capability = self
            .view
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.capability(kind));
        match capability {
            Some(capability) if capability.supported => None,
            Some(capability) => Some(
                capability
                    .reason
                    .clone()
                    .unwrap_or_else(|| copy::CHECKING_CONTROLS.into()),
            ),
            None => Some(copy::CHECKING_CONTROLS.into()),
        }
    }

    /// `allowCaptureNone`'s session half: the capture capability allows None.
    pub fn capture_allows_none(&self) -> bool {
        self.view
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.capability(SourceKind::Capture))
            .is_some_and(|capability| capability.allows_none)
    }

    fn report_failure(
        &mut self,
        request_id: &str,
        message: &str,
        kind: Option<SourceKind>,
        device_id: Option<String>,
    ) -> Option<SwitchFailure> {
        if self.last_failure_request.as_deref() == Some(request_id) {
            return None;
        }
        self.last_failure_request = Some(request_id.to_string());
        Some(SwitchFailure {
            request_id: request_id.to_string(),
            message: message.to_string(),
            kind,
            device_id,
        })
    }

    /// `accept(snapshot, epoch)`: the backend's sources for this session,
    /// never older than the last.
    pub fn accept(&mut self, snapshot: SessionSources, epoch: u64) -> Accepted {
        if epoch != self.epoch || Some(&snapshot.session_id) != self.session_id.as_ref() {
            return Accepted::default();
        }
        let last_revision = self
            .view
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.source_revision);
        if last_revision.is_some_and(|last| snapshot.source_revision < last) {
            return Accepted::default();
        }
        let operation = snapshot.last_operation.clone();
        let completed = self.request_id.is_some()
            && operation.as_ref().is_some_and(|operation| {
                Some(&operation.request_id) == self.request_id.as_ref() && operation.ended()
            });
        let pending = snapshot
            .pending
            .as_ref()
            .and_then(SwitchOperation::source_kind)
            .or(if completed || self.request_id.is_none() {
                None
            } else {
                self.view.pending
            });
        let applied = operation
            .as_ref()
            .is_some_and(|operation| operation.stage == "applied");
        let error = if completed {
            (!applied).then(|| {
                operation
                    .as_ref()
                    .and_then(|operation| operation.reason.clone())
                    .unwrap_or_else(|| copy::COULD_NOT_CHANGE.into())
            })
        } else if self.view.checking && self.request_id.is_none() {
            None
        } else {
            self.view.error.clone()
        };
        let mut failure = None;
        if completed
            && let Some(operation) = operation
                .as_ref()
                .filter(|operation| operation.stage == "failed")
        {
            failure = self.report_failure(
                &operation.request_id.clone(),
                operation
                    .reason
                    .as_deref()
                    .unwrap_or(copy::COULD_NOT_CHANGE),
                operation.source_kind(),
                operation.device_id.clone(),
            );
        }
        if completed {
            self.request_id = None;
            self.request = None;
        }
        let output_pending = operation.as_ref().is_some_and(|operation| {
            operation.stage == "applied"
                && !operation.output_observed
                && !operation.output_superseded
        });
        let operation_id = operation
            .as_ref()
            .map(|operation| operation.request_id.clone());
        if self.proof_request != operation_id {
            self.proof_request = operation_id;
            self.proof_reads = 0;
        }
        let keeps_target = pending.is_some()
            && snapshot
                .pending
                .as_ref()
                .is_none_or(|pending| Some(&pending.request_id) == self.request_id.as_ref());
        let error_kind = if completed && !applied {
            operation.as_ref().and_then(SwitchOperation::source_kind)
        } else if error.is_some() {
            self.view.error_kind
        } else {
            None
        };
        let shown_error = if output_pending && self.proof_reads >= PROOF_READS {
            Some(copy::UNCONFIRMED_OUTPUT.to_string())
        } else if !output_pending && self.view.output_pending {
            None
        } else {
            error
        };
        self.view = LiveSourcesView {
            target_name: keeps_target
                .then(|| self.view.target_name.clone())
                .flatten(),
            checking: self.request_id.is_some() && pending.is_some() && self.view.checking,
            snapshot: Some(snapshot),
            pending,
            output_pending,
            error_kind,
            error: shown_error,
        };
        Accepted {
            accepted: true,
            failure,
            proof_due: (output_pending && self.proof_reads < PROOF_READS) || pending.is_some(),
        }
    }

    /// The request a read finds lost, to send again with its identity.
    pub fn resend_after_read(&self) -> Option<SwitchRequest> {
        let request = self.request.clone()?;
        let lost = self.view.checking
            && self
                .view
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.pending.is_none())
            && !self.sending
            && self.attempts < MAX_ATTEMPTS;
        lost.then_some(request)
    }

    /// A read failed (`refresh`'s catch).
    pub fn read_failed(&mut self) {
        self.view.checking = true;
        self.view.error = Some(copy::CANT_CHECK.into());
    }

    /// `select`'s synchronous part: the fence closes before anything awaits.
    pub fn begin_select(
        &mut self,
        kind: SourceKind,
        device_id: Option<String>,
        target_name: Option<String>,
        request_id: String,
        protected_overlay_window_ids: Vec<u32>,
    ) -> Result<SwitchRequest, String> {
        let reason = self.reason(kind);
        let (Some(session_id), Some(snapshot), None) = (
            self.session_id.clone(),
            self.view.snapshot.as_ref(),
            &reason,
        ) else {
            return Err(reason.unwrap_or_else(|| copy::NO_SESSION.into()));
        };
        let request = SwitchRequest {
            session_id,
            request_id: request_id.clone(),
            expected_source_revision: snapshot.source_revision,
            kind: kind.as_str().to_string(),
            device_id: device_id.clone(),
            protected_overlay_window_ids,
        };
        self.request_id = Some(request_id);
        self.request = Some(request.clone());
        self.attempts = 0;
        self.read_generation += 1;
        self.reading = false;
        self.view.pending = Some(kind);
        self.view.target_name =
            Some(target_name.unwrap_or_else(|| device_id.unwrap_or_else(|| "None".to_string())));
        self.view.output_pending = false;
        self.view.checking = false;
        self.view.error = None;
        Ok(request)
    }

    /// `send`'s start: the attempt counted, a generation for its answer.
    pub fn begin_send(&mut self) -> u64 {
        self.sending = true;
        self.send_generation += 1;
        self.attempts += 1;
        self.send_generation
    }

    /// Whether a send's answer still counts.
    pub fn send_current(&self, epoch: u64, generation: u64, request_id: &str) -> bool {
        epoch == self.epoch
            && generation == self.send_generation
            && self.request_id.as_deref() == Some(request_id)
    }

    pub fn end_send(&mut self, epoch: u64, generation: u64) {
        if epoch == self.epoch && generation == self.send_generation {
            self.sending = false;
        }
    }

    /// The backend refused the switch outright (`source-switch-*`,
    /// `invalid-params`). Answers the toast unless the session is ending.
    pub fn send_rejected(
        &mut self,
        request: &SwitchRequest,
        code: &str,
        message: &str,
    ) -> Option<SwitchFailure> {
        self.read_generation += 1;
        self.reading = false;
        self.request = None;
        self.request_id = None;
        let message = if message.trim().is_empty() {
            copy::REJECTED
        } else {
            message
        };
        self.view.pending = None;
        self.view.checking = false;
        self.view.error = Some(message.to_string());
        self.view.error_kind = SourceKind::parse(&request.kind);
        if code == "source-switch-stopping" || code == "source-switch-inactive-session" {
            return None;
        }
        self.report_failure(
            &request.request_id,
            message,
            SourceKind::parse(&request.kind),
            request.device_id.clone(),
        )
    }

    /// The switch's answer was lost: check, and say so after three tries.
    pub fn send_lost(&mut self) {
        self.view.checking = true;
        self.view.error = (self.attempts >= MAX_ATTEMPTS).then(|| copy::CANT_CONFIRM.into());
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// `retryStatus`'s reset.
    pub fn retry(&mut self) -> bool {
        if self.sending || self.reading {
            return false;
        }
        self.attempts = 0;
        self.proof_reads = 0;
        self.view.error = None;
        true
    }

    /// `reconcile`'s end: still checking with nothing said.
    pub fn give_up_confirming(&mut self) {
        if self.view.checking && self.view.error.is_none() {
            self.view.error = Some(copy::CANT_CONFIRM.into());
        }
    }
}

// ── What the backend confirmed, merged into the capture config ───────────

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// `confirmedSourceSelection`: the backend's ids over the selection, the
/// names kept across an unplug, an earlier None or Off ended only by a
/// confirmed device, a stand-in's pick no longer a wish once confirmed.
pub fn confirmed_source_selection(
    current: &Value,
    snapshot: &SessionSources,
    devices: &[Device],
) -> Value {
    let confirmed = &snapshot.confirmed;
    let id = |key: &str| text(confirmed.get(key));
    let cur = |key: &str| text(current.get(key));
    let name = |id: &Option<String>, old_id: &str, old_name: &str| -> Option<String> {
        let id = id.as_ref()?;
        devices
            .iter()
            .find(|device| &device.id == id)
            .map(|device| device.name.clone())
            .or_else(|| {
                (Some(id) == cur(old_id).as_ref())
                    .then(|| cur(old_name))
                    .flatten()
            })
    };
    let (screen, window, camera, microphone) = (
        id("screenId"),
        id("windowId"),
        id("cameraId"),
        id("microphoneId"),
    );
    let screen_uuid = screen.as_ref().and_then(|screen| {
        devices
            .iter()
            .find(|device| &device.id == screen)
            .and_then(|device| device.display_uuid.clone())
            .or_else(|| {
                (Some(screen) == cur("screenId").as_ref())
                    .then(|| cur("screenUuid"))
                    .flatten()
            })
    });
    let mut next = current.as_object().cloned().unwrap_or_default();
    // `...snapshot.confirmed` first: its other fields (the test pattern).
    if let Some(map) = confirmed.as_object() {
        for (key, value) in map {
            if !value.is_null() {
                next.insert(key.clone(), value.clone());
            }
        }
    }
    let mut set = |key: &str, value: Option<Value>| match value {
        Some(value) => {
            next.insert(key.to_string(), value);
        }
        None => {
            next.remove(key);
        }
    };
    set("screenId", screen.clone().map(Value::String));
    set("windowId", window.clone().map(Value::String));
    set("cameraId", camera.clone().map(Value::String));
    set("microphoneId", microphone.clone().map(Value::String));
    set(
        "screenName",
        name(&screen, "screenId", "screenName").map(Value::String),
    );
    set("screenUuid", screen_uuid.clone().map(Value::String));
    set(
        "windowName",
        name(&window, "windowId", "windowName").map(Value::String),
    );
    set(
        "captureOff",
        if screen.is_some() || window.is_some() {
            None
        } else {
            current.get("captureOff").cloned()
        },
    );
    set(
        "cameraName",
        name(&camera, "cameraId", "cameraName").map(Value::String),
    );
    set(
        "cameraOff",
        if camera.is_some() {
            None
        } else {
            current.get("cameraOff").cloned()
        },
    );
    let wanted_uuid = cur("wantedScreenUuid");
    if screen.is_some()
        && screen == cur("wantedScreenId")
        && (wanted_uuid.is_none() || screen_uuid.is_none() || screen_uuid == wanted_uuid)
    {
        set("wantedScreenId", None);
        set("wantedScreenName", None);
        set("wantedScreenUuid", None);
    }
    if window.is_some() && window == cur("wantedWindowId") {
        set("wantedWindowId", None);
        set("wantedWindowName", None);
    }
    if camera.is_some() && camera == cur("wantedCameraId") {
        set("wantedCameraId", None);
        set("wantedCameraName", None);
    }
    set(
        "microphoneName",
        name(&microphone, "microphoneId", "microphoneName").map(Value::String),
    );
    set(
        "microphoneOff",
        if microphone.is_some() {
            None
        } else {
            current.get("microphoneOff").cloned()
        },
    );
    set(
        "testPattern",
        confirmed
            .get("testPattern")
            .cloned()
            .filter(|value| !value.is_null()),
    );
    Value::Object(next)
}

/// `sourceSelectionController.confirmed`'s merge (#1543): a scene commit
/// publishes its sources before the Studio puts that scene on stream, and
/// its transaction owns the whole picture. While it waits for its proof
/// (`layoutIntentAwaitingProofRef !== null`), only the confirmed
/// microphone is taken, so the next screen is never saved into the scene
/// being left; the visual kinds wait until the commit settles.
pub fn confirmed_sources_for_commit(
    current: &Value,
    selected: &Value,
    scene_pending: bool,
) -> Value {
    if scene_pending {
        merge_source_kind(current, selected, SourceKind::Microphone)
    } else {
        selected.clone()
    }
}

// ── The picker's status line (`SourceSwitchStatus`) ──────────────────────

/// One picker's status line, and whether it offers Check again.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SwitchStatusLine {
    pub message: String,
    pub check_again: bool,
}

/// `SourceSwitchStatus`: the switch's progress, its failure, a source the
/// session lost, the output's proof, else why the picker waits.
pub fn switch_status_line(
    kind: SourceKind,
    view: &LiveSourcesView,
    devices: &[Device],
    switch_reason: Option<&str>,
) -> Option<SwitchStatusLine> {
    let snapshot = view.snapshot.as_ref();
    let pending = snapshot.and_then(|snapshot| snapshot.pending.as_ref());
    let turning_off =
        view.target_name.is_none() && pending.is_some_and(|op| op.device_id.is_none());
    let target_name = view.target_name.clone().or_else(|| {
        let device_id = pending?.device_id.as_ref()?;
        Some(
            devices
                .iter()
                .find(|device| &device.id == device_id)
                .map_or_else(|| device_id.clone(), |device| device.name.clone()),
        )
    });
    let health = snapshot.and_then(|snapshot| {
        snapshot
            .health
            .iter()
            .find(|health| health.kind == kind.as_str())
    });
    let changeable = snapshot
        .and_then(|snapshot| snapshot.capability(kind))
        .is_none_or(|capability| capability.supported);
    let own_error = view
        .error
        .clone()
        .filter(|_| view.error_kind.is_none_or(|error_kind| error_kind == kind));
    let last = snapshot.and_then(|snapshot| snapshot.last_operation.as_ref());
    let message = own_error.or_else(|| {
        if view.checking {
            Some(copy::CHECKING_SOURCE.to_string())
        } else if view.pending == Some(kind) || pending.is_some_and(|op| op.kind == kind.as_str()) {
            Some(if pending.is_some_and(|op| op.stage == "restoring") {
                copy::RESTORING.to_string()
            } else if turning_off {
                copy::TURNING_OFF.to_string()
            } else {
                format!("Preparing {}…", target_name.as_deref().unwrap_or("source"))
            })
        } else if health.is_some_and(|health| health.health == "unavailable") {
            Some(
                if changeable {
                    copy::UNAVAILABLE_RETRY
                } else {
                    copy::UNAVAILABLE_STOP
                }
                .to_string(),
            )
        } else if let Some(last) = last.filter(|last| {
            last.kind == kind.as_str() && last.stage == "applied" && !last.output_observed
        }) {
            Some(
                if last.output_superseded {
                    copy::SUPERSEDED
                } else {
                    copy::CHECKING_OUTPUT
                }
                .to_string(),
            )
        } else {
            switch_reason.map(str::to_string)
        }
    })?;
    Some(SwitchStatusLine {
        message,
        check_again: (view.checking || view.output_pending) && view.error.is_some(),
    })
}

/// `sourceSwitchFailedTitle`.
pub fn switch_failed_title(failure: &SwitchFailure, devices: &[Device]) -> String {
    let noun = match failure.kind {
        Some(SourceKind::Camera) => "camera",
        Some(SourceKind::Microphone) => "microphone",
        _ => "screen",
    };
    let name = failure.device_id.as_ref().and_then(|id| {
        devices
            .iter()
            .find(|device| &device.id == id)
            .map(|device| device.name.trim().to_string())
            .filter(|name| !name.is_empty())
    });
    match (name, &failure.device_id) {
        (Some(name), _) => format!("Couldn't switch to {name}"),
        (None, None) => format!("Couldn't turn off the {noun}"),
        (None, Some(_)) => format!("Couldn't switch the {noun}"),
    }
}

/// `sourceSwitchFailedDescription`: the reason as a sentence, then the fix.
pub fn switch_failed_description(reason: &str) -> String {
    // The adapter's text names its "source transactions" (never shown).
    let lower = reason.to_ascii_lowercase();
    let trimmed = if lower.contains("source transactions") && lower.contains("session") {
        "This source cannot change until you stop, pick a new one, then start again."
    } else {
        reason.trim()
    };
    let sentence = if trimmed.is_empty() || trimmed.ends_with(['.', '!', '?']) {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    };
    if sentence.is_empty() {
        "Choose it again in Sources.".to_string()
    } else {
        format!("{sentence} Choose it again in Sources.")
    }
}

#[cfg(test)]
#[path = "live_sources_tests.rs"]
mod tests;
