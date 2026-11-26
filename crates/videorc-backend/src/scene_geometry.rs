use crate::protocol::{
    ArrangementMode, CameraAspect, CameraCorner, CameraFit, CameraShape, CameraSize,
    CameraTransform, CameraTransformMode, EffectiveSceneBackground, LayoutPreset, LayoutSettings,
    Scene, SceneSourceKind, SceneTransform, SideBySideSplit,
};

const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;

/// The protocol's bounds for a scene source's box, as canvas fractions (plan
/// 215 E3, owner decision D2): a source may be up to 400% of the canvas and
/// sit anywhere from three canvases left or above the canvas to four right
/// or below it. These are the coarse limits every render path tolerates
/// (`scene::sanitize_transform_unsnapped` clamps to them); the editor keeps
/// at least 5% of the canvas covered on each axis (the stage's
/// `MIN_SOURCE_FRACTION`). Mirrored by `transform-fields-math.ts`,
/// `stage-transform.ts` and the Windows D3D11 planner.
pub const MAX_SOURCE_SIZE_FRACTION: f64 = 4.0;
pub const MIN_SOURCE_POSITION_FRACTION: f64 = -3.0;
pub const MAX_SOURCE_POSITION_FRACTION: f64 = 4.0;

/// Backend-independent destination rectangle used by the FFmpeg recording and
/// CPU/Metal compositor paths. Renderer-specific syntax and buffer handling
/// deliberately stay in those consumers. Always on the canvas: a source's
/// box before the canvas edge cuts it is a [`SignedPixelRect`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A source's box in canvas pixels before the canvas edge cuts it (plan 215
/// E1): signed, so a box that starts left of or above the canvas keeps its
/// true origin, and as big as its transform says, so one that runs past the
/// right or bottom edge keeps its true size. Every render path fits the
/// source into THIS box and lets the canvas edge cut what hangs off (the GPU
/// paths clip the quad; the CPU path draws `intersect_canvas`); nothing
/// squashes the box onto the canvas any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedPixelRect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// What the canvas edge leaves of a [`SignedPixelRect`]: the part on the
/// canvas, and how many pixels of the box's left and top the edge cut off
/// (the right and bottom cuts follow from the sizes). A consumer that draws
/// `visible` from a source window fitted to the whole box starts the window
/// `cut_left` and `cut_top` box pixels in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasCut {
    pub visible: PixelRect,
    pub cut_left: u32,
    pub cut_top: u32,
}

impl SignedPixelRect {
    pub fn right(self) -> i64 {
        self.x.saturating_add(i64::from(self.width))
    }

    pub fn bottom(self) -> i64 {
        self.y.saturating_add(i64::from(self.height))
    }

    /// The box intersected with a `canvas_width`×`canvas_height` canvas, with
    /// the amount cut off its left and top; `None` when nothing of it is on
    /// the canvas (or the box is empty).
    pub fn intersect_canvas(self, canvas_width: u32, canvas_height: u32) -> Option<CanvasCut> {
        let left = self.x.max(0);
        let top = self.y.max(0);
        let right = self.right().min(i64::from(canvas_width));
        let bottom = self.bottom().min(i64::from(canvas_height));
        if right <= left || bottom <= top {
            return None;
        }
        Some(CanvasCut {
            visible: PixelRect {
                x: left as u32,
                y: top as u32,
                width: (right - left) as u32,
                height: (bottom - top) as u32,
            },
            cut_left: (left - self.x) as u32,
            cut_top: (top - self.y) as u32,
        })
    }

    /// The whole box as an on-canvas rect, only when the canvas edge cuts
    /// nothing off it. Only the Windows recording path asks; elsewhere the
    /// tests still read it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn whole_on_canvas(self, canvas_width: u32, canvas_height: u32) -> Option<PixelRect> {
        let cut = self.intersect_canvas(canvas_width, canvas_height)?;
        (cut.cut_left == 0
            && cut.cut_top == 0
            && cut.visible.width == self.width
            && cut.visible.height == self.height)
            .then_some(cut.visible)
    }
}

impl From<PixelRect> for SignedPixelRect {
    fn from(rect: PixelRect) -> Self {
        Self {
            x: i64::from(rect.x),
            y: i64::from(rect.y),
            width: rect.width,
            height: rect.height,
        }
    }
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

/// The scene background's stage as one render path sees it for one scene:
/// how far it sits in from the canvas edge, and whether the camera sits on it
/// (plan 235, owner decision D9 a).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundStage {
    /// The inset per side, as a canvas fraction. Zero means no stage.
    pub margin: f64,
    /// Whether the scene's camera sits on the stage too
    /// ([`scene_camera_uses_background_stage`]).
    pub camera: bool,
}

impl BackgroundStage {
    /// No stage: every source keeps its own transform. Only the macOS and
    /// Windows render paths use it outside tests.
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    pub const NONE: Self = Self {
        margin: 0.0,
        camera: false,
    };

    /// The stage for `scene` under `layout`. Pass a `margin` of zero unless
    /// the background really renders, so a background that failed to load
    /// never leaves a ring around the sources.
    pub fn for_scene(scene: &Scene, layout: &LayoutSettings, margin: f64) -> Self {
        Self {
            margin,
            camera: scene_camera_uses_background_stage(scene, layout),
        }
    }
}

/// A source's transform as the render paths draw it: mapped onto the scene
/// background's stage when [`scene_source_uses_background_stage`] says the
/// source sits on it, untouched otherwise.
pub fn scene_source_render_transform(
    transform: &SceneTransform,
    source_kind: &SceneSourceKind,
    stage: BackgroundStage,
) -> SceneTransform {
    let stage_margin = stage.margin;
    if stage_margin <= 0.0 || !scene_source_uses_background_stage(source_kind, stage.camera) {
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

/// The one rule for which sources sit on the scene background's stage (plan
/// 235, owner decision D9 a). A screen, a window and the test pattern always
/// do. The camera does only when the scene says so
/// ([`scene_camera_uses_background_stage`]). Metal, CPU, D3D11 and the FFmpeg
/// legacy graph all ask this through [`scene_source_render_transform`]; the
/// TypeScript twin is `sceneSourceUsesBackgroundStage`.
pub fn scene_source_uses_background_stage(
    source_kind: &SceneSourceKind,
    camera_on_stage: bool,
) -> bool {
    match source_kind {
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern => true,
        SceneSourceKind::Camera => camera_on_stage,
    }
}

/// Whether this scene's camera sits on the background's stage (plan 235 D9
/// a): the scene is camera-only, on either canvas, and the camera is not
/// keyed. A background behind a full-frame camera was drawn and then covered,
/// so the camera now gets the stage a shared screen gets. A keyed camera
/// stays full frame over the background (the green screen case), a camera
/// beside or over a screen keeps its place, and a Freeform scene's boxes are
/// the streamer's own.
pub fn scene_camera_uses_background_stage(scene: &Scene, layout: &LayoutSettings) -> bool {
    camera_uses_background_stage(
        scene.sources.iter().map(|source| &source.kind),
        layout.arrangement_mode == ArrangementMode::Freeform,
        camera_chroma_key(layout).is_some(),
    )
}

/// [`scene_camera_uses_background_stage`] on the facts alone, which is the
/// form `protocol-fixtures/scene-picture-geometry.json` pins against the
/// TypeScript twin (`sceneCameraUsesBackgroundStage`). Hidden sources count:
/// hiding a screen must not move the camera.
pub fn camera_uses_background_stage<'a>(
    source_kinds: impl IntoIterator<Item = &'a SceneSourceKind>,
    freeform: bool,
    camera_keyed: bool,
) -> bool {
    if freeform || camera_keyed {
        return false;
    }
    let mut has_camera = false;
    for kind in source_kinds {
        match kind {
            SceneSourceKind::Camera => has_camera = true,
            SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern => {
                return false;
            }
        }
    }
    has_camera
}

/// A scene source's box in canvas pixels, uncut (plan 215 E1, D2): its true
/// origin (signed, so a box that starts left of or above the canvas keeps
/// it) and its true size (so a box past the right or bottom edge keeps it).
/// What hangs off the canvas is the render path's to cut, never to squash:
/// before this, the origin was clamped onto the canvas and the size shrunk
/// to what was left, which squeezed the whole picture into the visible part.
/// A box wholly on the canvas comes out exactly as it always did.
pub fn scene_source_rect_pixels(
    transform: &SceneTransform,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<SignedPixelRect> {
    if transform.width <= 0.0 || transform.height <= 0.0 {
        return None;
    }
    Some(SignedPixelRect {
        x: normalized_to_signed_pixel(transform.x, canvas_width),
        y: normalized_to_signed_pixel(transform.y, canvas_height),
        width: normalized_to_span(transform.width, canvas_width),
        height: normalized_to_span(transform.height, canvas_height),
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

/// The largest box of a picture's aspect inside `rect`, centred: the
/// compositor's Fit (plan 216 B1). `source_width` and `source_height` are
/// the picture after its crop, in source pixels. This is the one contain
/// arithmetic: `compositor::source_fit` draws with it, and
/// [`scene_picture_rect_pixels`] tells the renderer where the picture is,
/// so the Scene stage's box, handles and hit target land on the picture the
/// compositor really draws (`apps/desktop/src/shared/scene-picture-geometry.ts`
/// is its TypeScript twin; `protocol-fixtures/scene-picture-geometry.json`
/// keeps them equal). A degenerate box or picture comes back as the box.
pub fn contain_rect_pixels(
    source_width: f64,
    source_height: f64,
    rect: SignedPixelRect,
) -> SignedPixelRect {
    // A NaN size is not a size either: `NaN > 0.0` is false.
    let fits = source_width > 0.0 && source_height > 0.0 && rect.width > 0 && rect.height > 0;
    if !fits {
        return rect;
    }
    let source_aspect = source_width / source_height;
    let rect_aspect = f64::from(rect.width) / f64::from(rect.height);
    let (width, height) = if source_aspect > rect_aspect {
        let width = rect.width;
        let height = (f64::from(width) / source_aspect).round().max(1.0) as u32;
        (width, height.min(rect.height))
    } else {
        let height = rect.height;
        let width = (f64::from(height) * source_aspect).round().max(1.0) as u32;
        (width.min(rect.width), height)
    };
    SignedPixelRect {
        x: rect.x + i64::from((rect.width - width) / 2),
        y: rect.y + i64::from((rect.height - height) / 2),
        width,
        height,
    }
}

/// Where a scene source's PICTURE lands, in canvas pixels (plan 216 B1,
/// owner decision D2): the source's frame mapped onto the scene background's
/// stage margin ([`scene_source_render_transform`]) and rounded to pixels
/// ([`scene_source_rect_pixels`]), then, on Fit with a known source size,
/// the cropped picture's largest box inside it ([`contain_rect_pixels`]).
/// Fill, the test pattern (drawn at the canvas size) and an unknown size
/// give the frame itself. `None` only for an empty frame.
///
/// The renderer's twin is the consumer today (the fixture keeps the two
/// equal); plan 215 F's rounded-screen mask is the first Rust caller.
#[cfg_attr(not(test), allow(dead_code))]
pub fn scene_picture_rect_pixels(
    transform: &SceneTransform,
    kind: &SceneSourceKind,
    fit: SceneFit,
    source_size: Option<(u32, u32)>,
    stage: BackgroundStage,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<SignedPixelRect> {
    let staged = scene_source_render_transform(transform, kind, stage);
    let rect = scene_source_rect_pixels(&staged, canvas_width, canvas_height)?;
    let Some((source_width, source_height)) = source_size else {
        return Some(rect);
    };
    if matches!(fit, SceneFit::Cover)
        || matches!(kind, SceneSourceKind::TestPattern)
        || source_width == 0
        || source_height == 0
    {
        return Some(rect);
    }
    let crop = scene_crop_from_transform(&staged);
    Some(contain_rect_pixels(
        f64::from(source_width) * crop.kept_width(),
        f64::from(source_height) * crop.kept_height(),
        rect,
    ))
}

/// [`scene_picture_rect_pixels`] as canvas fractions: the box the Scene
/// stage draws and edits for the source.
#[cfg_attr(not(test), allow(dead_code))]
pub fn scene_picture_rect(
    transform: &SceneTransform,
    kind: &SceneSourceKind,
    fit: SceneFit,
    source_size: Option<(u32, u32)>,
    stage: BackgroundStage,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<CameraTransform> {
    let pixels = scene_picture_rect_pixels(
        transform,
        kind,
        fit,
        source_size,
        stage,
        canvas_width,
        canvas_height,
    )?;
    let width = f64::from(canvas_width.max(1));
    let height = f64::from(canvas_height.max(1));
    Some(CameraTransform {
        x: pixels.x as f64 / width,
        y: pixels.y as f64 / height,
        width: f64::from(pixels.width) / width,
        height: f64::from(pixels.height) / height,
    })
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

/// True when a vertical-mode scene frames its screen with
/// `VerticalScreenFraming::Fit` (whole screen visible) instead of the
/// short-form fill law. Horizontal presets never consult the field.
pub fn vertical_screen_fits(layout: &LayoutSettings) -> bool {
    vertical_fill_preset(&layout.layout_preset)
        && matches!(
            layout.vertical_screen_framing,
            crate::protocol::VerticalScreenFraming::Fit
        )
}

/// True when a landscape scene fills its screen (plan 213 G3): the user's
/// `HorizontalScreenFraming::Fill`. Vertical presets never consult the field.
pub fn horizontal_screen_fills(layout: &LayoutSettings) -> bool {
    !layout.layout_preset.is_vertical()
        && matches!(
            layout.horizontal_screen_framing,
            crate::protocol::HorizontalScreenFraming::Fill
        )
}

/// The shared fit policy for source status, FFmpeg filters, CPU blits, and
/// Metal placement. Side-by-side and ALL vertical presets cover their regions
/// (short-form bands are filled, center-cropped — never letterboxed); the
/// horizontal full-frame screen/window presets contain so UI edges are never
/// cropped, unless the user chose Fill for them (plan 213 G3). Vertical BAND cameras cover unconditionally — a contain camera
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
            if vertical_screen_fits(layout) {
                // Fit framing: the whole screen is the content (live screen
                // share). Stacked bands are sized to the screen, so contain
                // only ever shows background when the source is not 16:9.
                SceneFit::Contain
            } else if matches!(layout.layout_preset, LayoutPreset::SideBySide)
                || vertical_fill_preset(&layout.layout_preset)
                || horizontal_screen_fills(layout)
            {
                SceneFit::Cover
            } else {
                SceneFit::Contain
            }
        }
        // The test pattern is synthesised AT the canvas size, so it has no
        // aspect of its own to contain — it covers under every framing.
        SceneSourceKind::TestPattern => SceneFit::Cover,
    }
}

/// Camera masks are overlay policy, not renderer policy. The inset presets
/// (screen+camera) apply the selected bubble shape, and so does Freeform:
/// once the user drags the camera out of a preset it is their own bubble
/// everywhere, not just on the two inset presets it happened to start from.
/// Camera-only and side-by-side stay plain in Preset mode.
pub fn camera_mask(layout: &LayoutSettings) -> SceneMask {
    // Inset presets draw the camera as a shaped bubble regardless of
    // arrangement mode; every other preset keeps the camera rectangular
    // (maskless) in Preset mode, but in Freeform the camera is always the
    // user-owned bubble, so the shape still applies.
    let is_inset_preset = matches!(
        layout.layout_preset,
        LayoutPreset::ScreenCamera | LayoutPreset::VerticalScreenCamera
    );
    if !is_inset_preset && layout.arrangement_mode != ArrangementMode::Freeform {
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

/// Chroma key spec for the camera layer — THE single source every render path
/// (CPU, Metal shader, FFmpeg filter) derives its keying from.
///
/// The keyer works on chroma DIRECTION, not absolute CbCr distance: a pixel
/// keys when the ANGLE between its CbCr vector and the key color's CbCr
/// direction is small, gated by a saturation floor so near-grey pixels never
/// key. The 0.9.39 absolute-distance model could not key real screens: pure
/// `#00FF00` sits at CbCr saturation ~136 while studio-lit screens sit at
/// 35–62, putting their DISTANCE at 75–101 units regardless of hue — above
/// any usable threshold (owner report + numeric repro, 2026-07-14). Angle is
/// lighting-invariant: bright and shadowed screen tones cluster within ~8° of
/// the key direction while subjects sit 90°+ away. The saturation floor
/// scales with luma for the same reason (plan 227, see
/// [`chroma_key_saturation_floor`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChromaKeySpec {
    pub key_rgb: [u8; 3],
    /// Angle (degrees) from the key's chroma direction at/below which a
    /// pixel is fully transparent.
    pub max_angle_deg: f64,
    /// Ramp band (degrees) beyond `max_angle_deg` over which alpha rises
    /// 0→255 (0 = hard cut).
    pub band_deg: f64,
    /// Spill suppression strength, 0..=1.
    pub spill: f64,
    /// Hide edges (plan 227 B): the part of the camera's SOURCE frame the
    /// key keeps. Everything outside is see-through, green or not, so a
    /// curtain or light stand at the frame's edge never shows.
    pub edges: ChromaKeyEdges,
}

/// The largest share of the camera frame Hide edges may take from one side
/// (percent). Mirrored by `CAMERA_KEY_EDGE_MAX_PCT` in the renderer and the
/// RPC contracts.
pub const CAMERA_KEY_EDGE_MAX_PCT: u32 = 25;

/// Hide edges as fractions of the camera's SOURCE frame (texture space,
/// before any mirror): `left`/`top`/`right`/`bottom` are how much of each
/// source side is see-through. The streamer sets them as seen (mirror
/// applied); [`camera_chroma_key`] resolves the mirror once, so every path
/// tests the texel it samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChromaKeyEdges {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl ChromaKeyEdges {
    pub const NONE: Self = Self {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };

    /// The streamer's percents, as seen (clamped to
    /// [`CAMERA_KEY_EDGE_MAX_PCT`] each). Not mirror-resolved.
    pub fn from_as_seen_pct(edges: &crate::protocol::CameraKeyEdges) -> Self {
        let fraction = |pct: u32| f64::from(pct.min(CAMERA_KEY_EDGE_MAX_PCT)) / 100.0;
        Self {
            left: fraction(edges.left_pct),
            top: fraction(edges.top_pct),
            right: fraction(edges.right_pct),
            bottom: fraction(edges.bottom_pct),
        }
    }

    /// The same edges seen through a horizontal mirror.
    pub fn mirrored(self) -> Self {
        Self {
            left: self.right,
            right: self.left,
            ..self
        }
    }

    pub fn is_none(&self) -> bool {
        *self == Self::NONE
    }

    /// The kept box in normalized source coordinates: `[u_min, v_min, u_max,
    /// v_max]` (the shaders' form).
    pub fn kept_uv(&self) -> [f64; 4] {
        [self.left, self.top, 1.0 - self.right, 1.0 - self.bottom]
    }

    /// Whether source texel (`x`, `y`) of a `width`×`height` frame survives;
    /// its centre is tested, like the shaders test the sample position.
    #[inline]
    pub fn keeps_texel(&self, x: u32, y: u32, width: u32, height: u32) -> bool {
        if self.is_none() {
            return true;
        }
        let u = (f64::from(x) + 0.5) / f64::from(width.max(1));
        let v = (f64::from(y) + 0.5) / f64::from(height.max(1));
        self.keeps_uv(u, v)
    }

    #[inline]
    pub fn keeps_uv(&self, u: f64, v: f64) -> bool {
        let [u_min, v_min, u_max, v_max] = self.kept_uv();
        u >= u_min && u <= u_max && v >= v_min && v <= v_max
    }
}

/// Similarity/smoothness percent → degrees. 100% maps to 60°; the default
/// similarity of 40% is a 24° cone — real screen tones cluster within ~8° of
/// the key direction, subjects sit 90°+ away, so defaults key with margin.
const CHROMA_KEY_PCT_TO_DEGREES: f64 = 0.6;

/// Chroma saturation (|CbCr vector|) floor: at or below it a pixel can never
/// key — greys, whites and blacks have no meaningful hue direction. Above it
/// the pixel ramps to fully keyable over `floor × RAMP_RATIO` units.
///
/// Plan 227 (owner recording, 2026-11-11): the floor used to be a fixed 14,
/// and chroma shrinks with brightness, so a green screen in shadow — the
/// right hue, `(1,23,6)` is 16° off the key — has chroma 9–12 and stayed on
/// the picture. The floor now scales with the pixel's luma, so it is
/// lighting-invariant like the angle: `clamp(PER_LUMA × Y, MIN, MAX)`.
/// Mid and bright pixels (Y ≥ ~93) keep the old 14 exactly; near-black
/// subject pixels (a black t-shirt, the mic arm: chroma under 2) stay below
/// `MIN`. The Metal shader and the D3D11 shader mirror all four constants.
pub const CHROMA_KEY_SATURATION_FLOOR_MIN: f64 = 5.0;
pub const CHROMA_KEY_SATURATION_FLOOR_PER_LUMA: f64 = 0.15;
pub const CHROMA_KEY_SATURATION_FLOOR_MAX: f64 = 14.0;
/// The ramp's width as a share of the floor (the old fixed 6 over 14).
pub const CHROMA_KEY_SATURATION_RAMP_RATIO: f64 = 6.0 / 14.0;

/// The four floor constants in shader order: `(min, per_luma, max,
/// ramp_ratio)`.
pub const CHROMA_KEY_SATURATION_FLOOR_PARAMS: [f64; 4] = [
    CHROMA_KEY_SATURATION_FLOOR_MIN,
    CHROMA_KEY_SATURATION_FLOOR_PER_LUMA,
    CHROMA_KEY_SATURATION_FLOOR_MAX,
    CHROMA_KEY_SATURATION_RAMP_RATIO,
];

/// `(floor, ramp)` for a pixel of full-range BT.601 luma `luma` (0..=255).
pub fn chroma_key_saturation_floor(luma: f64) -> (f64, f64) {
    let floor = (CHROMA_KEY_SATURATION_FLOOR_PER_LUMA * luma).clamp(
        CHROMA_KEY_SATURATION_FLOOR_MIN,
        CHROMA_KEY_SATURATION_FLOOR_MAX,
    );
    (floor, floor * CHROMA_KEY_SATURATION_RAMP_RATIO)
}

impl ChromaKeySpec {
    pub fn key_cb(&self) -> f64 {
        rgb_cb_f64(self.key_rgb)
    }

    pub fn key_cr(&self) -> f64 {
        rgb_cr_f64(self.key_rgb)
    }

    /// Unit vector of the key color's chroma direction. `None` when the key
    /// color is (near-)grey — no direction exists and nothing may key.
    pub fn key_direction(&self) -> Option<(f64, f64)> {
        let cb = self.key_cb() - 128.0;
        let cr = self.key_cr() - 128.0;
        let length = (cb * cb + cr * cr).sqrt();
        if length < 1.0 {
            return None;
        }
        Some((cb / length, cr / length))
    }

    /// Which channel spills: blue screens contaminate blue, everything else
    /// (green screens) contaminates green.
    pub fn spill_is_blue(&self) -> bool {
        self.key_rgb[2] > self.key_rgb[1]
    }
}

/// Full-range BT.601 Cb using the same integer coefficient family as
/// `color::rgb_to_yuv_full_range_bt601`, evaluated in f64 so the keyer's ramp
/// is smooth. The Metal shader mirrors these exact coefficients.
fn rgb_cb_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    128.0 + (-43.0 * r - 85.0 * g + 128.0 * b) / 256.0
}

fn rgb_cr_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    128.0 + (128.0 * r - 107.0 * g - 21.0 * b) / 256.0
}

/// Full-range BT.601 Y of the same family (`color.rs`'s 77/150/29), in f64:
/// what the saturation floor scales with. The shaders mirror it.
#[cfg(test)]
fn rgb_luma_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    (77.0 * r + 150.0 * g + 29.0 * b) / 256.0
}

/// Centred CbCr and luma of a colour in 0..=255 units, the same coefficient
/// family as [`rgb_cb_f64`] / [`rgb_cr_f64`] / `rgb_luma_f64`, for the
/// keyer's (possibly averaged, so fractional) colour.
fn key_chroma_and_luma(rgb: [f64; 3]) -> (f64, f64, f64) {
    let [r, g, b] = rgb;
    (
        (-43.0 * r - 85.0 * g + 128.0 * b) / 256.0,
        (128.0 * r - 107.0 * g - 21.0 * b) / 256.0,
        (77.0 * r + 150.0 * g + 29.0 * b) / 256.0,
    )
}

/// Parse `#RRGGBB` (leading `#` optional, case-insensitive).
pub fn parse_hex_rgb(value: &str) -> Option<[u8; 3]> {
    let hex = value.trim().strip_prefix('#').unwrap_or(value.trim());
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some([channel(0..2)?, channel(2..4)?, channel(4..6)?])
}

/// Chroma key is a camera-layer treatment available in EVERY layout with a
/// camera (unlike the bubble mask, which is overlay policy) — a keyed camera
/// over an Assets background is the headline use case. Returns None when off.
pub fn camera_chroma_key(layout: &LayoutSettings) -> Option<ChromaKeySpec> {
    if !layout.camera_chroma_key_enabled {
        return None;
    }
    let key_rgb = parse_hex_rgb(&layout.camera_chroma_key_color).unwrap_or_else(|| {
        tracing::warn!(
            color = %layout.camera_chroma_key_color,
            "Chroma key color is not #RRGGBB; keying against green."
        );
        [0, 255, 0]
    });
    // Hide edges are set as the streamer sees the camera; the CPU, Metal and
    // D3D11 paths sample the unmirrored source, so resolve the mirror here.
    let as_seen = camera_chroma_key_edges_as_seen(layout);
    let edges = if layout.camera_mirror {
        as_seen.mirrored()
    } else {
        as_seen
    };
    Some(ChromaKeySpec {
        key_rgb,
        max_angle_deg: f64::from(layout.camera_chroma_key_similarity_pct.min(100))
            * CHROMA_KEY_PCT_TO_DEGREES,
        band_deg: f64::from(layout.camera_chroma_key_smoothness_pct.min(100))
            * CHROMA_KEY_PCT_TO_DEGREES,
        spill: f64::from(layout.camera_chroma_key_spill_pct.min(100)) / 100.0,
        edges,
    })
}

/// Hide edges as the streamer sees the camera (mirror applied), for paths
/// that mirror BEFORE keying (the FFmpeg leg runs `hflip` first). Every
/// other path uses the mirror-resolved [`ChromaKeySpec::edges`].
pub fn camera_chroma_key_edges_as_seen(layout: &LayoutSettings) -> ChromaKeyEdges {
    ChromaKeyEdges::from_as_seen_pct(&layout.camera_chroma_key_edges)
}

/// Alpha for one colour. Angle model: θ = angle between the colour's CbCr
/// vector and the key direction; 0 at/below `max_angle_deg`, 255 at/above
/// `max_angle_deg + band_deg`, linear ramp between. The luma-scaled saturation
/// floor then pulls low-chroma colours back toward opaque (greys never key).
/// Hide edges are positional, so callers test [`ChromaKeySpec::edges`] with
/// the texel they sampled.
///
/// A picture is keyed through [`chroma_key_alpha_rgb`] on the colour
/// [`chroma_key_neighbourhood_rgb`] smooths (plan 229); this is the same
/// model for one exact colour, the tests' oracle for a flat frame.
#[cfg(test)]
pub fn chroma_key_alpha(spec: &ChromaKeySpec, r: u8, g: u8, b: u8) -> u8 {
    chroma_key_alpha_rgb(spec, [r, g, b].map(f64::from))
}

/// [`chroma_key_alpha`] for a colour in 0..=255 units that may be fractional
/// (the neighbourhood mean). This f64 form is the reference the CPU path
/// calls and the Metal and D3D11 shaders mirror in f32.
pub fn chroma_key_alpha_rgb(spec: &ChromaKeySpec, rgb: [f64; 3]) -> u8 {
    let Some((dir_cb, dir_cr)) = spec.key_direction() else {
        return 255;
    };
    let (cb, cr, luma) = key_chroma_and_luma(rgb);
    let saturation = (cb * cb + cr * cr).sqrt();
    let (floor, ramp) = chroma_key_saturation_floor(luma);
    if saturation <= floor {
        return 255;
    }
    let cos_theta = ((cb * dir_cb + cr * dir_cr) / saturation).clamp(-1.0, 1.0);
    let theta_deg = cos_theta.acos().to_degrees();
    let angle_alpha = if theta_deg <= spec.max_angle_deg {
        0.0
    } else if spec.band_deg <= 0.0 || theta_deg >= spec.max_angle_deg + spec.band_deg {
        255.0
    } else {
        (theta_deg - spec.max_angle_deg) / spec.band_deg * 255.0
    };
    let eligibility = ((saturation - floor) / ramp).clamp(0.0, 1.0);
    (255.0 - eligibility * (255.0 - angle_alpha)).round() as u8
}

/// Plan 229: the key judges a pixel by its neighbourhood, not alone.
///
/// The owner's evening stream on 0.22.0 (2026-11-11) showed "snow": specks
/// of green screen, one or two pixels across, flickering on the picture
/// around the subject. A camera's chroma noise (4:2:0, so one sample per 2×2
/// pixels) swings a sample's hue by a few degrees, and a real chroma-green
/// screen sits 16–20° from `#00FF00`, a few degrees inside the default 24°
/// cone. Each frame some samples crossed the cone, or in shadow dropped
/// under the floor, and stayed on the picture alone. FFmpeg's `chromakey`
/// (the FFmpeg leg) already decides on a 3×3 neighbourhood.
///
/// The key now judges the colour smoothed over a 5×5 binomial,
/// `[1 4 6 4 1]² / 256`, around the sampled texel, and the pixel keeps its
/// own colour (despill still runs on it). A speck of one or two chroma
/// samples keys out with the screen around it, and a lone keyed speck in
/// the subject fills back in. An edge moves by under a third of a pixel on
/// average; a dark subject against a bright screen can lose up to a pixel
/// of outline, the same choke that removes its green fringe.
pub const CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS: [u32; 5] = [1, 4, 6, 4, 1];

/// The shaders' form of [`CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS`]: per axis,
/// three bilinear taps, one on the sample weighing 6/16 and one 1.2 texels
/// out each side weighing 5/16. A tap 1.2 texels out reads the texels one
/// and two out 4:1, so the nine taps are the same `[1 4 6 4 1]²` on the
/// texel grid. The Metal and D3D11 shaders mirror these constants.
pub const CHROMA_KEY_NEIGHBOURHOOD_TAP_OFFSET: f64 = 1.2;
pub const CHROMA_KEY_NEIGHBOURHOOD_SIDE_TAP_WEIGHT: f64 = 5.0 / 16.0;

/// The colour the key judges for source texel (`x`, `y`) of a
/// `width`×`height` frame: the [`CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS`] mean of
/// its 5×5 neighbourhood, in 0..=255 units. Texels past the frame's edge
/// repeat the edge (the shaders' clamp-to-edge sampler). `read` returns a
/// texel's RGB.
///
/// The definition: the CPU blits build it separably for a whole frame
/// (`compositor::KeyJudgedPlane`, pinned to this at every texel) and the
/// shaders reach it with nine bilinear taps.
#[cfg(test)]
pub fn chroma_key_neighbourhood_rgb(
    read: impl Fn(u32, u32) -> [u8; 3],
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> [f64; 3] {
    let clamp_to = |centre: u32, offset: usize, len: u32| -> u32 {
        (i64::from(centre) + offset as i64 - 2).clamp(0, i64::from(len.max(1) - 1)) as u32
    };
    let columns: [u32; 5] = std::array::from_fn(|offset| clamp_to(x, offset, width));
    let rows: [u32; 5] = std::array::from_fn(|offset| clamp_to(y, offset, height));
    let mut sum = [0u32; 3];
    for (row, row_weight) in rows.into_iter().zip(CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS) {
        let mut row_sum = [0u32; 3];
        for (column, weight) in columns.into_iter().zip(CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS) {
            let rgb = read(column, row);
            for channel in 0..3 {
                row_sum[channel] += weight * u32::from(rgb[channel]);
            }
        }
        for channel in 0..3 {
            sum[channel] += row_weight * row_sum[channel];
        }
    }
    sum.map(|total| f64::from(total) / 256.0)
}

/// Plan 233: how many halvings the keyed camera takes before it is drawn.
///
/// The owner's 4K camera in the 720×405 Large slot put 5.3 × 5.3 camera
/// texels under every output pixel, and the key judged one bilinear tap of
/// them per pixel: along the subject's outline a pixel flipped between kept
/// and keyed out with every sub-texel movement, and left green specks in a
/// new place every frame. The keyed picture is now built per camera texel,
/// reduced by averaging 2^L × 2^L blocks (premultiplied), and drawn with one
/// bilinear tap, which leaves a shrink under 2×. `L = floor(log2(camera px
/// per drawn px))` on the axis with the SMALLER ratio, never below 0, so no
/// axis is ever reduced past its drawn size. `source_*` is the camera window
/// the draw reads (after its crop) in texels and `drawn_*` the box it fills
/// in output pixels. The Metal compositor mirrors this (it also builds into
/// the preview helper, which has no `scene_geometry`); a test pins the two.
pub fn chroma_key_reduction_level(
    source_width: f64,
    source_height: f64,
    drawn_width: f64,
    drawn_height: f64,
) -> u32 {
    if !(source_width > 0.0 && source_height > 0.0 && drawn_width > 0.0 && drawn_height > 0.0) {
        return 0;
    }
    let ratio = (source_width / drawn_width).min(source_height / drawn_height);
    if ratio.is_nan() || ratio < 2.0 {
        return 0;
    }
    (ratio.log2().floor() as u32).min(CHROMA_KEY_REDUCTION_LEVEL_MAX)
}

/// The deepest reduction (a 32 × 32 block): the Metal key pass loads one
/// block plus its apron per thread into threadgroup memory, and nothing
/// draws a camera 64 times smaller than it is. The Metal mirror pins it.
pub const CHROMA_KEY_REDUCTION_LEVEL_MAX: u32 = 5;

/// Speck cleanup: the key drops a tiny kept patch that the keyed-out screen
/// surrounds on every side.
///
/// The owner's recording of 2026-11-14 had a teal dot ("a small hole") in the
/// same place on the left of every frame, whatever the background. The raw
/// camera has a blue mark on the green screen there, about 5 × 5 texels of a
/// 4K frame (`(49,109,171)` on a `(35,128,52)` screen). Its judged colour
/// sits far outside the cone, so the key kept it, and the edge despill turned
/// it teal. Nothing the subject brings is that small and that alone: hair and
/// the mic cable reach back to the subject, and the cleanup only removes
/// patches enclosed by keyed-out screen. It never fills holes, so the screen
/// between fingers stays see-through.
///
/// The rule works on CELLS of the keyed picture: a cell is kept when any of
/// its texels has alpha above [`CHROMA_KEY_SPECK_KEPT_ALPHA`]. Around a cell,
/// the RING is the cells exactly [`CHROMA_KEY_SPECK_RING`] cells away
/// (Chebyshev distance); the WINDOW is the cells nearer than that. A cell
/// whose ring holds no kept cell has an enclosed window: nothing kept inside
/// can reach anything outside without crossing the ring. Every cell inside
/// some enclosed window is dropped, so a patch goes whole or not at all. A
/// patch up to ring × cell texels across always goes (12 texels of a 4K
/// camera); up to (2 × ring − 1) cells when it sits well on the grid; never
/// anything bigger.
///
/// The cell is a share of the camera frame, about [`CHROMA_KEY_SPECK_CELL_SHARE`]
/// of its short side (4 texels of a 4K camera, 2 of a 1080p one), in keyed
/// texels at the reduction level (at least 1), so the preview and the
/// recording drop the same patches. Out past the frame counts as kept: what
/// the frame's edge cuts may be part of something bigger, so a patch in the
/// outermost cells always stays, and so does every picture under seven cells
/// across. The Metal key pass mirrors all three constants; a compositor test
/// pins them.
pub const CHROMA_KEY_SPECK_CELL_SHARE: f64 = 1.0 / 540.0;
pub const CHROMA_KEY_SPECK_RING: usize = 3;
pub const CHROMA_KEY_SPECK_KEPT_ALPHA: f64 = 1.0 / 32.0;

/// The speck cleanup's cell side in keyed texels for a `source_width` ×
/// `source_height` camera keyed at `block` × `block` reduction: the share of
/// the short side in camera texels over the block, rounded, at least 1.
pub fn chroma_key_speck_cell(source_width: u32, source_height: u32, block: u32) -> usize {
    let short_side = f64::from(source_width.min(source_height));
    let camera_texels = short_side * CHROMA_KEY_SPECK_CELL_SHARE;
    ((camera_texels / f64::from(block.max(1))).round() as usize).max(1)
}

/// Which keyed texels of a `width` × `height` keyed picture the speck
/// cleanup drops ([`CHROMA_KEY_SPECK_CELL_SHARE`]), from each texel's alpha
/// (`alpha_at(x, y)`, 0..=1) with cells of `cell` × `cell` texels. The CPU
/// keyed plane uses it as is; the Metal key pass mirrors its three steps (kept
/// cells, enclosed windows, dropped cells) in three small kernels.
pub struct ChromaKeySpecks {
    cell: usize,
    cells_width: usize,
    dropped: Vec<bool>,
}

impl ChromaKeySpecks {
    pub fn find(
        width: usize,
        height: usize,
        cell: usize,
        alpha_at: impl Fn(usize, usize) -> f32,
    ) -> Self {
        let cell = cell.max(1);
        let (cells_width, cells_height) = (width.div_ceil(cell), height.div_ceil(cell));
        let threshold = CHROMA_KEY_SPECK_KEPT_ALPHA as f32;
        let mut kept = vec![false; cells_width * cells_height];
        for y in 0..height {
            for x in 0..width {
                if alpha_at(x, y) > threshold {
                    kept[(y / cell) * cells_width + x / cell] = true;
                }
            }
        }
        let ring = CHROMA_KEY_SPECK_RING as isize;
        let inside = |x: isize, y: isize| -> bool {
            x >= 0 && y >= 0 && (x as usize) < cells_width && (y as usize) < cells_height
        };
        // Out past the frame is kept for the ring (it may hide more of the
        // patch) and never an enclosed window.
        let kept_at = |x: isize, y: isize| -> bool {
            !inside(x, y) || kept[y as usize * cells_width + x as usize]
        };
        let mut enclosed = vec![false; cells_width * cells_height];
        for cy in 0..cells_height as isize {
            for cx in 0..cells_width as isize {
                let ring_is_clear = (-ring..=ring).all(|dy| {
                    let step = if dy.abs() == ring {
                        1
                    } else {
                        (2 * ring) as usize
                    };
                    (-ring..=ring)
                        .step_by(step)
                        .all(|dx| !kept_at(cx + dx, cy + dy))
                });
                enclosed[cy as usize * cells_width + cx as usize] = ring_is_clear;
            }
        }
        let reach = ring - 1;
        let mut dropped = vec![false; cells_width * cells_height];
        for cy in 0..cells_height as isize {
            for cx in 0..cells_width as isize {
                dropped[cy as usize * cells_width + cx as usize] = (-reach..=reach).any(|dy| {
                    (-reach..=reach).any(|dx| {
                        let (x, y) = (cx + dx, cy + dy);
                        inside(x, y) && enclosed[y as usize * cells_width + x as usize]
                    })
                });
            }
        }
        Self {
            cell,
            cells_width,
            dropped,
        }
    }

    /// Whether keyed texel (`x`, `y`) is dropped.
    #[inline]
    pub fn drops(&self, x: usize, y: usize) -> bool {
        self.dropped[(y / self.cell) * self.cells_width + x / self.cell]
    }
}

/// Spill suppression on kept pixels: pull the key channel down toward the
/// other channels' max, scaled by `spill`. Only pixels where the key channel
/// DOMINATES both others move, so neutral/yellow/cyan subject tones survive.
///
/// [`chroma_key_despill_rgb`] is the f64 form the keyed plane runs on a level
/// texel's average colour (plan 233); this is the same rule for one 8-bit
/// colour at the spec's strength, the tests' oracle.
#[cfg(test)]
pub fn chroma_key_despill(spec: &ChromaKeySpec, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    if spec.spill <= 0.0 {
        return (r, g, b);
    }
    if spec.spill_is_blue() {
        let limit = r.max(g);
        if b > limit {
            let suppressed = f64::from(b) - spec.spill * f64::from(b - limit);
            return (r, g, suppressed.round() as u8);
        }
    } else {
        let limit = r.max(b);
        if g > limit {
            let suppressed = f64::from(g) - spec.spill * f64::from(g - limit);
            return (r, suppressed.round() as u8, b);
        }
    }
    (r, g, b)
}

/// Despill near the edge (plan 233 D1 a, reworked 2026-11-26).
///
/// The screen throws green light on the subject's outline: hair, ears, the
/// side of the head nearest a lit screen. Spill removal 10 takes only a tenth
/// of it off, so next to the keyed-out area the despill is stronger.
///
/// The owner's recording of 2026-11-26 (a 4K camera drawn full frame) showed
/// a green-olive band along the left of the hair, from the temple to the top
/// of the ear, over a dark background too. Two things let it through:
///
/// - Reach. The proximity was the alpha over a 5×5 binomial at the keyed
///   texture's spacing, about two keyed texels. Drawn full frame a keyed
///   texel is a camera texel, and the spill reached 20–45 camera texels into
///   the hair. Spill is light on the subject, so its reach is a share of the
///   camera frame: the proximity now comes from the alpha of the
///   [`ChromaKeySpillZone`], cells of [`CHROMA_KEY_SPILL_CELL_SHARE`] of the
///   camera's short side, the same at every draw size.
/// - The rule. Green light on brown hair makes it olive: green rises toward
///   red but stays under it (`(71,66,49)` against `(55,38,20)` on the clean
///   side), so the "green above both others" despill never touched it, and
///   the edge strength was gated by the colour's nearness to the key, which
///   is about 0 for olive. Next to the edge, green now comes down toward
///   `max(blue, (red + blue) / 2)` ([`chroma_key_edge_despill_rgb`]): the
///   average of the other two for a warm colour (red at or above blue), blue
///   otherwise, so teal and cyan keep their colour exactly as before.
///
/// Spill removal stays the floor everywhere. A yellow or blond tone within
/// the spill zone warms a little; that is the trade every average despill
/// makes, and only next to the screen. The Metal shader mirrors the gain and
/// the cell.
pub const CHROMA_KEY_EDGE_DESPILL_PROXIMITY_GAIN: f64 = 6.0;

/// The spill zone's cell as a share of the camera's short side (30 camera
/// texels of a 4K frame, 15 of a 1080p one).
pub const CHROMA_KEY_SPILL_CELL_SHARE: f64 = 1.0 / 72.0;

/// The spill zone's cell side in keyed texels for a `source_width` ×
/// `source_height` camera keyed at `block` × `block` reduction: the share of
/// the short side in camera texels over the block, rounded, at least 1.
pub fn chroma_key_spill_cell(source_width: u32, source_height: u32, block: u32) -> usize {
    let short_side = f64::from(source_width.min(source_height));
    let camera_texels = short_side * CHROMA_KEY_SPILL_CELL_SHARE;
    ((camera_texels / f64::from(block.max(1))).round() as usize).max(1)
}

/// How close to the keyed-out area each keyed texel is, from the keyed
/// picture's alpha. The mean alpha of each `cell` × `cell` cell (texels in
/// the frame only), smoothed over the cell grid by `[1 2 1]² / 16` (cells
/// past the grid repeat the edge), read bilinearly at the texel's centre in
/// cell units (clamped to the grid), then
/// `clamp((1 − that) × GAIN, 0, 1)`: full for about two thirds of a cell
/// into the subject, gone by a cell and a half. A one-texel cell (a tiny
/// camera) still reaches the texel next to the edge. The CPU keyed plane uses it as is; the Metal key pass mirrors it
/// (`k_spill_cover`, `k_spill_blur` and the read in `f_key_finish`).
pub struct ChromaKeySpillZone {
    cell: usize,
    cells_width: usize,
    cells_height: usize,
    smoothed: Vec<f32>,
}

impl ChromaKeySpillZone {
    pub fn find(
        width: usize,
        height: usize,
        cell: usize,
        alpha_at: impl Fn(usize, usize) -> f32,
    ) -> Self {
        let cell = cell.max(1);
        let (cells_width, cells_height) =
            (width.div_ceil(cell).max(1), height.div_ceil(cell).max(1));
        let mut means = vec![0.0f32; cells_width * cells_height];
        for (index, mean) in means.iter_mut().enumerate() {
            let (cx, cy) = (index % cells_width, index / cells_width);
            let (x_end, y_end) = (((cx + 1) * cell).min(width), ((cy + 1) * cell).min(height));
            let mut sum = 0.0f32;
            for y in cy * cell..y_end {
                for x in cx * cell..x_end {
                    sum += alpha_at(x, y);
                }
            }
            let count = (x_end.saturating_sub(cx * cell) * y_end.saturating_sub(cy * cell)) as f32;
            *mean = if count > 0.0 { sum / count } else { 1.0 };
        }
        let at = |x: isize, y: isize| -> f32 {
            let x = x.clamp(0, cells_width as isize - 1) as usize;
            let y = y.clamp(0, cells_height as isize - 1) as usize;
            means[y * cells_width + x]
        };
        const WEIGHTS: [f32; 3] = [1.0, 2.0, 1.0];
        let mut smoothed = vec![0.0f32; cells_width * cells_height];
        for (index, out) in smoothed.iter_mut().enumerate() {
            let (cx, cy) = (
                (index % cells_width) as isize,
                (index / cells_width) as isize,
            );
            let mut sum = 0.0f32;
            for (dy, wy) in (-1..=1).zip(WEIGHTS) {
                for (dx, wx) in (-1..=1).zip(WEIGHTS) {
                    sum += wx * wy * at(cx + dx, cy + dy);
                }
            }
            *out = sum / 16.0;
        }
        Self {
            cell,
            cells_width,
            cells_height,
            smoothed,
        }
    }

    /// Keyed texel (`x`, `y`)'s proximity to the keyed-out area, 0..=1.
    pub fn proximity(&self, x: usize, y: usize) -> f32 {
        let cell = self.cell as f32;
        let axis = |texel: usize, cells: usize| -> (usize, usize, f32) {
            let at = ((texel as f32 + 0.5) / cell - 0.5).clamp(0.0, (cells - 1) as f32);
            let first = at.floor() as usize;
            (first, (first + 1).min(cells - 1), at - first as f32)
        };
        let (x0, x1, wx) = axis(x, self.cells_width);
        let (y0, y1, wy) = axis(y, self.cells_height);
        let value = |cx: usize, cy: usize| self.smoothed[cy * self.cells_width + cx];
        let top = value(x0, y0) * (1.0 - wx) + value(x1, y0) * wx;
        let bottom = value(x0, y1) * (1.0 - wx) + value(x1, y1) * wx;
        let alpha = top * (1.0 - wy) + bottom * wy;
        ((1.0 - alpha) * CHROMA_KEY_EDGE_DESPILL_PROXIMITY_GAIN as f32).clamp(0.0, 1.0)
    }
}

/// The colour treatment's despill for a kept colour (0..=255 units, maybe
/// fractional) at `proximity` to the keyed-out area: the larger of Spill
/// removal (`spill`, the key channel toward the other two's max,
/// [`chroma_key_despill_rgb`]) and the edge despill (the key channel toward
/// `max(other, (red + other) / 2)` by `proximity`, where `other` is blue for
/// a green screen and green for a blue one). The Metal shader mirrors it.
pub fn chroma_key_edge_despill_rgb(
    spill_is_blue: bool,
    spill: f64,
    proximity: f64,
    rgb: [f64; 3],
) -> [f64; 3] {
    let [r, g, b] = rgb;
    let (key, other) = if spill_is_blue { (b, g) } else { (g, b) };
    let floor_cut = if key > r.max(other) {
        spill.max(0.0) * (key - r.max(other))
    } else {
        0.0
    };
    let edge_limit = other.max((r + other) / 2.0);
    let edge_cut = if key > edge_limit {
        proximity.clamp(0.0, 1.0) * (key - edge_limit)
    } else {
        0.0
    };
    let key = key - floor_cut.max(edge_cut);
    if spill_is_blue {
        [r, g, key]
    } else {
        [r, key, b]
    }
}

/// [`chroma_key_despill`] for a colour in 0..=255 units that may be
/// fractional (a level texel's average, plan 233) at `strength` in 0..=1:
/// the key channel comes down toward the other two's max by that share,
/// only where it dominates them. The D3D11 shader mirrors it; the keyed
/// plane and the Metal key pass run it inside [`chroma_key_edge_despill_rgb`].
#[cfg(test)]
pub fn chroma_key_despill_rgb(spill_is_blue: bool, strength: f64, rgb: [f64; 3]) -> [f64; 3] {
    if strength <= 0.0 {
        return rgb;
    }
    let [r, g, b] = rgb;
    if spill_is_blue {
        let limit = r.max(g);
        if b > limit {
            return [r, g, b - strength * (b - limit)];
        }
    } else {
        let limit = r.max(b);
        if g > limit {
            return [r, g - strength * (g - limit), b];
        }
    }
    rgb
}

/// Mask geometry over a box that may hang off the canvas (plan 215 E2): the
/// circle or corners belong to the whole box, so a source bigger than the
/// canvas keeps its true shape and the canvas edge cuts the shape, not the
/// other way round. An on-canvas [`PixelRect`] converts; the f64s are the
/// same ones as before for it.
pub fn circle_geometry(rect: impl Into<SignedPixelRect>) -> CircleGeometry {
    let rect = rect.into();
    CircleGeometry {
        center_x: rect.x as f64 + f64::from(rect.width) / 2.0,
        center_y: rect.y as f64 + f64::from(rect.height) / 2.0,
        radius: f64::from(rect.width.min(rect.height)) / 2.0,
    }
}

pub fn rounded_rect_geometry(
    rect: impl Into<SignedPixelRect>,
    radius_pct: u32,
) -> RoundedRectGeometry {
    let rect = rect.into();
    let radius = f64::from(rect.width.min(rect.height)) * f64::from(radius_pct.min(50)) / 100.0;
    RoundedRectGeometry {
        center_x: rect.x as f64 + f64::from(rect.width) / 2.0,
        center_y: rect.y as f64 + f64::from(rect.height) / 2.0,
        radius,
        inner_half_width: (f64::from(rect.width) / 2.0 - radius).max(0.0),
        inner_half_height: (f64::from(rect.height) / 2.0 - radius).max(0.0),
    }
}

/// The single-pixel mask test. Per-pixel loops build a `SceneMaskTester` once
/// instead (plan 191); this is the same tester, so there is one rule.
#[cfg(test)]
pub fn scene_mask_allows(
    mask: SceneMask,
    rect: impl Into<SignedPixelRect>,
    x: usize,
    y: usize,
) -> bool {
    SceneMaskTester::new(mask, rect).allows(x, y)
}

/// A `SceneMask` resolved against one destination rect (plan 191): the circle
/// or rounded-rect geometry, f64 divisions included, is derived once in `new`
/// instead of for every pixel. `allows` runs the same f64 operations in the
/// same order as the per-pixel rule always did, so results are bit-identical.
#[derive(Debug, Clone, Copy)]
pub enum SceneMaskTester {
    None,
    Circle(CircleGeometry),
    Rounded(RoundedRectGeometry),
}

impl SceneMaskTester {
    pub fn new(mask: SceneMask, rect: impl Into<SignedPixelRect>) -> Self {
        let rect = rect.into();
        match mask {
            SceneMask::None => Self::None,
            SceneMask::Circle => Self::Circle(circle_geometry(rect)),
            SceneMask::Rounded { radius_pct } => {
                Self::Rounded(rounded_rect_geometry(rect, radius_pct))
            }
        }
    }

    /// Whether the pixel at canvas `(x, y)` survives; its centre is tested.
    #[inline]
    pub fn allows(&self, x: usize, y: usize) -> bool {
        match *self {
            Self::None => true,
            Self::Circle(geometry) => {
                if geometry.radius <= 0.0 {
                    return false;
                }
                let dx = x as f64 + 0.5 - geometry.center_x;
                let dy = y as f64 + 0.5 - geometry.center_y;
                dx * dx + dy * dy <= geometry.radius * geometry.radius
            }
            Self::Rounded(geometry) => {
                if geometry.radius <= 0.0 {
                    return true;
                }
                let qx = ((x as f64 + 0.5 - geometry.center_x).abs() - geometry.inner_half_width)
                    .max(0.0);
                let qy = ((y as f64 + 0.5 - geometry.center_y).abs() - geometry.inner_half_height)
                    .max(0.0);
                qx * qx + qy * qy <= geometry.radius * geometry.radius
            }
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

/// Smallest canvas fraction a custom (free-resized) camera box may keep per
/// axis. Mirrors the stage's MIN_SOURCE_FRACTION in
/// `apps/desktop/src/renderer/src/components/scene/stage-transform.ts`.
pub(crate) const MIN_CUSTOM_CAMERA_FRACTION: f64 = 0.05;

pub fn resolved_camera_transform(
    layout: &LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let mut transform = preset_camera_transform(layout, output_width, output_height);
    if let (CameraTransformMode::Custom, Some(custom)) =
        (layout.camera_transform_mode, layout.camera_transform)
    {
        // Free resize: a custom transform overrides the S/M/L preset box.
        // The camera's aspect LAW still holds — circle boxes stay square and
        // square/portrait aspects keep their pixel ratio — because every
        // render path derives its mask/crop from this one box.
        let (width, height) =
            custom_camera_box_fractions(layout, custom, &transform, output_width, output_height);
        transform.width = width;
        transform.height = height;
        transform.x = finite_or_zero(custom.x).clamp(0.0, (1.0 - transform.width).max(0.0));
        transform.y = finite_or_zero(custom.y).clamp(0.0, (1.0 - transform.height).max(0.0));
    }
    transform
}

/// The normalized box a custom camera transform resolves to. Non-finite or
/// non-positive sizes (legacy custom transforms carried position only in
/// spirit; the wire always had width/height) fall back to the preset box.
/// Shaped cameras (circle, forced square/portrait aspect) keep their pixel
/// ratio: the requested width drives and the height follows, clamped so both
/// axes stay within [5%, 100%] of the canvas.
pub(crate) fn custom_camera_box_fractions(
    layout: &LayoutSettings,
    custom: crate::protocol::CameraTransform,
    preset: &SceneTransform,
    output_width: u32,
    output_height: u32,
) -> (f64, f64) {
    let output_width = f64::from(output_width.max(1));
    let output_height = f64::from(output_height.max(1));
    let min = MIN_CUSTOM_CAMERA_FRACTION;
    let requested_width = if custom.width.is_finite() && custom.width > 0.0 {
        custom.width
    } else {
        preset.width
    };
    let requested_height = if custom.height.is_finite() && custom.height > 0.0 {
        custom.height
    } else {
        preset.height
    };

    // Pixel width : height the mask law enforces, or None for a free box.
    let forced_ratio = match (&layout.camera_shape, &layout.camera_aspect) {
        (CameraShape::Circle, _) => Some(1.0),
        (_, CameraAspect::Square) => Some(1.0),
        (_, CameraAspect::Portrait) => Some(3.0 / 4.0),
        (_, CameraAspect::Source) => None,
    };
    let Some(ratio) = forced_ratio else {
        return (
            requested_width.clamp(min, 1.0),
            requested_height.clamp(min, 1.0),
        );
    };

    let mut width_px = requested_width.clamp(min, 1.0) * output_width;
    let min_width_px = (min * output_width).max(min * output_height * ratio);
    let max_width_px = output_width.min(output_height * ratio);
    width_px = width_px.clamp(min_width_px, max_width_px.max(min_width_px));
    (width_px / output_width, (width_px / ratio) / output_height)
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

/// A box origin in canvas pixels, signed, within the protocol's position
/// bounds (so a malformed transform cannot ask for a box light-years off).
fn normalized_to_signed_pixel(value: f64, span: u32) -> i64 {
    (finite_or_zero(value).clamp(MIN_SOURCE_POSITION_FRACTION, MAX_SOURCE_POSITION_FRACTION)
        * f64::from(span))
    .round() as i64
}

/// A box side in canvas pixels, at least one and at most the protocol's 400%.
fn normalized_to_span(value: f64, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, MAX_SOURCE_SIZE_FRACTION) * f64::from(span))
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
    use crate::protocol::{SideBySideCameraSide, default_layout_settings};

    fn layout() -> LayoutSettings {
        default_layout_settings()
    }

    #[test]
    fn talk_show_chroma_vectors_match_native_alpha_and_despill() {
        #[derive(serde::Deserialize)]
        struct Expected {
            alpha: u8,
            rgb: [u8; 3],
        }
        #[derive(serde::Deserialize)]
        struct Vector {
            name: String,
            rgb: [u8; 3],
            settings: serde_json::Value,
            expected: Expected,
        }
        let vectors: Vec<Vector> = serde_json::from_str(include_str!(
            "../../../apps/desktop/src/shared/chroma-key-vectors.json"
        ))
        .unwrap();
        for vector in vectors {
            let mut settings = serde_json::to_value(layout()).unwrap();
            for (key, value) in vector.settings.as_object().unwrap() {
                settings[key] = value.clone();
            }
            let settings: LayoutSettings = serde_json::from_value(settings).unwrap();
            let spec = camera_chroma_key(&settings).unwrap();
            let [r, g, b] = vector.rgb;
            assert!(
                chroma_key_alpha(&spec, r, g, b).abs_diff(vector.expected.alpha) <= 1,
                "{} alpha",
                vector.name
            );
            let (r, g, b) = chroma_key_despill(&spec, r, g, b);
            for (actual, expected) in [r, g, b].into_iter().zip(vector.expected.rgb) {
                assert!(actual.abs_diff(expected) <= 1, "{} spill", vector.name);
            }
        }
    }

    /// Plan 216 B1: the shared fixture pins the Rust picture rect to the TS
    /// `scenePictureRectPixels`, within a pixel, case for case.
    #[test]
    fn picture_rect_reproduces_the_shared_fixture() {
        #[derive(serde::Deserialize)]
        struct FixtureSize {
            width: u32,
            height: u32,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCrop {
            #[serde(default)]
            crop_left: f64,
            #[serde(default)]
            crop_top: f64,
            #[serde(default)]
            crop_right: f64,
            #[serde(default)]
            crop_bottom: f64,
        }
        #[derive(serde::Deserialize)]
        struct FixtureRect {
            x: i64,
            y: i64,
            width: i64,
            height: i64,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCase {
            name: String,
            frame: CameraTransform,
            kind: SceneSourceKind,
            fit: String,
            source: Option<FixtureSize>,
            crop: Option<FixtureCrop>,
            #[serde(default)]
            stage_margin: f64,
            /// The scene the source sits in (plan 235 D9 a). Without it the
            /// camera is not on the stage.
            scene: Option<FixtureScene>,
            canvas: FixtureSize,
            expected: FixtureRect,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureScene {
            source_kinds: Vec<SceneSourceKind>,
            #[serde(default)]
            camera_keyed: bool,
            #[serde(default)]
            freeform: bool,
            camera_on_stage: bool,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            schema_version: u32,
            cases: Vec<FixtureCase>,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/scene-picture-geometry.json"
        ))
        .expect("protocol-fixtures/scene-picture-geometry.json is valid JSON");
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.cases.len() >= 12);
        let scene_cases = fixture
            .cases
            .iter()
            .filter(|case| case.scene.is_some())
            .count();
        assert!(scene_cases >= 7, "plan 235's stage cases: {scene_cases}");
        for case in fixture.cases {
            let camera = case.scene.as_ref().is_some_and(|scene| {
                let camera = camera_uses_background_stage(
                    &scene.source_kinds,
                    scene.freeform,
                    scene.camera_keyed,
                );
                assert_eq!(
                    camera, scene.camera_on_stage,
                    "{}: whether the camera sits on the stage",
                    case.name
                );
                camera
            });
            let stage = BackgroundStage {
                margin: case.stage_margin,
                camera,
            };
            let crop = case.crop.unwrap_or(FixtureCrop {
                crop_left: 0.0,
                crop_top: 0.0,
                crop_right: 0.0,
                crop_bottom: 0.0,
            });
            let transform = SceneTransform {
                x: case.frame.x,
                y: case.frame.y,
                width: case.frame.width,
                height: case.frame.height,
                crop_left: crop.crop_left,
                crop_top: crop.crop_top,
                crop_right: crop.crop_right,
                crop_bottom: crop.crop_bottom,
            };
            let fit = match case.fit.as_str() {
                "contain" => SceneFit::Contain,
                "cover" => SceneFit::Cover,
                other => panic!("{}: unknown fit {other}", case.name),
            };
            let pixels = scene_picture_rect_pixels(
                &transform,
                &case.kind,
                fit,
                case.source.as_ref().map(|size| (size.width, size.height)),
                stage,
                case.canvas.width,
                case.canvas.height,
            )
            .unwrap_or_else(|| panic!("{}: no picture rect", case.name));
            let within = |actual: i64, expected: i64, what: &str| {
                assert!(
                    (actual - expected).abs() <= 1,
                    "{}: {what} {actual} vs {expected}",
                    case.name
                );
            };
            within(pixels.x, case.expected.x, "x");
            within(pixels.y, case.expected.y, "y");
            within(i64::from(pixels.width), case.expected.width, "width");
            within(i64::from(pixels.height), case.expected.height, "height");
            // The fraction form is the pixel form over the canvas.
            let fraction = scene_picture_rect(
                &transform,
                &case.kind,
                fit,
                case.source.as_ref().map(|size| (size.width, size.height)),
                stage,
                case.canvas.width,
                case.canvas.height,
            )
            .unwrap();
            within(
                (fraction.x * f64::from(case.canvas.width)).round() as i64,
                case.expected.x,
                "fraction x",
            );
            within(
                (fraction.width * f64::from(case.canvas.width)).round() as i64,
                case.expected.width,
                "fraction width",
            );
        }
    }

    /// The streamer's numbers (plan 216): a 2228x1440 display Fit in a
    /// 16:9 frame of 2321x1306 px at 9.3% is about 2021 px wide, at x 0.152.
    #[test]
    fn picture_rect_is_the_fitted_picture_not_the_frame() {
        let frame = SceneTransform {
            x: 0.0932,
            y: 0.0932,
            width: 0.9068,
            height: 0.9068,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };
        let picture = scene_picture_rect(
            &frame,
            &SceneSourceKind::Screen,
            SceneFit::Contain,
            Some((2228, 1440)),
            BackgroundStage::NONE,
            2560,
            1440,
        )
        .unwrap();
        assert!((picture.x - 0.152).abs() < 0.001, "{picture:?}");
        assert!((picture.width - 0.789).abs() < 0.001, "{picture:?}");
        assert!((picture.y - frame.y).abs() < 0.001, "{picture:?}");
        // Fill, an unknown size and the test pattern give the frame.
        for (fit, kind, size) in [
            (SceneFit::Cover, SceneSourceKind::Screen, Some((2228, 1440))),
            (SceneFit::Contain, SceneSourceKind::Screen, None),
            (
                SceneFit::Cover,
                SceneSourceKind::TestPattern,
                Some((2560, 1440)),
            ),
        ] {
            let rect = scene_picture_rect_pixels(
                &frame,
                &kind,
                fit,
                size,
                BackgroundStage::NONE,
                2560,
                1440,
            )
            .unwrap();
            assert_eq!(
                rect,
                scene_source_rect_pixels(&frame, 2560, 1440).unwrap(),
                "{kind:?} {fit:?}"
            );
        }
        // A scene background's margin moves the screen's picture. The camera's
        // moves only when the scene puts the camera on the stage (plan 235).
        let screens = BackgroundStage {
            margin: 0.1,
            camera: false,
        };
        let staged = scene_picture_rect_pixels(
            &frame,
            &SceneSourceKind::Screen,
            SceneFit::Contain,
            Some((2228, 1440)),
            screens,
            2560,
            1440,
        )
        .unwrap();
        assert_eq!(
            scene_source_render_transform(&frame, &SceneSourceKind::Camera, screens),
            frame
        );
        let camera_staged = scene_source_render_transform(
            &frame,
            &SceneSourceKind::Camera,
            BackgroundStage {
                margin: 0.1,
                camera: true,
            },
        );
        assert_eq!(
            camera_staged,
            scene_source_render_transform(&frame, &SceneSourceKind::Screen, screens)
        );
        let expected = scene_source_render_transform(&frame, &SceneSourceKind::Screen, screens);
        let expected = contain_rect_pixels(
            2228.0,
            1440.0,
            scene_source_rect_pixels(&expected, 2560, 1440).unwrap(),
        );
        assert_eq!(staged, expected);
    }

    #[test]
    fn horizontal_fill_covers_the_landscape_screen_scenes_only() {
        // Plan 213 G3: Fill makes the landscape screen scenes cover; the
        // default stays Fit (contain), side by side always covers, and a
        // vertical scene ignores the landscape field.
        use crate::protocol::HorizontalScreenFraming;
        assert_eq!(
            layout().horizontal_screen_framing,
            HorizontalScreenFraming::Fit
        );
        for preset in [LayoutPreset::ScreenCamera, LayoutPreset::ScreenOnly] {
            for freeform in [false, true] {
                let mut layout = layout();
                layout.layout_preset = preset.clone();
                if freeform {
                    layout.arrangement_mode = ArrangementMode::Freeform;
                }
                for kind in [SceneSourceKind::Screen, SceneSourceKind::Window] {
                    assert_eq!(scene_source_fit(&kind, &layout), SceneFit::Contain);
                    layout.horizontal_screen_framing = HorizontalScreenFraming::Fill;
                    assert_eq!(
                        scene_source_fit(&kind, &layout),
                        SceneFit::Cover,
                        "{preset:?}"
                    );
                    layout.horizontal_screen_framing = HorizontalScreenFraming::Fit;
                }
                // The camera keeps its own Fit choice.
                layout.horizontal_screen_framing = HorizontalScreenFraming::Fill;
                layout.camera_fit = CameraFit::Fit;
                assert_eq!(
                    scene_source_fit(&SceneSourceKind::Camera, &layout),
                    SceneFit::Contain
                );
            }
        }
        let mut side_by_side = layout();
        side_by_side.layout_preset = LayoutPreset::SideBySide;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &side_by_side),
            SceneFit::Cover
        );
        let mut vertical = layout();
        vertical.layout_preset = LayoutPreset::VerticalScreenOnly;
        vertical.vertical_screen_framing = crate::protocol::VerticalScreenFraming::Fit;
        vertical.horizontal_screen_framing = HorizontalScreenFraming::Fill;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &vertical),
            SceneFit::Contain,
            "a vertical scene reads only its own framing"
        );
    }

    #[test]
    fn fit_framing_contains_the_screen_in_every_vertical_preset_only() {
        use crate::protocol::VerticalScreenFraming;
        for preset in [
            LayoutPreset::VerticalCameraTop,
            LayoutPreset::VerticalCameraBottom,
            LayoutPreset::VerticalSplit,
            LayoutPreset::VerticalScreenCamera,
            LayoutPreset::VerticalScreenOnly,
        ] {
            let mut layout = layout();
            layout.layout_preset = preset.clone();
            layout.vertical_screen_framing = VerticalScreenFraming::Fit;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::TestPattern, &layout),
                SceneFit::Cover,
                "the canvas-sized test pattern has nothing to contain"
            );
            for kind in [SceneSourceKind::Screen, SceneSourceKind::Window] {
                assert_eq!(
                    scene_source_fit(&kind, &layout),
                    SceneFit::Contain,
                    "{preset:?} {kind:?} must show the whole screen under fit"
                );
            }
            // The default stays the short-form fill law.
            layout.vertical_screen_framing = VerticalScreenFraming::Fill;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Screen, &layout),
                SceneFit::Cover
            );
        }

        // Band cameras keep covering under fit: the camera fills whatever the
        // screen leaves, so the canvas never shows a dead band.
        let mut stacked = layout();
        stacked.layout_preset = LayoutPreset::VerticalCameraBottom;
        stacked.vertical_screen_framing = VerticalScreenFraming::Fit;
        stacked.camera_fit = CameraFit::Fit;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Camera, &stacked),
            SceneFit::Cover
        );

        // Horizontal presets never consult the field.
        let mut side_by_side = layout();
        side_by_side.layout_preset = LayoutPreset::SideBySide;
        side_by_side.vertical_screen_framing = VerticalScreenFraming::Fit;
        assert!(!vertical_screen_fits(&side_by_side));
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &side_by_side),
            SceneFit::Cover
        );
        assert_eq!(
            scene_source_fit(&SceneSourceKind::TestPattern, &side_by_side),
            SceneFit::Cover
        );
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
    fn camera_mask_applies_in_freeform_for_any_preset_but_not_preset_side_by_side() {
        // Freeform is the user-owned bubble everywhere: once the camera is
        // dragged out of a preset, the mask shape applies regardless of which
        // preset it was entered from. Preset mode keeps the existing rule
        // (SideBySide stays maskless).
        let mut side_by_side_preset = layout();
        side_by_side_preset.layout_preset = LayoutPreset::SideBySide;
        side_by_side_preset.camera_shape = CameraShape::Circle;
        assert_eq!(
            camera_mask(&side_by_side_preset),
            SceneMask::None,
            "Preset SideBySide stays maskless"
        );

        let mut side_by_side_freeform = side_by_side_preset.clone();
        side_by_side_freeform.arrangement_mode = ArrangementMode::Freeform;
        assert_eq!(
            camera_mask(&side_by_side_freeform),
            SceneMask::Circle,
            "Freeform entered from SideBySide still shows the selected Circle"
        );

        let mut side_by_side_rounded = side_by_side_freeform.clone();
        side_by_side_rounded.camera_shape = CameraShape::Rounded;
        side_by_side_rounded.camera_corner_radius_pct = 20;
        assert_eq!(
            camera_mask(&side_by_side_rounded),
            SceneMask::Rounded { radius_pct: 20 },
            "Freeform Rounded also applies regardless of preset"
        );
    }

    #[test]
    fn parse_hex_rgb_accepts_rrggbb_with_or_without_hash() {
        assert_eq!(parse_hex_rgb("#00FF00"), Some([0, 255, 0]));
        assert_eq!(parse_hex_rgb("00b4ff"), Some([0, 180, 255]));
        assert_eq!(parse_hex_rgb(" #0000FF "), Some([0, 0, 255]));
        assert_eq!(parse_hex_rgb("#0F0"), None);
        assert_eq!(parse_hex_rgb("#GGHHII"), None);
        assert_eq!(parse_hex_rgb(""), None);
    }

    #[test]
    fn camera_chroma_key_is_off_by_default_and_ignores_preset() {
        assert_eq!(camera_chroma_key(&layout()), None);
        // Unlike the bubble mask, keying is NOT overlay policy: any layout
        // that renders a camera keys it (virtual set over a background).
        for preset in [
            LayoutPreset::ScreenCamera,
            LayoutPreset::CameraOnly,
            LayoutPreset::SideBySide,
            LayoutPreset::VerticalCameraOnly,
        ] {
            let mut layout = layout();
            layout.layout_preset = preset;
            layout.camera_chroma_key_enabled = true;
            let spec = camera_chroma_key(&layout).expect("keying enabled");
            assert_eq!(spec.key_rgb, [0, 255, 0]);
            assert_eq!(spec.max_angle_deg, 40.0 * 0.6);
            assert_eq!(spec.band_deg, 8.0 * 0.6);
            assert_eq!(spec.spill, 0.10);
        }
    }

    #[test]
    fn camera_chroma_key_clamps_percents_and_falls_back_to_green() {
        let mut layout = layout();
        layout.camera_chroma_key_enabled = true;
        layout.camera_chroma_key_color = "chartreuse".to_string();
        layout.camera_chroma_key_similarity_pct = 900;
        layout.camera_chroma_key_smoothness_pct = 900;
        layout.camera_chroma_key_spill_pct = 900;
        let spec = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!(spec.key_rgb, [0, 255, 0], "unparseable color keys green");
        assert_eq!(spec.max_angle_deg, 60.0);
        assert_eq!(spec.band_deg, 60.0);
        assert_eq!(spec.spill, 1.0);
    }

    #[test]
    fn chroma_key_cbcr_matches_the_integer_color_path_within_rounding() {
        // The keyer's f64 CbCr and color.rs's integer-shift YUV share one
        // coefficient family; if they drift the CPU key and the encoded frame
        // disagree about what "green" is.
        for rgb in [[0, 255, 0], [0, 0, 255], [255, 0, 0], [60, 180, 70]] {
            let (_, u, v) = crate::color::rgb_to_yuv_full_range_bt601(rgb[0], rgb[1], rgb[2]);
            assert!(
                (rgb_cb_f64(rgb) - f64::from(u)).abs() <= 1.0,
                "cb drift for {rgb:?}"
            );
            assert!(
                (rgb_cr_f64(rgb) - f64::from(v)).abs() <= 1.0,
                "cr drift for {rgb:?}"
            );
        }
    }

    fn default_green_spec() -> ChromaKeySpec {
        ChromaKeySpec {
            key_rgb: [0, 255, 0],
            max_angle_deg: 24.0,
            band_deg: 4.8,
            spill: 0.0,
            edges: ChromaKeyEdges::NONE,
        }
    }

    /// Plan 227 S0, the owner's recording (2026-11-11, raw camera take): the
    /// green screen falls into deep shadow in the bottom corners. These are
    /// its real tones — 13–17° from the key, chroma 9–25 — and they must key
    /// with the shipped defaults. The fixed floor of 14 kept them all.
    #[test]
    fn chroma_key_keys_a_deep_shadowed_screen() {
        let spec = default_green_spec();
        for (label, rgb) in [
            ("bottom-right deep shadow", [1u8, 23, 6]),
            ("bottom-right shadow", [0, 26, 9]),
            ("bottom-right fold", [3, 22, 9]),
            ("bottom-right corner", [1, 25, 6]),
            ("bottom-right mean", [1, 34, 12]),
            ("left-edge shadow", [8, 32, 13]),
            ("bottom-left mean", [4, 56, 20]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                0,
                "{label} {rgb:?} must key with defaults"
            );
        }
    }

    /// Plan 227 S0: the same recording's near-black SUBJECT and the real
    /// curtain at the frame's edge. Their chroma is under 4 and every one of
    /// them must stay opaque, or the t-shirt and the mic arm get holes.
    #[test]
    fn chroma_key_keeps_near_black_subjects() {
        let spec = default_green_spec();
        for (label, rgb) in [
            ("black t-shirt", [27u8, 23, 25]),
            ("mic arm", [6, 9, 6]),
            ("mic arm shadow", [1, 4, 1]),
            ("near-black codec noise", [2, 7, 3]),
            ("t-shirt with green spill", [10, 18, 12]),
            ("curtain strip", [17, 19, 16]),
            ("curtain black", [6, 6, 6]),
            ("pure black", [0, 0, 0]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                255,
                "{label} {rgb:?} must survive with defaults"
            );
        }
    }

    /// Plan 233: the level just above the drawn size, on the axis with the
    /// smaller ratio, never below 0.
    #[test]
    fn chroma_key_reduction_level_is_the_power_of_two_just_above_the_slot() {
        // The owner's 4K camera in the 720×405 Large slot: 5.3× → level 2.
        assert_eq!(chroma_key_reduction_level(3840.0, 2160.0, 720.0, 405.0), 2);
        // The same camera in the Preview's 480-wide slot: 8× exactly → 3.
        assert_eq!(chroma_key_reduction_level(3840.0, 2160.0, 480.0, 270.0), 3);
        // A 1080p camera in the Large slot: 2.67× → 1.
        assert_eq!(chroma_key_reduction_level(1920.0, 1080.0, 720.0, 405.0), 1);
        // 1:1, an upscale, or a shrink under 2× stay at level 0.
        assert_eq!(
            chroma_key_reduction_level(1920.0, 1080.0, 1920.0, 1080.0),
            0
        );
        assert_eq!(chroma_key_reduction_level(1280.0, 720.0, 1920.0, 1080.0), 0);
        assert_eq!(chroma_key_reduction_level(1920.0, 1080.0, 1000.0, 563.0), 0);
        // The smaller ratio decides: 3.84× across, 5.3× down → 1.
        assert_eq!(chroma_key_reduction_level(3840.0, 2160.0, 1000.0, 405.0), 1);
        // The deepest level is 5, a 32 × 32 block.
        assert_eq!(
            chroma_key_reduction_level(3840.0, 2160.0, 10.0, 6.0),
            CHROMA_KEY_REDUCTION_LEVEL_MAX
        );
        // Degenerate sizes never reduce.
        assert_eq!(chroma_key_reduction_level(0.0, 2160.0, 720.0, 405.0), 0);
        assert_eq!(chroma_key_reduction_level(3840.0, 2160.0, 0.0, 405.0), 0);
        assert_eq!(
            chroma_key_reduction_level(f64::NAN, 2160.0, 720.0, 405.0),
            0
        );
    }

    /// The speck cleanup's cell is about 1/540 of the camera's short side,
    /// in keyed texels at the reduction level, never under one.
    #[test]
    fn chroma_key_speck_cell_is_a_share_of_the_short_side() {
        assert_eq!(chroma_key_speck_cell(3840, 2160, 1), 4, "4K at 1:1");
        assert_eq!(chroma_key_speck_cell(3840, 2160, 2), 2);
        assert_eq!(
            chroma_key_speck_cell(3840, 2160, 4),
            1,
            "4K in the Large slot"
        );
        assert_eq!(chroma_key_speck_cell(3840, 2160, 32), 1);
        assert_eq!(chroma_key_speck_cell(1920, 1080, 1), 2, "1080p at 1:1");
        assert_eq!(chroma_key_speck_cell(1280, 720, 1), 1);
        assert_eq!(
            chroma_key_speck_cell(1080, 1920, 1),
            2,
            "portrait: short side"
        );
        assert_eq!(chroma_key_speck_cell(0, 0, 0), 1);
    }

    /// A keyed picture as alpha rows, 0 = keyed out.
    struct AlphaGrid {
        width: usize,
        alpha: Vec<f32>,
    }

    impl AlphaGrid {
        fn new(width: usize, height: usize) -> Self {
            Self {
                width,
                alpha: vec![0.0; width * height],
            }
        }

        fn fill(&mut self, xs: std::ops::Range<usize>, ys: std::ops::Range<usize>, alpha: f32) {
            for y in ys {
                for x in xs.clone() {
                    self.alpha[y * self.width + x] = alpha;
                }
            }
        }

        fn specks(&self, cell: usize) -> ChromaKeySpecks {
            let height = self.alpha.len() / self.width;
            ChromaKeySpecks::find(self.width, height, cell, |x, y| {
                self.alpha[y * self.width + x]
            })
        }
    }

    fn dropped_in(
        specks: &ChromaKeySpecks,
        xs: std::ops::Range<usize>,
        ys: std::ops::Range<usize>,
    ) -> usize {
        ys.flat_map(|y| xs.clone().map(move |x| (x, y)))
            .filter(|&(x, y)| specks.drops(x, y))
            .count()
    }

    /// The owner's speck (2026-11-14): a 5 × 5 patch alone on the screen
    /// goes, and so do a 12 × 12 patch (ring × cell, the size that always
    /// goes) and a speck one cell in from the frame's edge. The subject, a
    /// blob bigger than a window, thin strands (straight and diagonal) that
    /// reach back to the subject, a dot right next to the subject and a speck
    /// the frame's edge cuts all stay.
    #[test]
    fn chroma_key_specks_drop_lone_patches_and_keep_what_reaches_the_subject() {
        let (width, height, cell) = (160, 96, 4);
        let mut grid = AlphaGrid::new(width, height);
        grid.fill(112..160, 0..96, 1.0); // the subject
        grid.fill(20..25, 60..65, 1.0); // the owner's speck
        grid.fill(20..44, 8..32, 1.0); // a blob bigger than a window
        grid.fill(70..82, 20..32, 0.8); // ring × cell across
        grid.fill(0..3, 0..3, 1.0); // a speck the frame's corner cuts
        grid.fill(5..8, 86..89, 1.0); // a speck one cell in from the edge
        grid.fill(50..112, 80..81, 0.5); // a one-texel strand to the subject
        for step in 0..30 {
            grid.fill(111 - step..112 - step, 50 + step..51 + step, 1.0); // diagonal
        }
        grid.fill(108..110, 8..10, 1.0); // a dot two texels off the subject
        let specks = grid.specks(cell);
        assert_eq!(dropped_in(&specks, 20..25, 60..65), 25, "the owner's speck");
        assert_eq!(dropped_in(&specks, 70..82, 20..32), 144, "ring × cell");
        assert_eq!(dropped_in(&specks, 5..8, 86..89), 9, "one cell in");
        assert_eq!(dropped_in(&specks, 0..3, 0..3), 0, "the corner speck");
        assert_eq!(dropped_in(&specks, 112..160, 0..96), 0, "the subject");
        assert_eq!(dropped_in(&specks, 20..44, 8..32), 0, "the blob");
        assert_eq!(dropped_in(&specks, 50..112, 80..81), 0, "the strand");
        for step in 0..30 {
            assert!(
                !specks.drops(111 - step, 50 + step),
                "the diagonal strand at step {step}"
            );
        }
        assert_eq!(
            dropped_in(&specks, 108..110, 8..10),
            0,
            "the dot by the subject"
        );
    }

    /// A patch goes whole or not at all: 16 texels across (4 cells) fit
    /// one enclosed window and go whole even with the subject close on one
    /// side; 24 across (6 cells) fit no window, and no part of them goes.
    #[test]
    fn chroma_key_specks_drop_a_patch_whole_or_not_at_all() {
        let (width, height, cell) = (128, 64, 4);
        let mut fits = AlphaGrid::new(width, height);
        fits.fill(60..128, 0..64, 1.0);
        fits.fill(40..56, 30..34, 1.0);
        assert_eq!(dropped_in(&fits.specks(cell), 40..56, 30..34), 64);
        let mut too_wide = AlphaGrid::new(width, height);
        too_wide.fill(100..128, 0..64, 1.0);
        too_wide.fill(40..64, 30..34, 1.0);
        assert_eq!(dropped_in(&too_wide.specks(cell), 40..64, 30..34), 0);
    }

    /// Faint texels (alpha at or under 1/32) never keep a cell, so they never
    /// shield a speck; a fully kept picture and one under seven cells across
    /// (the old fixtures' tiny cameras) are left as they are.
    #[test]
    fn chroma_key_specks_ignore_faint_texels_and_flat_pictures() {
        let mut grid = AlphaGrid::new(64, 64);
        grid.fill(30..34, 30..34, 1.0);
        // A faint row through the speck's ring (cell row 12 of 2-texel cells).
        grid.fill(0..64, 24..25, CHROMA_KEY_SPECK_KEPT_ALPHA as f32);
        assert_eq!(dropped_in(&grid.specks(2), 30..34, 30..34), 16);
        let mut kept = AlphaGrid::new(64, 64);
        kept.fill(0..64, 0..64, 1.0);
        assert_eq!(dropped_in(&kept.specks(4), 0..64, 0..64), 0);
        let mut tiny = AlphaGrid::new(6, 6);
        tiny.fill(3..6, 0..6, 1.0);
        assert_eq!(dropped_in(&tiny.specks(1), 0..6, 0..6), 0);
    }

    /// 2026-11-26: away from the edge only Spill removal acts; next to it
    /// the olive the screen makes of brown hair comes back to brown, while
    /// skin, teal, cyan and a grey keep their colour at any proximity.
    #[test]
    fn chroma_key_edge_despill_is_spill_removal_inside_and_warms_olive_at_the_edge() {
        let spill = 0.1;
        let despill = |proximity: f64, rgb: [f64; 3]| {
            chroma_key_edge_despill_rgb(false, spill, proximity, rgb)
        };
        // Inside (proximity 0) it is exactly Spill removal.
        for rgb in [
            [100.0, 200.0, 80.0],
            [71.0, 66.0, 49.0],
            [0.0, 150.0, 150.0],
            [206.0, 148.0, 116.0],
        ] {
            assert_eq!(
                despill(0.0, rgb),
                chroma_key_despill_rgb(false, spill, rgb),
                "{rgb:?}"
            );
        }
        // The owner's olive hair (2026-11-26 recording): Spill removal never
        // touches it (green is under red); next to the edge green comes down
        // to the average of red and blue.
        let olive = [71.0, 66.0, 49.0];
        assert_eq!(despill(0.0, olive), olive);
        assert_eq!(despill(1.0, olive), [71.0, 60.0, 49.0]);
        assert_eq!(despill(0.5, olive), [71.0, 63.0, 49.0]);
        // A green-dominant rim goes further than Spill removal's limit.
        assert_eq!(despill(1.0, [100.0, 115.0, 70.0]), [100.0, 85.0, 70.0]);
        // Never more than the larger cut: Spill removal at 100 % on a
        // green-dominant colour still stops at the other channels' max.
        assert_eq!(
            chroma_key_edge_despill_rgb(false, 1.0, 0.0, [100.0, 200.0, 80.0]),
            [100.0, 100.0, 80.0]
        );
        // Untouched at full proximity: skin, brown hair, teal, cyan, grey.
        for rgb in [
            [206.0, 148.0, 116.0],
            [55.0, 36.0, 20.0],
            [0.0, 150.0, 150.0],
            [0.0, 200.0, 200.0],
            [128.0, 128.0, 128.0],
        ] {
            assert_eq!(despill(1.0, rgb), rgb, "{rgb:?}");
        }
        // A blue screen mirrors it on blue, with green as the other channel.
        assert_eq!(
            chroma_key_edge_despill_rgb(true, spill, 1.0, [71.0, 49.0, 66.0]),
            [71.0, 49.0, 60.0]
        );
    }

    /// The spill zone: 0 deep in a kept picture, 1 next to a keyed-out one,
    /// fading over about two cells, and a one-texel cell still reaches the
    /// texel next to the edge.
    #[test]
    fn chroma_key_spill_zone_reaches_a_share_of_the_camera_into_the_subject() {
        assert_eq!(chroma_key_spill_cell(3840, 2160, 1), 30, "4K at 1:1");
        assert_eq!(chroma_key_spill_cell(3840, 2160, 4), 8, "4K in a slot");
        assert_eq!(chroma_key_spill_cell(1920, 1080, 1), 15, "1080p at 1:1");
        assert_eq!(chroma_key_spill_cell(1080, 1920, 1), 15, "portrait");
        assert_eq!(chroma_key_spill_cell(64, 8, 1), 1);
        assert_eq!(chroma_key_spill_cell(0, 0, 0), 1);
        // A 4K camera at 1:1: the screen left of column 1200, the subject
        // from it. The edge despill acts fully across the band the owner's
        // spill reached and fades out by a cell and a half in (an edge on a
        // cell boundary; off the grid it reaches a little further).
        let (width, height, cell) = (1800usize, 300usize, 30usize);
        let zone =
            ChromaKeySpillZone::find(width, height, cell, |x, _| if x < 1200 { 0.0 } else { 1.0 });
        for depth in [0usize, 10, 20] {
            assert_eq!(zone.proximity(1200 + depth, 150), 1.0, "depth {depth}");
        }
        assert!(zone.proximity(1200 + 30, 150) > 0.5, "depth 30");
        assert_eq!(zone.proximity(1200 + 45, 150), 0.0, "depth 45");
        assert_eq!(zone.proximity(1200 + 120, 150), 0.0, "depth 120");
        assert_eq!(zone.proximity(1799, 150), 0.0, "the far side");
        // Kept everywhere: nothing near.
        let kept = ChromaKeySpillZone::find(90, 60, 30, |_, _| 1.0);
        assert_eq!(kept.proximity(45, 30), 0.0);
        // A one-texel cell (a tiny camera, or a deep reduction).
        let tiny = ChromaKeySpillZone::find(64, 8, 1, |x, _| if x < 24 { 0.0 } else { 1.0 });
        assert_eq!(tiny.proximity(24, 4), 1.0, "next to the edge");
        assert_eq!(tiny.proximity(44, 4), 0.0, "20 in");
    }

    /// Plan 233: the f64 despill is the 8-bit despill on whole colours and
    /// leaves a colour the key channel does not dominate alone.
    #[test]
    fn chroma_key_despill_rgb_matches_the_eight_bit_despill() {
        let spec = default_green_spec();
        for rgb in [
            [100u8, 200, 80],
            [60, 61, 10],
            [0, 150, 150],
            [200, 150, 120],
        ] {
            let (r, g, b) = chroma_key_despill(&spec, rgb[0], rgb[1], rgb[2]);
            let reference =
                chroma_key_despill_rgb(spec.spill_is_blue(), spec.spill, rgb.map(f64::from));
            assert_eq!(
                [r, g, b],
                reference.map(|value| value.round() as u8),
                "{rgb:?}"
            );
        }
        // The teal logo: green never dominates blue, so it is untouched at
        // any strength.
        assert_eq!(
            chroma_key_despill_rgb(false, 1.0, [0.0, 150.0, 150.0]),
            [0.0, 150.0, 150.0]
        );
        // Full strength clamps green to the other channels' max.
        assert_eq!(
            chroma_key_despill_rgb(false, 1.0, [100.0, 200.0, 80.0]),
            [100.0, 100.0, 80.0]
        );
    }

    #[test]
    fn chroma_key_saturation_floor_scales_with_luma_and_keeps_the_old_floor_up_high() {
        assert_eq!(chroma_key_saturation_floor(0.0), (5.0, 5.0 * 6.0 / 14.0));
        assert_eq!(chroma_key_saturation_floor(20.0).0, 5.0);
        assert!((chroma_key_saturation_floor(60.0).0 - 9.0).abs() < 1e-9);
        // From Y ≈ 93.3 up the floor is the old 14 with the old ramp of 6.
        for luma in [94.0, 128.0, 255.0] {
            let (floor, ramp) = chroma_key_saturation_floor(luma);
            assert_eq!(floor, 14.0);
            assert!((ramp - 6.0).abs() < 1e-9);
        }
        assert_eq!(
            CHROMA_KEY_SATURATION_FLOOR_PARAMS,
            [5.0, 0.15, 14.0, 6.0 / 14.0]
        );
        assert!((rgb_luma_f64([255, 255, 255]) - 255.0).abs() < 1e-9);
    }

    #[test]
    fn hide_edges_resolve_the_mirror_and_clamp_each_side() {
        let mut layout = layout();
        layout.camera_chroma_key_enabled = true;
        assert!(
            camera_chroma_key(&layout)
                .expect("keying enabled")
                .edges
                .is_none(),
            "no edges by default"
        );
        layout.camera_chroma_key_edges = crate::protocol::CameraKeyEdges {
            left_pct: 2,
            top_pct: 0,
            right_pct: 90,
            bottom_pct: 5,
        };
        let spec = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!(
            spec.edges,
            ChromaKeyEdges {
                left: 0.02,
                top: 0.0,
                right: 0.25,
                bottom: 0.05,
            },
            "each side clamps to 25 %"
        );
        assert_eq!(camera_chroma_key_edges_as_seen(&layout), spec.edges);
        // Mirrored, "left as you see it" is the source's right side.
        layout.camera_mirror = true;
        let mirrored = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!((mirrored.edges.left, mirrored.edges.right), (0.25, 0.02));
        assert_eq!(camera_chroma_key_edges_as_seen(&layout).left, 0.02);
        assert_eq!(mirrored.edges.kept_uv(), [0.25, 0.0, 0.98, 0.95]);
    }

    #[test]
    fn hide_edges_test_the_texel_centre() {
        let edges = ChromaKeyEdges {
            left: 0.25,
            top: 0.0,
            right: 0.0,
            bottom: 0.5,
        };
        // 4×2 frame: column 0 (centre 0.125) is hidden, column 1 (0.375) kept;
        // row 1 (centre 0.75) is below the kept half.
        assert!(!edges.keeps_texel(0, 0, 4, 2));
        assert!(edges.keeps_texel(1, 0, 4, 2));
        assert!(edges.keeps_texel(3, 0, 4, 2));
        assert!(!edges.keeps_texel(3, 1, 4, 2));
        assert!(ChromaKeyEdges::NONE.keeps_texel(0, 0, 1, 1));
    }

    /// A `width`×`height` frame of `field` with `patch` painted on the texels
    /// `inside` accepts, keyed the way every path keys a picture (plan 229):
    /// the alpha of texel (`x`, `y`) from its neighbourhood.
    fn keyed_frame(
        spec: &ChromaKeySpec,
        (width, height): (u32, u32),
        field: [u8; 3],
        patch: [u8; 3],
        inside: impl Fn(u32, u32) -> bool,
    ) -> impl Fn(u32, u32) -> u8 {
        let spec = *spec;
        let read = move |x: u32, y: u32| if inside(x, y) { patch } else { field };
        move |x, y| {
            chroma_key_alpha_rgb(
                &spec,
                chroma_key_neighbourhood_rgb(&read, x, y, width, height),
            )
        }
    }

    #[test]
    fn chroma_key_neighbourhood_is_the_binomial_clamped_at_the_frame_edge() {
        assert_eq!(
            CHROMA_KEY_NEIGHBOURHOOD_WEIGHTS.iter().sum::<u32>().pow(2),
            256
        );
        // A flat frame judges its own colour, edge texels included.
        let flat = |_: u32, _: u32| [21u8, 124, 55];
        for (x, y) in [(0, 0), (4, 4), (8, 0), (8, 8)] {
            assert_eq!(
                chroma_key_neighbourhood_rgb(flat, x, y, 9, 9),
                [21.0, 124.0, 55.0]
            );
        }
        // One white texel in black: 36/256 of it at the centre, 24/256 one
        // texel out, 16/256 diagonally, 1/256 two texels out diagonally.
        let dot = |x: u32, y: u32| if (x, y) == (4, 4) { [255u8; 3] } else { [0; 3] };
        let share = |x, y| chroma_key_neighbourhood_rgb(dot, x, y, 9, 9)[0] / 255.0 * 256.0;
        assert!((share(4, 4) - 36.0).abs() < 1e-9);
        assert!((share(5, 4) - 24.0).abs() < 1e-9);
        assert!((share(5, 5) - 16.0).abs() < 1e-9);
        assert!((share(6, 6) - 1.0).abs() < 1e-9);
        assert_eq!(share(7, 4), 0.0);
        // Past the edge the edge texel repeats: a white left column is 6+4+1
        // sixteenths of column 0's judged colour.
        let column = |x: u32, _: u32| if x == 0 { [255u8; 3] } else { [0; 3] };
        let judged = chroma_key_neighbourhood_rgb(column, 0, 4, 9, 9)[0];
        assert!((judged - 255.0 * 11.0 / 16.0).abs() < 1e-9);
        // The shaders' nine taps are the same kernel on a texel centre.
        let side = CHROMA_KEY_NEIGHBOURHOOD_SIDE_TAP_WEIGHT;
        let far = CHROMA_KEY_NEIGHBOURHOOD_TAP_OFFSET - 1.0;
        assert!(
            (side * far * 16.0 - 1.0).abs() < 1e-9,
            "1/16 two texels out"
        );
        assert!(
            (side * (1.0 - far) * 16.0 - 4.0).abs() < 1e-9,
            "4/16 one out"
        );
        assert!(
            ((1.0 - 2.0 * side) * 16.0 - 6.0).abs() < 1e-9,
            "6/16 centre"
        );
    }

    /// Plan 229, the owner's evening stream on 0.22.0 (2026-11-11, raw
    /// camera take at 805 s): "snow" around the subject. These specks are
    /// real texels that keyed only part way alone (their hue a degree or two
    /// past the 24° cone, or their chroma at the floor's ramp), each in the
    /// median tone of the screen around it. As a speck of one chroma sample
    /// (2×2) they key fully with the screen around them.
    #[test]
    fn chroma_key_keys_the_snow_with_the_screen_around_it() {
        let spec = default_green_spec();
        for (label, screen, speck) in [
            ("lit screen, bluer speck", [21u8, 124, 55], [9u8, 107, 53]),
            ("lit screen, darker speck", [14, 108, 47], [3, 89, 42]),
            ("shoulder screen", [6, 90, 38], [0, 88, 39]),
            ("mid shadow", [2, 43, 18], [0, 43, 20]),
            ("deep shadow", [2, 28, 10], [3, 29, 15]),
            ("deep shadow at the floor", [2, 24, 9], [0, 11, 0]),
        ] {
            let alone = chroma_key_alpha(&spec, speck[0], speck[1], speck[2]);
            assert!(alone > 40, "{label}: {speck:?} stays alone ({alone})");
            let alpha = keyed_frame(&spec, (9, 9), screen, speck, |x, y| {
                (4..6).contains(&x) && (4..6).contains(&y)
            });
            for (x, y) in [(4, 4), (5, 4), (4, 5), (5, 5)] {
                assert_eq!(alpha(x, y), 0, "{label}: speck texel ({x}, {y})");
            }
        }
    }

    /// Plan 229: a texel of the black t-shirt that chroma noise turned
    /// green-ish keys alone (a hole); judged with the shirt around it, it
    /// stays. The teal logo on the shirt (the footage's 10th to 90th
    /// percentile tones, 41–43° from the key) stays opaque, its edges too.
    #[test]
    fn chroma_key_fills_a_noise_hole_and_keeps_the_teal_logo() {
        let spec = default_green_spec();
        let shirt = [25u8, 25, 28];
        let noisy = [14u8, 30, 18];
        assert_eq!(chroma_key_alpha(&spec, 14, 30, 18), 0, "a hole alone");
        let alpha = keyed_frame(&spec, (9, 9), shirt, noisy, |x, y| (x, y) == (4, 4));
        assert_eq!(alpha(4, 4), 255, "filled with the shirt around it");

        for logo in [[21u8, 88, 71], [35, 140, 110], [54, 187, 143]] {
            // A 4-texel-wide stroke of logo on the shirt.
            let alpha = keyed_frame(&spec, (12, 9), shirt, logo, |x, _| (4..8).contains(&x));
            for x in 0..12 {
                assert_eq!(alpha(x, 4), 255, "logo {logo:?} column {x}");
            }
        }
    }

    /// Plan 229: what the neighbourhood costs at an edge. A dark subject
    /// against a bright screen loses at most the one column touching the
    /// screen (the green that the 4:2:0 chroma already bleeds into it), and
    /// every screen column keys.
    #[test]
    fn chroma_key_neighbourhood_chokes_a_dark_edge_by_at_most_one_texel() {
        let spec = default_green_spec();
        let shirt = [25u8, 25, 28];
        let screen = [21u8, 124, 55];
        // Shirt on columns 0..6, screen on 6..12.
        let alpha = keyed_frame(&spec, (12, 5), screen, shirt, |x, _| x < 6);
        for x in 0..5 {
            assert_eq!(alpha(x, 2), 255, "shirt column {x} stays");
        }
        for x in 6..12 {
            assert_eq!(alpha(x, 2), 0, "screen column {x} keys");
        }
        // Without the neighbourhood both sides are exact; with it the shirt's
        // last column is the only one that changes.
        assert_eq!(chroma_key_alpha(&spec, 25, 25, 28), 255);
        assert_eq!(chroma_key_alpha(&spec, 21, 124, 55), 0);
    }

    /// THE calibration pin (2026-07-14 owner report): the keyer must key a
    /// REALISTIC studio-lit screen with the SHIPPED DEFAULTS, not just pure
    /// fixture colors. The 0.9.39 absolute-distance model passed every
    /// pure-color test and keyed nothing real; this table is the regression
    /// guard against that class of miscalibration.
    #[test]
    fn chroma_key_keys_a_realistic_screen_palette_with_defaults() {
        let spec = default_green_spec();
        // Real screen tones across lighting — ALL must key fully.
        for (label, rgb) in [
            ("pure green", [0u8, 255, 0]),
            ("bright lit screen", [80, 200, 90]),
            ("well-lit screen", [60, 180, 70]),
            ("mid screen", [40, 140, 55]),
            ("shadowed screen", [30, 100, 40]),
            ("overexposed edge", [110, 190, 120]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                0,
                "{label} must key with defaults"
            );
        }
        // The subject must survive untouched.
        for (label, rgb) in [
            ("skin", [200u8, 160, 140]),
            ("dark hair", [40, 30, 25]),
            ("white shirt", [230, 230, 230]),
            ("red", [255, 0, 0]),
            ("grey", [128, 128, 128]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                255,
                "{label} must survive with defaults"
            );
        }
        // Documented physics (true of every chroma keyer): a saturated green
        // GARMENT keys too — the saturation floor cannot save a green shirt.
        assert_eq!(chroma_key_alpha(&spec, 90, 140, 95), 0);
    }

    #[test]
    fn chroma_key_alpha_ramps_by_angle_and_saturation() {
        let spec = default_green_spec();
        // Alpha never decreases as hue rotates away from the key direction:
        // blend green toward red through yellow.
        let mut previous = 0;
        for step in 0..=10 {
            let t = f64::from(step) / 10.0;
            let r = (255.0 * t).round() as u8;
            let g = (255.0 * (1.0 - t) + 100.0 * t).round() as u8;
            let alpha = chroma_key_alpha(&spec, r, g, 0);
            assert!(
                alpha >= previous,
                "hue ramp not monotonic at step {step}: {alpha} < {previous}"
            );
            previous = alpha;
        }
        assert_eq!(previous, 255);
        // The saturation floor ramps: a key-direction color fades to opaque
        // as it desaturates toward grey.
        // (100,135,100): saturation ~18.7 → partially eligible → mid alpha.
        let partial = chroma_key_alpha(&spec, 100, 135, 100);
        assert!(
            partial > 0 && partial < 255,
            "low-saturation screen tone should partially key, got {partial}"
        );
        // (110,130,110): saturation ~10.7, below the floor → fully opaque.
        assert_eq!(chroma_key_alpha(&spec, 110, 130, 110), 255);
    }

    #[test]
    fn chroma_key_alpha_zero_band_is_a_hard_cut_and_grey_key_never_keys() {
        let spec = ChromaKeySpec {
            band_deg: 0.0,
            ..default_green_spec()
        };
        assert_eq!(chroma_key_alpha(&spec, 0, 255, 0), 0);
        assert_eq!(chroma_key_alpha(&spec, 128, 128, 128), 255);
        assert_eq!(chroma_key_alpha(&spec, 255, 0, 0), 255);
        // A grey key color has no chroma direction — nothing may key.
        let grey_key = ChromaKeySpec {
            key_rgb: [128, 128, 128],
            ..default_green_spec()
        };
        assert_eq!(chroma_key_alpha(&grey_key, 0, 255, 0), 255);
        assert!(grey_key.key_direction().is_none());
    }

    #[test]
    fn chroma_key_despill_clamps_only_the_dominant_key_channel() {
        let green = ChromaKeySpec {
            key_rgb: [0, 255, 0],
            max_angle_deg: 24.0,
            band_deg: 4.8,
            spill: 1.0,
            edges: ChromaKeyEdges::NONE,
        };
        assert_eq!(chroma_key_despill(&green, 100, 200, 80), (100, 100, 80));
        let half = ChromaKeySpec {
            spill: 0.5,
            ..green
        };
        assert_eq!(chroma_key_despill(&half, 100, 200, 80), (100, 150, 80));
        // Neutral and non-dominant pixels never move.
        assert_eq!(chroma_key_despill(&green, 128, 128, 128), (128, 128, 128));
        assert_eq!(chroma_key_despill(&green, 200, 150, 90), (200, 150, 90));
        let blue = ChromaKeySpec {
            key_rgb: [0, 0, 255],
            ..green
        };
        assert!(blue.spill_is_blue());
        assert_eq!(chroma_key_despill(&blue, 90, 100, 220), (90, 100, 100));
        let off = ChromaKeySpec {
            spill: 0.0,
            ..green
        };
        assert_eq!(chroma_key_despill(&off, 100, 200, 80), (100, 200, 80));
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
    fn shape_and_radius_policy_applies_in_freeform_too() {
        // Same clamp-once policy, but entered from a non-inset preset via
        // Freeform instead of ScreenCamera.
        let mut layout = layout();
        layout.layout_preset = LayoutPreset::CameraOnly;
        layout.arrangement_mode = ArrangementMode::Freeform;
        layout.camera_shape = CameraShape::Circle;
        assert_eq!(camera_mask(&layout), SceneMask::Circle);

        layout.camera_shape = CameraShape::Rounded;
        layout.camera_corner_radius_pct = 400;
        assert_eq!(camera_mask(&layout), SceneMask::Rounded { radius_pct: 50 });
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
                Some(SignedPixelRect::from(expected))
            );
        }
    }

    /// The Scene stage shows this box while a camera is dragged into a corner
    /// of a preset scene (its drop target): pinned with the renderer's twin,
    /// `presetCameraCornerRect` in `components/scene/stage-corner.test.ts`.
    #[test]
    fn preset_camera_corner_boxes_match_the_stage_drop_target() {
        let cases = [
            (
                CameraSize::Medium,
                CameraShape::Rectangle,
                CameraAspect::Source,
                32,
                CameraCorner::BottomRight,
                (1920, 1080),
                (1332, 727, 540, 305),
            ),
            (
                CameraSize::Small,
                CameraShape::Circle,
                CameraAspect::Source,
                32,
                CameraCorner::TopLeft,
                (1080, 1920),
                (27, 27, 219, 219),
            ),
            (
                CameraSize::Large,
                CameraShape::Rounded,
                CameraAspect::Portrait,
                500,
                CameraCorner::TopRight,
                (1280, 720),
                (640, 160, 480, 640),
            ),
        ];
        for (size, shape, aspect, margin, corner, (width, height), (x, y, w, h)) in cases {
            let mut layout = layout();
            layout.camera_size = size;
            layout.camera_shape = shape;
            layout.camera_aspect = aspect;
            layout.camera_margin = margin;
            layout.camera_corner = corner;
            let transform = preset_camera_transform(&layout, width, height);
            let (width, height) = (f64::from(width), f64::from(height));
            assert_eq!(
                (transform.x, transform.y, transform.width, transform.height),
                (
                    f64::from(x) / width,
                    f64::from(y) / height,
                    f64::from(w) / width,
                    f64::from(h) / height
                )
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
            assert_eq!(rect.right(), i64::from(width), "custom x clamps on-canvas");
            assert_eq!(rect.y, 0, "custom y clamps on-canvas");
            assert!((transform.crop_left - 0.233_333_333_333_333_34).abs() < 1e-9);
            assert!((transform.crop_right - 0.1).abs() < 1e-9);
            assert!((transform.crop_top - 0.133_333_333_333_333_33).abs() < 1e-9);
            assert!((transform.crop_bottom - 0.2).abs() < 1e-9);
        }
    }

    /// Plan 215 E1 (D2): a box that runs past the canvas edge keeps its true
    /// origin and size, so what hangs off is cut, never squashed. Before,
    /// `scene_source_rect_pixels` clamped the origin onto the canvas and
    /// shrank the size to what was left, which squeezed the whole picture
    /// into the visible part.
    #[test]
    fn transform_and_crop_table_cuts_at_canvas_edges_and_never_squashes() {
        let past_the_corner = SceneTransform {
            x: 0.75,
            y: 0.8,
            width: 0.5,
            height: 0.5,
            crop_left: -1.0,
            crop_top: 0.25,
            crop_right: 4.0,
            crop_bottom: 0.125,
        };
        let left_of_the_canvas = SceneTransform {
            x: -0.25,
            y: 0.0,
            width: 1.5,
            height: 1.0,
            ..past_the_corner.clone()
        };
        let four_hundred_percent = SceneTransform {
            x: -1.5,
            y: -1.5,
            width: 4.0,
            height: 4.0,
            ..past_the_corner.clone()
        };
        // (transform, canvas) -> the uncut box: signed origin, full size.
        let cases = [
            (&past_the_corner, (1920, 1080), (1440, 864, 960, 540)),
            (&past_the_corner, (3840, 2160), (2880, 1728, 1920, 1080)),
            (&left_of_the_canvas, (1920, 1080), (-480, 0, 2880, 1080)),
            (&left_of_the_canvas, (3840, 2160), (-960, 0, 5760, 2160)),
            (
                &four_hundred_percent,
                (1920, 1080),
                (-2880, -1620, 7680, 4320),
            ),
        ];
        for (transform, (width, height), (x, y, w, h)) in cases {
            let rect = scene_source_rect_pixels(transform, width, height).expect("a box");
            assert_eq!(
                (rect.x, rect.y, rect.width, rect.height),
                (x, y, w, h),
                "{transform:?} on {width}x{height}"
            );
        }
        assert_eq!(
            scene_crop_from_transform(&past_the_corner),
            SceneCrop {
                left: 0.0,
                top: 0.25,
                right: 0.95,
                bottom: 0.125,
            }
        );
    }

    #[test]
    fn signed_rect_intersects_the_canvas_and_reports_the_cut() {
        let rect = |x, y, width, height| SignedPixelRect {
            x,
            y,
            width,
            height,
        };
        let pixel = |x, y, width, height| PixelRect {
            x,
            y,
            width,
            height,
        };
        // Past the bottom-right corner: the origin stays, the size is cut.
        assert_eq!(
            rect(1440, 864, 960, 540).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(1440, 864, 480, 216),
                cut_left: 0,
                cut_top: 0,
            })
        );
        // Left of the canvas: the visible part starts at 0 and the source
        // window starts 480 box pixels in.
        assert_eq!(
            rect(-480, 0, 2880, 1080).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1920, 1080),
                cut_left: 480,
                cut_top: 0,
            })
        );
        // A 400% box centred on the canvas covers it; three quarters of it
        // hang off.
        assert_eq!(
            rect(-2880, -1620, 7680, 4320).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1920, 1080),
                cut_left: 2880,
                cut_top: 1620,
            })
        );
        // Nothing on the canvas: off every side, and an empty box.
        assert_eq!(rect(1920, 0, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(-100, 0, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, 1080, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, -100, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, 0, 0, 100).intersect_canvas(1920, 1080), None);
        // One pixel on the canvas still counts.
        assert_eq!(
            rect(-99, -99, 100, 100).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1, 1),
                cut_left: 99,
                cut_top: 99,
            })
        );
        assert_eq!(rect(-99, -99, 100, 100).whole_on_canvas(1920, 1080), None);
        assert_eq!(
            rect(0, 0, 1920, 1080).whole_on_canvas(1920, 1080),
            Some(pixel(0, 0, 1920, 1080))
        );
    }

    /// Plan 215 E2: a mask belongs to the whole box, so a circle on a box
    /// that hangs off the canvas is centred where the box is centred (off
    /// the canvas too), and the canvas edge cuts the circle. Squashing the
    /// box onto the canvas would have drawn a smaller circle in the corner.
    #[test]
    fn masks_keep_their_geometry_on_a_box_that_hangs_off_the_canvas() {
        let hanging = SignedPixelRect {
            x: -100,
            y: -100,
            width: 200,
            height: 200,
        };
        let circle = circle_geometry(hanging);
        assert_eq!(
            (circle.center_x, circle.center_y, circle.radius),
            (0.0, 0.0, 100.0)
        );
        let tester = SceneMaskTester::new(SceneMask::Circle, hanging);
        // Inside the quarter of the circle that is on the canvas...
        assert!(tester.allows(10, 10));
        assert!(tester.allows(70, 70));
        // ...and outside it, still on the canvas and still inside the box.
        assert!(!tester.allows(90, 90));
        assert!(!tester.allows(99, 50));
        // The same box as an on-canvas rect gives the same f64s.
        let on_canvas = PixelRect {
            x: 40,
            y: 60,
            width: 200,
            height: 200,
        };
        assert_eq!(
            circle_geometry(on_canvas),
            circle_geometry(SignedPixelRect::from(on_canvas))
        );
        assert_eq!(
            rounded_rect_geometry(on_canvas, 24),
            rounded_rect_geometry(SignedPixelRect::from(on_canvas), 24)
        );
        let corners = rounded_rect_geometry(hanging, 50);
        assert_eq!(
            (corners.center_x, corners.center_y, corners.radius),
            (0.0, 0.0, 100.0)
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

    /// The pre-plan-191 body of `scene_mask_allows`, verbatim: geometry
    /// rebuilt on every call. The frozen oracle for `SceneMaskTester`.
    fn scene_mask_allows_before_plan_191(
        mask: SceneMask,
        rect: PixelRect,
        x: usize,
        y: usize,
    ) -> bool {
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
                let qx = ((x as f64 + 0.5 - geometry.center_x).abs() - geometry.inner_half_width)
                    .max(0.0);
                let qy = ((y as f64 + 0.5 - geometry.center_y).abs() - geometry.inner_half_height)
                    .max(0.0);
                qx * qx + qy * qy <= geometry.radius * geometry.radius
            }
        }
    }

    #[test]
    fn scene_mask_tester_matches_the_per_pixel_rule_at_every_pixel_around_the_rect() {
        let pixel_rect = |x, y, width, height| PixelRect {
            x,
            y,
            width,
            height,
        };
        let rects = [
            pixel_rect(0, 0, 1, 1),
            pixel_rect(3, 2, 1, 1),
            pixel_rect(0, 0, 2, 2),
            pixel_rect(5, 7, 3, 3),
            pixel_rect(4, 9, 2, 5),
            pixel_rect(10, 4, 17, 9),
            pixel_rect(2, 3, 9, 31),
            pixel_rect(6, 6, 64, 64),
            pixel_rect(0, 0, 200, 100),
            pixel_rect(37, 21, 101, 57),
            // An odd camera bubble at a 1080p canvas offset.
            pixel_rect(1617, 853, 261, 147),
            // Degenerate rects: zero radius on both mask kinds.
            pixel_rect(4, 4, 0, 5),
            pixel_rect(4, 4, 6, 0),
        ];
        let masks = [
            SceneMask::None,
            SceneMask::Circle,
            SceneMask::Rounded { radius_pct: 0 },
            SceneMask::Rounded { radius_pct: 1 },
            SceneMask::Rounded { radius_pct: 12 },
            SceneMask::Rounded { radius_pct: 20 },
            SceneMask::Rounded { radius_pct: 33 },
            SceneMask::Rounded { radius_pct: 50 },
            // Clamped to 50.
            SceneMask::Rounded { radius_pct: 80 },
        ];
        let (mut allowed, mut rejected) = (0_usize, 0_usize);
        for rect in rects {
            for mask in masks {
                let tester = SceneMaskTester::new(mask, rect);
                // The rect's bounding box plus a 2-pixel margin on every side
                // (clamped at the canvas origin).
                let xs =
                    (rect.x as usize).saturating_sub(2)..rect.x as usize + rect.width as usize + 2;
                let ys =
                    (rect.y as usize).saturating_sub(2)..rect.y as usize + rect.height as usize + 2;
                for y in ys {
                    for x in xs.clone() {
                        let expected = scene_mask_allows_before_plan_191(mask, rect, x, y);
                        assert_eq!(
                            tester.allows(x, y),
                            expected,
                            "{mask:?} on {rect:?} at ({x}, {y})"
                        );
                        assert_eq!(
                            scene_mask_allows(mask, rect, x, y),
                            expected,
                            "scene_mask_allows: {mask:?} on {rect:?} at ({x}, {y})"
                        );
                        if expected {
                            allowed += 1;
                        } else {
                            rejected += 1;
                        }
                    }
                }
            }
        }
        // Both outcomes were exercised, not only one side of the edge.
        assert!(
            allowed > 0 && rejected > 0,
            "{allowed} allowed, {rejected} rejected"
        );
    }
}

/// Plan 213 G1: the one cropped-screen fixture every render path draws (CPU,
/// Metal, the FFmpeg legacy graph and the aux leg), so a crop that one path
/// ignores shows up as a wrong colour at a known point.
#[cfg(test)]
pub(crate) mod screen_crop_fixture {
    use crate::protocol::SceneTransform;

    pub const SOURCE_WIDTH: u32 = 64;
    pub const SOURCE_HEIGHT: u32 = 36;

    pub const RED: [u8; 3] = [255, 0, 0];
    pub const GREEN: [u8; 3] = [0, 255, 0];
    pub const BLUE: [u8; 3] = [0, 0, 255];
    pub const WHITE: [u8; 3] = [255, 255, 255];
    pub const MAGENTA: [u8; 3] = [255, 0, 255];
    pub const CYAN: [u8; 3] = [0, 255, 255];
    pub const BLACK: [u8; 3] = [0, 0, 0];

    /// The screen picture as RGB: four 16 px columns (red, green, blue,
    /// white) between a magenta band on top and a cyan band at the bottom,
    /// 9 rows each.
    pub fn source_rgb(x: u32, y: u32) -> [u8; 3] {
        if y < 9 {
            MAGENTA
        } else if y >= SOURCE_HEIGHT - 9 {
            CYAN
        } else {
            [RED, GREEN, BLUE, WHITE][(x / 16) as usize]
        }
    }

    pub fn source_bgra() -> Vec<u8> {
        (0..SOURCE_HEIGHT)
            .flat_map(|y| (0..SOURCE_WIDTH).map(move |x| (x, y)))
            .flat_map(|(x, y)| {
                let [r, g, b] = source_rgb(x, y);
                [b, g, r, 255]
            })
            .collect()
    }

    /// A box in the middle half of the canvas with a quarter cropped off
    /// every side. What is left is the green and blue columns, 32×18: the
    /// box's own 16:9, so Fit fills the box exactly.
    pub fn transform() -> SceneTransform {
        SceneTransform {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            crop_left: 0.25,
            crop_top: 0.25,
            crop_right: 0.25,
            crop_bottom: 0.25,
        }
    }

    /// Canvas points (fractions, so any canvas size) and the colour each
    /// shows. Without the crop the four points next to the box's edges would
    /// show red, magenta, cyan and white instead.
    pub fn expected_samples() -> [((f64, f64), [u8; 3]); 7] {
        [
            ((0.30, 0.50), GREEN),
            ((0.45, 0.30), GREEN),
            ((0.45, 0.70), GREEN),
            ((0.55, 0.50), BLUE),
            ((0.70, 0.50), BLUE),
            ((0.10, 0.10), BLACK),
            ((0.90, 0.90), BLACK),
        ]
    }

    /// The sample's pixel on a `width`×`height` canvas.
    pub fn sample_pixel(point: (f64, f64), width: u32, height: u32) -> (usize, usize) {
        (
            (point.0 * f64::from(width)).floor() as usize,
            (point.1 * f64::from(height)).floor() as usize,
        )
    }
}

/// Plan 215 E2 (D2): the one bigger-than-canvas fixture every render path
/// draws (CPU, Metal, the FFmpeg legacy graph, the aux leg and the D3D11
/// planner): the crop fixture's screen picture, uncropped, in a 150% box
/// with a quarter of it past every canvas edge. Cut, each visible stripe is
/// three times its source width and the outer stripes are half off the
/// canvas; squashed onto the canvas, the whole picture would show at twice
/// its width, so the two differ at the points below.
#[cfg(test)]
pub(crate) mod screen_beyond_canvas_fixture {
    use super::screen_crop_fixture::{BLUE, CYAN, GREEN, MAGENTA, RED, WHITE};
    use crate::protocol::SceneTransform;

    /// A 16:9 box (so Fit fills it exactly on a 16:9 canvas) at 150% of the
    /// canvas, centred: 25% hangs off every edge.
    pub fn transform() -> SceneTransform {
        SceneTransform {
            x: -0.25,
            y: -0.25,
            width: 1.5,
            height: 1.5,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        }
    }

    /// Canvas points (fractions, so any 16:9 canvas) and the colour each
    /// shows when the box is cut at the edge. With the box squashed onto the
    /// canvas instead, the first four points would show red, white, magenta
    /// and cyan. Every point sits mid-stripe: x 0.5 lands on the green/blue
    /// column edge (source x 32), where the bilinear paths (Metal, the aux
    /// leg, FFmpeg) rightly blend, so the vertical probes use x 0.6875, the
    /// middle of the blue column (source x 40).
    pub fn expected_samples() -> [((f64, f64), [u8; 3]); 8] {
        [
            ((0.20, 0.50), GREEN),
            ((0.80, 0.50), BLUE),
            ((0.6875, 0.18), BLUE),
            ((0.6875, 0.82), BLUE),
            ((0.05, 0.50), RED),
            ((0.95, 0.50), WHITE),
            ((0.50, 0.05), MAGENTA),
            ((0.50, 0.95), CYAN),
        ]
    }
}
