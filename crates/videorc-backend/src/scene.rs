use std::path::Path;

use crate::protocol::{
    LayoutPreset, Scene, SceneConfigParams, SceneOutput, SceneOutputKind, SceneSource,
    SceneSourceKind, SceneSourceOrderParams, SceneSourceParams, SceneSourceVisibilityParams,
    SceneTransform, SceneTransformPatch, SceneTransformUpdateParams, SideBySideCameraSide,
    SourceSelection,
};
use crate::scene_geometry::{
    preset_camera_transform, resolved_camera_transform, side_by_side_fractions,
};

#[cfg(test)]
use crate::scene_geometry::{camera_box_size, crop_for_zoom};

const DEFAULT_SCENE_ID: &str = "scene:default";
const BASE_SOURCE_ID: &str = "source:base";
const CAMERA_SOURCE_ID: &str = "source:camera";
const TEST_PATTERN_SOURCE_ID: &str = "source:test-pattern";
const SNAP_THRESHOLD: f64 = 0.015;

pub fn default_scene() -> Scene {
    Scene {
        id: DEFAULT_SCENE_ID.to_string(),
        name: "Default Scene".to_string(),
        sources: Vec::new(),
        outputs: vec![SceneOutput {
            id: "output:preview".to_string(),
            kind: SceneOutputKind::Preview,
            width: 1280,
            height: 720,
            fps: 30,
        }],
        background: None,
    }
}

pub fn validate_scene_background(scene: &Scene) -> Result<(), String> {
    let Some(background) = scene.background.as_ref() else {
        return Ok(());
    };

    let path = background.managed_asset_path.trim();
    crate::resource_authority::validate_asset_id(&background.asset_id)
        .map_err(|error| error.to_string())?;
    if path.is_empty() {
        return Err(format!(
            "Scene background {} has no managed asset path. Re-apply or replace the background before recording.",
            background.asset_id
        ));
    }

    let image_path = Path::new(path);
    if !image_path.is_file() {
        return Err(format!(
            "Scene background {} file is missing: {}. Re-apply or replace the background before recording.",
            background.asset_id, path
        ));
    }

    crate::resource_authority::validate_managed_background_path(image_path)
        .map_err(|error| error.to_string())?;

    image::open(image_path).map_err(|error| {
        format!(
            "Scene background {} could not be read from {}: {}. Replace the background before recording.",
            background.asset_id, path, error
        )
    })?;

    Ok(())
}

/// Fit the preview output inside the preview budget box (1280x720) while
/// PRESERVING the canvas aspect. The old independent `min()` clamps distorted
/// any non-16:9 canvas — a portrait 1080x1920 became a 1080x720 (3:2) preview
/// surface inside a correctly 9:16 CSS slot (vertical scene plan S2).
/// Dimensions are rounded down to even values for the YUV conversion paths.
fn preview_output_dimensions(output_width: u32, output_height: u32) -> (u32, u32) {
    const MAX_WIDTH: u32 = 1280;
    const MAX_HEIGHT: u32 = 720;
    let even = |value: u32| (value.max(2) / 2) * 2;
    if output_width <= MAX_WIDTH && output_height <= MAX_HEIGHT {
        return (even(output_width), even(output_height));
    }
    let scale = (f64::from(MAX_WIDTH) / f64::from(output_width.max(1)))
        .min(f64::from(MAX_HEIGHT) / f64::from(output_height.max(1)));
    let width = (f64::from(output_width) * scale).round() as u32;
    let height = (f64::from(output_height) * scale).round() as u32;
    (even(width), even(height))
}

pub fn scene_from_capture_config(params: SceneConfigParams) -> Scene {
    let (output_width, output_height, fps) = params
        .video
        .as_ref()
        .map(|video| (video.width, video.height, video.fps))
        .unwrap_or((1280, 720, 30));
    let mut scene = Scene {
        id: DEFAULT_SCENE_ID.to_string(),
        name: "Default Scene".to_string(),
        sources: Vec::new(),
        outputs: vec![
            {
                let (preview_width, preview_height) =
                    preview_output_dimensions(output_width, output_height);
                SceneOutput {
                    id: "output:preview".to_string(),
                    kind: SceneOutputKind::Preview,
                    width: preview_width,
                    height: preview_height,
                    fps: fps.min(30),
                }
            },
            SceneOutput {
                id: "output:recording".to_string(),
                kind: SceneOutputKind::Recording,
                width: output_width,
                height: output_height,
                fps,
            },
        ],
        background: params.background.clone(),
    };

    match params.layout.layout_preset {
        LayoutPreset::CameraOnly => {
            // The camera is the full-frame source: no screen base, no overlay.
            if let Some(camera_id) = params.sources.camera_id.clone() {
                let mut camera =
                    camera_source(camera_id, &params.layout, output_width, output_height);
                camera.transform = full_frame_transform();
                camera.default_transform = full_frame_transform();
                scene.sources.push(camera);
            } else {
                scene.sources.push(base_source(&params.sources));
            }
        }
        LayoutPreset::ScreenOnly | LayoutPreset::VerticalScreenOnly => {
            // Screen-only never composites the camera; the vertical variant is
            // the same full-frame contain on the portrait canvas.
            scene.sources.push(base_source(&params.sources));
        }
        LayoutPreset::SideBySide => {
            // Screen and camera occupy fixed side-by-side regions (screen larger).
            let (screen_fraction, camera_fraction) =
                side_by_side_fractions(params.layout.side_by_side_split);
            let camera_right = matches!(
                params.layout.side_by_side_camera_side,
                SideBySideCameraSide::Right
            );
            let (screen_x, camera_x) = if camera_right {
                (0.0, screen_fraction)
            } else {
                (camera_fraction, 0.0)
            };

            let mut base = base_source(&params.sources);
            base.transform = region_transform(screen_x, screen_fraction);
            base.default_transform = base.transform.clone();
            scene.sources.push(base);

            if let Some(camera_id) = params.sources.camera_id.clone() {
                let mut camera =
                    camera_source(camera_id, &params.layout, output_width, output_height);
                camera.transform = region_transform(camera_x, camera_fraction);
                camera.default_transform = camera.transform.clone();
                scene.sources.push(camera);
            }
        }
        // Stacked portrait arrangements (9:16 short-form). Fractions are
        // canvas-normalized so they stay sane even on a landscape canvas.
        LayoutPreset::VerticalCameraTop => {
            let bands = VerticalStackBands {
                camera_y: 0.0,
                camera_height: VERTICAL_CAMERA_BAND,
            };
            push_vertical_stack(&mut scene, &params, output_width, output_height, bands);
        }
        LayoutPreset::VerticalCameraBottom => {
            let bands = VerticalStackBands {
                camera_y: 1.0 - VERTICAL_CAMERA_BAND,
                camera_height: VERTICAL_CAMERA_BAND,
            };
            push_vertical_stack(&mut scene, &params, output_width, output_height, bands);
        }
        LayoutPreset::VerticalSplit => {
            let bands = VerticalStackBands {
                camera_y: 0.5,
                camera_height: 0.5,
            };
            push_vertical_stack(&mut scene, &params, output_width, output_height, bands);
        }
        // Explicit arm (no wildcard): a new preset must state its composition
        // here or fail to compile — the old `_ =>` silently composited unknown
        // presets as screen-camera. The vertical variant is the identical
        // arrangement on the portrait canvas: screen full-frame contain,
        // camera as the user's corner/size/shape inset bubble.
        LayoutPreset::ScreenCamera | LayoutPreset::VerticalScreenCamera => {
            scene.sources.push(base_source(&params.sources));
            if let Some(camera_id) = params.sources.camera_id.clone() {
                scene.sources.push(camera_source(
                    camera_id,
                    &params.layout,
                    output_width,
                    output_height,
                ));
            }
        }
    }

    scene
}

pub fn update_source_transform(
    scene: &mut Scene,
    params: SceneTransformUpdateParams,
) -> Result<Scene, String> {
    let source = find_source_mut(scene, &params.source_id)?;
    source.transform = sanitize_transform(apply_transform_patch(
        source.transform.clone(),
        params.transform,
    ));
    Ok(scene.clone())
}

pub fn reset_source_transform(
    scene: &mut Scene,
    params: SceneSourceParams,
) -> Result<Scene, String> {
    let source = find_source_mut(scene, &params.source_id)?;
    source.transform = source.default_transform.clone();
    Ok(scene.clone())
}

pub fn update_source_visibility(
    scene: &mut Scene,
    params: SceneSourceVisibilityParams,
) -> Result<Scene, String> {
    let source = find_source_mut(scene, &params.source_id)?;
    source.visible = params.visible;
    Ok(scene.clone())
}

pub fn reorder_sources(scene: &mut Scene, params: SceneSourceOrderParams) -> Result<Scene, String> {
    if params.source_ids.len() != scene.sources.len() {
        return Err("sourceIds must include every source exactly once".to_string());
    }

    let mut reordered = Vec::with_capacity(scene.sources.len());
    for source_id in params.source_ids {
        let Some(index) = scene
            .sources
            .iter()
            .position(|source| source.id == source_id)
        else {
            return Err(format!("Unknown source id: {source_id}"));
        };
        reordered.push(scene.sources.remove(index));
    }
    scene.sources = reordered;
    Ok(scene.clone())
}

pub fn nudge_source(
    scene: &mut Scene,
    source_id: &str,
    direction_x: f64,
    direction_y: f64,
    large: bool,
) -> Result<Scene, String> {
    let step = if large { 0.025 } else { 0.005 };
    let source = find_source_mut(scene, source_id)?;
    // No snapping on nudge: the snap magnet (threshold 0.015) is a DRAG
    // convenience, but it swallowed every small nudge step (0.005) taken from
    // a snapped edge/center — each arrow click moved and instantly snapped
    // back, a permanent no-op. Arrow nudges are precision intent.
    source.transform = sanitize_transform_unsnapped(SceneTransform {
        x: source.transform.x + direction_x * step,
        y: source.transform.y + direction_y * step,
        ..source.transform.clone()
    });
    Ok(scene.clone())
}

pub fn snap_transform(mut transform: SceneTransform) -> SceneTransform {
    transform.x = snap_position(transform.x, transform.width);
    transform.y = snap_position(transform.y, transform.height);
    transform
}

fn base_source(sources: &SourceSelection) -> SceneSource {
    let (id, name, kind, device_id) = if let Some(window_id) = sources.window_id.clone() {
        (
            BASE_SOURCE_ID,
            "Window capture",
            SceneSourceKind::Window,
            Some(window_id),
        )
    } else if let Some(screen_id) = sources.screen_id.clone() {
        (
            BASE_SOURCE_ID,
            "Screen capture",
            SceneSourceKind::Screen,
            Some(screen_id),
        )
    } else if sources.test_pattern {
        (
            TEST_PATTERN_SOURCE_ID,
            "Test pattern",
            SceneSourceKind::TestPattern,
            None,
        )
    } else {
        (
            BASE_SOURCE_ID,
            "Screen capture",
            SceneSourceKind::Screen,
            None,
        )
    };
    let transform = full_frame_transform();

    SceneSource {
        id: id.to_string(),
        name: name.to_string(),
        kind,
        device_id,
        transform: transform.clone(),
        default_transform: transform,
        visible: true,
        locked: false,
    }
}

fn camera_source(
    camera_id: String,
    layout: &crate::protocol::LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneSource {
    let default_transform = preset_camera_transform(layout, output_width, output_height);
    // A dragged camera (custom mode) overrides position only; size/crop and the
    // default_transform stay tied to the corner/size preset so Reset restores it.
    let transform = resolved_camera_transform(layout, output_width, output_height);
    SceneSource {
        id: CAMERA_SOURCE_ID.to_string(),
        name: "Camera".to_string(),
        kind: SceneSourceKind::Camera,
        device_id: Some(camera_id),
        transform,
        default_transform,
        visible: true,
        locked: false,
    }
}

fn full_frame_transform() -> SceneTransform {
    SceneTransform {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

fn region_transform(x: f64, width: f64) -> SceneTransform {
    SceneTransform {
        x,
        y: 0.0,
        width,
        height: 1.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

/// Camera band height for the stacked vertical (9:16) presets. Owner taste
/// review may tune this (0.35-0.45); Split ignores it and shares evenly.
/// Shared with the legacy FFmpeg path (recording.rs) so the two render paths
/// cannot drift apart.
pub(crate) const VERTICAL_CAMERA_BAND: f64 = 0.4;

/// Camera band geometry for a stacked vertical preset; the screen takes the
/// complementary band.
struct VerticalStackBands {
    camera_y: f64,
    camera_height: f64,
}

/// Push the stacked vertical arrangement: camera band at the given geometry,
/// screen in the complementary band. Like side-by-side regions, the camera
/// band keeps no bubble mask and the screen band CONTAINS (nothing on the
/// user's screen may be cropped away); the camera honors the user's Fit/Fill.
fn push_vertical_stack(
    scene: &mut Scene,
    params: &SceneConfigParams,
    output_width: u32,
    output_height: u32,
    bands: VerticalStackBands,
) {
    let (screen_y, screen_height) = if bands.camera_y == 0.0 {
        (bands.camera_height, 1.0 - bands.camera_height)
    } else {
        (0.0, bands.camera_y)
    };

    let mut base = base_source(&params.sources);
    base.transform = vertical_band_transform(screen_y, screen_height);
    base.default_transform = base.transform.clone();
    scene.sources.push(base);

    if let Some(camera_id) = params.sources.camera_id.clone() {
        let mut camera = camera_source(camera_id, &params.layout, output_width, output_height);
        camera.transform = vertical_band_transform(bands.camera_y, bands.camera_height);
        camera.default_transform = camera.transform.clone();
        scene.sources.push(camera);
    }
}

fn vertical_band_transform(y: f64, height: f64) -> SceneTransform {
    SceneTransform {
        x: 0.0,
        y,
        width: 1.0,
        height,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

fn apply_transform_patch(
    mut transform: SceneTransform,
    patch: SceneTransformPatch,
) -> SceneTransform {
    if let Some(value) = patch.x {
        transform.x = value;
    }
    if let Some(value) = patch.y {
        transform.y = value;
    }
    if let Some(value) = patch.width {
        transform.width = value;
    }
    if let Some(value) = patch.height {
        transform.height = value;
    }
    if let Some(value) = patch.crop_left {
        transform.crop_left = value;
    }
    if let Some(value) = patch.crop_top {
        transform.crop_top = value;
    }
    if let Some(value) = patch.crop_right {
        transform.crop_right = value;
    }
    if let Some(value) = patch.crop_bottom {
        transform.crop_bottom = value;
    }
    transform
}

fn sanitize_transform(transform: SceneTransform) -> SceneTransform {
    snap_transform(sanitize_transform_unsnapped(transform))
}

// Clamp + clean without the edge/center snap — for precision operations
// (arrow nudges) where the snap magnet must not undo the movement.
fn sanitize_transform_unsnapped(transform: SceneTransform) -> SceneTransform {
    let (crop_left, crop_right) = normalize_crop_pair(
        clean_number(transform.crop_left),
        clean_number(transform.crop_right),
    );
    let (crop_top, crop_bottom) = normalize_crop_pair(
        clean_number(transform.crop_top),
        clean_number(transform.crop_bottom),
    );

    SceneTransform {
        x: clean_number(transform.x).clamp(-1.0, 2.0),
        y: clean_number(transform.y).clamp(-1.0, 2.0),
        width: clean_number(transform.width).clamp(0.0, 2.0),
        height: clean_number(transform.height).clamp(0.0, 2.0),
        crop_left,
        crop_top,
        crop_right,
        crop_bottom,
    }
}

fn normalize_crop_pair(first: f64, second: f64) -> (f64, f64) {
    let mut first = first.clamp(0.0, 0.95);
    let mut second = second.clamp(0.0, 0.95);
    let total = first + second;
    if total > 0.95 {
        let scale = 0.95 / total;
        first *= scale;
        second *= scale;
    }
    (first, second)
}

fn snap_position(position: f64, size: f64) -> f64 {
    if position.abs() <= SNAP_THRESHOLD {
        0.0
    } else if ((position + size) - 1.0).abs() <= SNAP_THRESHOLD {
        1.0 - size
    } else if ((position + (size / 2.0)) - 0.5).abs() <= SNAP_THRESHOLD {
        0.5 - (size / 2.0)
    } else {
        position
    }
}

fn clean_number(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

fn find_source_mut<'a>(
    scene: &'a mut Scene,
    source_id: &str,
) -> Result<&'a mut SceneSource, String> {
    scene
        .sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or_else(|| format!("Unknown source id: {source_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        BackgroundFit, CameraAspect, CameraCorner, CameraFit, CameraShape, CameraSize,
        CameraTransform, CameraTransformMode, EffectiveSceneBackground, LayoutPreset,
        LayoutSettings, SideBySideSplit, SourceSelection,
    };

    #[test]
    fn vertical_camera_top_stacks_camera_band_over_contained_screen() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::VerticalCameraTop;
        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 2);
        let screen = &scene.sources[0];
        let camera = &scene.sources[1];

        // Screen fills the lower band edge-to-edge.
        assert_eq!(screen.transform.x, 0.0);
        assert_eq!(screen.transform.y, VERTICAL_CAMERA_BAND);
        assert_eq!(screen.transform.width, 1.0);
        assert_eq!(screen.transform.height, 1.0 - VERTICAL_CAMERA_BAND);

        // Camera band sits on top, full width.
        assert_eq!(camera.transform.x, 0.0);
        assert_eq!(camera.transform.y, 0.0);
        assert_eq!(camera.transform.width, 1.0);
        assert_eq!(camera.transform.height, VERTICAL_CAMERA_BAND);
        assert_eq!(camera.default_transform, camera.transform);
    }

    #[test]
    fn vertical_camera_bottom_mirrors_the_stack() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::VerticalCameraBottom;
        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 2);
        let screen = &scene.sources[0];
        let camera = &scene.sources[1];

        // Screen fills the upper band edge-to-edge.
        assert_eq!(screen.transform.y, 0.0);
        assert_eq!(screen.transform.width, 1.0);
        assert_eq!(screen.transform.height, 1.0 - VERTICAL_CAMERA_BAND);

        // Camera band sits at the bottom, full width.
        assert_eq!(camera.transform.y, 1.0 - VERTICAL_CAMERA_BAND);
        assert_eq!(camera.transform.width, 1.0);
        assert_eq!(camera.transform.height, VERTICAL_CAMERA_BAND);
        assert_eq!(camera.default_transform, camera.transform);
    }

    #[test]
    fn vertical_split_shares_the_canvas_evenly_screen_on_top() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::VerticalSplit;
        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 2);
        let screen = &scene.sources[0];
        let camera = &scene.sources[1];

        assert_eq!(screen.transform.y, 0.0);
        assert_eq!(screen.transform.height, 0.5);
        assert_eq!(camera.transform.y, 0.5);
        assert_eq!(camera.transform.height, 0.5);
        assert_eq!(screen.transform.width, 1.0);
        assert_eq!(camera.transform.width, 1.0);
    }

    #[test]
    fn vertical_screen_camera_composes_exactly_like_screen_camera() {
        // The inset scene delegates: full-frame screen + the user's camera
        // bubble (corner/size/shape/drag) — only the canvas differs.
        let mut landscape = base_params();
        landscape.layout.layout_preset = LayoutPreset::ScreenCamera;
        let mut portrait = base_params();
        portrait.layout.layout_preset = LayoutPreset::VerticalScreenCamera;

        let landscape_scene = scene_from_capture_config(landscape);
        let portrait_scene = scene_from_capture_config(portrait);

        assert_eq!(landscape_scene.sources, portrait_scene.sources);
    }

    #[test]
    fn vertical_screen_only_composes_exactly_like_screen_only() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::VerticalScreenOnly;
        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 1);
        assert_eq!(scene.sources[0].transform, full_frame_transform());
    }

    #[test]
    fn vertical_stack_without_camera_keeps_the_screen_band() {
        // Transient state only — the selection blocker refuses these presets
        // without a camera; the band stays consistent with side-by-side.
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::VerticalCameraTop;
        params.sources.camera_id = None;
        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 1);
        assert_eq!(scene.sources[0].transform.y, VERTICAL_CAMERA_BAND);
    }

    #[test]
    fn preview_output_preserves_canvas_aspect_inside_the_budget_box() {
        // Standard landscape canvases keep their historical preview sizes.
        assert_eq!(preview_output_dimensions(1920, 1080), (1280, 720));
        assert_eq!(preview_output_dimensions(3840, 2160), (1280, 720));
        assert_eq!(preview_output_dimensions(1280, 720), (1280, 720));
        // Portrait no longer distorts: 1080x1920 fits height-bound at 9:16.
        assert_eq!(preview_output_dimensions(1080, 1920), (404, 720));
        // Non-16:9 landscape scales by the binding axis instead of squashing.
        assert_eq!(preview_output_dimensions(1500, 1000), (1080, 720));
        // Small canvases pass through (evened), never upscaled.
        assert_eq!(preview_output_dimensions(640, 360), (640, 360));
        assert_eq!(preview_output_dimensions(3, 3), (2, 2));
    }

    // Camera shape/aspect feature (2026-07-06): the box aspect is decided HERE
    // once; every render path center-crops into it via Fill. Portrait = 3:4,
    // square = 1:1, source keeps the per-shape default; circle has no aspect.
    #[test]
    fn camera_box_size_follows_shape_and_aspect() {
        let medium = CameraSize::Medium;

        assert_eq!(
            camera_box_size(&medium, &CameraShape::Rectangle, &CameraAspect::Source),
            (360, 203)
        );
        assert_eq!(
            camera_box_size(&medium, &CameraShape::Rounded, &CameraAspect::Source),
            (360, 203)
        );
        assert_eq!(
            camera_box_size(&medium, &CameraShape::Rounded, &CameraAspect::Square),
            (360, 360)
        );
        assert_eq!(
            camera_box_size(&medium, &CameraShape::Rectangle, &CameraAspect::Portrait),
            (360, 480)
        );
        // Circle ignores aspect — a circle has no aspect.
        assert_eq!(
            camera_box_size(&medium, &CameraShape::Circle, &CameraAspect::Portrait),
            (360, 360)
        );
    }

    // Old persisted layouts predate cameraCornerRadiusPct/cameraAspect — they
    // must deserialize to the defaults, never fail.
    #[test]
    fn layout_settings_without_new_fields_deserialize_to_defaults() {
        let old_json = serde_json::json!({
            "layoutPreset": "screen-camera",
            "cameraCorner": "bottom-right",
            "cameraSize": "medium",
            "cameraShape": "rectangle",
            "cameraMargin": 32
        });
        let layout: LayoutSettings = serde_json::from_value(old_json).expect("old layout parses");

        assert_eq!(layout.camera_corner_radius_pct, 12);
        assert_eq!(layout.camera_aspect, crate::protocol::CameraAspect::Source);
    }

    fn base_params() -> SceneConfigParams {
        SceneConfigParams {
            sources: SourceSelection {
                screen_id: Some("screen:screencapturekit:1".to_string()),
                window_id: None,
                camera_id: Some("camera:avfoundation-native:abc123".to_string()),
                microphone_id: None,
                test_pattern: false,
            },
            layout: LayoutSettings {
                layout_preset: LayoutPreset::ScreenCamera,
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
            },
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
        }
    }

    fn test_background(path: impl Into<String>) -> EffectiveSceneBackground {
        EffectiveSceneBackground {
            asset_id: "asset-1".to_string(),
            managed_asset_path: path.into(),
            fit: BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
        }
    }

    fn temp_png_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "videorc-scene-{name}-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn custom_transform_moves_camera_without_touching_default() {
        let mut params = base_params();
        params.layout.camera_transform_mode = CameraTransformMode::Custom;
        params.layout.camera_transform = Some(CameraTransform {
            x: 0.4,
            y: 0.3,
            width: 0.25,
            height: 0.25,
        });

        let scene = scene_from_capture_config(params);
        let camera = scene
            .sources
            .iter()
            .find(|source| source.kind == SceneSourceKind::Camera)
            .expect("camera source present");

        assert!((camera.transform.x - 0.4).abs() < 1e-6);
        assert!((camera.transform.y - 0.3).abs() < 1e-6);
        // default_transform stays the bottom-right corner preset so Reset restores it.
        assert!(camera.default_transform.x > 0.6);
        assert!(camera.default_transform.y > 0.6);
        assert_ne!(camera.default_transform.x, camera.transform.x);
    }

    #[test]
    fn screen_only_scene_has_no_camera_source() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::ScreenOnly;

        let scene = scene_from_capture_config(params);

        assert!(
            scene
                .sources
                .iter()
                .all(|source| source.kind != SceneSourceKind::Camera)
        );
    }

    #[test]
    fn camera_only_scene_is_full_frame_camera() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::CameraOnly;

        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources.len(), 1);
        let camera = &scene.sources[0];
        assert_eq!(camera.kind, SceneSourceKind::Camera);
        assert!((camera.transform.width - 1.0).abs() < 1e-9);
        assert!((camera.transform.height - 1.0).abs() < 1e-9);
        assert!(camera.transform.x.abs() < 1e-9);
        assert!(camera.transform.y.abs() < 1e-9);
    }

    #[test]
    fn side_by_side_scene_places_sources_in_regions() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::SideBySide;
        params.layout.side_by_side_split = SideBySideSplit::SeventyThirty;
        params.layout.side_by_side_camera_side = SideBySideCameraSide::Right;

        let scene = scene_from_capture_config(params);
        assert_eq!(scene.sources.len(), 2);
        let base = scene
            .sources
            .iter()
            .find(|source| source.kind != SceneSourceKind::Camera)
            .expect("base source");
        let camera = scene
            .sources
            .iter()
            .find(|source| source.kind == SceneSourceKind::Camera)
            .expect("camera source");

        // Screen left at 70% wide, camera right at 30% wide, full height.
        assert!(base.transform.x.abs() < 1e-9);
        assert!((base.transform.width - 0.7).abs() < 1e-9);
        assert!((camera.transform.x - 0.7).abs() < 1e-9);
        assert!((camera.transform.width - 0.3).abs() < 1e-9);
        assert!((camera.transform.height - 1.0).abs() < 1e-9);
    }

    #[test]
    fn side_by_side_camera_left_swaps_regions() {
        let mut params = base_params();
        params.layout.layout_preset = LayoutPreset::SideBySide;
        params.layout.side_by_side_split = SideBySideSplit::SixtyForty;
        params.layout.side_by_side_camera_side = SideBySideCameraSide::Left;

        let scene = scene_from_capture_config(params);
        let base = scene
            .sources
            .iter()
            .find(|source| source.kind != SceneSourceKind::Camera)
            .expect("base source");
        let camera = scene
            .sources
            .iter()
            .find(|source| source.kind == SceneSourceKind::Camera)
            .expect("camera source");

        // Camera left at 40% wide, screen right at 60% wide.
        assert!(camera.transform.x.abs() < 1e-9);
        assert!((camera.transform.width - 0.4).abs() < 1e-9);
        assert!((base.transform.x - 0.4).abs() < 1e-9);
        assert!((base.transform.width - 0.6).abs() < 1e-9);
    }

    #[test]
    fn builds_scene_from_capture_config_in_source_order() {
        let scene = scene_from_capture_config(base_params());

        assert_eq!(scene.sources.len(), 2);
        assert_eq!(scene.sources[0].kind, SceneSourceKind::Screen);
        assert_eq!(scene.sources[1].kind, SceneSourceKind::Camera);
        assert_eq!(scene.sources[0].transform.width, 1.0);
        assert!(scene.sources[1].transform.x > 0.6);
        assert!(scene.sources[1].transform.y > 0.6);
    }

    #[test]
    fn scene_from_capture_config_preserves_background() {
        let mut params = base_params();
        params.background = Some(test_background("/managed/background.png"));

        let scene = scene_from_capture_config(params);

        assert_eq!(
            scene
                .background
                .as_ref()
                .map(|background| background.asset_id.as_str()),
            Some("asset-1")
        );
        assert_eq!(
            scene
                .background
                .as_ref()
                .map(|background| background.managed_asset_path.as_str()),
            Some("/managed/background.png")
        );
    }

    #[test]
    fn validate_scene_background_blocks_missing_and_unreadable_files() {
        let mut scene = scene_from_capture_config(base_params());

        scene.background = Some(test_background(""));
        assert!(
            validate_scene_background(&scene)
                .unwrap_err()
                .contains("has no managed asset path")
        );

        scene.background = Some(test_background("/tmp/videorc-missing-background.png"));
        assert!(
            validate_scene_background(&scene)
                .unwrap_err()
                .contains("file is missing")
        );

        let path = temp_png_path("invalid");
        std::fs::write(&path, b"not an image").unwrap();
        scene.background = Some(test_background(path.display().to_string()));
        assert!(
            validate_scene_background(&scene)
                .unwrap_err()
                .contains("could not be read")
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_scene_background_accepts_decodable_images() {
        let path = temp_png_path("valid");
        image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))
            .save(&path)
            .unwrap();

        let mut scene = scene_from_capture_config(base_params());
        scene.background = Some(test_background(path.display().to_string()));

        assert_eq!(validate_scene_background(&scene), Ok(()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_scene_background_accepts_bundled_webp() {
        // The exact asset class that shipped broken: the builtin background
        // library is .webp, and the image crate was built png-only — every
        // builtin background failed validation and killed the scene commit
        // ("Waiting for the app to commit its scene", 2026-07-01).
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/renderer/src/assets/backgrounds/light-mode.webp");
        assert!(
            path.is_file(),
            "bundled webp fixture missing: {}",
            path.display()
        );

        let mut scene = scene_from_capture_config(base_params());
        scene.background = Some(test_background(path.display().to_string()));

        assert_eq!(validate_scene_background(&scene), Ok(()));
    }

    #[test]
    fn real_screen_source_wins_over_stale_test_pattern_flag() {
        let mut params = base_params();
        params.sources.test_pattern = true;

        let scene = scene_from_capture_config(params);

        assert_eq!(scene.sources[0].kind, SceneSourceKind::Screen);
        assert_eq!(
            scene.sources[0].device_id.as_deref(),
            Some("screen:screencapturekit:1")
        );
    }

    #[test]
    fn camera_scene_transform_keeps_relative_size_across_output_resolutions() {
        let mut preview_params = base_params();
        preview_params.video = Some(crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4000,
        });
        let mut recording_params = base_params();
        recording_params.video = Some(crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        });

        let preview_scene = scene_from_capture_config(preview_params);
        let recording_scene = scene_from_capture_config(recording_params);
        let preview_camera = &preview_scene.sources[1].transform;
        let recording_camera = &recording_scene.sources[1].transform;

        assert!((preview_camera.width - recording_camera.width).abs() < 0.0001);
        assert!((preview_camera.height - recording_camera.height).abs() < 0.0001);
        assert!((preview_camera.x - recording_camera.x).abs() < 0.0001);
        assert!((preview_camera.y - recording_camera.y).abs() < 0.0001);
    }

    #[test]
    fn camera_margin_below_snap_threshold_stays_visible() {
        let mut params = base_params();
        params.layout.camera_corner = CameraCorner::BottomRight;
        params.layout.camera_margin = 18;

        let scene = scene_from_capture_config(params);
        let camera = scene
            .sources
            .iter()
            .find(|source| source.kind == SceneSourceKind::Camera)
            .expect("camera source present");

        let right_margin = 1.0 - (camera.transform.x + camera.transform.width);
        let bottom_margin = 1.0 - (camera.transform.y + camera.transform.height);

        assert!((right_margin - (18.0 / 1280.0)).abs() < 0.0001);
        assert!((bottom_margin - (18.0 / 720.0)).abs() < 0.0001);
    }

    #[test]
    fn reset_transform_restores_source_default() {
        let mut scene = scene_from_capture_config(base_params());

        update_source_transform(
            &mut scene,
            SceneTransformUpdateParams {
                source_id: CAMERA_SOURCE_ID.to_string(),
                transform: SceneTransformPatch {
                    x: Some(0.1),
                    y: Some(0.2),
                    ..SceneTransformPatch::default()
                },
            },
        )
        .unwrap();
        reset_source_transform(
            &mut scene,
            SceneSourceParams {
                source_id: CAMERA_SOURCE_ID.to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            scene.sources[1].transform,
            scene.sources[1].default_transform
        );
    }

    #[test]
    fn clamps_crop_pairs_without_rejecting_tiny_transforms() {
        let mut scene = scene_from_capture_config(base_params());

        update_source_transform(
            &mut scene,
            SceneTransformUpdateParams {
                source_id: CAMERA_SOURCE_ID.to_string(),
                transform: SceneTransformPatch {
                    width: Some(0.0),
                    height: Some(0.0),
                    crop_left: Some(0.8),
                    crop_right: Some(0.8),
                    ..SceneTransformPatch::default()
                },
            },
        )
        .unwrap();

        let transform = &scene.sources[1].transform;
        assert_eq!(transform.width, 0.0);
        assert_eq!(transform.height, 0.0);
        assert!(transform.crop_left + transform.crop_right <= 0.95);
    }

    #[test]
    fn snaps_near_edges_and_center() {
        let transform = snap_transform(SceneTransform {
            x: 0.012,
            y: 0.301,
            width: 0.4,
            height: 0.4,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        });

        assert_eq!(transform.x, 0.0);
        assert_eq!(transform.y, 0.3);
    }

    #[test]
    fn reorders_sources_exactly() {
        let mut scene = scene_from_capture_config(base_params());

        reorder_sources(
            &mut scene,
            SceneSourceOrderParams {
                source_ids: vec![CAMERA_SOURCE_ID.to_string(), BASE_SOURCE_ID.to_string()],
            },
        )
        .unwrap();

        assert_eq!(scene.sources[0].id, CAMERA_SOURCE_ID);
        assert_eq!(scene.sources[1].id, BASE_SOURCE_ID);
    }

    #[test]
    fn updates_source_visibility() {
        let mut scene = scene_from_capture_config(base_params());

        update_source_visibility(
            &mut scene,
            SceneSourceVisibilityParams {
                source_id: CAMERA_SOURCE_ID.to_string(),
                visible: false,
            },
        )
        .unwrap();

        assert!(!scene.sources[1].visible);
    }

    #[test]
    fn nudges_with_small_and_large_steps() {
        let mut params = base_params();
        params.layout.camera_corner = CameraCorner::TopLeft;
        let mut scene = scene_from_capture_config(params);
        let original_x = scene.sources[1].transform.x;

        nudge_source(&mut scene, CAMERA_SOURCE_ID, -1.0, 0.0, false).unwrap();
        assert!((scene.sources[1].transform.x - (original_x - 0.005)).abs() < 0.0001);

        nudge_source(&mut scene, CAMERA_SOURCE_ID, 1.0, 0.0, true).unwrap();
        assert!((scene.sources[1].transform.x - (original_x + 0.02)).abs() < 0.0001);
    }

    #[test]
    fn nudges_escape_the_snap_magnet() {
        // The snap threshold (0.015) is larger than the small nudge step
        // (0.005): with snapping applied, every arrow click from a snapped
        // edge moved and instantly snapped back — a permanent no-op the user
        // reported as "the arrows do nothing". Nudges skip the snap.
        let mut scene = scene_from_capture_config(base_params());
        let source_id = scene.sources[0].id.clone();
        scene.sources[0].transform = SceneTransform {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 0.5,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };

        nudge_source(&mut scene, &source_id, 1.0, 0.0, false).unwrap();
        assert!((scene.sources[0].transform.x - 0.005).abs() < 0.0001);

        // Repeated clicks keep accumulating instead of re-snapping to 0.
        nudge_source(&mut scene, &source_id, 1.0, 0.0, false).unwrap();
        assert!((scene.sources[0].transform.x - 0.010).abs() < 0.0001);
    }

    #[test]
    fn derives_crop_from_zoom_and_pan() {
        let (left, right) = crop_for_zoom(150, 40);

        assert!(left > right);
        assert!(left + right > 0.3);
        assert!(left + right < 0.34);
    }
}
