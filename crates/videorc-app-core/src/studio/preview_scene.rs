//! The Studio's scene reload rule (plan 260 S1.6s, from `videorc-rust`'s
//! plan 220 S3.1b): the parts that stand alone, which L1's preview feed
//! (`videorc-preview`, S1.7b) reads. The renderer reloads the scene its
//! capture config describes (`scene.load_from_capture_config`) 250 ms after
//! a change, and only while nothing else holds the scene
//! (`shouldReloadSceneFromCaptureConfig`,
//! `apps/desktop/src/renderer/src/lib/layout-transaction-policy.ts`). A run
//! in the preview smoke mode (`VIDEORC_SMOKE_PREVIEW_MOTION=1`) commits the
//! test pattern and the synthetic preview camera in place of the picks
//! (`smokePreviewCompositorCaptureConfig`, `lib/capture.ts`).
//!
//! `preview_scene_request` and `studio_scene_params`, which read the Studio's
//! snapshot, capture config and settings, come with the Studio area (S1.6a).

use std::time::Duration;

use serde_json::Value;
use videorc_protocol::{
    LayoutPreset, LayoutSettings, RecordingState, SceneConfigParams, SourceSelection,
};

use super::settings::{CaptureConfig, StudioSettings};
use super::{Connection, StudioSnapshot};

/// The renderer's 250 ms between a change and the reload it runs.
pub const SCENE_RELOAD_DELAY: Duration = Duration::from_millis(250);

/// `smokePreviewCompositorCaptureConfig`'s camera.
pub const SMOKE_PREVIEW_CAMERA_ID: &str = "camera:synthetic-preview-smoke";

/// What `shouldReloadSceneFromCaptureConfig` reads.
#[derive(Debug, Clone, Copy)]
pub struct ReloadInput<'a> {
    pub connected: bool,
    /// The scene editor holds the scene (S3.3b); false until it lands.
    pub scene_edit_mode: bool,
    pub recording_state: &'a RecordingState,
    pub start_pending: bool,
    pub stop_pending: bool,
    /// Plan 212's performance check holds the session slot (S3.11a's Health
    /// action brings it); false until then.
    pub performance_check_running: bool,
}

/// `shouldReloadSceneFromCaptureConfig`: the capture config's scene may be
/// committed only while connected, outside the scene editor, with no start,
/// stop, check or session holding the scene.
pub fn should_reload_scene_from_capture_config(input: ReloadInput<'_>) -> bool {
    input.connected
        && !input.scene_edit_mode
        && !input.start_pending
        && !input.stop_pending
        && !input.performance_check_running
        && !matches!(
            input.recording_state,
            RecordingState::Starting
                | RecordingState::Recording
                | RecordingState::Streaming
                | RecordingState::Stopping
        )
}

/// `layoutPresetNeedsCamera`.
pub fn layout_preset_needs_camera(preset: &LayoutPreset) -> bool {
    matches!(
        preset,
        LayoutPreset::ScreenCamera
            | LayoutPreset::CameraOnly
            | LayoutPreset::SideBySide
            | LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
            | LayoutPreset::VerticalScreenCamera
            | LayoutPreset::VerticalCameraOnly
    )
}

/// `layoutPresetNeedsScreen`.
pub fn layout_preset_needs_screen(preset: &LayoutPreset) -> bool {
    matches!(
        preset,
        LayoutPreset::ScreenCamera
            | LayoutPreset::ScreenOnly
            | LayoutPreset::SideBySide
            | LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
            | LayoutPreset::VerticalScreenCamera
            | LayoutPreset::VerticalScreenOnly
    )
}

/// `smokePreviewCompositorCaptureConfig`'s sources: the test pattern, the
/// synthetic preview camera when the layout shows a camera, the microphone
/// as chosen; the screen and window picks never reach a smoke's preview.
pub fn smoke_preview_compositor_sources(
    sources: &SourceSelection,
    preset: &LayoutPreset,
) -> SourceSelection {
    SourceSelection {
        screen_id: None,
        window_id: None,
        camera_id: layout_preset_needs_camera(preset).then(|| SMOKE_PREVIEW_CAMERA_ID.to_string()),
        microphone_id: sources.microphone_id.clone(),
        test_pattern: true,
    }
}

/// `cameraLookLayout`: the chosen camera's look from the settings
/// (`settings.cameraLooks`) replaces whatever look the layout held; no look
/// for that camera is the neutral one. Electron's `cameraOutputLayout` also
/// puts the camera's background (plan 258) and, after the D4 migration, its
/// key on the layout: [`camera_output_layout`] adds those on top.
pub fn camera_look_layout(
    layout: &LayoutSettings,
    camera_id: Option<&str>,
    studio: &StudioSettings,
) -> LayoutSettings {
    let mut layout = layout.clone();
    layout.camera_look = studio
        .camera_look(camera_id)
        .and_then(|look| serde_json::from_value(look).ok())
        .unwrap_or_default();
    layout
}

/// `cameraOutputLayout` on the typed layout: the camera's look
/// ([`camera_look_layout`]), then its background and, once the D4
/// migration settled, its key, through the output boundary
/// ([`super::camera_background::camera_output_layout`]). The session start
/// and the Preview's idle reload both send this.
pub fn camera_output_layout(
    layout: &LayoutSettings,
    camera_id: Option<&str>,
    studio: &StudioSettings,
) -> LayoutSettings {
    let looked = camera_look_layout(layout, camera_id, studio);
    serde_json::to_value(&looked)
        .ok()
        .map(|layout| super::camera_background::camera_output_layout(&layout, camera_id, studio))
        .and_then(|layout| serde_json::from_value(layout).ok())
        .unwrap_or(looked)
}

/// `reloadSceneFromCaptureConfig`'s params: the capture config's sources,
/// layout (through the camera's output boundary, as Electron's
/// `captureConfig.layout` is) and video; the smoke mode's sources in a
/// preview smoke run. No background: [`preview_scene_request`] adds the
/// working scene's.
pub fn studio_scene_params(
    capture: &CaptureConfig,
    studio: &StudioSettings,
    smoke_preview: bool,
) -> SceneConfigParams {
    let layout = camera_output_layout(
        &capture.layout,
        capture.sources.camera_id.as_deref(),
        studio,
    );
    let sources = if smoke_preview {
        smoke_preview_compositor_sources(&capture.sources, &layout.layout_preset)
    } else {
        capture.sources.clone()
    };
    SceneConfigParams {
        sources,
        layout,
        video: Some(capture.video.clone()),
        background: None,
        protected_overlay_window_ids: Vec::new(),
        transition_ms: None,
    }
}

/// What the preview feed commits now: the Studio's scene while
/// [`should_reload_scene_from_capture_config`] holds and the settings have
/// loaded (a scene from the defaults would flash before the stored one),
/// `None` otherwise. The scene editor and the performance check hold the
/// scene once they land (S1.6b, and the check with Health). It wears the
/// working background, as Electron's `loadScene` sent `activeSceneBackground`:
/// without it every reload (at launch, 250 ms after each Stop) committed the
/// scene with no background, and a live background and its stage margin left
/// the Preview until the next Record or scene switch (owner report
/// 2026-11-26).
pub fn preview_scene_request(
    snapshot: &StudioSnapshot,
    smoke_preview: bool,
) -> Option<SceneConfigParams> {
    let allowed = snapshot.settings.hydrated
        && should_reload_scene_from_capture_config(ReloadInput {
            connected: matches!(snapshot.connection, Connection::Connected { .. }),
            scene_edit_mode: false,
            recording_state: &snapshot.session.status.state,
            start_pending: snapshot.session.start_pending,
            stop_pending: snapshot.session.stop_pending,
            performance_check_running: snapshot.performance.hold,
        });
    allowed.then(|| {
        let mut params = studio_scene_params(
            &snapshot.settings.capture,
            &snapshot.settings.studio,
            smoke_preview,
        );
        params.background = snapshot
            .scenes
            .working_background
            .as_ref()
            .and_then(|background| serde_json::from_value(background.clone()).ok());
        params
    })
}

/// A preview reload as `loadScene(config, config.sources)` keeps it: the
/// request, and the capture config's own layout and sources it was made
/// from, which are what its commit confirms as the working setup (D11).
/// The request's sources are not: they name no screen or camera, stand for
/// an absent id with `null` (which `normalizeSceneVisual` refuses as
/// "Invalid source identity"), and in the preview smoke mode are the test
/// pattern in place of the picks.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewReload {
    pub request: SceneConfigParams,
    pub layout: Value,
    pub sources: Value,
}

impl PreviewReload {
    /// The layout and sources a commit of `committed` confirms, or `None`
    /// when the feed committed another request than this one (the newer
    /// reload confirms its own).
    pub fn confirms(&self, committed: &SceneConfigParams) -> Option<(&Value, &Value)> {
        (committed.sources == self.request.sources && committed.layout == self.request.layout)
            .then_some((&self.layout, &self.sources))
    }
}

/// [`preview_scene_request`] with the capture config it reads.
pub fn preview_scene_reload(
    snapshot: &StudioSnapshot,
    smoke_preview: bool,
) -> Option<PreviewReload> {
    preview_scene_request(snapshot, smoke_preview).map(|request| PreviewReload {
        request,
        layout: snapshot.settings.capture_doc["layout"].clone(),
        sources: snapshot.settings.capture_doc["sources"].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(state: &RecordingState) -> ReloadInput<'_> {
        ReloadInput {
            connected: true,
            scene_edit_mode: false,
            recording_state: state,
            start_pending: false,
            stop_pending: false,
            performance_check_running: false,
        }
    }

    /// `layout-transaction-policy.test.ts`'s reload cases.
    #[test]
    fn the_scene_reloads_only_while_nothing_holds_it() {
        assert!(should_reload_scene_from_capture_config(input(
            &RecordingState::Idle
        )));
        assert!(should_reload_scene_from_capture_config(input(
            &RecordingState::Failed
        )));
        for state in [
            RecordingState::Starting,
            RecordingState::Recording,
            RecordingState::Streaming,
            RecordingState::Stopping,
        ] {
            assert!(!should_reload_scene_from_capture_config(input(&state)));
        }
        let base = input(&RecordingState::Idle);
        for blocked in [
            ReloadInput {
                connected: false,
                ..base
            },
            ReloadInput {
                scene_edit_mode: true,
                ..base
            },
            ReloadInput {
                start_pending: true,
                ..base
            },
            ReloadInput {
                stop_pending: true,
                ..base
            },
            ReloadInput {
                performance_check_running: true,
                ..base
            },
        ] {
            assert!(!should_reload_scene_from_capture_config(blocked));
        }
    }

    /// `capture.test.ts`'s `smokePreviewCompositorCaptureConfig` cases.
    #[test]
    fn a_preview_smoke_shows_the_test_pattern_and_the_synthetic_camera() {
        let picks = SourceSelection {
            screen_id: Some("screen:1".into()),
            window_id: Some("window:2".into()),
            camera_id: Some("camera:real".into()),
            microphone_id: Some("mic:1".into()),
            test_pattern: false,
        };
        let with_camera = smoke_preview_compositor_sources(&picks, &LayoutPreset::ScreenCamera);
        assert_eq!(
            with_camera.camera_id.as_deref(),
            Some(SMOKE_PREVIEW_CAMERA_ID)
        );
        assert_eq!(with_camera.microphone_id.as_deref(), Some("mic:1"));
        assert!(with_camera.test_pattern);
        assert!(with_camera.screen_id.is_none() && with_camera.window_id.is_none());
        let screen_only = smoke_preview_compositor_sources(&picks, &LayoutPreset::ScreenOnly);
        assert!(screen_only.camera_id.is_none());
        assert!(screen_only.test_pattern);
    }

    #[test]
    fn every_preset_says_what_it_needs() {
        use LayoutPreset::*;
        for preset in [
            ScreenCamera,
            SideBySide,
            VerticalCameraTop,
            VerticalCameraBottom,
            VerticalSplit,
            VerticalScreenCamera,
        ] {
            assert!(layout_preset_needs_camera(&preset), "{preset:?}");
            assert!(layout_preset_needs_screen(&preset), "{preset:?}");
        }
        for preset in [CameraOnly, VerticalCameraOnly] {
            assert!(layout_preset_needs_camera(&preset));
            assert!(!layout_preset_needs_screen(&preset));
        }
        for preset in [ScreenOnly, VerticalScreenOnly] {
            assert!(!layout_preset_needs_camera(&preset));
            assert!(layout_preset_needs_screen(&preset));
        }
    }

    /// Review of #1813: the Preview's idle reload goes through the camera's
    /// output boundary, as Electron's `captureConfig.layout` does: the
    /// camera's background, and its key once the D4 migration settled.
    #[test]
    fn the_idle_reload_carries_the_cameras_background_and_key() {
        let mut capture = CaptureConfig::default();
        capture.sources.camera_id = Some("camera-a".into());
        let blue = serde_json::json!({"mode": "blue", "blurPct": 70, "edges": "balanced"});
        let studio = StudioSettings::load(Some(&serde_json::Value::String(
            serde_json::json!({
                "cameraBackgrounds": {"camera-a": blue},
                "cameraBackgroundMigration": 1
            })
            .to_string(),
        )));
        let params = studio_scene_params(&capture, &studio, false);
        assert!(params.layout.camera_background.is_some());
        assert!(params.layout.camera_chroma_key_enabled);
        assert_eq!(params.layout.camera_chroma_key_color, "#0000FF");
    }

    /// Owner report 2026-11-26: the idle reload (at launch, 250 ms after a
    /// Stop) committed the scene with no background, so a live background
    /// and its stage margin left the Preview. It wears the working
    /// background, as Electron's `loadScene` did; with none it sends none.
    #[test]
    fn the_idle_reload_wears_the_working_background() {
        let mut snapshot = super::super::test_support::ready_snapshot();
        let request = preview_scene_request(&snapshot, false).expect("idle reloads");
        assert_eq!(request.background, None);
        snapshot.scenes.working_background = Some(serde_json::json!({
            "assetId": "live-silk-satin",
            "managedAssetPath": "videorc-asset://background/live-silk-satin.webp",
            "fit": "fill",
            "scale": 100,
            "offsetX": 0,
            "offsetY": 0,
            "blurPx": 0,
            "dimPercent": 0,
            "saturationPercent": 100,
            "vignettePercent": 0,
            "visibilityPercent": 20,
            "live": {"id": "silk", "look": "satin", "motion": "calm"}
        }));
        let request = preview_scene_request(&snapshot, false).expect("idle reloads");
        let background = request.background.expect("the working background");
        assert_eq!(background.asset_id, "live-silk-satin");
        assert_eq!(background.visibility_percent, 20.0);
        assert!(background.live.is_some(), "the live spec rides along");
    }

    /// `loadScene(config, config.sources)`: a reload confirms the capture
    /// config's own sources, which read as a scene visual. The request's
    /// protocol sources don't (a `null` id is "Invalid source identity"),
    /// so confirming those saved nothing and the scene on stream never took
    /// a screen pick such as the test pattern (L6's layout-source-loop red).
    #[test]
    fn a_reload_confirms_the_capture_configs_sources_not_the_requests() {
        use crate::scenes::model::{normalize_scene_visual, visual_sources};
        use serde_json::json;

        let doc = json!({
            "layout": {"layoutPreset": "screen-camera"},
            "sources": {"cameraId": "camera:1", "cameraName": "Camera", "testPattern": true},
        });
        let mut capture = CaptureConfig::default();
        capture.sources.camera_id = Some("camera:1".into());
        capture.sources.test_pattern = true;
        let request = studio_scene_params(&capture, &StudioSettings::default(), false);
        let reload = PreviewReload {
            request: request.clone(),
            layout: doc["layout"].clone(),
            sources: doc["sources"].clone(),
        };

        let (layout, sources) = reload.confirms(&request).expect("its own commit");
        let visual = normalize_scene_visual(&json!({
            "layout": layout,
            "sources": visual_sources(sources),
            "background": null,
        }))
        .expect("the capture config's sources read");
        assert_eq!(visual["sources"]["testPattern"], json!(true));
        assert_eq!(visual["sources"]["cameraName"], json!("Camera"));

        let protocol = serde_json::to_value(&request.sources).unwrap();
        assert_eq!(
            normalize_scene_visual(&json!({
                "layout": layout,
                "sources": visual_sources(&protocol),
                "background": null,
            })),
            Err("Invalid source identity")
        );

        // The feed committed another request: the newer reload confirms its own.
        let mut other = request.clone();
        other.sources.test_pattern = false;
        assert_eq!(reload.confirms(&other), None);
        let mut moved = request;
        moved.layout.layout_preset = LayoutPreset::CameraOnly;
        assert_eq!(reload.confirms(&moved), None);
    }
}
