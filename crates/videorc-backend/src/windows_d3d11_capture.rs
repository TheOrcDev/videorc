use std::fmt;

use crate::windows_d3d11_device::{DxgiAdapterLuid, WindowsDxgiOutputSelection};

const MAX_POINTER_SHAPE_BYTES: usize = 1024 * 1024;
const MAX_DUPLICATION_RECOVERY_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CaptureBackend {
    DesktopDuplication,
    WindowsGraphicsCaptureMonitor,
}

impl WindowsD3d11CaptureBackend {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::DesktopDuplication => "desktop-duplication",
            Self::WindowsGraphicsCaptureMonitor => "windows-graphics-capture-monitor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CursorMode {
    Embedded,
    Separate,
    ExcludedWgc,
    DisabledFallback,
}

impl WindowsD3d11CursorMode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Separate => "separate",
            Self::ExcludedWgc => "excluded-wgc",
            Self::DisabledFallback => "disabled-fallback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CursorPixelsSource {
    DesktopSurface,
    DuplicationPointerShape,
    ExcludedByWindowsGraphicsCapture,
    LegacyFallback,
}

impl WindowsD3d11CursorPixelsSource {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::DesktopSurface => "desktop-surface",
            Self::DuplicationPointerShape => "duplication-pointer-shape",
            Self::ExcludedByWindowsGraphicsCapture => "excluded-by-wgc",
            Self::LegacyFallback => "legacy-fallback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CaptureFallbackReason {
    InvalidScreenId,
    AdapterMismatch,
    OutputUnavailable,
    DesktopDuplicationUnavailable,
    DesktopDuplicationAccessLost,
    DeviceLost,
    ProtectedContent,
    RemoteDesktopUnsupported,
    WgcUnavailable,
    WgcDirect3dInteropUnavailable,
    WgcCursorControlUnavailable,
    WgcCursorExclusionUnconfirmed,
    WgcFramePoolUnavailable,
    TextureContractMismatch,
    RotationNormalizationUnavailable,
    PointerShapeInvalid,
    RecoveryExhausted,
}

impl WindowsD3d11CaptureFallbackReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidScreenId => "d3d11-capture-invalid-screen-id",
            Self::AdapterMismatch => "d3d11-capture-adapter-mismatch",
            Self::OutputUnavailable => "d3d11-capture-output-unavailable",
            Self::DesktopDuplicationUnavailable => "d3d11-capture-desktop-duplication-unavailable",
            Self::DesktopDuplicationAccessLost => "d3d11-capture-desktop-duplication-access-lost",
            Self::DeviceLost => "d3d11-capture-device-lost",
            Self::ProtectedContent => "d3d11-capture-protected-content",
            Self::RemoteDesktopUnsupported => "d3d11-capture-remote-desktop-unsupported",
            Self::WgcUnavailable => "d3d11-capture-wgc-unavailable",
            Self::WgcDirect3dInteropUnavailable => "d3d11-capture-wgc-direct3d-interop-unavailable",
            Self::WgcCursorControlUnavailable => "d3d11-capture-wgc-cursor-control-unavailable",
            Self::WgcCursorExclusionUnconfirmed => "d3d11-capture-wgc-cursor-exclusion-unconfirmed",
            Self::WgcFramePoolUnavailable => "d3d11-capture-wgc-frame-pool-unavailable",
            Self::TextureContractMismatch => "d3d11-capture-texture-contract-mismatch",
            Self::RotationNormalizationUnavailable => {
                "d3d11-capture-rotation-normalization-unavailable"
            }
            Self::PointerShapeInvalid => "d3d11-capture-pointer-shape-invalid",
            Self::RecoveryExhausted => "d3d11-capture-recovery-exhausted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CaptureError {
    pub(crate) reason: WindowsD3d11CaptureFallbackReason,
    pub(crate) detail: String,
}

impl WindowsD3d11CaptureError {
    fn new(reason: WindowsD3d11CaptureFallbackReason, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for WindowsD3d11CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.reason.as_str(), self.detail)
    }
}

impl std::error::Error for WindowsD3d11CaptureError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11WgcCursorExclusionProbe {
    pub(crate) graphics_capture_supported: bool,
    pub(crate) direct3d_interop_supported: bool,
    pub(crate) same_adapter: bool,
    pub(crate) cursor_control_supported: bool,
    pub(crate) cursor_disable_set_succeeded: bool,
    pub(crate) cursor_disable_readback_confirmed: bool,
}

impl WindowsD3d11WgcCursorExclusionProbe {
    pub(crate) const fn confirmed(self) -> bool {
        self.graphics_capture_supported
            && self.direct3d_interop_supported
            && self.same_adapter
            && self.cursor_control_supported
            && self.cursor_disable_set_succeeded
            && self.cursor_disable_readback_confirmed
    }

    fn rejection_reason(self) -> WindowsD3d11CaptureFallbackReason {
        if !self.graphics_capture_supported {
            WindowsD3d11CaptureFallbackReason::WgcUnavailable
        } else if !self.direct3d_interop_supported || !self.same_adapter {
            WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable
        } else if !self.cursor_control_supported {
            WindowsD3d11CaptureFallbackReason::WgcCursorControlUnavailable
        } else {
            WindowsD3d11CaptureFallbackReason::WgcCursorExclusionUnconfirmed
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CapturePlan {
    pub(crate) selection: WindowsDxgiOutputSelection,
    pub(crate) generation: u64,
    pub(crate) backend: WindowsD3d11CaptureBackend,
    pub(crate) cursor_requested: bool,
    pub(crate) cursor_mode: Option<WindowsD3d11CursorMode>,
    pub(crate) cursor_pixels_source: Option<WindowsD3d11CursorPixelsSource>,
    pub(crate) cursor_exclusion_guaranteed: bool,
}

impl WindowsD3d11CapturePlan {
    pub(crate) fn resolve(
        screen_id: &str,
        capture_cursor: bool,
        session_adapter_luid: DxgiAdapterLuid,
        generation: u64,
        wgc_probe: WindowsD3d11WgcCursorExclusionProbe,
    ) -> Result<Self, WindowsD3d11CaptureError> {
        if generation == 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DeviceLost,
                "capture generation zero is reserved",
            ));
        }
        let selection = WindowsDxgiOutputSelection::parse(screen_id).map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::InvalidScreenId,
                error.to_string(),
            )
        })?;
        if selection.adapter_luid != session_adapter_luid {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::AdapterMismatch,
                format!(
                    "screen adapter {} does not match session adapter {}",
                    selection.adapter_luid, session_adapter_luid
                ),
            ));
        }
        if capture_cursor {
            return Ok(Self {
                selection,
                generation,
                backend: WindowsD3d11CaptureBackend::DesktopDuplication,
                cursor_requested: true,
                cursor_mode: None,
                cursor_pixels_source: None,
                cursor_exclusion_guaranteed: false,
            });
        }
        if !wgc_probe.confirmed() {
            let reason = wgc_probe.rejection_reason();
            return Err(WindowsD3d11CaptureError::new(
                reason,
                "cursor-disabled D3D11 capture requires confirmed WGC monitor cursor exclusion before StartCapture",
            ));
        }
        Ok(Self {
            selection,
            generation,
            backend: WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor,
            cursor_requested: false,
            cursor_mode: Some(WindowsD3d11CursorMode::ExcludedWgc),
            cursor_pixels_source: Some(
                WindowsD3d11CursorPixelsSource::ExcludedByWindowsGraphicsCapture,
            ),
            cursor_exclusion_guaranteed: true,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CaptureDiagnostics {
    pub(crate) generation: u64,
    pub(crate) adapter_luid: u64,
    pub(crate) output_index: u32,
    pub(crate) capture_backend: Option<WindowsD3d11CaptureBackend>,
    pub(crate) cursor_mode: Option<WindowsD3d11CursorMode>,
    pub(crate) cursor_requested: bool,
    pub(crate) cursor_pixels_source: Option<WindowsD3d11CursorPixelsSource>,
    pub(crate) cursor_exclusion_guaranteed: bool,
    pub(crate) acquired_frames: u64,
    pub(crate) published_frames: u64,
    pub(crate) pointer_only_frames: u64,
    pub(crate) coalesced_acquisitions: u64,
    pub(crate) latest_wins_replacements: u64,
    pub(crate) pool_pressure_drops: u64,
    pub(crate) acquisition_timeouts: u64,
    pub(crate) capture_readback_frames: u64,
    pub(crate) pointer_shape_uploads: u64,
    pub(crate) pointer_composited_frames: u64,
    pub(crate) wgc_frame_callbacks: u64,
    pub(crate) wgc_frames_drained: u64,
    pub(crate) access_lost_events: u64,
    pub(crate) display_change_events: u64,
    pub(crate) duplication_recreates: u64,
    pub(crate) device_resets: u64,
    pub(crate) timestamp_corrections: u64,
    pub(crate) fallback_reason: Option<WindowsD3d11CaptureFallbackReason>,
}

impl WindowsD3d11CaptureDiagnostics {
    pub(crate) fn for_plan(plan: WindowsD3d11CapturePlan) -> Self {
        Self {
            generation: plan.generation,
            adapter_luid: plan.selection.adapter_luid.as_u64(),
            output_index: plan.selection.output_index,
            capture_backend: Some(plan.backend),
            cursor_mode: plan.cursor_mode,
            cursor_requested: plan.cursor_requested,
            cursor_pixels_source: plan.cursor_pixels_source,
            cursor_exclusion_guaranteed: plan.cursor_exclusion_guaranteed,
            ..Self::default()
        }
    }

    pub(crate) fn set_fallback(&mut self, reason: WindowsD3d11CaptureFallbackReason) {
        self.capture_backend = None;
        self.fallback_reason = Some(reason);
        self.cursor_mode =
            (!self.cursor_requested).then_some(WindowsD3d11CursorMode::DisabledFallback);
        self.cursor_pixels_source =
            (!self.cursor_requested).then_some(WindowsD3d11CursorPixelsSource::LegacyFallback);
        self.cursor_exclusion_guaranteed = false;
    }

    pub(crate) fn record_decision(&mut self, decision: WindowsD3d11CaptureDecision) {
        self.cursor_mode = Some(decision.cursor_mode);
        self.cursor_pixels_source = Some(decision.cursor_pixels_source);
        if decision.publish {
            self.published_frames = self.published_frames.saturating_add(1);
        } else {
            self.coalesced_acquisitions = self.coalesced_acquisitions.saturating_add(1);
        }
        if decision.content_change == Some(WindowsD3d11CaptureContentChange::PointerOnly) {
            self.pointer_only_frames = self.pointer_only_frames.saturating_add(1);
        }
        if decision.composite_pointer {
            self.pointer_composited_frames = self.pointer_composited_frames.saturating_add(1);
        }
        if decision.timestamp_corrected {
            self.timestamp_corrections = self.timestamp_corrections.saturating_add(1);
        }
    }
}

#[derive(Debug)]
pub(crate) struct WindowsD3d11LatestWinsSlot<T> {
    pending: Option<T>,
    published: u64,
    replacements: u64,
    consumed: u64,
}

impl<T> Default for WindowsD3d11LatestWinsSlot<T> {
    fn default() -> Self {
        Self {
            pending: None,
            published: 0,
            replacements: 0,
            consumed: 0,
        }
    }
}

impl<T> WindowsD3d11LatestWinsSlot<T> {
    pub(crate) fn publish(&mut self, item: T) -> Option<T> {
        self.published = self.published.saturating_add(1);
        let replaced = self.pending.replace(item);
        if replaced.is_some() {
            self.replacements = self.replacements.saturating_add(1);
        }
        replaced
    }

    pub(crate) fn take_latest(&mut self) -> Option<T> {
        let item = self.pending.take();
        if item.is_some() {
            self.consumed = self.consumed.saturating_add(1);
        }
        item
    }

    pub(crate) const fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) const fn published_count(&self) -> u64 {
        self.published
    }

    pub(crate) const fn replacement_count(&self) -> u64 {
        self.replacements
    }

    pub(crate) const fn consumed_count(&self) -> u64 {
        self.consumed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11QpcClock {
    frequency: u64,
    anchor_ticks: i64,
    anchor_micros: u64,
}

impl WindowsD3d11QpcClock {
    pub(crate) fn new(
        frequency: u64,
        anchor_ticks: i64,
        anchor_micros: u64,
    ) -> Result<Self, WindowsD3d11CaptureError> {
        if frequency == 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DeviceLost,
                "QPC frequency must be non-zero",
            ));
        }
        Ok(Self {
            frequency,
            anchor_ticks,
            anchor_micros,
        })
    }

    pub(crate) fn to_micros(self, ticks: i64) -> Result<u64, WindowsD3d11CaptureError> {
        let delta_ticks = i128::from(ticks) - i128::from(self.anchor_ticks);
        let magnitude_micros = delta_ticks
            .unsigned_abs()
            .checked_mul(1_000_000)
            .and_then(|value| value.checked_div(u128::from(self.frequency)))
            .ok_or_else(|| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::DeviceLost,
                    "QPC timestamp conversion overflowed",
                )
            })?;
        let magnitude_micros = u64::try_from(magnitude_micros).map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DeviceLost,
                format!("QPC timestamp is outside the supported range: {error}"),
            )
        })?;
        if delta_ticks < 0 {
            self.anchor_micros
                .checked_sub(magnitude_micros)
                .ok_or_else(|| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DeviceLost,
                        "QPC timestamp predates the session clock origin",
                    )
                })
        } else {
            self.anchor_micros
                .checked_add(magnitude_micros)
                .ok_or_else(|| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DeviceLost,
                        "QPC timestamp exceeds the session clock range",
                    )
                })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsD3d11CaptureTimeline {
    sequence: u64,
    last_qpc_timestamp: i64,
}

impl WindowsD3d11CaptureTimeline {
    const fn new() -> Self {
        Self {
            sequence: 0,
            last_qpc_timestamp: 0,
        }
    }

    fn next(&mut self, candidate_qpc: i64) -> (u64, i64, bool) {
        self.sequence = self.sequence.saturating_add(1);
        let corrected = self.sequence > 1 && candidate_qpc <= self.last_qpc_timestamp;
        let timestamp = if corrected {
            self.last_qpc_timestamp.saturating_add(1)
        } else {
            candidate_qpc.max(1)
        };
        self.last_qpc_timestamp = timestamp;
        (self.sequence, timestamp, corrected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PointerObservation {
    pub(crate) visible: bool,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) shape_revision: u64,
}

impl WindowsD3d11PointerObservation {
    const fn effective_visual_changed(self, previous: Option<Self>) -> bool {
        let Some(previous) = previous else {
            return self.visible;
        };
        if self.visible != previous.visible {
            return true;
        }
        self.visible
            && (self.x != previous.x
                || self.y != previous.y
                || self.shape_revision != previous.shape_revision)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11DuplicationObservation {
    pub(crate) last_present_qpc: i64,
    pub(crate) last_mouse_update_qpc: i64,
    pub(crate) accumulated_frames: u32,
    pub(crate) desktop_surface_acquired: bool,
    pub(crate) pointer: WindowsD3d11PointerObservation,
    pub(crate) protected_content_masked_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CaptureContentChange {
    Desktop,
    PointerOnly,
    WindowsGraphicsCaptureFrame,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CaptureDecision {
    pub(crate) publish: bool,
    pub(crate) sequence: Option<u64>,
    pub(crate) qpc_timestamp: Option<i64>,
    pub(crate) liveness_qpc: i64,
    pub(crate) content_change: Option<WindowsD3d11CaptureContentChange>,
    pub(crate) cursor_mode: WindowsD3d11CursorMode,
    pub(crate) cursor_pixels_source: WindowsD3d11CursorPixelsSource,
    pub(crate) composite_pointer: bool,
    pub(crate) clear_previous_pointer: bool,
    pub(crate) use_cached_uncomposited_desktop: bool,
    pub(crate) timestamp_corrected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11CaptureTimestampKind {
    QueryPerformanceCounter,
    SystemRelativeHundredNanoseconds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11CaptureSubmissionMetadata {
    pub(crate) generation: u64,
    pub(crate) adapter_luid: u64,
    pub(crate) output_index: u32,
    pub(crate) capture_backend: WindowsD3d11CaptureBackend,
    pub(crate) sequence: u64,
    pub(crate) source_timestamp: i64,
    pub(crate) timestamp_kind: WindowsD3d11CaptureTimestampKind,
    pub(crate) accumulated_frames: u32,
    pub(crate) content_change: WindowsD3d11CaptureContentChange,
    pub(crate) rotation: WindowsD3d11OutputRotation,
    pub(crate) cursor_mode: WindowsD3d11CursorMode,
    pub(crate) cursor_pixels_source: WindowsD3d11CursorPixelsSource,
    pub(crate) cursor_requested: bool,
    pub(crate) cursor_exclusion_guaranteed: bool,
    pub(crate) pointer_shape_revision: u64,
}

impl WindowsD3d11CaptureSubmissionMetadata {
    pub(crate) fn desktop_duplication(
        plan: WindowsD3d11CapturePlan,
        decision: WindowsD3d11CaptureDecision,
        observation: WindowsD3d11DuplicationObservation,
        rotation: WindowsD3d11OutputRotation,
    ) -> Option<Self> {
        Some(Self {
            generation: plan.generation,
            adapter_luid: plan.selection.adapter_luid.as_u64(),
            output_index: plan.selection.output_index,
            capture_backend: WindowsD3d11CaptureBackend::DesktopDuplication,
            sequence: decision.sequence?,
            source_timestamp: decision.qpc_timestamp?,
            timestamp_kind: WindowsD3d11CaptureTimestampKind::QueryPerformanceCounter,
            accumulated_frames: observation.accumulated_frames,
            content_change: decision.content_change?,
            rotation,
            cursor_mode: decision.cursor_mode,
            cursor_pixels_source: decision.cursor_pixels_source,
            cursor_requested: plan.cursor_requested,
            cursor_exclusion_guaranteed: false,
            pointer_shape_revision: observation.pointer.shape_revision,
        })
    }

    pub(crate) fn windows_graphics_capture(
        plan: WindowsD3d11CapturePlan,
        sequence: u64,
        system_relative_hundred_nanoseconds: i64,
        rotation: WindowsD3d11OutputRotation,
    ) -> Result<Self, WindowsD3d11CaptureError> {
        if plan.backend != WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor
            || plan.cursor_requested
            || !plan.cursor_exclusion_guaranteed
            || plan.cursor_mode != Some(WindowsD3d11CursorMode::ExcludedWgc)
        {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::WgcCursorExclusionUnconfirmed,
                "WGC submission metadata requires a confirmed cursor-excluded monitor plan",
            ));
        }
        if sequence == 0 || system_relative_hundred_nanoseconds <= 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                "WGC submission sequence and source timestamp must be positive",
            ));
        }
        Ok(Self {
            generation: plan.generation,
            adapter_luid: plan.selection.adapter_luid.as_u64(),
            output_index: plan.selection.output_index,
            capture_backend: plan.backend,
            sequence,
            source_timestamp: system_relative_hundred_nanoseconds,
            timestamp_kind: WindowsD3d11CaptureTimestampKind::SystemRelativeHundredNanoseconds,
            accumulated_frames: 1,
            content_change: WindowsD3d11CaptureContentChange::WindowsGraphicsCaptureFrame,
            rotation,
            cursor_mode: WindowsD3d11CursorMode::ExcludedWgc,
            cursor_pixels_source: WindowsD3d11CursorPixelsSource::ExcludedByWindowsGraphicsCapture,
            cursor_requested: false,
            cursor_exclusion_guaranteed: true,
            pointer_shape_revision: 0,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11DesktopDuplicationState {
    generation: u64,
    capture_cursor: bool,
    cursor_mode: WindowsD3d11CursorMode,
    previous_pointer: Option<WindowsD3d11PointerObservation>,
    has_uncomposited_desktop: bool,
    timeline: WindowsD3d11CaptureTimeline,
}

impl WindowsD3d11DesktopDuplicationState {
    pub(crate) fn new(
        generation: u64,
        capture_cursor: bool,
    ) -> Result<Self, WindowsD3d11CaptureError> {
        if generation == 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DeviceLost,
                "Desktop Duplication state requires a non-zero generation",
            ));
        }
        Ok(Self {
            generation,
            capture_cursor,
            cursor_mode: WindowsD3d11CursorMode::Embedded,
            previous_pointer: None,
            has_uncomposited_desktop: false,
            timeline: WindowsD3d11CaptureTimeline::new(),
        })
    }

    pub(crate) fn reset_for_generation(
        &mut self,
        generation: u64,
    ) -> Result<(), WindowsD3d11CaptureError> {
        *self = Self::new(generation, self.capture_cursor)?;
        Ok(())
    }

    pub(crate) fn observe(
        &mut self,
        observation: WindowsD3d11DuplicationObservation,
    ) -> Result<WindowsD3d11CaptureDecision, WindowsD3d11CaptureError> {
        if observation.protected_content_masked_out {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::ProtectedContent,
                "Desktop Duplication reported protected content masking",
            ));
        }
        let desktop_changed = observation.last_present_qpc > 0;
        if desktop_changed && !observation.desktop_surface_acquired {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                "Desktop Duplication reported a present without an acquired desktop texture",
            ));
        }
        let pointer_changed = observation
            .pointer
            .effective_visual_changed(self.previous_pointer);
        let previous_pointer_visible = self.previous_pointer.is_some_and(|pointer| pointer.visible);

        let (publish, content_change, use_cached_uncomposited_desktop) = if desktop_changed {
            (true, Some(WindowsD3d11CaptureContentChange::Desktop), false)
        } else if self.capture_cursor
            && self.cursor_mode == WindowsD3d11CursorMode::Separate
            && pointer_changed
            && self.has_uncomposited_desktop
        {
            (
                true,
                Some(WindowsD3d11CaptureContentChange::PointerOnly),
                true,
            )
        } else {
            (false, None, false)
        };

        if desktop_changed {
            self.cursor_mode = if self.capture_cursor && observation.pointer.visible {
                WindowsD3d11CursorMode::Separate
            } else if self.capture_cursor && self.cursor_mode == WindowsD3d11CursorMode::Separate {
                // A visible-to-hidden transition still has to remove the
                // previously composited pointer from the cached clean desktop.
                WindowsD3d11CursorMode::Separate
            } else {
                WindowsD3d11CursorMode::Embedded
            };
            self.has_uncomposited_desktop = self.cursor_mode == WindowsD3d11CursorMode::Separate;
        }

        let cursor_pixels_source = if self.cursor_mode == WindowsD3d11CursorMode::Separate {
            WindowsD3d11CursorPixelsSource::DuplicationPointerShape
        } else {
            WindowsD3d11CursorPixelsSource::DesktopSurface
        };
        let composite_pointer = publish
            && self.capture_cursor
            && self.cursor_mode == WindowsD3d11CursorMode::Separate
            && observation.pointer.visible;
        let clear_previous_pointer = publish
            && self.cursor_mode == WindowsD3d11CursorMode::Separate
            && previous_pointer_visible
            && !observation.pointer.visible;
        self.previous_pointer = Some(observation.pointer);

        let liveness_qpc = observation
            .last_present_qpc
            .max(observation.last_mouse_update_qpc);
        let (sequence, qpc_timestamp, timestamp_corrected) = if publish {
            let candidate = match content_change {
                Some(WindowsD3d11CaptureContentChange::PointerOnly) => {
                    observation.last_mouse_update_qpc
                }
                _ => observation
                    .last_present_qpc
                    .max(observation.last_mouse_update_qpc),
            };
            let (sequence, timestamp, corrected) = self.timeline.next(candidate);
            (Some(sequence), Some(timestamp), corrected)
        } else {
            (None, None, false)
        };
        Ok(WindowsD3d11CaptureDecision {
            publish,
            sequence,
            qpc_timestamp,
            liveness_qpc,
            content_change,
            cursor_mode: self.cursor_mode,
            cursor_pixels_source,
            composite_pointer,
            clear_previous_pointer,
            use_cached_uncomposited_desktop,
            timestamp_corrected,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11PointerShapeKind {
    Color,
    Monochrome,
    MaskedColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11PointerBlendOperation {
    Alpha,
    AndThenXor { plane_height: u32 },
    MaskedColorXor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PointerShapeDescriptor {
    pub(crate) kind: WindowsD3d11PointerShapeKind,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pitch: u32,
    pub(crate) hotspot_x: i32,
    pub(crate) hotspot_y: i32,
}

impl WindowsD3d11PointerShapeDescriptor {
    pub(crate) fn validate(
        self,
        byte_len: usize,
    ) -> Result<WindowsD3d11PointerBlendOperation, WindowsD3d11CaptureError> {
        if self.width == 0 || self.height == 0 || self.pitch == 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                "pointer shape dimensions and pitch must be non-zero",
            ));
        }
        if byte_len > MAX_POINTER_SHAPE_BYTES {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                "pointer shape exceeds the bounded one-MiB upload limit",
            ));
        }
        let required = usize::try_from(self.pitch)
            .ok()
            .and_then(|pitch| {
                usize::try_from(self.height)
                    .ok()
                    .and_then(|height| pitch.checked_mul(height))
            })
            .ok_or_else(|| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                    "pointer shape byte count overflowed",
                )
            })?;
        if byte_len < required {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                format!("pointer shape requires {required} bytes but received {byte_len}"),
            ));
        }
        match self.kind {
            WindowsD3d11PointerShapeKind::Color => Ok(WindowsD3d11PointerBlendOperation::Alpha),
            WindowsD3d11PointerShapeKind::MaskedColor => {
                Ok(WindowsD3d11PointerBlendOperation::MaskedColorXor)
            }
            WindowsD3d11PointerShapeKind::Monochrome => {
                if !self.height.is_multiple_of(2) {
                    return Err(WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                        "monochrome pointer height must contain equal AND/XOR mask planes",
                    ));
                }
                Ok(WindowsD3d11PointerBlendOperation::AndThenXor {
                    plane_height: self.height / 2,
                })
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11OutputRotation {
    Identity,
    Rotate90,
    Rotate180,
    Rotate270,
}

pub(crate) const fn windows_d3d11_rotation_requires_fallback(
    rotation: WindowsD3d11OutputRotation,
) -> bool {
    !matches!(rotation, WindowsD3d11OutputRotation::Identity)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11Point {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11Rect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

impl WindowsD3d11Rect {
    fn width(self) -> Option<u32> {
        self.right
            .checked_sub(self.left)
            .and_then(|width| u32::try_from(width).ok())
            .filter(|width| *width > 0)
    }

    fn height(self) -> Option<u32> {
        self.bottom
            .checked_sub(self.top)
            .and_then(|height| u32::try_from(height).ok())
            .filter(|height| *height > 0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PointerTransform {
    pub(crate) source_width: u32,
    pub(crate) source_height: u32,
    pub(crate) rotation: WindowsD3d11OutputRotation,
    pub(crate) crop: WindowsD3d11Rect,
    pub(crate) destination_width: u32,
    pub(crate) destination_height: u32,
}

pub(crate) fn transform_windows_d3d11_pointer(
    point: WindowsD3d11Point,
    hotspot: WindowsD3d11Point,
    transform: WindowsD3d11PointerTransform,
) -> Option<WindowsD3d11Point> {
    if transform.source_width == 0
        || transform.source_height == 0
        || transform.destination_width == 0
        || transform.destination_height == 0
    {
        return None;
    }
    let local_x = point.x.checked_sub(hotspot.x)?;
    let local_y = point.y.checked_sub(hotspot.y)?;
    let source_width_i32 = i32::try_from(transform.source_width).ok()?;
    let source_height_i32 = i32::try_from(transform.source_height).ok()?;
    let (rotated_x, rotated_y) = match transform.rotation {
        WindowsD3d11OutputRotation::Identity => (local_x, local_y),
        WindowsD3d11OutputRotation::Rotate90 => (
            source_height_i32.checked_sub(1)?.checked_sub(local_y)?,
            local_x,
        ),
        WindowsD3d11OutputRotation::Rotate180 => (
            source_width_i32.checked_sub(1)?.checked_sub(local_x)?,
            source_height_i32.checked_sub(1)?.checked_sub(local_y)?,
        ),
        WindowsD3d11OutputRotation::Rotate270 => (
            local_y,
            source_width_i32.checked_sub(1)?.checked_sub(local_x)?,
        ),
    };
    let cropped_x = rotated_x.checked_sub(transform.crop.left)?;
    let cropped_y = rotated_y.checked_sub(transform.crop.top)?;
    let crop_width = transform.crop.width()?;
    let crop_height = transform.crop.height()?;
    if cropped_x < 0
        || cropped_y < 0
        || u32::try_from(cropped_x).ok()? >= crop_width
        || u32::try_from(cropped_y).ok()? >= crop_height
    {
        return None;
    }
    let scaled_x = i64::from(cropped_x)
        .checked_mul(i64::from(transform.destination_width))?
        .checked_div(i64::from(crop_width))?;
    let scaled_y = i64::from(cropped_y)
        .checked_mul(i64::from(transform.destination_height))?
        .checked_div(i64::from(crop_height))?;
    Some(WindowsD3d11Point {
        x: i32::try_from(scaled_x).ok()?,
        y: i32::try_from(scaled_y).ok()?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11DuplicationEvent {
    FrameAcquired,
    Timeout,
    AccessLost,
    DisplayChanged,
    DeviceLost,
    Recreated,
    RecreateFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11DuplicationRecoveryAction {
    Continue,
    RecreateDuplication,
    EndGeneration,
    FallBack(WindowsD3d11CaptureFallbackReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsD3d11DuplicationRecoveryPhase {
    Running,
    Recreating { attempts: u32 },
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11DuplicationRecoveryState {
    generation: u64,
    phase: WindowsD3d11DuplicationRecoveryPhase,
}

impl WindowsD3d11DuplicationRecoveryState {
    pub(crate) fn new(generation: u64) -> Result<Self, WindowsD3d11CaptureError> {
        if generation == 0 {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DeviceLost,
                "duplication recovery generation zero is reserved",
            ));
        }
        Ok(Self {
            generation,
            phase: WindowsD3d11DuplicationRecoveryPhase::Running,
        })
    }

    pub(crate) fn observe(
        &mut self,
        event: WindowsD3d11DuplicationEvent,
    ) -> WindowsD3d11DuplicationRecoveryAction {
        match (self.phase, event) {
            (
                WindowsD3d11DuplicationRecoveryPhase::Running,
                WindowsD3d11DuplicationEvent::FrameAcquired | WindowsD3d11DuplicationEvent::Timeout,
            ) => WindowsD3d11DuplicationRecoveryAction::Continue,
            (
                WindowsD3d11DuplicationRecoveryPhase::Running,
                WindowsD3d11DuplicationEvent::AccessLost
                | WindowsD3d11DuplicationEvent::DisplayChanged,
            ) => {
                self.phase = WindowsD3d11DuplicationRecoveryPhase::Recreating { attempts: 1 };
                WindowsD3d11DuplicationRecoveryAction::RecreateDuplication
            }
            (
                WindowsD3d11DuplicationRecoveryPhase::Recreating { .. },
                WindowsD3d11DuplicationEvent::Recreated,
            ) => {
                self.phase = WindowsD3d11DuplicationRecoveryPhase::Running;
                WindowsD3d11DuplicationRecoveryAction::Continue
            }
            (
                WindowsD3d11DuplicationRecoveryPhase::Recreating { attempts },
                WindowsD3d11DuplicationEvent::RecreateFailed,
            ) if attempts < MAX_DUPLICATION_RECOVERY_ATTEMPTS => {
                self.phase = WindowsD3d11DuplicationRecoveryPhase::Recreating {
                    attempts: attempts + 1,
                };
                WindowsD3d11DuplicationRecoveryAction::RecreateDuplication
            }
            (
                WindowsD3d11DuplicationRecoveryPhase::Recreating { .. },
                WindowsD3d11DuplicationEvent::RecreateFailed,
            ) => {
                self.phase = WindowsD3d11DuplicationRecoveryPhase::Ended;
                WindowsD3d11DuplicationRecoveryAction::FallBack(
                    WindowsD3d11CaptureFallbackReason::RecoveryExhausted,
                )
            }
            (_, WindowsD3d11DuplicationEvent::DeviceLost) => {
                self.phase = WindowsD3d11DuplicationRecoveryPhase::Ended;
                WindowsD3d11DuplicationRecoveryAction::EndGeneration
            }
            (WindowsD3d11DuplicationRecoveryPhase::Ended, _) => {
                WindowsD3d11DuplicationRecoveryAction::FallBack(
                    WindowsD3d11CaptureFallbackReason::DeviceLost,
                )
            }
            (
                WindowsD3d11DuplicationRecoveryPhase::Recreating { .. },
                WindowsD3d11DuplicationEvent::FrameAcquired
                | WindowsD3d11DuplicationEvent::Timeout
                | WindowsD3d11DuplicationEvent::AccessLost
                | WindowsD3d11DuplicationEvent::DisplayChanged,
            ) => WindowsD3d11DuplicationRecoveryAction::RecreateDuplication,
            (
                WindowsD3d11DuplicationRecoveryPhase::Running,
                WindowsD3d11DuplicationEvent::Recreated
                | WindowsD3d11DuplicationEvent::RecreateFailed,
            ) => WindowsD3d11DuplicationRecoveryAction::Continue,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsD3d11DuplicationFramePhase {
    Idle,
    Acquired { desktop_changed: bool },
    Copied,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11DuplicationFrameContract {
    phase: WindowsD3d11DuplicationFramePhase,
}

impl WindowsD3d11DuplicationFrameContract {
    pub(crate) const fn new() -> Self {
        Self {
            phase: WindowsD3d11DuplicationFramePhase::Idle,
        }
    }

    pub(crate) fn acquired(
        &mut self,
        desktop_changed: bool,
    ) -> Result<(), WindowsD3d11CaptureError> {
        if self.phase != WindowsD3d11DuplicationFramePhase::Idle {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                "Desktop Duplication frame was acquired twice",
            ));
        }
        self.phase = WindowsD3d11DuplicationFramePhase::Acquired { desktop_changed };
        Ok(())
    }

    pub(crate) fn copied(&mut self) -> Result<(), WindowsD3d11CaptureError> {
        if !matches!(
            self.phase,
            WindowsD3d11DuplicationFramePhase::Acquired { .. }
        ) {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::TextureContractMismatch,
                "desktop texture copy did not follow acquisition",
            ));
        }
        self.phase = WindowsD3d11DuplicationFramePhase::Copied;
        Ok(())
    }

    pub(crate) fn released(&mut self) -> Result<(), WindowsD3d11CaptureError> {
        match self.phase {
            WindowsD3d11DuplicationFramePhase::Copied
            | WindowsD3d11DuplicationFramePhase::Acquired {
                desktop_changed: false,
            } => {
                self.phase = WindowsD3d11DuplicationFramePhase::Released;
                Ok(())
            }
            WindowsD3d11DuplicationFramePhase::Acquired {
                desktop_changed: true,
            } => Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::TextureContractMismatch,
                "ReleaseFrame cannot precede the GPU copy for changed desktop pixels",
            )),
            _ => Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                "Desktop Duplication frame release was out of order",
            )),
        }
    }
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use std::marker::PhantomData;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::windows_d3d11_device::WindowsD3d11Device;
    use windows::Foundation::{IClosable, TypedEventHandler};
    use windows::Graphics::Capture::{
        Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
        GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Graphics::SizeInt32;
    use windows::Win32::Graphics::Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Texture2D};
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_ROTATE90,
        DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270,
    };
    use windows::Win32::Graphics::Dxgi::{
        DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET,
        DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
        DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
        DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
        IDXGIAdapter, IDXGIAdapter1, IDXGIDevice, IDXGIOutput1, IDXGIOutputDuplication,
        IDXGIResource,
    };
    use windows::Win32::Graphics::Gdi::HMONITOR;
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::core::{IInspectable, Interface, factory};

    #[derive(Debug)]
    struct WindowsD3d11OutputBinding {
        output: IDXGIOutput1,
        monitor: HMONITOR,
        rotation: WindowsD3d11OutputRotation,
        width: u32,
        height: u32,
    }

    fn bind_selected_output(
        device: &WindowsD3d11Device,
        selection: WindowsDxgiOutputSelection,
    ) -> Result<WindowsD3d11OutputBinding, WindowsD3d11CaptureError> {
        if device.adapter_luid() != selection.adapter_luid {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::AdapterMismatch,
                format!(
                    "capture adapter {} does not match media adapter {}",
                    selection.adapter_luid,
                    device.adapter_luid()
                ),
            ));
        }
        let dxgi_device: IDXGIDevice = device.raw_device().cast().map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                format!("D3D11 device does not expose IDXGIDevice: {error}"),
            )
        })?;
        // SAFETY: the adapter remains owned by the returned COM wrapper and
        // all calls stay on the D3D11 media thread.
        let adapter: IDXGIAdapter = unsafe { dxgi_device.GetAdapter() }.map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                format!("IDXGIDevice::GetAdapter failed: {error}"),
            )
        })?;
        let adapter1: IDXGIAdapter1 = adapter.cast().map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                format!("selected adapter does not expose IDXGIAdapter1: {error}"),
            )
        })?;
        // SAFETY: descriptor storage is returned by DXGI.
        let descriptor = unsafe { adapter1.GetDesc1() }.map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                format!("IDXGIAdapter1::GetDesc1 failed: {error}"),
            )
        })?;
        let actual_luid = (u64::from(descriptor.AdapterLuid.HighPart as u32) << 32)
            | u64::from(descriptor.AdapterLuid.LowPart);
        if actual_luid != selection.adapter_luid.as_u64() {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::AdapterMismatch,
                "the D3D11 device's DXGI adapter LUID changed during capture binding",
            ));
        }
        // SAFETY: the stable output index is enumerated on the selected
        // adapter; not-found remains a named capability failure.
        let output = unsafe { adapter.EnumOutputs(selection.output_index) }.map_err(|error| {
            let reason = if error.code() == DXGI_ERROR_NOT_FOUND {
                WindowsD3d11CaptureFallbackReason::OutputUnavailable
            } else {
                WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable
            };
            WindowsD3d11CaptureError::new(
                reason,
                format!(
                    "DXGI output {} was unavailable: {error}",
                    selection.output_index
                ),
            )
        })?;
        // SAFETY: the output descriptor is copied while the output is alive.
        let output_descriptor = unsafe { output.GetDesc() }.map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                format!("IDXGIOutput::GetDesc failed: {error}"),
            )
        })?;
        if !output_descriptor.AttachedToDesktop.as_bool() {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                "selected DXGI output is not attached to the desktop",
            ));
        }
        let width = output_descriptor
            .DesktopCoordinates
            .right
            .checked_sub(output_descriptor.DesktopCoordinates.left)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                    "selected DXGI output has invalid desktop bounds",
                )
            })?;
        let height = output_descriptor
            .DesktopCoordinates
            .bottom
            .checked_sub(output_descriptor.DesktopCoordinates.top)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                    "selected DXGI output has invalid desktop bounds",
                )
            })?;
        let rotation = if output_descriptor.Rotation == DXGI_MODE_ROTATION_IDENTITY {
            WindowsD3d11OutputRotation::Identity
        } else if output_descriptor.Rotation == DXGI_MODE_ROTATION_ROTATE90 {
            WindowsD3d11OutputRotation::Rotate90
        } else if output_descriptor.Rotation == DXGI_MODE_ROTATION_ROTATE180 {
            WindowsD3d11OutputRotation::Rotate180
        } else if output_descriptor.Rotation == DXGI_MODE_ROTATION_ROTATE270 {
            WindowsD3d11OutputRotation::Rotate270
        } else {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                "selected DXGI output reported an unsupported rotation",
            ));
        };
        Ok(WindowsD3d11OutputBinding {
            output: output.cast().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                    format!("selected output does not expose IDXGIOutput1: {error}"),
                )
            })?,
            monitor: output_descriptor.Monitor,
            rotation,
            width,
            height,
        })
    }

    struct AcquiredDuplicationFrame<'a> {
        duplication: &'a IDXGIOutputDuplication,
        active: bool,
        contract: WindowsD3d11DuplicationFrameContract,
    }

    impl<'a> AcquiredDuplicationFrame<'a> {
        fn new(
            duplication: &'a IDXGIOutputDuplication,
            desktop_changed: bool,
        ) -> Result<Self, WindowsD3d11CaptureError> {
            let mut contract = WindowsD3d11DuplicationFrameContract::new();
            contract.acquired(desktop_changed)?;
            Ok(Self {
                duplication,
                active: true,
                contract,
            })
        }

        fn mark_copied(&mut self) -> Result<(), WindowsD3d11CaptureError> {
            self.contract.copied()
        }

        fn release(mut self) -> Result<(), WindowsD3d11CaptureError> {
            self.contract.released()?;
            // SAFETY: this guard owns the one outstanding frame for this
            // duplication object. The GPU copy was enqueued before this call.
            let result = unsafe { self.duplication.ReleaseFrame() }.map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::DesktopDuplicationAccessLost,
                    format!("IDXGIOutputDuplication::ReleaseFrame failed: {error}"),
                )
            });
            self.active = false;
            result
        }
    }

    impl Drop for AcquiredDuplicationFrame<'_> {
        fn drop(&mut self) {
            if self.active {
                // SAFETY: fail-closed cleanup for an early-return path. A
                // changed desktop cannot be published because mark_copied was
                // not reached, but the DXGI frame must still be released.
                let _ = unsafe { self.duplication.ReleaseFrame() };
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11PointerShapeUpdate {
        pub(crate) descriptor: WindowsD3d11PointerShapeDescriptor,
        pub(crate) bytes: Vec<u8>,
        pub(crate) blend: WindowsD3d11PointerBlendOperation,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct WindowsD3d11RuntimeAcquisition {
        pub(crate) observation: WindowsD3d11DuplicationObservation,
        pub(crate) pointer_shape: Option<WindowsD3d11PointerShapeUpdate>,
        pub(crate) rotation: WindowsD3d11OutputRotation,
        pub(crate) copied_before_release: bool,
    }

    pub(crate) struct WindowsD3d11DesktopDuplicationCapture {
        selection: WindowsDxgiOutputSelection,
        duplication: IDXGIOutputDuplication,
        rotation: WindowsD3d11OutputRotation,
        diagnostics: WindowsD3d11CaptureDiagnostics,
        pointer_shape_revision: u64,
        // Keep every DXGI/D3D owner confined to the media thread even though
        // windows-rs wrappers themselves implement Send/Sync.
        _thread_affinity: PhantomData<Rc<()>>,
    }

    impl fmt::Debug for WindowsD3d11DesktopDuplicationCapture {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("WindowsD3d11DesktopDuplicationCapture")
                .field("selection", &self.selection)
                .field("rotation", &self.rotation)
                .field("diagnostics", &self.diagnostics)
                .finish_non_exhaustive()
        }
    }

    impl WindowsD3d11DesktopDuplicationCapture {
        pub(crate) fn create(
            device: &WindowsD3d11Device,
            plan: WindowsD3d11CapturePlan,
        ) -> Result<Self, WindowsD3d11CaptureError> {
            if plan.backend != WindowsD3d11CaptureBackend::DesktopDuplication {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                    "Desktop Duplication runtime received a WGC capture plan",
                ));
            }
            let binding = bind_selected_output(device, plan.selection)?;
            if windows_d3d11_rotation_requires_fallback(binding.rotation) {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::RotationNormalizationUnavailable,
                    format!(
                        "selected output uses {:?} rotation; production D3D11 capture cannot claim live until same-GPU desktop rotation normalization is available",
                        binding.rotation
                    ),
                ));
            }
            // SAFETY: DuplicateOutput receives the same adapter's D3D11
            // device, and the result remains on this media thread.
            let duplication = unsafe { binding.output.DuplicateOutput(device.raw_device()) }
                .map_err(map_duplication_create_error)?;
            Ok(Self {
                selection: plan.selection,
                duplication,
                rotation: binding.rotation,
                diagnostics: WindowsD3d11CaptureDiagnostics::for_plan(plan),
                pointer_shape_revision: 0,
                _thread_affinity: PhantomData,
            })
        }

        pub(crate) fn recreate(
            &mut self,
            device: &WindowsD3d11Device,
        ) -> Result<(), WindowsD3d11CaptureError> {
            let binding = bind_selected_output(device, self.selection)?;
            if windows_d3d11_rotation_requires_fallback(binding.rotation) {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::RotationNormalizationUnavailable,
                    format!(
                        "display recreation observed {:?} rotation; retire this D3D11 generation before fallback",
                        binding.rotation
                    ),
                ));
            }
            // SAFETY: same-adapter recreation stays on the media thread.
            self.duplication = unsafe { binding.output.DuplicateOutput(device.raw_device()) }
                .map_err(map_duplication_create_error)?;
            self.rotation = binding.rotation;
            self.pointer_shape_revision = 0;
            self.diagnostics.duplication_recreates =
                self.diagnostics.duplication_recreates.saturating_add(1);
            Ok(())
        }

        pub(crate) fn acquire_into(
            &mut self,
            device: &WindowsD3d11Device,
            destination: &ID3D11Texture2D,
            timeout_ms: u32,
        ) -> Result<Option<WindowsD3d11RuntimeAcquisition>, WindowsD3d11CaptureError> {
            if device.adapter_luid() != self.selection.adapter_luid {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::AdapterMismatch,
                    "capture destination device no longer matches the selected adapter",
                ));
            }
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            // SAFETY: output pointers are initialized and valid for this call.
            match unsafe {
                self.duplication
                    .AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource)
            } {
                Ok(()) => {}
                Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    self.diagnostics.acquisition_timeouts =
                        self.diagnostics.acquisition_timeouts.saturating_add(1);
                    return Ok(None);
                }
                Err(error) if error.code() == DXGI_ERROR_ACCESS_LOST => {
                    self.diagnostics.access_lost_events =
                        self.diagnostics.access_lost_events.saturating_add(1);
                    return Err(WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DesktopDuplicationAccessLost,
                        format!("Desktop Duplication access was lost: {error}"),
                    ));
                }
                Err(error)
                    if error.code() == DXGI_ERROR_DEVICE_REMOVED
                        || error.code() == DXGI_ERROR_DEVICE_RESET =>
                {
                    self.diagnostics.device_resets =
                        self.diagnostics.device_resets.saturating_add(1);
                    return Err(WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DeviceLost,
                        format!("D3D11 device was removed during capture: {error}"),
                    ));
                }
                Err(error) => {
                    return Err(WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                        format!("AcquireNextFrame failed: {error}"),
                    ));
                }
            }
            self.diagnostics.acquired_frames = self.diagnostics.acquired_frames.saturating_add(1);
            let desktop_changed = frame_info.LastPresentTime > 0;
            let mut guard = AcquiredDuplicationFrame::new(&self.duplication, desktop_changed)?;
            if desktop_changed {
                let resource = resource.ok_or_else(|| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable,
                        "AcquireNextFrame returned no desktop resource for changed pixels",
                    )
                })?;
                let source: ID3D11Texture2D = resource.cast().map_err(|error| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::TextureContractMismatch,
                        format!("acquired desktop resource is not a D3D11 texture: {error}"),
                    )
                })?;
                validate_copy_contract(&source, destination)?;
                // SAFETY: both textures belong to this device/adapter and have
                // matching default-resource descriptors. This is a GPU copy;
                // no Map, ReadFromSubresource, or staging resource is used.
                unsafe {
                    device
                        .immediate_context()
                        .CopyResource(destination, &source);
                }
                guard.mark_copied()?;
            }
            let pointer_shape = read_pointer_shape(
                &self.duplication,
                frame_info.PointerShapeBufferSize,
                &mut self.pointer_shape_revision,
            )?;
            if pointer_shape.is_some() {
                self.diagnostics.pointer_shape_uploads =
                    self.diagnostics.pointer_shape_uploads.saturating_add(1);
            }
            let observation = WindowsD3d11DuplicationObservation {
                last_present_qpc: frame_info.LastPresentTime,
                last_mouse_update_qpc: frame_info.LastMouseUpdateTime,
                accumulated_frames: frame_info.AccumulatedFrames,
                desktop_surface_acquired: true,
                pointer: WindowsD3d11PointerObservation {
                    visible: frame_info.PointerPosition.Visible.as_bool(),
                    x: frame_info.PointerPosition.Position.x,
                    y: frame_info.PointerPosition.Position.y,
                    shape_revision: self.pointer_shape_revision,
                },
                protected_content_masked_out: frame_info.ProtectedContentMaskedOut.as_bool(),
            };
            guard.release()?;
            Ok(Some(WindowsD3d11RuntimeAcquisition {
                observation,
                pointer_shape,
                rotation: self.rotation,
                copied_before_release: desktop_changed,
            }))
        }

        pub(crate) const fn diagnostics(&self) -> WindowsD3d11CaptureDiagnostics {
            self.diagnostics
        }

        pub(crate) fn record_decision(&mut self, decision: WindowsD3d11CaptureDecision) {
            self.diagnostics.record_decision(decision);
        }
    }

    fn validate_copy_contract(
        source: &ID3D11Texture2D,
        destination: &ID3D11Texture2D,
    ) -> Result<(), WindowsD3d11CaptureError> {
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        let mut destination_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: descriptors point to initialized local storage.
        unsafe {
            source.GetDesc(&mut source_desc);
            destination.GetDesc(&mut destination_desc);
        }
        if source_desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || destination_desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || source_desc.Width != destination_desc.Width
            || source_desc.Height != destination_desc.Height
            || source_desc.ArraySize != 1
            || destination_desc.ArraySize != 1
        {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::TextureContractMismatch,
                format!(
                    "capture copy requires matching single-slice BGRA textures (source={}x{}, destination={}x{})",
                    source_desc.Width,
                    source_desc.Height,
                    destination_desc.Width,
                    destination_desc.Height
                ),
            ));
        }
        Ok(())
    }

    fn read_pointer_shape(
        duplication: &IDXGIOutputDuplication,
        byte_count: u32,
        shape_revision: &mut u64,
    ) -> Result<Option<WindowsD3d11PointerShapeUpdate>, WindowsD3d11CaptureError> {
        if byte_count == 0 {
            return Ok(None);
        }
        let byte_count_usize = usize::try_from(byte_count).map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                format!("pointer shape byte count could not be represented: {error}"),
            )
        })?;
        if byte_count_usize > MAX_POINTER_SHAPE_BYTES {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                "Desktop Duplication pointer shape exceeded the bounded upload size",
            ));
        }
        let mut bytes = vec![0_u8; byte_count_usize];
        let mut required = 0_u32;
        let mut info = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
        // SAFETY: the bounded vector is writable for byte_count bytes and all
        // output metadata points to initialized local storage.
        unsafe {
            duplication.GetFramePointerShape(
                byte_count,
                bytes.as_mut_ptr().cast(),
                &mut required,
                &mut info,
            )
        }
        .map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                format!("GetFramePointerShape failed: {error}"),
            )
        })?;
        let required_usize = usize::try_from(required).map_err(|error| {
            WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                format!("pointer shape result size could not be represented: {error}"),
            )
        })?;
        if required_usize > bytes.len() {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                "GetFramePointerShape required more than the advertised bounded buffer",
            ));
        }
        bytes.truncate(required_usize);
        let kind = if info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32 {
            WindowsD3d11PointerShapeKind::Color
        } else if info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32 {
            WindowsD3d11PointerShapeKind::Monochrome
        } else if info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 as u32 {
            WindowsD3d11PointerShapeKind::MaskedColor
        } else {
            return Err(WindowsD3d11CaptureError::new(
                WindowsD3d11CaptureFallbackReason::PointerShapeInvalid,
                format!(
                    "Desktop Duplication returned unknown pointer shape type {}",
                    info.Type
                ),
            ));
        };
        let descriptor = WindowsD3d11PointerShapeDescriptor {
            kind,
            width: info.Width,
            height: info.Height,
            pitch: info.Pitch,
            hotspot_x: info.HotSpot.x,
            hotspot_y: info.HotSpot.y,
        };
        let blend = descriptor.validate(bytes.len())?;
        *shape_revision = shape_revision.saturating_add(1);
        Ok(Some(WindowsD3d11PointerShapeUpdate {
            descriptor,
            bytes,
            blend,
        }))
    }

    fn map_duplication_create_error(error: windows::core::Error) -> WindowsD3d11CaptureError {
        let reason = if error.code() == DXGI_ERROR_ACCESS_LOST {
            WindowsD3d11CaptureFallbackReason::DesktopDuplicationAccessLost
        } else if error.code() == DXGI_ERROR_DEVICE_REMOVED
            || error.code() == DXGI_ERROR_DEVICE_RESET
        {
            WindowsD3d11CaptureFallbackReason::DeviceLost
        } else {
            WindowsD3d11CaptureFallbackReason::DesktopDuplicationUnavailable
        };
        WindowsD3d11CaptureError::new(
            reason,
            format!("IDXGIOutput1::DuplicateOutput failed: {error}"),
        )
    }

    pub(crate) struct WindowsD3d11WgcMonitorCapture {
        selection: WindowsDxgiOutputSelection,
        rotation: WindowsD3d11OutputRotation,
        item: GraphicsCaptureItem,
        frame_pool: Direct3D11CaptureFramePool,
        session: GraphicsCaptureSession,
        frame_arrived_token: i64,
        callback_count: Arc<AtomicU64>,
        drained_callback_count: u64,
        diagnostics: WindowsD3d11CaptureDiagnostics,
        _thread_affinity: PhantomData<Rc<()>>,
    }

    impl fmt::Debug for WindowsD3d11WgcMonitorCapture {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("WindowsD3d11WgcMonitorCapture")
                .field("selection", &self.selection)
                .field("rotation", &self.rotation)
                .field("diagnostics", &self.diagnostics)
                .finish_non_exhaustive()
        }
    }

    impl WindowsD3d11WgcMonitorCapture {
        pub(crate) fn create(
            device: &WindowsD3d11Device,
            plan: WindowsD3d11CapturePlan,
        ) -> Result<Self, WindowsD3d11CaptureError> {
            if plan.backend != WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor
                || plan.cursor_requested
            {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcCursorExclusionUnconfirmed,
                    "WGC monitor capture is reserved for cursor-disabled capture",
                ));
            }
            if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    "Windows Graphics Capture is not supported on this host",
                ));
            }
            let binding = bind_selected_output(device, plan.selection)?;
            let item_factory: IGraphicsCaptureItemInterop =
                factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|error| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                        format!("GraphicsCaptureItem activation factory is unavailable: {error}"),
                    )
                })?;
            // SAFETY: HMONITOR comes from the exact selected DXGI output and
            // remains valid while display-change recovery owns this session.
            let item: GraphicsCaptureItem =
                unsafe { item_factory.CreateForMonitor(binding.monitor) }.map_err(|error| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                        format!("CreateForMonitor failed: {error}"),
                    )
                })?;
            let dxgi_device: IDXGIDevice = device.raw_device().cast().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                    format!("D3D11 device does not expose IDXGIDevice: {error}"),
                )
            })?;
            // SAFETY: the WinRT device wraps the same DXGI device; no shared
            // handle or second adapter/device is created.
            let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
                .map_err(|error| {
                    WindowsD3d11CaptureError::new(
                        WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                        format!("D3D11 WinRT interop failed: {error}"),
                    )
                })?;
            let direct3d_device: IDirect3DDevice = inspectable.cast().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                    format!("WinRT D3D device cast failed: {error}"),
                )
            })?;
            let item_size = item.Size().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    format!("GraphicsCaptureItem::Size failed: {error}"),
                )
            })?;
            if item_size.Width <= 0 || item_size.Height <= 0 {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                    "WGC monitor item returned invalid dimensions",
                ));
            }
            let expected_size = SizeInt32 {
                Width: i32::try_from(binding.width).unwrap_or(i32::MAX),
                Height: i32::try_from(binding.height).unwrap_or(i32::MAX),
            };
            if item_size != expected_size {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::OutputUnavailable,
                    format!(
                        "WGC monitor dimensions {}x{} do not match DXGI output {}x{}",
                        item_size.Width, item_size.Height, binding.width, binding.height
                    ),
                ));
            }
            let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &direct3d_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                item_size,
            )
            .map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcFramePoolUnavailable,
                    format!("CreateFreeThreaded frame pool failed: {error}"),
                )
            })?;
            let session = frame_pool.CreateCaptureSession(&item).map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    format!("CreateCaptureSession failed: {error}"),
                )
            })?;
            session.SetIsCursorCaptureEnabled(false).map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcCursorControlUnavailable,
                    format!("setting IsCursorCaptureEnabled=false failed: {error}"),
                )
            })?;
            let cursor_enabled = session.IsCursorCaptureEnabled().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcCursorControlUnavailable,
                    format!("reading IsCursorCaptureEnabled failed: {error}"),
                )
            })?;
            if cursor_enabled {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcCursorExclusionUnconfirmed,
                    "WGC cursor-disable property read back true before StartCapture",
                ));
            }
            let callback_count = Arc::new(AtomicU64::new(0));
            let callback_counter = callback_count.clone();
            let handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                move |_sender, _args| {
                    callback_counter.fetch_add(1, Ordering::Release);
                    Ok(())
                },
            );
            let frame_arrived_token = frame_pool.FrameArrived(&handler).map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcFramePoolUnavailable,
                    format!("registering WGC FrameArrived callback failed: {error}"),
                )
            })?;
            // Cursor exclusion was set and read back before this call. No GPU
            // work occurs in FrameArrived; the media thread drains frames.
            session.StartCapture().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    format!("GraphicsCaptureSession::StartCapture failed: {error}"),
                )
            })?;
            Ok(Self {
                selection: plan.selection,
                rotation: binding.rotation,
                item,
                frame_pool,
                session,
                frame_arrived_token,
                callback_count,
                drained_callback_count: 0,
                diagnostics: WindowsD3d11CaptureDiagnostics::for_plan(plan),
                _thread_affinity: PhantomData,
            })
        }

        pub(crate) fn copy_latest_into(
            &mut self,
            device: &WindowsD3d11Device,
            destination: &ID3D11Texture2D,
        ) -> Result<Option<i64>, WindowsD3d11CaptureError> {
            if device.adapter_luid() != self.selection.adapter_luid {
                return Err(WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::AdapterMismatch,
                    "WGC frame destination no longer matches the selected adapter",
                ));
            }
            let callback_count = self.callback_count.load(Ordering::Acquire);
            self.diagnostics.wgc_frame_callbacks = callback_count;
            if callback_count == self.drained_callback_count {
                return Ok(None);
            }
            let mut latest: Option<Direct3D11CaptureFrame> = None;
            let pending_callbacks = callback_count.saturating_sub(self.drained_callback_count);
            for _ in 0..pending_callbacks {
                let frame = match self.frame_pool.TryGetNextFrame() {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                if let Some(previous) = latest.replace(frame) {
                    let _ = previous.Close();
                    self.diagnostics.wgc_frames_drained =
                        self.diagnostics.wgc_frames_drained.saturating_add(1);
                    self.diagnostics.latest_wins_replacements =
                        self.diagnostics.latest_wins_replacements.saturating_add(1);
                }
            }
            self.drained_callback_count = callback_count;
            let Some(frame) = latest else {
                return Ok(None);
            };
            let timestamp = frame.SystemRelativeTime().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    format!("WGC frame timestamp was unavailable: {error}"),
                )
            })?;
            let surface = frame.Surface().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                    format!("WGC frame surface was unavailable: {error}"),
                )
            })?;
            let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                    format!("WGC surface does not expose DXGI interface access: {error}"),
                )
            })?;
            // SAFETY: the interface access object returns the frame's own
            // D3D11 texture, which is copied on the media thread before Close.
            let source: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
                    format!("WGC surface does not expose ID3D11Texture2D: {error}"),
                )
            })?;
            validate_copy_contract(&source, destination)?;
            // SAFETY: same-device matching BGRA textures; GPU-only copy.
            unsafe {
                device
                    .immediate_context()
                    .CopyResource(destination, &source);
            }
            frame.Close().map_err(|error| {
                WindowsD3d11CaptureError::new(
                    WindowsD3d11CaptureFallbackReason::WgcUnavailable,
                    format!("closing WGC frame failed: {error}"),
                )
            })?;
            self.diagnostics.acquired_frames = self.diagnostics.acquired_frames.saturating_add(1);
            self.diagnostics.published_frames = self.diagnostics.published_frames.saturating_add(1);
            Ok(Some(timestamp.Duration))
        }

        pub(crate) const fn diagnostics(&self) -> WindowsD3d11CaptureDiagnostics {
            self.diagnostics
        }

        pub(crate) const fn rotation(&self) -> WindowsD3d11OutputRotation {
            self.rotation
        }
    }

    impl Drop for WindowsD3d11WgcMonitorCapture {
        fn drop(&mut self) {
            let _ = self.frame_pool.RemoveFrameArrived(self.frame_arrived_token);
            let _ = self
                .session
                .cast::<IClosable>()
                .and_then(|value| value.Close());
            let _ = self.frame_pool.Close();
            let _ = self
                .item
                .cast::<IClosable>()
                .and_then(|value| value.Close());
        }
    }
}

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub(crate) use runtime::{
    WindowsD3d11DesktopDuplicationCapture, WindowsD3d11PointerShapeUpdate,
    WindowsD3d11RuntimeAcquisition, WindowsD3d11WgcMonitorCapture,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter() -> DxgiAdapterLuid {
        DxgiAdapterLuid::from_u64(0x3f1)
    }

    fn confirmed_wgc_probe() -> WindowsD3d11WgcCursorExclusionProbe {
        WindowsD3d11WgcCursorExclusionProbe {
            graphics_capture_supported: true,
            direct3d_interop_supported: true,
            same_adapter: true,
            cursor_control_supported: true,
            cursor_disable_set_succeeded: true,
            cursor_disable_readback_confirmed: true,
        }
    }

    fn pointer(
        visible: bool,
        x: i32,
        y: i32,
        shape_revision: u64,
    ) -> WindowsD3d11PointerObservation {
        WindowsD3d11PointerObservation {
            visible,
            x,
            y,
            shape_revision,
        }
    }

    fn duplication_observation(
        present: i64,
        mouse: i64,
        pointer: WindowsD3d11PointerObservation,
    ) -> WindowsD3d11DuplicationObservation {
        WindowsD3d11DuplicationObservation {
            last_present_qpc: present,
            last_mouse_update_qpc: mouse,
            accumulated_frames: u32::from(present > 0),
            desktop_surface_acquired: true,
            pointer,
            protected_content_masked_out: false,
        }
    }

    #[test]
    fn windows_d3d11_capture_selects_cursor_safe_backend() {
        let cursor_enabled = WindowsD3d11CapturePlan::resolve(
            "screen:dxgi:00000000000003f1:2",
            true,
            adapter(),
            7,
            WindowsD3d11WgcCursorExclusionProbe::default(),
        )
        .expect("cursor-enabled display capture should use Desktop Duplication");
        assert_eq!(
            cursor_enabled.backend,
            WindowsD3d11CaptureBackend::DesktopDuplication
        );
        assert!(!cursor_enabled.cursor_exclusion_guaranteed);

        let cursor_disabled = WindowsD3d11CapturePlan::resolve(
            "screen:dxgi:00000000000003f1:2",
            false,
            adapter(),
            7,
            confirmed_wgc_probe(),
        )
        .expect("confirmed cursor-disabled capture should use WGC");
        assert_eq!(
            cursor_disabled.backend,
            WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor
        );
        assert_eq!(
            cursor_disabled.cursor_mode,
            Some(WindowsD3d11CursorMode::ExcludedWgc)
        );
        assert!(cursor_disabled.cursor_exclusion_guaranteed);
        let submission = WindowsD3d11CaptureSubmissionMetadata::windows_graphics_capture(
            cursor_disabled,
            1,
            10_000,
            WindowsD3d11OutputRotation::Identity,
        )
        .expect("confirmed WGC plan produces scalar submission metadata");
        assert_eq!(
            submission.timestamp_kind,
            WindowsD3d11CaptureTimestampKind::SystemRelativeHundredNanoseconds
        );
        assert_eq!(submission.adapter_luid, adapter().as_u64());
        assert!(submission.cursor_exclusion_guaranteed);

        let mismatch = WindowsD3d11CapturePlan::resolve(
            "screen:dxgi:00000000000003f1:2",
            true,
            DxgiAdapterLuid::from_u64(0x3f2),
            7,
            confirmed_wgc_probe(),
        )
        .expect_err("cross-adapter capture must fail closed");
        assert_eq!(
            mismatch.reason,
            WindowsD3d11CaptureFallbackReason::AdapterMismatch
        );
    }

    #[test]
    fn windows_d3d11_capture_latest_wins_is_bounded() {
        let mut slot = WindowsD3d11LatestWinsSlot::default();
        assert_eq!(slot.publish(1_u64), None);
        assert_eq!(slot.publish(2), Some(1));
        assert_eq!(slot.publish(3), Some(2));
        assert!(slot.is_pending());
        assert_eq!(slot.take_latest(), Some(3));
        assert!(!slot.is_pending());
        assert_eq!(slot.published_count(), 3);
        assert_eq!(slot.replacement_count(), 2);
        assert_eq!(slot.consumed_count(), 1);
    }

    #[test]
    fn windows_d3d11_capture_qpc_timestamps_are_monotonic() {
        let clock = WindowsD3d11QpcClock::new(10_000_000, 1_000, 50_000).expect("valid QPC clock");
        assert_eq!(clock.to_micros(1_010).expect("later timestamp"), 50_001);
        assert_eq!(clock.to_micros(990).expect("earlier timestamp"), 49_999);

        let mut timeline = WindowsD3d11CaptureTimeline::new();
        assert_eq!(timeline.next(100), (1, 100, false));
        assert_eq!(timeline.next(100), (2, 101, true));
        assert_eq!(timeline.next(99), (3, 102, true));
        assert_eq!(timeline.next(110), (4, 110, false));
    }

    #[test]
    fn windows_d3d11_capture_pointer_ownership_is_exactly_once() {
        let mut state = WindowsD3d11DesktopDuplicationState::new(1, true).expect("valid state");
        let separate = state
            .observe(duplication_observation(100, 90, pointer(true, 20, 30, 1)))
            .expect("separate pointer frame");
        assert_eq!(separate.cursor_mode, WindowsD3d11CursorMode::Separate);
        assert_eq!(
            separate.cursor_pixels_source,
            WindowsD3d11CursorPixelsSource::DuplicationPointerShape
        );
        assert!(separate.composite_pointer);

        let hidden = state
            .observe(duplication_observation(0, 110, pointer(false, 20, 30, 1)))
            .expect("pointer removal");
        assert_eq!(
            hidden.content_change,
            Some(WindowsD3d11CaptureContentChange::PointerOnly)
        );
        assert!(!hidden.composite_pointer);
        assert!(hidden.clear_previous_pointer);

        let mut embedded = WindowsD3d11DesktopDuplicationState::new(2, true).expect("valid state");
        let embedded_frame = embedded
            .observe(duplication_observation(200, 190, pointer(false, 0, 0, 0)))
            .expect("embedded frame");
        assert_eq!(embedded_frame.cursor_mode, WindowsD3d11CursorMode::Embedded);
        assert_eq!(
            embedded_frame.cursor_pixels_source,
            WindowsD3d11CursorPixelsSource::DesktopSurface
        );
        assert!(!embedded_frame.composite_pointer);
    }

    #[test]
    fn windows_d3d11_capture_pointer_only_publication_is_truthful() {
        let mut state = WindowsD3d11DesktopDuplicationState::new(1, true).expect("valid state");
        state
            .observe(duplication_observation(100, 95, pointer(true, 10, 10, 1)))
            .expect("initial desktop");

        let moved = state
            .observe(duplication_observation(0, 120, pointer(true, 11, 10, 1)))
            .expect("moving pointer");
        assert!(moved.publish);
        assert_eq!(
            moved.content_change,
            Some(WindowsD3d11CaptureContentChange::PointerOnly)
        );
        assert!(moved.use_cached_uncomposited_desktop);
        let mut diagnostics = WindowsD3d11CaptureDiagnostics::default();
        diagnostics.record_decision(moved);
        assert_eq!(diagnostics.published_frames, 1);
        assert_eq!(diagnostics.pointer_only_frames, 1);
        assert_eq!(diagnostics.pointer_composited_frames, 1);

        let unchanged = state
            .observe(duplication_observation(0, 130, pointer(true, 11, 10, 1)))
            .expect("unchanged pointer");
        assert!(!unchanged.publish);

        let hidden_motion = state
            .observe(duplication_observation(0, 140, pointer(false, 11, 10, 1)))
            .expect("visible-to-hidden removal");
        assert!(hidden_motion.publish);
        let hidden_unchanged = state
            .observe(duplication_observation(0, 150, pointer(false, 99, 99, 2)))
            .expect("hidden pointer movement");
        assert!(!hidden_unchanged.publish);

        let mut embedded = WindowsD3d11DesktopDuplicationState::new(2, true).expect("valid state");
        embedded
            .observe(duplication_observation(200, 190, pointer(false, 0, 0, 0)))
            .expect("embedded desktop");
        let embedded_pointer_notice = embedded
            .observe(duplication_observation(0, 220, pointer(true, 5, 5, 1)))
            .expect("embedded pointer notice");
        assert!(
            !embedded_pointer_notice.publish,
            "embedded mode requires a newly acquired desktop surface"
        );
    }

    #[test]
    fn windows_d3d11_capture_recovers_duplication_access_loss() {
        let mut recovery = WindowsD3d11DuplicationRecoveryState::new(9).expect("valid generation");
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::Timeout),
            WindowsD3d11DuplicationRecoveryAction::Continue
        );
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::AccessLost),
            WindowsD3d11DuplicationRecoveryAction::RecreateDuplication
        );
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::RecreateFailed),
            WindowsD3d11DuplicationRecoveryAction::RecreateDuplication
        );
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::Recreated),
            WindowsD3d11DuplicationRecoveryAction::Continue
        );
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::DisplayChanged),
            WindowsD3d11DuplicationRecoveryAction::RecreateDuplication
        );
        assert_eq!(
            recovery.observe(WindowsD3d11DuplicationEvent::DeviceLost),
            WindowsD3d11DuplicationRecoveryAction::EndGeneration
        );
    }

    #[test]
    fn windows_d3d11_capture_wgc_cursor_exclusion_fails_closed() {
        for (probe, expected) in [
            (
                WindowsD3d11WgcCursorExclusionProbe::default(),
                WindowsD3d11CaptureFallbackReason::WgcUnavailable,
            ),
            (
                WindowsD3d11WgcCursorExclusionProbe {
                    graphics_capture_supported: true,
                    ..WindowsD3d11WgcCursorExclusionProbe::default()
                },
                WindowsD3d11CaptureFallbackReason::WgcDirect3dInteropUnavailable,
            ),
            (
                WindowsD3d11WgcCursorExclusionProbe {
                    graphics_capture_supported: true,
                    direct3d_interop_supported: true,
                    same_adapter: true,
                    ..WindowsD3d11WgcCursorExclusionProbe::default()
                },
                WindowsD3d11CaptureFallbackReason::WgcCursorControlUnavailable,
            ),
            (
                WindowsD3d11WgcCursorExclusionProbe {
                    graphics_capture_supported: true,
                    direct3d_interop_supported: true,
                    same_adapter: true,
                    cursor_control_supported: true,
                    cursor_disable_set_succeeded: true,
                    cursor_disable_readback_confirmed: false,
                },
                WindowsD3d11CaptureFallbackReason::WgcCursorExclusionUnconfirmed,
            ),
        ] {
            let error = WindowsD3d11CapturePlan::resolve(
                "screen:dxgi:00000000000003f1:2",
                false,
                adapter(),
                1,
                probe,
            )
            .expect_err("unconfirmed WGC exclusion must fail closed");
            assert_eq!(error.reason, expected);
        }
    }

    #[test]
    fn windows_d3d11_capture_rotation_crop_scale_is_deterministic() {
        assert!(!windows_d3d11_rotation_requires_fallback(
            WindowsD3d11OutputRotation::Identity
        ));
        for rotation in [
            WindowsD3d11OutputRotation::Rotate90,
            WindowsD3d11OutputRotation::Rotate180,
            WindowsD3d11OutputRotation::Rotate270,
        ] {
            assert!(
                windows_d3d11_rotation_requires_fallback(rotation),
                "production capture must not claim an unnormalized rotated desktop"
            );
        }
        let crop = WindowsD3d11Rect {
            left: 0,
            top: 0,
            right: 1080,
            bottom: 1920,
        };
        let transformed = transform_windows_d3d11_pointer(
            WindowsD3d11Point { x: 100, y: 200 },
            WindowsD3d11Point { x: 10, y: 20 },
            WindowsD3d11PointerTransform {
                source_width: 1920,
                source_height: 1080,
                rotation: WindowsD3d11OutputRotation::Rotate90,
                crop,
                destination_width: 540,
                destination_height: 960,
            },
        )
        .expect("rotated cursor should remain inside the crop");
        assert_eq!(transformed, WindowsD3d11Point { x: 449, y: 45 });
        assert_eq!(
            transform_windows_d3d11_pointer(
                WindowsD3d11Point { x: -10, y: -20 },
                WindowsD3d11Point { x: 0, y: 0 },
                WindowsD3d11PointerTransform {
                    source_width: 1920,
                    source_height: 1080,
                    rotation: WindowsD3d11OutputRotation::Identity,
                    crop: WindowsD3d11Rect {
                        left: 0,
                        top: 0,
                        right: 1920,
                        bottom: 1080,
                    },
                    destination_width: 1920,
                    destination_height: 1080,
                },
            ),
            None
        );
    }

    #[test]
    fn windows_d3d11_capture_copies_before_releasing_duplication_frame() {
        let mut contract = WindowsD3d11DuplicationFrameContract::new();
        contract.acquired(true).expect("acquisition");
        let early_release = contract
            .released()
            .expect_err("changed desktop cannot be released before GPU copy");
        assert_eq!(
            early_release.reason,
            WindowsD3d11CaptureFallbackReason::TextureContractMismatch
        );

        let mut contract = WindowsD3d11DuplicationFrameContract::new();
        contract.acquired(true).expect("acquisition");
        contract.copied().expect("GPU copy");
        contract.released().expect("release after copy");

        let mut pointer_only = WindowsD3d11DuplicationFrameContract::new();
        pointer_only
            .acquired(false)
            .expect("pointer-only acquisition");
        pointer_only
            .released()
            .expect("unchanged desktop need not be copied");
    }

    #[test]
    fn windows_d3d11_capture_validates_pointer_shape_layouts() {
        let color = WindowsD3d11PointerShapeDescriptor {
            kind: WindowsD3d11PointerShapeKind::Color,
            width: 16,
            height: 16,
            pitch: 64,
            hotspot_x: 2,
            hotspot_y: 3,
        };
        assert_eq!(
            color.validate(1024).expect("color pointer"),
            WindowsD3d11PointerBlendOperation::Alpha
        );
        let monochrome = WindowsD3d11PointerShapeDescriptor {
            kind: WindowsD3d11PointerShapeKind::Monochrome,
            width: 16,
            height: 32,
            pitch: 2,
            hotspot_x: 0,
            hotspot_y: 0,
        };
        assert_eq!(
            monochrome.validate(64).expect("monochrome pointer"),
            WindowsD3d11PointerBlendOperation::AndThenXor { plane_height: 16 }
        );
        let masked = WindowsD3d11PointerShapeDescriptor {
            kind: WindowsD3d11PointerShapeKind::MaskedColor,
            ..color
        };
        assert_eq!(
            masked.validate(1024).expect("masked pointer"),
            WindowsD3d11PointerBlendOperation::MaskedColorXor
        );
        let invalid_monochrome = WindowsD3d11PointerShapeDescriptor {
            height: 31,
            ..monochrome
        };
        assert_eq!(
            invalid_monochrome
                .validate(62)
                .expect_err("odd monochrome plane height")
                .reason,
            WindowsD3d11CaptureFallbackReason::PointerShapeInvalid
        );
    }
}
