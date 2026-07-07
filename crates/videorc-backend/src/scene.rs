use std::path::Path;

use crate::protocol::{
    CameraAspect, CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode,
    LayoutPreset, Scene, SceneConfigParams, SceneOutput, SceneOutputKind, SceneSource,
    SceneSourceKind, SceneSourceOrderParams, SceneSourceParams, SceneSourceVisibilityParams,
    SceneTransform, SceneTransformPatch, SceneTransformUpdateParams, SideBySideCameraSide,
    SideBySideSplit, SourceSelection,
};

const DEFAULT_SCENE_ID: &str = "scene:default";
const BASE_SOURCE_ID: &str = "source:base";
const CAMERA_SOURCE_ID: &str = "source:camera";
const TEST_PATTERN_SOURCE_ID: &str = "source:test-pattern";
const SNAP_THRESHOLD: f64 = 0.015;
const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;

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

    image::open(image_path).map_err(|error| {
        format!(
            "Scene background {} could not be read from {}: {}. Replace the background before recording.",
            background.asset_id, path, error
        )
    })?;

    Ok(())
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
            SceneOutput {
                id: "output:preview".to_string(),
                kind: SceneOutputKind::Preview,
                width: output_width.min(1280),
                height: output_height.min(720),
                fps: fps.min(30),
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
        LayoutPreset::ScreenOnly => {
            // Screen-only never composites the camera.
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
        _ => {
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

pub fn crop_for_zoom(zoom: u32, offset: i32) -> (f64, f64) {
    let zoom = zoom.clamp(100, 200);
    if zoom == 100 {
        return (0.0, 0.0);
    }

    let total_crop = 1.0 - (100.0 / f64::from(zoom));
    let offset = (f64::from(offset.clamp(-100, 100)) / 200.0) * total_crop;
    normalize_crop_pair((total_crop / 2.0) + offset, (total_crop / 2.0) - offset)
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
    let default_transform = camera_transform(layout, output_width, output_height);
    // A dragged camera (custom mode) overrides position only; size/crop and the
    // default_transform stay tied to the corner/size preset so Reset restores it.
    let transform = match (layout.camera_transform_mode, layout.camera_transform) {
        (CameraTransformMode::Custom, Some(custom)) => sanitize_transform(SceneTransform {
            x: custom.x,
            y: custom.y,
            ..default_transform.clone()
        }),
        _ => default_transform.clone(),
    };
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

fn camera_transform(
    layout: &crate::protocol::LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let output_width = f64::from(output_width.max(1));
    let output_height = f64::from(output_height.max(1));
    let scale = camera_output_scale(output_width, output_height);
    let (camera_width, camera_height) = scaled_camera_box_size(
        &layout.camera_size,
        &layout.camera_shape,
        &layout.camera_aspect,
        scale,
    );
    let camera_width = f64::from(camera_width);
    let camera_height = f64::from(camera_height);
    let margin = f64::from(scale_camera_dimension(layout.camera_margin.min(160), scale));
    let x = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::BottomLeft => margin / output_width,
        CameraCorner::TopRight | CameraCorner::BottomRight => {
            (output_width - camera_width - margin) / output_width
        }
    };
    let y = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::TopRight => margin / output_height,
        CameraCorner::BottomLeft | CameraCorner::BottomRight => {
            (output_height - camera_height - margin) / output_height
        }
    };
    let (crop_left, crop_right) = match layout.camera_fit {
        CameraFit::Fit if layout.camera_zoom == 100 => (0.0, 0.0),
        CameraFit::Fit | CameraFit::Fill => {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_x)
        }
    };
    let (crop_top, crop_bottom) = match layout.camera_fit {
        CameraFit::Fit if layout.camera_zoom == 100 => (0.0, 0.0),
        CameraFit::Fit | CameraFit::Fill => {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_y)
        }
    };

    sanitize_transform_unsnapped(SceneTransform {
        x,
        y,
        width: camera_width / output_width,
        height: camera_height / output_height,
        crop_left,
        crop_top,
        crop_right,
        crop_bottom,
    })
}

fn camera_box_size(size: &CameraSize, shape: &CameraShape, aspect: &CameraAspect) -> (u32, u32) {
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    // The box aspect decides the framing; the default Fill fit center-crops
    // the camera into it, so `portrait` produces a Theo-style vertical camera
    // from a landscape webcam. Circle keeps its square box regardless — a
    // circle has no aspect.
    let height = match shape {
        CameraShape::Circle => width,
        CameraShape::Rectangle | CameraShape::Rounded => match aspect {
            CameraAspect::Source => (width * 9 + 8) / 16,
            CameraAspect::Square => width,
            CameraAspect::Portrait => (width * 4u32).div_ceil(3),
        },
    };
    (width, height)
}

fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
    scale: f64,
) -> (u32, u32) {
    let (width, height) = camera_box_size(size, shape, aspect);

    (
        scale_camera_dimension(width, scale),
        scale_camera_dimension(height, scale),
    )
}

fn camera_output_scale(output_width: f64, output_height: f64) -> f64 {
    (output_width / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(output_height / f64::from(CAMERA_REFERENCE_HEIGHT))
}

fn scale_camera_dimension(value: u32, scale: f64) -> u32 {
    (f64::from(value) * scale).round().max(1.0) as u32
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

fn side_by_side_fractions(split: SideBySideSplit) -> (f64, f64) {
    match split {
        SideBySideSplit::Even => (0.5, 0.5),
        SideBySideSplit::SixtyForty => (0.6, 0.4),
        SideBySideSplit::SeventyThirty => (0.7, 0.3),
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
        BackgroundFit, CameraTransform, EffectiveSceneBackground, LayoutPreset, LayoutSettings,
        SourceSelection,
    };

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
