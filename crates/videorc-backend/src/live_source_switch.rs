//! Session-owned source transactions. Selection revisions are independent of
//! scene revisions and native device generations; delayed work must hold both
//! the session and operation identity before publishing a result.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::protocol::{Scene, SceneSourceKind, SourceSelection};
use crate::state::AppState;

pub const SOURCE_SWITCH_EXECUTION_TIMEOUT: Duration = Duration::from_secs(65);
const RESULT_CACHE_CAPACITY: usize = 32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Capture,
    Camera,
    Microphone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSwitchParams {
    pub session_id: String,
    pub request_id: String,
    pub expected_source_revision: u64,
    pub kind: SourceKind,
    #[serde(deserialize_with = "required_device_id")]
    pub device_id: Option<String>,
    #[serde(default)]
    pub protected_overlay_window_ids: Vec<u32>,
}

fn required_device_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SwitchStage {
    Admitted,
    Preparing,
    Restoring,
    Committing,
    Applied,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourcePreservation {
    Preserved,
    Restored,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSwitchOperation {
    pub request_id: String,
    pub kind: SourceKind,
    pub device_id: Option<String>,
    pub stage: SwitchStage,
    pub reason: Option<String>,
    pub previous_source: SourcePreservation,
    /// A selection commit is not proof that every output has consumed it.
    pub output_observed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSwitchCapability {
    pub kind: SourceKind,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceHealth {
    None,
    Starting,
    Ready,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSourceHealth {
    pub kind: SourceKind,
    pub device_id: Option<String>,
    pub health: SourceHealth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSources {
    pub session_id: String,
    pub source_revision: u64,
    pub output_process_id: Option<u32>,
    pub audio: Option<crate::session_audio::AudioBusStatus>,
    pub confirmed: SourceSelection,
    pub health: Vec<SessionSourceHealth>,
    pub pending: Option<SourceSwitchOperation>,
    pub last_operation: Option<SourceSwitchOperation>,
    pub capabilities: Vec<SourceSwitchCapability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSourcesParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchError {
    InactiveSession,
    Stopping,
    StaleRevision,
    Busy,
    InvalidRequest,
    RequestIdReused,
    Unsupported,
    Superseded,
}

impl SwitchError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InactiveSession => {
                "This source change belongs to a session that is no longer running."
            }
            Self::Stopping => "Source changes are unavailable while the session is stopping.",
            Self::StaleRevision => {
                "The selected sources changed. Refresh session sources before retrying."
            }
            Self::Busy => "Another source change is still in progress.",
            Self::InvalidRequest => {
                "A source change needs a nonempty request ID of at most 128 bytes."
            }
            Self::RequestIdReused => {
                "This request ID was already used for a different source change."
            }
            Self::Unsupported => {
                "The running capture adapter does not support session source transactions."
            }
            Self::Superseded => {
                "This source change was cancelled or superseded before it could commit."
            }
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::InactiveSession => "source-switch-inactive-session",
            Self::Stopping => "source-switch-stopping",
            Self::StaleRevision => "source-switch-stale-revision",
            Self::Busy => "source-switch-busy",
            Self::InvalidRequest => "source-switch-invalid-request",
            Self::RequestIdReused => "source-switch-request-id-reused",
            Self::Unsupported => "source-switch-unsupported",
            Self::Superseded => "source-switch-superseded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    New(SessionSources),
    Existing(SessionSources),
}

impl Admission {
    #[cfg(test)]
    pub fn snapshot(self) -> SessionSources {
        match self {
            Self::New(snapshot) | Self::Existing(snapshot) => snapshot,
        }
    }
}

#[derive(Debug, Default)]
pub struct SourceSwitchCoordinator {
    snapshot: Option<SessionSources>,
    pending_request: Option<SourceSwitchParams>,
    completed: VecDeque<(SourceSwitchParams, SourceSwitchOperation)>,
    stopping: bool,
    deadline: Option<Instant>,
    cancellation: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl SourceSwitchCoordinator {
    pub fn start(&mut self, session_id: String, confirmed: SourceSelection) {
        if let Some(cancelled) = self.cancellation.take() {
            cancelled.store(true, std::sync::atomic::Ordering::Release);
        }
        *self = Self {
            snapshot: Some(SessionSources {
                session_id,
                source_revision: 0,
                output_process_id: None,
                audio: None,
                health: [
                    (
                        SourceKind::Capture,
                        confirmed.window_id.clone().or(confirmed.screen_id.clone()),
                    ),
                    (SourceKind::Camera, confirmed.camera_id.clone()),
                    (SourceKind::Microphone, confirmed.microphone_id.clone()),
                ]
                .into_iter()
                .map(|(kind, device_id)| SessionSourceHealth {
                    kind,
                    health: if device_id.is_some() {
                        SourceHealth::Unknown
                    } else {
                        SourceHealth::None
                    },
                    device_id,
                })
                .collect(),
                confirmed,
                pending: None,
                last_operation: None,
                capabilities: [
                    SourceKind::Capture,
                    SourceKind::Camera,
                    SourceKind::Microphone,
                ]
                .into_iter()
                .map(|kind| SourceSwitchCapability {
                    kind,
                    supported: false,
                    reason: Some(
                        "The running capture adapter does not support session source transactions."
                            .into(),
                    ),
                })
                .collect(),
            }),
            ..Self::default()
        };
    }

    pub fn set_output_process_id(&mut self, pid: u32) {
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.output_process_id = Some(pid);
        }
    }

    pub fn enable_microphone(&mut self) {
        if let Some(snapshot) = self.snapshot.as_mut() {
            for capability in &mut snapshot.capabilities {
                if capability.kind == SourceKind::Microphone {
                    capability.supported = true;
                    capability.reason = None;
                }
            }
        }
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SessionSources, SwitchError> {
        self.snapshot
            .as_ref()
            .filter(|snapshot| snapshot.session_id == session_id)
            .cloned()
            .ok_or(SwitchError::InactiveSession)
    }

    pub fn reconcile_scene(&mut self, session_id: &str, scene: &Scene) -> Option<SessionSources> {
        if self.stopping {
            return None;
        }
        let snapshot = self
            .snapshot
            .as_mut()
            .filter(|snapshot| snapshot.session_id == session_id)?;
        let mut confirmed = snapshot.confirmed.clone();
        for source in &scene.sources {
            match source.kind {
                SceneSourceKind::Camera => confirmed.camera_id = source.device_id.clone(),
                SceneSourceKind::Screen => {
                    confirmed.screen_id = source.device_id.clone();
                    confirmed.window_id = None;
                }
                SceneSourceKind::Window => {
                    confirmed.window_id = source.device_id.clone();
                    confirmed.screen_id = None;
                }
                SceneSourceKind::TestPattern => {}
            }
        }
        if snapshot.confirmed == confirmed {
            return None;
        }
        snapshot.confirmed = confirmed;
        snapshot.source_revision = snapshot.source_revision.saturating_add(1);
        Some(snapshot.clone())
    }

    pub fn stop(&mut self, session_id: &str) {
        if self.snapshot(session_id).is_err() {
            return;
        }
        self.stopping = true;
        if let Some(request) = self.pending_request.clone() {
            let _ = self.finish(
                &request,
                SwitchStage::Cancelled,
                Some("Session stopping".into()),
            );
        }
    }

    /// Admission is synchronous under the session coordinator mutex. Duplicate
    /// requests return the existing operation, including after response loss.
    pub fn admit(&mut self, request: &SourceSwitchParams) -> Result<Admission, SwitchError> {
        let snapshot = self.snapshot(&request.session_id)?;
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            return Err(SwitchError::InvalidRequest);
        }
        if let Some(previous) = self.pending_request.as_ref()
            && previous.request_id == request.request_id
        {
            return if previous == request {
                Ok(Admission::Existing(snapshot))
            } else {
                Err(SwitchError::RequestIdReused)
            };
        }
        if let Some((previous, operation)) = self
            .completed
            .iter()
            .find(|(previous, _)| previous.request_id == request.request_id)
        {
            if previous != request {
                return Err(SwitchError::RequestIdReused);
            }
            let mut result = snapshot;
            result.last_operation = Some(operation.clone());
            return Ok(Admission::Existing(result));
        }
        if self.stopping {
            return Err(SwitchError::Stopping);
        }
        if snapshot.source_revision != request.expected_source_revision {
            return Err(SwitchError::StaleRevision);
        }
        if self.pending_request.is_some() {
            return Err(SwitchError::Busy);
        }
        if !snapshot
            .capabilities
            .iter()
            .any(|capability| capability.kind == request.kind && capability.supported)
        {
            return Err(SwitchError::Unsupported);
        }
        let operation = SourceSwitchOperation {
            request_id: request.request_id.clone(),
            kind: request.kind,
            device_id: request.device_id.clone(),
            stage: SwitchStage::Admitted,
            reason: None,
            previous_source: SourcePreservation::Preserved,
            output_observed: false,
        };
        self.cancellation = Some(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        )));
        self.deadline = Some(Instant::now() + SOURCE_SWITCH_EXECUTION_TIMEOUT);
        self.pending_request = Some(request.clone());
        self.snapshot.as_mut().expect("validated session").pending = Some(operation);
        self.snapshot(&request.session_id).map(Admission::New)
    }

    pub fn cancellation(
        &self,
        request: &SourceSwitchParams,
    ) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, SwitchError> {
        self.validate_commit(request)?;
        self.cancellation.clone().ok_or(SwitchError::Superseded)
    }

    pub fn validate_commit(&self, request: &SourceSwitchParams) -> Result<(), SwitchError> {
        let snapshot = self.snapshot(&request.session_id)?;
        if self.stopping {
            return Err(SwitchError::Stopping);
        }
        if self.pending_request.as_ref() != Some(request)
            || snapshot.source_revision != request.expected_source_revision
            || self
                .cancellation
                .as_ref()
                .is_none_or(|cancelled| cancelled.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(SwitchError::Superseded);
        }
        Ok(())
    }

    pub fn previous_unavailable(&mut self, request: &SourceSwitchParams) {
        if self.pending_request.as_ref() == Some(request)
            && let Some(operation) = self
                .snapshot
                .as_mut()
                .and_then(|snapshot| snapshot.pending.as_mut())
        {
            operation.previous_source = SourcePreservation::Unavailable;
        }
    }

    pub fn set_stage(
        &mut self,
        request: &SourceSwitchParams,
        stage: SwitchStage,
    ) -> Result<SessionSources, SwitchError> {
        self.validate_commit(request)?;
        self.snapshot
            .as_mut()
            .expect("validated session")
            .pending
            .as_mut()
            .expect("admitted operation")
            .stage = stage;
        self.snapshot(&request.session_id)
    }

    /// Called under the same short mutex as the bus route installation. This
    /// receipt survives a lost RPC response and never waits for transport I/O.
    pub fn commit_microphone(
        &mut self,
        request: &SourceSwitchParams,
    ) -> Result<SessionSources, SwitchError> {
        self.validate_commit(request)?;
        let snapshot = self.snapshot.as_mut().expect("validated session");
        snapshot.confirmed.microphone_id = request.device_id.clone();
        snapshot.source_revision = snapshot.source_revision.saturating_add(1);
        self.finish(request, SwitchStage::Applied, None)
    }

    pub fn observe_output(&mut self, session_id: &str, request_id: &str) {
        if self.snapshot(session_id).is_err() {
            return;
        }
        for (request, operation) in &mut self.completed {
            if request.request_id == request_id {
                operation.output_observed = true;
            }
        }
        if let Some(operation) = self
            .snapshot
            .as_mut()
            .and_then(|snapshot| snapshot.last_operation.as_mut())
            && operation.request_id == request_id
        {
            operation.output_observed = true;
        }
    }

    pub fn expire_at(&mut self, now: Instant) {
        if self.deadline.is_some_and(|deadline| now >= deadline)
            && let Some(request) = self.pending_request.clone()
        {
            let _ = self.finish(
                &request,
                SwitchStage::Failed,
                Some("Source preparation timed out".into()),
            );
        }
    }

    pub fn finish(
        &mut self,
        request: &SourceSwitchParams,
        stage: SwitchStage,
        reason: Option<String>,
    ) -> Result<SessionSources, SwitchError> {
        self.snapshot(&request.session_id)?;
        if self.pending_request.as_ref() != Some(request) {
            return Err(SwitchError::Superseded);
        }
        let snapshot = self.snapshot.as_mut().expect("validated session");
        let mut operation = snapshot.pending.take().expect("admitted operation");
        operation.stage = stage;
        operation.reason = reason;
        snapshot.last_operation = Some(operation.clone());
        self.pending_request = None;
        self.deadline = None;
        if let Some(cancelled) = self.cancellation.take() {
            cancelled.store(true, std::sync::atomic::Ordering::Release);
        }
        self.completed.push_back((request.clone(), operation));
        while self.completed.len() > RESULT_CACHE_CAPACITY {
            self.completed.pop_front();
        }
        self.snapshot(&request.session_id)
    }
}

fn screen_health(
    status: &crate::protocol::PreviewScreenStatus,
    selected_id: Option<&str>,
) -> SourceHealth {
    if status.source_id.as_deref() != selected_id {
        return SourceHealth::Unavailable;
    }
    match status.state {
        // ScreenCaptureKit is change-driven. A retained static frame remains
        // valid while its exact source owner reports Live; camera cadence
        // thresholds must never classify a static desktop as an input loss.
        crate::protocol::PreviewScreenState::Live if status.frames_captured > 0 => {
            SourceHealth::Ready
        }
        crate::protocol::PreviewScreenState::Starting => SourceHealth::Starting,
        _ => SourceHealth::Unavailable,
    }
}

pub async fn get(state: &AppState, session_id: &str) -> Result<SessionSources, SwitchError> {
    // Preview reads do not hold the recording mutex or block Stop behind native work.
    let camera = crate::preview_camera::preview_camera_status(state).await;
    let capture = crate::preview_screen::preview_screen_status(state).await;
    let recording = state.recording.lock().await;
    let (stopping, audio_handle) = recording
        .as_ref()
        .filter(|active| active.session_id == session_id)
        .map(|active| {
            (
                active.stop_requested,
                active
                    .native_audio
                    .as_ref()
                    .map(|audio| audio.switch_handle()),
            )
        })
        .ok_or(SwitchError::InactiveSession)?;
    let mut coordinator = state
        .live_source_switch
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    coordinator.expire_at(Instant::now());
    if stopping {
        coordinator.stop(session_id);
    }
    let mut snapshot = coordinator.snapshot(session_id)?;
    snapshot.audio = audio_handle.as_ref().map(|audio| audio.status());
    let audio_health = audio_handle.as_ref().map(|audio| audio.input_state());
    for health in &mut snapshot.health {
        health.device_id = match health.kind {
            SourceKind::Camera => snapshot.confirmed.camera_id.clone(),
            SourceKind::Capture => snapshot
                .confirmed
                .window_id
                .clone()
                .or(snapshot.confirmed.screen_id.clone()),
            SourceKind::Microphone => snapshot.confirmed.microphone_id.clone(),
        };
        health.health = if health.device_id.is_none() {
            SourceHealth::None
        } else {
            match health.kind {
                SourceKind::Camera if camera.camera_id == health.device_id => match camera.state {
                    crate::protocol::PreviewCameraState::Live
                        if camera.frame_age_ms.is_some_and(|age| age <= 1500) =>
                    {
                        SourceHealth::Ready
                    }
                    crate::protocol::PreviewCameraState::Starting => SourceHealth::Starting,
                    _ => SourceHealth::Unavailable,
                },
                SourceKind::Capture => screen_health(&capture, health.device_id.as_deref()),
                SourceKind::Microphone => match audio_health {
                    Some(crate::audio::NativeAudioInputState::Live) => SourceHealth::Ready,
                    Some(crate::audio::NativeAudioInputState::Starting) => SourceHealth::Starting,
                    Some(_) => SourceHealth::Unavailable,
                    None => SourceHealth::Unknown,
                },
                _ => SourceHealth::Unavailable,
            }
        };
    }
    Ok(snapshot)
}

pub async fn switch(
    state: &AppState,
    request: SourceSwitchParams,
) -> Result<SessionSources, SwitchError> {
    let (handle, existing) = {
        let recording = state.recording.lock().await;
        let active = recording
            .as_ref()
            .filter(|active| active.session_id == request.session_id)
            .ok_or(SwitchError::InactiveSession)?;
        let mut coordinator = state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        coordinator.expire_at(Instant::now());
        if active.stop_requested {
            coordinator.stop(&request.session_id);
        }
        let existing = match coordinator.admit(&request)? {
            Admission::Existing(snapshot) => Some(snapshot),
            Admission::New(_) => {
                if request.kind == SourceKind::Microphone
                    && let Some(audio) = active.native_audio.as_ref()
                {
                    let status = audio.status();
                    if status.device_id == request.device_id
                        && (request.device_id.is_none()
                            || audio.input_state() == crate::audio::NativeAudioInputState::Live)
                    {
                        coordinator.finish(&request, SwitchStage::Applied, None)?;
                        if status.sample_cursor > 0 {
                            coordinator.observe_output(&request.session_id, &request.request_id);
                        }
                        Some(coordinator.snapshot(&request.session_id)?)
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };
        (
            active
                .native_audio
                .as_ref()
                .map(|audio| audio.switch_handle()),
            existing,
        )
    };
    if let Some(existing) = existing {
        let mut snapshot = get(state, &request.session_id).await?;
        // Current selection/health stays authoritative, while the cached
        // terminal outcome still belongs to the retried operation.
        snapshot.last_operation = existing.last_operation;
        return Ok(snapshot);
    }
    let cancelled = {
        let mut coordinator = state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let cancelled = coordinator.cancellation(&request)?;
        let snapshot = coordinator.set_stage(&request, SwitchStage::Preparing)?;
        state.emit_event("session.sources.changed", snapshot);
        cancelled
    };
    let result = async {
        if request.kind != SourceKind::Microphone {
            anyhow::bail!("This source adapter is not ready for replacement.");
        }
        let handle = handle
            .clone()
            .ok_or_else(|| anyhow::anyhow!("This session has no replaceable audio bus."))?;
        handle
            .replace(request.clone(), state.live_source_switch.clone(), cancelled)
            .await
    }
    .await;
    let snapshot = {
        let mut coordinator = state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if result.is_err()
            && handle.as_ref().is_some_and(|audio| {
                matches!(
                    audio.input_state(),
                    crate::audio::NativeAudioInputState::SourceLost
                        | crate::audio::NativeAudioInputState::DownstreamClosed
                )
            })
        {
            coordinator.previous_unavailable(&request);
        }
        match result {
            Ok(_) => coordinator.snapshot(&request.session_id)?,
            Err(error) => {
                match coordinator.finish(&request, SwitchStage::Failed, Some(error.to_string())) {
                    Ok(snapshot) => snapshot,
                    // Stop or an authoritative bus commit may have won already.
                    Err(SwitchError::Superseded | SwitchError::Stopping) => {
                        coordinator.snapshot(&request.session_id)?
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    };
    state.emit_event("session.sources.changed", &snapshot);
    get(state, &request.session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinator() -> SourceSwitchCoordinator {
        let mut coordinator = SourceSwitchCoordinator::default();
        coordinator.start(
            "session".into(),
            SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        for capability in &mut coordinator.snapshot.as_mut().unwrap().capabilities {
            capability.supported = true;
            capability.reason = None;
        }
        coordinator
    }

    fn request(id: &str) -> SourceSwitchParams {
        SourceSwitchParams {
            session_id: "session".into(),
            request_id: id.into(),
            expected_source_revision: 0,
            kind: SourceKind::Microphone,
            device_id: Some("microphone:coreaudio:7".into()),
            protected_overlay_window_ids: vec![],
        }
    }

    #[test]
    fn duplicate_admission_and_lost_response_are_idempotent() {
        let mut coordinator = coordinator();
        let request = request("one");
        let first = coordinator.admit(&request).unwrap().snapshot();
        assert_eq!(
            coordinator.admit(&request).unwrap(),
            Admission::Existing(first)
        );
        let terminal = coordinator
            .finish(&request, SwitchStage::Failed, Some("unavailable".into()))
            .unwrap();
        assert_eq!(
            coordinator.admit(&request).unwrap(),
            Admission::Existing(terminal.clone())
        );
        assert_eq!(coordinator.snapshot("session").unwrap(), terminal);
    }

    #[test]
    fn busy_stale_session_revision_and_identity_are_fenced() {
        let mut coordinator = coordinator();
        let mut invalid = request("invalid");
        invalid.session_id = "previous".into();
        assert_eq!(
            coordinator.admit(&invalid),
            Err(SwitchError::InactiveSession)
        );
        invalid = request("invalid");
        invalid.expected_source_revision = 4;
        assert_eq!(coordinator.admit(&invalid), Err(SwitchError::StaleRevision));
        coordinator.admit(&request("one")).unwrap();
        assert_eq!(coordinator.admit(&request("two")), Err(SwitchError::Busy));
        invalid = request("one");
        invalid.device_id = None;
        assert_eq!(
            coordinator.admit(&invalid),
            Err(SwitchError::RequestIdReused)
        );
    }

    #[test]
    fn stop_cancels_pending_and_rejects_late_completion_or_new_admission() {
        let mut coordinator = coordinator();
        let request = request("one");
        coordinator.admit(&request).unwrap();
        coordinator.stop("session");
        assert_eq!(
            coordinator
                .snapshot("session")
                .unwrap()
                .last_operation
                .unwrap()
                .stage,
            SwitchStage::Cancelled
        );
        assert_eq!(
            coordinator.finish(&request, SwitchStage::Applied, None),
            Err(SwitchError::Superseded)
        );
        let mut next = request.clone();
        next.request_id = "two".into();
        assert_eq!(coordinator.admit(&next), Err(SwitchError::Stopping));
        let confirmed = coordinator.snapshot("session").unwrap().confirmed;
        coordinator.start("next".into(), confirmed);
        assert_eq!(
            coordinator.finish(&request, SwitchStage::Applied, None),
            Err(SwitchError::InactiveSession)
        );
    }

    #[test]
    fn terminal_cache_is_bounded_and_contains_no_source_snapshots() {
        let mut coordinator = coordinator();
        for index in 0..100 {
            let request = request(&index.to_string());
            coordinator.admit(&request).unwrap();
            coordinator
                .finish(&request, SwitchStage::Failed, Some("timeout".into()))
                .unwrap();
        }
        assert_eq!(coordinator.completed.len(), RESULT_CACHE_CAPACITY);
    }

    #[test]
    fn timeout_is_terminal_and_late_completion_cannot_publish() {
        let mut coordinator = coordinator();
        let request = request("deadline");
        coordinator.admit(&request).unwrap();
        coordinator.expire_at(Instant::now() + SOURCE_SWITCH_EXECUTION_TIMEOUT);
        let status = coordinator.snapshot("session").unwrap();
        assert!(status.pending.is_none());
        assert_eq!(status.source_revision, 0);
        assert_eq!(status.last_operation.unwrap().stage, SwitchStage::Failed);
        assert_eq!(
            coordinator.finish(&request, SwitchStage::Applied, None),
            Err(SwitchError::Superseded)
        );
    }

    #[test]
    fn unsupported_transport_has_concrete_reason_and_never_admits() {
        let mut coordinator = coordinator();
        let confirmed = coordinator.snapshot("session").unwrap().confirmed;
        coordinator.start("session".into(), confirmed);
        assert_eq!(
            coordinator.admit(&request("unsupported")),
            Err(SwitchError::Unsupported)
        );
        let snapshot = coordinator.snapshot("session").unwrap();
        assert!(snapshot.pending.is_none());
        assert!(
            snapshot
                .capabilities
                .iter()
                .all(|capability| !capability.supported && capability.reason.is_some())
        );
    }

    #[tokio::test]
    async fn static_screen_is_healthy_but_wrong_identity_is_not() {
        let (events, _) = tokio::sync::broadcast::channel(8);
        let state = AppState::new(
            "test".into(),
            0,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let mut status = crate::preview_screen::preview_screen_status(&state).await;
        status.state = crate::protocol::PreviewScreenState::Live;
        status.source_id = Some("screen:test".into());
        status.frames_captured = 1;
        status.frame_age_ms = Some(6200);
        assert_eq!(
            screen_health(&status, Some("screen:test")),
            SourceHealth::Ready
        );
        assert_eq!(
            screen_health(&status, Some("screen:other")),
            SourceHealth::Unavailable
        );
    }

    #[test]
    fn protocol_is_renderer_only_and_reconciliation_never_waits_for_mutation() {
        use crate::backend_authority::{BackendRole, authorize_backend_method};
        for method in ["session.source.switch", "session.sources.get"] {
            assert!(authorize_backend_method(BackendRole::Renderer, method, false).is_ok());
            assert!(authorize_backend_method(BackendRole::Remote, method, true).is_err());
        }
        assert_eq!(
            crate::websocket_method_execution_policy("session.sources.get"),
            Some(crate::WebSocketMethodExecutionPolicy::Observation)
        );
        assert_eq!(
            crate::websocket_method_execution_policy("session.source.switch"),
            Some(crate::WebSocketMethodExecutionPolicy::Mutation {
                max_execution_age: SOURCE_SWITCH_EXECUTION_TIMEOUT
            })
        );
    }

    #[test]
    fn wire_rejects_whole_config_and_keeps_overlay_exclusions() {
        let mut value = serde_json::to_value(request("one")).unwrap();
        value["protectedOverlayWindowIds"] = serde_json::json!([12, 13]);
        let decoded: SourceSwitchParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded.protected_overlay_window_ids, vec![12, 13]);
        value.as_object_mut().unwrap().remove("deviceId");
        assert!(serde_json::from_value::<SourceSwitchParams>(value.clone()).is_err());
        value["deviceId"] = serde_json::Value::Null;
        assert!(
            serde_json::from_value::<SourceSwitchParams>(value.clone())
                .unwrap()
                .device_id
                .is_none()
        );
        value["video"] = serde_json::json!({});
        assert!(serde_json::from_value::<SourceSwitchParams>(value).is_err());
    }
}
