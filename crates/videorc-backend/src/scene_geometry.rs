use crate::protocol::{
    CameraAspect, CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode,
    EffectiveSceneBackground, LayoutPreset, LayoutSettings, SceneSourceKind, SceneTransform,
    SideBySideSplit,
};

const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;

/// Backend-independent destination rectangle used by the FFmpeg recording and
/// CPU/Metal compositor paths. Renderer-specific syntax and buffer handling
/// deliberately stay in those consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A normalized crop in source coordinates. Values are clamped independently
/// to the wire contract's 95% ceiling; `kept_*` keeps malformed legacy pairs
/// renderable instead of producing a zero-sized source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneCrop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl SceneCrop {
    pub const fn none() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        }
    }

    pub fn kept_width(self) -> f64 {
        (1.0 - self.left - self.right).max(0.001)
    }

    pub fn kept_height(self) -> f64 {
        (1.0 - self.top - self.bottom).max(0.001)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneMask {
    None,
    Circle,
    Rounded { radius_pct: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneFit {
    Contain,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CircleGeometry {
    pub center_x: f64,
    pub center_y: f64,
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedRectGeometry {
    pub center_x: f64,
    pub center_y: f64,
    pub radius: f64,
    pub inner_half_width: f64,
    pub inner_half_height: f64,
}

/// Stage margin per side for a scene background. The default visibility of 20
/// yields a 0.10 margin (an 80% content stage); zero stays full-canvas.
pub fn background_stage_margin(background: Option<&EffectiveSceneBackground>) -> f64 {
    background
        .map(|background| (background.visibility_percent / 200.0).clamp(0.0, 0.20))
        .unwrap_or(0.0)
}

pub fn background_zoom_crop(background: Option<&EffectiveSceneBackground>) -> SceneCrop {
    let Some(background) = background else {
        return SceneCrop::none();
    };
    let scale = background.scale.clamp(100.0, 200.0);
    if scale <= 100.0 {
        return SceneCrop::none();
    }
    let total_crop = 1.0 - (100.0 / scale);
    let crop_x = (background.offset_x.clamp(-100.0, 100.0) / 200.0) * total_crop;
    let crop_y = (background.offset_y.clamp(-100.0, 100.0) / 200.0) * total_crop;
    SceneCrop {
        left: ((total_crop / 2.0) + crop_x).clamp(0.0, 0.95),
        right: ((total_crop / 2.0) - crop_x).clamp(0.0, 0.95),
        top: ((total_crop / 2.0) + crop_y).clamp(0.0, 0.95),
        bottom: ((total_crop / 2.0) - crop_y).clamp(0.0, 0.95),
    }
}

pub fn scene_source_render_transform(
    transform: &SceneTransform,
    source_kind: &SceneSourceKind,
    stage_margin: f64,
) -> SceneTransform {
    if stage_margin <= 0.0 || !scene_source_uses_background_stage(source_kind) {
        return transform.clone();
    }
    let stage_scale = 1.0 - (stage_margin * 2.0);
    SceneTransform {
        x: stage_margin + (transform.x * stage_scale),
        y: stage_margin + (transform.y * stage_scale),
        width: transform.width * stage_scale,
        height: transform.height * stage_scale,
        crop_left: transform.crop_left,
        crop_top: transform.crop_top,
        crop_right: transform.crop_right,
        crop_bottom: transform.crop_bottom,
    }
}

pub fn scene_source_uses_background_stage(source_kind: &SceneSourceKind) -> bool {
    matches!(
        source_kind,
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern
    )
}

pub fn scene_source_rect_pixels(
    transform: &SceneTransform,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<PixelRect> {
    if transform.width <= 0.0 || transform.height <= 0.0 {
        return None;
    }
    let x = normalized_to_pixel(transform.x, canvas_width).min(canvas_width.saturating_sub(1));
    let y = normalized_to_pixel(transform.y, canvas_height).min(canvas_height.saturating_sub(1));
    let max_width = canvas_width.saturating_sub(x).max(1);
    let max_height = canvas_height.saturating_sub(y).max(1);
    let width = normalized_to_span(transform.width, canvas_width).min(max_width);
    let height = normalized_to_span(transform.height, canvas_height).min(max_height);
    Some(PixelRect {
        x,
        y,
        width,
        height,
    })
}

pub fn scene_crop_from_transform(transform: &SceneTransform) -> SceneCrop {
    SceneCrop {
        left: transform.crop_left.clamp(0.0, 0.95),
        top: transform.crop_top.clamp(0.0, 0.95),
        right: transform.crop_right.clamp(0.0, 0.95),
        bottom: transform.crop_bottom.clamp(0.0, 0.95),
    }
}

/// True for every vertical-mode preset: their regions are short-form bands
/// that must be FILLED — internal letterboxing is the bug (owner report,
/// 2026-07-13 fill-crop plan), not a fidelity feature.
fn vertical_fill_preset(preset: &LayoutPreset) -> bool {
    matches!(
        preset,
        LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
            | LayoutPreset::VerticalScreenCamera
            | LayoutPreset::VerticalScreenOnly
            | LayoutPreset::VerticalCameraOnly
    )
}

/// The shared fit policy for source status, FFmpeg filters, CPU blits, and
/// Metal placement. Side-by-side and ALL vertical presets cover their regions
/// (short-form bands are filled, center-cropped — never letterboxed); the
/// horizontal full-frame screen/window presets contain so UI edges are never
/// cropped. Vertical BAND cameras cover unconditionally — a contain camera
/// band letterboxes exactly like the reported bug; zoom/pan still frame the
/// crop. The vertical screen+camera inset bubble keeps the user's Fit choice
/// like its horizontal twin.
pub fn scene_source_fit(kind: &SceneSourceKind, layout: &LayoutSettings) -> SceneFit {
    match kind {
        SceneSourceKind::Camera => {
            // Band cameras and the full-canvas vertical camera always cover:
            // a contained camera letterboxes its region, which is exactly the
            // vertical fill law's bug. Only the vertical screen+camera inset
            // bubble keeps the user's Fit choice (like its horizontal twin).
            let vertical_filled_camera = matches!(
                layout.layout_preset,
                LayoutPreset::VerticalCameraTop
                    | LayoutPreset::VerticalCameraBottom
                    | LayoutPreset::VerticalSplit
                    | LayoutPreset::VerticalCameraOnly
            );
            if vertical_filled_camera {
                return SceneFit::Cover;
            }
            if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom <= 100 {
                SceneFit::Contain
            } else {
                SceneFit::Cover
            }
        }
        SceneSourceKind::Screen | SceneSourceKind::Window => {
            if matches!(layout.layout_preset, LayoutPreset::SideBySide)
                || vertical_fill_preset(&layout.layout_preset)
            {
                SceneFit::Cover
            } else {
                SceneFit::Contain
            }
        }
        SceneSourceKind::TestPattern => SceneFit::Cover,
    }
}

/// Camera masks are overlay policy, not renderer policy: only screen+camera
/// applies the selected bubble shape. Camera-only and side-by-side stay plain.
pub fn camera_mask(layout: &LayoutSettings) -> SceneMask {
    // Only the inset scenes draw the camera as a shaped bubble; band and
    // region presets keep the camera rectangular (maskless).
    if !matches!(
        layout.layout_preset,
        LayoutPreset::ScreenCamera | LayoutPreset::VerticalScreenCamera
    ) {
        return SceneMask::None;
    }
    match layout.camera_shape {
        CameraShape::Rectangle => SceneMask::None,
        CameraShape::Circle => SceneMask::Circle,
        CameraShape::Rounded => SceneMask::Rounded {
            radius_pct: layout.camera_corner_radius_pct.min(50),
        },
    }
}

pub fn circle_geometry(rect: PixelRect) -> CircleGeometry {
    CircleGeometry {
        center_x: f64::from(rect.x) + f64::from(rect.width) / 2.0,
        center_y: f64::from(rect.y) + f64::from(rect.height) / 2.0,
        radius: f64::from(rect.width.min(rect.height)) / 2.0,
    }
}

pub fn rounded_rect_geometry(rect: PixelRect, radius_pct: u32) -> RoundedRectGeometry {
    let radius = f64::from(rect.width.min(rect.height)) * f64::from(radius_pct.min(50)) / 100.0;
    RoundedRectGeometry {
        center_x: f64::from(rect.x) + f64::from(rect.width) / 2.0,
        center_y: f64::from(rect.y) + f64::from(rect.height) / 2.0,
        radius,
        inner_half_width: (f64::from(rect.width) / 2.0 - radius).max(0.0),
        inner_half_height: (f64::from(rect.height) / 2.0 - radius).max(0.0),
    }
}

pub fn scene_mask_allows(mask: SceneMask, rect: PixelRect, x: usize, y: usize) -> bool {
    match mask {
        SceneMask::None => true,
        SceneMask::Circle => {
            let geometry = circle_geometry(rect);
            if geometry.radius <= 0.0 {
                return false;
            }
            let dx = x as f64 + 0.5 - geometry.center_x;
            let dy = y as f64 + 0.5 - geometry.center_y;
            dx * dx + dy * dy <= geometry.radius * geometry.radius
        }
        SceneMask::Rounded { radius_pct } => {
            let geometry = rounded_rect_geometry(rect, radius_pct);
            if geometry.radius <= 0.0 {
                return true;
            }
            let qx =
                ((x as f64 + 0.5 - geometry.center_x).abs() - geometry.inner_half_width).max(0.0);
            let qy =
                ((y as f64 + 0.5 - geometry.center_y).abs() - geometry.inner_half_height).max(0.0);
            qx * qx + qy * qy <= geometry.radius * geometry.radius
        }
    }
}

pub fn camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
) -> (u32, u32) {
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    let height = match shape {
        CameraShape::Circle => width,
        CameraShape::Rectangle | CameraShape::Rounded => match aspect {
            CameraAspect::Source => (width * 9 + 8) / 16,
            CameraAspect::Square => width,
            CameraAspect::Portrait => (width * 4_u32).div_ceil(3),
        },
    };
    (width, height)
}

pub fn camera_output_scale(output_width: u32, output_height: u32) -> f64 {
    (f64::from(output_width) / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(f64::from(output_height) / f64::from(CAMERA_REFERENCE_HEIGHT))
}

pub fn scale_camera_dimension(value: u32, scale: f64) -> u32 {
    (f64::from(value) * scale).round().max(1.0) as u32
}

pub fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
    output_width: u32,
    output_height: u32,
) -> (u32, u32) {
    let scale = camera_output_scale(output_width, output_height);
    let (width, height) = camera_box_size(size, shape, aspect);
    (
        scale_camera_dimension(width, scale),
        scale_camera_dimension(height, scale),
    )
}

pub fn scaled_camera_margin(layout: &LayoutSettings, output_width: u32, output_height: u32) -> u32 {
    scale_camera_dimension(
        layout.camera_margin.min(160),
        camera_output_scale(output_width, output_height),
    )
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

/// Preset camera geometry is the authority used to build the scene consumed by
/// the compositor and the equivalent FFmpeg overlay dimensions/position.
pub fn preset_camera_transform(
    layout: &LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let output_width = output_width.max(1);
    let output_height = output_height.max(1);
    let (camera_width, camera_height) = scaled_camera_box_size(
        &layout.camera_size,
        &layout.camera_shape,
        &layout.camera_aspect,
        output_width,
        output_height,
    );
    let margin = scaled_camera_margin(layout, output_width, output_height);
    let x = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::BottomLeft => margin,
        CameraCorner::TopRight | CameraCorner::BottomRight => output_width
            .saturating_sub(camera_width)
            .saturating_sub(margin),
    };
    let y = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::TopRight => margin,
        CameraCorner::BottomLeft | CameraCorner::BottomRight => output_height
            .saturating_sub(camera_height)
            .saturating_sub(margin),
    };
    let (crop_left, crop_right) =
        if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom == 100 {
            (0.0, 0.0)
        } else {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_x)
        };
    let (crop_top, crop_bottom) =
        if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom == 100 {
            (0.0, 0.0)
        } else {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_y)
        };
    SceneTransform {
        x: f64::from(x) / f64::from(output_width),
        y: f64::from(y) / f64::from(output_height),
        width: f64::from(camera_width) / f64::from(output_width),
        height: f64::from(camera_height) / f64::from(output_height),
        crop_left,
        crop_top,
        crop_right,
        crop_bottom,
    }
}

pub fn resolved_camera_transform(
    layout: &LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let mut transform = preset_camera_transform(layout, output_width, output_height);
    if let (CameraTransformMode::Custom, Some(custom)) =
        (layout.camera_transform_mode, layout.camera_transform)
    {
        transform.x = finite_or_zero(custom.x).clamp(0.0, (1.0 - transform.width).max(0.0));
        transform.y = finite_or_zero(custom.y).clamp(0.0, (1.0 - transform.height).max(0.0));
    }
    transform
}

pub fn side_by_side_fractions(split: SideBySideSplit) -> (f64, f64) {
    match split {
        SideBySideSplit::Even => (0.5, 0.5),
        SideBySideSplit::SixtyForty => (0.6, 0.4),
        SideBySideSplit::SeventyThirty => (0.7, 0.3),
    }
}

/// Even pixel widths are required by the YUV/encoder paths. The regions always
/// tile the canvas and the screen gets the larger (or equal) share.
pub fn side_by_side_widths(split: SideBySideSplit, total_width: u32) -> (u32, u32) {
    let (screen_fraction, _) = side_by_side_fractions(split);
    let mut screen_width = (f64::from(total_width) * screen_fraction).round() as u32;
    screen_width -= screen_width % 2;
    screen_width = screen_width.clamp(2, total_width.saturating_sub(2));
    (screen_width, total_width - screen_width)
}

fn normalized_to_pixel(value: f64, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, 1.0) * f64::from(span)).round() as u32
}

fn normalized_to_span(value: f64, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, 1.0) * f64::from(span))
        .round()
        .max(1.0) as u32
}

fn normalize_crop_pair(first: f64, second: f64) -> (f64, f64) {
    let mut first = finite_or_zero(first).clamp(0.0, 0.95);
    let mut second = finite_or_zero(second).clamp(0.0, 0.95);
    let total = first + second;
    if total > 0.95 {
        let scale = 0.95 / total;
        first *= scale;
        second *= scale;
    }
    (first, second)
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CameraTransform, SideBySideCameraSide, default_layout_settings};

    fn layout() -> LayoutSettings {
        default_layout_settings()
    }

    #[test]
    fn preset_fit_and_mask_policy_table_is_renderer_independent() {
        // Columns: preset, screen fit, camera fit (with CameraFit::Fit set —
        // band cameras must IGNORE it and cover), mask. Every vertical preset
        // covers its regions: short-form bands are filled, never letterboxed
        // (2026-07-13 fill-crop plan, owner report).
        let cases = [
            (
                LayoutPreset::ScreenCamera,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::Rounded { radius_pct: 12 },
            ),
            (
                LayoutPreset::ScreenOnly,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::None,
            ),
            (
                LayoutPreset::CameraOnly,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::None,
            ),
            (
                LayoutPreset::SideBySide,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::None,
            ),
            // The inset twin masks exactly like ScreenCamera and keeps the
            // user's camera Fit for its bubble; its SCREEN covers the frame.
            (
                LayoutPreset::VerticalScreenCamera,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::Rounded { radius_pct: 12 },
            ),
            (
                LayoutPreset::VerticalCameraTop,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            (
                LayoutPreset::VerticalCameraBottom,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            (
                LayoutPreset::VerticalSplit,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            // Screen-only scenes never render a camera; the camera column
            // just documents the fallthrough (user Fit honored, moot here).
            (
                LayoutPreset::VerticalScreenOnly,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::None,
            ),
            // The full-canvas vertical camera ignores Fit like the bands do
            // (the portrait canvas is always filled) and stays maskless.
            (
                LayoutPreset::VerticalCameraOnly,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
        ];
        for (preset, expected_screen_fit, expected_camera_fit, expected_mask) in cases {
            let mut layout = layout();
            layout.layout_preset = preset.clone();
            layout.camera_shape = CameraShape::Rounded;
            layout.camera_fit = CameraFit::Fit;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Screen, &layout),
                expected_screen_fit,
                "screen fit for {preset:?}"
            );
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Camera, &layout),
                expected_camera_fit,
                "camera fit for {preset:?}"
            );
            assert_eq!(camera_mask(&layout), expected_mask, "mask for {preset:?}");
        }
    }

    #[test]
    fn shape_and_radius_policy_table_clamps_once() {
        let cases = [
            (CameraShape::Rectangle, 18, SceneMask::None),
            (CameraShape::Circle, 18, SceneMask::Circle),
            (
                CameraShape::Rounded,
                18,
                SceneMask::Rounded { radius_pct: 18 },
            ),
            (
                CameraShape::Rounded,
                400,
                SceneMask::Rounded { radius_pct: 50 },
            ),
        ];
        for (shape, radius_pct, expected) in cases {
            let mut layout = layout();
            layout.layout_preset = LayoutPreset::ScreenCamera;
            layout.camera_shape = shape;
            layout.camera_corner_radius_pct = radius_pct;
            assert_eq!(camera_mask(&layout), expected);
        }
    }

    #[test]
    fn camera_geometry_scales_at_1080p_and_4k() {
        let mut layout = layout();
        layout.camera_corner = CameraCorner::BottomRight;
        layout.camera_size = CameraSize::Medium;
        layout.camera_shape = CameraShape::Rectangle;
        layout.camera_aspect = CameraAspect::Source;
        layout.camera_margin = 32;

        let cases = [
            (
                (1920, 1080),
                PixelRect {
                    x: 1332,
                    y: 727,
                    width: 540,
                    height: 305,
                },
            ),
            (
                (3840, 2160),
                PixelRect {
                    x: 2664,
                    y: 1455,
                    width: 1080,
                    height: 609,
                },
            ),
        ];
        for ((width, height), expected) in cases {
            let transform = preset_camera_transform(&layout, width, height);
            assert_eq!(
                scene_source_rect_pixels(&transform, width, height),
                Some(expected)
            );
        }
    }

    #[test]
    fn custom_transform_and_zoom_crop_table_matches_1080p_and_4k() {
        let mut layout = layout();
        layout.camera_transform_mode = CameraTransformMode::Custom;
        layout.camera_transform = Some(CameraTransform {
            x: 0.9,
            y: -0.2,
            width: 0.1,
            height: 0.1,
        });
        layout.camera_zoom = 150;
        layout.camera_offset_x = 40;
        layout.camera_offset_y = -20;

        for (width, height) in [(1920, 1080), (3840, 2160)] {
            let transform = resolved_camera_transform(&layout, width, height);
            let rect = scene_source_rect_pixels(&transform, width, height).unwrap();
            assert_eq!(rect.x + rect.width, width, "custom x clamps on-canvas");
            assert_eq!(rect.y, 0, "custom y clamps on-canvas");
            assert!((transform.crop_left - 0.233_333_333_333_333_34).abs() < 1e-9);
            assert!((transform.crop_right - 0.1).abs() < 1e-9);
            assert!((transform.crop_top - 0.133_333_333_333_333_33).abs() < 1e-9);
            assert!((transform.crop_bottom - 0.2).abs() < 1e-9);
        }
    }

    #[test]
    fn transform_and_crop_table_clips_at_canvas_edges() {
        let transform = SceneTransform {
            x: 0.75,
            y: 0.8,
            width: 0.5,
            height: 0.5,
            crop_left: -1.0,
            crop_top: 0.25,
            crop_right: 4.0,
            crop_bottom: 0.125,
        };
        let cases = [
            (
                (1920, 1080),
                PixelRect {
                    x: 1440,
                    y: 864,
                    width: 480,
                    height: 216,
                },
            ),
            (
                (3840, 2160),
                PixelRect {
                    x: 2880,
                    y: 1728,
                    width: 960,
                    height: 432,
                },
            ),
        ];
        for ((width, height), expected) in cases {
            assert_eq!(
                scene_source_rect_pixels(&transform, width, height),
                Some(expected)
            );
        }
        assert_eq!(
            scene_crop_from_transform(&transform),
            SceneCrop {
                left: 0.0,
                top: 0.25,
                right: 0.95,
                bottom: 0.125,
            }
        );
    }

    #[test]
    fn side_by_side_table_tiles_1080p_and_4k() {
        let cases = [
            (1920, SideBySideSplit::Even, (960, 960)),
            (1920, SideBySideSplit::SixtyForty, (1152, 768)),
            (1920, SideBySideSplit::SeventyThirty, (1344, 576)),
            (3840, SideBySideSplit::Even, (1920, 1920)),
            (3840, SideBySideSplit::SixtyForty, (2304, 1536)),
            (3840, SideBySideSplit::SeventyThirty, (2688, 1152)),
        ];
        for (width, split, expected) in cases {
            assert_eq!(side_by_side_widths(split, width), expected);
        }
        let _ = SideBySideCameraSide::Right;
    }

    #[test]
    fn circle_and_rounded_masks_share_short_side_geometry() {
        let rect = PixelRect {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        };
        assert_eq!(circle_geometry(rect).radius, 50.0);
        let rounded = rounded_rect_geometry(rect, 20);
        assert_eq!(rounded.radius, 20.0);
        assert_eq!(rounded.inner_half_width, 80.0);
        assert_eq!(rounded.inner_half_height, 30.0);
        assert!(scene_mask_allows(SceneMask::Circle, rect, 100, 50));
        assert!(!scene_mask_allows(SceneMask::Circle, rect, 0, 50));
        assert!(!scene_mask_allows(
            SceneMask::Rounded { radius_pct: 20 },
            rect,
            0,
            0
        ));
        assert!(scene_mask_allows(
            SceneMask::Rounded { radius_pct: 20 },
            rect,
            100,
            0
        ));
    }
}
