//! Live layout preset switching on the native compositor path — Studio Shell And
//! Live Control Plan, slice D1.
//!
//! The compositor already swaps scene snapshots atomically per frame
//! ([`update_compositor_scene`] is revision-ordered and never touches the encoders),
//! so a preset change while recording/streaming is a scene-snapshot swap, not a
//! pipeline restart. What this module adds:
//!
//! - **Hot path:** every source the target preset needs is already delivering fresh
//!   frames → commit the new scene immediately.
//! - **Warm path (swap-on-ready, decision 6):** a needed source is not live → start
//!   it, keep the OLD layout on program output until the source delivers its first
//!   fresh frames, then commit atomically. Viewers never see a placeholder; the
//!   pending state lives in the UI only.
//! - **Honest blocking:** a preset that needs an unselected device, or a source that
//!   fails to start in time, returns an exact error and leaves the running layout
//!   untouched (no silent partial state).
//! - **Revision discipline:** committed revisions are always above both the current
//!   compositor revision and the wallclock-millis revisions used at session start, so
//!   live commits can never be silently rejected by the stale-revision guard.

use std::time::Duration;

use anyhow::{Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio::time::{Instant, sleep};

use crate::compositor::update_compositor_scene;
use crate::live_scene::{ApplyMode, MutationContext, MutationKind, classify_mutation};
#[cfg(test)]
use crate::preview_camera::preview_camera_status_and_starting_identity;
use crate::preview_camera::{
    PreviewCameraFrameInfo, PreviewCameraStartingIdentity,
    begin_capture_recovery_explicit_camera_configuration_mutation, begin_preview_camera_stop,
    begin_preview_camera_stop_if_starting, camera_capture_geometry_is_stale,
    finish_preview_camera_stop, preview_camera_latest_frame_info, preview_camera_status,
    reconcile_explicit_camera_configuration_change, start_preview_camera_for_layout,
    start_preview_camera_for_layout_until_transition_complete,
};
use crate::preview_screen::{
    PreviewScreenFrameInfo, PreviewScreenStartingIdentity, preview_screen_latest_frame_info,
};
use crate::preview_screen::{
    acquire_preview_screen_transition, begin_preview_screen_stop_if_starting_with_transition,
    begin_preview_screen_stop_with_transition, finish_preview_screen_stop, preview_screen_status,
    start_preview_screen_for_live_switch,
};
use crate::protocol::default_layout_settings;
use crate::protocol::{
    CompositorSceneUpdateParams, CompositorStatus, LayoutPreset, LayoutSettings,
    PreviewCameraStartParams, PreviewCameraState, PreviewCameraStatus, PreviewScreenStartParams,
    PreviewScreenState, PreviewScreenStatus, Scene, SceneCommitStatus, SceneConfigParams,
    SceneLayoutApplyParams, SceneSourceKind, SourceSelection, VideoSettings,
};
use crate::scene::{scene_from_capture_config, validate_scene_background};
use crate::screen_capture::{
    is_windows_gdigrab_desktop_screen_id, parse_screencapturekit_display_id,
    parse_screencapturekit_window_id, parse_windows_dxgi_output_index,
};
use crate::state::AppState;

/// Camera warm-start budget covers teardown + AVCaptureSession config +
/// startRunning() + the FIRST FRESH FRAME. External capture devices (Cam Link,
/// Continuity Camera, virtual cams) can take well over 5s to deliver a first
/// frame after HDMI renegotiation, so the camera gets the same budget as the
/// screen. A retry within `preview_camera::CAMERA_FIRST_FRAME_REUSE_GRACE`
/// joins the in-flight warm-up instead of restarting the device.
const WARM_CAMERA_START_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the scene must sit still before an idle geometry resync may
/// restart the camera. Long enough that scene browsing (and any 320ms scene
/// glide) never cycles the device; short enough that the capture box catches
/// up soon after the user settles on a layout.
const CAMERA_GEOMETRY_RESYNC_SETTLE: Duration = Duration::from_secs(2);
const WARM_SCREEN_START_TIMEOUT: Duration = Duration::from_secs(15);
const WARM_SOURCE_POLL: Duration = Duration::from_millis(100);
const LAYOUT_INTENT_CANCEL_POLL: Duration = Duration::from_millis(25);
const UNUSED_CAMERA_STOP_GRACE: Duration = Duration::from_secs(1);
/// A source counts as live only when its newest frame is at most this old — a stalled
/// capturer must not be swapped onto program output.
const SOURCE_FRESH_FRAME_MAX_AGE_MS: u64 = 1_500;

#[derive(Debug, Clone)]
struct SourceReadinessDeadlines {
    camera: Option<Instant>,
    screen: Option<Instant>,
    camera_admission: Option<PreviewCameraStartingIdentity>,
    screen_admission: Option<PreviewScreenStartingIdentity>,
}

#[derive(Debug, Clone, Default)]
struct SourceStartAdmission {
    camera: Option<PreviewCameraStartingIdentity>,
    screen: Option<PreviewScreenStartingIdentity>,
}

#[derive(Debug, Clone)]
struct SourceReadinessGuard {
    source_label: &'static str,
    deadline: Instant,
    target_sources: SourceSelection,
    admission: SourceStartAdmission,
}

impl SourceReadinessDeadlines {
    fn starting_now(needs: SceneSourceNeeds) -> Self {
        let now = Instant::now();
        Self {
            camera: needs
                .camera
                .then(|| now + warm_source_start_timeout("camera")),
            screen: needs
                .screen
                .then(|| now + warm_source_start_timeout("screen")),
            camera_admission: None,
            screen_admission: None,
        }
    }
}

fn warm_source_start_timeout(source_label: &str) -> Duration {
    match source_label {
        "screen" => WARM_SCREEN_START_TIMEOUT,
        _ => WARM_CAMERA_START_TIMEOUT,
    }
}

fn fallback_video_settings() -> crate::protocol::VideoSettings {
    crate::protocol::VideoSettings {
        preset: crate::protocol::VideoPreset::Tutorial1440p30,
        width: 2560,
        height: 1440,
        fps: 30,
        bitrate_kbps: 8000,
    }
}

/// Which real sources the target scene composes (visible sources only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SceneSourceNeeds {
    pub camera: bool,
    pub screen: bool,
}

/// Which real sources are currently delivering fresh frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SourceLiveness {
    pub camera: bool,
    pub screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLayoutApplyStatus {
    pub applied: bool,
    /// "idle" (no active session), "hot", or "warm".
    pub mode: String,
    pub scene_revision: u64,
    pub scene: Scene,
    pub intent_id: u64,
    pub compositor_status: CompositorStatus,
    pub presentation_proven: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn required_scene_sources(scene: &Scene) -> SceneSourceNeeds {
    let mut needs = SceneSourceNeeds::default();
    for source in scene.sources.iter().filter(|source| source.visible) {
        match source.kind {
            SceneSourceKind::Camera => needs.camera = true,
            SceneSourceKind::Screen | SceneSourceKind::Window => needs.screen = true,
            SceneSourceKind::TestPattern => {}
        }
    }
    needs
}

pub fn missing_sources(needs: SceneSourceNeeds, live: SourceLiveness) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if needs.screen && !live.screen {
        missing.push("screen");
    }
    if needs.camera && !live.camera {
        missing.push("camera");
    }
    missing
}

/// Classify the swap through the LS1 model: hot when every needed source is live,
/// warm otherwise (start, then swap on ready).
pub fn plan_live_swap(
    mutation_kind: MutationKind,
    needs: SceneSourceNeeds,
    live: SourceLiveness,
) -> ApplyMode {
    let required_sources_active = missing_sources(needs, live).is_empty();
    classify_mutation(
        mutation_kind,
        &MutationContext {
            required_sources_active,
        },
    )
}

/// Live commits must beat both the current compositor revision and the
/// wallclock-millis revisions stamped at session start; otherwise the compositor's
/// stale-revision guard would silently drop them (the pre-D1 bug: renderer counters
/// started at 0 and every mid-session scene push was rejected).
pub fn next_scene_revision(current: Option<u64>, now_millis: u64) -> u64 {
    current
        .map(|revision| revision.saturating_add(1))
        .unwrap_or(0)
        .max(now_millis)
}

#[cfg(test)]
pub fn camera_status_is_live(status: &PreviewCameraStatus) -> bool {
    status.state == PreviewCameraState::Live && fresh_frame_age(status.frame_age_ms)
}

#[cfg(test)]
pub fn screen_status_is_live(status: &PreviewScreenStatus) -> bool {
    status.state == PreviewScreenState::Live && screen_has_frame_evidence(status, None)
}

fn fresh_frame_age(frame_age_ms: Option<u64>) -> bool {
    frame_age_ms.is_some_and(|age| age <= SOURCE_FRESH_FRAME_MAX_AGE_MS)
}

fn camera_frame_info_is_live(frame_info: Option<PreviewCameraFrameInfo>) -> bool {
    frame_info.is_some_and(|frame| frame.frame_age_ms <= SOURCE_FRESH_FRAME_MAX_AGE_MS)
}

fn screen_has_frame_evidence(
    status: &PreviewScreenStatus,
    frame_info: Option<PreviewScreenFrameInfo>,
) -> bool {
    frame_info.is_some() || status.sequence.is_some() || status.frames_captured > 0
}

#[cfg(test)]
fn target_camera_status_is_live(
    status: &PreviewCameraStatus,
    target_sources: Option<&SourceSelection>,
) -> bool {
    target_camera_is_live(status, None, target_sources)
}

fn target_camera_is_live(
    status: &PreviewCameraStatus,
    frame_info: Option<PreviewCameraFrameInfo>,
    target_sources: Option<&SourceSelection>,
) -> bool {
    if status.state != PreviewCameraState::Live
        || !(fresh_frame_age(status.frame_age_ms) || camera_frame_info_is_live(frame_info))
    {
        return false;
    }
    match target_sources.and_then(|sources| sources.camera_id.as_deref()) {
        Some(camera_id) => status.camera_id.as_deref() == Some(camera_id),
        None => true,
    }
}

fn selected_screen_source_id(sources: &SourceSelection) -> Option<&str> {
    sources
        .window_id
        .as_deref()
        .or(sources.screen_id.as_deref())
}

#[cfg(test)]
fn target_screen_status_is_live(
    status: &PreviewScreenStatus,
    target_sources: Option<&SourceSelection>,
) -> bool {
    target_screen_is_live(status, None, target_sources)
}

fn target_screen_is_live(
    status: &PreviewScreenStatus,
    frame_info: Option<PreviewScreenFrameInfo>,
    target_sources: Option<&SourceSelection>,
) -> bool {
    if status.state != PreviewScreenState::Live || !screen_has_frame_evidence(status, frame_info) {
        return false;
    }
    match target_sources.and_then(selected_screen_source_id) {
        Some(source_id) => status.source_id.as_deref() == Some(source_id),
        None => true,
    }
}

/// A preset that composes a device which is not even selected can never swap; report
/// exactly what is missing instead of degrading silently.
pub fn preset_selection_blocker(params: &SceneConfigParams) -> Option<String> {
    let preset = &params.layout.layout_preset;
    // The inset scenes (ScreenCamera + its vertical twin) tolerate a missing
    // camera — the screen still fills the frame; the banded arrangements
    // would show a dead band, so the camera is required there.
    let needs_camera = matches!(
        preset,
        LayoutPreset::CameraOnly
            | LayoutPreset::SideBySide
            | LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
    );
    let needs_screen = matches!(
        preset,
        LayoutPreset::ScreenOnly
            | LayoutPreset::ScreenCamera
            | LayoutPreset::SideBySide
            | LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
            | LayoutPreset::VerticalScreenCamera
            | LayoutPreset::VerticalScreenOnly
    );
    let camera_selected = params.sources.camera_id.is_some();
    let screen_selected = params.sources.test_pattern
        || screen_source_is_native(params.sources.screen_id.as_deref())
        || window_source_is_native(params.sources.window_id.as_deref());
    if needs_camera && !camera_selected {
        return Some(format!(
            "Layout preset {preset:?} needs a camera, but no camera is selected. Pick a camera, then switch."
        ));
    }
    if needs_screen && !screen_selected {
        if params.sources.screen_id.is_some() || params.sources.window_id.is_some() {
            return Some(format!(
                "Layout preset {preset:?} needs a native screen or window source, but the selected source cannot feed the native compositor. Pick a screen or window again, then switch."
            ));
        }
        return Some(format!(
            "Layout preset {preset:?} needs a screen or window, but none is selected. Pick one, then switch."
        ));
    }
    None
}

fn screen_source_is_native(screen_id: Option<&str>) -> bool {
    let Some(screen_id) = screen_id else {
        return false;
    };
    if parse_screencapturekit_display_id(screen_id).is_some() {
        return true;
    }
    if parse_windows_dxgi_output_index(screen_id).is_some() {
        return true;
    }
    is_windows_gdigrab_desktop_screen_id(screen_id)
}

fn window_source_is_native(window_id: Option<&str>) -> bool {
    let Some(window_id) = window_id else {
        return false;
    };
    parse_screencapturekit_window_id(window_id).is_some()
}

async fn source_liveness(state: &AppState, target_sources: &SourceSelection) -> SourceLiveness {
    source_readiness(state, target_sources).await.live
}

#[derive(Debug, Clone)]
struct SourceReadiness {
    live: SourceLiveness,
    camera_status: PreviewCameraStatus,
    screen_status: PreviewScreenStatus,
    camera_frame: Option<PreviewCameraFrameInfo>,
    screen_frame: Option<PreviewScreenFrameInfo>,
}

async fn source_readiness(state: &AppState, target_sources: &SourceSelection) -> SourceReadiness {
    let camera = preview_camera_status(state).await;
    let screen = preview_screen_status(state).await;
    let camera_frame = preview_camera_latest_frame_info(state).await;
    let screen_frame = preview_screen_latest_frame_info(state).await;
    let live = SourceLiveness {
        camera: target_camera_is_live(&camera, camera_frame, Some(target_sources)),
        screen: target_screen_is_live(&screen, screen_frame, Some(target_sources)),
    };
    SourceReadiness {
        live,
        camera_status: camera,
        screen_status: screen,
        camera_frame,
        screen_frame,
    }
}

/// Apply a layout preset (or full layout change) to the active program scene.
/// Legacy callers may omit an intent id; the backend allocates one while preserving
/// the same readiness and commit semantics used by idle preview.
pub async fn apply_layout_live(
    state: &AppState,
    request: SceneLayoutApplyParams,
) -> Result<LiveLayoutApplyStatus> {
    apply_scene_transaction(
        state,
        request.config,
        MutationKind::LayoutSetPreset,
        None,
        "layout switch",
        request.intent_id,
    )
    .await
}

/// Idle preview uses the same source readiness and atomic commit path as an active
/// recording/stream. The separate route makes ownership explicit at the renderer
/// boundary without introducing a second scene writer.
pub async fn apply_layout_preview(
    state: &AppState,
    request: SceneLayoutApplyParams,
) -> Result<LiveLayoutApplyStatus> {
    apply_scene_transaction(
        state,
        request.config,
        MutationKind::LayoutSetPreset,
        None,
        "preview layout switch",
        request.intent_id,
    )
    .await
}

/// Switch a selected source device during an active session. The target scene keeps
/// the current layout/video, but liveness is evaluated against the newly selected
/// device id so the old camera/screen cannot masquerade as ready.
pub async fn apply_source_device_switch_live(
    state: &AppState,
    params: SceneConfigParams,
) -> Result<LiveLayoutApplyStatus> {
    apply_scene_transaction(
        state,
        params,
        MutationKind::SourceDeviceSwitch,
        None,
        "source device switch",
        None,
    )
    .await
}

async fn apply_scene_transaction(
    state: &AppState,
    params: SceneConfigParams,
    mutation_kind: MutationKind,
    target_sources_override: Option<&SourceSelection>,
    action_label: &'static str,
    requested_intent_id: Option<u64>,
) -> Result<LiveLayoutApplyStatus> {
    if let Some(blocker) = preset_selection_blocker(&params) {
        bail!(blocker);
    }

    let target_sources = target_sources_override.unwrap_or(&params.sources);
    let scene = scene_from_capture_config(params.clone());
    let needs = required_scene_sources(&scene);
    let intent_id = begin_layout_intent(state, requested_intent_id, needs).await?;
    let session_active = state.recording.lock().await.is_some();

    // Orientation classes imply the canvas (vertical = portrait) and the
    // encoder canvas is fixed at session start — crossing classes mid-session
    // is refused honestly in BOTH directions (the renderer hides cross-mode
    // scenes too; this is defense in depth). Scene switches WITHIN a class
    // stay fully live: sources, backgrounds, and any same-orientation preset.
    if session_active {
        let requested_vertical = params.layout.layout_preset.is_vertical();
        // An unknown running layout is treated as horizontal — the
        // conservative reading the pre-split blocker used.
        let running_vertical = {
            let compositor = state.compositor.lock().await;
            compositor
                .status
                .scene_layout
                .as_ref()
                .is_some_and(|layout| layout.layout_preset.is_vertical())
        };
        if running_vertical != requested_vertical {
            bail!(
                "Switching between horizontal and vertical scenes changes the canvas orientation — stop the session first."
            );
        }
    }

    // This explicit scene/config intent owns camera-recovery supersession from
    // this point, including a same-generation Hot layout commit that never
    // crosses preview-camera start/stop admission. The later async coordinator
    // reconciliation publishes Idle truth; this edge shares the preview-camera
    // mutation authority with final native installation so a queued recovery
    // driver cannot cross the physical boundary in the meantime.
    run_explicit_camera_configuration_transaction(state, async {
        let live = source_liveness(state, target_sources).await;
        match plan_live_swap(mutation_kind, needs, live) {
            ApplyMode::Hot => {
                let status = commit_scene_for_intent(
                    state,
                    intent_id,
                    &scene,
                    params.layout.clone(),
                    None,
                    params.transition_ms,
                )
                .await?;
                retire_unused_sources_after_commit(state, intent_id, needs).await;
                resync_camera_capture_geometry_after_commit(state, intent_id, &params, needs).await;
                Ok(layout_apply_status(
                    intent_id,
                    if session_active { "hot" } else { "idle" },
                    scene,
                    status,
                    None,
                ))
            }
            ApplyMode::Warm => {
                let missing = missing_sources(needs, live);
                let deadlines =
                    start_missing_sources(state, intent_id, &params, needs, &missing, action_label)
                        .await?;
                ensure_layout_intent_current(state, intent_id).await?;
                wait_for_sources_ready(
                    state,
                    intent_id,
                    deadlines,
                    needs,
                    target_sources,
                    action_label,
                )
                .await?;
                // Swap-on-ready: the old layout rendered until this exact commit; the new
                // sources are already delivering fresh frames, so the swap is seamless.
                let message = if missing.is_empty() {
                    format!("Applied live {action_label}.")
                } else {
                    format!(
                        "Started {} mid-session, swapped on first fresh frames.",
                        missing.join(" + ")
                    )
                };
                let status = commit_scene_for_intent(
                    state,
                    intent_id,
                    &scene,
                    params.layout.clone(),
                    Some(message.clone()),
                    params.transition_ms,
                )
                .await?;
                retire_unused_sources_after_commit(state, intent_id, needs).await;
                resync_camera_capture_geometry_after_commit(state, intent_id, &params, needs).await;
                Ok(layout_apply_status(
                    intent_id,
                    "warm",
                    scene,
                    status,
                    Some(message),
                ))
            }
            ApplyMode::Cold => {
                // classify_mutation never returns Cold for LayoutSetPreset; keep the
                // honest failure anyway rather than silently doing nothing.
                bail!("Layout preset change classified cold during an active session.");
            }
        }
    })
    .await
}

async fn run_explicit_camera_configuration_transaction<T>(
    state: &AppState,
    transaction: impl std::future::Future<Output = T>,
) -> T {
    let explicit_camera_mutation =
        begin_capture_recovery_explicit_camera_configuration_mutation(state).await;
    let result = transaction.await;
    explicit_camera_mutation.finish();
    reconcile_explicit_camera_configuration_change(state).await;
    result
}

async fn begin_layout_intent(
    state: &AppState,
    requested_intent_id: Option<u64>,
    needs: SceneSourceNeeds,
) -> Result<u64> {
    let mut intents = state.layout_intents.lock().await;
    let intent_id =
        requested_intent_id.unwrap_or_else(|| intents.latest_intent_id.saturating_add(1).max(1));
    if intent_id <= intents.latest_intent_id {
        bail!(
            "Layout intent {intent_id} was superseded by newer intent {}.",
            intents.latest_intent_id
        );
    }
    let _source_admission = state.lock_layout_source_admission();
    intents.latest_intent_id = intent_id;
    intents.latest_needs_camera = needs.camera;
    intents.latest_needs_screen = needs.screen;
    // Publish the registration linearization point before releasing the
    // mutex. Detached source workers use this mirror to reject an older
    // intent without taking the intent mutex under a preview-runtime lock.
    state.publish_latest_layout_intent_id(intent_id);
    Ok(intent_id)
}

async fn ensure_layout_intent_current(state: &AppState, intent_id: u64) -> Result<()> {
    let latest = state.layout_intents.lock().await.latest_intent_id;
    if latest != intent_id {
        bail!("Layout intent {intent_id} was superseded by newer intent {latest}.");
    }
    Ok(())
}

async fn wait_for_layout_intent_superseded(state: &AppState, intent_id: u64) -> u64 {
    loop {
        let latest = state.layout_intents.lock().await.latest_intent_id;
        if latest != intent_id {
            return latest;
        }
        sleep(LAYOUT_INTENT_CANCEL_POLL).await;
    }
}

async fn await_layout_source_admission<T: Send + 'static, R: Send + 'static>(
    state: &AppState,
    intent_id: u64,
    source_label: &'static str,
    source_task: &mut tokio::task::JoinHandle<R>,
    mut admission_ready: oneshot::Receiver<Option<T>>,
) -> Result<Option<T>> {
    tokio::select! {
        biased;
        result = &mut admission_ready => result.map_err(|_| {
            anyhow::anyhow!("{source_label} source startup ended before publishing admission ownership")
        }),
        _ = wait_for_layout_intent_superseded(state, intent_id) => {
            let latest = reconcile_superseded_source_start(
                state,
                source_label,
                source_task,
                &SourceStartAdmission::default(),
            )
            .await;
            bail!("Layout intent {intent_id} was superseded by newer intent {latest}.")
        }
    }
}

// Each argument is an independent part of the source-start race (intent,
// transition readiness, guarded peer readiness, and the owned task). Bundling
// them would hide those cancellation boundaries without reducing complexity.
#[allow(clippy::too_many_arguments)]
async fn await_layout_source_start<T: Send + 'static>(
    state: &AppState,
    intent_id: u64,
    timeout: Duration,
    source_task_owns_transition_timeout: bool,
    source_label: &'static str,
    restart_ready: Option<oneshot::Receiver<()>>,
    source_admission: SourceStartAdmission,
    readiness_guard: Option<SourceReadinessGuard>,
    mut source_task: tokio::task::JoinHandle<T>,
) -> Result<(T, Instant)> {
    if let Some(mut restart_ready) = restart_ready {
        tokio::select! {
            result = &mut source_task => {
                let deadline = Instant::now() + timeout;
                return result
                    .map(|value| (value, deadline))
                    .map_err(|error| anyhow::anyhow!("{source_label} source startup task failed: {error}"));
            },
            _ = wait_for_layout_intent_superseded(state, intent_id) => {
                let latest = reconcile_superseded_source_start(
                    state,
                    source_label,
                    &mut source_task,
                    &source_admission,
                ).await;
                bail!("Layout intent {intent_id} was superseded by newer intent {latest}.")
            },
            _ = &mut restart_ready => {}
        }
    }
    let guarded_source_label = readiness_guard.as_ref().map(|guard| guard.source_label);
    let guarded_readiness_failure = async {
        match readiness_guard.as_ref() {
            Some(guard) => wait_for_guarded_source_readiness_failure(state, guard).await,
            None => std::future::pending::<String>().await,
        }
    };
    tokio::pin!(guarded_readiness_failure);
    if source_task_owns_transition_timeout {
        return tokio::select! {
            result = &mut source_task => result
                // A camera transition owns its bounded command response. Its
                // layout first-frame budget starts only after that response;
                // racing it with another identical 15s timer aborted a valid
                // operator generation while it waited behind stale recovery.
                .map(|value| (value, Instant::now() + timeout))
                .map_err(|error| anyhow::anyhow!("{source_label} source startup task failed: {error}")),
            _ = wait_for_layout_intent_superseded(state, intent_id) => {
                let latest = reconcile_superseded_source_start(
                    state,
                    source_label,
                    &mut source_task,
                    &source_admission,
                ).await;
                bail!("Layout intent {intent_id} was superseded by newer intent {latest}.")
            }
            failure = &mut guarded_readiness_failure => {
                source_task.abort();
                cancel_pending_source_start_for_intent(
                    state,
                    intent_id,
                    source_label,
                    source_admission.camera.as_ref(),
                    source_admission.screen.as_ref(),
                )
                .await;
                if let Some(guarded_source_label) = guarded_source_label
                    && guarded_source_label != source_label
                {
                    cancel_pending_source_start_for_intent(
                        state,
                        intent_id,
                        guarded_source_label,
                        readiness_guard
                            .as_ref()
                            .and_then(|guard| guard.admission.camera.as_ref()),
                        readiness_guard
                            .as_ref()
                            .and_then(|guard| guard.admission.screen.as_ref()),
                    )
                    .await;
                }
                bail!(failure)
            }
        };
    }
    let deadline = Instant::now() + timeout;
    tokio::select! {
        result = &mut source_task => result
            .map(|value| (value, deadline))
            .map_err(|error| anyhow::anyhow!("{source_label} source startup task failed: {error}")),
        _ = wait_for_layout_intent_superseded(state, intent_id) => {
            let latest = reconcile_superseded_source_start(
                state,
                source_label,
                &mut source_task,
                &source_admission,
            ).await;
            bail!("Layout intent {intent_id} was superseded by newer intent {latest}.")
        }
        _ = tokio::time::sleep_until(deadline) => {
            let failure_detail = source_start_failure_detail(state, source_label).await;
            source_task.abort();
            cancel_pending_source_start_for_intent(
                state,
                intent_id,
                source_label,
                source_admission.camera.as_ref(),
                source_admission.screen.as_ref(),
            )
            .await;
            bail!(
                "Layout intent {intent_id} timed out while starting {source_label} within {}s.{failure_detail}",
                timeout.as_secs(),
            );
        }
        failure = &mut guarded_readiness_failure => {
            source_task.abort();
            cancel_pending_source_start_for_intent(
                state,
                intent_id,
                source_label,
                source_admission.camera.as_ref(),
                source_admission.screen.as_ref(),
            )
            .await;
            if let Some(guarded_source_label) = guarded_source_label
                && guarded_source_label != source_label
            {
                cancel_pending_source_start_for_intent(
                    state,
                    intent_id,
                    guarded_source_label,
                    readiness_guard
                        .as_ref()
                        .and_then(|guard| guard.admission.camera.as_ref()),
                    readiness_guard
                        .as_ref()
                        .and_then(|guard| guard.admission.screen.as_ref()),
                )
                .await;
            }
            bail!(failure)
        }
    }
}

async fn wait_for_guarded_source_readiness_failure(
    state: &AppState,
    guard: &SourceReadinessGuard,
) -> String {
    tokio::time::sleep_until(guard.deadline).await;
    let readiness = source_readiness(state, &guard.target_sources).await;
    let needs = match guard.source_label {
        "camera" => SceneSourceNeeds {
            camera: true,
            screen: false,
        },
        "screen" => SceneSourceNeeds {
            camera: false,
            screen: true,
        },
        _ => SceneSourceNeeds::default(),
    };
    if missing_sources(needs, readiness.live).is_empty() {
        return std::future::pending::<String>().await;
    }
    let detail =
        missing_readiness_messages(needs, &readiness, Some(&guard.target_sources)).join("; ");
    format!(
        "Live source device switch blocked after {} ({}s) exceeded its source-start/readiness budget: {detail}. The previous layout is still live.",
        guard.source_label,
        warm_source_start_timeout(guard.source_label).as_secs()
    )
}

async fn source_start_failure_detail(state: &AppState, source_label: &str) -> String {
    if source_label != "screen" {
        return String::new();
    }
    let status = preview_screen_status(state).await;
    if status.state != PreviewScreenState::Failed {
        return String::new();
    }
    status
        .message
        .as_deref()
        .map(|message| format!(" Screen error: {message}"))
        .unwrap_or_default()
}

async fn reconcile_superseded_source_start<T: Send + 'static>(
    state: &AppState,
    source_label: &'static str,
    source_task: &mut tokio::task::JoinHandle<T>,
    admission: &SourceStartAdmission,
) -> u64 {
    // The command task is only a disposable waiter. Every admitted native
    // generation already has a detached process owner, so aborting here cannot
    // orphan physical handles. Exact identity then invalidates only work still
    // owned by the superseded intent; a same-key newer intent transfers the
    // owner first and makes this CAS harmlessly miss.
    source_task.abort();
    match source_label {
        "camera" => {
            if let Some(stop) = match admission.camera.as_ref() {
                Some(expected) => begin_preview_camera_stop_if_starting(state, expected).await,
                None => None,
            } {
                let _ = finish_preview_camera_stop(stop).await;
            }
        }
        "screen" => {
            if let Some(expected) = admission.screen.as_ref() {
                let transition = acquire_preview_screen_transition(state).await;
                if let Some(stop) = begin_preview_screen_stop_if_starting_with_transition(
                    state, transition, expected,
                )
                .await
                {
                    let _ = finish_preview_screen_stop(stop).await;
                }
            }
        }
        _ => {}
    }
    state.latest_layout_intent_id()
}

async fn cancel_pending_source_start_for_intent(
    state: &AppState,
    intent_id: u64,
    source_label: &'static str,
    expected_camera: Option<&PreviewCameraStartingIdentity>,
    expected_screen: Option<&PreviewScreenStartingIdentity>,
) {
    match source_label {
        "camera" => {
            let Some(expected_camera) = expected_camera else {
                // A disposable command waiter cannot prove which camera
                // generation it owns. Its persistent transition supervisor
                // remains responsible; only readiness cleanup carrying an
                // exact sampled identity may invalidate a camera generation.
                return;
            };
            let stop = {
                let intents = state.layout_intents.lock().await;
                if intents.latest_intent_id != intent_id {
                    None
                } else {
                    begin_preview_camera_stop_if_starting(state, expected_camera).await
                }
            };
            if let Some(stop) = stop {
                let _ = finish_preview_camera_stop(stop).await;
            }
        }
        "screen" => {
            let Some(expected_screen) = expected_screen else {
                // As with camera, only a caller carrying the exact admitted
                // screen generation may cancel it. A public start or newer
                // layout can otherwise race the timeout sample.
                return;
            };
            let transition = acquire_preview_screen_transition(state).await;
            let stop = {
                let intents = state.layout_intents.lock().await;
                if intents.latest_intent_id != intent_id {
                    None
                } else {
                    begin_preview_screen_stop_if_starting_with_transition(
                        state,
                        transition,
                        expected_screen,
                    )
                    .await
                }
            };
            if let Some(stop) = stop {
                let _ = finish_preview_screen_stop(stop).await;
            }
        }
        _ => {}
    }
}

async fn cancel_expired_source_starts_and_refresh_readiness(
    state: &AppState,
    intent_id: u64,
    needs: SceneSourceNeeds,
    sampled_readiness: &SourceReadiness,
    camera_admission: Option<&PreviewCameraStartingIdentity>,
    screen_admission: Option<&PreviewScreenStartingIdentity>,
    target_sources: &SourceSelection,
) -> SourceReadiness {
    if needs.camera && !sampled_readiness.live.camera {
        cancel_pending_source_start_for_intent(state, intent_id, "camera", camera_admission, None)
            .await;
    }
    if needs.screen && !sampled_readiness.live.screen {
        cancel_pending_source_start_for_intent(state, intent_id, "screen", None, screen_admission)
            .await;
    }
    source_readiness(state, target_sources).await
}

async fn commit_scene_for_intent(
    state: &AppState,
    intent_id: u64,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
    transition_ms: Option<u32>,
) -> Result<SceneCommitStatus> {
    // Keep registration and the commit edge mutually exclusive. Warm-up never holds
    // this guard, so a new request can supersede an older waiter immediately.
    let intents = state.layout_intents.lock().await;
    if intents.latest_intent_id != intent_id {
        bail!(
            "Layout intent {intent_id} was superseded by newer intent {}.",
            intents.latest_intent_id
        );
    }
    let status =
        commit_scene_with_layout_with_transition(state, scene, layout, message, transition_ms)
            .await?;
    drop(intents);
    Ok(status)
}

fn layout_apply_status(
    intent_id: u64,
    mode: &str,
    scene: Scene,
    status: SceneCommitStatus,
    message: Option<String>,
) -> LiveLayoutApplyStatus {
    // Rendering is latest-wins: a frame at or beyond the committed revision
    // proves this commit was satisfied or superseded by newer committed truth.
    let presentation_proven = status
        .compositor_status
        .frame_scene_revision
        .is_some_and(|revision| revision >= status.scene_revision);
    LiveLayoutApplyStatus {
        applied: true,
        mode: mode.to_string(),
        scene_revision: status.scene_revision,
        scene,
        intent_id,
        compositor_status: status.compositor_status,
        presentation_proven,
        message,
    }
}

async fn start_missing_sources(
    state: &AppState,
    intent_id: u64,
    params: &SceneConfigParams,
    needs: SceneSourceNeeds,
    missing: &[&'static str],
    action_label: &'static str,
) -> Result<SourceReadinessDeadlines> {
    let ffmpeg_path = active_recording_ffmpeg_path(state).await;
    let mut readiness_deadlines = SourceReadinessDeadlines::starting_now(needs);
    for source in missing {
        ensure_layout_intent_current(state, intent_id).await?;
        match *source {
            "camera" => {
                // Always cross camera admission, even when the same device is
                // already Starting. Ordinary same-key starts join there, while
                // a recovery-owned Starting generation is superseded by this
                // operator intent. Skipping the call stranded the layout wait
                // when recovery was invalidated between native stop and spawn.
                let (admission_ready_tx, admission_ready_rx) = oneshot::channel();
                let mut start = tokio::spawn(start_preview_camera_for_layout(
                    state.clone(),
                    PreviewCameraStartParams {
                        sources: params.sources.clone(),
                        layout: params.layout.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                        ffmpeg_path: ffmpeg_path.clone(),
                    },
                    intent_id,
                    admission_ready_tx,
                ));
                let camera_admission = await_layout_source_admission(
                    state,
                    intent_id,
                    "camera",
                    &mut start,
                    admission_ready_rx,
                )
                .await?;
                let source_admission = SourceStartAdmission {
                    camera: camera_admission.clone(),
                    screen: None,
                };
                let (start, deadline) = await_layout_source_start(
                    state,
                    intent_id,
                    warm_source_start_timeout("camera"),
                    true,
                    "camera",
                    None,
                    source_admission,
                    missing.contains(&"screen").then(|| SourceReadinessGuard {
                        source_label: "screen",
                        deadline: readiness_deadlines
                            .screen
                            .expect("needed screen source must have a readiness deadline"),
                        target_sources: params.sources.clone(),
                        admission: SourceStartAdmission {
                            camera: None,
                            screen: readiness_deadlines.screen_admission.clone(),
                        },
                    }),
                    start,
                )
                .await?;
                readiness_deadlines.camera = Some(deadline);
                readiness_deadlines.camera_admission =
                    camera_admission.or(start.admitted_starting_identity);
                let status = start.status;
                if matches!(
                    status.state,
                    PreviewCameraState::Failed
                        | PreviewCameraState::DeviceMissing
                        | PreviewCameraState::PermissionNeeded
                ) {
                    bail!(
                        "Camera failed to start for the live {action_label} ({:?}): {}",
                        status.state,
                        status.message.unwrap_or_else(|| "no detail".to_string())
                    );
                }
            }
            "screen" => {
                // Always cross screen admission. A same-key layout join must
                // transfer timeout ownership to the newest intent, while a
                // stale different-key task must be rejected without changing
                // the generation.
                let (restart_ready_tx, restart_ready_rx) = oneshot::channel();
                let (admission_ready_tx, admission_ready_rx) = oneshot::channel();
                let mut start = tokio::spawn(start_preview_screen_for_live_switch(
                    state.clone(),
                    PreviewScreenStartParams {
                        sources: params.sources.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                        protected_overlay_window_ids: params.protected_overlay_window_ids.clone(),
                        ffmpeg_path: ffmpeg_path.clone(),
                    },
                    restart_ready_tx,
                    intent_id,
                    admission_ready_tx,
                ));
                let screen_admission = await_layout_source_admission(
                    state,
                    intent_id,
                    "screen",
                    &mut start,
                    admission_ready_rx,
                )
                .await?;
                let source_admission = SourceStartAdmission {
                    camera: None,
                    screen: screen_admission.clone(),
                };
                let (start, deadline) = await_layout_source_start(
                    state,
                    intent_id,
                    warm_source_start_timeout("screen"),
                    false,
                    "screen",
                    Some(restart_ready_rx),
                    source_admission,
                    None,
                    start,
                )
                .await?;
                readiness_deadlines.screen = Some(deadline);
                readiness_deadlines.screen_admission =
                    screen_admission.or(start.admitted_starting_identity);
                let status = start.status;
                if matches!(
                    status.state,
                    PreviewScreenState::Failed
                        | PreviewScreenState::SourceMissing
                        | PreviewScreenState::PermissionNeeded
                ) {
                    bail!(
                        "Screen capture failed to start for the live {action_label} ({:?}): {}",
                        status.state,
                        status.message.unwrap_or_else(|| "no detail".to_string())
                    );
                }
            }
            other => bail!("Unknown source kind {other} for live layout switch."),
        }
    }
    Ok(readiness_deadlines)
}

async fn active_recording_ffmpeg_path(state: &AppState) -> Option<String> {
    state
        .recording
        .lock()
        .await
        .as_ref()
        .map(|recording| recording.ffmpeg_path.clone())
}

async fn wait_for_sources_ready(
    state: &AppState,
    intent_id: u64,
    deadlines: SourceReadinessDeadlines,
    needs: SceneSourceNeeds,
    target_sources: &SourceSelection,
    action_label: &'static str,
) -> Result<()> {
    loop {
        ensure_layout_intent_current(state, intent_id).await?;
        let readiness = source_readiness(state, target_sources).await;
        if missing_sources(needs, readiness.live).is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let mut expired = Vec::new();
        if needs.camera
            && !readiness.live.camera
            && deadlines.camera.is_some_and(|deadline| now >= deadline)
        {
            expired.push(format!(
                "camera ({}s)",
                warm_source_start_timeout("camera").as_secs()
            ));
        }
        if needs.screen
            && !readiness.live.screen
            && deadlines.screen.is_some_and(|deadline| now >= deadline)
        {
            expired.push(format!(
                "screen ({}s)",
                warm_source_start_timeout("screen").as_secs()
            ));
        }
        if !expired.is_empty() {
            // A native source may publish Live after the sample above but
            // before timeout cancellation reaches preview admission. The
            // conditional stop CAS preserves that Live owner; accept it here
            // instead of returning an error after the target became ready.
            let readiness = cancel_expired_source_starts_and_refresh_readiness(
                state,
                intent_id,
                needs,
                &readiness,
                deadlines.camera_admission.as_ref(),
                deadlines.screen_admission.as_ref(),
                target_sources,
            )
            .await;
            if missing_sources(needs, readiness.live).is_empty() {
                return Ok(());
            }
            let still_missing =
                missing_readiness_messages(needs, &readiness, Some(target_sources)).join("; ");
            bail!(
                "Live {action_label} blocked after {} exceeded its source-start/readiness budget: {still_missing}. The previous layout is still live.",
                expired.join(" + ")
            );
        }
        sleep(WARM_SOURCE_POLL).await;
    }
}

/// A hot preset switch keeps the live camera session, but AVFoundation output
/// geometry is fixed at session start — a session capturing the inset overlay
/// box keeps delivering 720p-class frames after the scene goes full-canvas
/// (and vice versa). Re-derive the capture box after the commit and restart
/// the camera in the background when it no longer matches; reuse refuses
/// mismatched geometry, so the start lands as a real restart. The compositor
/// holds the last frame across the restart, so the swap is a brief hold, not
/// a blank slot.
async fn resync_camera_capture_geometry_after_commit(
    state: &AppState,
    intent_id: u64,
    params: &SceneConfigParams,
    needs: SceneSourceNeeds,
) {
    if !needs.camera {
        return;
    }
    // NEVER restart the camera while a capture session owns the pipeline: the
    // encoder assumes fixed camera frame geometry, and a mid-stream restart
    // that re-derives it misreads buffers as color garbage and can kill the
    // take (0.9.53–0.9.57 regression, owner-reported on a live scene switch).
    // Stale geometry mid-session is the long-standing correct behavior — the
    // scene math absorbs the scale — and the next idle commit re-syncs it.
    if state.recording.lock().await.is_some() {
        return;
    }
    let video = params.video.clone().unwrap_or_else(fallback_video_settings);
    if !camera_capture_geometry_is_stale(state, &params.layout, &video).await {
        return;
    }
    let layout = params.layout.clone();
    let start_params = PreviewCameraStartParams {
        sources: params.sources.clone(),
        layout: params.layout.clone(),
        video: video.clone(),
        ffmpeg_path: active_recording_ffmpeg_path(state).await,
    };
    let resync_state = state.clone();
    state.spawn_process_task(async move {
        // Settle first: browsing scenes fires a commit per click, and an
        // immediate restart per click stacks camera restarts on top of each
        // other — overlapping warm-ups misread renegotiation buffers as color
        // garbage and cycle the device off/on in plain view (owner-reported on
        // 0.9.63 scene motion, same family as the 0.9.51 retry storm). Waiting
        // out the settle window means only the LAST switch restarts the
        // camera, well after any 320ms scene glide has landed.
        sleep(CAMERA_GEOMETRY_RESYNC_SETTLE).await;
        let still_current = {
            let intents = resync_state.layout_intents.lock().await;
            intents.latest_intent_id == intent_id && intents.latest_needs_camera
        };
        if !still_current {
            return;
        }
        run_camera_geometry_resync_after_settle(
            resync_state,
            start_params,
            layout,
            video,
            intent_id,
        )
        .await;
    });
}

async fn run_camera_geometry_resync_after_settle(
    state: AppState,
    params: PreviewCameraStartParams,
    layout: LayoutSettings,
    video: VideoSettings,
    layout_intent_id: u64,
) {
    // Recording startup owns this fence from admission until `recording` is
    // published. Owning the same edge makes the decision and the complete
    // camera restart atomic with respect to startup: either resync finishes
    // first, or startup publishes recording truth and resync stands down.
    let _session_start_fence = state
        .session_start_source_transition_fence
        .clone()
        .lock_owned()
        .await;

    // Re-check every prerequisite after waiting for the fence. A session,
    // shutdown, or newer scene may have become authoritative while queued,
    // or another owner may already have installed matching geometry.
    if state.process_shutdown_requested() || state.recording.lock().await.is_some() {
        return;
    }
    let still_current = {
        let intents = state.layout_intents.lock().await;
        intents.latest_intent_id == layout_intent_id && intents.latest_needs_camera
    };
    if !still_current || !camera_capture_geometry_is_stale(&state, &layout, &video).await {
        return;
    }

    let _ = start_camera_geometry_resync_for_layout(state, params, layout_intent_id).await;
}

async fn start_camera_geometry_resync_for_layout(
    state: AppState,
    params: PreviewCameraStartParams,
    layout_intent_id: u64,
) -> crate::protocol::PreviewCameraStatus {
    // Geometry resync is delayed layout work, not an independent operator
    // command. Carry the originating intent through camera admission so a
    // newer scene that registers after the settle checks still wins at the
    // final source-registry/native-install linearization points.
    let (admission_ready, discarded_admission) = oneshot::channel();
    drop(discarded_admission);
    start_preview_camera_for_layout_until_transition_complete(
        state,
        params,
        layout_intent_id,
        admission_ready,
    )
    .await
    .status
}

async fn retire_unused_sources_after_commit(
    state: &AppState,
    intent_id: u64,
    needs: SceneSourceNeeds,
) {
    if !needs.screen {
        let transition = acquire_preview_screen_transition(state).await;
        let stop = {
            let intents = state.layout_intents.lock().await;
            if intents.latest_intent_id == intent_id && !intents.latest_needs_screen {
                Some(begin_preview_screen_stop_with_transition(state, transition).await)
            } else {
                None
            }
        };
        if let Some(stop) = stop {
            let _ = finish_preview_screen_stop(stop).await;
        }
    }
    if needs.camera {
        return;
    }

    let grace_state = state.clone();
    state.spawn_process_task(async move {
        sleep(UNUSED_CAMERA_STOP_GRACE).await;
        let stop = {
            let intents = grace_state.layout_intents.lock().await;
            if intents.latest_intent_id == intent_id && !intents.latest_needs_camera {
                Some(begin_preview_camera_stop(&grace_state).await)
            } else {
                None
            }
        };
        if let Some(stop) = stop {
            let _ = finish_preview_camera_stop(stop).await;
        }
    });
}

fn missing_readiness_messages(
    needs: SceneSourceNeeds,
    readiness: &SourceReadiness,
    target_sources: Option<&SourceSelection>,
) -> Vec<String> {
    let mut messages = Vec::new();
    if needs.camera && !readiness.live.camera {
        // "Never delivered" and "went stale" are different failures: the first
        // is a dead session or claimed device (Cam Link class), the second a
        // stalled-but-once-working stream. Say which one it was.
        let status = &readiness.camera_status;
        let never_delivered = status.frames_captured == 0
            && status.sequence.is_none()
            && readiness.camera_frame.is_none();
        let label = if never_delivered {
            "camera session never delivered a frame"
        } else {
            "camera frames stopped or went stale"
        };
        messages.push(format!(
            "{label} ({})",
            camera_readiness_detail(readiness, target_sources)
        ));
    }
    if needs.screen && !readiness.live.screen {
        messages.push(format!(
            "screen/window produced no initial frame for the selected source ({})",
            screen_readiness_detail(readiness, target_sources)
        ));
    }
    messages
}

fn camera_readiness_detail(
    readiness: &SourceReadiness,
    target_sources: Option<&SourceSelection>,
) -> String {
    let status = &readiness.camera_status;
    let frame_age_ms = readiness
        .camera_frame
        .map(|frame| frame.frame_age_ms)
        .or(status.frame_age_ms);
    format!(
        "state: {}, target: {}, current: {}, frames captured: {}, dropped: {}, latest sequence: {}, latest frame age: {}",
        camera_state_label(&status.state),
        target_sources
            .and_then(|sources| sources.camera_id.as_deref())
            .unwrap_or("none"),
        status.camera_id.as_deref().unwrap_or("none"),
        status.frames_captured,
        status.dropped_frames,
        format_optional_u64(
            readiness
                .camera_frame
                .map(|frame| frame.sequence)
                .or(status.sequence)
        ),
        format_age_ms(frame_age_ms)
    )
}

fn screen_readiness_detail(
    readiness: &SourceReadiness,
    target_sources: Option<&SourceSelection>,
) -> String {
    let status = &readiness.screen_status;
    let frame_age_ms = readiness
        .screen_frame
        .map(|frame| frame.frame_age_ms)
        .or(status.frame_age_ms);
    let failure = if status.state == PreviewScreenState::Failed {
        status
            .message
            .as_deref()
            .map(|message| format!(", error: {message}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    format!(
        "state: {}, target: {}, current: {}, frames captured: {}, latest sequence: {}, latest frame age: {}{}",
        screen_state_label(&status.state),
        target_sources
            .and_then(selected_screen_source_id)
            .unwrap_or("none"),
        status.source_id.as_deref().unwrap_or("none"),
        status.frames_captured,
        format_optional_u64(
            readiness
                .screen_frame
                .map(|frame| frame.sequence)
                .or(status.sequence)
        ),
        format_age_ms(frame_age_ms),
        failure
    )
}

fn camera_state_label(state: &PreviewCameraState) -> &'static str {
    match state {
        PreviewCameraState::DeviceMissing => "device-missing",
        PreviewCameraState::PermissionNeeded => "permission-needed",
        PreviewCameraState::Starting => "starting",
        PreviewCameraState::Live => "live",
        PreviewCameraState::Failed => "failed",
    }
}

fn screen_state_label(state: &PreviewScreenState) -> &'static str {
    match state {
        PreviewScreenState::SourceMissing => "source-missing",
        PreviewScreenState::PermissionNeeded => "permission-needed",
        PreviewScreenState::Starting => "starting",
        PreviewScreenState::Live => "live",
        PreviewScreenState::Failed => "failed",
    }
}

fn format_optional_u64(value: Option<u64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string())
}

fn format_age_ms(value: Option<u64>) -> String {
    value
        .map(|value| format!("{value}ms"))
        .unwrap_or_else(|| "none".to_string())
}

pub async fn commit_scene_with_current_layout(
    state: &AppState,
    scene: &Scene,
) -> Result<SceneCommitStatus> {
    let layout = {
        let compositor = state.compositor.lock().await;
        compositor
            .status
            .scene_layout
            .clone()
            .unwrap_or_else(default_layout_settings)
    };
    commit_scene_with_layout(state, scene, layout, None).await
}

pub async fn commit_scene_with_layout(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
) -> Result<SceneCommitStatus> {
    commit_scene_with_layout_with_transition(state, scene, layout, message, None).await
}

pub async fn commit_scene_with_layout_with_transition(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
    transition_ms: Option<u32>,
) -> Result<SceneCommitStatus> {
    let now_millis = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
    commit_scene_with_layout_at_time_with_policy(
        state,
        scene,
        layout,
        message,
        now_millis,
        false,
        transition_ms,
    )
    .await
}

pub async fn commit_idle_scene_with_layout(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
) -> Result<SceneCommitStatus> {
    let now_millis = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
    commit_scene_with_layout_at_time_with_policy(
        state, scene, layout, message, now_millis, true, None,
    )
    .await
}

#[cfg(test)]
async fn commit_scene_with_layout_at_time(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
    now_millis: u64,
) -> Result<SceneCommitStatus> {
    commit_scene_with_layout_at_time_with_policy(
        state, scene, layout, message, now_millis, false, None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn commit_scene_with_layout_at_time_with_policy(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
    now_millis: u64,
    idle_only: bool,
    transition_ms: Option<u32>,
) -> Result<SceneCommitStatus> {
    // An unreadable background must DEGRADE, never kill the commit: failing here
    // took the whole preview down with it (every builtin .webp background before
    // webp decode support — the app sat on "Waiting for the app to commit its
    // scene" forever). The compositor already renders a placeholder + message
    // for undecodable images, and recording start keeps its own strict
    // validate_scene_background gate.
    if let Err(background_warning) = validate_scene_background(scene) {
        tracing::warn!(
            "Committing scene with unreadable background (degraded render): {background_warning}"
        );
    }

    // One authority owns the entire commit edge. Without this guard, two
    // commands can both read the same compositor revision, publish different
    // scenes with that revision, and leave state/event consumers disagreeing
    // about which scene actually won.
    let _commit = state.scene_commit.lock().await;

    if idle_only && state.recording.lock().await.is_some() {
        bail!("Idle capture-config scene reload was superseded by session startup");
    }

    {
        let mut guard = state.scene.lock().await;
        *guard = scene.clone();
    }

    let (current_revision, active_screen) = {
        let compositor = state.compositor.lock().await;
        (compositor.status.scene_revision, compositor.active_screen())
    };
    let revision = next_scene_revision(current_revision, now_millis);
    // Make the otherwise tiny allocation/update gap deterministic in the
    // concurrent-commit regression. Production has no artificial yield.
    #[cfg(test)]
    tokio::task::yield_now().await;
    let compositor_status = update_compositor_scene(
        state,
        CompositorSceneUpdateParams {
            revision,
            scene: Some(scene.clone()),
            layout,
            active_screen,
            transition_ms,
        },
    )
    .await;
    state.emit_event("scene.changed", scene);
    let mode = if state.recording.lock().await.is_some() {
        "hot"
    } else {
        "idle"
    };
    Ok(SceneCommitStatus {
        applied: true,
        mode: mode.to_string(),
        scene_revision: revision,
        scene: scene.clone(),
        compositor_status,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{LayoutSettings, PreviewScreenSourceKind, SourceSelection};
    use crate::storage::Database;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::{Barrier, broadcast};

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn geometry_resync_is_inert_while_a_session_is_recording() {
        // The 0.9.53–0.9.57 regression: a hot preset switch mid-recording
        // (inset -> full canvas changes the capture box) force-restarted the
        // camera under the encoder — geometry changed mid-stream, buffers were
        // misread as color garbage, and the take could die. The resync must be
        // a no-op while any capture session owns the pipeline.
        let state = test_state();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Tutorial1440p30,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };
        // Installed under a smaller output canvas; the committed scene uses a
        // larger one, so the capture box is genuinely stale. (Capture geometry
        // is layout-invariant — only a canvas change can arm staleness.)
        let mut installed_video = video.clone();
        installed_video.preset = crate::protocol::VideoPreset::Stream1080p60;
        installed_video.width = 1920;
        installed_video.height = 1080;
        let full_layout = {
            let mut layout = default_layout_settings();
            layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
            layout
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:avfoundation-native:0",
            &default_layout_settings(),
            &installed_video,
        )
        .await;
        assert!(
            camera_capture_geometry_is_stale(&state, &full_layout, &video).await,
            "the scenario must be a real staleness case for this test to mean anything"
        );
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("mid-session"));

        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(7), needs)
            .await
            .expect("intent must register");
        let params = crate::protocol::SceneConfigParams {
            transition_ms: None,
            sources: sources(true, false),
            layout: full_layout,
            video: Some(video),
            background: None,
            protected_overlay_window_ids: Vec::new(),
        };
        resync_camera_capture_geometry_after_commit(&state, intent_id, &params, needs).await;
        // Give a wrongly-spawned restart time to touch the slot.
        sleep(Duration::from_millis(80)).await;

        let status = preview_camera_status(&state).await;
        assert_eq!(
            status.state,
            crate::protocol::PreviewCameraState::Live,
            "mid-recording resync must never restart the camera"
        );
        assert_eq!(
            status.frames_captured, 42,
            "the live session must be untouched"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn geometry_resync_settles_and_yields_to_a_newer_scene_switch() {
        // Browsing scenes fires one commit per click. An immediate restart per
        // click stacks camera restarts (renegotiation garbage on screen, the
        // device cycling off/on — owner-reported on 0.9.63 scene motion). The
        // resync must wait out the settle window and stand down when a newer
        // intent supersedes it, so only the LAST switch can restart the camera.
        let state = test_state();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Tutorial1440p30,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };
        let mut installed_video = video.clone();
        installed_video.preset = crate::protocol::VideoPreset::Stream1080p60;
        installed_video.width = 1920;
        installed_video.height = 1080;
        let full_layout = {
            let mut layout = default_layout_settings();
            layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
            layout
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:avfoundation-native:0",
            &default_layout_settings(),
            &installed_video,
        )
        .await;
        assert!(
            camera_capture_geometry_is_stale(&state, &full_layout, &video).await,
            "the scenario must be a real staleness case for this test to mean anything"
        );

        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(7), needs)
            .await
            .expect("intent must register");
        let params = crate::protocol::SceneConfigParams {
            transition_ms: Some(320),
            sources: sources(true, false),
            layout: full_layout,
            video: Some(video),
            background: None,
            protected_overlay_window_ids: Vec::new(),
        };
        resync_camera_capture_geometry_after_commit(&state, intent_id, &params, needs).await;
        // The user clicks another scene before the settle window elapses.
        begin_layout_intent(&state, Some(8), needs)
            .await
            .expect("newer intent must register");
        // Run well past the settle window (paused clock auto-advances).
        sleep(CAMERA_GEOMETRY_RESYNC_SETTLE + Duration::from_secs(1)).await;

        let status = preview_camera_status(&state).await;
        assert_eq!(
            status.state,
            crate::protocol::PreviewCameraState::Live,
            "a superseded resync must never restart the camera"
        );
        assert_eq!(
            status.frames_captured, 42,
            "the live session must be untouched"
        );
    }

    #[tokio::test]
    async fn geometry_resync_start_carries_its_layout_intent_through_camera_admission() {
        let state = test_state();
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:avfoundation-native:0",
            &default_layout_settings(),
            &fallback_video_settings(),
        )
        .await;
        begin_layout_intent(
            &state,
            Some(9),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("newer layout intent must register");

        let mut stale_sources = sources(true, false);
        // If delayed resync accidentally re-enters through the public camera
        // command, this unsupported source stops the current camera and
        // publishes Failed. Intent-owned admission rejects it before either
        // mutation, without touching real hardware.
        stale_sources.camera_id = Some("camera:unsupported:stale-resync".to_string());
        let status = start_camera_geometry_resync_for_layout(
            state.clone(),
            PreviewCameraStartParams {
                sources: stale_sources,
                layout: default_layout_settings(),
                video: fallback_video_settings(),
                ffmpeg_path: None,
            },
            8,
        )
        .await;

        assert_eq!(status.state, PreviewCameraState::Live);
        assert_eq!(
            status.camera_id.as_deref(),
            Some("camera:avfoundation-native:0")
        );
        assert_eq!(status.frames_captured, 42);
        let current = preview_camera_status(&state).await;
        assert_eq!(
            current, status,
            "stale resync must leave public camera truth untouched"
        );
    }

    #[tokio::test]
    async fn geometry_resync_waits_for_session_start_publication_before_touching_camera() {
        let state = test_state();
        let installed_video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Stream1080p60,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
        let target_video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Tutorial1440p30,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };
        let target_layout = {
            let mut layout = default_layout_settings();
            layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
            layout
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:avfoundation-native:0",
            &default_layout_settings(),
            &installed_video,
        )
        .await;
        assert!(
            camera_capture_geometry_is_stale(&state, &target_layout, &target_video).await,
            "the test must arm a real geometry resync"
        );

        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(10), needs)
            .await
            .expect("layout intent must register");
        let mut stale_sources = sources(true, false);
        stale_sources.camera_id = Some("camera:unsupported:must-not-start".to_string());

        // Simulate session.start after admission but before it publishes
        // `state.recording`. Without the shared fence, the delayed resync wins
        // this gap and the unsupported source turns the live camera Failed.
        let session_start_fence = state
            .session_start_source_transition_fence
            .clone()
            .lock_owned()
            .await;
        let mut resync = tokio::spawn(run_camera_geometry_resync_after_settle(
            state.clone(),
            PreviewCameraStartParams {
                sources: stale_sources,
                layout: target_layout.clone(),
                video: target_video.clone(),
                ffmpeg_path: None,
            },
            target_layout,
            target_video,
            intent_id,
        ));

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut resync)
                .await
                .is_err(),
            "geometry resync must wait while session startup owns admission"
        );
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "starting-session",
        ));
        drop(session_start_fence);
        resync.await.expect("geometry resync task must finish");

        let status = preview_camera_status(&state).await;
        assert_eq!(status.state, PreviewCameraState::Live);
        assert_eq!(
            status.camera_id.as_deref(),
            Some("camera:avfoundation-native:0")
        );
        assert_eq!(status.frames_captured, 42);
    }

    fn sources(camera: bool, screen: bool) -> SourceSelection {
        SourceSelection {
            screen_id: screen.then(|| "screen:screencapturekit:1".to_string()),
            window_id: None,
            camera_id: camera.then(|| "camera:avfoundation-native:0".to_string()),
            microphone_id: Some("microphone:coreaudio:81".to_string()),
            test_pattern: false,
        }
    }

    fn layout(preset: LayoutPreset) -> LayoutSettings {
        use crate::protocol::{
            CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode,
            SideBySideCameraSide, SideBySideSplit,
        };
        LayoutSettings {
            layout_preset: preset,
            camera_transform_mode: CameraTransformMode::Preset,
            camera_transform: None,
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Rectangle,
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: false,
            camera_zoom: 100,
            camera_offset_x: 0,
            camera_offset_y: 0,
            side_by_side_split: SideBySideSplit::SeventyThirty,
            side_by_side_camera_side: SideBySideCameraSide::Right,
            camera_chroma_key_enabled: false,
            camera_chroma_key_color: "#00FF00".to_string(),
            camera_chroma_key_similarity_pct: 40,
            camera_chroma_key_smoothness_pct: 8,
            camera_chroma_key_spill_pct: 10,
        }
    }

    fn config(preset: LayoutPreset, camera: bool, screen: bool) -> SceneConfigParams {
        SceneConfigParams {
            transition_ms: None,
            sources: sources(camera, screen),
            layout: layout(preset),
            video: Some(fallback_video_settings()),
            background: None,
            protected_overlay_window_ids: Vec::new(),
        }
    }

    fn live_camera_status(
        camera_id: &str,
        frame_age_ms: Option<u64>,
        frames_captured: u64,
        sequence: Option<u64>,
    ) -> PreviewCameraStatus {
        PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: Some(camera_id.to_string()),
            device_unique_id: None,
            target_fps: 30,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms,
            frames_captured,
            dropped_frames: 0,
            sequence,
            updated_at: "t".to_string(),
            message: None,
        }
    }

    fn live_screen_status(
        source_id: &str,
        frame_age_ms: Option<u64>,
        frames_captured: u64,
        sequence: Option<u64>,
    ) -> PreviewScreenStatus {
        PreviewScreenStatus {
            state: PreviewScreenState::Live,
            source_id: Some(source_id.to_string()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: 30,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: Some(true),
            d3d11_texture_available: Some(false),
            source_fps: None,
            frame_age_ms,
            frames_captured,
            dropped_frames: 0,
            sequence,
            include_cursor: true,
            exclude_current_process_windows: true,
            updated_at: "t".to_string(),
            message: None,
        }
    }

    #[test]
    fn required_sources_follow_the_built_scene() {
        let both = scene_from_capture_config(config(LayoutPreset::ScreenCamera, true, true));
        assert_eq!(
            required_scene_sources(&both),
            SceneSourceNeeds {
                camera: true,
                screen: true
            }
        );

        let camera_only = scene_from_capture_config(config(LayoutPreset::CameraOnly, true, true));
        assert_eq!(
            required_scene_sources(&camera_only),
            SceneSourceNeeds {
                camera: true,
                screen: false
            }
        );

        let screen_only = scene_from_capture_config(config(LayoutPreset::ScreenOnly, true, true));
        assert_eq!(
            required_scene_sources(&screen_only),
            SceneSourceNeeds {
                camera: false,
                screen: true
            }
        );
    }

    #[test]
    fn swap_is_hot_only_when_every_needed_source_is_live() {
        let needs = SceneSourceNeeds {
            camera: true,
            screen: true,
        };
        assert_eq!(
            plan_live_swap(
                MutationKind::LayoutSetPreset,
                needs,
                SourceLiveness {
                    camera: true,
                    screen: true
                }
            ),
            ApplyMode::Hot
        );
        assert_eq!(
            plan_live_swap(
                MutationKind::LayoutSetPreset,
                needs,
                SourceLiveness {
                    camera: false,
                    screen: true
                }
            ),
            ApplyMode::Warm
        );
        assert_eq!(
            missing_sources(
                needs,
                SourceLiveness {
                    camera: false,
                    screen: false
                }
            ),
            vec!["screen", "camera"]
        );
    }

    #[test]
    fn source_device_switch_is_always_warm() {
        let needs = SceneSourceNeeds {
            camera: true,
            screen: true,
        };
        assert_eq!(
            plan_live_swap(
                MutationKind::SourceDeviceSwitch,
                needs,
                SourceLiveness {
                    camera: true,
                    screen: true
                }
            ),
            ApplyMode::Warm
        );
    }

    #[test]
    fn unneeded_sources_never_block_a_hot_swap() {
        // screen-only while the camera is dark: camera liveness is irrelevant.
        let needs = SceneSourceNeeds {
            camera: false,
            screen: true,
        };
        assert_eq!(
            plan_live_swap(
                MutationKind::LayoutSetPreset,
                needs,
                SourceLiveness {
                    camera: false,
                    screen: true
                }
            ),
            ApplyMode::Hot
        );
    }

    #[test]
    fn live_revisions_always_beat_session_start_revisions() {
        // Session start stamps wallclock millis; a live commit must never be rejected
        // by the compositor's stale-revision guard.
        let session_revision = 1_781_038_338_044_u64;
        let next = next_scene_revision(Some(session_revision), session_revision - 10_000);
        assert_eq!(next, session_revision + 1);

        // And when the compositor is behind wallclock, jump to wallclock.
        assert_eq!(next_scene_revision(Some(5), 1_000), 1_000);
        assert_eq!(next_scene_revision(None, 1_000), 1_000);
    }

    #[test]
    fn renderer_local_revisions_are_below_backend_assigned_commits() {
        let current_compositor_revision = 1_781_038_338_044_u64;
        let renderer_local_revision = 7;

        assert!(
            renderer_local_revision < current_compositor_revision,
            "this is the stale renderer-counter shape this module must defeat"
        );
        assert_eq!(
            next_scene_revision(Some(current_compositor_revision), renderer_local_revision),
            current_compositor_revision + 1
        );
    }

    #[tokio::test]
    async fn concurrent_scene_commits_are_strictly_ordered_and_keep_one_truth() {
        let state = test_state();
        let mut first_scene =
            scene_from_capture_config(config(LayoutPreset::CameraOnly, true, false));
        first_scene.id = "scene:concurrent:first".to_string();
        first_scene.name = "Concurrent First".to_string();
        let first_layout = layout(LayoutPreset::CameraOnly);
        let mut second_scene =
            scene_from_capture_config(config(LayoutPreset::ScreenOnly, false, true));
        second_scene.id = "scene:concurrent:second".to_string();
        second_scene.name = "Concurrent Second".to_string();
        let second_layout = layout(LayoutPreset::ScreenOnly);
        let barrier = Arc::new(Barrier::new(3));

        let first_state = state.clone();
        let first_barrier = Arc::clone(&barrier);
        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            commit_scene_with_layout_at_time(&first_state, &first_scene, first_layout, None, 1_000)
                .await
                .expect("first concurrent scene commit")
        });
        let second_state = state.clone();
        let second_barrier = Arc::clone(&barrier);
        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            commit_scene_with_layout_at_time(
                &second_state,
                &second_scene,
                second_layout,
                None,
                1_000,
            )
            .await
            .expect("second concurrent scene commit")
        });

        barrier.wait().await;
        let first = first.await.expect("first commit task");
        let second = second.await.expect("second commit task");
        let (earlier, later) = if first.scene_revision < second.scene_revision {
            (&first, &second)
        } else {
            (&second, &first)
        };

        assert!(
            earlier.scene_revision < later.scene_revision,
            "concurrent commits reused scene revision {}",
            earlier.scene_revision
        );
        assert_eq!(*state.scene.lock().await, later.scene);
        let compositor = state.compositor.lock().await.status.clone();
        assert_eq!(compositor.scene_revision, Some(later.scene_revision));
        assert_eq!(
            compositor.scene_id.as_deref(),
            Some(later.scene.id.as_str())
        );
        assert_eq!(
            compositor.scene_layout,
            later.compositor_status.scene_layout
        );
    }

    #[test]
    fn preset_selection_blockers_are_exact() {
        let blocked = preset_selection_blocker(&config(LayoutPreset::CameraOnly, false, true));
        assert!(blocked.is_some_and(|message| message.contains("needs a camera")));

        let blocked = preset_selection_blocker(&config(LayoutPreset::ScreenCamera, true, false));
        assert!(blocked.is_some_and(|message| message.contains("needs a screen")));

        assert_eq!(
            preset_selection_blocker(&config(LayoutPreset::SideBySide, true, true)),
            None
        );
        let mut test_pattern = config(LayoutPreset::ScreenOnly, false, false);
        test_pattern.sources.test_pattern = true;
        assert_eq!(preset_selection_blocker(&test_pattern), None);

        let mut legacy_screen = config(LayoutPreset::SideBySide, true, false);
        legacy_screen.sources.screen_id = Some("screen:avfoundation:7".to_string());
        assert!(
            preset_selection_blocker(&legacy_screen)
                .is_some_and(|message| message.contains("native screen"))
        );

        let windows_screen = config(LayoutPreset::ScreenOnly, false, false);
        assert_eq!(
            preset_selection_blocker(&windows_screen),
            Some(
                "Layout preset ScreenOnly needs a screen or window, but none is selected. Pick one, then switch."
                    .to_string()
            )
        );

        let mut windows_dxgi = config(LayoutPreset::ScreenOnly, false, false);
        windows_dxgi.sources.screen_id = Some("screen:dxgi:00000000000003f1:2".to_string());
        assert_eq!(preset_selection_blocker(&windows_dxgi), None);

        let mut windows_gdigrab = config(LayoutPreset::ScreenOnly, false, false);
        windows_gdigrab.sources.screen_id = Some("screen:gdigrab:desktop".to_string());
        assert_eq!(preset_selection_blocker(&windows_gdigrab), None);
    }

    #[test]
    fn camera_freshness_and_screen_presence_are_source_specific() {
        let mut camera = PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: None,
            device_unique_id: None,
            target_fps: 30,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: Some(120),
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            updated_at: "t".to_string(),
            message: None,
        };
        assert!(camera_status_is_live(&camera));
        camera.frame_age_ms = Some(SOURCE_FRESH_FRAME_MAX_AGE_MS + 1);
        assert!(!camera_status_is_live(&camera));
        camera.frame_age_ms = None;
        assert!(!camera_status_is_live(&camera));
        camera.frame_age_ms = Some(120);
        camera.state = PreviewCameraState::Starting;
        assert!(!camera_status_is_live(&camera));

        let mut screen = PreviewScreenStatus {
            state: PreviewScreenState::Live,
            source_id: Some("screen:a".to_string()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: 30,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: None,
            d3d11_texture_available: None,
            source_fps: None,
            frame_age_ms: Some(120),
            frames_captured: 10,
            dropped_frames: 0,
            sequence: None,
            include_cursor: true,
            exclude_current_process_windows: true,
            updated_at: "t".to_string(),
            message: None,
        };
        assert!(screen_status_is_live(&screen));
        screen.frame_age_ms = Some(SOURCE_FRESH_FRAME_MAX_AGE_MS + 1);
        assert!(screen_status_is_live(&screen));
        screen.frame_age_ms = None;
        screen.frames_captured = 0;
        assert!(!screen_status_is_live(&screen));
    }

    #[test]
    fn target_camera_liveness_requires_requested_device() {
        let camera = PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: Some("camera:a".to_string()),
            device_unique_id: None,
            target_fps: 30,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: Some(120),
            frames_captured: 10,
            dropped_frames: 0,
            sequence: None,
            updated_at: "t".to_string(),
            message: None,
        };
        let mut target = sources(true, true);
        target.camera_id = Some("camera:b".to_string());
        assert!(!target_camera_status_is_live(&camera, Some(&target)));
        target.camera_id = Some("camera:a".to_string());
        assert!(target_camera_status_is_live(&camera, Some(&target)));
    }

    #[tokio::test]
    async fn transaction_liveness_rejects_old_devices_when_new_ids_are_requested() {
        let state = test_state();
        state.preview_camera.lock().await.status =
            live_camera_status("camera:old", Some(0), 1, Some(1));
        state.preview_screen.lock().await.status =
            live_screen_status("screen:screencapturekit:old", Some(0), 1, Some(1));
        let target = SourceSelection {
            screen_id: Some("screen:screencapturekit:new".to_string()),
            window_id: None,
            camera_id: Some("camera:new".to_string()),
            microphone_id: None,
            test_pattern: false,
        };

        let live = source_liveness(&state, &target).await;

        assert_eq!(live, SourceLiveness::default());
    }

    #[tokio::test]
    async fn screen_retirement_waiting_for_transition_does_not_hold_layout_intents() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(1),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("first intent");
        let held_transition =
            crate::preview_screen::acquire_preview_screen_transition(&state).await;
        let retirement_state = state.clone();
        let retirement = tokio::spawn(async move {
            retire_unused_sources_after_commit(
                &retirement_state,
                intent_id,
                SceneSourceNeeds {
                    camera: true,
                    screen: false,
                },
            )
            .await;
        });
        tokio::task::yield_now().await;

        let winner = tokio::time::timeout(
            Duration::from_millis(100),
            begin_layout_intent(
                &state,
                Some(2),
                SceneSourceNeeds {
                    camera: false,
                    screen: true,
                },
            ),
        )
        .await
        .expect("native transition wait must not block a newer layout intent")
        .expect("newer intent");
        assert_eq!(winner, 2);

        drop(held_transition);
        retirement.await.expect("retirement task");
    }

    #[tokio::test]
    async fn camera_start_cancellation_waiting_for_transition_does_not_hold_layout_intents() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(10),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("camera intent");
        let camera_identity = crate::preview_camera::test_install_starting_camera_generation(
            &state,
            "camera:avfoundation:test",
            &default_layout_settings(),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let held_transition =
            crate::preview_camera::acquire_preview_camera_transition(&state).await;
        let cancel_state = state.clone();
        let cancellation = tokio::spawn(async move {
            cancel_pending_source_start_for_intent(
                &cancel_state,
                intent_id,
                "camera",
                Some(&camera_identity),
                None,
            )
            .await;
        });
        tokio::task::yield_now().await;

        let winner = tokio::time::timeout(
            Duration::from_millis(100),
            begin_layout_intent(
                &state,
                Some(11),
                SceneSourceNeeds {
                    camera: false,
                    screen: true,
                },
            ),
        )
        .await
        .expect("camera transition wait must not block a newer layout intent")
        .expect("newer intent");
        assert_eq!(winner, 11);

        drop(held_transition);
        cancellation.await.expect("cancellation task");
    }

    #[tokio::test]
    async fn screen_retirement_serializes_new_intent_and_preserves_winner() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(1),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("first layout intent should register");

        // Hold the registry so retirement can acquire transition -> intent ->
        // preview runtime, but cannot commit the atomic consumer-release/detach
        // edge. A newer intent must remain blocked until that edge finishes.
        let registry = state.source_registry.lock().await;
        let retirement_state = state.clone();
        let retirement = tokio::spawn(async move {
            retire_unused_sources_after_commit(
                &retirement_state,
                intent_id,
                SceneSourceNeeds {
                    camera: true,
                    screen: false,
                },
            )
            .await;
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if state.layout_intents.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retirement must hold the intent guard at the detach edge");

        let winner_state = state.clone();
        let winner = tokio::spawn(async move {
            let intent_id = begin_layout_intent(
                &winner_state,
                Some(2),
                SceneSourceNeeds {
                    camera: false,
                    screen: true,
                },
            )
            .await
            .expect("newer screen intent should register after retirement detaches");
            let target = sources(false, true);
            winner_state.preview_screen.lock().await.status = live_screen_status(
                target.screen_id.as_deref().expect("selected screen"),
                Some(0),
                1,
                Some(1),
            );
            (intent_id, target)
        });
        tokio::task::yield_now().await;
        assert!(
            !winner.is_finished(),
            "newer screen intent registered before old retirement detached"
        );

        drop(registry);
        retirement.await.expect("screen retirement task");
        let (winner_id, winner_target) = winner.await.expect("newer screen intent task");

        let intents = state.layout_intents.lock().await;
        assert_eq!(intents.latest_intent_id, winner_id);
        assert!(intents.latest_needs_screen);
        drop(intents);
        assert!(source_liveness(&state, &winner_target).await.screen);
    }

    #[tokio::test]
    async fn superseded_layout_stops_waiting_for_an_in_flight_native_source_start() {
        let state = test_state();
        let stale_intent = begin_layout_intent(
            &state,
            Some(10),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("stale screen intent should register");
        let source_waiter_started = Arc::new(Barrier::new(2));
        let source_waiter_dropped = Arc::new(AtomicBool::new(false));
        let source_task = {
            let source_waiter_started = Arc::clone(&source_waiter_started);
            let source_waiter_dropped = Arc::clone(&source_waiter_dropped);
            tokio::spawn(async move {
                let _drop_flag = DropFlag(source_waiter_dropped);
                source_waiter_started.wait().await;
                std::future::pending::<u64>().await
            })
        };
        let waiter_state = state.clone();
        let waiter = tokio::spawn(async move {
            await_layout_source_start(
                &waiter_state,
                stale_intent,
                Duration::from_secs(5),
                false,
                "screen",
                None,
                SourceStartAdmission::default(),
                None,
                source_task,
            )
            .await
        });
        source_waiter_started.wait().await;

        begin_layout_intent(
            &state,
            Some(11),
            SceneSourceNeeds {
                camera: true,
                screen: true,
            },
        )
        .await
        .expect("newer camera intent should register");
        let result = tokio::time::timeout(Duration::from_millis(500), waiter)
            .await
            .expect("superseded layout waiter must return promptly")
            .expect("layout waiter task");

        assert!(
            result
                .expect_err("stale layout must not accept the source")
                .to_string()
                .contains("superseded")
        );
        // `source_task` is only the command-facing waiter. The physical
        // transition was already queued under a process-owned supervisor, so
        // supersession must cancel this wrapper promptly; queued supervisor
        // continuation and owner transfer have dedicated preview source tests.
        tokio::time::timeout(Duration::from_millis(500), async {
            while !source_waiter_dropped.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("supersession must cancel the disposable source-start waiter");
    }

    #[tokio::test]
    async fn superseded_unneeded_source_start_is_aborted_before_late_registration() {
        let state = test_state();
        let stale_intent = begin_layout_intent(
            &state,
            Some(15),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("stale screen intent should register");
        let start_dropped = Arc::new(AtomicBool::new(false));
        let source_task = {
            let flag = DropFlag(Arc::clone(&start_dropped));
            tokio::spawn(async move {
                let _flag = flag;
                std::future::pending::<u64>().await
            })
        };
        let waiter_state = state.clone();
        let waiter = tokio::spawn(async move {
            await_layout_source_start(
                &waiter_state,
                stale_intent,
                Duration::from_secs(5),
                false,
                "screen",
                None,
                SourceStartAdmission::default(),
                None,
                source_task,
            )
            .await
        });
        tokio::task::yield_now().await;

        begin_layout_intent(
            &state,
            Some(16),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("newer camera-only intent should register");
        let result = tokio::time::timeout(Duration::from_millis(500), waiter)
            .await
            .expect("superseded layout waiter must return promptly")
            .expect("layout waiter task");

        assert!(
            result
                .expect_err("stale layout must not accept the source")
                .to_string()
                .contains("superseded")
        );
        assert!(
            start_dropped.load(Ordering::Acquire),
            "a source the winner does not need must be canceled before it can register after retirement"
        );
    }

    #[tokio::test]
    async fn layout_source_start_timeout_invalidates_the_pending_current_start() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(20),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("screen intent should register");
        let pending = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            "screen:screencapturekit:pending",
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let source_task = tokio::spawn(async { std::future::pending::<u64>().await });

        let result = tokio::time::timeout(
            Duration::from_millis(500),
            await_layout_source_start(
                &state,
                intent_id,
                Duration::from_millis(50),
                false,
                "screen",
                None,
                SourceStartAdmission {
                    camera: None,
                    screen: Some(pending),
                },
                None,
                source_task,
            ),
        )
        .await
        .expect("the transaction deadline must bound native startup")
        .expect_err("pending native startup must time out");

        assert!(result.to_string().contains("timed out"));
        assert_ne!(
            preview_screen_status(&state).await.state,
            PreviewScreenState::Starting,
            "timeout must invalidate the pending lease so it cannot install later"
        );
    }

    #[tokio::test]
    async fn late_camera_live_between_expiry_sample_and_cancel_is_preserved() {
        let state = test_state();
        let target = sources(true, false);
        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(201), needs)
            .await
            .expect("camera intent");
        let expired = crate::preview_camera::test_install_starting_camera_generation(
            &state,
            target.camera_id.as_deref().expect("target camera"),
            &default_layout_settings(),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let sampled = source_readiness(&state, &target).await;
        assert!(!sampled.live.camera, "expiry sample must see Starting");

        crate::preview_camera::test_publish_starting_camera_live(
            &state,
            &expired,
            target.camera_id.as_deref().expect("target camera"),
            &default_layout_settings(),
            &fallback_video_settings(),
        )
        .await;
        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            Some(&expired),
            None,
            &target,
        )
        .await;

        assert!(refreshed.live.camera);
        assert_eq!(
            preview_camera_status(&state).await.state,
            PreviewCameraState::Live,
            "stale timeout cancellation must not stop a camera which already published Live"
        );
    }

    #[tokio::test]
    async fn expired_camera_generation_cannot_cancel_a_newer_starting_generation() {
        let state = test_state();
        let target = sources(true, false);
        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(203), needs)
            .await
            .expect("camera intent");
        let expired = crate::preview_camera::test_install_starting_camera_generation(
            &state,
            target.camera_id.as_deref().expect("target camera"),
            &default_layout_settings(),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let winner = crate::preview_camera::test_install_starting_camera_generation(
            &state,
            "camera:avfoundation:newer-public-command",
            &default_layout_settings(),
            &fallback_video_settings(),
            None,
        )
        .await;
        // The independently admitted winner is already current when the old
        // layout reaches its expiry sample. Cleanup must still carry G1 from
        // layout admission rather than discovering and cancelling G2 here.
        let sampled = source_readiness(&state, &target).await;
        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            Some(&expired),
            None,
            &target,
        )
        .await;

        assert!(!refreshed.live.camera);
        let (status, identity) = preview_camera_status_and_starting_identity(&state).await;
        assert_eq!(status.state, PreviewCameraState::Starting);
        assert_eq!(
            identity.as_ref(),
            Some(&winner),
            "G1 timeout cleanup must not invalidate the independently admitted G2"
        );
    }

    #[tokio::test]
    async fn exact_expired_camera_generation_is_invalidated() {
        let state = test_state();
        let target = sources(true, false);
        let needs = SceneSourceNeeds {
            camera: true,
            screen: false,
        };
        let intent_id = begin_layout_intent(&state, Some(204), needs)
            .await
            .expect("camera intent");
        let expired = crate::preview_camera::test_install_starting_camera_generation(
            &state,
            target.camera_id.as_deref().expect("target camera"),
            &default_layout_settings(),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let sampled = source_readiness(&state, &target).await;

        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            Some(&expired),
            None,
            &target,
        )
        .await;

        assert!(!refreshed.live.camera);
        let (status, identity) = preview_camera_status_and_starting_identity(&state).await;
        assert_ne!(status.state, PreviewCameraState::Starting);
        assert!(identity.is_none());
    }

    #[tokio::test]
    async fn late_screen_live_between_expiry_sample_and_cancel_is_preserved() {
        let state = test_state();
        let target = sources(false, true);
        let needs = SceneSourceNeeds {
            camera: false,
            screen: true,
        };
        let intent_id = begin_layout_intent(&state, Some(202), needs)
            .await
            .expect("screen intent");
        let expired = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            selected_screen_source_id(&target).expect("target screen"),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let sampled = source_readiness(&state, &target).await;
        assert!(!sampled.live.screen, "expiry sample must see Starting");

        crate::preview_screen::test_install_live_screen_generation(
            &state,
            selected_screen_source_id(&target).expect("target screen"),
            expired.generation,
            1,
            &fallback_video_settings(),
        )
        .await;
        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            None,
            Some(&expired),
            &target,
        )
        .await;

        assert!(refreshed.live.screen);
        assert_eq!(
            preview_screen_status(&state).await.state,
            PreviewScreenState::Live,
            "stale timeout cancellation must not stop a screen which already published Live"
        );
    }

    #[tokio::test]
    async fn expired_screen_generation_cannot_cancel_a_newer_starting_generation() {
        let state = test_state();
        let target = sources(false, true);
        let needs = SceneSourceNeeds {
            camera: false,
            screen: true,
        };
        let intent_id = begin_layout_intent(&state, Some(205), needs)
            .await
            .expect("screen intent");
        let expired = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            selected_screen_source_id(&target).expect("target screen"),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let winner = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            "screen:screencapturekit:newer-public-command",
            &fallback_video_settings(),
            None,
        )
        .await;
        let sampled = source_readiness(&state, &target).await;

        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            None,
            Some(&expired),
            &target,
        )
        .await;

        assert!(!refreshed.live.screen);
        let (status, identity) =
            crate::preview_screen::preview_screen_status_and_starting_identity(&state).await;
        assert_eq!(status.state, PreviewScreenState::Starting);
        assert_eq!(identity.as_ref(), Some(&winner));
    }

    #[tokio::test]
    async fn exact_expired_screen_generation_is_invalidated() {
        let state = test_state();
        let target = sources(false, true);
        let needs = SceneSourceNeeds {
            camera: false,
            screen: true,
        };
        let intent_id = begin_layout_intent(&state, Some(206), needs)
            .await
            .expect("screen intent");
        let expired = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            selected_screen_source_id(&target).expect("target screen"),
            &fallback_video_settings(),
            Some(intent_id),
        )
        .await;
        let sampled = source_readiness(&state, &target).await;

        let refreshed = cancel_expired_source_starts_and_refresh_readiness(
            &state,
            intent_id,
            needs,
            &sampled,
            None,
            Some(&expired),
            &target,
        )
        .await;

        assert!(!refreshed.live.screen);
        let (status, identity) =
            crate::preview_screen::preview_screen_status_and_starting_identity(&state).await;
        assert_ne!(status.state, PreviewScreenState::Starting);
        assert!(identity.is_none());
    }

    #[test]
    fn live_source_start_budgets_are_source_specific() {
        assert_eq!(warm_source_start_timeout("camera"), Duration::from_secs(15));
        assert_eq!(warm_source_start_timeout("screen"), Duration::from_secs(15));
    }

    #[tokio::test(start_paused = true)]
    async fn camera_transition_supervisor_owns_timeout_while_blocked_behind_recovery_gate() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(21),
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
        )
        .await
        .expect("camera layout intent");
        let held_transition =
            crate::preview_camera::acquire_preview_camera_transition(&state).await;
        let start_dropped = Arc::new(AtomicBool::new(false));
        let source_state = state.clone();
        let source_task = {
            let start_dropped = Arc::clone(&start_dropped);
            tokio::spawn(async move {
                let _drop_flag = DropFlag(start_dropped);
                let _transition =
                    crate::preview_camera::acquire_preview_camera_transition(&source_state).await;
                42_u64
            })
        };
        let waiter_state = state.clone();
        let waiter = tokio::spawn(async move {
            run_explicit_camera_configuration_transaction(&waiter_state, async {
                await_layout_source_start(
                    &waiter_state,
                    intent_id,
                    WARM_CAMERA_START_TIMEOUT,
                    true,
                    "camera",
                    None,
                    SourceStartAdmission::default(),
                    None,
                    source_task,
                )
                .await
            })
            .await
        });

        sleep(WARM_CAMERA_START_TIMEOUT + Duration::from_secs(1)).await;
        assert!(
            !waiter.is_finished(),
            "layout must not race the camera supervisor with another 15s timeout"
        );
        assert!(
            !start_dropped.load(Ordering::Acquire),
            "the admitted operator generation must remain owned while recovery releases the gate"
        );
        let in_flight_mutation_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(
            state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "the layout mutation must reject health admission while camera start is gate-blocked"
        );

        drop(held_transition);
        let (value, first_frame_deadline) = waiter
            .await
            .expect("layout waiter task")
            .expect("camera supervisor completion remains authoritative");
        assert_eq!(value, 42);
        assert_eq!(
            first_frame_deadline.saturating_duration_since(Instant::now()),
            WARM_CAMERA_START_TIMEOUT,
            "the first-frame budget starts after the transition response"
        );
        assert!(
            !state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "layout completion must release its explicit camera mutation lease"
        );
        assert!(
            state.capture_recovery_camera_mutation_epoch() > in_flight_mutation_epoch,
            "layout completion must stale health sampled inside the transaction"
        );
    }

    #[test]
    fn camera_zombie_grace_exceeds_the_camera_warm_start_budget() {
        // If the grace were inside the budget, a switch retry would tear down a
        // session that is still legitimately warming up and restart its clock —
        // a camera slower than the grace could then never come back (the 0.9.51
        // Cam Link retry storm). Retries must join the warm-up, not kill it.
        assert!(
            crate::preview_camera::CAMERA_FIRST_FRAME_REUSE_GRACE
                > warm_source_start_timeout("camera"),
            "CAMERA_FIRST_FRAME_REUSE_GRACE must stay above WARM_CAMERA_START_TIMEOUT"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn screen_source_start_budget_accepts_an_eight_second_start() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(21),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("screen intent should register");
        let source_task = tokio::spawn(async {
            sleep(Duration::from_secs(8)).await;
            42_u64
        });

        let result = await_layout_source_start(
            &state,
            intent_id,
            warm_source_start_timeout("screen"),
            false,
            "screen",
            None,
            SourceStartAdmission::default(),
            None,
            source_task,
        )
        .await;

        assert_eq!(
            result
                .expect("an eight-second screen start should fit its budget")
                .0,
            42
        );
    }

    #[tokio::test(start_paused = true)]
    async fn screen_source_start_budget_begins_after_old_stream_teardown() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(22),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("screen intent should register");
        let (restart_ready_tx, restart_ready_rx) = oneshot::channel();
        let source_task = tokio::spawn(async move {
            sleep(Duration::from_secs(8)).await;
            let _ = restart_ready_tx.send(());
            sleep(Duration::from_secs(8)).await;
            42_u64
        });

        let result = await_layout_source_start(
            &state,
            intent_id,
            warm_source_start_timeout("screen"),
            false,
            "screen",
            Some(restart_ready_rx),
            SourceStartAdmission::default(),
            None,
            source_task,
        )
        .await;

        assert_eq!(
            result
                .expect("teardown time must not consume the screen startup budget")
                .0,
            42
        );
    }

    #[tokio::test]
    async fn screen_source_start_timeout_surfaces_the_native_start_error() {
        let state = test_state();
        let intent_id = begin_layout_intent(
            &state,
            Some(23),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("screen intent should register");
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = PreviewScreenState::Failed;
            screen.status.message = Some(
                "ScreenCaptureKit stream failed to start: display was disconnected".to_string(),
            );
        }
        let source_task = tokio::spawn(async { std::future::pending::<u64>().await });

        let error = await_layout_source_start(
            &state,
            intent_id,
            Duration::from_millis(1),
            false,
            "screen",
            None,
            SourceStartAdmission::default(),
            None,
            source_task,
        )
        .await
        .expect_err("pending native startup must time out");

        assert!(
            error
                .to_string()
                .contains("ScreenCaptureKit stream failed to start: display was disconnected")
        );
    }

    #[tokio::test]
    async fn screen_readiness_timeout_surfaces_the_native_start_error() {
        let state = test_state();
        let target = sources(false, true);
        let intent_id = begin_layout_intent(
            &state,
            Some(24),
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
        )
        .await
        .expect("screen intent should register");
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status = live_screen_status(
                target.screen_id.as_deref().expect("selected screen"),
                None,
                0,
                None,
            );
            screen.status.state = PreviewScreenState::Failed;
            screen.status.message = Some(
                "ScreenCaptureKit stream failed to start: display was disconnected".to_string(),
            );
        }

        let error = wait_for_sources_ready(
            &state,
            intent_id,
            SourceReadinessDeadlines {
                camera: None,
                screen: Some(Instant::now()),
                camera_admission: None,
                screen_admission: None,
            },
            SceneSourceNeeds {
                camera: false,
                screen: true,
            },
            &target,
            "source device switch",
        )
        .await
        .expect_err("a failed screen start must block the switch");

        assert!(
            error
                .to_string()
                .contains("ScreenCaptureKit stream failed to start: display was disconnected")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn screen_readiness_budget_is_not_extended_by_a_later_camera_deadline() {
        let state = test_state();
        let target = sources(true, true);
        let needs = SceneSourceNeeds {
            camera: true,
            screen: true,
        };
        let intent_id = begin_layout_intent(&state, Some(25), needs)
            .await
            .expect("dual-source intent should register");
        let started = Instant::now();
        let camera_start = tokio::spawn(async {
            sleep(Duration::from_secs(20)).await;
            42_u64
        });

        let error = await_layout_source_start(
            &state,
            intent_id,
            Duration::from_secs(20),
            true,
            "camera",
            None,
            SourceStartAdmission::default(),
            Some(SourceReadinessGuard {
                source_label: "screen",
                deadline: started + WARM_SCREEN_START_TIMEOUT,
                target_sources: target,
                admission: SourceStartAdmission::default(),
            }),
            camera_start,
        )
        .await
        .expect_err("the screen must fail at its own deadline");

        assert_eq!(Instant::now() - started, WARM_SCREEN_START_TIMEOUT);
        assert!(error.to_string().contains("screen (15s)"));
        assert!(!error.to_string().contains("camera (15s)"));
    }

    #[test]
    fn target_camera_liveness_accepts_fresh_frame_store_evidence() {
        let camera = PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: Some("camera:a".to_string()),
            device_unique_id: None,
            target_fps: 30,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 10,
            dropped_frames: 0,
            sequence: None,
            updated_at: "t".to_string(),
            message: None,
        };
        let mut target = sources(true, true);
        target.camera_id = Some("camera:a".to_string());
        let frame = PreviewCameraFrameInfo {
            sequence: 10,
            width: 1280,
            height: 720,
            frame_age_ms: 120,
        };

        assert!(target_camera_is_live(&camera, Some(frame), Some(&target)));
        assert!(!target_camera_status_is_live(&camera, Some(&target)));
    }

    #[test]
    fn target_screen_liveness_requires_requested_source() {
        let screen = PreviewScreenStatus {
            state: PreviewScreenState::Live,
            source_id: Some("screen:a".to_string()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: 30,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: None,
            d3d11_texture_available: None,
            source_fps: None,
            frame_age_ms: Some(120),
            frames_captured: 10,
            dropped_frames: 0,
            sequence: None,
            include_cursor: true,
            exclude_current_process_windows: true,
            updated_at: "t".to_string(),
            message: None,
        };
        let mut target = sources(false, true);
        target.screen_id = Some("screen:b".to_string());
        assert!(!target_screen_status_is_live(&screen, Some(&target)));
        target.screen_id = Some("screen:a".to_string());
        assert!(target_screen_status_is_live(&screen, Some(&target)));
    }

    #[test]
    fn target_screen_liveness_accepts_fresh_frame_store_evidence() {
        let screen = PreviewScreenStatus {
            state: PreviewScreenState::Live,
            source_id: Some("screen:a".to_string()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: 30,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: Some(true),
            d3d11_texture_available: Some(false),
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            include_cursor: true,
            exclude_current_process_windows: true,
            updated_at: "t".to_string(),
            message: None,
        };
        let mut target = sources(false, true);
        target.screen_id = Some("screen:a".to_string());
        let frame = PreviewScreenFrameInfo {
            sequence: 10,
            width: 3840,
            height: 2160,
            frame_age_ms: SOURCE_FRESH_FRAME_MAX_AGE_MS + 1,
        };

        assert!(target_screen_is_live(&screen, Some(frame), Some(&target)));
        assert!(!target_screen_status_is_live(&screen, Some(&target)));
    }

    #[test]
    fn target_screen_liveness_accepts_static_screen_frame_presence() {
        let screen = live_screen_status(
            "screen:a",
            Some(SOURCE_FRESH_FRAME_MAX_AGE_MS + 1),
            24,
            Some(24),
        );
        let mut target = sources(false, true);
        target.screen_id = Some("screen:a".to_string());

        assert!(target_screen_status_is_live(&screen, Some(&target)));
    }

    #[test]
    fn target_screen_liveness_rejects_source_without_initial_frame() {
        let screen = live_screen_status("screen:a", None, 0, None);
        let mut target = sources(false, true);
        target.screen_id = Some("screen:a".to_string());

        assert!(!target_screen_status_is_live(&screen, Some(&target)));
    }

    #[test]
    fn missing_readiness_messages_name_camera_freshness_and_screen_initial_frame() {
        let camera = live_camera_status(
            "camera:a",
            Some(SOURCE_FRESH_FRAME_MAX_AGE_MS + 1),
            42,
            Some(42),
        );
        let screen = live_screen_status("screen:a", None, 0, None);
        let mut target = sources(true, true);
        target.camera_id = Some("camera:a".to_string());
        target.screen_id = Some("screen:a".to_string());
        let readiness = SourceReadiness {
            live: SourceLiveness {
                camera: false,
                screen: false,
            },
            camera_status: camera,
            screen_status: screen,
            camera_frame: None,
            screen_frame: None,
        };

        let messages = missing_readiness_messages(
            SceneSourceNeeds {
                camera: true,
                screen: true,
            },
            &readiness,
            Some(&target),
        );

        assert_eq!(messages.len(), 2);
        // 42 frames were captured and went stale — this is the stale wording,
        // not the never-delivered wording.
        assert!(messages[0].contains("camera frames stopped or went stale"));
        assert!(messages[0].contains("latest frame age: 1501ms"));
        assert!(messages[1].contains("screen/window produced no initial frame"));
        assert!(messages[1].contains("frames captured: 0"));
    }

    #[test]
    fn missing_readiness_messages_distinguish_a_camera_that_never_delivered() {
        // The Cam Link zombie shape: Live status, zero frames ever, no frame
        // store entry. The message must say "never delivered", not "stale",
        // and must carry the dropped counter so a silent-device failure can be
        // told apart from an unusable-format failure in field reports.
        let mut camera = live_camera_status("camera:a", None, 0, None);
        camera.dropped_frames = 7;
        let mut target = sources(true, false);
        target.camera_id = Some("camera:a".to_string());
        let readiness = SourceReadiness {
            live: SourceLiveness {
                camera: false,
                screen: false,
            },
            camera_status: camera,
            screen_status: live_screen_status("screen:unused", None, 0, None),
            camera_frame: None,
            screen_frame: None,
        };

        let messages = missing_readiness_messages(
            SceneSourceNeeds {
                camera: true,
                screen: false,
            },
            &readiness,
            Some(&target),
        );

        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("camera session never delivered a frame"));
        assert!(messages[0].contains("frames captured: 0"));
        assert!(messages[0].contains("dropped: 7"));
        assert!(messages[0].contains("latest frame age: none"));
    }
}
