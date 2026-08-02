use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};

const WINDOWS_DXGI_SCREEN_PREFIX: &str = "screen:dxgi:";
const D3D11_MAX_TEXTURE_DIMENSION: u32 = 16_384;
const D3D11_MAX_TEXTURES_PER_FORMAT: usize = 8;
const D3D11_MAX_MEDIA_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct DxgiAdapterLuid(u64);

impl DxgiAdapterLuid {
    pub(crate) const fn from_u64(value: u64) -> Self {
        Self(value)
    }

    pub(crate) const fn as_u64(self) -> u64 {
        self.0
    }
}

impl fmt::Display for DxgiAdapterLuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsDxgiOutputSelection {
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) output_index: u32,
}

impl WindowsDxgiOutputSelection {
    pub(crate) fn parse(screen_id: &str) -> Result<Self, WindowsD3d11Error> {
        let value = screen_id
            .strip_prefix(WINDOWS_DXGI_SCREEN_PREFIX)
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidScreenId,
                    "screen ID must use the screen:dxgi: namespace",
                )
            })?;
        let (adapter_luid, output_index) = value.rsplit_once(':').ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                "screen ID must contain an adapter LUID and output index",
            )
        })?;
        if adapter_luid.len() != 16
            || !adapter_luid
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                "adapter LUID must be exactly 16 lowercase hexadecimal digits",
            ));
        }
        let adapter_luid_value = u64::from_str_radix(adapter_luid, 16).map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                format!("adapter LUID could not be parsed: {error}"),
            )
        })?;
        if output_index.is_empty()
            || !output_index.bytes().all(|byte| byte.is_ascii_digit())
            || (output_index.len() > 1 && output_index.starts_with('0'))
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                "output index must be canonical unsigned decimal",
            ));
        }
        let output_index = output_index.parse::<u32>().map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                format!("output index could not be parsed: {error}"),
            )
        })?;
        let selection = Self {
            adapter_luid: DxgiAdapterLuid::from_u64(adapter_luid_value),
            output_index,
        };
        if selection.screen_id() != screen_id {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidScreenId,
                "screen ID is not in canonical DXGI form",
            ));
        }
        Ok(selection)
    }

    pub(crate) fn screen_id(self) -> String {
        format!(
            "{WINDOWS_DXGI_SCREEN_PREFIX}{}:{}",
            self.adapter_luid, self.output_index
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum WindowsD3d11TextureFormat {
    Bgra8Unorm,
    Nv12,
}

impl WindowsD3d11TextureFormat {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Bgra8Unorm => "bgra8-unorm",
            Self::Nv12 => "nv12",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TextureDimensions {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl WindowsD3d11TextureDimensions {
    fn validate(width: u32, height: u32) -> Result<Self, WindowsD3d11Error> {
        if width == 0 || height == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                "texture dimensions must be non-zero",
            ));
        }
        if width > D3D11_MAX_TEXTURE_DIMENSION || height > D3D11_MAX_TEXTURE_DIMENSION {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                format!(
                    "texture dimensions {width}x{height} exceed the D3D11 2D limit of {D3D11_MAX_TEXTURE_DIMENSION}"
                ),
            ));
        }
        Ok(Self { width, height })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11BgraTextureDescriptor {
    dimensions: WindowsD3d11TextureDimensions,
}

impl WindowsD3d11BgraTextureDescriptor {
    pub(crate) fn new(width: u32, height: u32) -> Result<Self, WindowsD3d11Error> {
        Ok(Self {
            dimensions: WindowsD3d11TextureDimensions::validate(width, height)?,
        })
    }

    pub(crate) const fn dimensions(self) -> WindowsD3d11TextureDimensions {
        self.dimensions
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11Nv12TextureDescriptor {
    dimensions: WindowsD3d11TextureDimensions,
}

impl WindowsD3d11Nv12TextureDescriptor {
    pub(crate) fn new(width: u32, height: u32) -> Result<Self, WindowsD3d11Error> {
        let dimensions = WindowsD3d11TextureDimensions::validate(width, height)?;
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                "NV12 texture dimensions must both be even",
            ));
        }
        Ok(Self { dimensions })
    }

    pub(crate) const fn dimensions(self) -> WindowsD3d11TextureDimensions {
        self.dimensions
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TexturePoolConfig {
    /// Desktop-capture BGRA resources.
    pub(crate) bgra: WindowsD3d11BgraTextureDescriptor,
    pub(crate) bgra_slots: usize,
    /// Primary encoded NV12 resources.
    pub(crate) nv12: WindowsD3d11Nv12TextureDescriptor,
    pub(crate) nv12_slots: usize,
    /// Independently sized compositor-preview resources. `None` preserves the
    /// legacy single-BGRA-dimension constructor.
    preview_bgra: Option<WindowsD3d11BgraTextureDescriptor>,
    preview_bgra_slots: usize,
    /// Independently sized auxiliary encoded resources.
    auxiliary_nv12: Option<WindowsD3d11Nv12TextureDescriptor>,
    auxiliary_nv12_slots: usize,
}

impl WindowsD3d11TexturePoolConfig {
    pub(crate) fn new(
        bgra: WindowsD3d11BgraTextureDescriptor,
        bgra_slots: usize,
        nv12: WindowsD3d11Nv12TextureDescriptor,
        nv12_slots: usize,
    ) -> Result<Self, WindowsD3d11Error> {
        validate_pool_size("BGRA", bgra_slots)?;
        validate_pool_size("NV12", nv12_slots)?;
        Ok(Self {
            bgra,
            bgra_slots,
            nv12,
            nv12_slots,
            preview_bgra: None,
            preview_bgra_slots: 0,
            auxiliary_nv12: None,
            auxiliary_nv12_slots: 0,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn dimension_keyed(
        capture_bgra: WindowsD3d11BgraTextureDescriptor,
        capture_bgra_slots: usize,
        preview_bgra: WindowsD3d11BgraTextureDescriptor,
        preview_bgra_slots: usize,
        primary_nv12: WindowsD3d11Nv12TextureDescriptor,
        primary_nv12_slots: usize,
        auxiliary_nv12: Option<(WindowsD3d11Nv12TextureDescriptor, usize)>,
    ) -> Result<Self, WindowsD3d11Error> {
        validate_pool_size("capture BGRA", capture_bgra_slots)?;
        validate_pool_size("preview BGRA", preview_bgra_slots)?;
        validate_pool_size("primary NV12", primary_nv12_slots)?;
        let (auxiliary_nv12, auxiliary_nv12_slots) = match auxiliary_nv12 {
            Some((descriptor, slots)) => {
                validate_pool_size("auxiliary NV12", slots)?;
                (Some(descriptor), slots)
            }
            None => (None, 0),
        };
        validate_combined_pool_size("BGRA", capture_bgra_slots, preview_bgra_slots)?;
        validate_combined_pool_size("NV12", primary_nv12_slots, auxiliary_nv12_slots)?;
        Ok(Self {
            bgra: capture_bgra,
            bgra_slots: capture_bgra_slots,
            nv12: primary_nv12,
            nv12_slots: primary_nv12_slots,
            preview_bgra: Some(preview_bgra),
            preview_bgra_slots,
            auxiliary_nv12,
            auxiliary_nv12_slots,
        })
    }

    fn buckets(self) -> Vec<WindowsD3d11TexturePoolBucket> {
        let mut buckets = Vec::with_capacity(4);
        add_pool_bucket(
            &mut buckets,
            WindowsD3d11TextureFormat::Bgra8Unorm,
            self.bgra.dimensions(),
            self.bgra_slots,
        );
        if let Some(preview) = self.preview_bgra {
            add_pool_bucket(
                &mut buckets,
                WindowsD3d11TextureFormat::Bgra8Unorm,
                preview.dimensions(),
                self.preview_bgra_slots,
            );
        }
        add_pool_bucket(
            &mut buckets,
            WindowsD3d11TextureFormat::Nv12,
            self.nv12.dimensions(),
            self.nv12_slots,
        );
        if let Some(auxiliary) = self.auxiliary_nv12 {
            add_pool_bucket(
                &mut buckets,
                WindowsD3d11TextureFormat::Nv12,
                auxiliary.dimensions(),
                self.auxiliary_nv12_slots,
            );
        }
        buckets
    }

    fn total_slots(self) -> usize {
        self.buckets().iter().map(|bucket| bucket.slots).sum()
    }

    fn capture_bgra_dimensions(self) -> WindowsD3d11TextureDimensions {
        self.bgra.dimensions()
    }

    fn preview_bgra_dimensions(self) -> WindowsD3d11TextureDimensions {
        self.preview_bgra
            .map(WindowsD3d11BgraTextureDescriptor::dimensions)
            .unwrap_or_else(|| self.bgra.dimensions())
    }

    fn slot_capacity(
        self,
        format: WindowsD3d11TextureFormat,
        dimensions: WindowsD3d11TextureDimensions,
    ) -> usize {
        self.buckets()
            .into_iter()
            .find(|bucket| bucket.format == format && bucket.dimensions == dimensions)
            .map(|bucket| bucket.slots)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsD3d11TexturePoolBucket {
    format: WindowsD3d11TextureFormat,
    dimensions: WindowsD3d11TextureDimensions,
    slots: usize,
}

fn add_pool_bucket(
    buckets: &mut Vec<WindowsD3d11TexturePoolBucket>,
    format: WindowsD3d11TextureFormat,
    dimensions: WindowsD3d11TextureDimensions,
    slots: usize,
) {
    if let Some(bucket) = buckets
        .iter_mut()
        .find(|bucket| bucket.format == format && bucket.dimensions == dimensions)
    {
        bucket.slots += slots;
    } else {
        buckets.push(WindowsD3d11TexturePoolBucket {
            format,
            dimensions,
            slots,
        });
    }
}

fn validate_pool_size(label: &str, slots: usize) -> Result<(), WindowsD3d11Error> {
    if !(1..=D3D11_MAX_TEXTURES_PER_FORMAT).contains(&slots) {
        return Err(WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!(
                "{label} texture pool size must be between 1 and {D3D11_MAX_TEXTURES_PER_FORMAT}"
            ),
        ));
    }
    Ok(())
}

fn validate_combined_pool_size(
    label: &str,
    first: usize,
    second: usize,
) -> Result<(), WindowsD3d11Error> {
    let combined = first.checked_add(second).ok_or_else(|| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!("{label} texture pool size overflowed"),
        )
    })?;
    if combined > D3D11_MAX_TEXTURES_PER_FORMAT {
        return Err(WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!(
                "combined {label} texture pool size must not exceed {D3D11_MAX_TEXTURES_PER_FORMAT}"
            ),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11ErrorCode {
    InvalidScreenId,
    AdapterNotFound,
    OutputNotFound,
    SoftwareAdapter,
    ComInitializationFailed,
    DeviceCreationFailed,
    FenceUnavailable,
    InvalidTextureDescriptor,
    TextureCreationFailed,
    TexturePoolExhausted,
    FenceTimelineViolation,
    AdapterMismatch,
    GenerationClosing,
    GenerationExhausted,
    StaleGeneration,
    InvalidLease,
    RoleNotHeld,
    CommandQueueFull,
    CommandChannelClosed,
    ResponseTimeout,
    CaptureUnavailable,
    CompositorUnavailable,
    EncoderUnavailable,
    EncoderBackpressure,
    UnsupportedCapability,
    DeviceLost,
}

impl WindowsD3d11ErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidScreenId => "d3d11-invalid-screen-id",
            Self::AdapterNotFound => "d3d11-adapter-not-found",
            Self::OutputNotFound => "d3d11-output-not-found",
            Self::SoftwareAdapter => "d3d11-software-adapter",
            Self::ComInitializationFailed => "d3d11-com-initialization-failed",
            Self::DeviceCreationFailed => "d3d11-device-creation-failed",
            Self::FenceUnavailable => "d3d11-fence-unavailable",
            Self::InvalidTextureDescriptor => "d3d11-invalid-texture-descriptor",
            Self::TextureCreationFailed => "d3d11-texture-creation-failed",
            Self::TexturePoolExhausted => "d3d11-texture-pool-exhausted",
            Self::FenceTimelineViolation => "d3d11-fence-timeline-violation",
            Self::AdapterMismatch => "d3d11-adapter-mismatch",
            Self::GenerationClosing => "d3d11-generation-closing",
            Self::GenerationExhausted => "d3d11-generation-exhausted",
            Self::StaleGeneration => "d3d11-stale-generation",
            Self::InvalidLease => "d3d11-invalid-lease",
            Self::RoleNotHeld => "d3d11-role-not-held",
            Self::CommandQueueFull => "d3d11-command-queue-full",
            Self::CommandChannelClosed => "d3d11-command-channel-closed",
            Self::ResponseTimeout => "d3d11-response-timeout",
            Self::CaptureUnavailable => "d3d11-capture-unavailable",
            Self::CompositorUnavailable => "d3d11-compositor-unavailable",
            Self::EncoderUnavailable => "d3d11-encoder-unavailable",
            Self::EncoderBackpressure => "d3d11-encoder-backpressure",
            Self::UnsupportedCapability => "d3d11-unsupported-capability",
            Self::DeviceLost => "d3d11-device-lost",
        }
    }
}

impl fmt::Display for WindowsD3d11ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {detail}")]
pub(crate) struct WindowsD3d11Error {
    pub(crate) code: WindowsD3d11ErrorCode,
    pub(crate) detail: String,
}

impl WindowsD3d11Error {
    pub(crate) fn new(code: WindowsD3d11ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum WindowsD3d11MediaRole {
    Compositor,
    Preview,
    Record,
    Stream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct WindowsD3d11TextureLeaseId(u64);

impl WindowsD3d11TextureLeaseId {
    pub(crate) const fn from_u64(value: u64) -> Self {
        Self(value)
    }

    pub(crate) const fn as_u64(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct WindowsD3d11TextureSlotId(u16);

impl WindowsD3d11TextureSlotId {
    pub(crate) const fn as_u16(self) -> u16 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11SynchronizationToken {
    pub(crate) generation: u64,
    pub(crate) fence_value: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ProducerTextureLease {
    pub(crate) generation: u64,
    pub(crate) lease_id: WindowsD3d11TextureLeaseId,
    pub(crate) slot_id: WindowsD3d11TextureSlotId,
    pub(crate) format: WindowsD3d11TextureFormat,
    pub(crate) dimensions: WindowsD3d11TextureDimensions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PublishedTextureLease {
    pub(crate) generation: u64,
    pub(crate) lease_id: WindowsD3d11TextureLeaseId,
    pub(crate) slot_id: WindowsD3d11TextureSlotId,
    pub(crate) format: WindowsD3d11TextureFormat,
    pub(crate) dimensions: WindowsD3d11TextureDimensions,
    pub(crate) synchronization: WindowsD3d11SynchronizationToken,
    pub(crate) consumers: BTreeSet<WindowsD3d11MediaRole>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11LeaseRelease {
    pub(crate) generation: u64,
    pub(crate) lease_id: WindowsD3d11TextureLeaseId,
    pub(crate) role: WindowsD3d11MediaRole,
}

#[derive(Clone)]
pub(crate) struct WindowsD3d11TextureLeaseReleaseSender {
    sender: SyncSender<WindowsD3d11LeaseRelease>,
    wake_event: usize,
    failed_releases: Arc<AtomicU64>,
}

impl fmt::Debug for WindowsD3d11TextureLeaseReleaseSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsD3d11TextureLeaseReleaseSender")
            .field("bounded", &true)
            .field("failed_releases", &self.failed_release_count())
            .finish()
    }
}

impl WindowsD3d11TextureLeaseReleaseSender {
    pub(crate) fn bounded(
        capacity: usize,
    ) -> Result<(Self, Receiver<WindowsD3d11LeaseRelease>), WindowsD3d11Error> {
        if !(1..=D3D11_MAX_MEDIA_QUEUE_CAPACITY).contains(&capacity) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                format!(
                    "lease release queue capacity must be between 1 and {D3D11_MAX_MEDIA_QUEUE_CAPACITY}"
                ),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(capacity);
        Ok((
            Self {
                sender,
                wake_event: 0,
                failed_releases: Arc::new(AtomicU64::new(0)),
            },
            receiver,
        ))
    }

    fn with_wake_event(mut self, wake_event: usize) -> Self {
        self.wake_event = wake_event;
        self
    }

    fn try_release(&self, release: WindowsD3d11LeaseRelease) {
        if self.sender.try_send(release).is_err() {
            self.failed_releases.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.wake();
    }

    pub(crate) fn failed_release_count(&self) -> u64 {
        self.failed_releases.load(Ordering::Relaxed)
    }

    fn wake(&self) {
        #[cfg(target_os = "windows")]
        if self.wake_event != 0 {
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::Threading::SetEvent;

            // SAFETY: `wake_event` is a non-owning copy of the media thread's
            // live event handle. A failed signal after shutdown is harmless:
            // the dropped release remains fail-closed and the texture is never
            // recycled by another generation.
            let _ = unsafe { SetEvent(HANDLE(self.wake_event as *mut core::ffi::c_void)) };
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TextureLeaseMetadata {
    pub(crate) generation: u64,
    pub(crate) lease_id: WindowsD3d11TextureLeaseId,
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) format: WindowsD3d11TextureFormat,
    pub(crate) sequence: u64,
    pub(crate) synchronization: WindowsD3d11SynchronizationToken,
    pub(crate) role: WindowsD3d11MediaRole,
}

#[derive(Clone)]
pub(crate) struct WindowsD3d11TextureLeaseTicket {
    inner: Arc<WindowsD3d11TextureLeaseTicketInner>,
}

struct WindowsD3d11TextureLeaseTicketInner {
    metadata: WindowsD3d11TextureLeaseMetadata,
    release_sender: WindowsD3d11TextureLeaseReleaseSender,
}

impl Drop for WindowsD3d11TextureLeaseTicketInner {
    fn drop(&mut self) {
        self.release_sender.try_release(WindowsD3d11LeaseRelease {
            generation: self.metadata.generation,
            lease_id: self.metadata.lease_id,
            role: self.metadata.role,
        });
    }
}

impl fmt::Debug for WindowsD3d11TextureLeaseTicket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsD3d11TextureLeaseTicket")
            .field("metadata", &self.inner.metadata)
            .finish_non_exhaustive()
    }
}

impl WindowsD3d11TextureLeaseTicket {
    pub(crate) fn new(
        metadata: WindowsD3d11TextureLeaseMetadata,
        release_sender: WindowsD3d11TextureLeaseReleaseSender,
    ) -> Result<Self, WindowsD3d11Error> {
        if metadata.generation == 0
            || metadata.lease_id.as_u64() == 0
            || metadata.synchronization.generation != metadata.generation
            || metadata.synchronization.fence_value == 0
            || metadata.width == 0
            || metadata.height == 0
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "D3D11 export ticket metadata is incomplete or generation-mismatched",
            ));
        }
        Ok(Self {
            inner: Arc::new(WindowsD3d11TextureLeaseTicketInner {
                metadata,
                release_sender,
            }),
        })
    }

    pub(crate) fn metadata(&self) -> WindowsD3d11TextureLeaseMetadata {
        self.inner.metadata
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsD3d11FenceTimeline {
    last_signaled: u64,
    completed: u64,
}

impl WindowsD3d11FenceTimeline {
    const fn new() -> Self {
        Self {
            last_signaled: 0,
            completed: 0,
        }
    }

    fn reserve_signal(&mut self) -> Result<u64, WindowsD3d11Error> {
        let value = self.last_signaled.checked_add(1).ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::FenceTimelineViolation,
                "D3D11 fence timeline was exhausted",
            )
        })?;
        self.last_signaled = value;
        Ok(value)
    }

    fn observe_completed(&mut self, value: u64) -> Result<(), WindowsD3d11Error> {
        if value < self.completed || value > self.last_signaled {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::FenceTimelineViolation,
                format!(
                    "completed fence value {value} is outside [{}, {}]",
                    self.completed, self.last_signaled
                ),
            ));
        }
        self.completed = value;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowsD3d11TextureSlotPhase {
    Free {
        reusable_after_fence: u64,
    },
    Writing {
        lease_id: WindowsD3d11TextureLeaseId,
    },
    Published {
        lease_id: WindowsD3d11TextureLeaseId,
        fence_value: u64,
        pending_roles: BTreeSet<WindowsD3d11MediaRole>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsD3d11TextureSlotState {
    slot_id: WindowsD3d11TextureSlotId,
    format: WindowsD3d11TextureFormat,
    dimensions: WindowsD3d11TextureDimensions,
    phase: WindowsD3d11TextureSlotPhase,
}

#[derive(Debug, Clone)]
pub(crate) struct WindowsD3d11BoundedTexturePool {
    generation: u64,
    slots: Vec<WindowsD3d11TextureSlotState>,
    next_lease_id: u64,
    timeline: WindowsD3d11FenceTimeline,
    pressure_events: u64,
}

impl WindowsD3d11BoundedTexturePool {
    pub(crate) fn new(
        generation: u64,
        config: WindowsD3d11TexturePoolConfig,
    ) -> Result<Self, WindowsD3d11Error> {
        if generation == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "D3D11 generation zero is reserved",
            ));
        }
        let buckets = config.buckets();
        let total_slots = config.total_slots();
        let mut slots = Vec::with_capacity(total_slots);
        for bucket in buckets {
            for _ in 0..bucket.slots {
                let slot_id = u16::try_from(slots.len()).map_err(|error| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                        format!("texture slot index overflowed: {error}"),
                    )
                })?;
                slots.push(WindowsD3d11TextureSlotState {
                    slot_id: WindowsD3d11TextureSlotId(slot_id),
                    format: bucket.format,
                    dimensions: bucket.dimensions,
                    phase: WindowsD3d11TextureSlotPhase::Free {
                        reusable_after_fence: 0,
                    },
                });
            }
        }
        Ok(Self {
            generation,
            slots,
            next_lease_id: 1,
            timeline: WindowsD3d11FenceTimeline::new(),
            pressure_events: 0,
        })
    }

    pub(crate) fn acquire_for_write(
        &mut self,
        format: WindowsD3d11TextureFormat,
    ) -> Result<WindowsD3d11ProducerTextureLease, WindowsD3d11Error> {
        let dimensions = self
            .slots
            .iter()
            .find(|slot| slot.format == format)
            .map(|slot| slot.dimensions)
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                    format!("the bounded pool has no {} texture bucket", format.as_str()),
                )
            })?;
        self.acquire_for_write_dimensions(format, dimensions)
    }

    pub(crate) fn acquire_for_write_dimensions(
        &mut self,
        format: WindowsD3d11TextureFormat,
        dimensions: WindowsD3d11TextureDimensions,
    ) -> Result<WindowsD3d11ProducerTextureLease, WindowsD3d11Error> {
        let slot_index = self.slots.iter().position(|slot| {
            slot.format == format
                && slot.dimensions == dimensions
                && matches!(
                    slot.phase,
                    WindowsD3d11TextureSlotPhase::Free {
                        reusable_after_fence
                    } if reusable_after_fence <= self.timeline.completed
                )
        });
        let Some(slot_index) = slot_index else {
            self.pressure_events = self.pressure_events.saturating_add(1);
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::TexturePoolExhausted,
                format!(
                    "no completed and fully released {} {}x{} texture is available",
                    format.as_str(),
                    dimensions.width,
                    dimensions.height
                ),
            ));
        };
        let lease_id = WindowsD3d11TextureLeaseId(self.next_lease_id);
        self.next_lease_id = self.next_lease_id.checked_add(1).ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "texture lease identifier space was exhausted",
            )
        })?;
        let slot = &mut self.slots[slot_index];
        slot.phase = WindowsD3d11TextureSlotPhase::Writing { lease_id };
        Ok(WindowsD3d11ProducerTextureLease {
            generation: self.generation,
            lease_id,
            slot_id: slot.slot_id,
            format,
            dimensions,
        })
    }

    pub(crate) fn capacity(&self) -> usize {
        self.slots.len()
    }

    pub(crate) fn in_use(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| !matches!(slot.phase, WindowsD3d11TextureSlotPhase::Free { .. }))
            .count()
    }

    pub(crate) const fn pressure_events(&self) -> u64 {
        self.pressure_events
    }

    pub(crate) fn cancel_write(
        &mut self,
        lease: WindowsD3d11ProducerTextureLease,
    ) -> Result<(), WindowsD3d11Error> {
        self.validate_generation(lease.generation)?;
        let slot = self.slot_mut(lease.slot_id)?;
        match slot.phase {
            WindowsD3d11TextureSlotPhase::Writing { lease_id }
                if lease_id == lease.lease_id
                    && slot.format == lease.format
                    && slot.dimensions == lease.dimensions =>
            {
                slot.phase = WindowsD3d11TextureSlotPhase::Free {
                    reusable_after_fence: 0,
                };
                Ok(())
            }
            _ => Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "producer lease does not own the requested texture slot",
            )),
        }
    }

    pub(crate) fn publish(
        &mut self,
        lease: WindowsD3d11ProducerTextureLease,
        consumers: impl IntoIterator<Item = WindowsD3d11MediaRole>,
    ) -> Result<WindowsD3d11PublishedTextureLease, WindowsD3d11Error> {
        self.validate_generation(lease.generation)?;
        let mut pending_roles = BTreeSet::new();
        for role in consumers {
            if !pending_roles.insert(role) {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    format!("consumer role {role:?} was requested more than once"),
                ));
            }
        }
        if pending_roles.is_empty() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "published texture must have at least one consumer role",
            ));
        }
        let slot_index = usize::from(lease.slot_id.as_u16());
        let slot = self.slots.get(slot_index).ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "producer texture slot is outside the bounded pool",
            )
        })?;
        if !matches!(
            slot.phase,
            WindowsD3d11TextureSlotPhase::Writing { lease_id }
                if lease_id == lease.lease_id
                    && slot.format == lease.format
                    && slot.dimensions == lease.dimensions
        ) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "producer lease is not the current writer for its texture slot",
            ));
        }
        let fence_value = self.timeline.reserve_signal()?;
        self.slots[slot_index].phase = WindowsD3d11TextureSlotPhase::Published {
            lease_id: lease.lease_id,
            fence_value,
            pending_roles: pending_roles.clone(),
        };
        Ok(WindowsD3d11PublishedTextureLease {
            generation: self.generation,
            lease_id: lease.lease_id,
            slot_id: lease.slot_id,
            format: lease.format,
            dimensions: lease.dimensions,
            synchronization: WindowsD3d11SynchronizationToken {
                generation: self.generation,
                fence_value,
            },
            consumers: pending_roles,
        })
    }

    pub(crate) fn publish_batch(
        &mut self,
        submissions: Vec<(WindowsD3d11ProducerTextureLease, Vec<WindowsD3d11MediaRole>)>,
    ) -> Result<Vec<WindowsD3d11PublishedTextureLease>, WindowsD3d11Error> {
        if submissions.is_empty() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "a D3D11 publication batch must contain at least one texture",
            ));
        }
        let mut trial = self.clone();
        let mut published = Vec::with_capacity(submissions.len());
        for (lease, consumers) in submissions {
            published.push(trial.publish(lease, consumers)?);
        }
        *self = trial;
        Ok(published)
    }

    pub(crate) fn validate_read_ticket(
        &self,
        metadata: WindowsD3d11TextureLeaseMetadata,
    ) -> Result<WindowsD3d11TextureSlotId, WindowsD3d11Error> {
        self.validate_generation(metadata.generation)?;
        let slot = self
            .slots
            .iter()
            .find(|slot| {
                matches!(
                    &slot.phase,
                    WindowsD3d11TextureSlotPhase::Published { lease_id, .. }
                        if *lease_id == metadata.lease_id
                )
            })
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "composition source ticket is no longer published",
                )
            })?;
        let WindowsD3d11TextureSlotPhase::Published {
            fence_value,
            pending_roles,
            ..
        } = &slot.phase
        else {
            unreachable!("published source slot was selected above");
        };
        if slot.format != metadata.format
            || slot.dimensions.width != metadata.width
            || slot.dimensions.height != metadata.height
            || *fence_value != metadata.synchronization.fence_value
            || metadata.synchronization.generation != metadata.generation
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "composition source ticket metadata does not match the active texture",
            ));
        }
        if !pending_roles.contains(&metadata.role) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::RoleNotHeld,
                format!(
                    "role {:?} no longer holds composition source lease {}",
                    metadata.role,
                    metadata.lease_id.as_u64()
                ),
            ));
        }
        Ok(slot.slot_id)
    }

    pub(crate) fn release_role(
        &mut self,
        release: WindowsD3d11LeaseRelease,
    ) -> Result<bool, WindowsD3d11Error> {
        self.validate_generation(release.generation)?;
        let slot_index = self
            .slots
            .iter()
            .position(|slot| {
                matches!(
                    slot.phase,
                    WindowsD3d11TextureSlotPhase::Published { lease_id, .. }
                        if lease_id == release.lease_id
                )
            })
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "published texture lease is not active",
                )
            })?;
        let slot = &mut self.slots[slot_index];
        let WindowsD3d11TextureSlotPhase::Published {
            fence_value,
            pending_roles,
            ..
        } = &mut slot.phase
        else {
            unreachable!("published slot was selected above");
        };
        if !pending_roles.remove(&release.role) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::RoleNotHeld,
                format!(
                    "role {:?} does not hold texture lease {}",
                    release.role,
                    release.lease_id.as_u64()
                ),
            ));
        }
        let reusable_after_fence = *fence_value;
        let fully_released = pending_roles.is_empty();
        if fully_released {
            slot.phase = WindowsD3d11TextureSlotPhase::Free {
                reusable_after_fence,
            };
        }
        Ok(fully_released)
    }

    pub(crate) fn observe_completed_fence(
        &mut self,
        completed: u64,
    ) -> Result<(), WindowsD3d11Error> {
        self.timeline.observe_completed(completed)
    }

    pub(crate) const fn last_signaled_fence(&self) -> u64 {
        self.timeline.last_signaled
    }

    pub(crate) const fn completed_fence(&self) -> u64 {
        self.timeline.completed
    }

    fn validate_generation(&self, generation: u64) -> Result<(), WindowsD3d11Error> {
        if generation != self.generation {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                format!(
                    "texture generation {generation} does not match active generation {}",
                    self.generation
                ),
            ));
        }
        Ok(())
    }

    fn slot_mut(
        &mut self,
        slot_id: WindowsD3d11TextureSlotId,
    ) -> Result<&mut WindowsD3d11TextureSlotState, WindowsD3d11Error> {
        self.slots
            .get_mut(usize::from(slot_id.as_u16()))
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "texture slot is outside the bounded pool",
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11RoleLease {
    pub(crate) generation: u64,
    pub(crate) lease_id: u64,
    pub(crate) role: WindowsD3d11MediaRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CoordinatorAcquireAction {
    StartMediaThread,
    ReuseMediaThread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CoordinatorReleaseAction {
    KeepMediaThread,
    DrainAndJoin {
        retired_generation: u64,
        next_generation: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CoordinatorRetireReason {
    LastRoleReleased,
    DeviceLost,
    AppShutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsD3d11CoordinatorPhase {
    Idle,
    Running {
        adapter_luid: DxgiAdapterLuid,
    },
    Closing {
        retired_generation: u64,
        reason: WindowsD3d11CoordinatorRetireReason,
    },
}

#[derive(Debug)]
pub(crate) struct WindowsD3d11MediaCoordinatorState {
    generation: u64,
    phase: WindowsD3d11CoordinatorPhase,
    next_role_lease_id: u64,
    role_leases: BTreeMap<u64, WindowsD3d11MediaRole>,
}

impl WindowsD3d11MediaCoordinatorState {
    pub(crate) fn new(initial_generation: u64) -> Result<Self, WindowsD3d11Error> {
        if initial_generation == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "D3D11 coordinator generation zero is reserved",
            ));
        }
        Ok(Self {
            generation: initial_generation,
            phase: WindowsD3d11CoordinatorPhase::Idle,
            next_role_lease_id: 1,
            role_leases: BTreeMap::new(),
        })
    }

    pub(crate) fn acquire(
        &mut self,
        adapter_luid: DxgiAdapterLuid,
        role: WindowsD3d11MediaRole,
    ) -> Result<(WindowsD3d11RoleLease, WindowsD3d11CoordinatorAcquireAction), WindowsD3d11Error>
    {
        let action = match self.phase {
            WindowsD3d11CoordinatorPhase::Idle => {
                self.phase = WindowsD3d11CoordinatorPhase::Running { adapter_luid };
                WindowsD3d11CoordinatorAcquireAction::StartMediaThread
            }
            WindowsD3d11CoordinatorPhase::Running {
                adapter_luid: active_adapter,
            } if active_adapter == adapter_luid => {
                WindowsD3d11CoordinatorAcquireAction::ReuseMediaThread
            }
            WindowsD3d11CoordinatorPhase::Running {
                adapter_luid: active_adapter,
            } => {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::AdapterMismatch,
                    format!(
                        "active adapter {active_adapter} cannot serve requested adapter {adapter_luid}"
                    ),
                ));
            }
            WindowsD3d11CoordinatorPhase::Closing { .. } => {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::GenerationClosing,
                    "the previous D3D11 generation is still draining",
                ));
            }
        };
        let lease_id = self.next_role_lease_id;
        self.next_role_lease_id = self.next_role_lease_id.checked_add(1).ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "role lease identifier space was exhausted",
            )
        })?;
        self.role_leases.insert(lease_id, role);
        Ok((
            WindowsD3d11RoleLease {
                generation: self.generation,
                lease_id,
                role,
            },
            action,
        ))
    }

    pub(crate) fn release(
        &mut self,
        lease: WindowsD3d11RoleLease,
    ) -> Result<WindowsD3d11CoordinatorReleaseAction, WindowsD3d11Error> {
        self.validate_running_generation(lease.generation)?;
        match self.role_leases.remove(&lease.lease_id) {
            Some(role) if role == lease.role => {}
            Some(role) => {
                self.role_leases.insert(lease.lease_id, role);
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "role lease type does not match the active coordinator lease",
                ));
            }
            None => {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "role lease is not active",
                ));
            }
        }
        if !self.role_leases.is_empty() {
            return Ok(WindowsD3d11CoordinatorReleaseAction::KeepMediaThread);
        }
        self.begin_closing(WindowsD3d11CoordinatorRetireReason::LastRoleReleased)
    }

    pub(crate) fn retire_for_device_loss(
        &mut self,
        generation: u64,
    ) -> Result<WindowsD3d11CoordinatorReleaseAction, WindowsD3d11Error> {
        self.validate_running_generation(generation)?;
        self.role_leases.clear();
        self.begin_closing(WindowsD3d11CoordinatorRetireReason::DeviceLost)
    }

    pub(crate) fn retire_for_shutdown(
        &mut self,
    ) -> Result<Option<WindowsD3d11CoordinatorReleaseAction>, WindowsD3d11Error> {
        match self.phase {
            WindowsD3d11CoordinatorPhase::Idle => Ok(None),
            WindowsD3d11CoordinatorPhase::Running { .. } => {
                self.role_leases.clear();
                self.begin_closing(WindowsD3d11CoordinatorRetireReason::AppShutdown)
                    .map(Some)
            }
            WindowsD3d11CoordinatorPhase::Closing { .. } => Ok(None),
        }
    }

    pub(crate) fn finish_shutdown(
        &mut self,
        retired_generation: u64,
    ) -> Result<(), WindowsD3d11Error> {
        match self.phase {
            WindowsD3d11CoordinatorPhase::Closing {
                retired_generation: expected,
                ..
            } if expected == retired_generation => {
                self.phase = WindowsD3d11CoordinatorPhase::Idle;
                Ok(())
            }
            WindowsD3d11CoordinatorPhase::Closing {
                retired_generation: expected,
                ..
            } => Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                format!(
                    "shutdown completion for generation {retired_generation} does not match retired generation {expected}"
                ),
            )),
            _ => Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "coordinator is not waiting for a media-thread shutdown",
            )),
        }
    }

    pub(crate) const fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn active_role_count(&self, role: WindowsD3d11MediaRole) -> usize {
        self.role_leases
            .values()
            .filter(|active_role| **active_role == role)
            .count()
    }

    fn begin_closing(
        &mut self,
        reason: WindowsD3d11CoordinatorRetireReason,
    ) -> Result<WindowsD3d11CoordinatorReleaseAction, WindowsD3d11Error> {
        let retired_generation = self.generation;
        let next_generation = retired_generation.checked_add(1).ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::GenerationExhausted,
                "D3D11 media generation was exhausted",
            )
        })?;
        self.generation = next_generation;
        self.phase = WindowsD3d11CoordinatorPhase::Closing {
            retired_generation,
            reason,
        };
        Ok(WindowsD3d11CoordinatorReleaseAction::DrainAndJoin {
            retired_generation,
            next_generation,
        })
    }

    fn validate_running_generation(&self, generation: u64) -> Result<(), WindowsD3d11Error> {
        match self.phase {
            WindowsD3d11CoordinatorPhase::Running { .. } if generation == self.generation => Ok(()),
            WindowsD3d11CoordinatorPhase::Running { .. }
            | WindowsD3d11CoordinatorPhase::Closing { .. } => Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                format!(
                    "callback generation {generation} does not match current generation {}",
                    self.generation
                ),
            )),
            WindowsD3d11CoordinatorPhase::Idle => Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "D3D11 coordinator has no active media thread",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11MediaPumpMetrics {
    pub(crate) max_message_batch: u32,
    pub(crate) max_media_batch: u32,
    pub(crate) message_lag_p95_micros: u64,
    pub(crate) max_message_lag_micros: u64,
    pub(crate) command_lag_p95_micros: u64,
    pub(crate) max_command_lag_micros: u64,
    pub(crate) stale_release_callbacks: u64,
}

const WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY: usize = 256;

#[derive(Debug, Clone)]
struct WindowsD3d11LatencySamples {
    values: [u64; WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY],
    len: usize,
    next: usize,
    max: u64,
}

impl Default for WindowsD3d11LatencySamples {
    fn default() -> Self {
        Self {
            values: [0; WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY],
            len: 0,
            next: 0,
            max: 0,
        }
    }
}

impl WindowsD3d11LatencySamples {
    fn observe(&mut self, micros: u64) {
        self.values[self.next] = micros;
        self.next = (self.next + 1) % WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY;
        self.len = self
            .len
            .saturating_add(1)
            .min(WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY);
        self.max = self.max.max(micros);
    }

    fn p95(&self) -> u64 {
        if self.len == 0 {
            return 0;
        }
        let mut ordered = self.values;
        ordered[..self.len].sort_unstable();
        let rank = self.len.saturating_mul(95).div_ceil(100).saturating_sub(1);
        ordered[rank]
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11MediaRuntimeCounters {
    pub(crate) capture: Option<crate::windows_d3d11_capture::WindowsD3d11CaptureDiagnostics>,
    pub(crate) compositor:
        Option<crate::windows_d3d11_compositor::WindowsD3d11CompositorDiagnostics>,
    pub(crate) encoder_gpu_samples: u64,
    pub(crate) encoder_system_memory_samples: u64,
    pub(crate) encoder_backpressure_events: u64,
    pub(crate) stale_generation_callbacks: u64,
    pub(crate) texture_pool_capacity: u64,
    pub(crate) texture_pool_in_use: u64,
    pub(crate) texture_pool_pressure_events: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11DeviceStatus {
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) output_index: u32,
    pub(crate) generation: u64,
    pub(crate) feature_level: u32,
    pub(crate) multithread_protected: bool,
    pub(crate) last_signaled_fence: u64,
    pub(crate) completed_fence: u64,
    pub(crate) device_loss_code: Option<i32>,
    pub(crate) capture_authority: Option<WindowsD3d11CaptureAuthorityKind>,
    pub(crate) compositor_ready: bool,
    pub(crate) pump: WindowsD3d11MediaPumpMetrics,
    pub(crate) runtime: WindowsD3d11MediaRuntimeCounters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CaptureAuthorityKind {
    DesktopDuplication,
    WindowsGraphicsCapture,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11MediaAuthorityState {
    generation: u64,
    capture: Option<WindowsD3d11CaptureAuthorityKind>,
    compositor_ready: bool,
}

impl WindowsD3d11MediaAuthorityState {
    pub(crate) fn new(generation: u64, compositor_ready: bool) -> Result<Self, WindowsD3d11Error> {
        if generation == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "D3D11 media authority generation zero is reserved",
            ));
        }
        Ok(Self {
            generation,
            capture: None,
            compositor_ready,
        })
    }

    pub(crate) fn start_capture(
        &mut self,
        generation: u64,
        capture: WindowsD3d11CaptureAuthorityKind,
    ) -> Result<(), WindowsD3d11Error> {
        self.validate_generation(generation)?;
        if self.capture.is_some() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CaptureUnavailable,
                "the media thread already owns an active capture runtime",
            ));
        }
        self.capture = Some(capture);
        Ok(())
    }

    pub(crate) fn require_capture(
        &self,
        generation: u64,
    ) -> Result<WindowsD3d11CaptureAuthorityKind, WindowsD3d11Error> {
        self.validate_generation(generation)?;
        self.capture.ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CaptureUnavailable,
                "capture acquisition requires a media-thread-owned capture runtime",
            )
        })
    }

    pub(crate) fn stop_capture(&mut self, generation: u64) -> Result<bool, WindowsD3d11Error> {
        self.validate_generation(generation)?;
        Ok(self.capture.take().is_some())
    }

    pub(crate) fn require_compositor(&self, generation: u64) -> Result<(), WindowsD3d11Error> {
        self.validate_generation(generation)?;
        if !self.compositor_ready {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CompositorUnavailable,
                "D3D11 shader initialization failed for this media generation",
            ));
        }
        Ok(())
    }

    fn validate_generation(&self, generation: u64) -> Result<(), WindowsD3d11Error> {
        if generation != self.generation {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                format!(
                    "media command generation {generation} does not match active generation {}",
                    self.generation
                ),
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use crate::windows_d3d11_capture::{
        WindowsD3d11CaptureBackend, WindowsD3d11CaptureDiagnostics, WindowsD3d11CaptureError,
        WindowsD3d11CaptureFallbackReason, WindowsD3d11CapturePlan,
        WindowsD3d11CaptureSubmissionMetadata, WindowsD3d11DesktopDuplicationCapture,
        WindowsD3d11DesktopDuplicationState, WindowsD3d11Point, WindowsD3d11WgcMonitorCapture,
    };
    use crate::windows_d3d11_compositor::{
        WindowsD3d11BgraUpload, WindowsD3d11ComposedFrame, WindowsD3d11Compositor,
        WindowsD3d11CompositorDiagnostics, WindowsD3d11CompositorError,
        WindowsD3d11CompositorErrorCode, WindowsD3d11EncodedOutputRole, WindowsD3d11EncodedTarget,
        WindowsD3d11GpuSource, WindowsD3d11GpuSourceContent, WindowsD3d11GpuTargets,
        WindowsD3d11OutputDimensions, WindowsD3d11ScenePlan, WindowsD3d11UploadPixelOrder,
    };
    use crate::windows_d3d11_preview::{
        WindowsD3d11Presenter, WindowsD3d11PresenterStatus, WindowsD3d11PreviewFrameMetadata,
        WindowsD3d11PreviewPlacement,
    };
    use crate::windows_d3d11_test_pattern::{
        WindowsD3d11TestPatternMetadata, render_bgra_test_pattern,
    };
    use std::marker::PhantomData;
    use std::mem;
    use std::rc::Rc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::sync::mpsc::TrySendError;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_FENCE_FLAG_NONE, D3D11_SDK_VERSION,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11CreateDevice, ID3D11Device, ID3D11Device5,
        ID3D11DeviceContext, ID3D11DeviceContext4, ID3D11Fence, ID3D11Multithread, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1,
        IDXGIFactory1,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::System::Threading::{CreateEventW, SetEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE,
        PeekMessageW, QS_ALLINPUT, TranslateMessage, WM_QUIT,
    };
    use windows::core::{Interface, PCWSTR};

    const MEDIA_COMMAND_QUEUE_CAPACITY: usize = 64;
    const MEDIA_RELEASE_QUEUE_CAPACITY: usize = 64;
    const MEDIA_BATCH_LIMIT: usize = 32;
    const MESSAGE_BATCH_LIMIT: usize = 32;
    const MEDIA_WAIT_TIMEOUT_MS: u32 = 16;
    const MEDIA_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
    const MAX_CAPTURE_WAIT_MS: u32 = 100;
    const MAX_COMPOSITION_SOURCES: usize = 64;
    const MAX_COMPOSITION_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

    pub(crate) struct WindowsD3d11Device {
        device: ID3D11Device5,
        immediate_context: ID3D11DeviceContext4,
        fence: ID3D11Fence,
        adapter_luid: DxgiAdapterLuid,
        feature_level: D3D_FEATURE_LEVEL,
        multithread_protected: bool,
        device_loss_code: Option<i32>,
        // windows-rs COM wrappers are Send + Sync. This marker deliberately
        // makes the aggregate thread-affine without a manual negative/positive
        // Send or Sync implementation.
        _thread_affinity: PhantomData<Rc<()>>,
    }

    impl WindowsD3d11Device {
        fn create(selection: WindowsDxgiOutputSelection) -> Result<Self, WindowsD3d11Error> {
            let adapter = select_adapter(selection)?;
            let mut base_device: Option<ID3D11Device> = None;
            let mut base_context: Option<ID3D11DeviceContext> = None;
            let mut feature_level = D3D_FEATURE_LEVEL_11_0;
            let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
            // SAFETY: all output pointers refer to initialized Options owned by
            // this media thread. The selected adapter stays alive for the call.
            unsafe {
                D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    flags,
                    Some(&feature_levels),
                    D3D11_SDK_VERSION,
                    Some(&mut base_device),
                    Some(&mut feature_level),
                    Some(&mut base_context),
                )
            }
            .map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceCreationFailed,
                    format!(
                        "D3D11CreateDevice failed for adapter {}: {error}",
                        selection.adapter_luid
                    ),
                )
            })?;
            let base_device = base_device.ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceCreationFailed,
                    "D3D11CreateDevice returned no device",
                )
            })?;
            let base_context = base_context.ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceCreationFailed,
                    "D3D11CreateDevice returned no immediate context",
                )
            })?;
            let multithread: ID3D11Multithread = base_context.cast().map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceCreationFailed,
                    format!("ID3D11Multithread is unavailable: {error}"),
                )
            })?;
            // SAFETY: the interface and context belong to this media thread.
            unsafe {
                let _ = multithread.SetMultithreadProtected(true);
            }
            let device: ID3D11Device5 = base_device.cast().map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::FenceUnavailable,
                    format!("ID3D11Device5 is unavailable: {error}"),
                )
            })?;
            let immediate_context: ID3D11DeviceContext4 = base_context.cast().map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::FenceUnavailable,
                    format!("ID3D11DeviceContext4 is unavailable: {error}"),
                )
            })?;
            let mut fence: Option<ID3D11Fence> = None;
            // SAFETY: the output Option is valid and remains on this thread.
            unsafe { device.CreateFence(0, D3D11_FENCE_FLAG_NONE, &mut fence) }.map_err(
                |error| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::FenceUnavailable,
                        format!("ID3D11Device5::CreateFence failed: {error}"),
                    )
                },
            )?;
            let fence = fence.ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::FenceUnavailable,
                    "ID3D11Device5::CreateFence returned no fence",
                )
            })?;
            Ok(Self {
                device,
                immediate_context,
                fence,
                adapter_luid: selection.adapter_luid,
                feature_level,
                multithread_protected: true,
                device_loss_code: None,
                _thread_affinity: PhantomData,
            })
        }

        pub(crate) const fn adapter_luid(&self) -> DxgiAdapterLuid {
            self.adapter_luid
        }

        pub(crate) const fn feature_level(&self) -> u32 {
            self.feature_level.0 as u32
        }

        pub(crate) const fn multithread_protected(&self) -> bool {
            self.multithread_protected
        }

        pub(crate) fn raw_device(&self) -> &ID3D11Device5 {
            &self.device
        }

        pub(crate) fn immediate_context(&self) -> &ID3D11DeviceContext4 {
            &self.immediate_context
        }

        fn completed_fence(&mut self) -> Result<u64, WindowsD3d11Error> {
            // SAFETY: the fence is owned and queried on this media thread.
            let completed = unsafe { self.fence.GetCompletedValue() };
            if completed == u64::MAX {
                self.record_device_loss();
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceLost,
                    "D3D11 fence reported device removal",
                ));
            }
            Ok(completed)
        }

        fn signal(&mut self, value: u64) -> Result<(), WindowsD3d11Error> {
            // SAFETY: the context and fence are confined to this media thread.
            unsafe { self.immediate_context.Signal(&self.fence, value) }.map_err(|error| {
                self.device_loss_code = Some(error.code().0);
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::DeviceLost,
                    format!("ID3D11DeviceContext4::Signal failed: {error}"),
                )
            })
        }

        fn record_device_loss(&mut self) {
            // SAFETY: the device is owned and queried on this media thread.
            self.device_loss_code = unsafe { self.device.GetDeviceRemovedReason() }
                .err()
                .map(|error| error.code().0);
        }
    }

    fn select_adapter(
        selection: WindowsDxgiOutputSelection,
    ) -> Result<IDXGIAdapter1, WindowsD3d11Error> {
        // SAFETY: DXGI returns an owned COM interface.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::AdapterNotFound,
                format!("CreateDXGIFactory1 failed: {error}"),
            )
        })?;
        let mut adapter_index = 0;
        loop {
            // SAFETY: adapter_index is bounded by DXGI's not-found response.
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => {
                    return Err(WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::AdapterNotFound,
                        format!("DXGI adapter {} was not found", selection.adapter_luid),
                    ));
                }
                Err(error) => {
                    return Err(WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::AdapterNotFound,
                        format!("IDXGIFactory1::EnumAdapters1 failed: {error}"),
                    ));
                }
            };
            // SAFETY: the adapter interface is valid for the call.
            let description = unsafe { adapter.GetDesc1() }.map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::AdapterNotFound,
                    format!("IDXGIAdapter1::GetDesc1 failed: {error}"),
                )
            })?;
            let adapter_luid = luid_from_parts(
                description.AdapterLuid.HighPart,
                description.AdapterLuid.LowPart,
            );
            if adapter_luid == selection.adapter_luid {
                if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                    return Err(WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::SoftwareAdapter,
                        format!("DXGI adapter {adapter_luid} is software-only"),
                    ));
                }
                // Validate the output half of the stable source ID on the same
                // adapter before creating any D3D resources.
                // SAFETY: output_index came from the canonical u32 source ID.
                match unsafe { adapter.EnumOutputs(selection.output_index) } {
                    Ok(_) => return Ok(adapter),
                    Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => {
                        return Err(WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::OutputNotFound,
                            format!(
                                "DXGI output {} was not found on adapter {adapter_luid}",
                                selection.output_index
                            ),
                        ));
                    }
                    Err(error) => {
                        return Err(WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::OutputNotFound,
                            format!("IDXGIAdapter1::EnumOutputs failed: {error}"),
                        ));
                    }
                }
            }
            adapter_index = adapter_index.checked_add(1).ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::AdapterNotFound,
                    "DXGI adapter index overflowed",
                )
            })?;
        }
    }

    fn luid_from_parts(high: i32, low: u32) -> DxgiAdapterLuid {
        DxgiAdapterLuid::from_u64((u64::from(high as u32) << 32) | u64::from(low))
    }

    struct WindowsD3d11TexturePoolOwner {
        config: WindowsD3d11TexturePoolConfig,
        state: WindowsD3d11BoundedTexturePool,
        textures: Vec<ID3D11Texture2D>,
    }

    impl WindowsD3d11TexturePoolOwner {
        fn create(
            device: &WindowsD3d11Device,
            generation: u64,
            config: WindowsD3d11TexturePoolConfig,
        ) -> Result<Self, WindowsD3d11Error> {
            let state = WindowsD3d11BoundedTexturePool::new(generation, config)?;
            let mut textures = Vec::with_capacity(config.total_slots());
            for bucket in config.buckets() {
                for _ in 0..bucket.slots {
                    textures.push(create_texture(device, bucket.dimensions, bucket.format)?);
                }
            }
            Ok(Self {
                config,
                state,
                textures,
            })
        }

        fn refresh_completed(
            &mut self,
            device: &mut WindowsD3d11Device,
        ) -> Result<(), WindowsD3d11Error> {
            let completed = device.completed_fence()?;
            self.state.observe_completed_fence(completed)
        }

        fn texture_for_producer(
            &self,
            lease: WindowsD3d11ProducerTextureLease,
        ) -> Result<&ID3D11Texture2D, WindowsD3d11Error> {
            self.textures
                .get(usize::from(lease.slot_id.as_u16()))
                .ok_or_else(|| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::InvalidLease,
                        "producer texture slot has no D3D11 resource",
                    )
                })
        }

        fn texture_for_ticket(
            &self,
            ticket: &WindowsD3d11TextureLeaseTicket,
        ) -> Result<&ID3D11Texture2D, WindowsD3d11Error> {
            let metadata = ticket.metadata();
            let slot_id = self.state.validate_read_ticket(metadata)?;
            self.textures
                .get(usize::from(slot_id.as_u16()))
                .ok_or_else(|| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::InvalidLease,
                        "composition source ticket has no D3D11 resource",
                    )
                })
        }
    }

    fn create_texture(
        device: &WindowsD3d11Device,
        dimensions: WindowsD3d11TextureDimensions,
        format: WindowsD3d11TextureFormat,
    ) -> Result<ID3D11Texture2D, WindowsD3d11Error> {
        let dxgi_format = match format {
            WindowsD3d11TextureFormat::Bgra8Unorm => DXGI_FORMAT_B8G8R8A8_UNORM,
            WindowsD3d11TextureFormat::Nv12 => DXGI_FORMAT_NV12,
        };
        let descriptor = D3D11_TEXTURE2D_DESC {
            Width: dimensions.width,
            Height: dimensions.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: dxgi_format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: descriptor and output Option live through the call. No
        // initial data is supplied for a GPU-owned default-usage texture.
        unsafe {
            device
                .raw_device()
                .CreateTexture2D(&descriptor, None, Some(&mut texture))
        }
        .map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::TextureCreationFailed,
                format!(
                    "creating {} texture {}x{} failed: {error}",
                    format.as_str(),
                    dimensions.width,
                    dimensions.height
                ),
            )
        })?;
        texture.ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::TextureCreationFailed,
                format!("creating {} texture returned no resource", format.as_str()),
            )
        })
    }

    struct OwnedEvent(HANDLE);

    impl OwnedEvent {
        fn create() -> Result<Self, WindowsD3d11Error> {
            // SAFETY: unnamed auto-reset event with default security.
            unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
                .map(Self)
                .map_err(|error| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::DeviceCreationFailed,
                        format!("creating D3D11 media command event failed: {error}"),
                    )
                })
        }

        fn value(&self) -> usize {
            self.0.0 as usize
        }
    }

    impl Drop for OwnedEvent {
        fn drop(&mut self) {
            // SAFETY: this owner closes its event exactly once on the media
            // thread after all GPU/COM objects have been dropped.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, WindowsD3d11Error> {
            // SAFETY: paired with this same thread's Drop implementation.
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result.is_err() {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::ComInitializationFailed,
                    format!("CoInitializeEx failed with {result:?}"),
                ));
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            // SAFETY: this balances the successful initialization above.
            unsafe {
                CoUninitialize();
            }
        }
    }

    #[derive(Debug)]
    struct QueuedMediaCommand {
        enqueued_at: Instant,
        command: WindowsD3d11MediaCommand,
    }

    #[derive(Debug)]
    enum WindowsD3d11MediaCommand {
        Status {
            reply: SyncSender<Result<WindowsD3d11DeviceStatus, WindowsD3d11Error>>,
        },
        RenderTestPattern {
            sequence: u64,
            consumers: Vec<WindowsD3d11MediaRole>,
            reply: SyncSender<Result<WindowsD3d11TestPatternSubmission, WindowsD3d11Error>>,
        },
        Shutdown,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11TestPatternSubmission {
        pub(crate) texture: WindowsD3d11PublishedTextureLease,
        pub(crate) metadata: WindowsD3d11TestPatternMetadata,
    }

    #[derive(Clone)]
    pub(crate) struct WindowsD3d11MediaClient {
        command_sender: SyncSender<QueuedMediaCommand>,
        release_sender: WindowsD3d11TextureLeaseReleaseSender,
        event_value: usize,
        selection: WindowsDxgiOutputSelection,
        generation: u64,
        preview_slot: Arc<Mutex<Option<WindowsD3d11QueuedPreviewFrame>>>,
        preview_replaced_frames: Arc<AtomicU64>,
    }

    impl fmt::Debug for WindowsD3d11MediaClient {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("WindowsD3d11MediaClient")
                .field("selection", &self.selection)
                .field("generation", &self.generation)
                .finish_non_exhaustive()
        }
    }

    impl WindowsD3d11MediaClient {
        pub(crate) fn status(&self) -> Result<WindowsD3d11DeviceStatus, WindowsD3d11Error> {
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::Status { reply })?;
            receive_response(response)
        }

        pub(crate) fn render_test_pattern(
            &self,
            sequence: u64,
            consumers: Vec<WindowsD3d11MediaRole>,
        ) -> Result<WindowsD3d11TestPatternSubmission, WindowsD3d11Error> {
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::RenderTestPattern {
                sequence,
                consumers,
                reply,
            })?;
            receive_response(response)
        }

        pub(crate) fn start_capture(
            &self,
            plan: WindowsD3d11CapturePlan,
        ) -> Result<WindowsD3d11CaptureSession, WindowsD3d11Error> {
            if plan.generation != self.generation
                || plan.selection.adapter_luid != self.selection.adapter_luid
                || plan.selection.output_index != self.selection.output_index
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::StaleGeneration,
                    "capture plan does not match this media-thread generation and output",
                ));
            }
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::StartCapture { plan, reply })?;
            receive_response(response)
        }

        pub(crate) fn acquire_capture(
            &self,
            timeout_ms: u32,
            consumers: Vec<WindowsD3d11MediaRole>,
        ) -> Result<Option<WindowsD3d11CaptureFrameSubmission>, WindowsD3d11Error> {
            if timeout_ms > MAX_CAPTURE_WAIT_MS {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::UnsupportedCapability,
                    format!(
                        "capture wait {timeout_ms}ms exceeds the bounded media-thread limit of {MAX_CAPTURE_WAIT_MS}ms"
                    ),
                ));
            }
            validate_consumer_roles("captured BGRA", &consumers, false)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::AcquireCapture {
                timeout_ms,
                consumers,
                reply,
            })?;
            receive_response(response)?
                .map(|submission| {
                    Ok(WindowsD3d11CaptureFrameSubmission {
                        metadata: submission.metadata,
                        texture: self.ticketed_texture(
                            WindowsD3d11ComposedTextureKind::CapturedBgra,
                            submission.lease,
                            submission.dimensions.width,
                            submission.dimensions.height,
                            submission.metadata.sequence,
                        )?,
                    })
                })
                .transpose()
        }

        pub(crate) fn stop_capture(&self) -> Result<bool, WindowsD3d11Error> {
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::StopCapture { reply })?;
            receive_response(response)
        }

        pub(crate) fn compose_scene(
            &self,
            plan: WindowsD3d11ScenePlan,
            sources: Vec<WindowsD3d11CompositionSource>,
            consumers: WindowsD3d11CompositionConsumers,
        ) -> Result<WindowsD3d11CompositionSubmission, WindowsD3d11Error> {
            validate_composition_command(self, &plan, &sources, &consumers)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::ComposeScene {
                plan,
                sources,
                consumers,
                reply,
            })?;
            let raw = receive_response(response)?;
            let mut textures = Vec::with_capacity(raw.textures.len());
            for texture in raw.textures {
                textures.push(self.ticketed_texture(
                    texture.kind,
                    texture.lease,
                    texture.dimensions.width,
                    texture.dimensions.height,
                    raw.frame.sequence,
                )?);
            }
            Ok(WindowsD3d11CompositionSubmission {
                frame: raw.frame,
                diagnostics: raw.diagnostics,
                textures,
            })
        }

        pub(crate) fn create_encoder(
            &self,
            role: WindowsD3d11MediaRole,
            config: MediaFoundationEncoderConfig,
            in_flight_capacity: usize,
        ) -> Result<WindowsD3d11EncoderStatus, WindowsD3d11Error> {
            validate_encoder_role(role)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::CreateEncoder {
                role,
                config,
                in_flight_capacity,
                reply,
            })?;
            receive_response(response)
        }

        pub(crate) fn encoder_status(
            &self,
            role: WindowsD3d11MediaRole,
        ) -> Result<WindowsD3d11EncoderStatus, WindowsD3d11Error> {
            validate_encoder_role(role)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::EncoderStatus { role, reply })?;
            receive_response(response)
        }

        /// Transfers one role-bound NV12 ticket to the media authority. On
        /// success the caller no longer owns recycling authority; the runtime
        /// retains it until IMFTrackedSample reports the scalar lease release.
        pub(crate) fn submit_encoder_texture(
            &self,
            ticket: WindowsD3d11TextureLeaseTicket,
            input_pts_100ns: i64,
            duration_100ns: i64,
            submitted_at_micros: u64,
        ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11EncoderSubmissionFailure> {
            let metadata = ticket.metadata();
            if let Err(error) = validate_encoder_ticket(self, metadata) {
                return Err(WindowsD3d11EncoderSubmissionFailure {
                    error,
                    progress: None,
                });
            }
            if input_pts_100ns < 0 || duration_100ns <= 0 {
                return Err(WindowsD3d11EncoderSubmissionFailure {
                    error: WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::InvalidLease,
                        "encoder submission requires non-negative PTS and positive duration",
                    ),
                    progress: None,
                });
            }
            let (reply, response) = mpsc::sync_channel(1);
            if let Err(error) = self.enqueue(WindowsD3d11MediaCommand::SubmitEncoderTexture {
                ticket,
                input_pts_100ns,
                duration_100ns,
                submitted_at_micros,
                reply,
            }) {
                return Err(WindowsD3d11EncoderSubmissionFailure {
                    error,
                    progress: None,
                });
            }
            receive_encoder_submission(response)
        }

        pub(crate) fn poll_encoder(
            &self,
            role: WindowsD3d11MediaRole,
        ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
            validate_encoder_role(role)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::PollEncoder { role, reply })?;
            receive_response(response)
        }

        pub(crate) fn drain_encoder(
            &self,
            role: WindowsD3d11MediaRole,
            timeout_ms: u32,
        ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
            validate_encoder_wait(role, timeout_ms)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::DrainEncoder {
                role,
                timeout_ms,
                reply,
            })?;
            receive_response_with_timeout(response, encoder_response_timeout(timeout_ms))
        }

        pub(crate) fn flush_encoder(
            &self,
            role: WindowsD3d11MediaRole,
            timeout_ms: u32,
        ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
            validate_encoder_wait(role, timeout_ms)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::FlushEncoder {
                role,
                timeout_ms,
                reply,
            })?;
            receive_response_with_timeout(response, encoder_response_timeout(timeout_ms))
        }

        /// Flushes, waits for tracked releases, and removes one encoder role.
        /// A timeout leaves the encoder and all retained tickets in place.
        pub(crate) fn shutdown_encoder(
            &self,
            role: WindowsD3d11MediaRole,
            timeout_ms: u32,
        ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
            validate_encoder_wait(role, timeout_ms)?;
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::ShutdownEncoder {
                role,
                timeout_ms,
                reply,
            })?;
            receive_response_with_timeout(response, encoder_response_timeout(timeout_ms))
        }

        pub(crate) fn configure_preview(
            &self,
            placement: WindowsD3d11PreviewPlacement,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            if placement.media_generation != self.generation
                || placement.preview_generation == 0
                || placement.adapter_luid != self.selection.adapter_luid
                || placement.target_window_handle == 0
                || placement.expected_owner_process_id == 0
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::StaleGeneration,
                    "preview placement does not match this media authority",
                ));
            }
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::ConfigurePreview { placement, reply })?;
            receive_response(response)
        }

        pub(crate) fn preview_status(
            &self,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::PreviewStatus { reply })?;
            receive_response(response)
        }

        /// Capacity-one latest-wins preview ingress. Replacing a pending frame
        /// drops its role ticket immediately; capture and encoder commands are
        /// never blocked behind stale preview work.
        pub(crate) fn offer_preview(
            &self,
            ticket: WindowsD3d11TextureLeaseTicket,
            preview_generation: u64,
            source_live: bool,
        ) -> Result<WindowsD3d11PreviewOffer, WindowsD3d11Error> {
            let metadata = ticket.metadata();
            if metadata.generation != self.generation
                || metadata.synchronization.generation != self.generation
                || metadata.adapter_luid != self.selection.adapter_luid
                || metadata.role != WindowsD3d11MediaRole::Preview
                || metadata.format != WindowsD3d11TextureFormat::Bgra8Unorm
                || preview_generation == 0
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "preview offer requires a same-authority, role-bound BGRA ticket",
                ));
            }
            let sequence = metadata.sequence;
            let replaced = {
                let mut slot = self.preview_slot.lock().map_err(|_| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::CommandChannelClosed,
                        "latest-wins preview slot lock was poisoned",
                    )
                })?;
                slot.replace(WindowsD3d11QueuedPreviewFrame {
                    ticket,
                    preview_generation,
                    source_live,
                })
            };
            let replaced_sequence = replaced
                .as_ref()
                .map(|frame| frame.ticket.metadata().sequence);
            if replaced.is_some() {
                self.preview_replaced_frames.fetch_add(1, Ordering::Relaxed);
            }
            drop(replaced);
            self.wake()?;
            Ok(WindowsD3d11PreviewOffer {
                sequence,
                replaced_sequence,
            })
        }

        pub(crate) fn destroy_preview(&self) -> Result<bool, WindowsD3d11Error> {
            let (reply, response) = mpsc::sync_channel(1);
            self.enqueue(WindowsD3d11MediaCommand::DestroyPreview { reply })?;
            receive_response(response)
        }

        pub(crate) fn texture_ticket(
            &self,
            submission: &WindowsD3d11TestPatternSubmission,
            role: WindowsD3d11MediaRole,
        ) -> Result<WindowsD3d11TextureLeaseTicket, WindowsD3d11Error> {
            if submission.texture.generation != self.generation
                || !submission.texture.consumers.contains(&role)
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "test-pattern submission does not grant the requested role in this generation",
                ));
            }
            let dimensions = submission.metadata.dimensions();
            WindowsD3d11TextureLeaseTicket::new(
                WindowsD3d11TextureLeaseMetadata {
                    generation: submission.texture.generation,
                    lease_id: submission.texture.lease_id,
                    adapter_luid: self.selection.adapter_luid,
                    width: dimensions.width,
                    height: dimensions.height,
                    format: submission.texture.format,
                    sequence: submission.metadata.sequence,
                    synchronization: submission.texture.synchronization,
                    role,
                },
                self.release_sender.clone(),
            )
        }

        pub(crate) fn release_sender(&self) -> WindowsD3d11TextureLeaseReleaseSender {
            self.release_sender.clone()
        }

        fn ticketed_texture(
            &self,
            kind: WindowsD3d11ComposedTextureKind,
            lease: WindowsD3d11PublishedTextureLease,
            width: u32,
            height: u32,
            sequence: u64,
        ) -> Result<WindowsD3d11TicketedTexture, WindowsD3d11Error> {
            if lease.generation != self.generation
                || lease.synchronization.generation != self.generation
                || lease.synchronization.fence_value == 0
                || width == 0
                || height == 0
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    "media-thread response returned invalid ticket metadata",
                ));
            }
            let mut tickets = Vec::with_capacity(lease.consumers.len());
            for role in &lease.consumers {
                tickets.push(WindowsD3d11TextureLeaseTicket::new(
                    WindowsD3d11TextureLeaseMetadata {
                        generation: lease.generation,
                        lease_id: lease.lease_id,
                        adapter_luid: self.selection.adapter_luid,
                        width,
                        height,
                        format: lease.format,
                        sequence,
                        synchronization: lease.synchronization,
                        role: *role,
                    },
                    self.release_sender.clone(),
                )?);
            }
            Ok(WindowsD3d11TicketedTexture {
                kind,
                lease,
                width,
                height,
                sequence,
                tickets,
            })
        }

        fn shutdown(&self) -> Result<(), WindowsD3d11Error> {
            self.enqueue(WindowsD3d11MediaCommand::Shutdown)
        }

        fn enqueue(&self, command: WindowsD3d11MediaCommand) -> Result<(), WindowsD3d11Error> {
            self.command_sender
                .try_send(QueuedMediaCommand {
                    enqueued_at: Instant::now(),
                    command,
                })
                .map_err(|error| match error {
                    TrySendError::Full(_) => WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::CommandQueueFull,
                        "bounded D3D11 media command queue is full",
                    ),
                    TrySendError::Disconnected(_) => WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::CommandChannelClosed,
                        "D3D11 media command queue is closed",
                    ),
                })?;
            // SAFETY: the media thread owns the handle. Failure means shutdown
            // raced this enqueue and is reported instead of silently blocking.
            unsafe { SetEvent(HANDLE(self.event_value as *mut core::ffi::c_void)) }.map_err(
                |error| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::CommandChannelClosed,
                        format!("signaling D3D11 media command event failed: {error}"),
                    )
                },
            )
        }
    }

    fn validate_consumer_roles(
        label: &str,
        consumers: &[WindowsD3d11MediaRole],
        allow_empty: bool,
    ) -> Result<(), WindowsD3d11Error> {
        if consumers.is_empty() && !allow_empty {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                format!("{label} requires at least one consumer role"),
            ));
        }
        let unique = consumers.iter().copied().collect::<BTreeSet<_>>();
        if unique.len() != consumers.len() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                format!("{label} contains a duplicate consumer role"),
            ));
        }
        Ok(())
    }

    fn encoder_role(
        role: WindowsD3d11MediaRole,
    ) -> Result<WindowsD3d11EncoderRole, WindowsD3d11Error> {
        match role {
            WindowsD3d11MediaRole::Record => Ok(WindowsD3d11EncoderRole::Record),
            WindowsD3d11MediaRole::Stream => Ok(WindowsD3d11EncoderRole::Stream),
            WindowsD3d11MediaRole::Compositor | WindowsD3d11MediaRole::Preview => {
                Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::UnsupportedCapability,
                    format!("{role:?} is not a Media Foundation encoder role"),
                ))
            }
        }
    }

    fn validate_encoder_role(role: WindowsD3d11MediaRole) -> Result<(), WindowsD3d11Error> {
        encoder_role(role).map(|_| ())
    }

    fn validate_encoder_ticket(
        client: &WindowsD3d11MediaClient,
        metadata: WindowsD3d11TextureLeaseMetadata,
    ) -> Result<(), WindowsD3d11Error> {
        validate_encoder_role(metadata.role)?;
        if metadata.generation != client.generation
            || metadata.synchronization.generation != client.generation
            || metadata.adapter_luid != client.selection.adapter_luid
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "encoder ticket does not belong to this media-thread generation and adapter",
            ));
        }
        if metadata.format != WindowsD3d11TextureFormat::Nv12 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "Media Foundation GPU submission requires a role-bound NV12 ticket",
            ));
        }
        Ok(())
    }

    fn validate_encoder_wait(
        role: WindowsD3d11MediaRole,
        timeout_ms: u32,
    ) -> Result<(), WindowsD3d11Error> {
        validate_encoder_role(role)?;
        if timeout_ms == 0 || timeout_ms > MAX_ENCODER_WAIT_MS {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                format!(
                    "encoder wait must be between 1ms and {MAX_ENCODER_WAIT_MS}ms, got {timeout_ms}ms"
                ),
            ));
        }
        Ok(())
    }

    fn encoder_response_timeout(timeout_ms: u32) -> Duration {
        MEDIA_RESPONSE_TIMEOUT + Duration::from_millis(u64::from(timeout_ms))
    }

    fn validate_composition_command(
        client: &WindowsD3d11MediaClient,
        plan: &WindowsD3d11ScenePlan,
        sources: &[WindowsD3d11CompositionSource],
        consumers: &WindowsD3d11CompositionConsumers,
    ) -> Result<(), WindowsD3d11Error> {
        if plan.generation != client.generation
            || plan.adapter_luid != client.selection.adapter_luid
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "composition plan does not match this media-thread authority",
            ));
        }
        if sources.len() > MAX_COMPOSITION_SOURCES {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                format!(
                    "composition has {} sources; bounded command limit is {MAX_COMPOSITION_SOURCES}",
                    sources.len()
                ),
            ));
        }
        let mut source_ids = BTreeSet::new();
        let mut upload_bytes = 0usize;
        for source in sources {
            if !source_ids.insert(source.source_id()) {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidLease,
                    format!("composition source ID {} appears twice", source.source_id()),
                ));
            }
            match source {
                WindowsD3d11CompositionSource::TextureLease { ticket, .. } => {
                    let metadata = ticket.metadata();
                    if metadata.generation != client.generation
                        || metadata.adapter_luid != client.selection.adapter_luid
                        || metadata.role != WindowsD3d11MediaRole::Compositor
                        || metadata.format != WindowsD3d11TextureFormat::Bgra8Unorm
                    {
                        return Err(WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::InvalidLease,
                            "GPU composition source requires a same-generation BGRA ticket held by the Compositor role",
                        ));
                    }
                }
                WindowsD3d11CompositionSource::BgraUpload { pixels, .. } => {
                    upload_bytes = upload_bytes.checked_add(pixels.len()).ok_or_else(|| {
                        WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::UnsupportedCapability,
                            "composition upload byte count overflowed",
                        )
                    })?;
                }
            }
        }
        if upload_bytes > MAX_COMPOSITION_UPLOAD_BYTES {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                format!(
                    "composition uploads total {upload_bytes} bytes; bounded command limit is {MAX_COMPOSITION_UPLOAD_BYTES}"
                ),
            ));
        }
        validate_consumer_roles("BGRA preview", &consumers.preview, true)?;
        for output in &plan.encoded_outputs {
            validate_consumer_roles(
                match output.role {
                    WindowsD3d11EncodedOutputRole::Primary => "primary NV12",
                    WindowsD3d11EncodedOutputRole::Auxiliary => "auxiliary NV12",
                },
                consumers.for_output(output.role),
                false,
            )?;
        }
        if (!plan
            .encoded_outputs
            .iter()
            .any(|output| output.role == WindowsD3d11EncodedOutputRole::Primary)
            && !consumers.primary.is_empty())
            || (!plan
                .encoded_outputs
                .iter()
                .any(|output| output.role == WindowsD3d11EncodedOutputRole::Auxiliary)
                && !consumers.auxiliary.is_empty())
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "consumer roles were supplied for an encoded output absent from the scene plan",
            ));
        }
        if consumers.preview.is_empty() && plan.encoded_outputs.is_empty() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "composition must export preview or at least one encoded output",
            ));
        }
        Ok(())
    }

    fn receive_response<T>(
        response: Receiver<Result<T, WindowsD3d11Error>>,
    ) -> Result<T, WindowsD3d11Error> {
        receive_response_with_timeout(response, MEDIA_RESPONSE_TIMEOUT)
    }

    fn receive_response_with_timeout<T>(
        response: Receiver<Result<T, WindowsD3d11Error>>,
        timeout: Duration,
    ) -> Result<T, WindowsD3d11Error> {
        response.recv_timeout(timeout).map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::ResponseTimeout,
                format!("D3D11 media response was not received: {error}"),
            )
        })?
    }

    fn receive_encoder_submission(
        response: Receiver<
            Result<WindowsD3d11EncoderProgress, WindowsD3d11EncoderSubmissionFailure>,
        >,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11EncoderSubmissionFailure> {
        response
            .recv_timeout(MEDIA_RESPONSE_TIMEOUT)
            .map_err(|error| WindowsD3d11EncoderSubmissionFailure {
                error: WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::ResponseTimeout,
                    format!("D3D11 encoder submission response was not received: {error}"),
                ),
                progress: None,
            })?
    }

    pub(crate) struct WindowsD3d11MediaThread {
        client: WindowsD3d11MediaClient,
        join: Option<JoinHandle<()>>,
    }

    impl fmt::Debug for WindowsD3d11MediaThread {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("WindowsD3d11MediaThread")
                .field("client", &self.client)
                .field("joinable", &self.join.is_some())
                .finish()
        }
    }

    impl WindowsD3d11MediaThread {
        pub(crate) fn spawn(
            selection: WindowsDxgiOutputSelection,
            generation: u64,
            pool_config: WindowsD3d11TexturePoolConfig,
        ) -> Result<Self, WindowsD3d11Error> {
            if generation == 0 {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::StaleGeneration,
                    "D3D11 media-thread generation zero is reserved",
                ));
            }
            let (command_sender, command_receiver) =
                mpsc::sync_channel(MEDIA_COMMAND_QUEUE_CAPACITY);
            let (release_sender, release_receiver) =
                WindowsD3d11TextureLeaseReleaseSender::bounded(MEDIA_RELEASE_QUEUE_CAPACITY)?;
            let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
            let cancel_startup = Arc::new(AtomicBool::new(false));
            let thread_cancel = cancel_startup.clone();
            let preview_slot: Arc<Mutex<Option<WindowsD3d11QueuedPreviewFrame>>> =
                Arc::new(Mutex::new(None));
            let thread_preview_slot = Arc::clone(&preview_slot);
            let preview_replaced_frames = Arc::new(AtomicU64::new(0));
            let thread_preview_replaced_frames = Arc::clone(&preview_replaced_frames);
            let join = thread::Builder::new()
                .name(format!("videorc-d3d11-media-{generation}"))
                .spawn(move || {
                    run_media_thread(
                        selection,
                        generation,
                        pool_config,
                        command_receiver,
                        release_receiver,
                        thread_preview_slot,
                        thread_preview_replaced_frames,
                        startup_sender,
                        thread_cancel,
                    );
                })
                .map_err(|error| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::DeviceCreationFailed,
                        format!("spawning D3D11 media thread failed: {error}"),
                    )
                })?;
            let startup = match startup_receiver.recv_timeout(Duration::from_secs(10)) {
                Ok(startup) => startup?,
                Err(error) => {
                    cancel_startup.store(true, AtomicOrdering::Release);
                    return Err(WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::ResponseTimeout,
                        format!("D3D11 media thread did not initialize in time: {error}"),
                    ));
                }
            };
            let release_sender = release_sender.with_wake_event(startup.event_value);
            Ok(Self {
                client: WindowsD3d11MediaClient {
                    command_sender,
                    release_sender,
                    event_value: startup.event_value,
                    selection,
                    generation,
                    preview_slot,
                    preview_replaced_frames,
                },
                join: Some(join),
            })
        }

        pub(crate) fn client(&self) -> WindowsD3d11MediaClient {
            self.client.clone()
        }

        pub(crate) fn shutdown(mut self) -> Result<(), WindowsD3d11Error> {
            self.shutdown_inner()
        }

        fn shutdown_inner(&mut self) -> Result<(), WindowsD3d11Error> {
            let send_result = self.client.shutdown();
            if let Some(join) = self.join.take() {
                join.join().map_err(|_| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::DeviceLost,
                        "D3D11 media thread panicked during shutdown",
                    )
                })?;
            }
            send_result
        }
    }

    impl Drop for WindowsD3d11MediaThread {
        fn drop(&mut self) {
            let _ = self.shutdown_inner();
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct MediaThreadStartup {
        event_value: usize,
    }

    fn run_media_thread(
        selection: WindowsDxgiOutputSelection,
        generation: u64,
        pool_config: WindowsD3d11TexturePoolConfig,
        command_receiver: Receiver<QueuedMediaCommand>,
        release_receiver: Receiver<WindowsD3d11LeaseRelease>,
        preview_slot: Arc<Mutex<Option<WindowsD3d11QueuedPreviewFrame>>>,
        preview_replaced_frames: Arc<AtomicU64>,
        startup_sender: SyncSender<Result<MediaThreadStartup, WindowsD3d11Error>>,
        cancel_startup: Arc<AtomicBool>,
    ) {
        let setup = (|| {
            let apartment = ComApartment::initialize()?;
            let event = OwnedEvent::create()?;
            let device = WindowsD3d11Device::create(selection)?;
            let texture_pool =
                WindowsD3d11TexturePoolOwner::create(&device, generation, pool_config)?;
            let compositor = WindowsD3d11Compositor::new(&device, generation);
            let media_runtime = WindowsD3d11MediaRuntimeState::new(generation, compositor)?;
            Ok::<_, WindowsD3d11Error>((apartment, event, device, texture_pool, media_runtime))
        })();
        let Ok((apartment, event, mut device, mut texture_pool, mut media_runtime)) = setup else {
            let _ = startup_sender.send(setup.map(|_| unreachable!()));
            return;
        };
        let _apartment = apartment;
        if startup_sender
            .send(Ok(MediaThreadStartup {
                event_value: event.value(),
            }))
            .is_err()
            || cancel_startup.load(AtomicOrdering::Acquire)
        {
            return;
        }
        let mut metrics = WindowsD3d11MediaPumpMetrics::default();
        let mut message_lag_samples = WindowsD3d11LatencySamples::default();
        let mut command_lag_samples = WindowsD3d11LatencySamples::default();
        let mut shutdown = false;
        while !shutdown && !cancel_startup.load(AtomicOrdering::Acquire) {
            let handles = [event.0];
            // SAFETY: the event is alive for the duration of the wait. This
            // call also creates/serves this thread's Win32 message queue.
            unsafe {
                MsgWaitForMultipleObjectsEx(
                    Some(&handles),
                    MEDIA_WAIT_TIMEOUT_MS,
                    QS_ALLINPUT,
                    MWMO_INPUTAVAILABLE,
                );
            }

            if cancel_startup.load(AtomicOrdering::Acquire) {
                break;
            }
            let message_count = drain_window_messages(&mut shutdown, &mut message_lag_samples);
            metrics.max_message_batch = metrics
                .max_message_batch
                .max(u32::try_from(message_count).unwrap_or(u32::MAX));
            metrics.message_lag_p95_micros = message_lag_samples.p95();
            metrics.max_message_lag_micros = message_lag_samples.max;

            let mut media_count = 0;
            while media_count < MEDIA_BATCH_LIMIT {
                match release_receiver.try_recv() {
                    Ok(release) => {
                        if texture_pool.state.release_role(release).is_err() {
                            metrics.stale_release_callbacks =
                                metrics.stale_release_callbacks.saturating_add(1);
                        }
                        media_count += 1;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break,
                }
            }
            while media_count < MEDIA_BATCH_LIMIT && !shutdown {
                match command_receiver.try_recv() {
                    Ok(queued) => {
                        let command_lag_micros = queued
                            .enqueued_at
                            .elapsed()
                            .as_micros()
                            .min(u128::from(u64::MAX))
                            as u64;
                        command_lag_samples.observe(command_lag_micros);
                        metrics.command_lag_p95_micros = command_lag_samples.p95();
                        metrics.max_command_lag_micros = command_lag_samples.max;
                        shutdown = handle_command(
                            queued.command,
                            selection,
                            generation,
                            &mut device,
                            &mut texture_pool,
                            &mut media_runtime,
                            metrics,
                        );
                        media_count += 1;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        shutdown = true;
                    }
                }
            }
            if media_count < MEDIA_BATCH_LIMIT && !shutdown {
                let preview_frame = match preview_slot.lock() {
                    Ok(mut slot) => slot.take(),
                    Err(_) => {
                        media_runtime.presenter_last_error = Some(WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::CommandChannelClosed,
                            "latest-wins preview slot lock was poisoned",
                        ));
                        None
                    }
                };
                let replaced = preview_replaced_frames.swap(0, AtomicOrdering::AcqRel);
                if let Some(presenter) = media_runtime.presenter.as_mut() {
                    presenter.note_latest_wins_drops(replaced);
                }
                if let Some(frame) = preview_frame {
                    if let Err(error) = present_preview_frame(
                        generation,
                        frame,
                        &device,
                        &texture_pool,
                        &mut media_runtime,
                    ) {
                        media_runtime.presenter_last_error = Some(error);
                    } else {
                        media_runtime.presenter_last_error = None;
                    }
                    media_count += 1;
                }
            }
            metrics.max_media_batch = metrics
                .max_media_batch
                .max(u32::try_from(media_count).unwrap_or(u32::MAX));
            if media_count == MEDIA_BATCH_LIMIT {
                // SAFETY: re-signal the owned event so a bounded batch cannot
                // strand remaining work behind a reset auto-reset event.
                let _ = unsafe { SetEvent(event.0) };
            }
        }
        drop(media_runtime);
        drop(texture_pool);
        drop(device);
        drop(event);
        mem::drop(_apartment);
    }

    fn present_preview_frame(
        generation: u64,
        frame: WindowsD3d11QueuedPreviewFrame,
        device: &WindowsD3d11Device,
        texture_pool: &WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
        let metadata = frame.ticket.metadata();
        if metadata.generation != generation
            || metadata.synchronization.generation != generation
            || metadata.adapter_luid != device.adapter_luid()
            || metadata.role != WindowsD3d11MediaRole::Preview
            || metadata.format != WindowsD3d11TextureFormat::Bgra8Unorm
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "latest-wins preview slot contained a stale or non-BGRA role ticket",
            ));
        }
        let texture = texture_pool.texture_for_ticket(&frame.ticket)?;
        let presenter = media_runtime.presenter.as_mut().ok_or_else(|| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CompositorUnavailable,
                "backend D3D11 presenter is not configured",
            )
        })?;
        presenter.present(
            device,
            texture,
            WindowsD3d11PreviewFrameMetadata {
                media_generation: generation,
                preview_generation: frame.preview_generation,
                adapter_luid: metadata.adapter_luid,
                sequence: metadata.sequence,
                source_live: frame.source_live,
            },
            metadata.width,
            metadata.height,
        )
    }

    fn drain_window_messages(
        shutdown: &mut bool,
        lag_samples: &mut WindowsD3d11LatencySamples,
    ) -> usize {
        let mut count = 0;
        while count < MESSAGE_BATCH_LIMIT {
            let mut message = MSG::default();
            // SAFETY: message points to initialized storage and no HWND filter
            // is used, so presenter/input/thread messages all remain serviced.
            if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                break;
            }
            // MSG.time and GetTickCount64 share the system-uptime millisecond
            // clock. Truncating the current tick to u32 and wrapping the
            // subtraction preserves the documented 49-day wrap behavior.
            let now_ms = unsafe { GetTickCount64() } as u32;
            let queued_ms = if message.time == 0 {
                0
            } else {
                now_ms.wrapping_sub(message.time)
            };
            lag_samples.observe(u64::from(queued_ms).saturating_mul(1_000));
            if message.message == WM_QUIT {
                *shutdown = true;
            } else {
                // SAFETY: message was returned by PeekMessageW on this thread.
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            count += 1;
        }
        count
    }

    fn media_runtime_counters(
        texture_pool: &WindowsD3d11TexturePoolOwner,
        media_runtime: &WindowsD3d11MediaRuntimeState,
        pump: WindowsD3d11MediaPumpMetrics,
    ) -> WindowsD3d11MediaRuntimeCounters {
        let mut counters = WindowsD3d11MediaRuntimeCounters {
            capture: media_runtime
                .capture
                .as_ref()
                .map(WindowsD3d11CaptureRuntime::diagnostics),
            compositor: media_runtime
                .compositor
                .as_ref()
                .ok()
                .map(WindowsD3d11Compositor::diagnostics),
            stale_generation_callbacks: pump.stale_release_callbacks,
            texture_pool_capacity: texture_pool.state.capacity() as u64,
            texture_pool_in_use: texture_pool.state.in_use() as u64,
            texture_pool_pressure_events: texture_pool.state.pressure_events(),
            ..Default::default()
        };
        for encoder in media_runtime.encoders.values() {
            let diagnostics = encoder.encoder.diagnostics();
            counters.encoder_gpu_samples = counters
                .encoder_gpu_samples
                .saturating_add(diagnostics.ownership.gpu_nv12_samples_submitted);
            counters.encoder_system_memory_samples = counters
                .encoder_system_memory_samples
                .saturating_add(diagnostics.ownership.system_memory_i420_samples_submitted);
            counters.encoder_backpressure_events = counters
                .encoder_backpressure_events
                .saturating_add(diagnostics.ownership.backpressure_events);
            counters.stale_generation_callbacks = counters
                .stale_generation_callbacks
                .saturating_add(diagnostics.ownership.stale_release_callbacks);
        }
        counters
    }

    fn handle_command(
        command: WindowsD3d11MediaCommand,
        selection: WindowsDxgiOutputSelection,
        generation: u64,
        device: &mut WindowsD3d11Device,
        texture_pool: &mut WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
        metrics: WindowsD3d11MediaPumpMetrics,
    ) -> bool {
        match command {
            WindowsD3d11MediaCommand::Status { reply } => {
                let response =
                    texture_pool
                        .refresh_completed(device)
                        .map(|()| WindowsD3d11DeviceStatus {
                            adapter_luid: device.adapter_luid(),
                            output_index: selection.output_index,
                            generation,
                            feature_level: device.feature_level(),
                            multithread_protected: device.multithread_protected(),
                            last_signaled_fence: texture_pool.state.last_signaled_fence(),
                            completed_fence: texture_pool.state.completed_fence(),
                            device_loss_code: device.device_loss_code,
                            capture_authority: media_runtime.contract.capture,
                            compositor_ready: media_runtime.compositor.is_ok(),
                            pump: metrics,
                            runtime: media_runtime_counters(texture_pool, media_runtime, metrics),
                        });
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::RenderTestPattern {
                sequence,
                consumers,
                reply,
            } => {
                let response =
                    render_test_pattern_submission(sequence, consumers, device, texture_pool);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::StartCapture { plan, reply } => {
                let response = start_capture_runtime(plan, device, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::AcquireCapture {
                timeout_ms,
                consumers,
                reply,
            } => {
                let response = acquire_capture_submission(
                    generation,
                    timeout_ms,
                    consumers,
                    device,
                    texture_pool,
                    media_runtime,
                );
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::StopCapture { reply } => {
                let response = media_runtime
                    .contract
                    .stop_capture(generation)
                    .map(|stopped| {
                        media_runtime.capture = None;
                        stopped
                    });
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::ComposeScene {
                plan,
                sources,
                consumers,
                reply,
            } => {
                let response = compose_scene_submission(
                    generation,
                    &plan,
                    &sources,
                    &consumers,
                    device,
                    texture_pool,
                    media_runtime,
                );
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::CreateEncoder {
                role,
                config,
                in_flight_capacity,
                reply,
            } => {
                let response = create_encoder_runtime(
                    generation,
                    role,
                    config,
                    in_flight_capacity,
                    device,
                    texture_pool,
                    media_runtime,
                );
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::EncoderStatus { role, reply } => {
                let response = media_runtime
                    .encoders
                    .get(&role)
                    .map(WindowsD3d11EncoderRuntime::status)
                    .ok_or_else(|| encoder_missing(role));
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::SubmitEncoderTexture {
                ticket,
                input_pts_100ns,
                duration_100ns,
                submitted_at_micros,
                reply,
            } => {
                let response = submit_encoder_texture_runtime(
                    generation,
                    ticket,
                    input_pts_100ns,
                    duration_100ns,
                    submitted_at_micros,
                    texture_pool,
                    media_runtime,
                );
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::PollEncoder { role, reply } => {
                let response = poll_encoder_runtime(generation, role, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::DrainEncoder {
                role,
                timeout_ms,
                reply,
            } => {
                let response = drain_encoder_runtime(generation, role, timeout_ms, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::FlushEncoder {
                role,
                timeout_ms,
                reply,
            } => {
                let response = flush_encoder_runtime(generation, role, timeout_ms, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::ShutdownEncoder {
                role,
                timeout_ms,
                reply,
            } => {
                let response =
                    shutdown_encoder_runtime(generation, role, timeout_ms, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::ConfigurePreview { placement, reply } => {
                let response =
                    configure_preview_runtime(generation, placement, device, media_runtime);
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::PreviewStatus { reply } => {
                let response = if let Some(presenter) = media_runtime.presenter.as_ref() {
                    Ok(presenter.status())
                } else {
                    Err(media_runtime
                        .presenter_last_error
                        .clone()
                        .unwrap_or_else(|| {
                            WindowsD3d11Error::new(
                                WindowsD3d11ErrorCode::CompositorUnavailable,
                                "backend D3D11 presenter is not configured",
                            )
                        }))
                };
                let _ = reply.try_send(response);
                false
            }
            WindowsD3d11MediaCommand::DestroyPreview { reply } => {
                let destroyed = media_runtime.presenter.take().is_some();
                media_runtime.presenter_last_error = Some(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::CompositorUnavailable,
                    "windows-d3d11-preview-destroyed",
                ));
                let _ = reply.try_send(Ok(destroyed));
                false
            }
        }
    }

    fn configure_preview_runtime(
        generation: u64,
        placement: WindowsD3d11PreviewPlacement,
        device: &WindowsD3d11Device,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
        if placement.media_generation != generation
            || placement.adapter_luid != device.adapter_luid()
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                "preview placement does not match the active media authority",
            ));
        }
        let recreate = media_runtime.presenter.as_ref().is_some_and(|presenter| {
            presenter.target_window_handle() != placement.target_window_handle
        });
        if recreate {
            media_runtime.presenter = None;
        }
        let response = if let Some(presenter) = media_runtime.presenter.as_mut() {
            presenter.configure(device, placement)
        } else {
            WindowsD3d11Presenter::create(device, generation, placement).map(|presenter| {
                let status = presenter.status();
                media_runtime.presenter = Some(presenter);
                status
            })
        };
        match response {
            Ok(status) => {
                media_runtime.presenter_last_error = None;
                Ok(status)
            }
            Err(error) => {
                media_runtime.presenter_last_error = Some(error.clone());
                Err(error)
            }
        }
    }

    fn create_encoder_runtime(
        generation: u64,
        role: WindowsD3d11MediaRole,
        config: MediaFoundationEncoderConfig,
        in_flight_capacity: usize,
        device: &WindowsD3d11Device,
        texture_pool: &WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderStatus, WindowsD3d11Error> {
        let encoder_role = encoder_role(role)?;
        if media_runtime.encoders.contains_key(&role) {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::EncoderUnavailable,
                format!("the media thread already owns a {role:?} encoder"),
            ));
        }
        let dimensions = WindowsD3d11Nv12TextureDescriptor::new(config.width, config.height)
            .map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                    format!("{role:?} encoder profile is invalid: {error}"),
                )
            })?
            .dimensions();
        let pool_capacity = texture_pool
            .config
            .slot_capacity(WindowsD3d11TextureFormat::Nv12, dimensions);
        if pool_capacity == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                format!(
                    "{role:?} encoder {}x{} has no dimension-keyed NV12 texture bucket",
                    config.width, config.height
                ),
            ));
        }
        if in_flight_capacity == 0 || in_flight_capacity > pool_capacity {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                format!(
                    "{role:?} encoder in-flight capacity must be between 1 and its {}x{} NV12 bucket size {pool_capacity}, got {in_flight_capacity}",
                    dimensions.width, dimensions.height
                ),
            ));
        }
        let encoder = MediaFoundationD3d11H264Encoder::new_on_media_thread(
            config,
            device,
            generation,
            encoder_role,
            in_flight_capacity,
        )
        .map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::EncoderUnavailable,
                format!("creating the {role:?} D3D11 Media Foundation encoder failed: {error}"),
            )
        })?;
        let runtime = WindowsD3d11EncoderRuntime {
            role,
            encoder,
            retained_tickets: BTreeMap::new(),
        };
        let status = runtime.status();
        media_runtime.encoders.insert(role, runtime);
        Ok(status)
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_encoder_texture_runtime(
        generation: u64,
        ticket: WindowsD3d11TextureLeaseTicket,
        input_pts_100ns: i64,
        duration_100ns: i64,
        submitted_at_micros: u64,
        texture_pool: &WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11EncoderSubmissionFailure> {
        let ticket_metadata = ticket.metadata();
        let role = ticket_metadata.role;
        let encoder_role = encoder_role(role).map_err(encoder_submission_error)?;
        if ticket_metadata.generation != generation
            || ticket_metadata.synchronization.generation != generation
            || ticket_metadata.format != WindowsD3d11TextureFormat::Nv12
        {
            return Err(encoder_submission_error(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                "encoder command received a stale or non-NV12 texture ticket",
            )));
        }
        let texture = texture_pool
            .texture_for_ticket(&ticket)
            .map_err(encoder_submission_error)?;
        let runtime = media_runtime
            .encoders
            .get_mut(&role)
            .ok_or_else(|| encoder_submission_error(encoder_missing(role)))?;
        let lease_id = ticket_metadata.lease_id.as_u64();
        if runtime.retained_tickets.contains_key(&lease_id) {
            return Err(encoder_submission_error(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::InvalidLease,
                format!("{role:?} encoder already retains texture lease {lease_id}"),
            )));
        }
        let metadata = WindowsD3d11EncoderSubmissionMetadata {
            generation,
            role: encoder_role,
            lease_id,
            input_pts_100ns,
            duration_100ns,
            submitted_at_micros,
        };
        match runtime.encoder.try_submit_nv12_texture(texture, metadata) {
            Ok(progress) => {
                runtime.retained_tickets.insert(lease_id, ticket);
                runtime
                    .apply_progress(generation, progress)
                    .map_err(encoder_submission_error)
            }
            Err(failure) => {
                let release_matches_ticket = failure.release.generation == generation
                    && failure.release.role == encoder_role
                    && failure.release.lease_id == lease_id;
                let error_code =
                    if failure.kind == MediaFoundationD3d11SubmissionFailureKind::Backpressure {
                        WindowsD3d11ErrorCode::EncoderBackpressure
                    } else {
                        WindowsD3d11ErrorCode::EncoderUnavailable
                    };
                let detail = failure.to_string();
                let progress = runtime
                    .apply_progress(generation, failure.progress)
                    .map_err(encoder_submission_error)?;
                if !release_matches_ticket {
                    return Err(WindowsD3d11EncoderSubmissionFailure {
                        error: WindowsD3d11Error::new(
                            WindowsD3d11ErrorCode::InvalidLease,
                            "Media Foundation rejected a ticket with a mismatched explicit release",
                        ),
                        progress: Some(progress),
                    });
                }
                // `ticket` was never inserted after a rejected ProcessInput.
                // Its Drop sends the explicit unsubmitted role release.
                Err(WindowsD3d11EncoderSubmissionFailure {
                    error: WindowsD3d11Error::new(error_code, detail),
                    progress: Some(progress),
                })
            }
        }
    }

    fn poll_encoder_runtime(
        generation: u64,
        role: WindowsD3d11MediaRole,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
        let runtime = media_runtime
            .encoders
            .get_mut(&role)
            .ok_or_else(|| encoder_missing(role))?;
        let progress = runtime.encoder.poll().map_err(|error| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::EncoderUnavailable,
                format!("polling the {role:?} Media Foundation encoder failed: {error}"),
            )
        })?;
        runtime.apply_progress(generation, progress)
    }

    fn drain_encoder_runtime(
        generation: u64,
        role: WindowsD3d11MediaRole,
        timeout_ms: u32,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
        validate_encoder_wait(role, timeout_ms)?;
        let runtime = media_runtime
            .encoders
            .get_mut(&role)
            .ok_or_else(|| encoder_missing(role))?;
        let progress = runtime
            .encoder
            .drain(Duration::from_millis(u64::from(timeout_ms)))
            .map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::EncoderUnavailable,
                    format!("draining the {role:?} Media Foundation encoder failed: {error}"),
                )
            })?;
        runtime.apply_progress(generation, progress)
    }

    fn flush_encoder_runtime(
        generation: u64,
        role: WindowsD3d11MediaRole,
        timeout_ms: u32,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
        validate_encoder_wait(role, timeout_ms)?;
        let runtime = media_runtime
            .encoders
            .get_mut(&role)
            .ok_or_else(|| encoder_missing(role))?;
        let released_leases = runtime
            .encoder
            .flush(Duration::from_millis(u64::from(timeout_ms)))
            .map_err(|error| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::EncoderUnavailable,
                    format!("flushing the {role:?} Media Foundation encoder failed: {error}"),
                )
            })?;
        runtime.apply_progress(
            generation,
            MediaFoundationD3d11EncoderProgress {
                encoded_frames: Vec::new(),
                released_leases,
            },
        )
    }

    fn shutdown_encoder_runtime(
        generation: u64,
        role: WindowsD3d11MediaRole,
        timeout_ms: u32,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11EncoderProgress, WindowsD3d11Error> {
        let progress = flush_encoder_runtime(generation, role, timeout_ms, media_runtime)?;
        let runtime = media_runtime
            .encoders
            .get(&role)
            .ok_or_else(|| encoder_missing(role))?;
        if !runtime.encoder.is_drained() || !runtime.retained_tickets.is_empty() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::EncoderUnavailable,
                format!(
                    "{role:?} encoder shutdown retained {} callback-owned texture leases",
                    runtime.retained_tickets.len()
                ),
            ));
        }
        media_runtime.encoders.remove(&role);
        Ok(progress)
    }

    fn encoder_missing(role: WindowsD3d11MediaRole) -> WindowsD3d11Error {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::EncoderUnavailable,
            format!("the media thread does not own a {role:?} encoder"),
        )
    }

    fn encoder_submission_error(error: WindowsD3d11Error) -> WindowsD3d11EncoderSubmissionFailure {
        WindowsD3d11EncoderSubmissionFailure {
            error,
            progress: None,
        }
    }

    fn start_capture_runtime(
        plan: WindowsD3d11CapturePlan,
        device: &WindowsD3d11Device,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11CaptureSession, WindowsD3d11Error> {
        if media_runtime.capture.is_some() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CaptureUnavailable,
                "the media thread already owns an active capture runtime",
            ));
        }
        let capture = match plan.backend {
            WindowsD3d11CaptureBackend::DesktopDuplication => {
                WindowsD3d11CaptureRuntime::DesktopDuplication {
                    plan,
                    capture: WindowsD3d11DesktopDuplicationCapture::create(device, plan)
                        .map_err(map_capture_error)?,
                    state: WindowsD3d11DesktopDuplicationState::new(
                        plan.generation,
                        plan.cursor_requested,
                    )
                    .map_err(map_capture_error)?,
                }
            }
            WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor => {
                WindowsD3d11CaptureRuntime::WindowsGraphicsCapture {
                    plan,
                    capture: WindowsD3d11WgcMonitorCapture::create(device, plan)
                        .map_err(map_capture_error)?,
                    next_sequence: 1,
                }
            }
        };
        let kind = capture.kind();
        let diagnostics = capture.diagnostics();
        media_runtime
            .contract
            .start_capture(plan.generation, kind)?;
        media_runtime.capture = Some(capture);
        Ok(WindowsD3d11CaptureSession { plan, diagnostics })
    }

    fn acquire_capture_submission(
        generation: u64,
        timeout_ms: u32,
        consumers: Vec<WindowsD3d11MediaRole>,
        device: &mut WindowsD3d11Device,
        texture_pool: &mut WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<Option<WindowsD3d11RawCaptureSubmission>, WindowsD3d11Error> {
        media_runtime.contract.require_capture(generation)?;
        if timeout_ms > MAX_CAPTURE_WAIT_MS {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                "capture command exceeded the bounded wait contract",
            ));
        }
        validate_consumer_roles("captured BGRA", &consumers, false)?;
        texture_pool.refresh_completed(device)?;
        let dimensions = texture_pool.config.capture_bgra_dimensions();
        let producer = texture_pool
            .state
            .acquire_for_write_dimensions(WindowsD3d11TextureFormat::Bgra8Unorm, dimensions)?;
        let acquisition =
            (|| -> Result<Option<WindowsD3d11CaptureSubmissionMetadata>, WindowsD3d11Error> {
                let destination = texture_pool.texture_for_producer(producer)?;
                let capture = media_runtime.capture.as_mut().ok_or_else(|| {
                    WindowsD3d11Error::new(
                        WindowsD3d11ErrorCode::CaptureUnavailable,
                        "capture authority exists without a runtime object",
                    )
                })?;
                match capture {
                    WindowsD3d11CaptureRuntime::DesktopDuplication {
                        plan,
                        capture,
                        state,
                    } => {
                        let acquisition = capture
                            .acquire_into(device, destination, timeout_ms)
                            .map_err(map_capture_error)?;
                        let Some(acquisition) = acquisition else {
                            return Ok(None);
                        };
                        let decision = state
                            .observe(acquisition.observation)
                            .map_err(map_capture_error)?;
                        if !decision.publish {
                            capture.record_decision(decision);
                            return Ok(None);
                        }
                        if decision.composite_pointer
                            || decision.clear_previous_pointer
                            || decision.use_cached_uncomposited_desktop
                        {
                            let compositor = media_runtime
                                .compositor
                                .as_mut()
                                .map_err(|error| map_compositor_error(error.clone()))?;
                            compositor
                                .composite_duplication_pointer(
                                    device,
                                    destination,
                                    acquisition.copied_before_release,
                                    decision.use_cached_uncomposited_desktop,
                                    acquisition.observation.pointer.visible,
                                    WindowsD3d11Point {
                                        x: acquisition.observation.pointer.x,
                                        y: acquisition.observation.pointer.y,
                                    },
                                    acquisition.rotation,
                                    acquisition.observation.pointer.shape_revision,
                                    acquisition.pointer_shape.as_ref(),
                                )
                                .map_err(map_compositor_error)?;
                        }
                        capture.record_decision(decision);
                        Ok(WindowsD3d11CaptureSubmissionMetadata::desktop_duplication(
                            *plan,
                            decision,
                            acquisition.observation,
                            acquisition.rotation,
                        ))
                    }
                    WindowsD3d11CaptureRuntime::WindowsGraphicsCapture {
                        plan,
                        capture,
                        next_sequence,
                    } => {
                        let timestamp = capture
                            .copy_latest_into(device, destination)
                            .map_err(map_capture_error)?;
                        let Some(timestamp) = timestamp else {
                            return Ok(None);
                        };
                        let sequence = *next_sequence;
                        *next_sequence = next_sequence.checked_add(1).ok_or_else(|| {
                            WindowsD3d11Error::new(
                                WindowsD3d11ErrorCode::CaptureUnavailable,
                                "WGC capture sequence was exhausted",
                            )
                        })?;
                        Ok(Some(
                            WindowsD3d11CaptureSubmissionMetadata::windows_graphics_capture(
                                *plan,
                                sequence,
                                timestamp,
                                capture.rotation(),
                            )
                            .map_err(map_capture_error)?,
                        ))
                    }
                }
            })();
        let acquisition = match acquisition {
            Ok(acquisition) => acquisition,
            Err(error) => {
                let _ = texture_pool.state.cancel_write(producer);
                return Err(error);
            }
        };
        let Some(metadata) = acquisition else {
            texture_pool.state.cancel_write(producer)?;
            return Ok(None);
        };
        let published = match texture_pool.state.publish(producer, consumers) {
            Ok(published) => published,
            Err(error) => {
                let _ = texture_pool.state.cancel_write(producer);
                return Err(error);
            }
        };
        device.signal(published.synchronization.fence_value)?;
        Ok(Some(WindowsD3d11RawCaptureSubmission {
            metadata,
            lease: published,
            dimensions,
        }))
    }

    fn compose_scene_submission(
        generation: u64,
        plan: &WindowsD3d11ScenePlan,
        sources: &[WindowsD3d11CompositionSource],
        consumers: &WindowsD3d11CompositionConsumers,
        device: &mut WindowsD3d11Device,
        texture_pool: &mut WindowsD3d11TexturePoolOwner,
        media_runtime: &mut WindowsD3d11MediaRuntimeState,
    ) -> Result<WindowsD3d11RawCompositionSubmission, WindowsD3d11Error> {
        media_runtime.contract.require_compositor(generation)?;
        let preview_requested = !consumers.preview.is_empty();
        let preview_dimensions = texture_pool.config.preview_bgra_dimensions();
        if preview_requested
            && (plan.canvas_dimensions.width != preview_dimensions.width
                || plan.canvas_dimensions.height != preview_dimensions.height)
        {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                format!(
                    "scene canvas {}x{} does not match the preview BGRA bucket {}x{}",
                    plan.canvas_dimensions.width,
                    plan.canvas_dimensions.height,
                    preview_dimensions.width,
                    preview_dimensions.height
                ),
            ));
        }
        for output in &plan.encoded_outputs {
            let dimensions = WindowsD3d11TextureDimensions {
                width: output.dimensions.width,
                height: output.dimensions.height,
            };
            if texture_pool
                .config
                .slot_capacity(WindowsD3d11TextureFormat::Nv12, dimensions)
                == 0
            {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::InvalidTextureDescriptor,
                    format!(
                        "{} NV12 output {}x{} has no dimension-keyed texture bucket",
                        match output.role {
                            WindowsD3d11EncodedOutputRole::Primary => "primary",
                            WindowsD3d11EncodedOutputRole::Auxiliary => "auxiliary",
                        },
                        output.dimensions.width,
                        output.dimensions.height
                    ),
                ));
            }
        }

        texture_pool.refresh_completed(device)?;
        let preview_producer = preview_requested
            .then(|| {
                texture_pool.state.acquire_for_write_dimensions(
                    WindowsD3d11TextureFormat::Bgra8Unorm,
                    preview_dimensions,
                )
            })
            .transpose()?;
        let mut encoded_producers = Vec::with_capacity(plan.encoded_outputs.len());
        for output in &plan.encoded_outputs {
            match texture_pool.state.acquire_for_write_dimensions(
                WindowsD3d11TextureFormat::Nv12,
                WindowsD3d11TextureDimensions {
                    width: output.dimensions.width,
                    height: output.dimensions.height,
                },
            ) {
                Ok(producer) => encoded_producers.push((*output, producer)),
                Err(error) => {
                    if let Some(preview_producer) = preview_producer {
                        let _ = texture_pool.state.cancel_write(preview_producer);
                    }
                    cancel_producers(texture_pool, &encoded_producers);
                    return Err(error);
                }
            }
        }

        let composition = (|| {
            let mut gpu_sources = Vec::with_capacity(sources.len());
            for source in sources {
                match source {
                    WindowsD3d11CompositionSource::TextureLease { source_id, ticket } => {
                        gpu_sources.push(WindowsD3d11GpuSource {
                            source_id: *source_id,
                            content: WindowsD3d11GpuSourceContent::Texture(
                                texture_pool.texture_for_ticket(ticket)?,
                            ),
                        });
                    }
                    WindowsD3d11CompositionSource::BgraUpload {
                        source_id,
                        pixels,
                        dimensions,
                        row_pitch,
                        pixel_order,
                        content_revision,
                        immutable,
                    } => {
                        gpu_sources.push(WindowsD3d11GpuSource {
                            source_id: *source_id,
                            content: WindowsD3d11GpuSourceContent::Upload(WindowsD3d11BgraUpload {
                                pixels,
                                dimensions: *dimensions,
                                row_pitch: *row_pitch,
                                pixel_order: *pixel_order,
                                content_revision: *content_revision,
                                immutable: *immutable,
                            }),
                        });
                    }
                }
            }
            let preview_texture = preview_producer
                .map(|producer| texture_pool.texture_for_producer(producer))
                .transpose()?;
            let mut encoded_targets = Vec::with_capacity(encoded_producers.len());
            for (output, producer) in &encoded_producers {
                encoded_targets.push(WindowsD3d11EncodedTarget {
                    role: output.role,
                    texture: texture_pool.texture_for_producer(*producer)?,
                });
            }
            let compositor = media_runtime
                .compositor
                .as_mut()
                .map_err(|error| map_compositor_error(error.clone()))?;
            let frame = compositor
                .compose(
                    device,
                    plan,
                    &gpu_sources,
                    WindowsD3d11GpuTargets {
                        preview_bgra: preview_texture,
                        encoded_nv12: &encoded_targets,
                    },
                )
                .map_err(map_compositor_error)?;
            Ok::<_, WindowsD3d11Error>((frame, compositor.diagnostics()))
        })();
        let (frame, diagnostics) = match composition {
            Ok(value) => value,
            Err(error) => {
                if let Some(preview_producer) = preview_producer {
                    let _ = texture_pool.state.cancel_write(preview_producer);
                }
                cancel_producers(texture_pool, &encoded_producers);
                return Err(error);
            }
        };

        let mut batch =
            Vec::with_capacity(usize::from(preview_requested) + encoded_producers.len());
        if let Some(preview_producer) = preview_producer {
            batch.push((preview_producer, consumers.preview.clone()));
        }
        for (output, producer) in &encoded_producers {
            batch.push((*producer, consumers.for_output(output.role).clone()));
        }
        let published = match texture_pool.state.publish_batch(batch) {
            Ok(published) => published,
            Err(error) => {
                if let Some(preview_producer) = preview_producer {
                    let _ = texture_pool.state.cancel_write(preview_producer);
                }
                cancel_producers(texture_pool, &encoded_producers);
                return Err(error);
            }
        };
        let last_fence = published
            .last()
            .expect("composition always publishes at least one target")
            .synchronization
            .fence_value;
        device.signal(last_fence)?;

        let mut textures = Vec::with_capacity(published.len());
        let encoded_offset = usize::from(preview_requested);
        for (index, lease) in published.into_iter().enumerate() {
            if preview_requested && index == 0 {
                textures.push(WindowsD3d11RawComposedTexture {
                    kind: WindowsD3d11ComposedTextureKind::PreviewBgra,
                    lease,
                    dimensions: plan.canvas_dimensions,
                });
                continue;
            }
            let output = plan.encoded_outputs[index - encoded_offset];
            textures.push(WindowsD3d11RawComposedTexture {
                kind: match output.role {
                    WindowsD3d11EncodedOutputRole::Primary => {
                        WindowsD3d11ComposedTextureKind::PrimaryNv12
                    }
                    WindowsD3d11EncodedOutputRole::Auxiliary => {
                        WindowsD3d11ComposedTextureKind::AuxiliaryNv12
                    }
                },
                lease,
                dimensions: output.dimensions,
            });
        }
        Ok(WindowsD3d11RawCompositionSubmission {
            frame,
            diagnostics,
            textures,
        })
    }

    fn cancel_producers(
        texture_pool: &mut WindowsD3d11TexturePoolOwner,
        producers: &[(
            crate::windows_d3d11_compositor::WindowsD3d11EncodedOutputPlan,
            WindowsD3d11ProducerTextureLease,
        )],
    ) {
        for (_, producer) in producers {
            let _ = texture_pool.state.cancel_write(*producer);
        }
    }

    fn map_capture_error(error: WindowsD3d11CaptureError) -> WindowsD3d11Error {
        WindowsD3d11Error::new(
            if error.reason == WindowsD3d11CaptureFallbackReason::DeviceLost {
                WindowsD3d11ErrorCode::DeviceLost
            } else {
                WindowsD3d11ErrorCode::CaptureUnavailable
            },
            error.to_string(),
        )
    }

    fn map_compositor_error(error: WindowsD3d11CompositorError) -> WindowsD3d11Error {
        WindowsD3d11Error::new(
            if error.code == WindowsD3d11CompositorErrorCode::DeviceLost {
                WindowsD3d11ErrorCode::DeviceLost
            } else {
                WindowsD3d11ErrorCode::CompositorUnavailable
            },
            error.to_string(),
        )
    }

    fn render_test_pattern_submission(
        sequence: u64,
        consumers: Vec<WindowsD3d11MediaRole>,
        device: &mut WindowsD3d11Device,
        texture_pool: &mut WindowsD3d11TexturePoolOwner,
    ) -> Result<WindowsD3d11TestPatternSubmission, WindowsD3d11Error> {
        texture_pool.refresh_completed(device)?;
        let dimensions = texture_pool.config.capture_bgra_dimensions();
        let producer = texture_pool
            .state
            .acquire_for_write_dimensions(WindowsD3d11TextureFormat::Bgra8Unorm, dimensions)?;
        let metadata = (|| {
            let destination = texture_pool.texture_for_producer(producer)?;
            render_bgra_test_pattern(device, destination, texture_pool.config.bgra, sequence)
        })();
        let metadata = match metadata {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = texture_pool.state.cancel_write(producer);
                return Err(error);
            }
        };
        let published = match texture_pool.state.publish(producer, consumers) {
            Ok(published) => published,
            Err(error) => {
                let _ = texture_pool.state.cancel_write(producer);
                return Err(error);
            }
        };
        device.signal(published.synchronization.fence_value)?;
        Ok(WindowsD3d11TestPatternSubmission {
            texture: published,
            metadata,
        })
    }
}

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub(crate) use runtime::{
    WindowsD3d11CaptureFrameSubmission, WindowsD3d11CaptureSession,
    WindowsD3d11ComposedTextureKind, WindowsD3d11CompositionConsumers,
    WindowsD3d11CompositionSource, WindowsD3d11CompositionSubmission, WindowsD3d11Device,
    WindowsD3d11EncoderProgress, WindowsD3d11EncoderStatus, WindowsD3d11EncoderSubmissionFailure,
    WindowsD3d11MediaClient, WindowsD3d11MediaThread, WindowsD3d11PreviewOffer,
    WindowsD3d11TestPatternSubmission, WindowsD3d11TicketedTexture,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_config(bgra_slots: usize, nv12_slots: usize) -> WindowsD3d11TexturePoolConfig {
        WindowsD3d11TexturePoolConfig::new(
            WindowsD3d11BgraTextureDescriptor::new(1920, 1080).unwrap(),
            bgra_slots,
            WindowsD3d11Nv12TextureDescriptor::new(1920, 1080).unwrap(),
            nv12_slots,
        )
        .unwrap()
    }

    #[test]
    fn windows_d3d11_latency_samples_are_bounded_and_report_p95_and_max() {
        let mut samples = WindowsD3d11LatencySamples::default();
        for value in 1..=100_u64 {
            samples.observe(value);
        }
        assert_eq!(samples.p95(), 95);
        assert_eq!(samples.max, 100);

        for value in 101..=400_u64 {
            samples.observe(value);
        }
        assert_eq!(samples.len, WINDOWS_D3D11_LATENCY_SAMPLE_CAPACITY);
        assert!(samples.p95() >= 380);
        assert_eq!(samples.max, 400);
    }

    #[test]
    fn canonical_dxgi_screen_id_round_trips_adapter_and_output() {
        let selection =
            WindowsDxgiOutputSelection::parse("screen:dxgi:89abcdef01234567:12").unwrap();
        assert_eq!(
            selection.adapter_luid,
            DxgiAdapterLuid::from_u64(0x89ab_cdef_0123_4567)
        );
        assert_eq!(selection.output_index, 12);
        assert_eq!(selection.screen_id(), "screen:dxgi:89abcdef01234567:12");
    }

    #[test]
    fn windows_d3d11_adapter_selection_rejects_invalid_screen_ids() {
        for screen_id in [
            "screen:dxgi:1:0",
            "screen:dxgi:89ABCDEF01234567:0",
            "screen:dxgi:89abcdef01234567:00",
            "screen:dxgi:89abcdef01234567:+1",
            "screen:dxgi:89abcdef01234567:4294967296",
            "screen:gdigrab:desktop",
        ] {
            let error = WindowsDxgiOutputSelection::parse(screen_id).unwrap_err();
            assert_eq!(error.code, WindowsD3d11ErrorCode::InvalidScreenId);
        }
    }

    #[test]
    fn windows_d3d11_texture_descriptor_validates_format_and_dimensions() {
        assert!(WindowsD3d11BgraTextureDescriptor::new(1, 1).is_ok());
        assert!(WindowsD3d11Nv12TextureDescriptor::new(1920, 1080).is_ok());
        assert!(WindowsD3d11Nv12TextureDescriptor::new(1919, 1080).is_err());
        assert!(WindowsD3d11Nv12TextureDescriptor::new(1920, 1079).is_err());
        assert!(
            WindowsD3d11BgraTextureDescriptor::new(D3D11_MAX_TEXTURE_DIMENSION + 1, 1).is_err()
        );
        assert!(WindowsD3d11BgraTextureDescriptor::new(0, 1080).is_err());
        assert!(
            WindowsD3d11TexturePoolConfig::new(
                WindowsD3d11BgraTextureDescriptor::new(1920, 1080).unwrap(),
                D3D11_MAX_TEXTURES_PER_FORMAT + 1,
                WindowsD3d11Nv12TextureDescriptor::new(1920, 1080).unwrap(),
                1,
            )
            .is_err()
        );
    }

    #[test]
    fn windows_d3d11_media_authority_orders_capture_and_compositor_commands() {
        let mut authority = WindowsD3d11MediaAuthorityState::new(7, true).unwrap();
        assert_eq!(
            authority.require_capture(7).unwrap_err().code,
            WindowsD3d11ErrorCode::CaptureUnavailable
        );
        authority
            .start_capture(7, WindowsD3d11CaptureAuthorityKind::DesktopDuplication)
            .unwrap();
        assert_eq!(
            authority.require_capture(7).unwrap(),
            WindowsD3d11CaptureAuthorityKind::DesktopDuplication
        );
        assert_eq!(
            authority
                .start_capture(7, WindowsD3d11CaptureAuthorityKind::WindowsGraphicsCapture,)
                .unwrap_err()
                .code,
            WindowsD3d11ErrorCode::CaptureUnavailable
        );
        authority.require_compositor(7).unwrap();
        assert!(authority.stop_capture(7).unwrap());
        assert!(!authority.stop_capture(7).unwrap());
        assert_eq!(
            authority.require_compositor(8).unwrap_err().code,
            WindowsD3d11ErrorCode::StaleGeneration
        );
    }

    #[test]
    fn windows_d3d11_media_authority_preserves_capture_when_compositor_is_unavailable() {
        let mut authority = WindowsD3d11MediaAuthorityState::new(11, false).unwrap();
        authority
            .start_capture(11, WindowsD3d11CaptureAuthorityKind::WindowsGraphicsCapture)
            .unwrap();
        assert_eq!(
            authority.require_compositor(11).unwrap_err().code,
            WindowsD3d11ErrorCode::CompositorUnavailable
        );
        assert_eq!(
            authority.require_capture(11).unwrap(),
            WindowsD3d11CaptureAuthorityKind::WindowsGraphicsCapture
        );
    }

    #[test]
    fn windows_d3d11_pool_batch_publication_is_atomic() {
        let mut pool = WindowsD3d11BoundedTexturePool::new(13, pool_config(1, 1)).unwrap();
        let bgra = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let nv12 = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Nv12)
            .unwrap();
        assert_eq!(
            pool.publish_batch(vec![
                (bgra, vec![WindowsD3d11MediaRole::Preview]),
                (nv12, Vec::new()),
            ])
            .unwrap_err()
            .code,
            WindowsD3d11ErrorCode::InvalidLease
        );
        pool.cancel_write(bgra).unwrap();
        pool.cancel_write(nv12).unwrap();

        let replacement = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let published = pool
            .publish(replacement, [WindowsD3d11MediaRole::Preview])
            .unwrap();
        assert_eq!(
            published.synchronization.fence_value, 1,
            "a failed batch must not consume fence values or partially publish"
        );
    }

    #[test]
    fn windows_d3d11_compositor_source_requires_live_role_bound_ticket() {
        let mut pool = WindowsD3d11BoundedTexturePool::new(17, pool_config(1, 1)).unwrap();
        let producer = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let published = pool
            .publish(
                producer,
                [
                    WindowsD3d11MediaRole::Compositor,
                    WindowsD3d11MediaRole::Preview,
                ],
            )
            .unwrap();
        let metadata = WindowsD3d11TextureLeaseMetadata {
            generation: 17,
            lease_id: published.lease_id,
            adapter_luid: DxgiAdapterLuid::from_u64(99),
            width: 1920,
            height: 1080,
            format: WindowsD3d11TextureFormat::Bgra8Unorm,
            sequence: 3,
            synchronization: published.synchronization,
            role: WindowsD3d11MediaRole::Compositor,
        };
        assert_eq!(
            pool.validate_read_ticket(metadata).unwrap(),
            producer.slot_id
        );

        let wrong_role = WindowsD3d11TextureLeaseMetadata {
            role: WindowsD3d11MediaRole::Record,
            ..metadata
        };
        assert_eq!(
            pool.validate_read_ticket(wrong_role).unwrap_err().code,
            WindowsD3d11ErrorCode::RoleNotHeld
        );
        assert!(
            !pool
                .release_role(WindowsD3d11LeaseRelease {
                    generation: 17,
                    lease_id: published.lease_id,
                    role: WindowsD3d11MediaRole::Compositor,
                })
                .unwrap()
        );
        assert_eq!(
            pool.validate_read_ticket(metadata).unwrap_err().code,
            WindowsD3d11ErrorCode::RoleNotHeld
        );
    }

    #[test]
    fn windows_d3d11_pool_reserves_capture_preview_and_encoded_targets() {
        let mut pool = WindowsD3d11BoundedTexturePool::new(19, pool_config(2, 2)).unwrap();
        let capture = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let preview = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let primary = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Nv12)
            .unwrap();
        let auxiliary = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Nv12)
            .unwrap();
        assert_eq!(
            pool.acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
                .unwrap_err()
                .code,
            WindowsD3d11ErrorCode::TexturePoolExhausted
        );
        assert_eq!(
            pool.acquire_for_write(WindowsD3d11TextureFormat::Nv12)
                .unwrap_err()
                .code,
            WindowsD3d11ErrorCode::TexturePoolExhausted
        );
        for producer in [capture, preview, primary, auxiliary] {
            pool.cancel_write(producer).unwrap();
        }
    }

    #[test]
    fn windows_d3d11_pool_never_reuses_an_active_lease() {
        let mut pool = WindowsD3d11BoundedTexturePool::new(7, pool_config(1, 1)).unwrap();
        let producer = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        let published = pool
            .publish(
                producer,
                [
                    WindowsD3d11MediaRole::Preview,
                    WindowsD3d11MediaRole::Stream,
                ],
            )
            .unwrap();
        assert_eq!(published.synchronization.fence_value, 1);
        assert!(
            pool.acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
                .is_err()
        );
        assert!(
            !pool
                .release_role(WindowsD3d11LeaseRelease {
                    generation: 7,
                    lease_id: published.lease_id,
                    role: WindowsD3d11MediaRole::Preview,
                })
                .unwrap()
        );
        assert!(
            pool.acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
                .is_err()
        );
        assert!(
            pool.release_role(WindowsD3d11LeaseRelease {
                generation: 7,
                lease_id: published.lease_id,
                role: WindowsD3d11MediaRole::Stream,
            })
            .unwrap()
        );
        assert!(
            pool.acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
                .is_err(),
            "role release alone cannot bypass the producer fence"
        );
        pool.observe_completed_fence(1).unwrap();
        let reused = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Bgra8Unorm)
            .unwrap();
        assert_eq!(reused.slot_id, producer.slot_id);
        assert_ne!(reused.lease_id, producer.lease_id);
    }

    #[test]
    fn pool_rejects_duplicate_roles_stale_generations_and_fence_regressions() {
        let mut pool = WindowsD3d11BoundedTexturePool::new(3, pool_config(1, 1)).unwrap();
        let producer = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Nv12)
            .unwrap();
        let duplicate = pool
            .publish(
                producer,
                [WindowsD3d11MediaRole::Record, WindowsD3d11MediaRole::Record],
            )
            .unwrap_err();
        assert_eq!(duplicate.code, WindowsD3d11ErrorCode::InvalidLease);
        pool.cancel_write(producer).unwrap();
        let producer = pool
            .acquire_for_write(WindowsD3d11TextureFormat::Nv12)
            .unwrap();
        let published = pool
            .publish(producer, [WindowsD3d11MediaRole::Record])
            .unwrap();
        pool.observe_completed_fence(1).unwrap();
        assert_eq!(
            pool.observe_completed_fence(0).unwrap_err().code,
            WindowsD3d11ErrorCode::FenceTimelineViolation
        );
        assert_eq!(
            pool.release_role(WindowsD3d11LeaseRelease {
                generation: 2,
                lease_id: published.lease_id,
                role: WindowsD3d11MediaRole::Record,
            })
            .unwrap_err()
            .code,
            WindowsD3d11ErrorCode::StaleGeneration
        );
    }

    #[test]
    fn preview_release_cannot_stop_active_stream_role() {
        let adapter = DxgiAdapterLuid::from_u64(42);
        let mut coordinator = WindowsD3d11MediaCoordinatorState::new(9).unwrap();
        let (preview, first_action) = coordinator
            .acquire(adapter, WindowsD3d11MediaRole::Preview)
            .unwrap();
        let (stream, second_action) = coordinator
            .acquire(adapter, WindowsD3d11MediaRole::Stream)
            .unwrap();
        assert_eq!(
            first_action,
            WindowsD3d11CoordinatorAcquireAction::StartMediaThread
        );
        assert_eq!(
            second_action,
            WindowsD3d11CoordinatorAcquireAction::ReuseMediaThread
        );
        assert_eq!(
            coordinator.release(preview).unwrap(),
            WindowsD3d11CoordinatorReleaseAction::KeepMediaThread
        );
        assert_eq!(
            coordinator.active_role_count(WindowsD3d11MediaRole::Stream),
            1
        );
        assert!(matches!(
            coordinator.release(stream).unwrap(),
            WindowsD3d11CoordinatorReleaseAction::DrainAndJoin {
                retired_generation: 9,
                next_generation: 10
            }
        ));
    }

    #[test]
    fn windows_d3d11_coordinator_rejects_cross_adapter_reuse() {
        let first_adapter = DxgiAdapterLuid::from_u64(1);
        let second_adapter = DxgiAdapterLuid::from_u64(2);
        let mut coordinator = WindowsD3d11MediaCoordinatorState::new(4).unwrap();
        let (lease, _) = coordinator
            .acquire(first_adapter, WindowsD3d11MediaRole::Record)
            .unwrap();
        assert_eq!(
            coordinator
                .acquire(second_adapter, WindowsD3d11MediaRole::Preview)
                .unwrap_err()
                .code,
            WindowsD3d11ErrorCode::AdapterMismatch
        );
        let reset = coordinator.retire_for_device_loss(4).unwrap();
        assert_eq!(
            reset,
            WindowsD3d11CoordinatorReleaseAction::DrainAndJoin {
                retired_generation: 4,
                next_generation: 5
            }
        );
        assert_eq!(
            coordinator.release(lease).unwrap_err().code,
            WindowsD3d11ErrorCode::StaleGeneration
        );
        assert_eq!(
            coordinator
                .acquire(first_adapter, WindowsD3d11MediaRole::Record)
                .unwrap_err()
                .code,
            WindowsD3d11ErrorCode::GenerationClosing
        );
        coordinator.finish_shutdown(4).unwrap();
        assert!(coordinator.finish_shutdown(4).is_err());
        let (replacement, action) = coordinator
            .acquire(first_adapter, WindowsD3d11MediaRole::Record)
            .unwrap();
        assert_eq!(replacement.generation, 5);
        assert_eq!(
            action,
            WindowsD3d11CoordinatorAcquireAction::StartMediaThread
        );
    }

    #[test]
    fn cloned_export_ticket_releases_role_exactly_once_on_last_drop() {
        let (release_sender, release_receiver) =
            WindowsD3d11TextureLeaseReleaseSender::bounded(1).unwrap();
        let metadata = WindowsD3d11TextureLeaseMetadata {
            generation: 2,
            lease_id: WindowsD3d11TextureLeaseId::from_u64(8),
            adapter_luid: DxgiAdapterLuid::from_u64(3),
            width: 1920,
            height: 1080,
            format: WindowsD3d11TextureFormat::Nv12,
            sequence: 17,
            synchronization: WindowsD3d11SynchronizationToken {
                generation: 2,
                fence_value: 9,
            },
            role: WindowsD3d11MediaRole::Stream,
        };
        let ticket = WindowsD3d11TextureLeaseTicket::new(metadata, release_sender.clone()).unwrap();
        let clone = ticket.clone();
        drop(ticket);
        assert!(matches!(
            release_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(clone);
        assert_eq!(
            release_receiver.recv().unwrap(),
            WindowsD3d11LeaseRelease {
                generation: 2,
                lease_id: WindowsD3d11TextureLeaseId::from_u64(8),
                role: WindowsD3d11MediaRole::Stream,
            }
        );
        assert_eq!(release_sender.failed_release_count(), 0);
    }

    #[test]
    fn full_drop_queue_fails_closed_without_blocking_or_recycling() {
        let (release_sender, release_receiver) =
            WindowsD3d11TextureLeaseReleaseSender::bounded(1).unwrap();
        release_sender.try_release(WindowsD3d11LeaseRelease {
            generation: 1,
            lease_id: WindowsD3d11TextureLeaseId::from_u64(1),
            role: WindowsD3d11MediaRole::Preview,
        });
        let ticket = WindowsD3d11TextureLeaseTicket::new(
            WindowsD3d11TextureLeaseMetadata {
                generation: 1,
                lease_id: WindowsD3d11TextureLeaseId::from_u64(2),
                adapter_luid: DxgiAdapterLuid::from_u64(3),
                width: 1280,
                height: 720,
                format: WindowsD3d11TextureFormat::Bgra8Unorm,
                sequence: 1,
                synchronization: WindowsD3d11SynchronizationToken {
                    generation: 1,
                    fence_value: 1,
                },
                role: WindowsD3d11MediaRole::Preview,
            },
            release_sender.clone(),
        )
        .unwrap();
        drop(ticket);
        assert_eq!(release_sender.failed_release_count(), 1);
        assert_eq!(
            release_receiver.recv().unwrap().lease_id,
            WindowsD3d11TextureLeaseId::from_u64(1)
        );
    }
}
