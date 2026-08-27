//! Hardware-only Windows Media Foundation H.264 encoder used by the recording
//! bridge. All COM, D3D11, and Media Foundation objects stay on the creating
//! MTA thread. The legacy compositor path submits I420 bytes; the direct
//! Windows capture path submits retained D3D11 textures without a CPU readback.

use std::collections::VecDeque;
use std::fmt;
use std::marker::PhantomData;
use std::mem::ManuallyDrop;
use std::ptr;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use windows::Win32::Foundation::{E_NOTIMPL, HMODULE, RECT, VARIANT_BOOL};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CAPS, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ALPHA_STREAM, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext,
    ID3D11Texture2D, ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1,
};
use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonLowLatency, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncCommonRealTime,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize, ICodecAPI, IMF2DBuffer2,
    IMFActivate, IMFAsyncCallback, IMFAsyncCallback_Impl, IMFAsyncResult, IMFAttributes,
    IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaEventGenerator, IMFSample, IMFTrackedSample,
    IMFTransform, METransformDrainComplete, METransformHaveOutput, METransformNeedInput,
    MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_STREAM_CHANGE, MF_EVENT_FLAG_NO_WAIT, MF_LOW_LATENCY,
    MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING,
    MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_MPEG2_PROFILE, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION,
    MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MF_SA_D3D11_AWARE,
    MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION, MF2DBuffer_LockFlags_Write,
    MFCreate2DMediaBuffer, MFCreateAttributes, MFCreateDXGIDeviceManager,
    MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateTrackedSample, MFMediaType_Video, MFNominalRange_16_235, MFSTARTUP_FULL, MFShutdown,
    MFStartup, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_ADAPTER_LUID, MFT_ENUM_FLAG,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_FRIENDLY_NAME_Attribute,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
    MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264,
    MFVideoFormat_I420, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFVideoPrimaries_BT709,
    MFVideoTransFunc_709, MFVideoTransferMatrix_BT709, eAVEncCommonRateControlMode_CBR,
    eAVEncH264VProfile_High,
};
use windows::Win32::System::Com::{
    COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4,
};
use windows::core::{ComObject, GUID, IUnknown, Interface, Ref};

use crate::diagnostics::RECORDING_FRAME_ACCOUNTING;
use crate::frame_store::RetainedD3D11Texture;
use crate::windows_d3d11_device::WindowsD3d11Device;
use crate::windows_d3d11_encoder_contract::{
    WindowsD3d11EncoderContractErrorCode, WindowsD3d11EncoderDiagnostics,
    WindowsD3d11EncoderLeaseRelease, WindowsD3d11EncoderOwnershipState,
    WindowsD3d11EncoderReleaseCallback, WindowsD3d11EncoderReleaseDisposition,
    WindowsD3d11EncoderRole, WindowsD3d11EncoderSubmissionMetadata, WindowsD3d11EncoderWaitStatus,
};

const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(1);
const EVENT_TIMEOUT: Duration = Duration::from_secs(3);
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const D3D11_INPUT_SURFACE_COUNT: usize = 4;
const TRACKED_SAMPLE_CALLBACK_QUEUE_MULTIPLIER: usize = 4;
const TRACKED_SAMPLE_GENERATION_KEY: GUID = GUID::from_u128(0xc243c261_ba33_46fd_b45f_3b03013c26d1);
const TRACKED_SAMPLE_ROLE_KEY: GUID = GUID::from_u128(0x1d73f584_e106_457a_b3f6_b237f8770db4);
const TRACKED_SAMPLE_LEASE_KEY: GUID = GUID::from_u128(0x066587c6_6714_4d93_882e_87c573b2ae63);

#[windows::core::implement(IMFAsyncCallback)]
struct TrackedSampleReleaseCallback {
    sender: SyncSender<WindowsD3d11EncoderReleaseCallback>,
    decode_failures: Arc<AtomicU64>,
    queue_failures: Arc<AtomicU64>,
}

#[allow(non_snake_case)]
impl IMFAsyncCallback_Impl for TrackedSampleReleaseCallback_Impl {
    fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Invoke(&self, result: Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        let decoded = (|| {
            let result = result.as_ref()?;
            let state = unsafe { result.GetState().ok()? };
            let attributes: IMFAttributes = state.cast().ok()?;
            let generation = unsafe { attributes.GetUINT64(&TRACKED_SAMPLE_GENERATION_KEY).ok()? };
            let role_value = unsafe { attributes.GetUINT64(&TRACKED_SAMPLE_ROLE_KEY).ok()? };
            let role = match role_value {
                1 => WindowsD3d11EncoderRole::Record,
                2 => WindowsD3d11EncoderRole::Stream,
                _ => return None,
            };
            let lease_id = unsafe { attributes.GetUINT64(&TRACKED_SAMPLE_LEASE_KEY).ok()? };
            Some(WindowsD3d11EncoderReleaseCallback {
                generation,
                role,
                lease_id,
            })
        })();
        let Some(callback) = decoded else {
            self.decode_failures.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        };
        match self.sender.try_send(callback) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.queue_failures.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaFoundationInputSubtype {
    I420,
    Nv12,
}

impl MediaFoundationInputSubtype {
    pub const fn label(self) -> &'static str {
        match self {
            Self::I420 => "I420",
            Self::Nv12 => "NV12",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MediaFoundationEncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub low_latency: bool,
}

impl MediaFoundationEncoderConfig {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.width > 0
                && self.height > 0
                && self.width.is_multiple_of(2)
                && self.height.is_multiple_of(2),
            "Media Foundation H.264 requires non-zero even dimensions, got {}x{}",
            self.width,
            self.height
        );
        ensure!(self.fps > 0, "Media Foundation H.264 FPS must be positive");
        ensure!(
            self.bitrate_kbps > 0,
            "Media Foundation H.264 bitrate must be positive"
        );
        Ok(())
    }

    pub fn profile_label(&self) -> String {
        format!(
            "{}x{}@{} {}kbps",
            self.width, self.height, self.fps, self.bitrate_kbps
        )
    }

    fn i420_len(&self) -> Result<usize> {
        let pixels = u64::from(self.width)
            .checked_mul(u64::from(self.height))
            .context("Media Foundation I420 frame size overflowed")?;
        usize::try_from(pixels + pixels / 2)
            .context("Media Foundation I420 frame size does not fit memory")
    }
}

#[derive(Debug, Clone)]
pub struct MediaFoundationEncodedFrame {
    pub frame_index: u64,
    pub pts_100ns: i64,
    pub duration_100ns: i64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct MediaFoundationProbe {
    pub encoder_identity: String,
    pub input_subtype: MediaFoundationInputSubtype,
    pub frames: Vec<MediaFoundationEncodedFrame>,
    // Bitrate the probe actually validated. On Intel iGPU MFTs that reject the
    // requested bitrate with E_UNEXPECTED, this is the fallback bitrate the
    // ladder settled on; sessions must encode at THIS bitrate or the same MFT
    // will reject the config mid-session where there is no clean retry.
    pub effective_bitrate_kbps: u32,
}

pub struct MediaFoundationH264Encoder {
    config: MediaFoundationEncoderConfig,
    activation: ManuallyDrop<IMFActivate>,
    transform: ManuallyDrop<IMFTransform>,
    events: ManuallyDrop<IMFMediaEventGenerator>,
    identity: String,
    input_subtype: MediaFoundationInputSubtype,
    sequence_header: Vec<u8>,
    submitted_pts: VecDeque<i64>,
    submitted_surface_slots: VecDeque<Option<SubmittedSurfaceSlot>>,
    d3d11_input: Option<D3D11SurfaceInput>,
    d3d11_cpu_upload: Option<D3D11CpuUploadInput>,
    last_output_pts: Option<i64>,
    input_credits: usize,
    saw_first_idr: bool,
    /// Bounded wait for `METransformNeedInput` once the MFT has granted its
    /// first credit. The bridge writer caps this at two frame intervals so a
    /// stalled MFT skips one frame (counted) instead of freezing the CFR
    /// schedule for the full [`EVENT_TIMEOUT`]; every other caller keeps the
    /// 3 s hard failure.
    input_credit_timeout: Duration,
    /// Cold start always gets the full [`EVENT_TIMEOUT`]; the cap applies only
    /// after the MFT has proven it issues credits at all.
    saw_first_input_credit: bool,
    /// True for the session's recording leg: submissions and input-credit
    /// waits feed [`RECORDING_FRAME_ACCOUNTING`].
    accounts_session_frames: bool,
    input_credit_timeouts: u64,
    drained: bool,
    mf_started: bool,
    com_started: bool,
}

struct D3D11SurfaceSlot {
    texture: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    in_use: bool,
}

#[derive(Clone, Copy)]
enum SubmittedSurfaceSlot {
    Direct(usize),
    CpuUpload(usize),
}

struct D3D11CpuUploadSlot {
    texture: ID3D11Texture2D,
    nv12_bytes: Vec<u8>,
    in_use: bool,
}

struct D3D11CpuUploadInput {
    immediate_context: ID3D11DeviceContext,
    device_manager: IMFDXGIDeviceManager,
    width: u32,
    height: u32,
    surfaces: Vec<D3D11CpuUploadSlot>,
}

struct D3D11SurfaceInput {
    device: ID3D11Device,
    immediate_context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext1,
    device_manager: IMFDXGIDeviceManager,
    processor_enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    source_width: u32,
    source_height: u32,
    output_width: u32,
    output_height: u32,
    fps: u32,
    surfaces: Vec<D3D11SurfaceSlot>,
    camera_overlay: Option<D3D11CameraOverlayTexture>,
}

struct D3D11CameraOverlayTexture {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
    sequence: u64,
}

pub struct D3D11BgraOverlay<'a> {
    pub bytes: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
    pub destination: crate::scene_geometry::PixelRect,
}

#[derive(Clone, Copy)]
struct D3D11ProcessorConfig {
    source_width: u32,
    source_height: u32,
    output_width: u32,
    output_height: u32,
    fps: u32,
}

#[derive(Debug, Default)]
pub(crate) struct MediaFoundationD3d11EncoderProgress {
    pub(crate) encoded_frames: Vec<MediaFoundationEncodedFrame>,
    pub(crate) released_leases: Vec<WindowsD3d11EncoderLeaseRelease>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct MediaFoundationD3d11EncoderDiagnostics {
    pub(crate) adapter_luid: u64,
    pub(crate) d3d11_aware: bool,
    pub(crate) dxgi_manager_bound: bool,
    pub(crate) callback_decode_failures: u64,
    pub(crate) callback_queue_failures: u64,
    pub(crate) ownership: WindowsD3d11EncoderDiagnostics,
}

#[derive(Debug)]
pub(crate) struct MediaFoundationD3d11SubmissionFailure {
    pub(crate) release: WindowsD3d11EncoderLeaseRelease,
    pub(crate) progress: MediaFoundationD3d11EncoderProgress,
    pub(crate) kind: MediaFoundationD3d11SubmissionFailureKind,
    error: anyhow::Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaFoundationD3d11SubmissionFailureKind {
    Backpressure,
    Rejected,
}

impl MediaFoundationD3d11SubmissionFailure {
    fn new(
        metadata: WindowsD3d11EncoderSubmissionMetadata,
        progress: MediaFoundationD3d11EncoderProgress,
        error: anyhow::Error,
    ) -> Self {
        Self {
            release: lease_release(metadata),
            progress,
            kind: MediaFoundationD3d11SubmissionFailureKind::Rejected,
            error,
        }
    }

    fn from_contract(
        metadata: WindowsD3d11EncoderSubmissionMetadata,
        progress: MediaFoundationD3d11EncoderProgress,
        error: crate::windows_d3d11_encoder_contract::WindowsD3d11EncoderContractError,
    ) -> Self {
        let kind = if matches!(
            error.code,
            WindowsD3d11EncoderContractErrorCode::NoInputCredit
                | WindowsD3d11EncoderContractErrorCode::Backpressure
        ) {
            MediaFoundationD3d11SubmissionFailureKind::Backpressure
        } else {
            MediaFoundationD3d11SubmissionFailureKind::Rejected
        };
        Self {
            release: lease_release(metadata),
            progress,
            kind,
            error: anyhow!("Media Foundation D3D11 submission reservation: {error}"),
        }
    }

    fn with_release(
        release: WindowsD3d11EncoderLeaseRelease,
        progress: MediaFoundationD3d11EncoderProgress,
        error: anyhow::Error,
    ) -> Self {
        Self {
            release,
            progress,
            kind: MediaFoundationD3d11SubmissionFailureKind::Rejected,
            error,
        }
    }
}

impl fmt::Display for MediaFoundationD3d11SubmissionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.error)
    }
}

impl std::error::Error for MediaFoundationD3d11SubmissionFailure {}

/// Dedicated NV12 DXGI-surface encoder. This is intentionally separate from
/// `MediaFoundationH264Encoder`: a surface lease can never enter the I420 byte
/// API, and successful `ProcessInput` transfers recycling authority solely to
/// the tracked-sample release callback.
#[allow(dead_code)]
pub(crate) struct MediaFoundationD3d11H264Encoder {
    config: MediaFoundationEncoderConfig,
    activation: ManuallyDrop<IMFActivate>,
    transform: ManuallyDrop<IMFTransform>,
    events: ManuallyDrop<IMFMediaEventGenerator>,
    device_manager: ManuallyDrop<IMFDXGIDeviceManager>,
    authority_device: ManuallyDrop<IUnknown>,
    release_callback: ManuallyDrop<IMFAsyncCallback>,
    release_receiver: Receiver<WindowsD3d11EncoderReleaseCallback>,
    callback_decode_failures: Arc<AtomicU64>,
    callback_queue_failures: Arc<AtomicU64>,
    identity: String,
    adapter_luid: u64,
    ownership: WindowsD3d11EncoderOwnershipState,
    sequence_header: Vec<u8>,
    submitted_pts: VecDeque<i64>,
    last_output_pts: Option<i64>,
    started_at: Instant,
    drained: bool,
    mf_started: bool,
    com_started: bool,
    _thread_affinity: PhantomData<Rc<()>>,
}

impl MediaFoundationH264Encoder {
    /// Creates and configures the highest-merit hardware H.264 MFT. Call this
    /// only from the dedicated encoder thread that will own the session.
    pub fn new(config: MediaFoundationEncoderConfig) -> Result<Self> {
        Self::new_with_optional_d3d11_texture(config, None)
    }

    /// Creates a hardware H.264 MFT configured to accept NV12 surfaces owned by
    /// the D3D11 device that produced `source_texture`.
    pub fn new_with_d3d11_texture(
        config: MediaFoundationEncoderConfig,
        source_texture: &RetainedD3D11Texture,
    ) -> Result<Self> {
        Self::new_with_optional_d3d11_texture(config, Some(source_texture))
    }

    fn new_with_optional_d3d11_texture(
        config: MediaFoundationEncoderConfig,
        source_texture: Option<&RetainedD3D11Texture>,
    ) -> Result<Self> {
        config.validate()?;
        let profile = config.profile_label();
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                return Err(stage_error(
                    "com-initialize",
                    hr,
                    "<not-enumerated>",
                    None,
                    &profile,
                ));
            }
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(stage_windows_error(
                    "mf-startup",
                    &error,
                    "<not-enumerated>",
                    None,
                    &profile,
                ));
            }
        }

        let result = Self::create_after_startup(config.clone(), source_texture, true, true);
        if result.is_err() {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
        result
    }

    fn create_after_startup(
        config: MediaFoundationEncoderConfig,
        source_texture: Option<&RetainedD3D11Texture>,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let activations = enumerate_hardware_h264_activations(&profile)?;
        let mut failures = Vec::new();
        for activation in activations {
            let identity = activation_name(&activation)
                .unwrap_or_else(|_| "<unnamed hardware H.264 MFT>".to_string());
            let adapter_luid = activation_adapter_luid(&activation).map_err(|error| {
                anyhow!(
                    "Media Foundation probe stage=activation-adapter encoder={identity:?} input=<unset> profile={profile}: {error}"
                )
            })?;
            match unsafe { activation.ActivateObject::<IMFTransform>() } {
                Ok(transform) => {
                    match Self::configure_transform(
                        config.clone(),
                        activation,
                        transform,
                        identity.clone(),
                        adapter_luid,
                        source_texture,
                        com_started,
                        mf_started,
                    ) {
                        Ok(encoder) => return Ok(encoder),
                        Err(error) => failures.push(error.to_string()),
                    }
                }
                Err(error) => failures.push(
                    stage_windows_error("activate", &error, &identity, None, &profile).to_string(),
                ),
            }
        }
        bail!(
            "Media Foundation hardware H.264 probe rejected every activation for {profile}: {}",
            failures.join(" | ")
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn configure_transform(
        config: MediaFoundationEncoderConfig,
        activation: IMFActivate,
        transform: IMFTransform,
        identity: String,
        adapter_luid: Option<u64>,
        source_texture: Option<&RetainedD3D11Texture>,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let attributes = unsafe {
            transform.GetAttributes().map_err(|error| {
                stage_windows_error(
                    "get-transform-attributes",
                    &error,
                    &identity,
                    None,
                    &profile,
                )
            })?
        };
        let asynchronous = unsafe { attributes.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0);
        ensure!(
            asynchronous != 0,
            "Media Foundation probe stage=async-contract encoder={identity:?} input=<unset> profile={profile}: hardware activation did not advertise an asynchronous MFT"
        );
        let d3d11_aware = unsafe { attributes.GetUINT32(&MF_SA_D3D11_AWARE) }.unwrap_or(0);
        if source_texture.is_some() {
            ensure!(
                d3d11_aware != 0,
                "Media Foundation probe stage=d3d11-awareness encoder={identity:?} input=NV12-D3D11 profile={profile}: hardware activation did not advertise MF_SA_D3D11_AWARE"
            );
        }
        unsafe {
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|error| {
                    stage_windows_error("async-unlock", &error, &identity, None, &profile)
                })?;
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, u32::from(config.low_latency));
        }

        let d3d11_input = source_texture
            .map(|source_texture| {
                D3D11SurfaceInput::new(&config, source_texture).map_err(|error| {
                    anyhow!(
                        "Media Foundation probe stage=d3d11-input-setup encoder={identity:?} input=NV12-D3D11 profile={profile}: {error}"
                    )
                })
            })
            .transpose()?;
        let d3d11_cpu_upload = if source_texture.is_none() && d3d11_aware != 0 {
            Some(
                D3D11CpuUploadInput::new(&config, adapter_luid).map_err(|error| {
                anyhow!(
                    "Media Foundation probe stage=d3d11-cpu-upload-setup encoder={identity:?} input=NV12-D3D11 profile={profile}: {error}"
                )
                })?,
            )
        } else {
            None
        };
        let device_manager = d3d11_input
            .as_ref()
            .map(|input| &input.device_manager)
            .or_else(|| d3d11_cpu_upload.as_ref().map(|input| &input.device_manager));
        if let Some(device_manager) = device_manager {
            let manager: IUnknown = device_manager.cast().map_err(|error| {
                stage_windows_error(
                    "d3d-manager-interface",
                    &error,
                    &identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                )
            })?;
            unsafe {
                transform
                    .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                    .map_err(|error| {
                        stage_windows_error(
                            "set-d3d-manager",
                            &error,
                            &identity,
                            Some(MediaFoundationInputSubtype::Nv12),
                            &profile,
                        )
                    })?;
            }
        }

        let output_type = create_video_type(
            &config,
            MFVideoFormat_H264,
            Some(eAVEncH264VProfile_High.0 as u32),
        )
        .map_err(|error| anyhow!("Media Foundation output type for {profile}: {error}"))?;
        unsafe {
            transform
                .SetOutputType(0, &output_type, 0)
                .map_err(|error| {
                    stage_windows_error("set-output-type", &error, &identity, None, &profile)
                })?;
        }

        let mut selected = None;
        let mut input_failures = Vec::new();
        let input_candidates: &[(MediaFoundationInputSubtype, windows::core::GUID)] =
            if d3d11_input.is_some() {
                &[(MediaFoundationInputSubtype::Nv12, MFVideoFormat_NV12)]
            } else {
                &[
                    (MediaFoundationInputSubtype::I420, MFVideoFormat_I420),
                    (MediaFoundationInputSubtype::Nv12, MFVideoFormat_NV12),
                ]
            };
        for &(subtype, guid) in input_candidates {
            let input_type = create_video_type(&config, guid, None)?;
            match unsafe { transform.SetInputType(0, &input_type, 0) } {
                Ok(()) => {
                    selected = Some(subtype);
                    break;
                }
                Err(error) => input_failures.push(format!(
                    "{} HRESULT=0x{:08X}",
                    subtype.label(),
                    error.code().0 as u32
                )),
            }
        }
        let input_subtype = selected.with_context(|| {
            format!(
                "Media Foundation probe stage=set-input-type encoder={identity:?} input=I420/NV12 profile={profile}: {}",
                input_failures.join(", ")
            )
        })?;
        configure_codec_api(&transform, &config, &identity, input_subtype)?;
        let events: IMFMediaEventGenerator = transform.cast().map_err(|error| {
            stage_windows_error(
                "event-generator",
                &error,
                &identity,
                Some(input_subtype),
                &profile,
            )
        })?;
        unsafe {
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "begin-streaming",
                        &error,
                        &identity,
                        Some(input_subtype),
                        &profile,
                    )
                })?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "start-stream",
                        &error,
                        &identity,
                        Some(input_subtype),
                        &profile,
                    )
                })?;
        }
        let sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        Ok(Self {
            config,
            activation: ManuallyDrop::new(activation),
            transform: ManuallyDrop::new(transform),
            events: ManuallyDrop::new(events),
            identity,
            input_subtype,
            sequence_header,
            submitted_pts: VecDeque::new(),
            submitted_surface_slots: VecDeque::new(),
            d3d11_input,
            d3d11_cpu_upload,
            last_output_pts: None,
            input_credits: 0,
            saw_first_idr: false,
            input_credit_timeout: EVENT_TIMEOUT,
            saw_first_input_credit: false,
            accounts_session_frames: false,
            input_credit_timeouts: 0,
            drained: false,
            mf_started,
            com_started,
        })
    }

    /// Bridge writer thread posture: cap steady-state input-credit waits at
    /// `input_credit_timeout` (skip-and-count instead of a 3 s stall) and,
    /// for the recording leg, feed the session frame accounting.
    pub fn configure_for_bridge_writer(
        &mut self,
        input_credit_timeout: Duration,
        accounts_session_frames: bool,
    ) {
        self.input_credit_timeout = input_credit_timeout.min(EVENT_TIMEOUT);
        self.accounts_session_frames = accounts_session_frames;
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub const fn input_subtype(&self) -> MediaFoundationInputSubtype {
        self.input_subtype
    }

    pub fn pending_frame_count(&self) -> usize {
        self.submitted_pts.len()
    }

    pub fn encode_frame(
        &mut self,
        i420: &[u8],
        frame_index: u64,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        ensure!(
            !self.drained,
            "Media Foundation encoder {} was already drained",
            self.identity
        );
        ensure!(
            i420.len() == self.config.i420_len()?,
            "Media Foundation encoder {} expected {} I420 bytes, got {}",
            self.identity,
            self.config.i420_len()?,
            i420.len()
        );
        let (mut output, credit) = self.acquire_input_credit_for_frame()?;
        if !credit {
            return Ok(output);
        }
        let use_d3d11_cpu_upload = self.input_subtype == MediaFoundationInputSubtype::Nv12
            && self.d3d11_cpu_upload.is_some();
        if use_d3d11_cpu_upload {
            output.extend(self.wait_for_d3d11_cpu_upload_surface(EVENT_TIMEOUT)?);
        }
        let pts = scheduled_time_100ns(frame_index, self.config.fps)?;
        let duration = scheduled_duration_100ns(frame_index, self.config.fps)?;
        let (sample, submitted_surface_slot) = if use_d3d11_cpu_upload {
            let (sample, surface_slot) = self
                .d3d11_cpu_upload
                .as_mut()
                .context("D3D11 CPU upload input disappeared while encoding")?
                .create_sample(i420, pts, duration)
                .map_err(|error| {
                    anyhow!(
                        "Media Foundation probe stage=create-d3d11-cpu-upload-sample encoder={:?} input=NV12-D3D11 profile={}: {error}",
                        self.identity,
                        self.config.profile_label()
                    )
                })?;
            (sample, Some(SubmittedSurfaceSlot::CpuUpload(surface_slot)))
        } else {
            (
                create_input_sample(
                    i420,
                    self.input_subtype,
                    self.config.width,
                    self.config.height,
                    pts,
                    duration,
                )
                .map_err(|error| {
                    anyhow!(
                        "Media Foundation probe stage=create-input-sample encoder={:?} input={} profile={}: {error}",
                        self.identity,
                        self.input_subtype.label(),
                        self.config.profile_label()
                    )
                })?,
                None,
            )
        };
        if let Err(error) = unsafe { self.transform.ProcessInput(0, &sample, 0) } {
            if let Some(SubmittedSurfaceSlot::CpuUpload(surface_slot)) = submitted_surface_slot
                && let Some(d3d11_cpu_upload) = self.d3d11_cpu_upload.as_mut()
            {
                d3d11_cpu_upload.release_surface(surface_slot);
            }
            return Err(stage_windows_error(
                "process-input",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            ));
        }
        self.submitted_pts.push_back(pts);
        self.submitted_surface_slots
            .push_back(submitted_surface_slot);
        self.input_credits = self.input_credits.saturating_sub(1);
        self.record_submitted_frame();
        output.extend(self.collect_available_events()?);
        Ok(output)
    }

    pub fn encode_d3d11_texture(
        &mut self,
        source_texture: &RetainedD3D11Texture,
        frame_index: u64,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        self.encode_d3d11_texture_with_overlay(source_texture, None, frame_index)
    }

    pub fn encode_d3d11_texture_with_overlay(
        &mut self,
        source_texture: &RetainedD3D11Texture,
        overlay: Option<&D3D11BgraOverlay<'_>>,
        frame_index: u64,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        ensure!(
            !self.drained,
            "Media Foundation encoder {} was already drained",
            self.identity
        );
        ensure!(
            self.d3d11_input.is_some(),
            "Media Foundation encoder {} was not configured for D3D11 texture input",
            self.identity
        );
        let (mut output, credit) = self.acquire_input_credit_for_frame()?;
        if !credit {
            return Ok(output);
        }
        output.extend(self.wait_for_d3d11_surface(EVENT_TIMEOUT)?);
        let pts = scheduled_time_100ns(frame_index, self.config.fps)?;
        let duration = scheduled_duration_100ns(frame_index, self.config.fps)?;
        let (sample, surface_slot) = self
            .d3d11_input
            .as_mut()
            .context("D3D11 input disappeared while encoding")?
            .create_sample(source_texture, overlay, pts, duration)
            .map_err(|error| {
                anyhow!(
                    "Media Foundation probe stage=create-d3d11-input-sample encoder={:?} input=NV12-D3D11 profile={}: {error}",
                    self.identity,
                    self.config.profile_label()
                )
            })?;
        let process_result = unsafe { self.transform.ProcessInput(0, &sample, 0) };
        if let Err(error) = process_result {
            if let Some(d3d11_input) = self.d3d11_input.as_mut() {
                d3d11_input.release_surface(surface_slot);
            }
            return Err(stage_windows_error(
                "process-d3d11-input",
                &error,
                &self.identity,
                Some(MediaFoundationInputSubtype::Nv12),
                &self.config.profile_label(),
            ));
        }
        self.submitted_pts.push_back(pts);
        self.submitted_surface_slots
            .push_back(Some(SubmittedSurfaceSlot::Direct(surface_slot)));
        self.input_credits = self.input_credits.saturating_sub(1);
        self.record_submitted_frame();
        output.extend(self.collect_available_events()?);
        Ok(output)
    }

    fn record_submitted_frame(&self) {
        if self.accounts_session_frames {
            RECORDING_FRAME_ACCOUNTING.record_mf_submitted_frame();
        }
    }

    /// Per-frame input credit with the writer posture applied: cold start and
    /// unconfigured callers wait the full [`EVENT_TIMEOUT`] and fail hard;
    /// a configured writer waits at most `input_credit_timeout` in steady
    /// state and returns `(output, false)` so the caller skips the frame.
    /// Output collected while waiting is always returned.
    fn acquire_input_credit_for_frame(
        &mut self,
    ) -> Result<(Vec<MediaFoundationEncodedFrame>, bool)> {
        let timeout = if self.saw_first_input_credit {
            self.input_credit_timeout
        } else {
            EVENT_TIMEOUT
        };
        let wait_started_at = Instant::now();
        let (output, credit) = self.poll_input_credit(timeout)?;
        if self.accounts_session_frames {
            RECORDING_FRAME_ACCOUNTING.record_mf_input_credit_wait(wait_started_at.elapsed());
        }
        if credit {
            self.saw_first_input_credit = true;
            return Ok((output, true));
        }
        if timeout >= EVENT_TIMEOUT {
            return Err(self.input_credit_timeout_error(timeout));
        }
        self.input_credit_timeouts = self.input_credit_timeouts.saturating_add(1);
        if self.accounts_session_frames {
            RECORDING_FRAME_ACCOUNTING.record_mf_input_credit_timeout();
        }
        if self.input_credit_timeouts == 1 || self.input_credit_timeouts.is_multiple_of(300) {
            tracing::warn!(
                "Media Foundation encoder {} granted no input credit within {}ms; skipping the frame ({} skipped so far)",
                self.identity,
                timeout.as_millis(),
                self.input_credit_timeouts
            );
        }
        Ok((output, false))
    }

    fn input_credit_timeout_error(&self, timeout: Duration) -> anyhow::Error {
        anyhow!(
            "Media Foundation probe stage=need-input encoder={:?} input={} profile={}: no input credit within {}ms",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            timeout.as_millis()
        )
    }

    pub fn drain(&mut self, timeout: Duration) -> Result<Vec<MediaFoundationEncodedFrame>> {
        if self.drained {
            return Ok(Vec::new());
        }
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "end-of-stream",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &self.config.profile_label(),
                    )
                })?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "drain-command",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &self.config.profile_label(),
                    )
                })?;
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        let mut drain_complete = false;
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                }
                Some(event_type) if event_type == METransformDrainComplete.0 as u32 => {
                    drain_complete = true;
                    break;
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        ensure!(
            drain_complete && self.submitted_pts.is_empty(),
            "Media Foundation probe stage=drain encoder={:?} input={} profile={}: bounded drain did not complete in {}ms (pending timestamps={})",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            timeout.as_millis(),
            self.submitted_pts.len()
        );
        self.drained = true;
        Ok(output)
    }

    /// Bounded wait for an input credit that never fails on timeout: returns
    /// the output drained meanwhile and whether a credit is now held.
    fn poll_input_credit(
        &mut self,
        timeout: Duration,
    ) -> Result<(Vec<MediaFoundationEncodedFrame>, bool)> {
        if self.input_credits > 0 {
            return Ok((Vec::new(), true));
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformNeedInput.0 as u32 => {
                    self.input_credits = self.input_credits.saturating_add(1);
                    return Ok((output, true));
                }
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        Ok((output, false))
    }

    fn wait_for_d3d11_surface(
        &mut self,
        timeout: Duration,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        if self
            .d3d11_input
            .as_ref()
            .is_some_and(D3D11SurfaceInput::has_available_surface)
        {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                    if self
                        .d3d11_input
                        .as_ref()
                        .is_some_and(D3D11SurfaceInput::has_available_surface)
                    {
                        return Ok(output);
                    }
                }
                Some(event_type) if event_type == METransformNeedInput.0 as u32 => {
                    self.input_credits = self.input_credits.saturating_add(1);
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        bail!(
            "Media Foundation probe stage=d3d11-surface-pool encoder={:?} input=NV12-D3D11 profile={}: no reusable surface within {}ms",
            self.identity,
            self.config.profile_label(),
            timeout.as_millis()
        )
    }

    fn wait_for_d3d11_cpu_upload_surface(
        &mut self,
        timeout: Duration,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        if self
            .d3d11_cpu_upload
            .as_ref()
            .is_some_and(D3D11CpuUploadInput::has_available_surface)
        {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                    if self
                        .d3d11_cpu_upload
                        .as_ref()
                        .is_some_and(D3D11CpuUploadInput::has_available_surface)
                    {
                        return Ok(output);
                    }
                }
                Some(event_type) if event_type == METransformNeedInput.0 as u32 => {
                    self.input_credits = self.input_credits.saturating_add(1);
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        bail!(
            "Media Foundation probe stage=d3d11-cpu-upload-surface-pool encoder={:?} input=NV12-D3D11 profile={}: no reusable surface within {}ms",
            self.identity,
            self.config.profile_label(),
            timeout.as_millis()
        )
    }

    fn collect_available_events(&mut self) -> Result<Vec<MediaFoundationEncodedFrame>> {
        let mut output = Vec::new();
        while let Some(event_type) = self.next_event()? {
            if event_type == METransformHaveOutput.0 as u32 {
                output.push(self.process_one_output()?);
            } else if event_type == METransformNeedInput.0 as u32 {
                self.input_credits = self.input_credits.saturating_add(1);
            }
        }
        Ok(output)
    }

    fn next_event(&self) -> Result<Option<u32>> {
        let event = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(None),
            Err(error) => {
                return Err(stage_windows_error(
                    "get-event",
                    &error,
                    &self.identity,
                    Some(self.input_subtype),
                    &self.config.profile_label(),
                ));
            }
        };
        let status = unsafe { event.GetStatus() }.map_err(|error| {
            stage_windows_error(
                "event-status",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        if status.is_err() {
            return Err(stage_error(
                "event-status",
                status,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            ));
        }
        unsafe { event.GetType() }
            .map_err(|error| {
                stage_windows_error(
                    "event-type",
                    &error,
                    &self.identity,
                    Some(self.input_subtype),
                    &self.config.profile_label(),
                )
            })
            .map(Some)
    }

    fn process_one_output(&mut self) -> Result<MediaFoundationEncodedFrame> {
        let profile_label = self.config.profile_label();
        let mut renegotiations = 0_u32;
        let sample = loop {
            let stream_info =
                unsafe { self.transform.GetOutputStreamInfo(0) }.map_err(|error| {
                    stage_windows_error(
                        "output-stream-info",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &profile_label,
                    )
                })?;
            let transform_provides_sample = stream_info.dwFlags
                & ((MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0)
                    as u32)
                != 0;
            let supplied_sample = if transform_provides_sample {
                None
            } else {
                let sample = unsafe { MFCreateSample() }?;
                let buffer = unsafe { MFCreateMemoryBuffer(stream_info.cbSize.max(1)) }?;
                unsafe { sample.AddBuffer(&buffer) }?;
                Some(sample)
            };
            let mut output_buffer = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(supplied_sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            let mut status = 0_u32;
            let process_result = unsafe {
                self.transform.ProcessOutput(
                    0,
                    std::slice::from_mut(&mut output_buffer),
                    &mut status,
                )
            };
            let sample = unsafe { ManuallyDrop::take(&mut output_buffer.pSample) };
            let _events = unsafe { ManuallyDrop::take(&mut output_buffer.pEvents) };
            match process_result {
                Ok(()) => break sample,
                Err(error)
                    if is_mf_stream_change(error.code())
                        && renegotiations < MFT_STREAM_CHANGE_MAX_RENEGOTIATIONS =>
                {
                    renegotiations += 1;
                    tracing::warn!(
                        "Media Foundation encoder {:?} requested output-type renegotiation (attempt {renegotiations}/{}); re-selecting output type",
                        self.identity,
                        MFT_STREAM_CHANGE_MAX_RENEGOTIATIONS
                    );
                    renegotiate_mft_output_type(
                        &self.transform,
                        &self.config,
                        &self.identity,
                        Some(self.input_subtype),
                    )?;
                }
                Err(error) => {
                    return Err(stage_windows_error(
                        "process-output",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &profile_label,
                    ));
                }
            }
        };
        let sample = sample.context("Media Foundation HaveOutput event returned no sample")?;
        let pts = unsafe { sample.GetSampleTime() }.map_err(|error| {
            stage_windows_error(
                "output-timestamp",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        let expected_pts = self.submitted_pts.pop_front().with_context(|| {
            format!(
                "Media Foundation encoder {:?} produced output without a submitted timestamp",
                self.identity
            )
        })?;
        let submitted_surface_slot =
            self.submitted_surface_slots.pop_front().with_context(|| {
                format!(
                    "Media Foundation encoder {:?} lost its submitted-surface bookkeeping",
                    self.identity
                )
            })?;
        if let Some(submitted_surface_slot) = submitted_surface_slot {
            match submitted_surface_slot {
                SubmittedSurfaceSlot::Direct(surface_slot) => {
                    if let Some(d3d11_input) = self.d3d11_input.as_mut() {
                        d3d11_input.release_surface(surface_slot);
                    }
                }
                SubmittedSurfaceSlot::CpuUpload(surface_slot) => {
                    if let Some(d3d11_cpu_upload) = self.d3d11_cpu_upload.as_mut() {
                        d3d11_cpu_upload.release_surface(surface_slot);
                    }
                }
            }
        }
        ensure!(
            pts == expected_pts,
            "Media Foundation probe stage=timestamp-order encoder={:?} input={} profile={}: expected PTS {}, got {} (reordered/B-frame-dependent output)",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            expected_pts,
            pts
        );
        if let Some(last) = self.last_output_pts {
            ensure!(
                pts > last,
                "Media Foundation probe stage=timestamp-regression encoder={:?} input={} profile={}: output PTS {} followed {}",
                self.identity,
                self.input_subtype.label(),
                self.config.profile_label(),
                pts,
                last
            );
        }
        self.last_output_pts = Some(pts);
        let duration = unsafe { sample.GetSampleDuration() }
            .unwrap_or_else(|_| scheduled_duration_100ns(0, self.config.fps).unwrap_or(1));
        let buffer = unsafe { sample.ConvertToContiguousBuffer() }?;
        let encoded = copy_media_buffer(&buffer)?;
        let mut bytes = normalize_annex_b(&encoded)?;
        if self.sequence_header.is_empty()
            && let Ok(output_type) = unsafe { self.transform.GetOutputCurrentType(0) }
        {
            self.sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        }
        let contains_idr = annex_b_contains_nal_type(&bytes, 5);
        if contains_idr && !annex_b_has_parameter_sets(&bytes) {
            ensure!(
                annex_b_has_parameter_sets(&self.sequence_header),
                "Media Foundation probe stage=sequence-header encoder={:?} input={} profile={}: IDR had no SPS/PPS and MF_MT_MPEG_SEQUENCE_HEADER was unusable",
                self.identity,
                self.input_subtype.label(),
                self.config.profile_label()
            );
            let mut with_header = Vec::with_capacity(self.sequence_header.len() + bytes.len());
            with_header.extend_from_slice(&self.sequence_header);
            with_header.extend_from_slice(&bytes);
            bytes = with_header;
        }
        if contains_idr {
            self.saw_first_idr = true;
        }
        let frame_index = frame_index_from_100ns(pts, self.config.fps)?;
        Ok(MediaFoundationEncodedFrame {
            frame_index,
            pts_100ns: pts,
            duration_100ns: duration,
            bytes,
        })
    }
}

impl D3D11CpuUploadInput {
    fn new(config: &MediaFoundationEncoderConfig, adapter_luid: Option<u64>) -> Result<Self> {
        let adapter = adapter_luid.map(dxgi_adapter_for_luid).transpose()?;
        let adapter: Option<IDXGIAdapter> = adapter
            .as_ref()
            .map(|adapter| adapter.cast().context("cast selected DXGI adapter"))
            .transpose()?;
        let driver_type = if adapter.is_some() {
            D3D_DRIVER_TYPE_UNKNOWN
        } else {
            D3D_DRIVER_TYPE_HARDWARE
        };
        let mut device = None;
        let mut immediate_context = None;
        unsafe {
            D3D11CreateDevice(
                adapter.as_ref(),
                driver_type,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut immediate_context),
            )
        }
        .context("create D3D11 device for reusable CPU frame uploads")?;
        let device = device.context("D3D11CreateDevice returned no CPU upload device")?;
        let immediate_context = immediate_context
            .context("D3D11CreateDevice returned no CPU upload immediate context")?;

        let mut reset_token = 0_u32;
        let mut device_manager = None;
        unsafe {
            MFCreateDXGIDeviceManager(&mut reset_token, &mut device_manager)
                .context("create MF DXGI device manager for CPU uploads")?;
        }
        let device_manager =
            device_manager.context("MFCreateDXGIDeviceManager returned no CPU upload manager")?;
        let device_unknown: IUnknown = device.cast().context("cast CPU upload D3D11 device")?;
        unsafe {
            device_manager
                .ResetDevice(&device_unknown, reset_token)
                .context("bind CPU upload D3D11 device to MF DXGI device manager")?;
        }

        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: config.width,
            Height: config.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET
                | D3D11_BIND_SHADER_RESOURCE
                | D3D11_BIND_VIDEO_ENCODER)
                .0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let nv12_len = config.i420_len()?;
        let mut surfaces = Vec::with_capacity(D3D11_INPUT_SURFACE_COUNT);
        for _ in 0..D3D11_INPUT_SURFACE_COUNT {
            let mut texture = None;
            unsafe {
                device
                    .CreateTexture2D(&texture_desc, None, Some(&mut texture))
                    .context("create reusable D3D11 NV12 CPU-upload encoder texture")?;
            }
            surfaces.push(D3D11CpuUploadSlot {
                texture: texture.context("CreateTexture2D returned no CPU-upload texture")?,
                nv12_bytes: vec![0; nv12_len],
                in_use: false,
            });
        }
        Ok(Self {
            immediate_context,
            device_manager,
            width: config.width,
            height: config.height,
            surfaces,
        })
    }

    fn has_available_surface(&self) -> bool {
        self.surfaces.iter().any(|surface| !surface.in_use)
    }

    fn create_sample(
        &mut self,
        i420: &[u8],
        pts: i64,
        duration: i64,
    ) -> Result<(IMFSample, usize)> {
        let surface_slot = self
            .surfaces
            .iter()
            .position(|surface| !surface.in_use)
            .context("D3D11 CPU-upload encoder surface pool was exhausted")?;
        let surface = &mut self.surfaces[surface_slot];
        let pitch = usize::try_from(self.width)?;
        i420_to_nv12_strided(
            i420,
            self.width,
            self.height,
            pitch,
            &mut surface.nv12_bytes,
        )?;
        unsafe {
            self.immediate_context.UpdateSubresource(
                &surface.texture,
                0,
                None,
                surface.nv12_bytes.as_ptr().cast(),
                self.width,
                0,
            );
        }

        let surface_unknown: IUnknown = surface
            .texture
            .cast()
            .context("cast CPU-upload NV12 texture to IUnknown")?;
        let buffer =
            unsafe { MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &surface_unknown, 0, false) }
                .context("wrap CPU-upload NV12 texture in Media Foundation buffer")?;
        let sample = unsafe { MFCreateSample() }.context("create CPU-upload D3D11 sample")?;
        unsafe {
            sample
                .AddBuffer(&buffer)
                .context("attach CPU-upload DXGI surface buffer to sample")?;
            sample
                .SetSampleTime(pts)
                .context("set CPU-upload sample PTS")?;
            sample
                .SetSampleDuration(duration)
                .context("set CPU-upload sample duration")?;
        }
        surface.in_use = true;
        Ok((sample, surface_slot))
    }

    fn release_surface(&mut self, surface_slot: usize) {
        if let Some(surface) = self.surfaces.get_mut(surface_slot) {
            surface.in_use = false;
        }
    }
}

fn dxgi_adapter_for_luid(target_luid: u64) -> Result<IDXGIAdapter1> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("create DXGI factory for encoder adapter")?;
    let mut adapter_index = 0_u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("enumerate DXGI encoder adapters"),
        };
        let descriptor = unsafe { adapter.GetDesc1() }.context("describe DXGI encoder adapter")?;
        let luid = (u64::from(descriptor.AdapterLuid.HighPart as u32) << 32)
            | u64::from(descriptor.AdapterLuid.LowPart);
        if luid == target_luid {
            return Ok(adapter);
        }
        adapter_index = adapter_index.saturating_add(1);
    }
    bail!("MFT adapter LUID {target_luid:016x} was not available through DXGI")
}

impl D3D11SurfaceInput {
    fn new(
        config: &MediaFoundationEncoderConfig,
        source_texture: &RetainedD3D11Texture,
    ) -> Result<Self> {
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            source_texture.texture().GetDesc(&mut source_desc);
        }
        ensure!(
            source_desc.Width > 0 && source_desc.Height > 0,
            "captured D3D11 texture had invalid dimensions {}x{}",
            source_desc.Width,
            source_desc.Height
        );
        ensure!(
            source_desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM,
            "captured D3D11 texture format {:?} was not BGRA8",
            source_desc.Format
        );
        let device =
            unsafe { source_texture.texture().GetDevice() }.context("get D3D11 capture device")?;
        let video_device: ID3D11VideoDevice = device.cast().context("query ID3D11VideoDevice")?;
        let immediate_context =
            unsafe { device.GetImmediateContext() }.context("get D3D11 immediate context")?;
        let video_context: ID3D11VideoContext1 = immediate_context
            .cast()
            .context("query ID3D11VideoContext1")?;

        let mut reset_token = 0_u32;
        let mut device_manager = None;
        unsafe {
            MFCreateDXGIDeviceManager(&mut reset_token, &mut device_manager)
                .context("create MF DXGI device manager")?;
        }
        let device_manager =
            device_manager.context("MFCreateDXGIDeviceManager returned no manager")?;
        let device_unknown: IUnknown = device.cast().context("cast D3D11 device to IUnknown")?;
        unsafe {
            device_manager
                .ResetDevice(&device_unknown, reset_token)
                .context("bind D3D11 device to MF DXGI device manager")?;
        }

        let (processor_enumerator, processor, surfaces) = Self::create_processor_resources(
            &device,
            &video_device,
            &video_context,
            D3D11ProcessorConfig {
                source_width: source_desc.Width,
                source_height: source_desc.Height,
                output_width: config.width,
                output_height: config.height,
                fps: config.fps,
            },
        )?;
        Ok(Self {
            device,
            immediate_context,
            video_device,
            video_context,
            device_manager,
            processor_enumerator,
            processor,
            source_width: source_desc.Width,
            source_height: source_desc.Height,
            output_width: config.width,
            output_height: config.height,
            fps: config.fps,
            surfaces,
            camera_overlay: None,
        })
    }

    fn create_processor_resources(
        device: &ID3D11Device,
        video_device: &ID3D11VideoDevice,
        video_context: &ID3D11VideoContext1,
        config: D3D11ProcessorConfig,
    ) -> Result<(
        ID3D11VideoProcessorEnumerator,
        ID3D11VideoProcessor,
        Vec<D3D11SurfaceSlot>,
    )> {
        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: config.fps,
                Denominator: 1,
            },
            InputWidth: config.source_width,
            InputHeight: config.source_height,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: config.fps,
                Denominator: 1,
            },
            OutputWidth: config.output_width,
            OutputHeight: config.output_height,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let processor_enumerator =
            unsafe { video_device.CreateVideoProcessorEnumerator(&content_desc) }
                .context("create D3D11 video processor enumerator")?;
        let processor = unsafe { video_device.CreateVideoProcessor(&processor_enumerator, 0) }
            .context("create D3D11 video processor")?;
        unsafe {
            video_context.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            video_context.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
        }

        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: config.output_width,
            Height: config.output_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET
                | D3D11_BIND_SHADER_RESOURCE
                | D3D11_BIND_VIDEO_ENCODER)
                .0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let output_view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut surfaces = Vec::with_capacity(D3D11_INPUT_SURFACE_COUNT);
        for _ in 0..D3D11_INPUT_SURFACE_COUNT {
            let mut texture = None;
            unsafe {
                device
                    .CreateTexture2D(&texture_desc, None, Some(&mut texture))
                    .context("create reusable D3D11 NV12 encoder texture")?;
            }
            let texture = texture.context("CreateTexture2D returned no NV12 texture")?;
            let mut output_view = None;
            unsafe {
                video_device
                    .CreateVideoProcessorOutputView(
                        &texture,
                        &processor_enumerator,
                        &output_view_desc,
                        Some(&mut output_view),
                    )
                    .context("create D3D11 NV12 processor output view")?;
            }
            surfaces.push(D3D11SurfaceSlot {
                texture,
                output_view: output_view
                    .context("CreateVideoProcessorOutputView returned no view")?,
                in_use: false,
            });
        }
        Ok((processor_enumerator, processor, surfaces))
    }

    fn has_available_surface(&self) -> bool {
        self.surfaces.iter().any(|surface| !surface.in_use)
    }

    fn create_sample(
        &mut self,
        source_texture: &RetainedD3D11Texture,
        overlay: Option<&D3D11BgraOverlay<'_>>,
        pts: i64,
        duration: i64,
    ) -> Result<(IMFSample, usize)> {
        let source_device = unsafe { source_texture.texture().GetDevice() }
            .context("get submitted texture device")?;
        ensure!(
            source_device.as_raw() == self.device.as_raw(),
            "submitted D3D11 texture came from a different device"
        );
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            source_texture.texture().GetDesc(&mut source_desc);
        }
        ensure!(
            source_desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM,
            "submitted D3D11 texture format {:?} was not BGRA8",
            source_desc.Format
        );
        if source_desc.Width != self.source_width || source_desc.Height != self.source_height {
            ensure!(
                self.surfaces.iter().all(|surface| !surface.in_use),
                "captured D3D11 texture resized while encoder surfaces were in flight"
            );
            let (processor_enumerator, processor, surfaces) = Self::create_processor_resources(
                &self.device,
                &self.video_device,
                &self.video_context,
                D3D11ProcessorConfig {
                    source_width: source_desc.Width,
                    source_height: source_desc.Height,
                    output_width: self.output_width,
                    output_height: self.output_height,
                    fps: self.fps,
                },
            )?;
            self.processor_enumerator = processor_enumerator;
            self.processor = processor;
            self.surfaces = surfaces;
            self.source_width = source_desc.Width;
            self.source_height = source_desc.Height;
            self.camera_overlay = None;
        }
        let surface_slot = self
            .surfaces
            .iter()
            .position(|surface| !surface.in_use)
            .context("D3D11 encoder surface pool was exhausted")?;
        let input_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };
        let mut input_view = None;
        unsafe {
            self.video_device
                .CreateVideoProcessorInputView(
                    source_texture.texture(),
                    &self.processor_enumerator,
                    &input_view_desc,
                    Some(&mut input_view),
                )
                .context("create D3D11 capture processor input view")?;
        }
        let input_view =
            input_view.context("CreateVideoProcessorInputView returned no input view")?;
        let output_view = self.surfaces[surface_slot].output_view.clone();
        let screen_stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input_view)),
            ..Default::default()
        };
        let mut streams = vec![screen_stream];
        if let Some(overlay) = overlay {
            let overlay_texture = self.prepare_camera_overlay(overlay)?;
            let mut overlay_input_view = None;
            unsafe {
                self.video_device
                    .CreateVideoProcessorInputView(
                        &overlay_texture,
                        &self.processor_enumerator,
                        &input_view_desc,
                        Some(&mut overlay_input_view),
                    )
                    .context("create D3D11 camera overlay processor input view")?;
            }
            let overlay_input_view = overlay_input_view
                .context("CreateVideoProcessorInputView returned no camera overlay view")?;
            let source_rect = RECT {
                left: 0,
                top: 0,
                right: i32::try_from(overlay.width).context("camera overlay width overflowed")?,
                bottom: i32::try_from(overlay.height)
                    .context("camera overlay height overflowed")?,
            };
            let destination_rect = pixel_rect_to_win32(overlay.destination)?;
            unsafe {
                self.video_context.VideoProcessorSetStreamColorSpace1(
                    &self.processor,
                    1,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                self.video_context.VideoProcessorSetStreamSourceRect(
                    &self.processor,
                    1,
                    true,
                    Some(&source_rect),
                );
                self.video_context.VideoProcessorSetStreamDestRect(
                    &self.processor,
                    1,
                    true,
                    Some(&destination_rect),
                );
                self.video_context
                    .VideoProcessorSetStreamAlpha(&self.processor, 1, true, 1.0);
            }
            streams.push(D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(overlay_input_view)),
                ..Default::default()
            });
        }
        let blit_result = unsafe {
            self.video_context
                .VideoProcessorBlt(&self.processor, &output_view, 0, &streams)
        };
        for stream in &mut streams {
            let retained_input_view = unsafe { ManuallyDrop::take(&mut stream.pInputSurface) };
            drop(retained_input_view);
        }
        blit_result.context("compose captured BGRA textures into NV12")?;

        let surface_unknown: IUnknown = self.surfaces[surface_slot]
            .texture
            .cast()
            .context("cast NV12 texture to IUnknown")?;
        let buffer =
            unsafe { MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &surface_unknown, 0, false) }
                .context("wrap NV12 texture in Media Foundation buffer")?;
        let sample = unsafe { MFCreateSample() }.context("create D3D11 input sample")?;
        unsafe {
            sample
                .AddBuffer(&buffer)
                .context("attach DXGI surface buffer to sample")?;
            sample.SetSampleTime(pts).context("set D3D11 sample PTS")?;
            sample
                .SetSampleDuration(duration)
                .context("set D3D11 sample duration")?;
        }
        self.surfaces[surface_slot].in_use = true;
        Ok((sample, surface_slot))
    }

    fn prepare_camera_overlay(
        &mut self,
        overlay: &D3D11BgraOverlay<'_>,
    ) -> Result<ID3D11Texture2D> {
        ensure!(
            overlay.width > 0 && overlay.height > 0,
            "camera overlay had invalid dimensions {}x{}",
            overlay.width,
            overlay.height
        );
        let expected_len = usize::try_from(overlay.width)
            .ok()
            .and_then(|width| {
                usize::try_from(overlay.height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .context("camera overlay byte length overflowed")?;
        ensure!(
            overlay.bytes.len() >= expected_len,
            "camera overlay buffer was {} bytes; expected at least {expected_len}",
            overlay.bytes.len()
        );
        ensure!(
            overlay
                .destination
                .x
                .saturating_add(overlay.destination.width)
                <= self.output_width
                && overlay
                    .destination
                    .y
                    .saturating_add(overlay.destination.height)
                    <= self.output_height,
            "camera overlay destination {:?} exceeded {}x{} output",
            overlay.destination,
            self.output_width,
            self.output_height
        );

        let recreate = self
            .camera_overlay
            .as_ref()
            .is_none_or(|cached| cached.width != overlay.width || cached.height != overlay.height);
        if recreate {
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            unsafe {
                self.processor_enumerator
                    .GetVideoProcessorCaps(&mut caps)
                    .context("query D3D11 video processor capabilities")?;
            }
            ensure!(
                caps.MaxInputStreams >= 2,
                "D3D11 video processor supports {} input stream(s); screen+camera needs 2",
                caps.MaxInputStreams
            );
            ensure!(
                caps.FeatureCaps & D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ALPHA_STREAM.0 as u32 != 0,
                "D3D11 video processor does not support per-stream alpha"
            );
            let texture_desc = D3D11_TEXTURE2D_DESC {
                Width: overlay.width,
                Height: overlay.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                // Video-processor input views accept DEFAULT textures with
                // no bind flags. A shader-resource-only texture is not a
                // valid video-processor input on the NVIDIA driver.
                BindFlags: 0,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut texture = None;
            unsafe {
                self.device
                    .CreateTexture2D(&texture_desc, None, Some(&mut texture))
                    .context("create reusable D3D11 camera overlay texture")?;
            }
            self.camera_overlay = Some(D3D11CameraOverlayTexture {
                texture: texture.context("CreateTexture2D returned no camera overlay texture")?,
                width: overlay.width,
                height: overlay.height,
                sequence: u64::MAX,
            });
        }
        let cached = self
            .camera_overlay
            .as_mut()
            .context("camera overlay texture disappeared")?;
        if cached.sequence != overlay.sequence {
            let row_pitch = overlay
                .width
                .checked_mul(4)
                .context("camera overlay row pitch overflowed")?;
            unsafe {
                self.immediate_context.UpdateSubresource(
                    &cached.texture,
                    0,
                    None,
                    overlay.bytes.as_ptr().cast(),
                    row_pitch,
                    0,
                );
            }
            cached.sequence = overlay.sequence;
        }
        Ok(cached.texture.clone())
    }

    fn release_surface(&mut self, surface_slot: usize) {
        if let Some(surface) = self.surfaces.get_mut(surface_slot) {
            surface.in_use = false;
        }
    }
}

fn pixel_rect_to_win32(rect: crate::scene_geometry::PixelRect) -> Result<RECT> {
    let right = rect
        .x
        .checked_add(rect.width)
        .context("camera overlay right edge overflowed")?;
    let bottom = rect
        .y
        .checked_add(rect.height)
        .context("camera overlay bottom edge overflowed")?;
    Ok(RECT {
        left: i32::try_from(rect.x).context("camera overlay x overflowed")?,
        top: i32::try_from(rect.y).context("camera overlay y overflowed")?,
        right: i32::try_from(right).context("camera overlay right edge overflowed i32")?,
        bottom: i32::try_from(bottom).context("camera overlay bottom edge overflowed i32")?,
    })
}

#[allow(dead_code)]
impl MediaFoundationD3d11H264Encoder {
    /// Creates an NV12-only hardware encoder on the D3D11 media authority
    /// thread. `authority` is also installed into the MFT's DXGI device
    /// manager, so an encoder cannot silently use a second D3D11 device.
    pub(crate) fn new_on_media_thread(
        config: MediaFoundationEncoderConfig,
        authority: &WindowsD3d11Device,
        generation: u64,
        role: WindowsD3d11EncoderRole,
        in_flight_capacity: usize,
    ) -> Result<Self> {
        config.validate()?;
        // Validate the pure ownership contract before initializing COM/MF.
        WindowsD3d11EncoderOwnershipState::new(generation, role, in_flight_capacity)?;
        let adapter_luid = authority.adapter_luid().as_u64();
        let authority_device: IUnknown = authority
            .raw_device()
            .cast()
            .context("D3D11 authority device did not expose IUnknown")?;
        let profile = config.profile_label();
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                return Err(stage_error(
                    "d3d11-com-initialize",
                    hr,
                    "<not-enumerated>",
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                ));
            }
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(stage_windows_error(
                    "d3d11-mf-startup",
                    &error,
                    "<not-enumerated>",
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                ));
            }
        }

        let result = Self::create_after_startup(
            config.clone(),
            authority_device,
            adapter_luid,
            generation,
            role,
            in_flight_capacity,
            true,
            true,
        );
        if result.is_err() {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn create_after_startup(
        config: MediaFoundationEncoderConfig,
        authority_device: IUnknown,
        adapter_luid: u64,
        generation: u64,
        role: WindowsD3d11EncoderRole,
        in_flight_capacity: usize,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let activations = enumerate_hardware_h264_activations(&profile)?;
        let mut failures = Vec::new();
        for activation in activations {
            let identity = activation_name(&activation)
                .unwrap_or_else(|_| "<unnamed hardware H.264 MFT>".to_string());
            match unsafe { activation.ActivateObject::<IMFTransform>() } {
                Ok(transform) => match Self::configure_transform(
                    config.clone(),
                    activation,
                    transform,
                    identity.clone(),
                    authority_device.clone(),
                    adapter_luid,
                    generation,
                    role,
                    in_flight_capacity,
                    com_started,
                    mf_started,
                ) {
                    Ok(encoder) => return Ok(encoder),
                    Err(error) => failures.push(error.to_string()),
                },
                Err(error) => failures.push(
                    stage_windows_error(
                        "d3d11-activate",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                    .to_string(),
                ),
            }
        }
        bail!(
            "Media Foundation NV12 DXGI-surface probe rejected every hardware activation for {profile}: {}",
            failures.join(" | ")
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn configure_transform(
        config: MediaFoundationEncoderConfig,
        activation: IMFActivate,
        transform: IMFTransform,
        identity: String,
        authority_device: IUnknown,
        adapter_luid: u64,
        generation: u64,
        role: WindowsD3d11EncoderRole,
        in_flight_capacity: usize,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let attributes = unsafe {
            transform.GetAttributes().map_err(|error| {
                stage_windows_error(
                    "d3d11-get-transform-attributes",
                    &error,
                    &identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                )
            })?
        };
        ensure!(
            unsafe { attributes.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0) != 0,
            "Media Foundation probe stage=d3d11-async-contract encoder={identity:?} input=NV12 profile={profile}: hardware activation did not advertise an asynchronous MFT"
        );
        ensure!(
            unsafe { attributes.GetUINT32(&MF_SA_D3D11_AWARE) }.unwrap_or(0) != 0,
            "Media Foundation probe stage=d3d11-aware encoder={identity:?} input=NV12 profile={profile}: activation is not D3D11-aware"
        );
        unsafe {
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-async-unlock",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, u32::from(config.low_latency));
        }

        let mut reset_token = 0_u32;
        let mut device_manager = None;
        unsafe { MFCreateDXGIDeviceManager(&mut reset_token, &mut device_manager) }.map_err(
            |error| {
                stage_windows_error(
                    "d3d11-create-device-manager",
                    &error,
                    &identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                )
            },
        )?;
        let device_manager =
            device_manager.context("MFCreateDXGIDeviceManager returned no manager")?;
        unsafe {
            device_manager
                .ResetDevice(&authority_device, reset_token)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-reset-device-manager",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
            transform
                .ProcessMessage(
                    MFT_MESSAGE_SET_D3D_MANAGER,
                    Interface::as_raw(&device_manager) as usize,
                )
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-bind-device-manager",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
        }

        let output_type = create_video_type(
            &config,
            MFVideoFormat_H264,
            Some(eAVEncH264VProfile_High.0 as u32),
        )
        .map_err(|error| anyhow!("Media Foundation output type for {profile}: {error}"))?;
        unsafe {
            transform
                .SetOutputType(0, &output_type, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-set-output-type",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
        }
        let input_type = create_video_type(&config, MFVideoFormat_NV12, None)?;
        unsafe {
            transform.SetInputType(0, &input_type, 0).map_err(|error| {
                stage_windows_error(
                    "d3d11-set-nv12-input-type",
                    &error,
                    &identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &profile,
                )
            })?;
        }
        configure_codec_api(
            &transform,
            &config,
            &identity,
            MediaFoundationInputSubtype::Nv12,
        )?;
        let events: IMFMediaEventGenerator = transform.cast().map_err(|error| {
            stage_windows_error(
                "d3d11-event-generator",
                &error,
                &identity,
                Some(MediaFoundationInputSubtype::Nv12),
                &profile,
            )
        })?;
        unsafe {
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-begin-streaming",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-start-stream",
                        &error,
                        &identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile,
                    )
                })?;
        }

        let callback_capacity = in_flight_capacity
            .saturating_mul(TRACKED_SAMPLE_CALLBACK_QUEUE_MULTIPLIER)
            .max(1);
        let (release_sender, release_receiver) = sync_channel(callback_capacity);
        let callback_decode_failures = Arc::new(AtomicU64::new(0));
        let callback_queue_failures = Arc::new(AtomicU64::new(0));
        let release_callback: IMFAsyncCallback = ComObject::new(TrackedSampleReleaseCallback {
            sender: release_sender,
            decode_failures: Arc::clone(&callback_decode_failures),
            queue_failures: Arc::clone(&callback_queue_failures),
        })
        .into_interface();
        let sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        Ok(Self {
            config,
            activation: ManuallyDrop::new(activation),
            transform: ManuallyDrop::new(transform),
            events: ManuallyDrop::new(events),
            device_manager: ManuallyDrop::new(device_manager),
            authority_device: ManuallyDrop::new(authority_device),
            release_callback: ManuallyDrop::new(release_callback),
            release_receiver,
            callback_decode_failures,
            callback_queue_failures,
            identity,
            adapter_luid,
            ownership: WindowsD3d11EncoderOwnershipState::new(
                generation,
                role,
                in_flight_capacity,
            )?,
            sequence_header,
            submitted_pts: VecDeque::new(),
            last_output_pts: None,
            started_at: Instant::now(),
            drained: false,
            mf_started,
            com_started,
            _thread_affinity: PhantomData,
        })
    }

    pub(crate) fn identity(&self) -> &str {
        &self.identity
    }

    pub(crate) fn diagnostics(&self) -> MediaFoundationD3d11EncoderDiagnostics {
        MediaFoundationD3d11EncoderDiagnostics {
            adapter_luid: self.adapter_luid,
            d3d11_aware: true,
            dxgi_manager_bound: true,
            callback_decode_failures: self.callback_decode_failures.load(Ordering::Relaxed),
            callback_queue_failures: self.callback_queue_failures.load(Ordering::Relaxed),
            ownership: self.ownership.diagnostics(),
        }
    }

    pub(crate) fn pending_frame_count(&self) -> usize {
        self.submitted_pts.len()
    }

    /// Submits one texture-backed NV12 sample. Every rejection includes the
    /// explicit unsubmitted lease release. Once `ProcessInput` succeeds, this
    /// method drops every application-held sample/interface reference; only the
    /// IMFTrackedSample allocator callback may return that lease.
    pub(crate) fn submit_nv12_texture(
        &mut self,
        texture: &ID3D11Texture2D,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
    ) -> std::result::Result<
        MediaFoundationD3d11EncoderProgress,
        MediaFoundationD3d11SubmissionFailure,
    > {
        self.submit_nv12_texture_with_credit_policy(texture, metadata, true)
    }

    /// Reactor-safe variant of [`Self::submit_nv12_texture`]. This collects
    /// already-queued MFT events but never waits for a future NeedInput event.
    /// A missing credit is returned as an explicit unsubmitted lease so the
    /// single D3D11 media thread cannot stall capture, composition, preview, or
    /// the other encoder role.
    pub(crate) fn try_submit_nv12_texture(
        &mut self,
        texture: &ID3D11Texture2D,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
    ) -> std::result::Result<
        MediaFoundationD3d11EncoderProgress,
        MediaFoundationD3d11SubmissionFailure,
    > {
        self.submit_nv12_texture_with_credit_policy(texture, metadata, false)
    }

    fn submit_nv12_texture_with_credit_policy(
        &mut self,
        texture: &ID3D11Texture2D,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
        wait_for_future_credit: bool,
    ) -> std::result::Result<
        MediaFoundationD3d11EncoderProgress,
        MediaFoundationD3d11SubmissionFailure,
    > {
        let mut progress = MediaFoundationD3d11EncoderProgress::default();
        if self.drained {
            return Err(MediaFoundationD3d11SubmissionFailure::new(
                metadata,
                progress,
                anyhow!(
                    "Media Foundation NV12 DXGI encoder {:?} was already drained",
                    self.identity
                ),
            ));
        }
        if let Err(error) = self.validate_nv12_surface(texture) {
            return Err(MediaFoundationD3d11SubmissionFailure::new(
                metadata, progress, error,
            ));
        }
        let credit_result = if wait_for_future_credit {
            self.wait_for_input_credit(EVENT_TIMEOUT, &mut progress)
        } else {
            self.drain_release_callbacks(&mut progress);
            self.collect_available_events(&mut progress)
        };
        if let Err(error) = credit_result {
            return Err(MediaFoundationD3d11SubmissionFailure::new(
                metadata, progress, error,
            ));
        }
        if let Err(error) = self.ownership.reserve_submission(metadata) {
            return Err(MediaFoundationD3d11SubmissionFailure::from_contract(
                metadata, progress, error,
            ));
        }
        let (tracked_sample, sample) = match self.create_tracked_input_sample(texture, metadata) {
            Ok(sample) => sample,
            Err(error) => {
                let release = self
                    .ownership
                    .fail_process_input(metadata.lease_id)
                    .unwrap_or_else(|_| lease_release(metadata));
                return Err(MediaFoundationD3d11SubmissionFailure::with_release(
                    release, progress, error,
                ));
            }
        };
        let process_result = unsafe { self.transform.ProcessInput(0, &sample, 0) };
        if let Err(error) = process_result {
            let release = self
                .ownership
                .fail_process_input(metadata.lease_id)
                .unwrap_or_else(|_| lease_release(metadata));
            // The callback may run after these final application references are
            // dropped. The reservation has already been removed, so that late
            // callback is counted/ignored and cannot double-return the lease.
            drop(sample);
            drop(tracked_sample);
            self.drain_release_callbacks(&mut progress);
            return Err(MediaFoundationD3d11SubmissionFailure::with_release(
                release,
                progress,
                stage_windows_error(
                    "d3d11-process-input",
                    &error,
                    &self.identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &self.config.profile_label(),
                ),
            ));
        }
        self.ownership
            .commit_process_input(metadata.lease_id)
            .expect("successful ProcessInput must have one reserved lease");
        self.submitted_pts.push_back(metadata.input_pts_100ns);
        // This is the ownership transfer point. No sample, buffer, attributes,
        // texture, or tracked-sample COM reference remains in application code.
        drop(sample);
        drop(tracked_sample);
        self.drain_release_callbacks(&mut progress);
        Ok(progress)
    }

    pub(crate) const fn is_drained(&self) -> bool {
        self.drained
    }

    pub(crate) fn poll(&mut self) -> Result<MediaFoundationD3d11EncoderProgress> {
        let mut progress = MediaFoundationD3d11EncoderProgress::default();
        self.drain_release_callbacks(&mut progress);
        if !self.drained {
            self.collect_available_events(&mut progress)?;
        }
        self.drain_release_callbacks(&mut progress);
        Ok(progress)
    }

    pub(crate) fn drain(
        &mut self,
        timeout: Duration,
    ) -> Result<MediaFoundationD3d11EncoderProgress> {
        if self.drained {
            let mut progress = MediaFoundationD3d11EncoderProgress::default();
            self.drain_release_callbacks(&mut progress);
            return Ok(progress);
        }
        let now_micros = self.now_micros();
        self.ownership
            .begin_drain(now_micros, duration_micros(timeout))?;
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-end-of-stream",
                        &error,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &self.config.profile_label(),
                    )
                })?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-drain-command",
                        &error,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &self.config.profile_label(),
                    )
                })?;
        }

        let mut progress = MediaFoundationD3d11EncoderProgress::default();
        loop {
            self.drain_release_callbacks(&mut progress);
            while let Some(event_type) = self.next_event()? {
                if event_type == METransformHaveOutput.0 as u32 {
                    progress.encoded_frames.push(self.process_one_output()?);
                } else if event_type == METransformDrainComplete.0 as u32 {
                    self.ownership.note_transform_drain_complete()?;
                }
            }
            self.drain_release_callbacks(&mut progress);
            match self.ownership.drain_status(self.now_micros())? {
                WindowsD3d11EncoderWaitStatus::Complete => {
                    ensure!(
                        self.submitted_pts.is_empty(),
                        "Media Foundation probe stage=d3d11-drain encoder={:?} input=NV12 profile={}: transform completed with {} pending output timestamps",
                        self.identity,
                        self.config.profile_label(),
                        self.submitted_pts.len()
                    );
                    self.drained = true;
                    return Ok(progress);
                }
                WindowsD3d11EncoderWaitStatus::Pending { .. } => {
                    thread::sleep(EVENT_POLL_INTERVAL);
                }
            }
        }
    }

    /// Flushes the MFT and then waits only for tracked-sample callbacks. A
    /// timeout never force-recycles a lease retained by the transform.
    pub(crate) fn flush(
        &mut self,
        timeout: Duration,
    ) -> Result<Vec<WindowsD3d11EncoderLeaseRelease>> {
        let mut progress = MediaFoundationD3d11EncoderProgress::default();
        if self.drained {
            self.drain_release_callbacks(&mut progress);
            return Ok(progress.released_leases);
        }
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "d3d11-flush-command",
                        &error,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &self.config.profile_label(),
                    )
                })?;
        }
        self.ownership
            .begin_flush(self.now_micros(), duration_micros(timeout))?;
        loop {
            self.drain_release_callbacks(&mut progress);
            match self.ownership.flush_status(self.now_micros())? {
                WindowsD3d11EncoderWaitStatus::Complete => {
                    self.submitted_pts.clear();
                    self.drained = true;
                    return Ok(progress.released_leases);
                }
                WindowsD3d11EncoderWaitStatus::Pending { .. } => {
                    thread::sleep(EVENT_POLL_INTERVAL);
                }
            }
        }
    }

    fn validate_nv12_surface(&self, texture: &ID3D11Texture2D) -> Result<()> {
        let mut descriptor = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut descriptor) };
        validate_nv12_surface_descriptor(&self.config, &descriptor)?;
        let texture_device: ID3D11Device = unsafe { texture.GetDevice() }
            .context("NV12 encoder surface did not expose its D3D11 device")?;
        let texture_identity: IUnknown = texture_device
            .cast()
            .context("NV12 encoder surface device did not expose IUnknown")?;
        ensure!(
            Interface::as_raw(&texture_identity) == Interface::as_raw(&*self.authority_device),
            "Media Foundation probe stage=d3d11-device-identity encoder={:?} input=NV12 profile={}: surface belongs to a different D3D11 device",
            self.identity,
            self.config.profile_label()
        );
        Ok(())
    }

    fn create_tracked_input_sample(
        &self,
        texture: &ID3D11Texture2D,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
    ) -> Result<(IMFTrackedSample, IMFSample)> {
        let buffer = unsafe { MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false) }
            .context("MFCreateDXGISurfaceBuffer rejected the NV12 texture")?;
        let tracked_sample =
            unsafe { MFCreateTrackedSample() }.context("MFCreateTrackedSample failed")?;
        let sample: IMFSample = tracked_sample
            .cast()
            .context("IMFTrackedSample did not expose IMFSample")?;
        unsafe {
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(metadata.input_pts_100ns)?;
            sample.SetSampleDuration(metadata.duration_100ns)?;
        }
        let mut state = None;
        unsafe { MFCreateAttributes(&mut state, 3) }
            .context("tracked-sample state attribute creation failed")?;
        let state = state.context("MFCreateAttributes returned no tracked-sample state")?;
        unsafe {
            state.SetUINT64(&TRACKED_SAMPLE_GENERATION_KEY, metadata.generation)?;
            state.SetUINT64(&TRACKED_SAMPLE_ROLE_KEY, encoder_role_value(metadata.role))?;
            state.SetUINT64(&TRACKED_SAMPLE_LEASE_KEY, metadata.lease_id)?;
        }
        let state_unknown: IUnknown = state
            .cast()
            .context("tracked-sample attributes did not expose IUnknown")?;
        unsafe {
            tracked_sample.SetAllocator(&*self.release_callback, &state_unknown)?;
        }
        drop(state_unknown);
        drop(state);
        drop(buffer);
        Ok((tracked_sample, sample))
    }

    fn wait_for_input_credit(
        &mut self,
        timeout: Duration,
        progress: &mut MediaFoundationD3d11EncoderProgress,
    ) -> Result<()> {
        if self.ownership.has_input_credit() {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            self.drain_release_callbacks(progress);
            match self.next_event()? {
                Some(event_type) if event_type == METransformNeedInput.0 as u32 => {
                    self.ownership.note_input_credit()?;
                    return Ok(());
                }
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    progress.encoded_frames.push(self.process_one_output()?);
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        bail!(
            "Media Foundation probe stage=d3d11-need-input encoder={:?} input=NV12 profile={}: no input credit within {}ms",
            self.identity,
            self.config.profile_label(),
            timeout.as_millis()
        )
    }

    fn collect_available_events(
        &mut self,
        progress: &mut MediaFoundationD3d11EncoderProgress,
    ) -> Result<()> {
        while let Some(event_type) = self.next_event()? {
            if event_type == METransformHaveOutput.0 as u32 {
                progress.encoded_frames.push(self.process_one_output()?);
            } else if event_type == METransformNeedInput.0 as u32 {
                self.ownership.note_input_credit()?;
            }
        }
        Ok(())
    }

    fn next_event(&self) -> Result<Option<u32>> {
        let event = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(None),
            Err(error) => {
                return Err(stage_windows_error(
                    "d3d11-get-event",
                    &error,
                    &self.identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &self.config.profile_label(),
                ));
            }
        };
        let status = unsafe { event.GetStatus() }.map_err(|error| {
            stage_windows_error(
                "d3d11-event-status",
                &error,
                &self.identity,
                Some(MediaFoundationInputSubtype::Nv12),
                &self.config.profile_label(),
            )
        })?;
        if status.is_err() {
            return Err(stage_error(
                "d3d11-event-status",
                status,
                &self.identity,
                Some(MediaFoundationInputSubtype::Nv12),
                &self.config.profile_label(),
            ));
        }
        unsafe { event.GetType() }
            .map_err(|error| {
                stage_windows_error(
                    "d3d11-event-type",
                    &error,
                    &self.identity,
                    Some(MediaFoundationInputSubtype::Nv12),
                    &self.config.profile_label(),
                )
            })
            .map(Some)
    }

    fn process_one_output(&mut self) -> Result<MediaFoundationEncodedFrame> {
        let profile_label = self.config.profile_label();
        let mut renegotiations = 0_u32;
        let sample = loop {
            let stream_info =
                unsafe { self.transform.GetOutputStreamInfo(0) }.map_err(|error| {
                    stage_windows_error(
                        "d3d11-output-stream-info",
                        &error,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile_label,
                    )
                })?;
            let transform_provides_sample = stream_info.dwFlags
                & ((MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0)
                    as u32)
                != 0;
            let supplied_sample = if transform_provides_sample {
                None
            } else {
                let sample = unsafe { MFCreateSample() }?;
                let buffer = unsafe { MFCreateMemoryBuffer(stream_info.cbSize.max(1)) }?;
                unsafe { sample.AddBuffer(&buffer) }?;
                Some(sample)
            };
            let mut output_buffer = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(supplied_sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            let mut status = 0_u32;
            let process_result = unsafe {
                self.transform.ProcessOutput(
                    0,
                    std::slice::from_mut(&mut output_buffer),
                    &mut status,
                )
            };
            let sample = unsafe { ManuallyDrop::take(&mut output_buffer.pSample) };
            let _events = unsafe { ManuallyDrop::take(&mut output_buffer.pEvents) };
            match process_result {
                Ok(()) => break sample,
                Err(error)
                    if is_mf_stream_change(error.code())
                        && renegotiations < MFT_STREAM_CHANGE_MAX_RENEGOTIATIONS =>
                {
                    renegotiations += 1;
                    tracing::warn!(
                        "Media Foundation D3D11 encoder {:?} requested output-type renegotiation (attempt {renegotiations}/{}); re-selecting output type",
                        self.identity,
                        MFT_STREAM_CHANGE_MAX_RENEGOTIATIONS
                    );
                    renegotiate_mft_output_type(
                        &self.transform,
                        &self.config,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                    )?;
                }
                Err(error) => {
                    return Err(stage_windows_error(
                        "d3d11-process-output",
                        &error,
                        &self.identity,
                        Some(MediaFoundationInputSubtype::Nv12),
                        &profile_label,
                    ));
                }
            }
        };
        let sample = sample.context("Media Foundation HaveOutput event returned no sample")?;
        let pts = unsafe { sample.GetSampleTime() }.map_err(|error| {
            stage_windows_error(
                "d3d11-output-timestamp",
                &error,
                &self.identity,
                Some(MediaFoundationInputSubtype::Nv12),
                &self.config.profile_label(),
            )
        })?;
        let expected_pts = self.submitted_pts.pop_front().with_context(|| {
            format!(
                "Media Foundation D3D11 encoder {:?} produced output without a submitted timestamp",
                self.identity
            )
        })?;
        ensure!(
            pts == expected_pts,
            "Media Foundation probe stage=d3d11-timestamp-order encoder={:?} input=NV12 profile={}: expected PTS {}, got {}",
            self.identity,
            self.config.profile_label(),
            expected_pts,
            pts
        );
        if let Some(last) = self.last_output_pts {
            ensure!(
                pts > last,
                "Media Foundation probe stage=d3d11-timestamp-regression encoder={:?} input=NV12 profile={}: output PTS {} followed {}",
                self.identity,
                self.config.profile_label(),
                pts,
                last
            );
        }
        self.last_output_pts = Some(pts);
        let _ = self.ownership.note_output(pts);
        let duration = unsafe { sample.GetSampleDuration() }
            .unwrap_or_else(|_| scheduled_duration_100ns(0, self.config.fps).unwrap_or(1));
        let buffer = unsafe { sample.ConvertToContiguousBuffer() }?;
        let encoded = copy_media_buffer(&buffer)?;
        let mut bytes = normalize_annex_b(&encoded)?;
        if self.sequence_header.is_empty()
            && let Ok(output_type) = unsafe { self.transform.GetOutputCurrentType(0) }
        {
            self.sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        }
        let contains_idr = annex_b_contains_nal_type(&bytes, 5);
        if contains_idr && !annex_b_has_parameter_sets(&bytes) {
            ensure!(
                annex_b_has_parameter_sets(&self.sequence_header),
                "Media Foundation probe stage=d3d11-sequence-header encoder={:?} input=NV12 profile={}: IDR had no SPS/PPS and MF_MT_MPEG_SEQUENCE_HEADER was unusable",
                self.identity,
                self.config.profile_label()
            );
            let mut with_header = Vec::with_capacity(self.sequence_header.len() + bytes.len());
            with_header.extend_from_slice(&self.sequence_header);
            with_header.extend_from_slice(&bytes);
            bytes = with_header;
        }
        let frame_index = frame_index_from_100ns(pts, self.config.fps)?;
        Ok(MediaFoundationEncodedFrame {
            frame_index,
            pts_100ns: pts,
            duration_100ns: duration,
            bytes,
        })
    }

    fn drain_release_callbacks(&mut self, progress: &mut MediaFoundationD3d11EncoderProgress) {
        while let Ok(callback) = self.release_receiver.try_recv() {
            if let WindowsD3d11EncoderReleaseDisposition::Released(release) =
                self.ownership.release_callback(callback)
            {
                progress.released_leases.push(release);
            }
        }
    }

    fn now_micros(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_micros()).unwrap_or(u64::MAX)
    }
}

fn encoder_role_value(role: WindowsD3d11EncoderRole) -> u64 {
    match role {
        WindowsD3d11EncoderRole::Record => 1,
        WindowsD3d11EncoderRole::Stream => 2,
    }
}

fn lease_release(
    metadata: WindowsD3d11EncoderSubmissionMetadata,
) -> WindowsD3d11EncoderLeaseRelease {
    WindowsD3d11EncoderLeaseRelease {
        generation: metadata.generation,
        role: metadata.role,
        lease_id: metadata.lease_id,
    }
}

fn duration_micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn validate_nv12_surface_descriptor(
    config: &MediaFoundationEncoderConfig,
    descriptor: &D3D11_TEXTURE2D_DESC,
) -> Result<()> {
    ensure!(
        descriptor.Format == DXGI_FORMAT_NV12,
        "Media Foundation D3D11 input requires DXGI_FORMAT_NV12, got {:?}",
        descriptor.Format
    );
    ensure!(
        descriptor.Width == config.width && descriptor.Height == config.height,
        "Media Foundation D3D11 input expected {}x{}, got {}x{}",
        config.width,
        config.height,
        descriptor.Width,
        descriptor.Height
    );
    ensure!(
        descriptor.ArraySize == 1 && descriptor.MipLevels == 1 && descriptor.SampleDesc.Count == 1,
        "Media Foundation D3D11 input requires one non-multisampled 2D subresource (array={}, mips={}, samples={})",
        descriptor.ArraySize,
        descriptor.MipLevels,
        descriptor.SampleDesc.Count
    );
    Ok(())
}

fn configure_codec_api(
    transform: &IMFTransform,
    config: &MediaFoundationEncoderConfig,
    identity: &str,
    input_subtype: MediaFoundationInputSubtype,
) -> Result<()> {
    let codec_api: ICodecAPI = transform.cast().map_err(|error| {
        stage_windows_error(
            "codec-api",
            &error,
            identity,
            Some(input_subtype),
            &config.profile_label(),
        )
    })?;
    let profile = config.profile_label();
    let settings = [
        (
            &CODECAPI_AVEncCommonRealTime,
            variant_bool(true),
            "real-time",
        ),
        (
            &CODECAPI_AVEncCommonLowLatency,
            variant_bool(config.low_latency),
            "low-latency",
        ),
        (
            &CODECAPI_AVEncMPVDefaultBPictureCount,
            variant_u32(0),
            "b-frame-count",
        ),
        (
            &CODECAPI_AVEncMPVGOPSize,
            variant_u32(config.fps.saturating_mul(2)),
            "gop-size",
        ),
        (
            &CODECAPI_AVEncCommonRateControlMode,
            variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32),
            "rate-control",
        ),
        (
            &CODECAPI_AVEncCommonMeanBitRate,
            variant_u32(config.bitrate_kbps.saturating_mul(1_000)),
            "mean-bitrate",
        ),
    ];
    for (key, value, label) in settings {
        if unsafe { codec_api.IsSupported(key) }.is_ok() {
            unsafe { codec_api.SetValue(key, &value) }.map_err(|error| {
                stage_windows_error(
                    &format!("codec-api-{label}"),
                    &error,
                    identity,
                    Some(input_subtype),
                    &profile,
                )
            })?;
        }
    }
    Ok(())
}

fn variant_bool(value: bool) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BOOL,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 {
                    boolVal: VARIANT_BOOL::from(value),
                },
            }),
        },
    }
}

fn variant_u32(value: u32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_UI4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { ulVal: value },
            }),
        },
    }
}

impl Drop for MediaFoundationH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let activation = ManuallyDrop::take(&mut self.activation);
            let events = ManuallyDrop::take(&mut self.events);
            let transform = ManuallyDrop::take(&mut self.transform);
            let _ = activation.ShutdownObject();
            drop(events);
            drop(transform);
            drop(activation);
            drop(self.d3d11_input.take());
            drop(self.d3d11_cpu_upload.take());
            if self.mf_started {
                let _ = MFShutdown();
                self.mf_started = false;
            }
            if self.com_started {
                CoUninitialize();
                self.com_started = false;
            }
        }
    }
}

impl Drop for MediaFoundationD3d11H264Encoder {
    fn drop(&mut self) {
        unsafe {
            if !self.drained {
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            }
            let activation = ManuallyDrop::take(&mut self.activation);
            let events = ManuallyDrop::take(&mut self.events);
            let transform = ManuallyDrop::take(&mut self.transform);
            let device_manager = ManuallyDrop::take(&mut self.device_manager);
            let authority_device = ManuallyDrop::take(&mut self.authority_device);
            let release_callback = ManuallyDrop::take(&mut self.release_callback);
            let _ = activation.ShutdownObject();
            drop(events);
            drop(transform);

            // Transform teardown can synchronously release its final tracked
            // samples. Apply those scalar callbacks before dropping the
            // callback object; never synthesize releases for anything retained.
            let mut progress = MediaFoundationD3d11EncoderProgress::default();
            self.drain_release_callbacks(&mut progress);

            drop(activation);
            drop(device_manager);
            drop(authority_device);
            drop(release_callback);
            if self.mf_started {
                let _ = MFShutdown();
                self.mf_started = false;
            }
            if self.com_started {
                CoUninitialize();
                self.com_started = false;
            }
        }
    }
}

pub fn probe_hardware_encoder(
    config: MediaFoundationEncoderConfig,
) -> Result<MediaFoundationProbe> {
    // Iris Xe iGPUs can E_UNEXPECTED at 1080p30 / 6000 CBR (see support bundle
    // 20260826-190155Z). Retry the probe with the AI-recommended fallback
    // bitrates before we abandon hardware for CPU encoding.
    let fallback_bitrates = probe_fallback_bitrates(config.bitrate_kbps);
    let mut last_error: Option<anyhow::Error> = None;
    for &bitrate in &fallback_bitrates {
        let candidate = MediaFoundationEncoderConfig {
            bitrate_kbps: bitrate,
            ..config.clone()
        };
        match try_probe_once(candidate) {
            Ok(probe) => {
                if bitrate != config.bitrate_kbps {
                    tracing::warn!(
                        "Media Foundation hardware probe succeeded on Intel fallback bitrate {bitrate} kbps (original {} kbps rejected with E_UNEXPECTED); recording will use {bitrate} kbps for hardware",
                        config.bitrate_kbps
                    );
                }
                return Ok(probe);
            }
            Err(error) => {
                let is_e_unexpected = error.to_string().contains("HRESULT=0x8000FFFF");
                if !is_e_unexpected || bitrate == *fallback_bitrates.last().unwrap() {
                    // Either not the Intel E_UNEXPECTED case, or we've exhausted
                    // the ladder — bubble the original (or last) error up so
                    // recording.rs can fall back to software with an annotated
                    // reason.
                    if bitrate != config.bitrate_kbps {
                        tracing::warn!(
                            "Media Foundation hardware probe fallback at {bitrate} kbps also failed: {error:#}"
                        );
                    }
                    last_error = Some(error);
                    if !is_e_unexpected {
                        break;
                    }
                } else {
                    tracing::warn!(
                        "Media Foundation hardware probe at {} kbps failed with E_UNEXPECTED — retrying at {next} kbps: {error:#}",
                        bitrate,
                        next = fallback_bitrates[fallback_bitrates
                            .iter()
                            .position(|&b| b == bitrate)
                            .unwrap()
                            + 1]
                    );
                    last_error = Some(error);
                }
            }
        }
    }
    Err(last_error.unwrap())
}

fn probe_fallback_bitrates(requested: u32) -> Vec<u32> {
    // Fix 2 from the Intel report: CBR allocations at 6000 can be rejected
    // by Iris Xe MFTs. Walk down through the recommended fallbacks.
    let mut candidates = vec![requested];
    if requested >= 6000 {
        for &alt in &[5500_u32, 5000_u32] {
            if !candidates.contains(&alt) {
                candidates.push(alt);
            }
        }
    } else if requested > 5000 {
        if !candidates.contains(&5000) {
            candidates.push(5000);
        }
    }
    candidates
}

fn try_probe_once(config: MediaFoundationEncoderConfig) -> Result<MediaFoundationProbe> {
    let frame_len = config.i420_len()?;
    let mut encoder = MediaFoundationH264Encoder::new(config.clone())?;
    let identity = encoder.identity().to_string();
    let input_subtype = encoder.input_subtype();
    let mut frames = Vec::new();
    for frame_index in 0..config.fps.clamp(3, 6) as u64 {
        let mut i420 = vec![0x10; frame_len];
        let y_len = usize::try_from(u64::from(config.width) * u64::from(config.height))?;
        i420[..y_len].fill(16_u8.saturating_add(frame_index as u8));
        i420[y_len..].fill(128);
        frames.extend(encoder.encode_frame(&i420, frame_index)?);
    }
    frames.extend(encoder.drain(DRAIN_TIMEOUT)?);
    ensure!(
        !frames.is_empty(),
        "Media Foundation hardware probe produced no H.264 output for {}",
        config.profile_label()
    );
    ensure!(
        frames
            .iter()
            .any(|frame| annex_b_contains_nal_type(&frame.bytes, 5)),
        "Media Foundation hardware probe produced no IDR for {}",
        config.profile_label()
    );
    Ok(MediaFoundationProbe {
        encoder_identity: identity,
        input_subtype,
        frames,
        effective_bitrate_kbps: config.bitrate_kbps,
    })
}

fn enumerate_hardware_h264_activations(profile: &str) -> Result<Vec<IMFActivate>> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let flags = MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);
    let mut raw: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0_u32;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None,
            Some(&output),
            &mut raw,
            &mut count,
        )
        .map_err(|error| stage_windows_error("enumerate", &error, "<none>", None, profile))?;
    }
    ensure!(
        count > 0 && !raw.is_null(),
        "Media Foundation probe stage=enumerate encoder=<none> input=<unset> profile={profile}: no hardware H.264 MFT was available"
    );
    let mut activations = Vec::with_capacity(count as usize);
    unsafe {
        for slot in std::slice::from_raw_parts_mut(raw, count as usize) {
            if let Some(activation) = slot.take() {
                activations.push(activation);
            }
        }
        CoTaskMemFree(Some(raw.cast()));
    }
    Ok(activations)
}

fn activation_name(activation: &IMFActivate) -> Result<String> {
    let length = unsafe { activation.GetStringLength(&MFT_FRIENDLY_NAME_Attribute) }?;
    let mut value = vec![0_u16; length.saturating_add(1) as usize];
    unsafe { activation.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut value, None) }?;
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    Ok(String::from_utf16_lossy(&value[..end]))
}

fn activation_adapter_luid(activation: &IMFActivate) -> Result<Option<u64>> {
    let size = match unsafe { activation.GetBlobSize(&MFT_ENUM_ADAPTER_LUID) } {
        Ok(size) => size,
        Err(_) => return Ok(None),
    };
    ensure!(
        size == 8,
        "MFT_ENUM_ADAPTER_LUID contained {size} bytes instead of 8"
    );
    let mut bytes = [0_u8; 8];
    unsafe {
        activation.GetBlob(&MFT_ENUM_ADAPTER_LUID, &mut bytes, None)?;
    }
    Ok(Some(u64::from_ne_bytes(bytes)))
}

fn create_video_type(
    config: &MediaFoundationEncoderConfig,
    subtype: windows::core::GUID,
    profile: Option<u32>,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType> {
    let media_type = unsafe { MFCreateMediaType() }?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(
            &MF_MT_FRAME_SIZE,
            (u64::from(config.width) << 32) | u64::from(config.height),
        )?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(config.fps) << 32) | 1)?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        media_type.SetUINT32(
            &MF_MT_AVG_BITRATE,
            config.bitrate_kbps.saturating_mul(1_000),
        )?;
        media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 0)?;
        media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, u32::from(profile.is_none()))?;
        if let Some(profile) = profile {
            media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, profile)?;
            media_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, config.fps.saturating_mul(2))?;
        }
    }
    Ok(media_type)
}

fn create_input_sample(
    i420: &[u8],
    input_subtype: MediaFoundationInputSubtype,
    width: u32,
    height: u32,
    pts: i64,
    duration: i64,
) -> Result<IMFSample> {
    let buffer = match input_subtype {
        MediaFoundationInputSubtype::I420 => create_i420_input_buffer(i420)?,
        MediaFoundationInputSubtype::Nv12 => create_nv12_input_buffer(i420, width, height)?,
    };
    let sample = unsafe { MFCreateSample() }?;
    unsafe {
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(pts)?;
        sample.SetSampleDuration(duration)?;
    }
    Ok(sample)
}

fn create_i420_input_buffer(i420: &[u8]) -> Result<IMFMediaBuffer> {
    let len = u32::try_from(i420.len()).context("Media Foundation input frame exceeded u32")?;
    let buffer = unsafe { MFCreateMemoryBuffer(len) }?;
    let mut target = ptr::null_mut();
    let mut max_len = 0_u32;
    unsafe {
        buffer.Lock(&mut target, Some(&mut max_len), None)?;
        if max_len < len {
            let _ = buffer.Unlock();
            bail!("Media Foundation input buffer was smaller than requested");
        }
        std::slice::from_raw_parts_mut(target, i420.len()).copy_from_slice(i420);
        buffer.Unlock()?;
        buffer.SetCurrentLength(len)?;
    }
    Ok(buffer)
}

fn create_nv12_input_buffer(i420: &[u8], width: u32, height: u32) -> Result<IMFMediaBuffer> {
    ensure!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "NV12 input requires even dimensions"
    );
    let buffer = unsafe { MFCreate2DMediaBuffer(width, height, MFVideoFormat_NV12.data1, false) }?;
    let buffer_2d: IMF2DBuffer2 = buffer.cast()?;
    let mut scanline = ptr::null_mut();
    let mut pitch = 0_i32;
    let mut buffer_start = ptr::null_mut();
    let mut buffer_len = 0_u32;
    unsafe {
        buffer_2d.Lock2DSize(
            MF2DBuffer_LockFlags_Write,
            &mut scanline,
            &mut pitch,
            &mut buffer_start,
            &mut buffer_len,
        )?;
        let write_result = (|| {
            ensure!(
                pitch > 0,
                "NV12 input buffer returned non-positive pitch {pitch}"
            );
            ensure!(
                scanline == buffer_start,
                "NV12 input buffer returned an unexpected top-row offset"
            );
            let pitch = usize::try_from(pitch)?;
            let height = usize::try_from(height)?;
            let required_len = pitch
                .checked_mul(height + height / 2)
                .context("NV12 strided input buffer size overflowed")?;
            ensure!(
                required_len <= buffer_len as usize,
                "NV12 input buffer length {buffer_len} was smaller than required {required_len}"
            );
            let target = std::slice::from_raw_parts_mut(buffer_start, required_len);
            i420_to_nv12_strided(i420, width, height as u32, pitch, target)
        })();
        if let Err(error) = write_result {
            let _ = buffer_2d.Unlock2D();
            return Err(error);
        }
        buffer_2d.Unlock2D()?;
        buffer.SetCurrentLength(buffer_2d.GetContiguousLength()?)?;
    }
    Ok(buffer)
}

fn copy_media_buffer(buffer: &IMFMediaBuffer) -> Result<Vec<u8>> {
    let len = unsafe { buffer.GetCurrentLength() }?;
    let mut source = ptr::null_mut();
    unsafe {
        buffer.Lock(&mut source, None, None)?;
        let bytes = std::slice::from_raw_parts(source, len as usize).to_vec();
        buffer.Unlock()?;
        Ok(bytes)
    }
}

fn media_type_sequence_header(
    media_type: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> Result<Vec<u8>> {
    let size = unsafe { media_type.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) }?;
    let mut header = vec![0; size as usize];
    unsafe { media_type.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut header, None) }?;
    normalize_annex_b(&header)
}

fn scheduled_time_100ns(frame_index: u64, fps: u32) -> Result<i64> {
    ensure!(fps > 0, "scheduled Media Foundation FPS must be positive");
    let value = u128::from(frame_index)
        .checked_mul(10_000_000)
        .context("Media Foundation timestamp overflowed")?
        / u128::from(fps);
    i64::try_from(value).context("Media Foundation timestamp exceeded i64")
}

fn scheduled_duration_100ns(frame_index: u64, fps: u32) -> Result<i64> {
    Ok(scheduled_time_100ns(frame_index.saturating_add(1), fps)?
        - scheduled_time_100ns(frame_index, fps)?)
}

fn frame_index_from_100ns(pts: i64, fps: u32) -> Result<u64> {
    ensure!(pts >= 0, "Media Foundation output PTS was negative");
    let value = u128::try_from(pts)?
        .checked_mul(u128::from(fps))
        .context("Media Foundation frame-index conversion overflowed")?
        / 10_000_000;
    u64::try_from(value).context("Media Foundation frame index exceeded u64")
}

fn i420_to_nv12_strided(
    i420: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
    output: &mut [u8],
) -> Result<()> {
    ensure!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "NV12 conversion requires even dimensions"
    );
    let y_len = usize::try_from(u64::from(width) * u64::from(height))?;
    let chroma_len = y_len / 4;
    ensure!(
        i420.len() == y_len + chroma_len * 2,
        "I420/NV12 conversion input length mismatch"
    );
    let width = usize::try_from(width)?;
    let height = usize::try_from(height)?;
    ensure!(
        pitch >= width,
        "I420/NV12 conversion pitch {pitch} was smaller than width {width}"
    );
    let output_len = pitch
        .checked_mul(height + height / 2)
        .context("I420/NV12 conversion output size overflowed")?;
    ensure!(
        output.len() == output_len,
        "I420/NV12 conversion output length mismatch"
    );
    for row in 0..height {
        let source_start = row * width;
        let target_start = row * pitch;
        output[target_start..target_start + width]
            .copy_from_slice(&i420[source_start..source_start + width]);
    }
    let u = &i420[y_len..y_len + chroma_len];
    let v = &i420[y_len + chroma_len..];
    let chroma_width = width / 2;
    let uv_offset = pitch * height;
    for row in 0..height / 2 {
        let source_start = row * chroma_width;
        let target_start = uv_offset + row * pitch;
        for column in 0..chroma_width {
            output[target_start + column * 2] = u[source_start + column];
            output[target_start + column * 2 + 1] = v[source_start + column];
        }
    }
    Ok(())
}

fn normalize_annex_b(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]) {
        return Ok(bytes.to_vec());
    }
    let mut input = bytes;
    let mut output = Vec::with_capacity(bytes.len().saturating_add(16));
    while !input.is_empty() {
        ensure!(
            input.len() >= 4,
            "truncated length-prefixed H.264 access unit"
        );
        let len = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
        input = &input[4..];
        ensure!(
            len > 0 && input.len() >= len,
            "invalid length-prefixed H.264 NAL size {len}"
        );
        output.extend_from_slice(&[0, 0, 0, 1]);
        output.extend_from_slice(&input[..len]);
        input = &input[len..];
    }
    ensure!(!output.is_empty(), "empty H.264 access unit");
    Ok(output)
}

fn annex_b_nal_types(bytes: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut index = 0;
    while index + 3 < bytes.len() {
        let start_len = if bytes[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let header = index + start_len;
        if header < bytes.len() {
            types.push(bytes[header] & 0x1f);
        }
        index = header.saturating_add(1);
    }
    types
}

fn annex_b_contains_nal_type(bytes: &[u8], nal_type: u8) -> bool {
    annex_b_nal_types(bytes).contains(&nal_type)
}

fn annex_b_has_parameter_sets(bytes: &[u8]) -> bool {
    let types = annex_b_nal_types(bytes);
    types.contains(&7) && types.contains(&8)
}

fn stage_windows_error(
    stage: &str,
    error: &windows::core::Error,
    identity: &str,
    subtype: Option<MediaFoundationInputSubtype>,
    profile: &str,
) -> anyhow::Error {
    stage_error(stage, error.code(), identity, subtype, profile)
}

fn stage_error(
    stage: &str,
    hresult: windows::core::HRESULT,
    identity: &str,
    subtype: Option<MediaFoundationInputSubtype>,
    profile: &str,
) -> anyhow::Error {
    anyhow!(
        "Media Foundation probe stage={stage} HRESULT=0x{:08X}{} encoder={identity:?} input={} profile={profile}",
        hresult.0 as u32,
        mf_hresult_annotation(hresult)
            .map(|annotation| format!(" ({annotation})"))
            .unwrap_or_default(),
        subtype.map_or("<unset>", MediaFoundationInputSubtype::label)
    )
}

/// Intel iGPU MFTs report `MF_E_TRANSFORM_STREAM_CHANGE` on their first
/// `ProcessOutput` calls while they settle the negotiated output type; NVIDIA
/// MFTs never do. The condition means "renegotiate and retry", not failure —
/// treating it as fatal is why Iris Xe machines fell back to CPU encoding.
fn is_mf_stream_change(hresult: windows::core::HRESULT) -> bool {
    hresult == MF_E_TRANSFORM_STREAM_CHANGE
}

/// Bounded number of output-type renegotiations per `ProcessOutput` attempt.
const MFT_STREAM_CHANGE_MAX_RENEGOTIATIONS: u32 = 2;

/// Human-facing annotations for the Media Foundation HRESULTs an operator can
/// act on. Unknown codes return `None` so logs stay free of guesses.
fn mf_hresult_annotation(hresult: windows::core::HRESULT) -> Option<&'static str> {
    if is_mf_stream_change(hresult) {
        Some(
            "encoder requested output-type renegotiation (MF_E_TRANSFORM_STREAM_CHANGE; common on Intel iGPU MFTs)",
        )
    } else if hresult.0 as u32 == 0x8000FFFF {
        Some(
            "unexpected encoder failure (E_UNEXPECTED; Intel Quick Sync via WMF rejected the 1080p30 / bitrate parameters — try lower bitrate, VBR, or the native QSV encoder)",
        )
    } else {
        None
    }
}

/// Answers a `MF_E_TRANSFORM_STREAM_CHANGE` report by re-selecting the
/// encoder's own available output type, falling back to the configured type
/// when the MFT refuses to advertise one.
#[allow(clippy::too_many_arguments)]
fn renegotiate_mft_output_type(
    transform: &IMFTransform,
    config: &MediaFoundationEncoderConfig,
    identity: &str,
    subtype: Option<MediaFoundationInputSubtype>,
) -> Result<()> {
    let profile = config.profile_label();
    let advertised = unsafe { transform.GetOutputAvailableType(0, 0) };
    match advertised {
        Ok(media_type) => unsafe { transform.SetOutputType(0, &media_type, 0) }.map_err(|error| {
            stage_windows_error(
                "renegotiate-set-output-type",
                &error,
                identity,
                subtype,
                &profile,
            )
        }),
        Err(_) => {
            let output_type = create_video_type(
                config,
                MFVideoFormat_H264,
                Some(eAVEncH264VProfile_High.0 as u32),
            )
            .map_err(|error| anyhow!("Media Foundation output type for {profile}: {error}"))?;
            unsafe { transform.SetOutputType(0, &output_type, 0) }.map_err(|error| {
                stage_windows_error(
                    "renegotiate-configured-output-type",
                    &error,
                    identity,
                    subtype,
                    &profile,
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_change_hresult_is_classified_as_renegotiation() {
        assert!(is_mf_stream_change(MF_E_TRANSFORM_STREAM_CHANGE));
        // MF_E_TRANSFORM_NEED_MORE_INPUT (0xC00D6D62) is a different condition.
        assert!(!is_mf_stream_change(windows::core::HRESULT(
            0xC00D6D62_u32 as i32
        )));
        assert!(!is_mf_stream_change(windows::core::HRESULT(0)));
    }

    #[test]
    fn hresult_annotations_name_only_known_codes() {
        let annotation = mf_hresult_annotation(MF_E_TRANSFORM_STREAM_CHANGE)
            .expect("stream change must be annotated");
        assert!(annotation.contains("MF_E_TRANSFORM_STREAM_CHANGE"));
        assert!(annotation.contains("Intel iGPU"));
        let e_unexpected = mf_hresult_annotation(windows::core::HRESULT(0x8000FFFF_u32 as i32))
            .expect("E_UNEXPECTED must be annotated");
        assert!(e_unexpected.contains("E_UNEXPECTED"));
        assert_eq!(mf_hresult_annotation(windows::core::HRESULT(0)), None);
    }

    #[test]
    fn probe_fallback_bitrates_cover_intel_recommendations() {
        assert_eq!(probe_fallback_bitrates(6000), vec![6000, 5500, 5000]);
        assert_eq!(probe_fallback_bitrates(5500), vec![5500, 5000]);
        assert_eq!(probe_fallback_bitrates(5000), vec![5000]);
        assert_eq!(probe_fallback_bitrates(4000), vec![4000]);
    }

    #[test]
    fn scheduled_timestamps_do_not_regress_at_fractional_100ns_intervals() {
        let values = (0..120)
            .map(|index| scheduled_time_100ns(index, 60).unwrap())
            .collect::<Vec<_>>();
        assert!(values.windows(2).all(|pair| pair[1] > pair[0]));
        assert_eq!(values[60], 10_000_000);
    }

    #[test]
    fn converts_i420_chroma_to_nv12_interleaving() {
        let input = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let mut output = [0; 12];
        i420_to_nv12_strided(&input, 4, 2, 4, &mut output).unwrap();
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
    }

    #[test]
    fn converts_i420_into_strided_nv12_rows_without_touching_padding() {
        let input = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let mut output = [0xff; 24];
        i420_to_nv12_strided(&input, 4, 2, 8, &mut output).unwrap();
        assert_eq!(&output[..8], &[1, 2, 3, 4, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(&output[8..16], &[5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(&output[16..], &[10, 20, 11, 21, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn rejects_an_incorrect_strided_nv12_output_length() {
        let input = [1, 2, 3, 4, 5, 6];
        let mut output = [0; 11];
        let error = i420_to_nv12_strided(&input, 2, 2, 4, &mut output).unwrap_err();
        assert!(error.to_string().contains("output length mismatch"));
    }

    #[test]
    fn normalizes_length_prefixed_access_units_and_finds_parameter_sets() {
        let avcc = [
            0, 0, 0, 2, 0x67, 1, 0, 0, 0, 2, 0x68, 2, 0, 0, 0, 2, 0x65, 3,
        ];
        let annex_b = normalize_annex_b(&avcc).unwrap();
        assert!(annex_b_has_parameter_sets(&annex_b));
        assert!(annex_b_contains_nal_type(&annex_b, 5));
    }

    #[test]
    fn windows_d3d11_encoder_surface_descriptor_is_nv12_only() {
        let config = MediaFoundationEncoderConfig {
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 9_000,
            low_latency: true,
        };
        let mut descriptor = D3D11_TEXTURE2D_DESC {
            Width: 1920,
            Height: 1080,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            ..D3D11_TEXTURE2D_DESC::default()
        };
        descriptor.SampleDesc.Count = 1;
        validate_nv12_surface_descriptor(&config, &descriptor).expect("valid NV12 surface");
        descriptor.Format = windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
        assert!(validate_nv12_surface_descriptor(&config, &descriptor).is_err());
    }

    #[test]
    fn windows_d3d11_encoder_gpu_surface_api_is_separate_from_i420_bytes() {
        let _create: fn(
            MediaFoundationEncoderConfig,
            &WindowsD3d11Device,
            u64,
            WindowsD3d11EncoderRole,
            usize,
        ) -> Result<MediaFoundationD3d11H264Encoder> =
            MediaFoundationD3d11H264Encoder::new_on_media_thread;
        let _submit: fn(
            &mut MediaFoundationD3d11H264Encoder,
            &ID3D11Texture2D,
            WindowsD3d11EncoderSubmissionMetadata,
        ) -> std::result::Result<
            MediaFoundationD3d11EncoderProgress,
            MediaFoundationD3d11SubmissionFailure,
        > = MediaFoundationD3d11H264Encoder::submit_nv12_texture;
        let _i420: fn(
            &mut MediaFoundationH264Encoder,
            &[u8],
            u64,
        ) -> Result<Vec<MediaFoundationEncodedFrame>> = MediaFoundationH264Encoder::encode_frame;
    }

    #[test]
    fn windows_d3d11_encoder_tracked_callback_keys_and_roles_are_unambiguous() {
        assert_ne!(TRACKED_SAMPLE_GENERATION_KEY, TRACKED_SAMPLE_ROLE_KEY);
        assert_ne!(TRACKED_SAMPLE_GENERATION_KEY, TRACKED_SAMPLE_LEASE_KEY);
        assert_ne!(TRACKED_SAMPLE_ROLE_KEY, TRACKED_SAMPLE_LEASE_KEY);
        assert_ne!(
            encoder_role_value(WindowsD3d11EncoderRole::Record),
            encoder_role_value(WindowsD3d11EncoderRole::Stream)
        );
    }
}
