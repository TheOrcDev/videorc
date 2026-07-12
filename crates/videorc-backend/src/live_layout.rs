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
use tokio::time::{Instant, sleep};

use crate::compositor::update_compositor_scene;
use crate::live_scene::{ApplyMode, MutationContext, MutationKind, classify_mutation};
use crate::preview_camera::{
    PreviewCameraFrameInfo, begin_preview_camera_stop, finish_preview_camera_stop,
    preview_camera_latest_frame_info, preview_camera_status, start_preview_camera,
};
use crate::preview_screen::{PreviewScreenFrameInfo, preview_screen_latest_frame_info};
use crate::preview_screen::{
    begin_preview_screen_stop, finish_preview_screen_stop, preview_screen_status,
    start_preview_screen,
};
use crate::protocol::default_layout_settings;
use crate::protocol::{
    CompositorSceneUpdateParams, CompositorStatus, LayoutPreset, PreviewCameraStartParams,
    PreviewCameraState, PreviewCameraStatus, PreviewScreenStartParams, PreviewScreenState,
    PreviewScreenStatus, Scene, SceneCommitStatus, SceneConfigParams, SceneLayoutApplyParams,
    SceneSourceKind, SourceSelection,
};
use crate::scene::{scene_from_capture_config, validate_scene_background};
use crate::screen_capture::{
    is_windows_gdigrab_desktop_screen_id, parse_screencapturekit_display_id,
    parse_screencapturekit_window_id, parse_windows_dxgi_output_index,
};
use crate::state::AppState;

const WARM_SOURCE_START_TIMEOUT: Duration = Duration::from_secs(5);
const WARM_SOURCE_POLL: Duration = Duration::from_millis(100);
const LAYOUT_INTENT_CANCEL_POLL: Duration = Duration::from_millis(25);
const UNUSED_CAMERA_STOP_GRACE: Duration = Duration::from_secs(1);
/// A source counts as live only when its newest frame is at most this old — a stalled
/// capturer must not be swapped onto program output.
const SOURCE_FRESH_FRAME_MAX_AGE_MS: u64 = 1_500;

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

    let live = source_liveness(state, target_sources).await;
    match plan_live_swap(mutation_kind, needs, live) {
        ApplyMode::Hot => {
            let status =
                commit_scene_for_intent(state, intent_id, &scene, params.layout.clone(), None)
                    .await?;
            retire_unused_sources_after_commit(state, intent_id, needs).await;
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
            let deadline = Instant::now() + WARM_SOURCE_START_TIMEOUT;
            start_missing_sources(state, intent_id, deadline, &params, &missing, action_label)
                .await?;
            ensure_layout_intent_current(state, intent_id).await?;
            wait_for_sources_ready(
                state,
                intent_id,
                deadline,
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
            )
            .await?;
            retire_unused_sources_after_commit(state, intent_id, needs).await;
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
    intents.latest_intent_id = intent_id;
    intents.latest_needs_camera = needs.camera;
    intents.latest_needs_screen = needs.screen;
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

async fn await_layout_source_start<T: Send + 'static>(
    state: &AppState,
    intent_id: u64,
    deadline: Instant,
    source_label: &'static str,
    mut source_task: tokio::task::JoinHandle<T>,
) -> Result<T> {
    tokio::select! {
        result = &mut source_task => result.map_err(|error| {
            anyhow::anyhow!("{source_label} source startup task failed: {error}")
        }),
        _ = wait_for_layout_intent_superseded(state, intent_id) => {
            let intents = state.layout_intents.lock().await;
            let latest = intents.latest_intent_id;
            let latest_needs_source = match source_label {
                "camera" => intents.latest_needs_camera,
                "screen" => intents.latest_needs_screen,
                _ => false,
            };
            if !latest_needs_source {
                // Do not detach a startup that can register after the winner's
                // retirement edge has already run. Abort it while intent
                // registration is blocked, then invalidate any lease it created
                // before observing cancellation. A winner that still needs this
                // source keeps the detached task and can join its lease instead.
                source_task.abort();
                let _ = (&mut source_task).await;
                match source_label {
                    "camera" if preview_camera_status(state).await.state == PreviewCameraState::Starting => {
                        let stop = begin_preview_camera_stop(state).await;
                        let _ = finish_preview_camera_stop(stop).await;
                    }
                    "screen" if preview_screen_status(state).await.state == PreviewScreenState::Starting => {
                        let stop = begin_preview_screen_stop(state).await;
                        let _ = finish_preview_screen_stop(stop).await;
                    }
                    _ => {}
                }
            }
            bail!("Layout intent {intent_id} was superseded by newer intent {latest}.")
        }
        _ = tokio::time::sleep_until(deadline) => {
            source_task.abort();
            cancel_pending_source_start_for_intent(state, intent_id, source_label).await;
            bail!(
                "Layout intent {intent_id} timed out while starting {source_label} within {}s.",
                WARM_SOURCE_START_TIMEOUT.as_secs()
            );
        }
    }
}

async fn cancel_pending_source_start_for_intent(
    state: &AppState,
    intent_id: u64,
    source_label: &'static str,
) {
    match source_label {
        "camera" => {
            let stop = {
                let intents = state.layout_intents.lock().await;
                if intents.latest_intent_id != intent_id
                    || preview_camera_status(state).await.state != PreviewCameraState::Starting
                {
                    None
                } else {
                    Some(begin_preview_camera_stop(state).await)
                }
            };
            if let Some(stop) = stop {
                let _ = finish_preview_camera_stop(stop).await;
            }
        }
        "screen" => {
            let stop = {
                let intents = state.layout_intents.lock().await;
                if intents.latest_intent_id != intent_id
                    || preview_screen_status(state).await.state != PreviewScreenState::Starting
                {
                    None
                } else {
                    Some(begin_preview_screen_stop(state).await)
                }
            };
            if let Some(stop) = stop {
                let _ = finish_preview_screen_stop(stop).await;
            }
        }
        _ => {}
    }
}

async fn commit_scene_for_intent(
    state: &AppState,
    intent_id: u64,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
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
    let status = commit_scene_with_layout(state, scene, layout, message).await?;
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
    deadline: Instant,
    params: &SceneConfigParams,
    missing: &[&'static str],
    action_label: &'static str,
) -> Result<()> {
    let ffmpeg_path = active_recording_ffmpeg_path(state).await;
    for source in missing {
        ensure_layout_intent_current(state, intent_id).await?;
        match *source {
            "camera" => {
                let current = preview_camera_status(state).await;
                if current.state == PreviewCameraState::Starting
                    && current.camera_id == params.sources.camera_id
                {
                    continue;
                }
                let start = tokio::spawn(start_preview_camera(
                    state.clone(),
                    PreviewCameraStartParams {
                        sources: params.sources.clone(),
                        layout: params.layout.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                        ffmpeg_path: ffmpeg_path.clone(),
                    },
                ));
                let status =
                    await_layout_source_start(state, intent_id, deadline, "camera", start).await?;
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
                let current = preview_screen_status(state).await;
                if current.state == PreviewScreenState::Starting
                    && current.source_id.as_deref() == selected_screen_source_id(&params.sources)
                {
                    continue;
                }
                let start = tokio::spawn(start_preview_screen(
                    state.clone(),
                    PreviewScreenStartParams {
                        sources: params.sources.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                        protected_overlay_window_ids: params.protected_overlay_window_ids.clone(),
                        ffmpeg_path: ffmpeg_path.clone(),
                    },
                ));
                let status =
                    await_layout_source_start(state, intent_id, deadline, "screen", start).await?;
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
    Ok(())
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
    deadline: Instant,
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
        if Instant::now() >= deadline {
            let still_missing =
                missing_readiness_messages(needs, &readiness, Some(target_sources)).join("; ");
            if needs.camera && !readiness.live.camera {
                cancel_pending_source_start_for_intent(state, intent_id, "camera").await;
            }
            if needs.screen && !readiness.live.screen {
                cancel_pending_source_start_for_intent(state, intent_id, "screen").await;
            }
            bail!(
                "Live {action_label} blocked: {still_missing} within {}s total source-start/readiness time. The previous layout is still live.",
                WARM_SOURCE_START_TIMEOUT.as_secs()
            );
        }
        sleep(WARM_SOURCE_POLL).await;
    }
}

async fn retire_unused_sources_after_commit(
    state: &AppState,
    intent_id: u64,
    needs: SceneSourceNeeds,
) {
    if !needs.screen {
        // Keep intent registration and runtime detachment on one atomic edge.
        // The capture thread is signalled here, but its potentially slow join is
        // deliberately finished after releasing the intent mutex.
        let stop = {
            let intents = state.layout_intents.lock().await;
            if intents.latest_intent_id == intent_id && !intents.latest_needs_screen {
                Some(begin_preview_screen_stop(state).await)
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
    tokio::spawn(async move {
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
        messages.push(format!(
            "camera produced no fresh frames ({})",
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
        "state: {}, target: {}, current: {}, frames captured: {}, latest sequence: {}, latest frame age: {}",
        camera_state_label(&status.state),
        target_sources
            .and_then(|sources| sources.camera_id.as_deref())
            .unwrap_or("none"),
        status.camera_id.as_deref().unwrap_or("none"),
        status.frames_captured,
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
    format!(
        "state: {}, target: {}, current: {}, frames captured: {}, latest sequence: {}, latest frame age: {}",
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
        format_age_ms(frame_age_ms)
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
    let now_millis = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
    commit_scene_with_layout_at_time_with_policy(state, scene, layout, message, now_millis, false)
        .await
}

pub async fn commit_idle_scene_with_layout(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
) -> Result<SceneCommitStatus> {
    let now_millis = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
    commit_scene_with_layout_at_time_with_policy(state, scene, layout, message, now_millis, true)
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
    commit_scene_with_layout_at_time_with_policy(state, scene, layout, message, now_millis, false)
        .await
}

async fn commit_scene_with_layout_at_time_with_policy(
    state: &AppState,
    scene: &Scene,
    layout: crate::protocol::LayoutSettings,
    message: Option<String>,
    now_millis: u64,
    idle_only: bool,
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
    use tokio::sync::{Barrier, Notify, broadcast};

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
        }
    }

    fn config(preset: LayoutPreset, camera: bool, screen: bool) -> SceneConfigParams {
        SceneConfigParams {
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

        // Hold the runtime slot so retirement reaches the detach edge but cannot
        // complete it. A newer intent must remain blocked until that edge finishes;
        // otherwise it can register between the old check and the old stop.
        let screen = state.preview_screen.lock().await;
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
        tokio::time::sleep(Duration::from_millis(25)).await;

        assert!(
            state.layout_intents.try_lock().is_err(),
            "retirement released the intent guard before detaching the screen source"
        );

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

        drop(screen);
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
        let release_start = Arc::new(Notify::new());
        let start_finished = Arc::new(AtomicBool::new(false));
        let source_task = {
            let release_start = Arc::clone(&release_start);
            let start_finished = Arc::clone(&start_finished);
            tokio::spawn(async move {
                release_start.notified().await;
                start_finished.store(true, Ordering::Release);
                42_u64
            })
        };
        let waiter_state = state.clone();
        let waiter = tokio::spawn(async move {
            await_layout_source_start(
                &waiter_state,
                stale_intent,
                Instant::now() + Duration::from_secs(5),
                "screen",
                source_task,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;

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
        assert!(
            !start_finished.load(Ordering::Acquire),
            "superseding the layout should detach, not destroy, a source start the winner may reuse"
        );
        release_start.notify_one();
        tokio::time::timeout(Duration::from_millis(500), async {
            while !start_finished.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached source start should still be able to finish for the winner");
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
                Instant::now() + Duration::from_secs(5),
                "screen",
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
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = PreviewScreenState::Starting;
            screen.status.source_id = Some("screen:screencapturekit:pending".to_string());
        }
        let source_task = tokio::spawn(async { std::future::pending::<u64>().await });

        let result = tokio::time::timeout(
            Duration::from_millis(500),
            await_layout_source_start(
                &state,
                intent_id,
                Instant::now() + Duration::from_millis(50),
                "screen",
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
        assert!(messages[0].contains("camera produced no fresh frames"));
        assert!(messages[0].contains("latest frame age: 1501ms"));
        assert!(messages[1].contains("screen/window produced no initial frame"));
        assert!(messages[1].contains("frames captured: 0"));
    }
}
