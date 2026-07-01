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
    PreviewCameraFrameInfo, preview_camera_latest_frame_info, preview_camera_status,
    start_preview_camera,
};
use crate::preview_screen::{PreviewScreenFrameInfo, preview_screen_latest_frame_info};
use crate::preview_screen::{preview_screen_status, start_preview_screen};
use crate::protocol::default_layout_settings;
use crate::protocol::{
    CompositorSceneUpdateParams, LayoutPreset, PreviewCameraStartParams, PreviewCameraState,
    PreviewCameraStatus, PreviewScreenStartParams, PreviewScreenState, PreviewScreenStatus, Scene,
    SceneCommitStatus, SceneConfigParams, SceneSourceKind, SourceSelection,
};
use crate::scene::{scene_from_capture_config, validate_scene_background};
use crate::screen_capture::{parse_screencapturekit_display_id, parse_screencapturekit_window_id};
use crate::state::AppState;

const WARM_SOURCE_START_TIMEOUT: Duration = Duration::from_secs(5);
const WARM_SOURCE_POLL: Duration = Duration::from_millis(100);
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
    status.state == PreviewScreenState::Live && fresh_frame_age(status.frame_age_ms)
}

fn fresh_frame_age(frame_age_ms: Option<u64>) -> bool {
    frame_age_ms.is_some_and(|age| age <= SOURCE_FRESH_FRAME_MAX_AGE_MS)
}

fn camera_frame_info_is_live(frame_info: Option<PreviewCameraFrameInfo>) -> bool {
    frame_info.is_some_and(|frame| frame.frame_age_ms <= SOURCE_FRESH_FRAME_MAX_AGE_MS)
}

fn screen_frame_info_is_live(frame_info: Option<PreviewScreenFrameInfo>) -> bool {
    frame_info.is_some_and(|frame| frame.frame_age_ms <= SOURCE_FRESH_FRAME_MAX_AGE_MS)
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
    if status.state != PreviewScreenState::Live
        || !(fresh_frame_age(status.frame_age_ms) || screen_frame_info_is_live(frame_info))
    {
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
    let needs_camera = matches!(preset, LayoutPreset::CameraOnly | LayoutPreset::SideBySide);
    let needs_screen = matches!(
        preset,
        LayoutPreset::ScreenOnly | LayoutPreset::ScreenCamera | LayoutPreset::SideBySide
    );
    let camera_selected = params.sources.camera_id.is_some();
    let screen_selected = params.sources.test_pattern
        || params
            .sources
            .screen_id
            .as_deref()
            .and_then(parse_screencapturekit_display_id)
            .is_some()
        || params
            .sources
            .window_id
            .as_deref()
            .and_then(parse_screencapturekit_window_id)
            .is_some();
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

async fn source_liveness(
    state: &AppState,
    target_sources: Option<&SourceSelection>,
) -> SourceLiveness {
    let camera = preview_camera_status(state).await;
    let screen = preview_screen_status(state).await;
    let camera_frame = preview_camera_latest_frame_info(state).await;
    let screen_frame = preview_screen_latest_frame_info(state).await;
    SourceLiveness {
        camera: target_camera_is_live(&camera, camera_frame, target_sources),
        screen: target_screen_is_live(&screen, screen_frame, target_sources),
    }
}

/// Apply a layout preset (or full layout change) to the live scene. Outside a session
/// this is a plain scene reload + compositor push; during a session it is the D1
/// hot/warm swap with swap-on-ready semantics.
pub async fn apply_layout_live(
    state: &AppState,
    params: SceneConfigParams,
) -> Result<LiveLayoutApplyStatus> {
    apply_scene_live(
        state,
        params,
        MutationKind::LayoutSetPreset,
        None,
        "layout switch",
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
    apply_scene_live(
        state,
        params,
        MutationKind::SourceDeviceSwitch,
        None,
        "source device switch",
    )
    .await
}

async fn apply_scene_live(
    state: &AppState,
    params: SceneConfigParams,
    mutation_kind: MutationKind,
    target_sources_override: Option<&SourceSelection>,
    action_label: &'static str,
) -> Result<LiveLayoutApplyStatus> {
    if let Some(blocker) = preset_selection_blocker(&params) {
        bail!(blocker);
    }

    let target_sources = target_sources_override.unwrap_or(&params.sources);
    let scene = scene_from_capture_config(params.clone());
    let needs = required_scene_sources(&scene);
    let session_active = state.recording.lock().await.is_some();

    if !session_active {
        let status = commit_scene_with_layout(state, &scene, params.layout.clone(), None).await?;
        return Ok(LiveLayoutApplyStatus {
            applied: true,
            mode: "idle".to_string(),
            scene_revision: status.scene_revision,
            scene,
            message: None,
        });
    }

    let target_liveness = if mutation_kind == MutationKind::SourceDeviceSwitch {
        Some(target_sources)
    } else {
        target_sources_override
    };
    let live = source_liveness(state, target_liveness).await;
    match plan_live_swap(mutation_kind, needs, live) {
        ApplyMode::Hot => {
            let status =
                commit_scene_with_layout(state, &scene, params.layout.clone(), None).await?;
            Ok(LiveLayoutApplyStatus {
                applied: true,
                mode: "hot".to_string(),
                scene_revision: status.scene_revision,
                scene,
                message: None,
            })
        }
        ApplyMode::Warm => {
            let missing = missing_sources(needs, live);
            start_missing_sources(state, &params, &missing, action_label).await?;
            wait_for_sources_ready(state, needs, target_liveness, action_label).await?;
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
            let status = commit_scene_with_layout(
                state,
                &scene,
                params.layout.clone(),
                Some(message.clone()),
            )
            .await?;
            Ok(LiveLayoutApplyStatus {
                applied: true,
                mode: "warm".to_string(),
                scene_revision: status.scene_revision,
                scene,
                message: Some(message),
            })
        }
        ApplyMode::Cold => {
            // classify_mutation never returns Cold for LayoutSetPreset; keep the
            // honest failure anyway rather than silently doing nothing.
            bail!("Layout preset change classified cold during an active session.");
        }
    }
}

async fn start_missing_sources(
    state: &AppState,
    params: &SceneConfigParams,
    missing: &[&'static str],
    action_label: &'static str,
) -> Result<()> {
    for source in missing {
        match *source {
            "camera" => {
                let status = start_preview_camera(
                    state.clone(),
                    PreviewCameraStartParams {
                        sources: params.sources.clone(),
                        layout: params.layout.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                    },
                )
                .await;
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
                let status = start_preview_screen(
                    state.clone(),
                    PreviewScreenStartParams {
                        sources: params.sources.clone(),
                        video: params.video.clone().unwrap_or_else(fallback_video_settings),
                        protected_overlay_window_ids: params.protected_overlay_window_ids.clone(),
                    },
                )
                .await;
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

async fn wait_for_sources_ready(
    state: &AppState,
    needs: SceneSourceNeeds,
    target_sources: Option<&SourceSelection>,
    action_label: &'static str,
) -> Result<()> {
    let started = Instant::now();
    loop {
        let live = source_liveness(state, target_sources).await;
        if missing_sources(needs, live).is_empty() {
            return Ok(());
        }
        if started.elapsed() >= WARM_SOURCE_START_TIMEOUT {
            let still_missing = missing_sources(needs, live).join(" + ");
            bail!(
                "Live {action_label} blocked: {still_missing} produced no fresh frames within {}s. The previous layout is still live.",
                WARM_SOURCE_START_TIMEOUT.as_secs()
            );
        }
        sleep(WARM_SOURCE_POLL).await;
    }
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

    {
        let mut guard = state.scene.lock().await;
        *guard = scene.clone();
    }

    let (current_revision, active_screen) = {
        let compositor = state.compositor.lock().await;
        (compositor.status.scene_revision, compositor.active_screen())
    };
    let now_millis = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
    let revision = next_scene_revision(current_revision, now_millis);
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
    }

    #[test]
    fn stale_or_missing_frames_do_not_count_as_live() {
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
            frames_captured: 10,
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
            frames_captured: 10,
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
            frame_age_ms: 120,
        };

        assert!(target_screen_is_live(&screen, Some(frame), Some(&target)));
        assert!(!target_screen_status_is_live(&screen, Some(&target)));
    }
}
