use crate::windows_d3d11_device::DxgiAdapterLuid;
use std::fmt;

pub(crate) const WINDOWS_D3D11_SHADER_SOURCE: &str = include_str!("windows_d3d11_shaders.hlsl");

const MAX_SCENE_LAYERS: usize = 64;
const MAX_ENCODED_OUTPUTS: usize = 2;
const MAX_SOURCE_DIMENSION: u32 = 16_384;
const MAX_BLUR_RADIUS_PX: f32 = 32.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CompositorErrorCode {
    InvalidScenePlan,
    UnsupportedSceneFeature,
    AdapterMismatch,
    StaleGeneration,
    ShaderCompileFailed,
    SourceContractViolation,
    TargetContractViolation,
    GpuOperationFailed,
    DeviceLost,
}

impl WindowsD3d11CompositorErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidScenePlan => "d3d11-compositor-invalid-scene-plan",
            Self::UnsupportedSceneFeature => "d3d11-compositor-unsupported-scene-feature",
            Self::AdapterMismatch => "d3d11-compositor-adapter-mismatch",
            Self::StaleGeneration => "d3d11-compositor-stale-generation",
            Self::ShaderCompileFailed => "d3d11-compositor-shader-compile-failed",
            Self::SourceContractViolation => "d3d11-compositor-source-contract-violation",
            Self::TargetContractViolation => "d3d11-compositor-target-contract-violation",
            Self::GpuOperationFailed => "d3d11-compositor-gpu-operation-failed",
            Self::DeviceLost => "d3d11-compositor-device-lost",
        }
    }
}

impl fmt::Display for WindowsD3d11CompositorErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CompositorError {
    pub(crate) code: WindowsD3d11CompositorErrorCode,
    pub(crate) detail: String,
}

impl WindowsD3d11CompositorError {
    fn new(code: WindowsD3d11CompositorErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    fn invalid(detail: impl Into<String>) -> Self {
        Self::new(WindowsD3d11CompositorErrorCode::InvalidScenePlan, detail)
    }
}

impl fmt::Display for WindowsD3d11CompositorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for WindowsD3d11CompositorError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CanvasOrientation {
    Horizontal,
    Vertical,
}

impl WindowsD3d11CanvasOrientation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Horizontal => "horizontal",
            Self::Vertical => "vertical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11OutputDimensions {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl WindowsD3d11OutputDimensions {
    pub(crate) fn new(width: u32, height: u32) -> Result<Self, WindowsD3d11CompositorError> {
        if width == 0 || height == 0 {
            return Err(WindowsD3d11CompositorError::invalid(
                "output dimensions must be non-zero",
            ));
        }
        if width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION {
            return Err(WindowsD3d11CompositorError::invalid(format!(
                "output dimensions {width}x{height} exceed the D3D11 2D limit of {MAX_SOURCE_DIMENSION}"
            )));
        }
        Ok(Self { width, height })
    }

    pub(crate) fn nv12(width: u32, height: u32) -> Result<Self, WindowsD3d11CompositorError> {
        let dimensions = Self::new(width, height)?;
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(WindowsD3d11CompositorError::invalid(format!(
                "NV12 output dimensions {width}x{height} must both be even"
            )));
        }
        Ok(dimensions)
    }

    fn aspect_matches(self, other: Self) -> bool {
        u64::from(self.width) * u64::from(other.height)
            == u64::from(other.width) * u64::from(self.height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11EncodedOutputRole {
    Primary,
    Auxiliary,
}

impl WindowsD3d11EncodedOutputRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Auxiliary => "auxiliary",
        }
    }
}

/// Bounded scene-output selection. Layers default to every output so existing
/// scenes keep their current preview/recording/stream semantics until the
/// caller explicitly opts an overlay into a subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SceneOutputTargets(u8);

impl WindowsD3d11SceneOutputTargets {
    const PREVIEW_BIT: u8 = 1 << 0;
    const PRIMARY_BIT: u8 = 1 << 1;
    const AUXILIARY_BIT: u8 = 1 << 2;

    pub(crate) const PREVIEW: Self = Self(Self::PREVIEW_BIT);
    pub(crate) const PRIMARY: Self = Self(Self::PRIMARY_BIT);
    pub(crate) const AUXILIARY: Self = Self(Self::AUXILIARY_BIT);
    pub(crate) const ALL: Self = Self(Self::PREVIEW_BIT | Self::PRIMARY_BIT | Self::AUXILIARY_BIT);

    pub(crate) const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub(crate) const fn for_encoded_role(role: WindowsD3d11EncodedOutputRole) -> Self {
        match role {
            WindowsD3d11EncodedOutputRole::Primary => Self::PRIMARY,
            WindowsD3d11EncodedOutputRole::Auxiliary => Self::AUXILIARY,
        }
    }

    const fn includes(self, target: WindowsD3d11SceneOutputTarget) -> bool {
        self.0 & target.mask().0 != 0
    }

    const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl Default for WindowsD3d11SceneOutputTargets {
    fn default() -> Self {
        Self::ALL
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SceneOutputTarget {
    Preview,
    Encoded(WindowsD3d11EncodedOutputRole),
}

impl WindowsD3d11SceneOutputTarget {
    const fn mask(self) -> WindowsD3d11SceneOutputTargets {
        match self {
            Self::Preview => WindowsD3d11SceneOutputTargets::PREVIEW,
            Self::Encoded(role) => WindowsD3d11SceneOutputTargets::for_encoded_role(role),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncodedOutputPlan {
    pub(crate) role: WindowsD3d11EncodedOutputRole,
    pub(crate) dimensions: WindowsD3d11OutputDimensions,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11NormalizedTransform {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl WindowsD3d11NormalizedTransform {
    pub(crate) const fn full_canvas() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11Crop {
    pub(crate) left: f32,
    pub(crate) top: f32,
    pub(crate) right: f32,
    pub(crate) bottom: f32,
}

impl WindowsD3d11Crop {
    pub(crate) const fn none() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        }
    }

    fn normalized(self) -> Self {
        Self {
            left: finite_or_zero(self.left).clamp(0.0, 0.95),
            top: finite_or_zero(self.top).clamp(0.0, 0.95),
            right: finite_or_zero(self.right).clamp(0.0, 0.95),
            bottom: finite_or_zero(self.bottom).clamp(0.0, 0.95),
        }
    }

    fn kept_width(self) -> f32 {
        (1.0 - self.left - self.right).max(0.001)
    }

    fn kept_height(self) -> f32 {
        (1.0 - self.top - self.bottom).max(0.001)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SceneFit {
    Contain,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SceneMask {
    None,
    Circle,
    Rounded { radius_pct: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11UnsupportedFeature {
    BrowserSource,
    VideoSource,
    AnimatedImage,
    CustomShader,
    NonBgraSource,
    PerspectiveTransform,
}

impl WindowsD3d11UnsupportedFeature {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::BrowserSource => "browser-source",
            Self::VideoSource => "video-source",
            Self::AnimatedImage => "animated-image",
            Self::CustomShader => "custom-shader",
            Self::NonBgraSource => "non-bgra-source",
            Self::PerspectiveTransform => "perspective-transform",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SceneSourceKind {
    Display,
    Window,
    CameraUpload,
    BackgroundImage,
    Image,
    CaptionOverlay,
    CommentHighlight,
    SolidColor([u8; 4]),
    TestPattern,
    Unsupported(WindowsD3d11UnsupportedFeature),
}

impl WindowsD3d11SceneSourceKind {
    fn needs_external_source(self) -> bool {
        !matches!(
            self,
            Self::SolidColor(_) | Self::TestPattern | Self::Unsupported(_)
        )
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Window => "window",
            Self::CameraUpload => "camera-upload",
            Self::BackgroundImage => "background-image",
            Self::Image => "image",
            Self::CaptionOverlay => "caption-overlay",
            Self::CommentHighlight => "comment-highlight",
            Self::SolidColor(_) => "solid-color",
            Self::TestPattern => "test-pattern",
            Self::Unsupported(feature) => feature.as_str(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11ChromaKey {
    pub(crate) key_rgb: [u8; 3],
    pub(crate) angle_threshold_degrees: f32,
    pub(crate) softness_degrees: f32,
    pub(crate) spill_suppression: f32,
    pub(crate) saturation_floor: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11LayerEffects {
    pub(crate) opacity: f32,
    pub(crate) saturation: f32,
    pub(crate) dim: f32,
    pub(crate) vignette: f32,
    pub(crate) blur_radius_px: f32,
    pub(crate) chroma_key: Option<WindowsD3d11ChromaKey>,
}

impl Default for WindowsD3d11LayerEffects {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            saturation: 1.0,
            dim: 0.0,
            vignette: 0.0,
            blur_radius_px: 0.0,
            chroma_key: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11SceneLayerInput {
    pub(crate) source_id: u64,
    pub(crate) source_kind: WindowsD3d11SceneSourceKind,
    pub(crate) source_dimensions: WindowsD3d11OutputDimensions,
    pub(crate) transform: WindowsD3d11NormalizedTransform,
    pub(crate) crop: WindowsD3d11Crop,
    pub(crate) fit: WindowsD3d11SceneFit,
    pub(crate) mirror_x: bool,
    pub(crate) mask: WindowsD3d11SceneMask,
    pub(crate) effects: WindowsD3d11LayerEffects,
    pub(crate) z_index: i32,
    pub(crate) output_targets: WindowsD3d11SceneOutputTargets,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowsD3d11ScenePlanRequest {
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
    pub(crate) orientation: WindowsD3d11CanvasOrientation,
    pub(crate) canvas_dimensions: WindowsD3d11OutputDimensions,
    pub(crate) layers: Vec<WindowsD3d11SceneLayerInput>,
    pub(crate) encoded_outputs: Vec<WindowsD3d11EncodedOutputPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PixelRect {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11PlannedLayer {
    pub(crate) source_id: u64,
    pub(crate) source_kind: WindowsD3d11SceneSourceKind,
    pub(crate) source_dimensions: WindowsD3d11OutputDimensions,
    pub(crate) destination: WindowsD3d11PixelRect,
    pub(crate) destination_normalized: [f32; 4],
    pub(crate) source_uv: [f32; 4],
    pub(crate) mirror_x: bool,
    pub(crate) mask: WindowsD3d11SceneMask,
    pub(crate) effects: WindowsD3d11LayerEffects,
    pub(crate) z_index: i32,
    pub(crate) output_targets: WindowsD3d11SceneOutputTargets,
}

impl WindowsD3d11PlannedLayer {
    pub(crate) const fn applies_to(self, target: WindowsD3d11SceneOutputTarget) -> bool {
        self.output_targets.includes(target)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowsD3d11ScenePlan {
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
    pub(crate) orientation: WindowsD3d11CanvasOrientation,
    pub(crate) canvas_dimensions: WindowsD3d11OutputDimensions,
    pub(crate) layers: Vec<WindowsD3d11PlannedLayer>,
    pub(crate) encoded_outputs: Vec<WindowsD3d11EncodedOutputPlan>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CompositorDiagnostics {
    pub(crate) composed_frames: u64,
    pub(crate) camera_upload_frames: u64,
    /// There is deliberately no production method that can increment this.
    pub(crate) production_readback_frames: u64,
    pub(crate) parity_test_readback_frames: u64,
    pub(crate) parity_test_readback_bytes: u64,
}

impl WindowsD3d11CompositorDiagnostics {
    #[cfg(test)]
    fn attribute_test_readback(&mut self, bytes: &[u8]) -> u64 {
        self.parity_test_readback_frames = self.parity_test_readback_frames.saturating_add(1);
        self.parity_test_readback_bytes = self
            .parity_test_readback_bytes
            .saturating_add(bytes.len() as u64);
        // Stable FNV-1a is enough for fixture identity and does not introduce
        // a production readback dependency or API.
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }
}

pub(crate) fn build_windows_d3d11_scene_plan(
    request: WindowsD3d11ScenePlanRequest,
) -> Result<WindowsD3d11ScenePlan, WindowsD3d11CompositorError> {
    if request.generation == 0 {
        return Err(WindowsD3d11CompositorError::new(
            WindowsD3d11CompositorErrorCode::StaleGeneration,
            "D3D11 compositor generation zero is reserved",
        ));
    }
    validate_orientation(request.orientation, request.canvas_dimensions)?;
    if request.layers.len() > MAX_SCENE_LAYERS {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "scene has {} layers; the bounded D3D11 limit is {MAX_SCENE_LAYERS}",
            request.layers.len()
        )));
    }
    if request.encoded_outputs.len() > MAX_ENCODED_OUTPUTS {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "scene has {} encoded outputs; the bounded D3D11 limit is {MAX_ENCODED_OUTPUTS}",
            request.encoded_outputs.len()
        )));
    }

    // Reject unsupported semantics before geometry or GPU state is touched.
    // This preserves an all-or-nothing D3D11 capability identity.
    if let Some(feature) = request.layers.iter().find_map(|layer| {
        if let WindowsD3d11SceneSourceKind::Unsupported(feature) = layer.source_kind {
            Some(feature)
        } else {
            None
        }
    }) {
        return Err(WindowsD3d11CompositorError::new(
            WindowsD3d11CompositorErrorCode::UnsupportedSceneFeature,
            format!(
                "scene requires unsupported D3D11 feature {}; use the named legacy compositor fallback for the whole frame",
                feature.as_str()
            ),
        ));
    }

    validate_encoded_outputs(request.canvas_dimensions, &request.encoded_outputs)?;

    let mut planned_layers = Vec::with_capacity(request.layers.len());
    for (input_order, layer) in request.layers.into_iter().enumerate() {
        validate_layer(layer)?;
        let rect = normalized_rect_to_pixels(layer.transform, request.canvas_dimensions)?;
        let fit = source_fit(layer.source_dimensions, rect, layer.fit, layer.crop)?;
        planned_layers.push((
            input_order,
            WindowsD3d11PlannedLayer {
                source_id: layer.source_id,
                source_kind: layer.source_kind,
                source_dimensions: layer.source_dimensions,
                destination: fit.destination,
                destination_normalized: [
                    fit.destination.x as f32 / request.canvas_dimensions.width as f32,
                    fit.destination.y as f32 / request.canvas_dimensions.height as f32,
                    fit.destination.width as f32 / request.canvas_dimensions.width as f32,
                    fit.destination.height as f32 / request.canvas_dimensions.height as f32,
                ],
                source_uv: [
                    fit.source_x / layer.source_dimensions.width as f32,
                    fit.source_y / layer.source_dimensions.height as f32,
                    fit.source_width / layer.source_dimensions.width as f32,
                    fit.source_height / layer.source_dimensions.height as f32,
                ],
                mirror_x: layer.mirror_x,
                mask: layer.mask,
                effects: layer.effects,
                z_index: layer.z_index,
                output_targets: layer.output_targets,
            },
        ));
    }
    planned_layers.sort_by_key(|(input_order, layer)| (layer.z_index, *input_order));

    Ok(WindowsD3d11ScenePlan {
        adapter_luid: request.adapter_luid,
        generation: request.generation,
        sequence: request.sequence,
        orientation: request.orientation,
        canvas_dimensions: request.canvas_dimensions,
        layers: planned_layers.into_iter().map(|(_, layer)| layer).collect(),
        encoded_outputs: request.encoded_outputs,
    })
}

pub(crate) fn validate_windows_d3d11_compositor_authority(
    plan: &WindowsD3d11ScenePlan,
    adapter_luid: DxgiAdapterLuid,
    generation: u64,
) -> Result<(), WindowsD3d11CompositorError> {
    if plan.adapter_luid != adapter_luid {
        return Err(WindowsD3d11CompositorError::new(
            WindowsD3d11CompositorErrorCode::AdapterMismatch,
            format!(
                "scene adapter {} does not match media-thread adapter {}",
                plan.adapter_luid, adapter_luid
            ),
        ));
    }
    if generation == 0 || plan.generation != generation {
        return Err(WindowsD3d11CompositorError::new(
            WindowsD3d11CompositorErrorCode::StaleGeneration,
            format!(
                "scene generation {} does not match media-thread generation {}",
                plan.generation, generation
            ),
        ));
    }
    Ok(())
}

fn validate_orientation(
    orientation: WindowsD3d11CanvasOrientation,
    dimensions: WindowsD3d11OutputDimensions,
) -> Result<(), WindowsD3d11CompositorError> {
    let valid = match orientation {
        WindowsD3d11CanvasOrientation::Horizontal => dimensions.width >= dimensions.height,
        WindowsD3d11CanvasOrientation::Vertical => dimensions.height >= dimensions.width,
    };
    if !valid {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} canvas cannot use dimensions {}x{}",
            orientation.as_str(),
            dimensions.width,
            dimensions.height
        )));
    }
    Ok(())
}

fn validate_encoded_outputs(
    canvas: WindowsD3d11OutputDimensions,
    outputs: &[WindowsD3d11EncodedOutputPlan],
) -> Result<(), WindowsD3d11CompositorError> {
    let mut primary_seen = false;
    let mut auxiliary_seen = false;
    for output in outputs {
        let _ =
            WindowsD3d11OutputDimensions::nv12(output.dimensions.width, output.dimensions.height)?;
        if !canvas.aspect_matches(output.dimensions) {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::UnsupportedSceneFeature,
                format!(
                    "{} output {}x{} has a different aspect ratio from the {}x{} scene; mixed-aspect multi-output composition is not yet a D3D11 capability",
                    output.role.as_str(),
                    output.dimensions.width,
                    output.dimensions.height,
                    canvas.width,
                    canvas.height
                ),
            ));
        }
        let duplicate = match output.role {
            WindowsD3d11EncodedOutputRole::Primary => {
                let duplicate = primary_seen;
                primary_seen = true;
                duplicate
            }
            WindowsD3d11EncodedOutputRole::Auxiliary => {
                let duplicate = auxiliary_seen;
                auxiliary_seen = true;
                duplicate
            }
        };
        if duplicate {
            return Err(WindowsD3d11CompositorError::invalid(format!(
                "encoded output role {} appears more than once",
                output.role.as_str()
            )));
        }
    }
    Ok(())
}

fn validate_layer(layer: WindowsD3d11SceneLayerInput) -> Result<(), WindowsD3d11CompositorError> {
    if layer.output_targets.is_empty() {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} layer {} has no output targets",
            layer.source_kind.as_str(),
            layer.source_id
        )));
    }
    let transform = layer.transform;
    if ![transform.x, transform.y, transform.width, transform.height]
        .into_iter()
        .all(f32::is_finite)
        || transform.width <= 0.0
        || transform.height <= 0.0
    {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} layer {} has a non-finite or empty transform",
            layer.source_kind.as_str(),
            layer.source_id
        )));
    }
    let effects = layer.effects;
    if ![
        effects.opacity,
        effects.saturation,
        effects.dim,
        effects.vignette,
        effects.blur_radius_px,
    ]
    .into_iter()
    .all(f32::is_finite)
        || !(0.0..=1.0).contains(&effects.opacity)
        || effects.saturation < 0.0
        || !(0.0..=1.0).contains(&effects.dim)
        || !(0.0..=1.0).contains(&effects.vignette)
        || !(0.0..=MAX_BLUR_RADIUS_PX).contains(&effects.blur_radius_px)
    {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} layer {} has invalid effect controls",
            layer.source_kind.as_str(),
            layer.source_id
        )));
    }
    if let Some(key) = effects.chroma_key
        && (![
            key.angle_threshold_degrees,
            key.softness_degrees,
            key.spill_suppression,
            key.saturation_floor,
        ]
        .into_iter()
        .all(f32::is_finite)
            || !(0.0..=180.0).contains(&key.angle_threshold_degrees)
            || !(0.0..=180.0).contains(&key.softness_degrees)
            || !(0.0..=1.0).contains(&key.spill_suppression)
            || !(0.0..=1.0).contains(&key.saturation_floor))
    {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} layer {} has invalid chroma-key controls",
            layer.source_kind.as_str(),
            layer.source_id
        )));
    }
    if matches!(layer.mask, WindowsD3d11SceneMask::Rounded { radius_pct } if radius_pct > 50) {
        return Err(WindowsD3d11CompositorError::invalid(format!(
            "{} layer {} has rounded-mask radius above 50%",
            layer.source_kind.as_str(),
            layer.source_id
        )));
    }
    Ok(())
}

fn normalized_rect_to_pixels(
    transform: WindowsD3d11NormalizedTransform,
    canvas: WindowsD3d11OutputDimensions,
) -> Result<WindowsD3d11PixelRect, WindowsD3d11CompositorError> {
    let x = normalized_to_pixel(transform.x, canvas.width).min(canvas.width.saturating_sub(1));
    let y = normalized_to_pixel(transform.y, canvas.height).min(canvas.height.saturating_sub(1));
    let max_width = canvas.width.saturating_sub(x).max(1);
    let max_height = canvas.height.saturating_sub(y).max(1);
    let width = normalized_to_span(transform.width, canvas.width).min(max_width);
    let height = normalized_to_span(transform.height, canvas.height).min(max_height);
    if width == 0 || height == 0 {
        return Err(WindowsD3d11CompositorError::invalid(
            "normalized scene transform resolved to an empty rectangle",
        ));
    }
    Ok(WindowsD3d11PixelRect {
        x,
        y,
        width,
        height,
    })
}

fn normalized_to_pixel(value: f32, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, 1.0) * span as f32).round() as u32
}

fn normalized_to_span(value: f32, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, 1.0) * span as f32)
        .round()
        .max(1.0) as u32
}

fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() { value } else { 0.0 }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SourceFit {
    destination: WindowsD3d11PixelRect,
    source_x: f32,
    source_y: f32,
    source_width: f32,
    source_height: f32,
}

fn source_fit(
    source: WindowsD3d11OutputDimensions,
    rect: WindowsD3d11PixelRect,
    fit: WindowsD3d11SceneFit,
    crop: WindowsD3d11Crop,
) -> Result<SourceFit, WindowsD3d11CompositorError> {
    let crop = crop.normalized();
    let source_x = crop.left * source.width as f32;
    let source_y = crop.top * source.height as f32;
    let source_width = source.width as f32 * crop.kept_width();
    let source_height = source.height as f32 * crop.kept_height();
    let source_aspect = source_width / source_height;
    let rect_aspect = rect.width as f32 / rect.height as f32;

    match fit {
        WindowsD3d11SceneFit::Contain => {
            let (width, height) = if source_aspect > rect_aspect {
                let width = rect.width;
                let height =
                    ((width as f32 / source_aspect).round().max(1.0) as u32).min(rect.height);
                (width, height)
            } else {
                let height = rect.height;
                let width =
                    ((height as f32 * source_aspect).round().max(1.0) as u32).min(rect.width);
                (width, height)
            };
            Ok(SourceFit {
                destination: WindowsD3d11PixelRect {
                    x: rect.x + (rect.width - width) / 2,
                    y: rect.y + (rect.height - height) / 2,
                    width,
                    height,
                },
                source_x,
                source_y,
                source_width,
                source_height,
            })
        }
        WindowsD3d11SceneFit::Cover => {
            let (source_x, source_y, source_width, source_height) = if source_aspect > rect_aspect {
                let fitted_width = source_height * rect_aspect;
                (
                    source_x + (source_width - fitted_width) / 2.0,
                    source_y,
                    fitted_width,
                    source_height,
                )
            } else {
                let fitted_height = source_width / rect_aspect;
                (
                    source_x,
                    source_y + (source_height - fitted_height) / 2.0,
                    source_width,
                    fitted_height,
                )
            };
            Ok(SourceFit {
                destination: rect,
                source_x,
                source_y,
                source_width,
                source_height,
            })
        }
    }
}

pub(crate) fn bt709_video_range_reference(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = (16 + ((11968 * r + 40258 * g + 4064 * b + 32768) >> 16)).clamp(0, 255) as u8;
    let u = (128 + ((-6596 * r - 22189 * g + 28785 * b + 32768) >> 16)).clamp(0, 255) as u8;
    let v = (128 + ((28785 * r - 26147 * g - 2638 * b + 32768) >> 16)).clamp(0, 255) as u8;
    (y, u, v)
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use crate::windows_d3d11_capture::{
        WindowsD3d11OutputRotation, WindowsD3d11Point, WindowsD3d11PointerBlendOperation,
        WindowsD3d11PointerShapeDescriptor, WindowsD3d11PointerShapeUpdate,
        WindowsD3d11PointerTransform, WindowsD3d11Rect, transform_windows_d3d11_pointer,
    };
    use crate::windows_d3d11_device::WindowsD3d11Device;
    use std::ffi::c_void;
    use std::marker::PhantomData;
    use std::mem;
    use std::rc::Rc;
    use windows::Win32::Graphics::Direct3D::Fxc::{
        D3DCOMPILE_ENABLE_STRICTNESS, D3DCOMPILE_OPTIMIZATION_LEVEL3, D3DCompile,
    };
    use windows::Win32::Graphics::Direct3D::{
        D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob, ID3DInclude,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD,
        D3D11_BLEND_SRC_ALPHA, D3D11_BUFFER_DESC, D3D11_COLOR_WRITE_ENABLE_ALL,
        D3D11_COMPARISON_NEVER, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_RENDER_TARGET_VIEW_DESC1,
        D3D11_RENDER_TARGET_VIEW_DESC1_0, D3D11_RTV_DIMENSION_TEXTURE2D, D3D11_SAMPLER_DESC,
        D3D11_TEX2D_RTV1, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        D3D11_VIEWPORT, ID3D11BlendState, ID3D11Buffer, ID3D11ClassLinkage, ID3D11DepthStencilView,
        ID3D11PixelShader, ID3D11RenderTargetView, ID3D11RenderTargetView1, ID3D11SamplerState,
        ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
    };
    #[cfg(test)]
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM,
        DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
    };
    use windows::core::{Interface, PCSTR};

    const MAX_UPLOAD_CACHE_ENTRIES: usize = 32;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum WindowsD3d11UploadPixelOrder {
        Bgra,
        Rgba,
    }

    impl WindowsD3d11UploadPixelOrder {
        fn dxgi_format(self) -> windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT {
            match self {
                Self::Bgra => DXGI_FORMAT_B8G8R8A8_UNORM,
                Self::Rgba => DXGI_FORMAT_R8G8B8A8_UNORM,
            }
        }
    }

    #[derive(Debug, Clone, Copy)]
    pub(crate) struct WindowsD3d11BgraUpload<'a> {
        pub(crate) pixels: &'a [u8],
        pub(crate) dimensions: WindowsD3d11OutputDimensions,
        pub(crate) row_pitch: u32,
        pub(crate) pixel_order: WindowsD3d11UploadPixelOrder,
        pub(crate) content_revision: u64,
        pub(crate) immutable: bool,
    }

    #[derive(Debug, Clone, Copy)]
    pub(crate) enum WindowsD3d11GpuSourceContent<'a> {
        Texture(&'a ID3D11Texture2D),
        Upload(WindowsD3d11BgraUpload<'a>),
    }

    #[derive(Debug, Clone, Copy)]
    pub(crate) struct WindowsD3d11GpuSource<'a> {
        pub(crate) source_id: u64,
        pub(crate) content: WindowsD3d11GpuSourceContent<'a>,
    }

    #[derive(Debug, Clone, Copy)]
    pub(crate) struct WindowsD3d11EncodedTarget<'a> {
        pub(crate) role: WindowsD3d11EncodedOutputRole,
        pub(crate) texture: &'a ID3D11Texture2D,
    }

    #[derive(Debug, Clone, Copy)]
    pub(crate) struct WindowsD3d11GpuTargets<'a> {
        /// Absent while no trusted preview surface generation is open. The
        /// encoded outputs remain fully rendered without paying for a BGRA
        /// preview pass that no presenter can consume.
        pub(crate) preview_bgra: Option<&'a ID3D11Texture2D>,
        pub(crate) encoded_nv12: &'a [WindowsD3d11EncodedTarget<'a>],
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11ComposedFrame {
        pub(crate) sequence: u64,
        pub(crate) preview_dimensions: Option<WindowsD3d11OutputDimensions>,
        pub(crate) encoded_outputs: Vec<WindowsD3d11EncodedOutputPlan>,
    }

    #[cfg(test)]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11ParityReadback {
        pub(crate) bgra: Vec<u8>,
        pub(crate) stable_hash: u64,
    }

    struct CompiledShaders {
        scene_vertex: ID3D11VertexShader,
        full_screen_vertex: ID3D11VertexShader,
        scene_pixel: ID3D11PixelShader,
        pointer_pixel: ID3D11PixelShader,
        nv12_luma_pixel: ID3D11PixelShader,
        nv12_chroma_pixel: ID3D11PixelShader,
    }

    struct PointerDesktopCache {
        dimensions: WindowsD3d11OutputDimensions,
        texture: ID3D11Texture2D,
        shader_resource: ID3D11ShaderResourceView,
    }

    struct PointerShapeCache {
        revision: u64,
        descriptor: WindowsD3d11PointerShapeDescriptor,
        blend: WindowsD3d11PointerBlendOperation,
        texture: ID3D11Texture2D,
        shader_resource: ID3D11ShaderResourceView,
    }

    struct UploadCacheEntry {
        source_id: u64,
        dimensions: WindowsD3d11OutputDimensions,
        pixel_order: WindowsD3d11UploadPixelOrder,
        content_revision: u64,
        last_used_sequence: u64,
        texture: ID3D11Texture2D,
        shader_resource: ID3D11ShaderResourceView,
    }

    /// At most one intermediate BGRA surface exists for each encoded role.
    /// These stay generation-owned and are resized in place when an output
    /// profile changes; frame traffic cannot grow this cache.
    struct EncodedSceneSurface {
        role: WindowsD3d11EncodedOutputRole,
        dimensions: WindowsD3d11OutputDimensions,
        _texture: ID3D11Texture2D,
        render_target: ID3D11RenderTargetView,
        shader_resource: ID3D11ShaderResourceView,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct DrawConstants {
        destination: [f32; 4],
        source_crop: [f32; 4],
        effects: [f32; 4],
        mask: [f32; 4],
        chroma_key_color: [f32; 4],
        chroma_key_controls: [f32; 4],
        source_info: [f32; 4],
        solid_color: [f32; 4],
        frame_info: [f32; 4],
    }

    pub(crate) struct WindowsD3d11Compositor {
        adapter_luid: DxgiAdapterLuid,
        generation: u64,
        shaders: CompiledShaders,
        sampler: ID3D11SamplerState,
        alpha_blend: ID3D11BlendState,
        constant_buffer: ID3D11Buffer,
        uploads: Vec<UploadCacheEntry>,
        encoded_scene_surfaces: Vec<EncodedSceneSurface>,
        pointer_desktop: Option<PointerDesktopCache>,
        pointer_shape: Option<PointerShapeCache>,
        diagnostics: WindowsD3d11CompositorDiagnostics,
        _thread_affinity: PhantomData<Rc<()>>,
    }

    impl WindowsD3d11Compositor {
        /// Must be called by the generation-owned D3D11 media thread.
        pub(crate) fn new(
            device: &WindowsD3d11Device,
            generation: u64,
        ) -> Result<Self, WindowsD3d11CompositorError> {
            if generation == 0 {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::StaleGeneration,
                    "D3D11 compositor generation zero is reserved",
                ));
            }
            let raw_device = device.raw_device();
            let shaders = compile_shaders(raw_device)?;
            let sampler = create_sampler(raw_device)?;
            let alpha_blend = create_alpha_blend(raw_device)?;
            let constant_buffer = create_constant_buffer(raw_device)?;
            Ok(Self {
                adapter_luid: device.adapter_luid(),
                generation,
                shaders,
                sampler,
                alpha_blend,
                constant_buffer,
                uploads: Vec::with_capacity(MAX_UPLOAD_CACHE_ENTRIES),
                encoded_scene_surfaces: Vec::with_capacity(MAX_ENCODED_OUTPUTS),
                pointer_desktop: None,
                pointer_shape: None,
                diagnostics: WindowsD3d11CompositorDiagnostics::default(),
                _thread_affinity: PhantomData,
            })
        }

        pub(crate) fn diagnostics(&self) -> WindowsD3d11CompositorDiagnostics {
            self.diagnostics
        }

        /// Maintains a clean Desktop Duplication surface and composites the
        /// separate pointer entirely on the generation-owned GPU. Pointer-only
        /// acquisitions redraw from the clean cache, so an old cursor can
        /// never be baked into the next published capture texture.
        #[allow(clippy::too_many_arguments)]
        pub(crate) fn composite_duplication_pointer(
            &mut self,
            device: &WindowsD3d11Device,
            destination: &ID3D11Texture2D,
            desktop_changed: bool,
            use_cached_uncomposited_desktop: bool,
            pointer_visible: bool,
            pointer_position: WindowsD3d11Point,
            rotation: WindowsD3d11OutputRotation,
            pointer_shape_revision: u64,
            pointer_shape_update: Option<&WindowsD3d11PointerShapeUpdate>,
        ) -> Result<bool, WindowsD3d11CompositorError> {
            if device.adapter_luid() != self.adapter_luid {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::AdapterMismatch,
                    "Desktop Duplication pointer destination belongs to another adapter",
                ));
            }
            let destination_desc = texture_desc(destination);
            if destination_desc.Width == 0
                || destination_desc.Height == 0
                || destination_desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
                || destination_desc.SampleDesc.Count != 1
                || destination_desc.ArraySize != 1
                || destination_desc.BindFlags & D3D11_BIND_RENDER_TARGET.0 as u32 == 0
            {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::TargetContractViolation,
                    "Desktop Duplication pointer composition requires a render-target BGRA texture",
                ));
            }
            let dimensions =
                WindowsD3d11OutputDimensions::new(destination_desc.Width, destination_desc.Height)?;
            if self
                .pointer_desktop
                .as_ref()
                .is_none_or(|cache| cache.dimensions != dimensions)
            {
                self.pointer_desktop = Some(create_pointer_desktop_cache(device, dimensions)?);
            }
            let clean_desktop = self
                .pointer_desktop
                .as_ref()
                .expect("pointer desktop cache was created above");
            if desktop_changed {
                unsafe {
                    device
                        .immediate_context()
                        .CopyResource(&clean_desktop.texture, destination);
                }
            } else if !use_cached_uncomposited_desktop {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    "pointer-only composition was not authorized to use the cached clean desktop",
                ));
            }

            if let Some(update) = pointer_shape_update {
                self.pointer_shape = Some(upload_pointer_shape(
                    device,
                    self.pointer_shape.take(),
                    pointer_shape_revision,
                    update,
                )?);
            }
            if !pointer_visible {
                unsafe {
                    device
                        .immediate_context()
                        .CopyResource(destination, &clean_desktop.texture);
                }
                return Ok(false);
            }
            let pointer_shape = self.pointer_shape.as_ref().ok_or_else(|| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    "visible Desktop Duplication pointer has no uploaded shape",
                )
            })?;
            if pointer_shape.revision != pointer_shape_revision {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    format!(
                        "pointer shape cache revision {} does not match observation {pointer_shape_revision}",
                        pointer_shape.revision
                    ),
                ));
            }
            let geometry = pointer_geometry(
                pointer_position,
                pointer_shape.descriptor,
                pointer_shape.blend,
                rotation,
                dimensions,
            )
            .ok_or_else(|| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    "visible pointer geometry fell outside the Desktop Duplication surface",
                )
            })?;
            let constants = pointer_constants(
                geometry,
                pointer_shape.descriptor,
                pointer_shape.blend,
                rotation,
                dimensions,
            );
            update_constants(
                device.immediate_context(),
                &self.constant_buffer,
                &constants,
            );
            let target = create_render_target(
                device.raw_device(),
                destination,
                "Desktop Duplication pointer",
            )?;
            let context = device.immediate_context();
            set_viewport(context, dimensions.width, dimensions.height);
            unsafe {
                context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                context.VSSetShader(&self.shaders.full_screen_vertex, None);
                context.VSSetConstantBuffers(0, Some(&[Some(self.constant_buffer.clone())]));
                context.PSSetShader(&self.shaders.pointer_pixel, None);
                context.PSSetConstantBuffers(0, Some(&[Some(self.constant_buffer.clone())]));
                context.PSSetShaderResources(
                    0,
                    Some(&[
                        Some(clean_desktop.shader_resource.clone()),
                        Some(pointer_shape.shader_resource.clone()),
                    ]),
                );
                context.OMSetBlendState(None::<&ID3D11BlendState>, None, u32::MAX);
                context.OMSetRenderTargets(Some(&[Some(target)]), None::<&ID3D11DepthStencilView>);
                context.Draw(6, 0);
                context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
                context.PSSetShaderResources(0, Some(&[None, None]));
            }
            check_device_health(device, "Desktop Duplication pointer composition")?;
            debug_assert_eq!(self.diagnostics.production_readback_frames, 0);
            Ok(true)
        }

        /// Deterministic staging readback exists only in test binaries. Its
        /// dedicated counters can never be confused with production traffic.
        #[cfg(test)]
        pub(crate) fn readback_bgra_for_parity_test(
            &mut self,
            device: &WindowsD3d11Device,
            texture: &ID3D11Texture2D,
        ) -> Result<WindowsD3d11ParityReadback, WindowsD3d11CompositorError> {
            if device.adapter_luid() != self.adapter_luid {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::AdapterMismatch,
                    "test readback texture belongs to a different media-thread adapter",
                ));
            }
            let source_desc = texture_desc(texture);
            if source_desc.Width == 0
                || source_desc.Height == 0
                || source_desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
                || source_desc.SampleDesc.Count != 1
            {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::TargetContractViolation,
                    "test parity readback requires a single-sample BGRA texture",
                ));
            }
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                ..source_desc
            };
            let mut staging = None;
            unsafe {
                device
                    .raw_device()
                    .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            }
            .map_err(|error| gpu_error(device, "create test-only staging texture", error))?;
            let staging = staging.ok_or_else(|| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                    "D3D11 returned no test-only staging texture",
                )
            })?;
            let context = device.immediate_context();
            unsafe { context.CopyResource(&staging, texture) };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
                .map_err(|error| gpu_error(device, "map test-only staging texture", error))?;

            let tight_pitch = source_desc.Width as usize * 4;
            let mapped_pitch = mapped.RowPitch as usize;
            if mapped_pitch < tight_pitch {
                unsafe { context.Unmap(&staging, 0) };
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                    format!(
                        "test-only staging pitch {mapped_pitch} is smaller than BGRA pitch {tight_pitch}"
                    ),
                ));
            }
            let mut bgra =
                Vec::with_capacity(tight_pitch.saturating_mul(source_desc.Height as usize));
            for row in 0..source_desc.Height as usize {
                let row_pointer = unsafe {
                    mapped
                        .pData
                        .cast::<u8>()
                        .add(row.saturating_mul(mapped_pitch))
                };
                let row_bytes = unsafe { std::slice::from_raw_parts(row_pointer, tight_pitch) };
                bgra.extend_from_slice(row_bytes);
            }
            unsafe { context.Unmap(&staging, 0) };
            let stable_hash = self.diagnostics.attribute_test_readback(&bgra);
            debug_assert_eq!(self.diagnostics.production_readback_frames, 0);
            Ok(WindowsD3d11ParityReadback { bgra, stable_hash })
        }

        /// Renders BGRA preview and independently scaled NV12 primary/auxiliary
        /// targets. This API has no staging texture, Map, or readback path.
        pub(crate) fn compose(
            &mut self,
            device: &WindowsD3d11Device,
            plan: &WindowsD3d11ScenePlan,
            sources: &[WindowsD3d11GpuSource<'_>],
            targets: WindowsD3d11GpuTargets<'_>,
        ) -> Result<WindowsD3d11ComposedFrame, WindowsD3d11CompositorError> {
            validate_windows_d3d11_compositor_authority(
                plan,
                device.adapter_luid(),
                self.generation,
            )?;
            validate_windows_d3d11_compositor_authority(plan, self.adapter_luid, self.generation)?;
            preflight_sources(plan, sources)?;
            preflight_targets(plan, targets)?;

            let raw_device = device.raw_device();
            let context = device.immediate_context();

            // Resolve every source before changing a destination texture. A
            // bad upload or SRV therefore rejects the whole frame.
            let mut resolved_sources = Vec::with_capacity(plan.layers.len());
            for layer in &plan.layers {
                if !layer.source_kind.needs_external_source() {
                    resolved_sources.push(None);
                    continue;
                }
                let source = sources
                    .iter()
                    .find(|source| source.source_id == layer.source_id)
                    .expect("preflight established source presence");
                let shader_resource = match source.content {
                    WindowsD3d11GpuSourceContent::Texture(texture) => {
                        create_shader_resource(raw_device, texture, "captured source")?
                    }
                    WindowsD3d11GpuSourceContent::Upload(upload) => {
                        let shader_resource = self.resolve_upload(
                            device,
                            plan.sequence,
                            layer.source_id,
                            layer.source_kind,
                            upload,
                        )?;
                        shader_resource
                    }
                };
                resolved_sources.push(Some(shader_resource));
            }

            if let Some(preview_bgra) = targets.preview_bgra {
                let preview_rtv = create_render_target(raw_device, preview_bgra, "BGRA preview")?;
                render_scene_target(
                    context,
                    &self.shaders,
                    &self.sampler,
                    &self.alpha_blend,
                    &self.constant_buffer,
                    plan,
                    &resolved_sources,
                    WindowsD3d11SceneOutputTarget::Preview,
                    plan.canvas_dimensions,
                    &preview_rtv,
                );
            }

            for output in &plan.encoded_outputs {
                let target = targets
                    .encoded_nv12
                    .iter()
                    .find(|target| target.role == output.role)
                    .expect("preflight established encoded target role");
                let (scene_render_target, scene_shader_resource) =
                    self.resolve_encoded_scene_surface(device, *output)?;
                render_scene_target(
                    context,
                    &self.shaders,
                    &self.sampler,
                    &self.alpha_blend,
                    &self.constant_buffer,
                    plan,
                    &resolved_sources,
                    WindowsD3d11SceneOutputTarget::Encoded(output.role),
                    output.dimensions,
                    &scene_render_target,
                );
                render_nv12_output(
                    device,
                    &self.shaders,
                    &self.sampler,
                    &self.constant_buffer,
                    &scene_shader_resource,
                    output.dimensions,
                    output.dimensions,
                    target.texture,
                )?;
            }

            unsafe {
                context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
                context.PSSetShaderResources(0, Some(&[None]));
            }
            check_device_health(device, "D3D11 scene composition")?;
            self.diagnostics.composed_frames = self.diagnostics.composed_frames.saturating_add(1);
            debug_assert_eq!(self.diagnostics.production_readback_frames, 0);
            Ok(WindowsD3d11ComposedFrame {
                sequence: plan.sequence,
                preview_dimensions: targets.preview_bgra.map(|_| plan.canvas_dimensions),
                encoded_outputs: plan.encoded_outputs.clone(),
            })
        }

        fn resolve_encoded_scene_surface(
            &mut self,
            device: &WindowsD3d11Device,
            output: WindowsD3d11EncodedOutputPlan,
        ) -> Result<(ID3D11RenderTargetView, ID3D11ShaderResourceView), WindowsD3d11CompositorError>
        {
            if let Some(index) = self.encoded_scene_surfaces.iter().position(|surface| {
                surface.role == output.role && surface.dimensions == output.dimensions
            }) {
                let surface = &self.encoded_scene_surfaces[index];
                return Ok((
                    surface.render_target.clone(),
                    surface.shader_resource.clone(),
                ));
            }
            if let Some(index) = self
                .encoded_scene_surfaces
                .iter()
                .position(|surface| surface.role == output.role)
            {
                self.encoded_scene_surfaces.swap_remove(index);
            }
            if self.encoded_scene_surfaces.len() >= MAX_ENCODED_OUTPUTS {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::TargetContractViolation,
                    "encoded BGRA scene-surface cache exceeded the bounded two-role contract",
                ));
            }
            let texture = create_encoded_scene_texture(device, output)?;
            let render_target =
                create_render_target(device.raw_device(), &texture, output.role.as_str())?;
            let shader_resource =
                create_shader_resource(device.raw_device(), &texture, output.role.as_str())?;
            self.encoded_scene_surfaces.push(EncodedSceneSurface {
                role: output.role,
                dimensions: output.dimensions,
                _texture: texture,
                render_target: render_target.clone(),
                shader_resource: shader_resource.clone(),
            });
            Ok((render_target, shader_resource))
        }

        fn resolve_upload(
            &mut self,
            device: &WindowsD3d11Device,
            sequence: u64,
            source_id: u64,
            source_kind: WindowsD3d11SceneSourceKind,
            upload: WindowsD3d11BgraUpload<'_>,
        ) -> Result<ID3D11ShaderResourceView, WindowsD3d11CompositorError> {
            let existing = self.uploads.iter().position(|entry| {
                entry.source_id == source_id
                    && entry.dimensions == upload.dimensions
                    && entry.pixel_order == upload.pixel_order
            });
            let index = if let Some(index) = existing {
                index
            } else {
                if self.uploads.len() == MAX_UPLOAD_CACHE_ENTRIES {
                    let evict = self
                        .uploads
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, entry)| entry.last_used_sequence)
                        .map(|(index, _)| index)
                        .expect("non-empty bounded upload cache");
                    self.uploads.swap_remove(evict);
                }
                let (texture, shader_resource) = create_upload_texture(device, source_id, upload)?;
                self.uploads.push(UploadCacheEntry {
                    source_id,
                    dimensions: upload.dimensions,
                    pixel_order: upload.pixel_order,
                    content_revision: u64::MAX,
                    last_used_sequence: sequence,
                    texture,
                    shader_resource,
                });
                self.uploads.len() - 1
            };

            let entry = &mut self.uploads[index];
            let requires_update =
                !upload.immutable || entry.content_revision != upload.content_revision;
            if requires_update {
                // This is the one explicit system-memory upload for camera
                // frames (and the bounded immutable overlay/image upload path).
                unsafe {
                    device.immediate_context().UpdateSubresource(
                        &entry.texture,
                        0,
                        None,
                        upload.pixels.as_ptr().cast::<c_void>(),
                        upload.row_pitch,
                        0,
                    );
                }
                entry.content_revision = upload.content_revision;
                if source_kind == WindowsD3d11SceneSourceKind::CameraUpload {
                    self.diagnostics.camera_upload_frames =
                        self.diagnostics.camera_upload_frames.saturating_add(1);
                }
            }
            entry.last_used_sequence = sequence;
            Ok(entry.shader_resource.clone())
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_scene_target(
        context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext4,
        shaders: &CompiledShaders,
        sampler: &ID3D11SamplerState,
        alpha_blend: &ID3D11BlendState,
        constant_buffer: &ID3D11Buffer,
        plan: &WindowsD3d11ScenePlan,
        resolved_sources: &[Option<ID3D11ShaderResourceView>],
        target: WindowsD3d11SceneOutputTarget,
        dimensions: WindowsD3d11OutputDimensions,
        render_target: &ID3D11RenderTargetView,
    ) {
        set_viewport(context, dimensions.width, dimensions.height);
        // SAFETY: all D3D11 objects belong to the same generation-owned
        // device and are used only on its media thread.
        unsafe {
            context.OMSetRenderTargets(
                Some(&[Some(render_target.clone())]),
                None::<&ID3D11DepthStencilView>,
            );
            context.ClearRenderTargetView(render_target, &[0.0, 0.0, 0.0, 1.0]);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&shaders.scene_vertex, None);
            context.PSSetShader(&shaders.scene_pixel, None);
            context.VSSetConstantBuffers(0, Some(&[Some(constant_buffer.clone())]));
            context.PSSetConstantBuffers(0, Some(&[Some(constant_buffer.clone())]));
            context.PSSetSamplers(0, Some(&[Some(sampler.clone())]));
            context.OMSetBlendState(alpha_blend, None, u32::MAX);
        }

        for (layer, shader_resource) in plan.layers.iter().zip(resolved_sources) {
            if !layer.applies_to(target) {
                continue;
            }
            let constants = layer_constants(layer, plan, dimensions);
            update_constants(context, constant_buffer, &constants);
            // Procedural layers deliberately bind a null SRV.
            unsafe {
                context.PSSetShaderResources(0, Some(&[shader_resource.clone()]));
                context.Draw(6, 0);
            }
        }

        // Never leave an intermediate simultaneously bound as RTV and SRV.
        unsafe {
            context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
            context.PSSetShaderResources(0, Some(&[None]));
        }
    }

    fn preflight_sources(
        plan: &WindowsD3d11ScenePlan,
        sources: &[WindowsD3d11GpuSource<'_>],
    ) -> Result<(), WindowsD3d11CompositorError> {
        if sources.len() > MAX_SCENE_LAYERS {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                format!(
                    "source table has {} entries; bounded limit is {MAX_SCENE_LAYERS}",
                    sources.len()
                ),
            ));
        }
        for (index, source) in sources.iter().enumerate() {
            if sources[..index]
                .iter()
                .any(|prior| prior.source_id == source.source_id)
            {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    format!("source ID {} appears more than once", source.source_id),
                ));
            }
            if let WindowsD3d11GpuSourceContent::Upload(upload) = source.content {
                validate_upload(source.source_id, upload)?;
            }
        }

        for layer in &plan.layers {
            if !layer.source_kind.needs_external_source() {
                continue;
            }
            let Some(source) = sources
                .iter()
                .find(|source| source.source_id == layer.source_id)
            else {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    format!(
                        "{} layer {} has no GPU source",
                        layer.source_kind.as_str(),
                        layer.source_id
                    ),
                ));
            };
            match (layer.source_kind, source.content) {
                (
                    WindowsD3d11SceneSourceKind::CameraUpload,
                    WindowsD3d11GpuSourceContent::Upload(upload),
                ) if upload.dimensions == layer.source_dimensions => {}
                (
                    WindowsD3d11SceneSourceKind::CameraUpload,
                    WindowsD3d11GpuSourceContent::Texture(_),
                ) => {
                    return Err(WindowsD3d11CompositorError::new(
                        WindowsD3d11CompositorErrorCode::SourceContractViolation,
                        "camera source must use the explicit bounded BGRA upload contract",
                    ));
                }
                (_, WindowsD3d11GpuSourceContent::Upload(upload))
                    if upload.dimensions == layer.source_dimensions => {}
                (_, WindowsD3d11GpuSourceContent::Texture(texture)) => {
                    validate_source_texture(layer, texture)?;
                }
                _ => {
                    return Err(WindowsD3d11CompositorError::new(
                        WindowsD3d11CompositorErrorCode::SourceContractViolation,
                        format!(
                            "{} layer {} dimensions do not match its upload",
                            layer.source_kind.as_str(),
                            layer.source_id
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_upload(
        source_id: u64,
        upload: WindowsD3d11BgraUpload<'_>,
    ) -> Result<(), WindowsD3d11CompositorError> {
        let minimum_pitch = upload.dimensions.width.checked_mul(4).ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                format!("upload source {source_id} row pitch overflowed"),
            )
        })?;
        let required_bytes = usize::try_from(upload.row_pitch)
            .ok()
            .and_then(|pitch| pitch.checked_mul(upload.dimensions.height as usize))
            .ok_or_else(|| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    format!("upload source {source_id} byte count overflowed"),
                )
            })?;
        if upload.row_pitch < minimum_pitch || upload.pixels.len() < required_bytes {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                format!(
                    "upload source {source_id} provides {} bytes at pitch {}, but {} bytes at pitch {minimum_pitch} are required",
                    upload.pixels.len(),
                    upload.row_pitch,
                    usize::try_from(minimum_pitch).unwrap_or(usize::MAX)
                        * upload.dimensions.height as usize
                ),
            ));
        }
        Ok(())
    }

    fn validate_source_texture(
        layer: &WindowsD3d11PlannedLayer,
        texture: &ID3D11Texture2D,
    ) -> Result<(), WindowsD3d11CompositorError> {
        let desc = texture_desc(texture);
        if desc.Width != layer.source_dimensions.width
            || desc.Height != layer.source_dimensions.height
            || !matches!(
                desc.Format,
                DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_R8G8B8A8_UNORM
            )
            || desc.BindFlags & D3D11_BIND_SHADER_RESOURCE.0 as u32 == 0
        {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                format!(
                    "{} layer {} requires shader-readable BGRA/RGBA {}x{}, got format {:?} {}x{} with bind flags 0x{:x}",
                    layer.source_kind.as_str(),
                    layer.source_id,
                    layer.source_dimensions.width,
                    layer.source_dimensions.height,
                    desc.Format,
                    desc.Width,
                    desc.Height,
                    desc.BindFlags
                ),
            ));
        }
        Ok(())
    }

    fn preflight_targets(
        plan: &WindowsD3d11ScenePlan,
        targets: WindowsD3d11GpuTargets<'_>,
    ) -> Result<(), WindowsD3d11CompositorError> {
        if let Some(preview_bgra) = targets.preview_bgra {
            validate_target_texture(
                "preview",
                preview_bgra,
                plan.canvas_dimensions,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                D3D11_BIND_RENDER_TARGET.0 as u32 | D3D11_BIND_SHADER_RESOURCE.0 as u32,
            )?;
        }
        if targets.preview_bgra.is_none() && targets.encoded_nv12.is_empty() {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::TargetContractViolation,
                "composition requires a preview or encoded target",
            ));
        }
        if targets.encoded_nv12.len() != plan.encoded_outputs.len() {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::TargetContractViolation,
                format!(
                    "plan has {} encoded outputs but {} NV12 targets were supplied",
                    plan.encoded_outputs.len(),
                    targets.encoded_nv12.len()
                ),
            ));
        }
        for output in &plan.encoded_outputs {
            let Some(target) = targets
                .encoded_nv12
                .iter()
                .find(|target| target.role == output.role)
            else {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::TargetContractViolation,
                    format!("missing {} NV12 target", output.role.as_str()),
                ));
            };
            validate_target_texture(
                output.role.as_str(),
                target.texture,
                output.dimensions,
                DXGI_FORMAT_NV12,
                D3D11_BIND_RENDER_TARGET.0 as u32,
            )?;
        }
        for (index, target) in targets.encoded_nv12.iter().enumerate() {
            if targets.encoded_nv12[..index]
                .iter()
                .any(|prior| prior.role == target.role)
            {
                return Err(WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::TargetContractViolation,
                    format!(
                        "{} NV12 target appears more than once",
                        target.role.as_str()
                    ),
                ));
            }
        }
        Ok(())
    }

    fn validate_target_texture(
        label: &str,
        texture: &ID3D11Texture2D,
        dimensions: WindowsD3d11OutputDimensions,
        format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
        required_bind_flags: u32,
    ) -> Result<(), WindowsD3d11CompositorError> {
        let desc = texture_desc(texture);
        if desc.Width != dimensions.width
            || desc.Height != dimensions.height
            || desc.Format != format
            || desc.BindFlags & required_bind_flags != required_bind_flags
            || desc.SampleDesc.Count != 1
            || desc.ArraySize != 1
        {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::TargetContractViolation,
                format!(
                    "{label} target must be {:?} {}x{}, single-sample, with bind flags 0x{required_bind_flags:x}; got {:?} {}x{}, samples {}, array {}, bind flags 0x{:x}",
                    format,
                    dimensions.width,
                    dimensions.height,
                    desc.Format,
                    desc.Width,
                    desc.Height,
                    desc.SampleDesc.Count,
                    desc.ArraySize,
                    desc.BindFlags
                ),
            ));
        }
        Ok(())
    }

    fn texture_desc(texture: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: the output points to initialized local storage.
        unsafe { texture.GetDesc(&mut desc) };
        desc
    }

    fn layer_constants(
        layer: &WindowsD3d11PlannedLayer,
        plan: &WindowsD3d11ScenePlan,
        target_dimensions: WindowsD3d11OutputDimensions,
    ) -> DrawConstants {
        let (mask_kind, radius) = match layer.mask {
            WindowsD3d11SceneMask::None => (0.0, 0.0),
            WindowsD3d11SceneMask::Circle => (1.0, 0.5),
            WindowsD3d11SceneMask::Rounded { radius_pct } => {
                (2.0, radius_pct.min(50) as f32 / 100.0)
            }
        };
        let (source_kind, solid_color) = match layer.source_kind {
            WindowsD3d11SceneSourceKind::SolidColor(rgba) => (
                1.0,
                [
                    rgba[0] as f32 / 255.0,
                    rgba[1] as f32 / 255.0,
                    rgba[2] as f32 / 255.0,
                    rgba[3] as f32 / 255.0,
                ],
            ),
            WindowsD3d11SceneSourceKind::TestPattern => (2.0, [0.0; 4]),
            _ => (0.0, [0.0; 4]),
        };
        let (key_color, key_controls) = if let Some(key) = layer.effects.chroma_key {
            (
                [
                    key.key_rgb[0] as f32 / 255.0,
                    key.key_rgb[1] as f32 / 255.0,
                    key.key_rgb[2] as f32 / 255.0,
                    1.0,
                ],
                [
                    key.angle_threshold_degrees / 180.0,
                    key.softness_degrees / 180.0,
                    key.spill_suppression,
                    key.saturation_floor,
                ],
            )
        } else {
            ([0.0; 4], [0.0; 4])
        };
        DrawConstants {
            destination: layer.destination_normalized,
            source_crop: layer.source_uv,
            effects: [
                layer.effects.opacity,
                layer.effects.saturation,
                layer.effects.dim,
                layer.effects.vignette,
            ],
            mask: [
                if layer.mirror_x { 1.0 } else { 0.0 },
                mask_kind,
                radius,
                layer.destination.width as f32 / layer.destination.height.max(1) as f32,
            ],
            chroma_key_color: key_color,
            chroma_key_controls: key_controls,
            source_info: [
                1.0 / layer.source_dimensions.width as f32,
                1.0 / layer.source_dimensions.height as f32,
                layer.effects.blur_radius_px,
                source_kind,
            ],
            solid_color,
            frame_info: [
                1.0 / target_dimensions.width as f32,
                1.0 / target_dimensions.height as f32,
                (plan.sequence & 0x00ff_ffff) as f32,
                0.0,
            ],
        }
    }

    fn conversion_constants(source_dimensions: WindowsD3d11OutputDimensions) -> DrawConstants {
        DrawConstants {
            destination: [0.0, 0.0, 1.0, 1.0],
            source_crop: [0.0, 0.0, 1.0, 1.0],
            effects: [1.0, 1.0, 0.0, 0.0],
            source_info: [
                1.0 / source_dimensions.width as f32,
                1.0 / source_dimensions.height as f32,
                0.0,
                0.0,
            ],
            frame_info: [
                1.0 / source_dimensions.width as f32,
                1.0 / source_dimensions.height as f32,
                0.0,
                0.0,
            ],
            ..DrawConstants::default()
        }
    }

    fn update_constants(
        context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext4,
        constant_buffer: &ID3D11Buffer,
        constants: &DrawConstants,
    ) {
        // SAFETY: DrawConstants is repr(C), 16-byte aligned in size, and the
        // immediate context consumes the bytes during this call.
        unsafe {
            context.UpdateSubresource(
                constant_buffer,
                0,
                None,
                (constants as *const DrawConstants).cast::<c_void>(),
                0,
                0,
            );
        }
    }

    fn render_nv12_output(
        device: &WindowsD3d11Device,
        shaders: &CompiledShaders,
        sampler: &ID3D11SamplerState,
        constant_buffer: &ID3D11Buffer,
        preview_srv: &ID3D11ShaderResourceView,
        preview_dimensions: WindowsD3d11OutputDimensions,
        output_dimensions: WindowsD3d11OutputDimensions,
        output: &ID3D11Texture2D,
    ) -> Result<(), WindowsD3d11CompositorError> {
        let raw_device = device.raw_device();
        let context = device.immediate_context();
        let luma = create_nv12_plane_target(raw_device, output, 0, DXGI_FORMAT_R8_UNORM)?;
        let chroma = create_nv12_plane_target(raw_device, output, 1, DXGI_FORMAT_R8G8_UNORM)?;
        let constants = conversion_constants(preview_dimensions);
        update_constants(context, constant_buffer, &constants);
        unsafe {
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&shaders.full_screen_vertex, None);
            context.VSSetConstantBuffers(0, Some(&[Some(constant_buffer.clone())]));
            context.PSSetConstantBuffers(0, Some(&[Some(constant_buffer.clone())]));
            context.PSSetSamplers(0, Some(&[Some(sampler.clone())]));
            context.PSSetShaderResources(0, Some(&[Some(preview_srv.clone())]));
            context.OMSetBlendState(None::<&ID3D11BlendState>, None, u32::MAX);
        }

        set_viewport(context, output_dimensions.width, output_dimensions.height);
        unsafe {
            context.OMSetRenderTargets(Some(&[Some(luma)]), None::<&ID3D11DepthStencilView>);
            context.PSSetShader(&shaders.nv12_luma_pixel, None);
            context.Draw(6, 0);
        }
        set_viewport(
            context,
            output_dimensions.width / 2,
            output_dimensions.height / 2,
        );
        unsafe {
            context.OMSetRenderTargets(Some(&[Some(chroma)]), None::<&ID3D11DepthStencilView>);
            context.PSSetShader(&shaders.nv12_chroma_pixel, None);
            context.Draw(6, 0);
            context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
            context.PSSetShaderResources(0, Some(&[None]));
        }
        Ok(())
    }

    fn set_viewport(
        context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext4,
        width: u32,
        height: u32,
    ) {
        let viewport = D3D11_VIEWPORT {
            TopLeftX: 0.0,
            TopLeftY: 0.0,
            Width: width as f32,
            Height: height as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        };
        unsafe { context.RSSetViewports(Some(&[viewport])) };
    }

    fn compile_shaders(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
    ) -> Result<CompiledShaders, WindowsD3d11CompositorError> {
        let scene_vertex_bytes = compile_shader("SceneVs", "vs_5_0")?;
        let full_screen_vertex_bytes = compile_shader("FullScreenVs", "vs_5_0")?;
        let scene_pixel_bytes = compile_shader("ScenePs", "ps_5_0")?;
        let pointer_pixel_bytes = compile_shader("PointerPs", "ps_5_0")?;
        let nv12_luma_bytes = compile_shader("Nv12LumaPs", "ps_5_0")?;
        let nv12_chroma_bytes = compile_shader("Nv12ChromaPs", "ps_5_0")?;

        let mut scene_vertex = None;
        let mut full_screen_vertex = None;
        let mut scene_pixel = None;
        let mut pointer_pixel = None;
        let mut nv12_luma_pixel = None;
        let mut nv12_chroma_pixel = None;
        unsafe {
            device.CreateVertexShader(
                &scene_vertex_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut scene_vertex),
            )
        }
        .map_err(|error| shader_creation_error("SceneVs", error))?;
        unsafe {
            device.CreateVertexShader(
                &full_screen_vertex_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut full_screen_vertex),
            )
        }
        .map_err(|error| shader_creation_error("FullScreenVs", error))?;
        unsafe {
            device.CreatePixelShader(
                &scene_pixel_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut scene_pixel),
            )
        }
        .map_err(|error| shader_creation_error("ScenePs", error))?;
        unsafe {
            device.CreatePixelShader(
                &pointer_pixel_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut pointer_pixel),
            )
        }
        .map_err(|error| shader_creation_error("PointerPs", error))?;
        unsafe {
            device.CreatePixelShader(
                &nv12_luma_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut nv12_luma_pixel),
            )
        }
        .map_err(|error| shader_creation_error("Nv12LumaPs", error))?;
        unsafe {
            device.CreatePixelShader(
                &nv12_chroma_bytes,
                None::<&ID3D11ClassLinkage>,
                Some(&mut nv12_chroma_pixel),
            )
        }
        .map_err(|error| shader_creation_error("Nv12ChromaPs", error))?;

        Ok(CompiledShaders {
            scene_vertex: require_shader(scene_vertex, "SceneVs")?,
            full_screen_vertex: require_shader(full_screen_vertex, "FullScreenVs")?,
            scene_pixel: require_shader(scene_pixel, "ScenePs")?,
            pointer_pixel: require_shader(pointer_pixel, "PointerPs")?,
            nv12_luma_pixel: require_shader(nv12_luma_pixel, "Nv12LumaPs")?,
            nv12_chroma_pixel: require_shader(nv12_chroma_pixel, "Nv12ChromaPs")?,
        })
    }

    fn compile_shader(
        entry_point: &'static str,
        target: &'static str,
    ) -> Result<Vec<u8>, WindowsD3d11CompositorError> {
        let entry = nul_terminated(entry_point);
        let target_bytes = nul_terminated(target);
        let mut code: Option<ID3DBlob> = None;
        let mut errors: Option<ID3DBlob> = None;
        let result = unsafe {
            D3DCompile(
                WINDOWS_D3D11_SHADER_SOURCE.as_ptr().cast::<c_void>(),
                WINDOWS_D3D11_SHADER_SOURCE.len(),
                PCSTR(b"windows_d3d11_shaders.hlsl\0".as_ptr()),
                None,
                None::<&ID3DInclude>,
                PCSTR(entry.as_ptr()),
                PCSTR(target_bytes.as_ptr()),
                D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
                0,
                &mut code,
                Some(&mut errors),
            )
        };
        if let Err(error) = result {
            let compiler_detail = errors
                .as_ref()
                .map(blob_message)
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| error.to_string());
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::ShaderCompileFailed,
                format!(
                    "{entry_point} ({target}) failed to compile; use legacy compositor fallback: {compiler_detail}"
                ),
            ));
        }
        let code = code.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::ShaderCompileFailed,
                format!(
                    "{entry_point} ({target}) compiled without bytecode; use legacy compositor fallback"
                ),
            )
        })?;
        let bytes = unsafe {
            std::slice::from_raw_parts(code.GetBufferPointer().cast::<u8>(), code.GetBufferSize())
        };
        Ok(bytes.to_vec())
    }

    fn nul_terminated(value: &str) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(value.len() + 1);
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
        bytes
    }

    fn blob_message(blob: &ID3DBlob) -> String {
        let bytes = unsafe {
            std::slice::from_raw_parts(blob.GetBufferPointer().cast::<u8>(), blob.GetBufferSize())
        };
        String::from_utf8_lossy(bytes)
            .trim_matches(char::from(0))
            .trim()
            .to_owned()
    }

    fn shader_creation_error(
        entry_point: &str,
        error: windows::core::Error,
    ) -> WindowsD3d11CompositorError {
        WindowsD3d11CompositorError::new(
            WindowsD3d11CompositorErrorCode::ShaderCompileFailed,
            format!(
                "{entry_point} bytecode was rejected by D3D11; use legacy compositor fallback: {error}"
            ),
        )
    }

    fn require_shader<T>(
        shader: Option<T>,
        entry_point: &str,
    ) -> Result<T, WindowsD3d11CompositorError> {
        shader.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::ShaderCompileFailed,
                format!("D3D11 returned no {entry_point} shader; use legacy compositor fallback"),
            )
        })
    }

    fn create_sampler(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
    ) -> Result<ID3D11SamplerState, WindowsD3d11CompositorError> {
        let desc = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            MaxLOD: f32::MAX,
            ..D3D11_SAMPLER_DESC::default()
        };
        let mut sampler = None;
        unsafe { device.CreateSamplerState(&desc, Some(&mut sampler)) }.map_err(|error| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("failed to create D3D11 linear clamp sampler: {error}"),
            )
        })?;
        sampler.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                "D3D11 returned no linear clamp sampler",
            )
        })
    }

    fn create_alpha_blend(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
    ) -> Result<ID3D11BlendState, WindowsD3d11CompositorError> {
        let desc = alpha_blend_desc();
        let mut blend = None;
        unsafe { device.CreateBlendState(&desc, Some(&mut blend)) }.map_err(|error| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("failed to create D3D11 alpha blend state: {error}"),
            )
        })?;
        blend.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                "D3D11 returned no alpha blend state",
            )
        })
    }

    pub(super) fn alpha_blend_desc() -> D3D11_BLEND_DESC {
        let mut desc = D3D11_BLEND_DESC::default();
        desc.RenderTarget[0].BlendEnable = true.into();
        desc.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
        desc.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        desc.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        desc.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        desc.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        desc.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        desc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8;
        desc
    }

    fn create_constant_buffer(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
    ) -> Result<ID3D11Buffer, WindowsD3d11CompositorError> {
        debug_assert_eq!(mem::size_of::<DrawConstants>() % 16, 0);
        let desc = D3D11_BUFFER_DESC {
            ByteWidth: mem::size_of::<DrawConstants>() as u32,
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
            ..D3D11_BUFFER_DESC::default()
        };
        let mut buffer = None;
        unsafe { device.CreateBuffer(&desc, None, Some(&mut buffer)) }.map_err(|error| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("failed to create D3D11 draw constant buffer: {error}"),
            )
        })?;
        buffer.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                "D3D11 returned no draw constant buffer",
            )
        })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct PointerGeometry {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    }

    fn create_pointer_desktop_cache(
        device: &WindowsD3d11Device,
        dimensions: WindowsD3d11OutputDimensions,
    ) -> Result<PointerDesktopCache, WindowsD3d11CompositorError> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: dimensions.width,
            Height: dimensions.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..D3D11_TEXTURE2D_DESC::default()
        };
        let mut texture = None;
        unsafe {
            device
                .raw_device()
                .CreateTexture2D(&desc, None, Some(&mut texture))
        }
        .map_err(|error| gpu_error(device, "create clean pointer desktop cache", error))?;
        let texture = texture.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                "D3D11 returned no clean pointer desktop cache texture",
            )
        })?;
        let shader_resource =
            create_shader_resource(device.raw_device(), &texture, "clean pointer desktop")?;
        Ok(PointerDesktopCache {
            dimensions,
            texture,
            shader_resource,
        })
    }

    fn upload_pointer_shape(
        device: &WindowsD3d11Device,
        _existing: Option<PointerShapeCache>,
        revision: u64,
        update: &WindowsD3d11PointerShapeUpdate,
    ) -> Result<PointerShapeCache, WindowsD3d11CompositorError> {
        if revision == 0 {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                "Desktop Duplication pointer shape revision zero is reserved",
            ));
        }
        let blend = update
            .descriptor
            .validate(update.bytes.len())
            .map_err(|error| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    error.to_string(),
                )
            })?;
        if blend != update.blend {
            return Err(WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                "Desktop Duplication pointer blend operation did not match its descriptor",
            ));
        }
        let (width, height) = pointer_source_dimensions(update.descriptor, blend);
        let row_pitch = width.checked_mul(4).ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                "Desktop Duplication pointer upload row pitch overflowed",
            )
        })?;
        let pixels = pointer_upload_bgra(update, width, height)?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..D3D11_TEXTURE2D_DESC::default()
        };
        let mut texture = None;
        unsafe {
            device
                .raw_device()
                .CreateTexture2D(&desc, None, Some(&mut texture))
        }
        .map_err(|error| gpu_error(device, "create pointer shape texture", error))?;
        let texture = texture.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                "D3D11 returned no pointer shape texture",
            )
        })?;
        unsafe {
            device.immediate_context().UpdateSubresource(
                &texture,
                0,
                None,
                pixels.as_ptr().cast::<c_void>(),
                row_pitch,
                0,
            );
        }
        let shader_resource =
            create_shader_resource(device.raw_device(), &texture, "pointer shape")?;
        Ok(PointerShapeCache {
            revision,
            descriptor: update.descriptor,
            blend,
            texture,
            shader_resource,
        })
    }

    fn pointer_upload_bgra(
        update: &WindowsD3d11PointerShapeUpdate,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, WindowsD3d11CompositorError> {
        let tight_pitch = usize::try_from(width)
            .ok()
            .and_then(|width| width.checked_mul(4))
            .ok_or_else(|| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::SourceContractViolation,
                    "Desktop Duplication pointer tight pitch overflowed",
                )
            })?;
        let byte_len = tight_pitch.checked_mul(height as usize).ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::SourceContractViolation,
                "Desktop Duplication pointer upload byte count overflowed",
            )
        })?;
        let mut pixels = vec![0_u8; byte_len];
        match update.blend {
            WindowsD3d11PointerBlendOperation::Alpha
            | WindowsD3d11PointerBlendOperation::MaskedColorXor => {
                let source_pitch = update.descriptor.pitch as usize;
                if source_pitch < tight_pitch {
                    return Err(WindowsD3d11CompositorError::new(
                        WindowsD3d11CompositorErrorCode::SourceContractViolation,
                        "Desktop Duplication color pointer pitch is smaller than width * 4",
                    ));
                }
                for row in 0..height as usize {
                    let source_start = row.saturating_mul(source_pitch);
                    let destination_start = row.saturating_mul(tight_pitch);
                    pixels[destination_start..destination_start + tight_pitch]
                        .copy_from_slice(&update.bytes[source_start..source_start + tight_pitch]);
                }
            }
            WindowsD3d11PointerBlendOperation::AndThenXor { plane_height } => {
                debug_assert_eq!(plane_height, height);
                let source_pitch = update.descriptor.pitch as usize;
                let minimum_pitch = (width as usize).div_ceil(8);
                if source_pitch < minimum_pitch {
                    return Err(WindowsD3d11CompositorError::new(
                        WindowsD3d11CompositorErrorCode::SourceContractViolation,
                        "Desktop Duplication monochrome pointer pitch is smaller than its bit width",
                    ));
                }
                let xor_plane_start = source_pitch.saturating_mul(height as usize);
                for y in 0..height as usize {
                    for x in 0..width as usize {
                        let bit = 7 - (x & 7);
                        let byte = x / 8;
                        let and = (update.bytes[y * source_pitch + byte] >> bit) & 1;
                        let xor =
                            (update.bytes[xor_plane_start + y * source_pitch + byte] >> bit) & 1;
                        let destination = y * tight_pitch + x * 4;
                        // BGRA storage maps byte 2 to shader `.r` (AND) and
                        // byte 1 to `.g` (XOR).
                        pixels[destination + 1] = xor.saturating_mul(255);
                        pixels[destination + 2] = and.saturating_mul(255);
                        pixels[destination + 3] = 255;
                    }
                }
            }
        }
        Ok(pixels)
    }

    const fn pointer_source_dimensions(
        descriptor: WindowsD3d11PointerShapeDescriptor,
        blend: WindowsD3d11PointerBlendOperation,
    ) -> (u32, u32) {
        let height = match blend {
            WindowsD3d11PointerBlendOperation::AndThenXor { plane_height } => plane_height,
            _ => descriptor.height,
        };
        (descriptor.width, height)
    }

    fn pointer_geometry(
        pointer_position: WindowsD3d11Point,
        descriptor: WindowsD3d11PointerShapeDescriptor,
        blend: WindowsD3d11PointerBlendOperation,
        rotation: WindowsD3d11OutputRotation,
        dimensions: WindowsD3d11OutputDimensions,
    ) -> Option<PointerGeometry> {
        let (source_width, source_height) = pointer_source_dimensions(descriptor, blend);
        let hotspot = WindowsD3d11Point {
            x: descriptor.hotspot_x,
            y: descriptor.hotspot_y,
        };
        let transformed_hotspot = transform_windows_d3d11_pointer(
            pointer_position,
            WindowsD3d11Point { x: 0, y: 0 },
            WindowsD3d11PointerTransform {
                source_width: dimensions.width,
                source_height: dimensions.height,
                rotation,
                crop: WindowsD3d11Rect {
                    left: 0,
                    top: 0,
                    right: i32::try_from(dimensions.width).ok()?,
                    bottom: i32::try_from(dimensions.height).ok()?,
                },
                destination_width: dimensions.width,
                destination_height: dimensions.height,
            },
        )?;
        let (rotated_hotspot_x, rotated_hotspot_y, width, height) = match rotation {
            WindowsD3d11OutputRotation::Identity => {
                (hotspot.x, hotspot.y, source_width, source_height)
            }
            WindowsD3d11OutputRotation::Rotate90 => (
                i32::try_from(source_height)
                    .ok()?
                    .checked_sub(1)?
                    .checked_sub(hotspot.y)?,
                hotspot.x,
                source_height,
                source_width,
            ),
            WindowsD3d11OutputRotation::Rotate180 => (
                i32::try_from(source_width)
                    .ok()?
                    .checked_sub(1)?
                    .checked_sub(hotspot.x)?,
                i32::try_from(source_height)
                    .ok()?
                    .checked_sub(1)?
                    .checked_sub(hotspot.y)?,
                source_width,
                source_height,
            ),
            WindowsD3d11OutputRotation::Rotate270 => (
                hotspot.y,
                i32::try_from(source_width)
                    .ok()?
                    .checked_sub(1)?
                    .checked_sub(hotspot.x)?,
                source_height,
                source_width,
            ),
        };
        Some(PointerGeometry {
            x: transformed_hotspot.x.checked_sub(rotated_hotspot_x)?,
            y: transformed_hotspot.y.checked_sub(rotated_hotspot_y)?,
            width,
            height,
        })
    }

    fn pointer_constants(
        geometry: PointerGeometry,
        descriptor: WindowsD3d11PointerShapeDescriptor,
        blend: WindowsD3d11PointerBlendOperation,
        rotation: WindowsD3d11OutputRotation,
        dimensions: WindowsD3d11OutputDimensions,
    ) -> DrawConstants {
        let (source_width, source_height) = pointer_source_dimensions(descriptor, blend);
        let rotation = match rotation {
            WindowsD3d11OutputRotation::Identity => 0.0,
            WindowsD3d11OutputRotation::Rotate90 => 1.0,
            WindowsD3d11OutputRotation::Rotate180 => 2.0,
            WindowsD3d11OutputRotation::Rotate270 => 3.0,
        };
        let mode = match blend {
            WindowsD3d11PointerBlendOperation::Alpha => 1.0,
            WindowsD3d11PointerBlendOperation::AndThenXor { .. } => 2.0,
            WindowsD3d11PointerBlendOperation::MaskedColorXor => 3.0,
        };
        DrawConstants {
            destination: [
                geometry.x as f32,
                geometry.y as f32,
                geometry.width as f32,
                geometry.height as f32,
            ],
            source_info: [source_width as f32, source_height as f32, rotation, mode],
            frame_info: [dimensions.width as f32, dimensions.height as f32, 0.0, 0.0],
            ..DrawConstants::default()
        }
    }

    fn create_upload_texture(
        device: &WindowsD3d11Device,
        source_id: u64,
        upload: WindowsD3d11BgraUpload<'_>,
    ) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView), WindowsD3d11CompositorError> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: upload.dimensions.width,
            Height: upload.dimensions.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: upload.pixel_order.dxgi_format(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..D3D11_TEXTURE2D_DESC::default()
        };
        let mut texture = None;
        unsafe {
            device
                .raw_device()
                .CreateTexture2D(&desc, None, Some(&mut texture))
        }
        .map_err(|error| {
            gpu_error(
                device,
                &format!("create upload texture for source {source_id}"),
                error,
            )
        })?;
        let texture = texture.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("D3D11 returned no upload texture for source {source_id}"),
            )
        })?;
        let shader_resource =
            create_shader_resource(device.raw_device(), &texture, "upload texture")?;
        Ok((texture, shader_resource))
    }

    fn create_encoded_scene_texture(
        device: &WindowsD3d11Device,
        output: WindowsD3d11EncodedOutputPlan,
    ) -> Result<ID3D11Texture2D, WindowsD3d11CompositorError> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: output.dimensions.width,
            Height: output.dimensions.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32 | D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..D3D11_TEXTURE2D_DESC::default()
        };
        let mut texture = None;
        unsafe {
            device
                .raw_device()
                .CreateTexture2D(&desc, None, Some(&mut texture))
        }
        .map_err(|error| {
            gpu_error(
                device,
                &format!("create {} BGRA scene surface", output.role.as_str()),
                error,
            )
        })?;
        texture.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!(
                    "D3D11 returned no {} BGRA scene surface",
                    output.role.as_str()
                ),
            )
        })
    }

    fn create_shader_resource(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
        texture: &ID3D11Texture2D,
        label: &str,
    ) -> Result<ID3D11ShaderResourceView, WindowsD3d11CompositorError> {
        let mut view = None;
        unsafe { device.CreateShaderResourceView(texture, None, Some(&mut view)) }.map_err(
            |error| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                    format!("failed to create {label} shader-resource view: {error}"),
                )
            },
        )?;
        view.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("D3D11 returned no {label} shader-resource view"),
            )
        })
    }

    fn create_render_target(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
        texture: &ID3D11Texture2D,
        label: &str,
    ) -> Result<ID3D11RenderTargetView, WindowsD3d11CompositorError> {
        let mut view = None;
        unsafe { device.CreateRenderTargetView(texture, None, Some(&mut view)) }.map_err(
            |error| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                    format!("failed to create {label} render-target view: {error}"),
                )
            },
        )?;
        view.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("D3D11 returned no {label} render-target view"),
            )
        })
    }

    fn create_nv12_plane_target(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device5,
        texture: &ID3D11Texture2D,
        plane: u32,
        format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    ) -> Result<ID3D11RenderTargetView, WindowsD3d11CompositorError> {
        let desc = D3D11_RENDER_TARGET_VIEW_DESC1 {
            Format: format,
            ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_RENDER_TARGET_VIEW_DESC1_0 {
                Texture2D: D3D11_TEX2D_RTV1 {
                    MipSlice: 0,
                    PlaneSlice: plane,
                },
            },
        };
        let mut view: Option<ID3D11RenderTargetView1> = None;
        unsafe { device.CreateRenderTargetView1(texture, Some(&desc), Some(&mut view)) }
            .map_err(|error| {
                WindowsD3d11CompositorError::new(
                    WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                    format!(
                        "failed to create NV12 plane {plane} render-target view; use legacy compositor fallback: {error}"
                    ),
                )
            })?;
        let view = view.ok_or_else(|| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!(
                    "D3D11 returned no NV12 plane {plane} render-target view; use legacy compositor fallback"
                ),
            )
        })?;
        view.cast::<ID3D11RenderTargetView>().map_err(|error| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("NV12 plane {plane} RTV cast failed: {error}"),
            )
        })
    }

    fn check_device_health(
        device: &WindowsD3d11Device,
        operation: &str,
    ) -> Result<(), WindowsD3d11CompositorError> {
        unsafe { device.raw_device().GetDeviceRemovedReason() }.map_err(|error| {
            WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::DeviceLost,
                format!(
                    "{operation} observed device removal/reset; retire generation before fallback: {error}"
                ),
            )
        })
    }

    fn gpu_error(
        device: &WindowsD3d11Device,
        operation: &str,
        error: windows::core::Error,
    ) -> WindowsD3d11CompositorError {
        match unsafe { device.raw_device().GetDeviceRemovedReason() } {
            Ok(()) => WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::GpuOperationFailed,
                format!("{operation} failed: {error}"),
            ),
            Err(removed) => WindowsD3d11CompositorError::new(
                WindowsD3d11CompositorErrorCode::DeviceLost,
                format!(
                    "{operation} failed after device removal/reset; retire generation before fallback: {error}; removal={removed}"
                ),
            ),
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
pub(crate) use runtime::WindowsD3d11ParityReadback;
#[cfg(target_os = "windows")]
pub(crate) use runtime::{
    WindowsD3d11BgraUpload, WindowsD3d11ComposedFrame, WindowsD3d11Compositor,
    WindowsD3d11EncodedTarget, WindowsD3d11GpuSource, WindowsD3d11GpuSourceContent,
    WindowsD3d11GpuTargets, WindowsD3d11UploadPixelOrder,
};

#[cfg(test)]
fn straight_alpha_blend_bgra_reference(
    background: [u8; 4],
    foreground: [u8; 4],
    layer_opacity: f32,
) -> [u8; 4] {
    let source_alpha = (foreground[3] as f32 / 255.0) * layer_opacity.clamp(0.0, 1.0);
    let destination_alpha = background[3] as f32 / 255.0;
    let blend_channel = |source: u8, destination: u8| {
        (source as f32 * source_alpha + destination as f32 * (1.0 - source_alpha))
            .round()
            .clamp(0.0, 255.0) as u8
    };
    [
        blend_channel(foreground[0], background[0]),
        blend_channel(foreground[1], background[1]),
        blend_channel(foreground[2], background[2]),
        ((source_alpha + destination_alpha * (1.0 - source_alpha)) * 255.0)
            .round()
            .clamp(0.0, 255.0) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dimensions(width: u32, height: u32) -> WindowsD3d11OutputDimensions {
        WindowsD3d11OutputDimensions::new(width, height).expect("valid test dimensions")
    }

    fn layer(
        source_id: u64,
        source_kind: WindowsD3d11SceneSourceKind,
        source_dimensions: WindowsD3d11OutputDimensions,
    ) -> WindowsD3d11SceneLayerInput {
        WindowsD3d11SceneLayerInput {
            source_id,
            source_kind,
            source_dimensions,
            transform: WindowsD3d11NormalizedTransform::full_canvas(),
            crop: WindowsD3d11Crop::none(),
            fit: WindowsD3d11SceneFit::Contain,
            mirror_x: false,
            mask: WindowsD3d11SceneMask::None,
            effects: WindowsD3d11LayerEffects::default(),
            z_index: 0,
            output_targets: WindowsD3d11SceneOutputTargets::default(),
        }
    }

    fn request(
        orientation: WindowsD3d11CanvasOrientation,
        canvas_dimensions: WindowsD3d11OutputDimensions,
        layers: Vec<WindowsD3d11SceneLayerInput>,
    ) -> WindowsD3d11ScenePlanRequest {
        WindowsD3d11ScenePlanRequest {
            adapter_luid: DxgiAdapterLuid::from_u64(0x0102_0304_0506_0708),
            generation: 7,
            sequence: 42,
            orientation,
            canvas_dimensions,
            layers,
            encoded_outputs: vec![],
        }
    }

    #[test]
    fn windows_d3d11_compositor_layout_plan_preserves_horizontal_and_vertical_geometry() {
        let horizontal = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![layer(
                1,
                WindowsD3d11SceneSourceKind::Display,
                dimensions(1280, 720),
            )],
        ))
        .expect("horizontal plan");
        assert_eq!(
            horizontal.layers[0].destination,
            WindowsD3d11PixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }
        );
        assert_eq!(horizontal.layers[0].source_uv, [0.0, 0.0, 1.0, 1.0]);

        let mut vertical_layer = layer(
            2,
            WindowsD3d11SceneSourceKind::Window,
            dimensions(1920, 1080),
        );
        vertical_layer.fit = WindowsD3d11SceneFit::Cover;
        let vertical = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Vertical,
            dimensions(1080, 1920),
            vec![vertical_layer],
        ))
        .expect("vertical plan");
        assert_eq!(
            vertical.layers[0].destination,
            WindowsD3d11PixelRect {
                x: 0,
                y: 0,
                width: 1080,
                height: 1920,
            }
        );
        assert!((vertical.layers[0].source_uv[0] - 0.341_796_88).abs() < 0.000_01);
        assert!((vertical.layers[0].source_uv[2] - 0.316_406_25).abs() < 0.000_01);
    }

    #[test]
    fn windows_d3d11_compositor_transforms_crop_mirror_and_masks_match_cpu_contract() {
        let mut camera = layer(
            5,
            WindowsD3d11SceneSourceKind::CameraUpload,
            dimensions(1000, 1000),
        );
        camera.transform = WindowsD3d11NormalizedTransform {
            x: 0.1,
            y: 0.2,
            width: 0.4,
            height: 0.6,
        };
        camera.crop = WindowsD3d11Crop {
            left: 0.1,
            top: 0.0,
            right: 0.1,
            bottom: 0.0,
        };
        camera.fit = WindowsD3d11SceneFit::Cover;
        camera.mirror_x = true;
        camera.mask = WindowsD3d11SceneMask::Rounded { radius_pct: 24 };
        let plan = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1000, 500),
            vec![camera],
        ))
        .expect("camera plan");
        let planned = &plan.layers[0];
        assert_eq!(
            planned.destination,
            WindowsD3d11PixelRect {
                x: 100,
                y: 100,
                width: 400,
                height: 300,
            }
        );
        assert_eq!(planned.destination_normalized, [0.1, 0.2, 0.4, 0.6]);
        for (actual, expected) in planned.source_uv.into_iter().zip([0.1, 0.2, 0.8, 0.6]) {
            assert!((actual - expected).abs() < 0.000_001);
        }
        assert!(planned.mirror_x);
        assert_eq!(
            planned.mask,
            WindowsD3d11SceneMask::Rounded { radius_pct: 24 }
        );
    }

    #[test]
    fn windows_d3d11_compositor_primary_and_auxiliary_outputs_validate_dimensions() {
        let mut valid = request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![],
        );
        valid.encoded_outputs = vec![
            WindowsD3d11EncodedOutputPlan {
                role: WindowsD3d11EncodedOutputRole::Primary,
                dimensions: dimensions(1920, 1080),
            },
            WindowsD3d11EncodedOutputPlan {
                role: WindowsD3d11EncodedOutputRole::Auxiliary,
                dimensions: dimensions(1280, 720),
            },
        ];
        let plan = build_windows_d3d11_scene_plan(valid).expect("two scaled outputs");
        assert_eq!(plan.encoded_outputs.len(), 2);

        let mut odd = request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![],
        );
        odd.encoded_outputs = vec![WindowsD3d11EncodedOutputPlan {
            role: WindowsD3d11EncodedOutputRole::Primary,
            dimensions: dimensions(1279, 720),
        }];
        assert_eq!(
            build_windows_d3d11_scene_plan(odd)
                .expect_err("odd NV12 dimensions")
                .code,
            WindowsD3d11CompositorErrorCode::InvalidScenePlan
        );

        let mut mixed_aspect = request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![],
        );
        mixed_aspect.encoded_outputs = vec![WindowsD3d11EncodedOutputPlan {
            role: WindowsD3d11EncodedOutputRole::Auxiliary,
            dimensions: dimensions(1080, 1920),
        }];
        assert_eq!(
            build_windows_d3d11_scene_plan(mixed_aspect)
                .expect_err("mixed aspect requires a named fallback")
                .code,
            WindowsD3d11CompositorErrorCode::UnsupportedSceneFeature
        );
    }

    #[test]
    fn windows_d3d11_compositor_filters_scene_layers_per_output_leg() {
        let base = layer(
            1,
            WindowsD3d11SceneSourceKind::Display,
            dimensions(1920, 1080),
        );
        let mut caption = layer(
            2,
            WindowsD3d11SceneSourceKind::CaptionOverlay,
            dimensions(800, 160),
        );
        caption.output_targets = WindowsD3d11SceneOutputTargets::PREVIEW
            .union(WindowsD3d11SceneOutputTargets::AUXILIARY);
        caption.z_index = 10;
        let mut comment = layer(
            3,
            WindowsD3d11SceneSourceKind::CommentHighlight,
            dimensions(960, 240),
        );
        comment.output_targets = WindowsD3d11SceneOutputTargets::AUXILIARY;
        comment.z_index = 20;

        let plan = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![base, caption, comment],
        ))
        .expect("target-selective scene plan");
        let source_ids = |target| {
            plan.layers
                .iter()
                .filter(|layer| layer.applies_to(target))
                .map(|layer| layer.source_id)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            source_ids(WindowsD3d11SceneOutputTarget::Preview),
            vec![1, 2]
        );
        assert_eq!(
            source_ids(WindowsD3d11SceneOutputTarget::Encoded(
                WindowsD3d11EncodedOutputRole::Primary
            )),
            vec![1]
        );
        assert_eq!(
            source_ids(WindowsD3d11SceneOutputTarget::Encoded(
                WindowsD3d11EncodedOutputRole::Auxiliary
            )),
            vec![1, 2, 3]
        );
        assert_eq!(
            plan.layers[0].output_targets,
            WindowsD3d11SceneOutputTargets::ALL,
            "the default remains all-target for existing scenes"
        );
    }

    #[test]
    fn windows_d3d11_compositor_rejects_layers_with_no_output_leg() {
        let mut orphan = layer(
            7,
            WindowsD3d11SceneSourceKind::CaptionOverlay,
            dimensions(800, 160),
        );
        orphan.output_targets = WindowsD3d11SceneOutputTargets(0);
        let error = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![orphan],
        ))
        .expect_err("empty target mask must fail before GPU work");
        assert_eq!(
            error.code,
            WindowsD3d11CompositorErrorCode::InvalidScenePlan
        );
        assert!(error.detail.contains("no output targets"));
    }

    #[test]
    fn windows_d3d11_compositor_overlay_alpha_uses_straight_alpha_contract() {
        // BGRA: a half-transparent warm overlay at 50% layer opacity has an
        // effective source alpha of roughly 25%.
        assert_eq!(
            straight_alpha_blend_bgra_reference([10, 20, 30, 255], [210, 120, 70, 128], 0.5),
            [60, 45, 40, 255]
        );
        assert_eq!(
            straight_alpha_blend_bgra_reference([1, 2, 3, 255], [9, 8, 7, 0], 1.0),
            [1, 2, 3, 255]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_d3d11_compositor_runtime_blend_state_matches_overlay_reference() {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE, D3D11_BLEND_SRC_ALPHA,
            D3D11_COLOR_WRITE_ENABLE_ALL,
        };

        let target = runtime::alpha_blend_desc().RenderTarget[0];
        assert!(bool::from(target.BlendEnable));
        assert_eq!(target.SrcBlend, D3D11_BLEND_SRC_ALPHA);
        assert_eq!(target.DestBlend, D3D11_BLEND_INV_SRC_ALPHA);
        assert_eq!(target.SrcBlendAlpha, D3D11_BLEND_ONE);
        assert_eq!(target.DestBlendAlpha, D3D11_BLEND_INV_SRC_ALPHA);
        assert_eq!(
            target.RenderTargetWriteMask,
            D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8
        );
    }

    #[test]
    fn windows_d3d11_compositor_bt709_video_range_matches_reference_fixtures() {
        assert_eq!(bt709_video_range_reference(0, 0, 0), (16, 128, 128));
        assert_eq!(bt709_video_range_reference(255, 255, 255), (235, 128, 128));
        assert_eq!(bt709_video_range_reference(255, 0, 0), (63, 102, 240));
        assert_eq!(bt709_video_range_reference(0, 255, 0), (173, 42, 26));
        assert_eq!(bt709_video_range_reference(0, 0, 255), (32, 240, 118));
        assert!(WINDOWS_D3D11_SHADER_SOURCE.contains("bt709VideoRange"));
        assert!(WINDOWS_D3D11_SHADER_SOURCE.contains("Nv12LumaPs"));
        assert!(WINDOWS_D3D11_SHADER_SOURCE.contains("Nv12ChromaPs"));
    }

    #[test]
    fn windows_d3d11_compositor_unsupported_scene_feature_falls_back_whole_frame() {
        let error = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![
                layer(
                    1,
                    WindowsD3d11SceneSourceKind::Display,
                    dimensions(1920, 1080),
                ),
                layer(
                    2,
                    WindowsD3d11SceneSourceKind::Unsupported(
                        WindowsD3d11UnsupportedFeature::BrowserSource,
                    ),
                    dimensions(800, 600),
                ),
            ],
        ))
        .expect_err("unsupported layer rejects the full frame");
        assert_eq!(
            error.code,
            WindowsD3d11CompositorErrorCode::UnsupportedSceneFeature
        );
        assert!(error.detail.contains("browser-source"));
        assert!(error.detail.contains("whole frame"));
    }

    #[test]
    fn windows_d3d11_compositor_rejects_adapter_and_generation_mismatch() {
        let plan = build_windows_d3d11_scene_plan(request(
            WindowsD3d11CanvasOrientation::Horizontal,
            dimensions(1920, 1080),
            vec![],
        ))
        .expect("plan");
        assert_eq!(
            validate_windows_d3d11_compositor_authority(
                &plan,
                DxgiAdapterLuid::from_u64(99),
                plan.generation,
            )
            .expect_err("adapter mismatch")
            .code,
            WindowsD3d11CompositorErrorCode::AdapterMismatch
        );
        assert_eq!(
            validate_windows_d3d11_compositor_authority(
                &plan,
                plan.adapter_luid,
                plan.generation + 1,
            )
            .expect_err("generation mismatch")
            .code,
            WindowsD3d11CompositorErrorCode::StaleGeneration
        );
    }

    #[test]
    fn windows_d3d11_compositor_test_readback_is_separately_attributed() {
        let mut diagnostics = WindowsD3d11CompositorDiagnostics::default();
        let first = diagnostics.attribute_test_readback(&[1, 2, 3, 4]);
        let second = diagnostics.attribute_test_readback(&[1, 2, 3, 4]);
        assert_eq!(first, second);
        assert_eq!(diagnostics.parity_test_readback_frames, 2);
        assert_eq!(diagnostics.parity_test_readback_bytes, 8);
        assert_eq!(diagnostics.production_readback_frames, 0);
    }
}
