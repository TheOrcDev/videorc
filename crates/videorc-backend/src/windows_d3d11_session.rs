use std::collections::BTreeSet;

use crate::windows_d3d11_device::{WindowsD3d11MediaRole, WindowsDxgiOutputSelection};

pub(crate) const WINDOWS_D3D11_MEDIA_ENV: &str = "VIDEORC_WINDOWS_D3D11_MEDIA";
pub(crate) const WINDOWS_REQUIRE_D3D11_MEDIA_ENV: &str = "VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11MediaMode {
    Disabled,
    Automatic,
    Required,
}

impl WindowsD3d11MediaMode {
    pub(crate) fn from_process_env() -> Result<Self, String> {
        Self::from_env_values(
            std::env::var(WINDOWS_D3D11_MEDIA_ENV).ok().as_deref(),
            std::env::var(WINDOWS_REQUIRE_D3D11_MEDIA_ENV)
                .ok()
                .as_deref(),
        )
    }

    pub(crate) fn from_env_values(
        media: Option<&str>,
        require: Option<&str>,
    ) -> Result<Self, String> {
        let media = match media.map(str::trim) {
            None | Some("") | Some("1") | Some("true") | Some("on") | Some("auto")
            | Some("automatic") => Self::Automatic,
            Some("0") | Some("false") | Some("off") | Some("disabled") => Self::Disabled,
            Some("required") | Some("require") => Self::Required,
            Some(value) => {
                return Err(format!(
                    "{WINDOWS_D3D11_MEDIA_ENV} has unsupported value {value:?}; use auto, required, or disabled"
                ));
            }
        };
        let require = match require.map(str::trim) {
            None | Some("") | Some("0") | Some("false") | Some("off") => false,
            Some("1") | Some("true") | Some("on") | Some("required") => true,
            Some(value) => {
                return Err(format!(
                    "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV} has unsupported value {value:?}; use 1 or 0"
                ));
            }
        };
        if require && media == Self::Disabled {
            return Err(format!(
                "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 conflicts with {WINDOWS_D3D11_MEDIA_ENV}=disabled"
            ));
        }
        Ok(if require { Self::Required } else { media })
    }

    pub(crate) const fn is_required(self) -> bool {
        matches!(self, Self::Required)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11VideoPlan {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fps: u32,
    pub(crate) bitrate_kbps: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SessionRequest {
    pub(crate) platform_supported: bool,
    pub(crate) screen_id: Option<String>,
    pub(crate) window_selected: bool,
    pub(crate) screen_available: bool,
    pub(crate) source_width: Option<u32>,
    pub(crate) source_height: Option<u32>,
    pub(crate) supported_layout: bool,
    pub(crate) camera_required: bool,
    pub(crate) camera_source_available: bool,
    pub(crate) explicit_scene: bool,
    /// Shipping scene semantics that do not yet have a D3D11 layer/input
    /// mapping. Keeping this explicit makes each future bounded `BgraUpload`
    /// source a selector capability change rather than a silent omission.
    pub(crate) unsupported_scene_features: Vec<String>,
    pub(crate) media_foundation_selected: bool,
    pub(crate) record_enabled: bool,
    pub(crate) stream_enabled: bool,
    pub(crate) primary: WindowsD3d11VideoPlan,
    pub(crate) auxiliary: Option<WindowsD3d11VideoPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11NaturalFallback {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

impl std::fmt::Display for WindowsD3d11NaturalFallback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SessionPlan {
    pub(crate) screen_id: String,
    pub(crate) source_width: u32,
    pub(crate) source_height: u32,
    pub(crate) primary: WindowsD3d11VideoPlan,
    pub(crate) auxiliary: Option<WindowsD3d11VideoPlan>,
    pub(crate) camera_required: bool,
    pub(crate) primary_role: WindowsD3d11MediaRole,
    pub(crate) roles: BTreeSet<WindowsD3d11MediaRole>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WindowsD3d11SessionSelection {
    Disabled,
    Candidate(WindowsD3d11SessionPlan),
    NaturalFallback(WindowsD3d11NaturalFallback),
}

fn fallback_or_required(
    mode: WindowsD3d11MediaMode,
    code: &'static str,
    detail: impl Into<String>,
) -> Result<WindowsD3d11SessionSelection, String> {
    let fallback = WindowsD3d11NaturalFallback {
        code,
        detail: detail.into(),
    };
    if mode.is_required() {
        Err(format!(
            "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 rejected session startup: {fallback}"
        ))
    } else {
        Ok(WindowsD3d11SessionSelection::NaturalFallback(fallback))
    }
}

pub(crate) fn select_windows_d3d11_session(
    mode: WindowsD3d11MediaMode,
    request: WindowsD3d11SessionRequest,
) -> Result<WindowsD3d11SessionSelection, String> {
    if mode == WindowsD3d11MediaMode::Disabled {
        return Ok(WindowsD3d11SessionSelection::Disabled);
    }
    if !request.platform_supported {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-platform-unsupported",
            "the unified D3D11 media authority is available only on Windows",
        );
    }
    if !request.media_foundation_selected {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-foundation-not-selected",
            "the effective encoder is not the Media Foundation H.264 bridge",
        );
    }
    if request.window_selected {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-window-capture-unsupported",
            "the first production D3D11 session supports DXGI monitor capture only",
        );
    }
    if !request.supported_layout {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-layout-unsupported",
            "the selected layout needs sources that are not yet mapped into the D3D11 scene plan",
        );
    }
    if request.explicit_scene {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-explicit-scene-unsupported",
            "explicit scene layers are not yet mapped into the D3D11 scene plan",
        );
    }
    if !request.unsupported_scene_features.is_empty() {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-scene-features-unsupported",
            format!(
                "the D3D11 scene input map does not yet support: {}",
                request.unsupported_scene_features.join(", ")
            ),
        );
    }
    if request.camera_required && !request.camera_source_available {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-camera-source-unavailable",
            "the screen-camera layout requires a live camera frame source for its measured GPU upload",
        );
    }
    if !request.record_enabled && !request.stream_enabled {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-no-output",
            "the session has neither a recording nor a livestream output",
        );
    }
    let Some(screen_id) = request.screen_id else {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-missing",
            "no DXGI monitor was selected",
        );
    };
    if let Err(error) = WindowsDxgiOutputSelection::parse(&screen_id) {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-id-invalid",
            error.to_string(),
        );
    }
    if !request.screen_available {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-unavailable",
            format!("selected monitor {screen_id} is not currently available"),
        );
    }
    let (Some(source_width), Some(source_height)) = (request.source_width, request.source_height)
    else {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-dimensions-missing",
            format!("selected monitor {screen_id} did not report native dimensions"),
        );
    };
    if source_width == 0 || source_height == 0 {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-screen-dimensions-invalid",
            format!("selected monitor {screen_id} reported {source_width}x{source_height}"),
        );
    }
    if !request.primary.width.is_multiple_of(2)
        || !request.primary.height.is_multiple_of(2)
        || request.primary.fps == 0
    {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-primary-profile-invalid",
            "the primary NV12 output requires even, non-zero dimensions and a non-zero frame rate",
        );
    }
    if let Some(auxiliary) = request.auxiliary
        && (!auxiliary.width.is_multiple_of(2)
            || !auxiliary.height.is_multiple_of(2)
            || auxiliary.fps == 0)
    {
        return fallback_or_required(
            mode,
            "windows-d3d11-media-auxiliary-profile-invalid",
            "the auxiliary NV12 output requires even, non-zero dimensions and a non-zero frame rate",
        );
    }

    let primary_role = if request.auxiliary.is_some() || !request.stream_enabled {
        WindowsD3d11MediaRole::Record
    } else {
        WindowsD3d11MediaRole::Stream
    };
    let mut roles = BTreeSet::from([
        WindowsD3d11MediaRole::Compositor,
        WindowsD3d11MediaRole::Preview,
        primary_role,
    ]);
    if request.auxiliary.is_some() {
        roles.insert(WindowsD3d11MediaRole::Stream);
    }
    Ok(WindowsD3d11SessionSelection::Candidate(
        WindowsD3d11SessionPlan {
            screen_id,
            source_width,
            source_height,
            primary: request.primary,
            auxiliary: request.auxiliary,
            camera_required: request.camera_required,
            primary_role,
            roles,
        },
    ))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11StartupEvidence {
    pub(crate) capture_started: bool,
    pub(crate) preview_ticket: bool,
    pub(crate) primary_ticket: bool,
    pub(crate) auxiliary_ticket: bool,
    pub(crate) primary_encoder_attached: bool,
    pub(crate) auxiliary_encoder_attached: bool,
}

pub(crate) fn validate_windows_d3d11_startup_evidence(
    mode: WindowsD3d11MediaMode,
    plan: &WindowsD3d11SessionPlan,
    evidence: WindowsD3d11StartupEvidence,
) -> Result<Option<WindowsD3d11NaturalFallback>, String> {
    let missing = if !evidence.capture_started {
        Some((
            "windows-d3d11-media-capture-not-started",
            "capture did not start on the D3D11 media authority",
        ))
    } else if !evidence.preview_ticket {
        Some((
            "windows-d3d11-media-preview-ticket-missing",
            "the compositor did not publish a role-bound BGRA preview ticket",
        ))
    } else if !evidence.primary_ticket {
        Some((
            "windows-d3d11-media-primary-ticket-missing",
            "the compositor did not publish a role-bound primary NV12 ticket",
        ))
    } else if plan.auxiliary.is_some() && !evidence.auxiliary_ticket {
        Some((
            "windows-d3d11-media-auxiliary-ticket-missing",
            "the compositor did not publish a role-bound auxiliary NV12 ticket",
        ))
    } else if !evidence.primary_encoder_attached {
        Some((
            "windows-d3d11-media-primary-encoder-unattached",
            "the primary NV12 ticket was not attached to its Media Foundation surface encoder",
        ))
    } else if plan.auxiliary.is_some() && !evidence.auxiliary_encoder_attached {
        Some((
            "windows-d3d11-media-auxiliary-encoder-unattached",
            "the auxiliary NV12 ticket was not attached to its Media Foundation surface encoder",
        ))
    } else {
        None
    };
    let Some((code, detail)) = missing else {
        return Ok(None);
    };
    let fallback = WindowsD3d11NaturalFallback {
        code,
        detail: detail.to_string(),
    };
    if mode.is_required() {
        Err(format!(
            "{WINDOWS_REQUIRE_D3D11_MEDIA_ENV}=1 rejected session startup: {fallback}"
        ))
    } else {
        Ok(Some(fallback))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsD3d11CfrTick {
    output_sequence: u64,
    source_sequence: u64,
    repeated_source: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct WindowsD3d11CfrSequencer {
    output_sequence: u64,
    source_sequence: Option<u64>,
}

impl WindowsD3d11CfrSequencer {
    fn advance(
        &mut self,
        new_source_sequence: Option<u64>,
    ) -> Result<Option<WindowsD3d11CfrTick>, String> {
        let repeated_source = new_source_sequence.is_none();
        if let Some(sequence) = new_source_sequence {
            if sequence == 0
                || self
                    .source_sequence
                    .is_some_and(|previous| sequence <= previous)
            {
                return Err(format!(
                    "D3D11 capture sequence {sequence} did not advance beyond {:?}",
                    self.source_sequence
                ));
            }
            self.source_sequence = Some(sequence);
        }
        let Some(source_sequence) = self.source_sequence else {
            return Ok(None);
        };
        self.output_sequence = self
            .output_sequence
            .checked_add(1)
            .ok_or_else(|| "D3D11 CFR output sequence was exhausted".to_string())?;
        Ok(Some(WindowsD3d11CfrTick {
            output_sequence: self.output_sequence,
            source_sequence,
            repeated_source,
        }))
    }
}

#[cfg(target_os = "windows")]
mod runtime {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use crate::captions::{
        CaptionOverlay, CaptionOverlaySlot, CaptionOverlaySlots, current_caption_overlay,
        current_caption_overlays,
    };
    use crate::compositor::{
        CompositorFrameExportHandle, CompositorFrameStore, CompositorPixelFormat,
        caption_overlay_layout_with_inset, caption_overlay_safe_inset,
    };
    use crate::frame_store::FrameStore;
    use crate::preview_camera::{PreviewCameraFrameSource, PreviewCameraPixelFormat};
    use crate::protocol::{LayoutSettings, SceneSourceKind};
    use crate::scene_geometry::{
        CHROMA_KEY_SATURATION_FLOOR, SceneFit, SceneMask, camera_chroma_key, camera_mask,
        resolved_camera_transform, scene_crop_from_transform, scene_source_fit,
    };
    use crate::state::{
        WindowsD3d11MediaCoordinatorSlot, WindowsD3d11MediaRoleHandle, acquire_windows_d3d11_media,
    };
    use crate::windows_d3d11_capture::{
        WindowsD3d11CapturePlan, WindowsD3d11WgcCursorExclusionProbe,
    };
    use crate::windows_d3d11_compositor::{
        WindowsD3d11CanvasOrientation, WindowsD3d11ChromaKey, WindowsD3d11Crop,
        WindowsD3d11EncodedOutputPlan, WindowsD3d11EncodedOutputRole, WindowsD3d11LayerEffects,
        WindowsD3d11NormalizedTransform, WindowsD3d11OutputDimensions, WindowsD3d11SceneFit,
        WindowsD3d11SceneLayerInput, WindowsD3d11SceneMask, WindowsD3d11SceneOutputTargets,
        WindowsD3d11ScenePlanRequest, WindowsD3d11SceneSourceKind, WindowsD3d11UploadPixelOrder,
        build_windows_d3d11_scene_plan,
    };
    use crate::windows_d3d11_device::{
        WindowsD3d11BgraTextureDescriptor, WindowsD3d11ComposedTextureKind,
        WindowsD3d11CompositionConsumers, WindowsD3d11CompositionSource, WindowsD3d11Error,
        WindowsD3d11ErrorCode, WindowsD3d11MediaClient, WindowsD3d11MediaRole,
        WindowsD3d11Nv12TextureDescriptor, WindowsD3d11TextureFormat,
        WindowsD3d11TextureLeaseTicket, WindowsD3d11TexturePoolConfig, WindowsD3d11TicketedTexture,
        WindowsDxgiOutputSelection,
    };
    use crate::windows_media_foundation_encoder::MediaFoundationEncoderConfig;

    use super::{WindowsD3d11CfrSequencer, WindowsD3d11SessionPlan, WindowsD3d11StartupEvidence};

    const STARTUP_TIMEOUT: Duration = Duration::from_secs(4);
    const CAPTURE_WAIT_MS: u32 = 16;
    const CAPTURE_SOURCE_ID: u64 = 1;
    const CAMERA_SOURCE_ID: u64 = 2;
    const CAPTION_PRIMARY_SOURCE_ID: u64 = 10;
    const CAPTION_AUXILIARY_SOURCE_ID: u64 = 11;
    const HIGHLIGHT_PRIMARY_SOURCE_ID: u64 = 12;
    const HIGHLIGHT_AUXILIARY_SOURCE_ID: u64 = 13;

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11CameraInput {
        pub(crate) source: PreviewCameraFrameSource,
        pub(crate) layout: LayoutSettings,
    }

    #[derive(Clone)]
    pub(crate) struct WindowsD3d11OverlayInput {
        pub(crate) captions: CaptionOverlaySlots,
        pub(crate) highlight: CaptionOverlaySlot,
        pub(crate) caption_on_primary: bool,
        pub(crate) caption_on_auxiliary: bool,
        pub(crate) highlight_on_primary: bool,
        pub(crate) highlight_on_auxiliary: bool,
    }

    #[derive(Clone)]
    struct WindowsD3d11OverlayFrame {
        source_id: u64,
        source_kind: WindowsD3d11SceneSourceKind,
        overlay: CaptionOverlay,
        output_targets: WindowsD3d11SceneOutputTargets,
        output_dimensions: WindowsD3d11OutputDimensions,
        safe_inset: usize,
        z_index: i32,
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11SessionPumpSnapshot {
        pub(crate) generation: u64,
        pub(crate) authority_adapter_luid: u64,
        pub(crate) capture_adapter_luid: u64,
        pub(crate) compositor_adapter_luid: u64,
        pub(crate) primary_encoder_adapter_luid: u64,
        pub(crate) auxiliary_encoder_adapter_luid: Option<u64>,
        pub(crate) adapter_mismatches: u64,
        pub(crate) captured_frames: u64,
        pub(crate) composed_frames: u64,
        pub(crate) latest_capture_sequence: Option<u64>,
        pub(crate) repeated_capture_frames: u64,
        pub(crate) pressure_skips: u64,
        pub(crate) preview_sequence: Option<u64>,
        pub(crate) primary_sequence: Option<u64>,
        pub(crate) auxiliary_sequence: Option<u64>,
        pub(crate) terminal_error: Option<String>,
        pub(crate) stopped: bool,
    }

    pub(crate) struct WindowsD3d11SessionPump {
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
        client: WindowsD3d11MediaClient,
        preview_store: CompositorFrameStore,
        primary_store: CompositorFrameStore,
        auxiliary_store: Option<CompositorFrameStore>,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        roles: Vec<WindowsD3d11MediaRoleHandle>,
        primary_role: WindowsD3d11MediaRole,
        startup_evidence: WindowsD3d11StartupEvidence,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11EncoderTicketSource {
        pub(crate) client: WindowsD3d11MediaClient,
        pub(crate) frame_store: CompositorFrameStore,
        pub(crate) role: WindowsD3d11MediaRole,
    }

    #[derive(Clone)]
    pub(crate) struct WindowsD3d11SessionMonitor {
        client: WindowsD3d11MediaClient,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        preview_generation: Arc<AtomicU64>,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11SessionDiagnosticsSnapshot {
        pub(crate) pump: WindowsD3d11SessionPumpSnapshot,
        pub(crate) device: crate::windows_d3d11_device::WindowsD3d11DeviceStatus,
        pub(crate) presenter: Option<WindowsD3d11PresenterStatus>,
    }

    impl WindowsD3d11SessionMonitor {
        pub(crate) fn configure_preview(
            &self,
            placement: WindowsD3d11PreviewPlacement,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            let preview_generation = placement.preview_generation;
            let status = self.client.configure_preview(placement).map_err(|error| {
                attribute_adapter_mismatch(&self.snapshot, &error);
                error
            })?;
            self.preview_generation
                .store(preview_generation, Ordering::Release);
            Ok(status)
        }

        pub(crate) fn preview_status(
            &self,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            self.client.preview_status()
        }

        pub(crate) fn destroy_preview(&self) -> Result<bool, WindowsD3d11Error> {
            let destroyed = self.client.destroy_preview()?;
            self.preview_generation.store(0, Ordering::Release);
            Ok(destroyed)
        }

        pub(crate) fn diagnostics_snapshot(
            &self,
        ) -> Result<WindowsD3d11SessionDiagnosticsSnapshot, WindowsD3d11Error> {
            let device = self.client.status()?;
            let presenter = self.client.preview_status().ok();
            Ok(WindowsD3d11SessionDiagnosticsSnapshot {
                pump: self
                    .snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                device,
                presenter,
            })
        }
    }

    impl WindowsD3d11EncoderTicketSource {
        pub(crate) fn latest_ticket(
            &self,
        ) -> Option<(u64, Instant, WindowsD3d11TextureLeaseTicket)> {
            let frame = self
                .frame_store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .latest()?;
            if !matches!(frame.pixel_format, CompositorPixelFormat::D3d11Nv12 { .. }) {
                return None;
            }
            let ticket = frame.metadata.d3d11_texture_for_role(self.role)?;
            Some((frame.sequence, frame.captured_at, ticket))
        }
    }

    impl std::fmt::Debug for WindowsD3d11SessionPump {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("WindowsD3d11SessionPump")
                .field("snapshot", &self.snapshot())
                .field("roles", &self.roles.len())
                .finish_non_exhaustive()
        }
    }

    impl WindowsD3d11SessionPump {
        pub(crate) fn start(
            coordinator: &WindowsD3d11MediaCoordinatorSlot,
            plan: WindowsD3d11SessionPlan,
            camera: Option<WindowsD3d11CameraInput>,
        ) -> Result<Self, String> {
            if plan.camera_required != camera.is_some() {
                return Err(format!(
                    "D3D11 screen-camera plan/source mismatch: plan requires camera={}, source supplied={}",
                    plan.camera_required,
                    camera.is_some()
                ));
            }
            if plan.auxiliary.is_none()
                && (overlays.caption_on_auxiliary || overlays.highlight_on_auxiliary)
            {
                return Err(
                    "D3D11 overlay plan targets an auxiliary leg that this session did not create"
                        .to_string(),
                );
            }
            let pool = WindowsD3d11TexturePoolConfig::dimension_keyed(
                WindowsD3d11BgraTextureDescriptor::new(plan.source_width, plan.source_height)
                    .map_err(|error| error.to_string())?,
                3,
                WindowsD3d11BgraTextureDescriptor::new(plan.primary.width, plan.primary.height)
                    .map_err(|error| error.to_string())?,
                3,
                WindowsD3d11Nv12TextureDescriptor::new(plan.primary.width, plan.primary.height)
                    .map_err(|error| error.to_string())?,
                3,
                plan.auxiliary
                    .map(|auxiliary| {
                        Ok((
                            WindowsD3d11Nv12TextureDescriptor::new(
                                auxiliary.width,
                                auxiliary.height,
                            )?,
                            3,
                        ))
                    })
                    .transpose()
                    .map_err(|error: WindowsD3d11Error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let mut roles = Vec::with_capacity(plan.roles.len());
            for role in &plan.roles {
                roles.push(
                    acquire_windows_d3d11_media(coordinator, &plan.screen_id, *role, pool)
                        .map_err(|error| {
                            format!("could not acquire D3D11 {role:?} authority: {error}")
                        })?,
                );
            }
            let client = roles
                .first()
                .ok_or_else(|| "D3D11 session plan acquired no roles".to_string())?
                .client();
            let status = client.status().map_err(|error| error.to_string())?;
            let selection = WindowsDxgiOutputSelection::parse(&plan.screen_id)
                .map_err(|error| error.to_string())?;
            if status.generation == 0
                || status.adapter_luid != selection.adapter_luid
                || status.output_index != selection.output_index
                || !status.compositor_ready
            {
                return Err(format!(
                    "D3D11 media authority status did not confirm compositor/output ownership for {}",
                    plan.screen_id
                ));
            }
            let capture_plan = WindowsD3d11CapturePlan::resolve(
                &plan.screen_id,
                true,
                status.adapter_luid,
                status.generation,
                WindowsD3d11WgcCursorExclusionProbe::default(),
            )
            .map_err(|error| error.to_string())?;
            let capture_session = client
                .start_capture(capture_plan)
                .map_err(|error| format!("could not start D3D11 capture: {error}"))?;
            let authority_adapter_luid = status.adapter_luid.as_u64();
            let capture_adapter_luid = capture_session.diagnostics.adapter_luid;
            if capture_adapter_luid != authority_adapter_luid {
                let _ = client.stop_capture();
                return Err(format!(
                    "D3D11 capture adapter {capture_adapter_luid:016x} does not match authority adapter {authority_adapter_luid:016x}"
                ));
            }
            let primary_encoder = client
                .create_encoder(plan.primary_role, encoder_config(plan.primary), 2)
                .map_err(|error| {
                    format!(
                        "could not attach the {:?} Media Foundation surface encoder: {error}",
                        plan.primary_role
                    )
                })?;
            if primary_encoder.role != plan.primary_role
                || !primary_encoder.diagnostics.d3d11_aware
                || !primary_encoder.diagnostics.dxgi_manager_bound
                || primary_encoder.diagnostics.adapter_luid != authority_adapter_luid
            {
                let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                let _ = client.stop_capture();
                return Err(format!(
                    "Media Foundation {:?} encoder did not confirm the D3D11/DXGI authority",
                    plan.primary_role
                ));
            }
            let primary_encoder_adapter_luid = primary_encoder.diagnostics.adapter_luid;
            let mut auxiliary_encoder_adapter_luid = None;
            if let Some(auxiliary) = plan.auxiliary {
                match client.create_encoder(
                    WindowsD3d11MediaRole::Stream,
                    encoder_config(auxiliary),
                    2,
                ) {
                    Ok(status)
                        if status.role == WindowsD3d11MediaRole::Stream
                            && status.diagnostics.d3d11_aware
                            && status.diagnostics.dxgi_manager_bound
                            && status.diagnostics.adapter_luid == authority_adapter_luid =>
                    {
                        auxiliary_encoder_adapter_luid = Some(status.diagnostics.adapter_luid);
                    }
                    Ok(_) => {
                        let _ = client.shutdown_encoder(WindowsD3d11MediaRole::Stream, 2_000);
                        let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                        let _ = client.stop_capture();
                        return Err(
                            "Media Foundation stream encoder did not confirm the D3D11/DXGI authority"
                                .to_string(),
                        );
                    }
                    Err(error) => {
                        let _ = client.shutdown_encoder(plan.primary_role, 2_000);
                        let _ = client.stop_capture();
                        return Err(format!(
                            "could not attach the Stream Media Foundation surface encoder: {error}"
                        ));
                    }
                }
            }

            let stop = Arc::new(AtomicBool::new(false));
            let preview_store = new_frame_store();
            let primary_store = new_frame_store();
            let auxiliary_store = plan.auxiliary.map(|_| new_frame_store());
            let snapshot = Arc::new(StdMutex::new(WindowsD3d11SessionPumpSnapshot {
                generation: status.generation,
                authority_adapter_luid,
                capture_adapter_luid,
                compositor_adapter_luid: selection.adapter_luid.as_u64(),
                primary_encoder_adapter_luid,
                auxiliary_encoder_adapter_luid,
                ..Default::default()
            }));
            let (startup_tx, startup_rx) = mpsc::sync_channel(1);
            let worker = {
                let stop = Arc::clone(&stop);
                let preview_store = Arc::clone(&preview_store);
                let primary_store = Arc::clone(&primary_store);
                let auxiliary_store = auxiliary_store.clone();
                let snapshot = Arc::clone(&snapshot);
                let worker_plan = plan.clone();
                thread::Builder::new()
                    .name("videorc-windows-d3d11-session".to_string())
                    .spawn(move || {
                        run_pump(
                            client,
                            worker_plan,
                            stop,
                            preview_store,
                            primary_store,
                            auxiliary_store,
                            snapshot,
                            startup_tx,
                            camera,
                        );
                    })
                    .map_err(|error| {
                        format!("could not start D3D11 session pump thread: {error}")
                    })?
            };
            match startup_rx.recv_timeout(STARTUP_TIMEOUT) {
                Ok(Ok(evidence)) => Ok(Self {
                    stop,
                    worker: Some(worker),
                    client: roles
                        .first()
                        .expect("D3D11 roles were validated before worker startup")
                        .client(),
                    preview_store,
                    primary_store,
                    auxiliary_store,
                    snapshot,
                    roles,
                    primary_role: plan.primary_role,
                    startup_evidence: evidence,
                }),
                Ok(Err(error)) => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = worker.join();
                    Err(error)
                }
                Err(_) => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = worker.join();
                    Err(format!(
                        "D3D11 session did not publish its first preview/encoder surfaces within {}ms",
                        STARTUP_TIMEOUT.as_millis()
                    ))
                }
            }
        }

        pub(crate) fn preview_store(&self) -> CompositorFrameStore {
            Arc::clone(&self.preview_store)
        }

        pub(crate) fn primary_store(&self) -> CompositorFrameStore {
            Arc::clone(&self.primary_store)
        }

        pub(crate) fn auxiliary_store(&self) -> Option<CompositorFrameStore> {
            self.auxiliary_store.clone()
        }

        pub(crate) fn primary_encoder_source(&self) -> WindowsD3d11EncoderTicketSource {
            WindowsD3d11EncoderTicketSource {
                client: self.client.clone(),
                frame_store: self.primary_store(),
                role: self.primary_role,
            }
        }

        pub(crate) fn auxiliary_encoder_source(&self) -> Option<WindowsD3d11EncoderTicketSource> {
            Some(WindowsD3d11EncoderTicketSource {
                client: self.client.clone(),
                frame_store: self.auxiliary_store()?,
                role: WindowsD3d11MediaRole::Stream,
            })
        }

        pub(crate) const fn startup_evidence(&self) -> WindowsD3d11StartupEvidence {
            self.startup_evidence
        }

        pub(crate) fn monitor(&self) -> WindowsD3d11SessionMonitor {
            WindowsD3d11SessionMonitor {
                client: self.client.clone(),
                snapshot: Arc::clone(&self.snapshot),
                preview_generation: Arc::clone(&self.preview_generation),
            }
        }

        pub(crate) fn snapshot(&self) -> WindowsD3d11SessionPumpSnapshot {
            self.snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        pub(crate) fn stop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            let roles = self
                .roles
                .iter()
                .map(WindowsD3d11MediaRoleHandle::role)
                .collect::<BTreeSet<_>>();
            if roles.contains(&WindowsD3d11MediaRole::Stream) {
                let _ = self
                    .client
                    .shutdown_encoder(WindowsD3d11MediaRole::Stream, 2_000);
            }
            if roles.contains(&WindowsD3d11MediaRole::Record) {
                let _ = self
                    .client
                    .shutdown_encoder(WindowsD3d11MediaRole::Record, 2_000);
            }
        }
    }

    impl Drop for WindowsD3d11SessionPump {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn new_frame_store() -> CompositorFrameStore {
        Arc::new(StdMutex::new(FrameStore::new(0)))
    }

    fn encoder_config(plan: super::WindowsD3d11VideoPlan) -> MediaFoundationEncoderConfig {
        MediaFoundationEncoderConfig {
            width: plan.width,
            height: plan.height,
            fps: plan.fps,
            bitrate_kbps: plan.bitrate_kbps,
            low_latency: true,
        }
    }

    fn latest_camera_frame(
        camera: Option<&WindowsD3d11CameraInput>,
        last_frame: &mut Option<FrameHandle<PreviewCameraPixelFormat>>,
    ) -> Option<FrameHandle<PreviewCameraPixelFormat>> {
        let camera = camera?;
        let latest = match camera.source.try_latest_frame_result() {
            Ok(Some((frame, _))) => Some(frame),
            Ok(None) | Err(()) => None,
        }
        .or_else(|| {
            last_frame
                .is_none()
                .then(|| camera.source.latest_frame_blocking())
                .flatten()
                .map(|(frame, _)| frame)
        });
        if let Some(frame) = latest {
            *last_frame = Some(frame);
        }
        last_frame.clone()
    }

    fn current_overlay_frames(
        plan: &WindowsD3d11SessionPlan,
        input: &WindowsD3d11OverlayInput,
    ) -> Result<Vec<WindowsD3d11OverlayFrame>, String> {
        let captions = current_caption_overlays(&input.captions);
        let highlight = current_caption_overlay(&input.highlight);
        let primary_dimensions =
            WindowsD3d11OutputDimensions::new(plan.primary.width, plan.primary.height)
                .map_err(|error| error.to_string())?;
        let auxiliary_dimensions = plan
            .auxiliary
            .map(|video| WindowsD3d11OutputDimensions::new(video.width, video.height))
            .transpose()
            .map_err(|error| error.to_string())?;
        let primary_targets = if plan.auxiliary.is_none() {
            WindowsD3d11SceneOutputTargets::PRIMARY.union(WindowsD3d11SceneOutputTargets::PREVIEW)
        } else {
            WindowsD3d11SceneOutputTargets::PRIMARY
        };
        let auxiliary_targets = WindowsD3d11SceneOutputTargets::AUXILIARY
            .union(WindowsD3d11SceneOutputTargets::PREVIEW);
        let mut frames = Vec::with_capacity(4);

        if input.caption_on_primary
            && let Some(caption) = captions.primary
        {
            let safe_inset = caption_overlay_safe_inset(
                Some(&caption),
                input
                    .highlight_on_primary
                    .then_some(highlight.as_ref())
                    .flatten(),
                primary_dimensions.height,
            );
            frames.push(WindowsD3d11OverlayFrame {
                source_id: CAPTION_PRIMARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CaptionOverlay,
                overlay: caption,
                output_targets: primary_targets,
                output_dimensions: primary_dimensions,
                safe_inset,
                z_index: 10,
            });
        }
        if input.caption_on_auxiliary
            && let (Some(caption), Some(output_dimensions)) =
                (captions.auxiliary, auxiliary_dimensions)
        {
            let safe_inset = caption_overlay_safe_inset(
                Some(&caption),
                input
                    .highlight_on_auxiliary
                    .then_some(highlight.as_ref())
                    .flatten(),
                output_dimensions.height,
            );
            frames.push(WindowsD3d11OverlayFrame {
                source_id: CAPTION_AUXILIARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CaptionOverlay,
                overlay: caption,
                output_targets: auxiliary_targets,
                output_dimensions,
                safe_inset,
                z_index: 10,
            });
        }
        if input.highlight_on_primary
            && let Some(overlay) = highlight.clone()
        {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: HIGHLIGHT_PRIMARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CommentHighlight,
                overlay,
                output_targets: primary_targets,
                output_dimensions: primary_dimensions,
                safe_inset: 0,
                z_index: 11,
            });
        }
        if input.highlight_on_auxiliary
            && let (Some(overlay), Some(output_dimensions)) = (highlight, auxiliary_dimensions)
        {
            frames.push(WindowsD3d11OverlayFrame {
                source_id: HIGHLIGHT_AUXILIARY_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CommentHighlight,
                overlay,
                output_targets: auxiliary_targets,
                output_dimensions,
                safe_inset: 0,
                z_index: 11,
            });
        }
        Ok(frames)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_pump(
        client: WindowsD3d11MediaClient,
        plan: WindowsD3d11SessionPlan,
        stop: Arc<AtomicBool>,
        preview_store: CompositorFrameStore,
        primary_store: CompositorFrameStore,
        auxiliary_store: Option<CompositorFrameStore>,
        snapshot: Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        startup_tx: mpsc::SyncSender<Result<WindowsD3d11StartupEvidence, String>>,
        _camera: Option<WindowsD3d11CameraInput>,
    ) {
        let mut startup_tx = Some(startup_tx);
        let frame_interval = Duration::from_secs_f64(1.0 / f64::from(plan.primary.fps.max(1)));
        while !stop.load(Ordering::Relaxed) {
            let frame_started_at = Instant::now();
            let capture = match client
                .acquire_capture(CAPTURE_WAIT_MS, vec![WindowsD3d11MediaRole::Compositor])
            {
                Ok(Some(capture)) => capture,
                Ok(None) => continue,
                Err(error) if is_transient_pressure(&error) => {
                    update_snapshot(&snapshot, |current| {
                        current.pressure_skips = current.pressure_skips.saturating_add(1);
                    });
                    continue;
                }
                Err(error) => {
                    finish_with_error(
                        &snapshot,
                        &mut startup_tx,
                        format!("D3D11 capture stopped: {error}"),
                    );
                    break;
                }
            };
            update_snapshot(&snapshot, |current| {
                current.captured_frames = current.captured_frames.saturating_add(1);
            });
            let sequence = capture.metadata.sequence;
            let source_ticket = match ticket_for_role(
                capture.texture,
                WindowsD3d11MediaRole::Compositor,
                WindowsD3d11ComposedTextureKind::CapturedBgra,
                WindowsD3d11TextureFormat::Bgra8Unorm,
            ) {
                Ok(ticket) => ticket,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            let scene = match build_scene_plan(&plan, sequence, source_ticket.metadata().generation)
            {
                Ok(scene) => scene,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            let consumers = WindowsD3d11CompositionConsumers {
                preview: vec![WindowsD3d11MediaRole::Preview],
                primary: vec![plan.primary_role],
                auxiliary: plan
                    .auxiliary
                    .map(|_| vec![WindowsD3d11MediaRole::Stream])
                    .unwrap_or_default(),
            };
            let composition = match client.compose_scene(
                scene,
                vec![WindowsD3d11CompositionSource::TextureLease {
                    source_id: CAPTURE_SOURCE_ID,
                    ticket: source_ticket,
                }],
                consumers,
            ) {
                Ok(composition) => composition,
                Err(error) if is_transient_pressure(&error) => {
                    update_snapshot(&snapshot, |current| {
                        current.pressure_skips = current.pressure_skips.saturating_add(1);
                    });
                    continue;
                }
                Err(error) => {
                    finish_with_error(
                        &snapshot,
                        &mut startup_tx,
                        format!("D3D11 composition stopped: {error}"),
                    );
                    break;
                }
            };
            if composition.diagnostics.production_readback_frames != 0 {
                finish_with_error(
                    &snapshot,
                    &mut startup_tx,
                    "D3D11 compositor reported a forbidden production GPU readback".to_string(),
                );
                break;
            }
            let published = publish_composition(
                composition.textures,
                plan.primary_role,
                &preview_store,
                &primary_store,
                auxiliary_store.as_ref(),
            );
            let (preview_sequence, primary_sequence, auxiliary_sequence) = match published {
                Ok(published) => published,
                Err(error) => {
                    finish_with_error(&snapshot, &mut startup_tx, error);
                    break;
                }
            };
            update_snapshot(&snapshot, |current| {
                current.composed_frames = current.composed_frames.saturating_add(1);
                current.preview_sequence = Some(preview_sequence);
                current.primary_sequence = Some(primary_sequence);
                current.auxiliary_sequence = auxiliary_sequence;
            });
            if let Some(sender) = startup_tx.take() {
                let _ = sender.send(Ok(WindowsD3d11StartupEvidence {
                    capture_started: true,
                    preview_ticket: true,
                    primary_ticket: true,
                    auxiliary_ticket: plan.auxiliary.is_none() || auxiliary_sequence.is_some(),
                    // The media-thread encoder attachment command augments
                    // these before the production claim gate is evaluated.
                    primary_encoder_attached: true,
                    auxiliary_encoder_attached: true,
                }));
            }
            if let Some(remaining) = frame_interval.checked_sub(frame_started_at.elapsed()) {
                thread::sleep(remaining);
            }
        }
        let _ = client.stop_capture();
        update_snapshot(&snapshot, |current| current.stopped = true);
        if let Some(sender) = startup_tx {
            let _ = sender.send(Err(
                "D3D11 session pump stopped before first-frame readiness".to_string(),
            ));
        }
    }

    fn is_transient_pressure(error: &WindowsD3d11Error) -> bool {
        matches!(
            error.code,
            WindowsD3d11ErrorCode::TexturePoolExhausted | WindowsD3d11ErrorCode::CommandQueueFull
        )
    }

    fn finish_with_error(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        startup_tx: &mut Option<mpsc::SyncSender<Result<WindowsD3d11StartupEvidence, String>>>,
        error: String,
    ) {
        update_snapshot(snapshot, |current| {
            current.terminal_error.get_or_insert_with(|| error.clone());
        });
        if let Some(sender) = startup_tx.take() {
            let _ = sender.send(Err(error));
        }
    }

    fn update_snapshot(
        snapshot: &Arc<StdMutex<WindowsD3d11SessionPumpSnapshot>>,
        update: impl FnOnce(&mut WindowsD3d11SessionPumpSnapshot),
    ) {
        update(
            &mut snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    }

    fn build_scene_plan(
        plan: &WindowsD3d11SessionPlan,
        sequence: u64,
        generation: u64,
        camera_dimensions: Option<(u32, u32)>,
        camera_layout: Option<&LayoutSettings>,
        overlays: &[WindowsD3d11OverlayFrame],
    ) -> Result<crate::windows_d3d11_compositor::WindowsD3d11ScenePlan, String> {
        if plan.camera_required != camera_dimensions.is_some()
            || plan.camera_required != camera_layout.is_some()
        {
            return Err(
                "D3D11 scene plan did not receive the camera dimensions/layout required by the session"
                    .to_string(),
            );
        }
        let selection = WindowsDxgiOutputSelection::parse(&plan.screen_id)
            .map_err(|error| error.to_string())?;
        let dimensions = WindowsD3d11OutputDimensions::new(plan.primary.width, plan.primary.height)
            .map_err(|error| error.to_string())?;
        let mut encoded_outputs = vec![WindowsD3d11EncodedOutputPlan {
            role: WindowsD3d11EncodedOutputRole::Primary,
            dimensions,
        }];
        if let Some(auxiliary) = plan.auxiliary {
            encoded_outputs.push(WindowsD3d11EncodedOutputPlan {
                role: WindowsD3d11EncodedOutputRole::Auxiliary,
                dimensions: WindowsD3d11OutputDimensions::nv12(auxiliary.width, auxiliary.height)
                    .map_err(|error| error.to_string())?,
            });
        }
        let display_fit = camera_layout
            .map(|layout| scene_source_fit(&SceneSourceKind::Screen, layout))
            .map(windows_scene_fit)
            .unwrap_or(WindowsD3d11SceneFit::Cover);
        let mut layers = vec![WindowsD3d11SceneLayerInput {
            source_id: CAPTURE_SOURCE_ID,
            source_kind: WindowsD3d11SceneSourceKind::Display,
            source_dimensions: WindowsD3d11OutputDimensions::new(
                plan.source_width,
                plan.source_height,
            )
            .map_err(|error| error.to_string())?,
            transform: WindowsD3d11NormalizedTransform::full_canvas(),
            crop: WindowsD3d11Crop::none(),
            fit: display_fit,
            mirror_x: false,
            mask: WindowsD3d11SceneMask::None,
            effects: WindowsD3d11LayerEffects::default(),
            z_index: 0,
            output_targets: WindowsD3d11SceneOutputTargets::ALL,
        }];
        if let (Some((camera_width, camera_height)), Some(layout)) =
            (camera_dimensions, camera_layout)
        {
            let transform = resolved_camera_transform(layout, dimensions.width, dimensions.height);
            let crop = scene_crop_from_transform(&transform);
            let chroma_key = camera_chroma_key(layout).map(|key| WindowsD3d11ChromaKey {
                key_rgb: key.key_rgb,
                angle_threshold_degrees: key.max_angle_deg as f32,
                softness_degrees: key.band_deg as f32,
                spill_suppression: key.spill as f32,
                saturation_floor: (CHROMA_KEY_SATURATION_FLOOR / 255.0) as f32,
            });
            layers.push(WindowsD3d11SceneLayerInput {
                source_id: CAMERA_SOURCE_ID,
                source_kind: WindowsD3d11SceneSourceKind::CameraUpload,
                source_dimensions: WindowsD3d11OutputDimensions::new(camera_width, camera_height)
                    .map_err(|error| error.to_string())?,
                transform: WindowsD3d11NormalizedTransform {
                    x: transform.x as f32,
                    y: transform.y as f32,
                    width: transform.width as f32,
                    height: transform.height as f32,
                },
                crop: WindowsD3d11Crop {
                    left: crop.left as f32,
                    top: crop.top as f32,
                    right: crop.right as f32,
                    bottom: crop.bottom as f32,
                },
                fit: windows_scene_fit(scene_source_fit(&SceneSourceKind::Camera, layout)),
                mirror_x: layout.camera_mirror,
                mask: windows_scene_mask(camera_mask(layout)),
                effects: WindowsD3d11LayerEffects {
                    chroma_key,
                    ..Default::default()
                },
                z_index: 1,
                output_targets: WindowsD3d11SceneOutputTargets::ALL,
            });
        }
        for overlay in overlays {
            let overlay_width = overlay.overlay.width.max(1) as usize;
            let overlay_height = overlay.overlay.height.max(1) as usize;
            let output_width = overlay.output_dimensions.width.max(1) as usize;
            let output_height = overlay.output_dimensions.height.max(1) as usize;
            let (source_left, destination_left, destination_top, draw_width) =
                caption_overlay_layout_with_inset(
                    overlay_width,
                    overlay_height,
                    output_width,
                    output_height,
                    overlay.overlay.position,
                    overlay.safe_inset,
                );
            let draw_height = overlay_height.min(output_height);
            layers.push(WindowsD3d11SceneLayerInput {
                source_id: overlay.source_id,
                source_kind: overlay.source_kind,
                source_dimensions: WindowsD3d11OutputDimensions::new(
                    overlay.overlay.width,
                    overlay.overlay.height,
                )
                .map_err(|error| error.to_string())?,
                transform: WindowsD3d11NormalizedTransform {
                    x: destination_left as f32 / output_width as f32,
                    y: destination_top as f32 / output_height as f32,
                    width: draw_width as f32 / output_width as f32,
                    height: draw_height as f32 / output_height as f32,
                },
                crop: WindowsD3d11Crop {
                    left: source_left as f32 / overlay_width as f32,
                    top: 0.0,
                    right: (overlay_width - source_left - draw_width) as f32 / overlay_width as f32,
                    bottom: (overlay_height - draw_height) as f32 / overlay_height as f32,
                },
                fit: WindowsD3d11SceneFit::Contain,
                mirror_x: false,
                mask: WindowsD3d11SceneMask::None,
                effects: WindowsD3d11LayerEffects::default(),
                z_index: overlay.z_index,
                output_targets: overlay.output_targets,
            });
        }
        build_windows_d3d11_scene_plan(WindowsD3d11ScenePlanRequest {
            adapter_luid: selection.adapter_luid,
            generation,
            sequence,
            orientation: if dimensions.width >= dimensions.height {
                WindowsD3d11CanvasOrientation::Horizontal
            } else {
                WindowsD3d11CanvasOrientation::Vertical
            },
            canvas_dimensions: dimensions,
            layers,
            encoded_outputs,
        })
        .map_err(|error| error.to_string())
    }

    const fn windows_scene_fit(fit: SceneFit) -> WindowsD3d11SceneFit {
        match fit {
            SceneFit::Contain => WindowsD3d11SceneFit::Contain,
            SceneFit::Cover => WindowsD3d11SceneFit::Cover,
        }
    }

    const fn windows_scene_mask(mask: SceneMask) -> WindowsD3d11SceneMask {
        match mask {
            SceneMask::None => WindowsD3d11SceneMask::None,
            SceneMask::Circle => WindowsD3d11SceneMask::Circle,
            SceneMask::Rounded { radius_pct } => WindowsD3d11SceneMask::Rounded { radius_pct },
        }
    }

    fn publish_composition(
        textures: Vec<WindowsD3d11TicketedTexture>,
        primary_role: WindowsD3d11MediaRole,
        preview_store: &CompositorFrameStore,
        primary_store: &CompositorFrameStore,
        auxiliary_store: Option<&CompositorFrameStore>,
    ) -> Result<(Option<u64>, u64, Option<u64>), String> {
        let mut preview = None;
        let mut primary = None;
        let mut auxiliary = None;
        for texture in textures {
            match texture.kind {
                WindowsD3d11ComposedTextureKind::PreviewBgra => {
                    preview = Some(publish_texture(
                        texture,
                        WindowsD3d11MediaRole::Preview,
                        WindowsD3d11TextureFormat::Bgra8Unorm,
                        preview_store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::PrimaryNv12 => {
                    primary = Some(publish_texture(
                        texture,
                        primary_role,
                        WindowsD3d11TextureFormat::Nv12,
                        primary_store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::AuxiliaryNv12 => {
                    let store = auxiliary_store.ok_or_else(|| {
                        "D3D11 compositor returned an unrequested auxiliary output".to_string()
                    })?;
                    auxiliary = Some(publish_texture(
                        texture,
                        WindowsD3d11MediaRole::Stream,
                        WindowsD3d11TextureFormat::Nv12,
                        store,
                    )?);
                }
                WindowsD3d11ComposedTextureKind::CapturedBgra => {
                    return Err(
                        "D3D11 compositor returned a captured texture as an output".to_string()
                    );
                }
            }
        }
        Ok((
            preview,
            primary.ok_or_else(|| "D3D11 primary output was missing".to_string())?,
            auxiliary,
        ))
    }

    fn publish_texture(
        texture: WindowsD3d11TicketedTexture,
        role: WindowsD3d11MediaRole,
        expected_format: WindowsD3d11TextureFormat,
        store: &CompositorFrameStore,
    ) -> Result<u64, String> {
        let sequence = texture.sequence;
        let width = texture.width;
        let height = texture.height;
        let ticket = ticket_for_role(
            texture,
            role,
            expected_kind(expected_format),
            expected_format,
        )?;
        let pixel_format = match expected_format {
            WindowsD3d11TextureFormat::Bgra8Unorm => {
                CompositorPixelFormat::d3d11_bgra8(width, height)
            }
            WindowsD3d11TextureFormat::Nv12 => CompositorPixelFormat::d3d11_nv12(width, height),
        };
        store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .publish_with_metadata(
                sequence,
                width,
                height,
                pixel_format,
                CompositorFrameExportHandle::d3d11_texture(ticket),
                Instant::now(),
                Vec::new(),
            );
        Ok(sequence)
    }

    fn expected_kind(format: WindowsD3d11TextureFormat) -> WindowsD3d11ComposedTextureKind {
        match format {
            WindowsD3d11TextureFormat::Bgra8Unorm => WindowsD3d11ComposedTextureKind::PreviewBgra,
            WindowsD3d11TextureFormat::Nv12 => WindowsD3d11ComposedTextureKind::PrimaryNv12,
        }
    }

    fn clone_ticket_for_role(
        textures: &[WindowsD3d11TicketedTexture],
        role: WindowsD3d11MediaRole,
        expected_kind: WindowsD3d11ComposedTextureKind,
        expected_format: WindowsD3d11TextureFormat,
    ) -> Option<WindowsD3d11TextureLeaseTicket> {
        let texture = textures.iter().find(|texture| {
            texture.kind == expected_kind && texture.lease.format == expected_format
        })?;
        texture
            .tickets
            .iter()
            .find(|ticket| ticket.metadata().role == role)
            .cloned()
    }

    fn ticket_for_role(
        mut texture: WindowsD3d11TicketedTexture,
        role: WindowsD3d11MediaRole,
        expected_kind: WindowsD3d11ComposedTextureKind,
        expected_format: WindowsD3d11TextureFormat,
    ) -> Result<WindowsD3d11TextureLeaseTicket, String> {
        if texture.kind != expected_kind
            && !(expected_format == WindowsD3d11TextureFormat::Nv12
                && texture.kind == WindowsD3d11ComposedTextureKind::AuxiliaryNv12)
        {
            return Err(format!(
                "D3D11 ticket kind {:?} did not match expected {:?}",
                texture.kind, expected_kind
            ));
        }
        if texture.lease.format != expected_format {
            return Err(format!(
                "D3D11 ticket format {:?} did not match expected {:?}",
                texture.lease.format, expected_format
            ));
        }
        let ticket_index = texture
            .tickets
            .iter()
            .position(|ticket| ticket.metadata().role == role)
            .ok_or_else(|| format!("D3D11 output did not grant the {role:?} role"))?;
        Ok(texture.tickets.swap_remove(ticket_index))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use runtime::{
    WindowsD3d11CameraInput, WindowsD3d11EncoderTicketSource, WindowsD3d11OverlayInput,
    WindowsD3d11SessionDiagnosticsSnapshot, WindowsD3d11SessionMonitor, WindowsD3d11SessionPump,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> WindowsD3d11SessionRequest {
        WindowsD3d11SessionRequest {
            platform_supported: true,
            screen_id: Some("screen:dxgi:00000000000003f1:2".to_string()),
            window_selected: false,
            screen_available: true,
            source_width: Some(1920),
            source_height: Some(1080),
            supported_layout: true,
            camera_required: false,
            camera_source_available: false,
            explicit_scene: false,
            unsupported_scene_features: Vec::new(),
            media_foundation_selected: true,
            record_enabled: true,
            stream_enabled: true,
            primary: WindowsD3d11VideoPlan {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 8_000,
            },
            auxiliary: None,
        }
    }

    #[test]
    fn windows_d3d11_media_env_selects_auto_required_and_disabled() {
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(None, None).unwrap(),
            WindowsD3d11MediaMode::Automatic
        );
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(Some("disabled"), None).unwrap(),
            WindowsD3d11MediaMode::Disabled
        );
        assert_eq!(
            WindowsD3d11MediaMode::from_env_values(Some("auto"), Some("1")).unwrap(),
            WindowsD3d11MediaMode::Required
        );
        assert!(WindowsD3d11MediaMode::from_env_values(Some("off"), Some("true")).is_err());
        assert!(WindowsD3d11MediaMode::from_env_values(Some("surprise"), None).is_err());
    }

    #[test]
    fn windows_d3d11_cfr_repeats_retained_static_source_at_render_cadence() {
        assert_eq!(
            WINDOWS_D3D11_CAPTURE_POLL_WAIT_MS, 0,
            "static-source CFR must not spend its 60-fps deadline blocking on capture"
        );
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        let first = sequencer.advance(Some(41)).unwrap().unwrap();
        let repeats = [
            sequencer.advance(None).unwrap().unwrap(),
            sequencer.advance(None).unwrap().unwrap(),
            sequencer.advance(None).unwrap().unwrap(),
        ];

        assert_eq!(first.output_sequence, 1);
        assert_eq!(first.source_sequence, 41);
        assert!(!first.repeated_source);
        assert_eq!(
            repeats.map(|tick| (tick.output_sequence, tick.source_sequence)),
            [(2, 41), (3, 41), (4, 41)]
        );
        assert!(repeats.iter().all(|tick| tick.repeated_source));
    }

    #[test]
    fn windows_d3d11_cfr_rejects_nonadvancing_capture_sequence() {
        let mut sequencer = WindowsD3d11CfrSequencer::default();
        assert!(sequencer.advance(None).unwrap().is_none());
        assert!(sequencer.advance(Some(7)).unwrap().is_some());
        assert!(
            sequencer
                .advance(Some(7))
                .unwrap_err()
                .contains("did not advance")
        );
    }

    #[test]
    fn windows_d3d11_supported_auto_session_gets_generation_roles() {
        let selection =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request()).unwrap();
        let WindowsD3d11SessionSelection::Candidate(plan) = selection else {
            panic!("supported request should select D3D11");
        };
        assert_eq!(plan.primary_role, WindowsD3d11MediaRole::Stream);
        assert_eq!(
            plan.roles,
            BTreeSet::from([
                WindowsD3d11MediaRole::Compositor,
                WindowsD3d11MediaRole::Preview,
                WindowsD3d11MediaRole::Stream,
            ])
        );
    }

    #[test]
    fn windows_d3d11_split_session_assigns_record_and_stream_roles() {
        let mut request = request();
        request.auxiliary = Some(request.primary);
        let selection =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request).unwrap();
        let WindowsD3d11SessionSelection::Candidate(plan) = selection else {
            panic!("supported split request should select D3D11");
        };
        assert_eq!(plan.primary_role, WindowsD3d11MediaRole::Record);
        assert!(plan.roles.contains(&WindowsD3d11MediaRole::Record));
        assert!(plan.roles.contains(&WindowsD3d11MediaRole::Stream));
    }

    #[test]
    fn windows_d3d11_auto_names_layout_and_window_fallbacks() {
        let mut window = request();
        window.window_selected = true;
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, window).unwrap()
        else {
            panic!("window capture should use a named fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-window-capture-unsupported"
        );

        let mut scene = request();
        scene.explicit_scene = true;
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, scene).unwrap()
        else {
            panic!("explicit scene should use a named fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-explicit-scene-unsupported"
        );

        let mut overlay = request();
        overlay.unsupported_scene_features = vec![
            "caption-overlay".to_string(),
            "comment-highlight-overlay".to_string(),
        ];
        let WindowsD3d11SessionSelection::NaturalFallback(fallback) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, overlay).unwrap()
        else {
            panic!("unmapped shipping overlays must use one whole-session fallback");
        };
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-scene-features-unsupported"
        );
        assert!(fallback.detail.contains("caption-overlay"));
        assert!(fallback.detail.contains("comment-highlight-overlay"));
    }

    #[test]
    fn windows_d3d11_required_fails_closed_for_unsupported_session() {
        let mut unsupported = request();
        unsupported.primary.width = 1279;
        let error =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Required, unsupported).unwrap_err();
        assert!(error.contains(WINDOWS_REQUIRE_D3D11_MEDIA_ENV));
        assert!(error.contains("primary-profile-invalid"));
    }

    #[test]
    fn windows_d3d11_accepts_scaled_split_outputs_and_screen_camera_upload() {
        let mut scaled = request();
        scaled.source_width = Some(2560);
        scaled.source_height = Some(1440);
        scaled.primary.width = 1920;
        scaled.primary.height = 1080;
        scaled.auxiliary = Some(WindowsD3d11VideoPlan {
            width: 1280,
            height: 720,
            fps: 60,
            bitrate_kbps: 4_500,
        });
        scaled.camera_required = true;
        scaled.camera_source_available = true;
        let WindowsD3d11SessionSelection::Candidate(plan) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, scaled).unwrap()
        else {
            panic!("dimension-keyed screen-camera session should remain on D3D11");
        };
        assert_eq!((plan.source_width, plan.source_height), (2560, 1440));
        assert_eq!(
            plan.auxiliary.map(|video| (video.width, video.height)),
            Some((1280, 720))
        );
        assert!(plan.camera_required);
    }

    #[test]
    fn windows_d3d11_claim_gate_requires_every_ticket_and_encoder() {
        let WindowsD3d11SessionSelection::Candidate(plan) =
            select_windows_d3d11_session(WindowsD3d11MediaMode::Automatic, request()).unwrap()
        else {
            panic!("supported request should select D3D11");
        };
        let fallback = validate_windows_d3d11_startup_evidence(
            WindowsD3d11MediaMode::Automatic,
            &plan,
            WindowsD3d11StartupEvidence {
                capture_started: true,
                preview_ticket: true,
                primary_ticket: true,
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            fallback.code,
            "windows-d3d11-media-primary-encoder-unattached"
        );
        assert!(
            validate_windows_d3d11_startup_evidence(
                WindowsD3d11MediaMode::Required,
                &plan,
                WindowsD3d11StartupEvidence {
                    capture_started: true,
                    preview_ticket: true,
                    primary_ticket: true,
                    ..Default::default()
                },
            )
            .is_err()
        );
    }
}
