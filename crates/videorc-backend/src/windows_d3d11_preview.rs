#[cfg(target_os = "windows")]
use crate::native_preview_host::NativePreviewHostBounds;
use crate::protocol::{WindowsD3d11PresenterBounds, WindowsD3d11PresenterDiagnostics};
use crate::windows_d3d11_device::DxgiAdapterLuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11PreviewFallbackReason {
    WaitingForTrustedWindow,
    DestroyedTargetWindow,
    ForeignTargetOwner,
    StaleGeneration,
    AdapterMismatch,
    WindowCreationFailed,
    WindowStackingFailed,
    WindowStyleReadbackFailed,
    CaptureExclusionFailed,
    DirectCompositionUnavailable,
    SwapChainUnavailable,
    PresentFailed,
    SourceStalled,
}

impl WindowsD3d11PreviewFallbackReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::WaitingForTrustedWindow => "windows-d3d11-preview-waiting-trusted-window",
            Self::DestroyedTargetWindow => "windows-d3d11-preview-target-destroyed",
            Self::ForeignTargetOwner => "windows-d3d11-preview-target-owner-mismatch",
            Self::StaleGeneration => "windows-d3d11-preview-stale-generation",
            Self::AdapterMismatch => "windows-d3d11-preview-adapter-mismatch",
            Self::WindowCreationFailed => "windows-d3d11-preview-window-create-failed",
            Self::WindowStackingFailed => "windows-d3d11-preview-window-stacking-failed",
            Self::WindowStyleReadbackFailed => "windows-d3d11-preview-window-style-readback-failed",
            Self::CaptureExclusionFailed => "windows-d3d11-preview-capture-exclusion-failed",
            Self::DirectCompositionUnavailable => {
                "windows-d3d11-preview-directcomposition-unavailable"
            }
            Self::SwapChainUnavailable => "windows-d3d11-preview-swapchain-unavailable",
            Self::PresentFailed => "windows-d3d11-preview-present-failed",
            Self::SourceStalled => "windows-d3d11-preview-source-stalled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowsD3d11PreviewPlacement {
    pub(crate) media_generation: u64,
    pub(crate) preview_generation: u64,
    pub(crate) adapter_luid: DxgiAdapterLuid,
    /// Privileged backend-only HWND bits. Never copy this into protocol status.
    pub(crate) target_window_handle: u64,
    /// Privileged backend-only supervisor PID. Status exposes only a match bit.
    pub(crate) expected_owner_process_id: u32,
    pub(crate) screen_x: f64,
    pub(crate) screen_y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) clip_x: Option<f64>,
    pub(crate) clip_y: Option<f64>,
    pub(crate) clip_width: Option<f64>,
    pub(crate) clip_height: Option<f64>,
    pub(crate) visible: bool,
}

impl WindowsD3d11PreviewPlacement {
    #[cfg(target_os = "windows")]
    pub(crate) fn from_trusted_host_bounds(
        media_generation: u64,
        adapter_luid: DxgiAdapterLuid,
        bounds: &NativePreviewHostBounds,
    ) -> Result<Self, String> {
        let preview_generation = bounds
            .preview_generation
            .filter(|generation| *generation != 0)
            .ok_or_else(|| "trusted preview bounds have no active generation".to_string())?;
        let target_window_handle = bounds
            .order_above_window_handle
            .as_ref()
            .map(|handle| handle.as_u64())
            .ok_or_else(|| "trusted preview bounds have no Electron HWND".to_string())?;
        let expected_owner_process_id = std::env::var("VIDEORC_SUPERVISOR_PID")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .ok_or_else(|| "authenticated Electron supervisor PID is unavailable".to_string())?;
        Ok(Self {
            media_generation,
            preview_generation,
            adapter_luid,
            target_window_handle,
            expected_owner_process_id,
            screen_x: bounds.screen_x,
            screen_y: bounds.screen_y,
            width: bounds.width,
            height: bounds.height,
            clip_x: bounds.clip_x,
            clip_y: bounds.clip_y,
            clip_width: bounds.clip_width,
            clip_height: bounds.clip_height,
            visible: bounds.visible.unwrap_or(true),
        })
    }

    pub(crate) fn visible_bounds(self) -> Option<WindowsD3d11PresenterBounds> {
        if !self.visible {
            return None;
        }
        let (x, y, width, height) =
            match (self.clip_x, self.clip_y, self.clip_width, self.clip_height) {
                (Some(x), Some(y), Some(width), Some(height)) => (x, y, width, height),
                _ => (self.screen_x, self.screen_y, self.width, self.height),
            };
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width < 1.0
            || height < 1.0
        {
            return None;
        }
        Some(WindowsD3d11PresenterBounds {
            x: rounded_i32(x),
            y: rounded_i32(y),
            width: rounded_u32(width),
            height: rounded_u32(height),
        })
    }

    pub(crate) fn visual_offset(self) -> (f32, f32) {
        let clip_x = self.clip_x.unwrap_or(self.screen_x);
        let clip_y = self.clip_y.unwrap_or(self.screen_y);
        (
            finite_f32(self.screen_x - clip_x),
            finite_f32(self.screen_y - clip_y),
        )
    }
}

fn rounded_i32(value: f64) -> i32 {
    value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn rounded_u32(value: f64) -> u32 {
    value.round().clamp(1.0, f64::from(u32::MAX)) as u32
}

fn finite_f32(value: f64) -> f32 {
    if value.is_finite() {
        value.clamp(f64::from(f32::MIN), f64::from(f32::MAX)) as f32
    } else {
        0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PreviewWindowReadback {
    pub(crate) target_exists: bool,
    pub(crate) owner_process_matches: bool,
    pub(crate) stacked_immediately_above: bool,
    pub(crate) layered: bool,
    pub(crate) transparent: bool,
    pub(crate) no_activate: bool,
    pub(crate) excluded_from_capture: bool,
    pub(crate) window_active: bool,
    pub(crate) window_focused: bool,
    pub(crate) actual_bounds: Option<WindowsD3d11PresenterBounds>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PreviewFrameMetadata {
    pub(crate) media_generation: u64,
    pub(crate) preview_generation: u64,
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) sequence: u64,
    pub(crate) source_live: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11PreviewPresentOutcome {
    Presented,
    Hidden,
    Busy,
    Failed(WindowsD3d11PreviewFallbackReason),
}

#[derive(Debug, Clone)]
pub(crate) struct WindowsD3d11PreviewContract {
    media_generation: u64,
    adapter_luid: DxgiAdapterLuid,
    preview_generation: Option<u64>,
    target_window_handle: Option<u64>,
    configuration_ready: bool,
    diagnostics: WindowsD3d11PresenterDiagnostics,
}

impl WindowsD3d11PreviewContract {
    pub(crate) fn new(media_generation: u64, adapter_luid: DxgiAdapterLuid) -> Self {
        let diagnostics = WindowsD3d11PresenterDiagnostics {
            media_generation,
            fallback_reason: Some(
                WindowsD3d11PreviewFallbackReason::WaitingForTrustedWindow
                    .as_str()
                    .to_string(),
            ),
            ..Default::default()
        };
        Self {
            media_generation,
            adapter_luid,
            preview_generation: None,
            target_window_handle: None,
            configuration_ready: false,
            diagnostics,
        }
    }

    pub(crate) fn configure(
        &mut self,
        placement: WindowsD3d11PreviewPlacement,
        readback: WindowsD3d11PreviewWindowReadback,
    ) {
        let identity_changed = self.preview_generation != Some(placement.preview_generation)
            || self.target_window_handle != Some(placement.target_window_handle);
        if identity_changed {
            self.diagnostics.first_present_succeeded = false;
            self.diagnostics.source_live = false;
            self.diagnostics.last_presented_sequence = None;
        }
        self.preview_generation = Some(placement.preview_generation);
        self.target_window_handle = Some(placement.target_window_handle);
        self.diagnostics.preview_generation = Some(placement.preview_generation);
        self.diagnostics.generation_matches = placement.media_generation == self.media_generation
            && placement.preview_generation != 0;
        self.diagnostics.same_adapter = placement.adapter_luid == self.adapter_luid;
        self.diagnostics.owner_process_matches = readback.owner_process_matches;
        self.diagnostics.layered = readback.layered;
        self.diagnostics.transparent = readback.transparent;
        self.diagnostics.no_activate = readback.no_activate;
        self.diagnostics.excluded_from_capture = readback.excluded_from_capture;
        self.diagnostics.window_active = readback.window_active;
        self.diagnostics.window_focused = readback.window_focused;
        self.diagnostics.actual_bounds = readback.actual_bounds;
        self.diagnostics.fallback_reason = if !readback.target_exists {
            Some(
                WindowsD3d11PreviewFallbackReason::DestroyedTargetWindow
                    .as_str()
                    .to_string(),
            )
        } else if !readback.owner_process_matches {
            Some(
                WindowsD3d11PreviewFallbackReason::ForeignTargetOwner
                    .as_str()
                    .to_string(),
            )
        } else if !readback.stacked_immediately_above {
            Some(
                WindowsD3d11PreviewFallbackReason::WindowStackingFailed
                    .as_str()
                    .to_string(),
            )
        } else if !self.diagnostics.generation_matches {
            Some(
                WindowsD3d11PreviewFallbackReason::StaleGeneration
                    .as_str()
                    .to_string(),
            )
        } else if !self.diagnostics.same_adapter {
            Some(
                WindowsD3d11PreviewFallbackReason::AdapterMismatch
                    .as_str()
                    .to_string(),
            )
        } else if !readback.layered || !readback.transparent || !readback.no_activate {
            Some(
                WindowsD3d11PreviewFallbackReason::WindowStyleReadbackFailed
                    .as_str()
                    .to_string(),
            )
        } else if !readback.excluded_from_capture {
            Some(
                WindowsD3d11PreviewFallbackReason::CaptureExclusionFailed
                    .as_str()
                    .to_string(),
            )
        } else {
            None
        };
        self.configuration_ready = self.diagnostics.fallback_reason.is_none();
    }

    pub(crate) fn note_latest_wins_drop(&mut self) {
        self.note_latest_wins_drops(1);
    }

    pub(crate) fn note_latest_wins_drops(&mut self, count: u64) {
        self.diagnostics.latest_wins_drops =
            self.diagnostics.latest_wins_drops.saturating_add(count);
    }

    pub(crate) fn observe_present(
        &mut self,
        frame: WindowsD3d11PreviewFrameMetadata,
        outcome: WindowsD3d11PreviewPresentOutcome,
    ) {
        if Some(frame.preview_generation) != self.preview_generation
            || frame.media_generation != self.media_generation
            || frame.adapter_luid != self.adapter_luid
        {
            self.diagnostics.stale_frame_drops =
                self.diagnostics.stale_frame_drops.saturating_add(1);
            self.diagnostics.fallback_reason = Some(
                WindowsD3d11PreviewFallbackReason::StaleGeneration
                    .as_str()
                    .to_string(),
            );
            return;
        }
        match outcome {
            WindowsD3d11PreviewPresentOutcome::Presented => {
                self.diagnostics.successful_presents =
                    self.diagnostics.successful_presents.saturating_add(1);
                self.diagnostics.last_presented_sequence = Some(frame.sequence);
                self.diagnostics.first_present_succeeded = true;
                self.diagnostics.source_live = frame.source_live;
                self.diagnostics.fallback_reason = if !self.configuration_ready {
                    self.diagnostics.fallback_reason.clone()
                } else if frame.source_live {
                    None
                } else {
                    Some(
                        WindowsD3d11PreviewFallbackReason::SourceStalled
                            .as_str()
                            .to_string(),
                    )
                };
            }
            WindowsD3d11PreviewPresentOutcome::Hidden => {
                self.diagnostics.hidden_drops = self.diagnostics.hidden_drops.saturating_add(1);
            }
            WindowsD3d11PreviewPresentOutcome::Busy => {
                self.diagnostics.busy_drops = self.diagnostics.busy_drops.saturating_add(1);
            }
            WindowsD3d11PreviewPresentOutcome::Failed(reason) => {
                self.diagnostics.fallback_reason = Some(reason.as_str().to_string());
            }
        }
    }

    pub(crate) fn canonical_claim_ready(&self) -> bool {
        self.configuration_ready
            && self.diagnostics.generation_matches
            && self.diagnostics.owner_process_matches
            && self.diagnostics.same_adapter
            && self.diagnostics.layered
            && self.diagnostics.transparent
            && self.diagnostics.no_activate
            && self.diagnostics.excluded_from_capture
            && !self.diagnostics.window_active
            && !self.diagnostics.window_focused
            && self.diagnostics.first_present_succeeded
            && self.diagnostics.source_live
            && self.diagnostics.fallback_reason.is_none()
    }

    pub(crate) fn diagnostics(&self) -> WindowsD3d11PresenterDiagnostics {
        self.diagnostics.clone()
    }
}

#[cfg(target_os = "windows")]
mod runtime {
    use super::*;
    use crate::windows_d3d11_device::{
        WindowsD3d11Device, WindowsD3d11Error, WindowsD3d11ErrorCode,
    };
    use std::mem::size_of;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
    use windows::Win32::Graphics::DirectComposition::{
        DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::{
        DXGI_ERROR_WAS_STILL_DRAWING, DXGI_MATRIX_3X2_F, DXGI_PRESENT_DO_NOT_WAIT,
        DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGIOutput,
        IDXGISwapChain1, IDXGISwapChain2,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GUITHREADINFO, GW_HWNDPREV, GWL_EXSTYLE,
        GetGUIThreadInfo, GetTopWindow, GetWindow, GetWindowDisplayAffinity, GetWindowLongPtrW,
        GetWindowRect, GetWindowThreadProcessId, HTTRANSPARENT, HWND_TOP, IsIconic, IsWindow,
        IsWindowVisible, MA_NOACTIVATE, RegisterClassExW, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE,
        SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
        WDA_EXCLUDEFROMCAPTURE, WINDOW_EX_STYLE, WM_CLOSE, WM_MOUSEACTIVATE, WM_NCHITTEST,
        WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT, WS_POPUP,
    };
    use windows::core::{Interface, PCWSTR, w};

    const PRESENTER_CLASS_NAME: PCWSTR = w!("VideorcD3d11PreviewPresenter");
    static PRESENTER_CLASS: OnceLock<Result<(), String>> = OnceLock::new();

    #[derive(Debug, Clone)]
    pub(crate) struct WindowsD3d11PresenterStatus {
        pub(crate) diagnostics: WindowsD3d11PresenterDiagnostics,
        pub(crate) canonical_claim_ready: bool,
    }

    struct DirectCompositionResources {
        _device: IDCompositionDevice,
        _target: IDCompositionTarget,
        visual: IDCompositionVisual,
        swap_chain: IDXGISwapChain1,
        swap_chain2: IDXGISwapChain2,
        width: u32,
        height: u32,
    }

    pub(crate) struct WindowsD3d11Presenter {
        media_generation: u64,
        adapter_luid: DxgiAdapterLuid,
        placement: WindowsD3d11PreviewPlacement,
        hwnd: HWND,
        contract: WindowsD3d11PreviewContract,
        resources: Option<DirectCompositionResources>,
    }

    impl WindowsD3d11Presenter {
        pub(crate) fn create(
            device: &WindowsD3d11Device,
            media_generation: u64,
            placement: WindowsD3d11PreviewPlacement,
        ) -> Result<Self, WindowsD3d11Error> {
            validate_placement_authority(device, media_generation, placement)?;
            register_presenter_class()?;
            let target = validate_target_window(placement)?;
            let bounds = placement
                .visible_bounds()
                .unwrap_or(WindowsD3d11PresenterBounds {
                    x: rounded_i32(placement.screen_x),
                    y: rounded_i32(placement.screen_y),
                    width: rounded_u32(placement.width.max(1.0)),
                    height: rounded_u32(placement.height.max(1.0)),
                });
            let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::WindowCreationFailed,
                    "GetModuleHandleW",
                    error,
                )
            })?;
            let ex_style = presenter_extended_style();
            let hwnd = unsafe {
                CreateWindowExW(
                    ex_style,
                    PRESENTER_CLASS_NAME,
                    w!("Videorc preview"),
                    WS_POPUP,
                    bounds.x,
                    bounds.y,
                    i32::try_from(bounds.width).unwrap_or(i32::MAX),
                    i32::try_from(bounds.height).unwrap_or(i32::MAX),
                    Some(target),
                    None,
                    Some(HINSTANCE(module.0)),
                    None,
                )
            }
            .map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::WindowCreationFailed,
                    "CreateWindowExW",
                    error,
                )
            })?;
            let mut presenter = Self {
                media_generation,
                adapter_luid: device.adapter_luid(),
                placement,
                hwnd,
                contract: WindowsD3d11PreviewContract::new(media_generation, device.adapter_luid()),
                resources: None,
            };
            if let Err(error) = presenter.apply_window_contract() {
                let _ = unsafe { DestroyWindow(hwnd) };
                return Err(error);
            }
            Ok(presenter)
        }

        pub(crate) fn configure(
            &mut self,
            device: &WindowsD3d11Device,
            placement: WindowsD3d11PreviewPlacement,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            validate_placement_authority(device, self.media_generation, placement)?;
            if placement.target_window_handle != self.placement.target_window_handle {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::UnsupportedCapability,
                    "preview target HWND changed; destroy and recreate the presenter generation",
                ));
            }
            self.placement = placement;
            self.apply_window_contract()?;
            self.apply_composition_transform()?;
            Ok(self.status())
        }

        pub(crate) fn present(
            &mut self,
            device: &WindowsD3d11Device,
            texture: &ID3D11Texture2D,
            frame: WindowsD3d11PreviewFrameMetadata,
            width: u32,
            height: u32,
        ) -> Result<WindowsD3d11PresenterStatus, WindowsD3d11Error> {
            validate_placement_authority(device, self.media_generation, self.placement)?;
            let target = validate_target_window(self.placement)?;
            if !self.placement.visible
                || self.placement.visible_bounds().is_none()
                || unsafe { IsIconic(target) }.as_bool()
                || !unsafe { IsWindowVisible(target) }.as_bool()
            {
                unsafe {
                    let _ = ShowWindow(self.hwnd, SW_HIDE);
                }
                self.contract
                    .observe_present(frame, WindowsD3d11PreviewPresentOutcome::Hidden);
                return Ok(self.status());
            }
            self.apply_window_contract()?;
            self.ensure_resources(device, width, height)?;
            let resources = self.resources.as_ref().ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::CompositorUnavailable,
                    "DirectComposition resources disappeared before preview present",
                )
            })?;
            let back_buffer: ID3D11Texture2D = unsafe { resources.swap_chain.GetBuffer(0) }
                .map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::SwapChainUnavailable,
                        "IDXGISwapChain::GetBuffer",
                        error,
                    )
                })?;
            unsafe {
                device
                    .immediate_context()
                    .CopyResource(&back_buffer, texture);
            }
            let present_result =
                unsafe { resources.swap_chain.Present(0, DXGI_PRESENT_DO_NOT_WAIT) };
            if present_result == DXGI_ERROR_WAS_STILL_DRAWING {
                self.contract
                    .observe_present(frame, WindowsD3d11PreviewPresentOutcome::Busy);
                return Ok(self.status());
            }
            if let Err(error) = present_result.ok() {
                self.contract.observe_present(
                    frame,
                    WindowsD3d11PreviewPresentOutcome::Failed(
                        WindowsD3d11PreviewFallbackReason::PresentFailed,
                    ),
                );
                return Err(preview_error(
                    WindowsD3d11PreviewFallbackReason::PresentFailed,
                    "IDXGISwapChain::Present",
                    error,
                ));
            }
            self.contract
                .observe_present(frame, WindowsD3d11PreviewPresentOutcome::Presented);
            Ok(self.status())
        }

        pub(crate) fn note_latest_wins_drop(&mut self) {
            self.contract.note_latest_wins_drop();
        }

        pub(crate) fn note_latest_wins_drops(&mut self, count: u64) {
            self.contract.note_latest_wins_drops(count);
        }

        pub(crate) const fn target_window_handle(&self) -> u64 {
            self.placement.target_window_handle
        }

        pub(crate) fn status(&self) -> WindowsD3d11PresenterStatus {
            WindowsD3d11PresenterStatus {
                diagnostics: self.contract.diagnostics(),
                canonical_claim_ready: self.contract.canonical_claim_ready(),
            }
        }

        fn ensure_resources(
            &mut self,
            device: &WindowsD3d11Device,
            width: u32,
            height: u32,
        ) -> Result<(), WindowsD3d11Error> {
            if self
                .resources
                .as_ref()
                .is_some_and(|resources| resources.width == width && resources.height == height)
            {
                return Ok(());
            }
            self.resources = None;
            let dxgi_device: IDXGIDevice = device.raw_device().cast().map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                    "ID3D11Device::cast<IDXGIDevice>",
                    error,
                )
            })?;
            let adapter: IDXGIAdapter = unsafe { dxgi_device.GetAdapter() }.map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                    "IDXGIDevice::GetAdapter",
                    error,
                )
            })?;
            let factory: IDXGIFactory2 = unsafe { adapter.GetParent() }.map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                    "IDXGIAdapter::GetParent<IDXGIFactory2>",
                    error,
                )
            })?;
            let descriptor = presenter_swap_chain_descriptor(width, height);
            let swap_chain = unsafe {
                factory.CreateSwapChainForComposition(
                    device.raw_device(),
                    &descriptor,
                    None::<&IDXGIOutput>,
                )
            }
            .map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::SwapChainUnavailable,
                    "IDXGIFactory2::CreateSwapChainForComposition",
                    error,
                )
            })?;
            let swap_chain2: IDXGISwapChain2 = swap_chain.cast().map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::SwapChainUnavailable,
                    "IDXGISwapChain1::cast<IDXGISwapChain2>",
                    error,
                )
            })?;
            let composition_device: IDCompositionDevice =
                unsafe { DCompositionCreateDevice(&dxgi_device) }.map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "DCompositionCreateDevice",
                        error,
                    )
                })?;
            let target = unsafe { composition_device.CreateTargetForHwnd(self.hwnd, false) }
                .map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionDevice::CreateTargetForHwnd",
                        error,
                    )
                })?;
            let visual = unsafe { composition_device.CreateVisual() }.map_err(|error| {
                preview_error(
                    WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                    "IDCompositionDevice::CreateVisual",
                    error,
                )
            })?;
            unsafe {
                visual.SetContent(&swap_chain).map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionVisual::SetContent",
                        error,
                    )
                })?;
                target.SetRoot(&visual).map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionTarget::SetRoot",
                        error,
                    )
                })?;
                composition_device.Commit().map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionDevice::Commit",
                        error,
                    )
                })?;
            }
            self.resources = Some(DirectCompositionResources {
                _device: composition_device,
                _target: target,
                visual,
                swap_chain,
                swap_chain2,
                width,
                height,
            });
            self.apply_composition_transform()
        }

        fn apply_composition_transform(&self) -> Result<(), WindowsD3d11Error> {
            let Some(resources) = self.resources.as_ref() else {
                return Ok(());
            };
            let scale_x = (self.placement.width / f64::from(resources.width))
                .clamp(f64::from(f32::MIN_POSITIVE), f64::from(f32::MAX))
                as f32;
            let scale_y = (self.placement.height / f64::from(resources.height))
                .clamp(f64::from(f32::MIN_POSITIVE), f64::from(f32::MAX))
                as f32;
            let matrix = DXGI_MATRIX_3X2_F {
                _11: scale_x,
                _12: 0.0,
                _21: 0.0,
                _22: scale_y,
                _31: 0.0,
                _32: 0.0,
            };
            let (offset_x, offset_y) = self.placement.visual_offset();
            unsafe {
                resources
                    .swap_chain2
                    .SetMatrixTransform(&matrix)
                    .map_err(|error| {
                        preview_error(
                            WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                            "IDXGISwapChain2::SetMatrixTransform",
                            error,
                        )
                    })?;
                resources.visual.SetOffsetX2(offset_x).map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionVisual::SetOffsetX",
                        error,
                    )
                })?;
                resources.visual.SetOffsetY2(offset_y).map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionVisual::SetOffsetY",
                        error,
                    )
                })?;
                resources._device.Commit().map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::DirectCompositionUnavailable,
                        "IDCompositionDevice::Commit(transform)",
                        error,
                    )
                })?;
            }
            Ok(())
        }

        fn apply_window_contract(&mut self) -> Result<(), WindowsD3d11Error> {
            let target = validate_target_window(self.placement)?;
            unsafe {
                SetWindowDisplayAffinity(self.hwnd, WDA_EXCLUDEFROMCAPTURE).map_err(|error| {
                    preview_error(
                        WindowsD3d11PreviewFallbackReason::CaptureExclusionFailed,
                        "SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)",
                        error,
                    )
                })?;
            }
            if let Some(bounds) = self.placement.visible_bounds() {
                // `hWndInsertAfter` names the window that must precede the
                // positioned window. Therefore using `target` directly would
                // place the presenter *behind* the Electron window. Anchor to
                // the target's current predecessor so the presenter lands
                // immediately above the target without becoming topmost.
                let (insert_after, z_order_flags) = match unsafe { GetWindow(target, GW_HWNDPREV) }
                {
                    Ok(window_above) if window_above == self.hwnd => (None, SWP_NOZORDER),
                    Ok(window_above) => (Some(window_above), Default::default()),
                    Err(_) => {
                        let top = unsafe { GetTopWindow(None) }.map_err(|error| {
                            preview_error(
                                WindowsD3d11PreviewFallbackReason::WindowStackingFailed,
                                "GetTopWindow",
                                error,
                            )
                        })?;
                        if top != target {
                            return Err(WindowsD3d11Error::new(
                                WindowsD3d11ErrorCode::CompositorUnavailable,
                                WindowsD3d11PreviewFallbackReason::WindowStackingFailed.as_str(),
                            ));
                        }
                        (Some(HWND_TOP), Default::default())
                    }
                };
                unsafe {
                    SetWindowPos(
                        self.hwnd,
                        insert_after,
                        bounds.x,
                        bounds.y,
                        i32::try_from(bounds.width).unwrap_or(i32::MAX),
                        i32::try_from(bounds.height).unwrap_or(i32::MAX),
                        SWP_NOACTIVATE | SWP_SHOWWINDOW | z_order_flags,
                    )
                    .map_err(|error| {
                        preview_error(
                            WindowsD3d11PreviewFallbackReason::WindowCreationFailed,
                            "SetWindowPos",
                            error,
                        )
                    })?;
                    let _ = ShowWindow(self.hwnd, SW_SHOWNA);
                }
            } else {
                unsafe {
                    let _ = ShowWindow(self.hwnd, SW_HIDE);
                }
            }
            let readback = read_window_contract(self.hwnd, target, self.placement)?;
            self.contract.configure(self.placement, readback);
            if !readback.stacked_immediately_above {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::CompositorUnavailable,
                    WindowsD3d11PreviewFallbackReason::WindowStackingFailed.as_str(),
                ));
            }
            if !readback.layered || !readback.transparent || !readback.no_activate {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::CompositorUnavailable,
                    WindowsD3d11PreviewFallbackReason::WindowStyleReadbackFailed.as_str(),
                ));
            }
            if !readback.excluded_from_capture {
                return Err(WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::CompositorUnavailable,
                    WindowsD3d11PreviewFallbackReason::CaptureExclusionFailed.as_str(),
                ));
            }
            Ok(())
        }
    }

    impl Drop for WindowsD3d11Presenter {
        fn drop(&mut self) {
            self.resources = None;
            let _ = unsafe { DestroyWindow(self.hwnd) };
        }
    }

    fn validate_placement_authority(
        device: &WindowsD3d11Device,
        media_generation: u64,
        placement: WindowsD3d11PreviewPlacement,
    ) -> Result<(), WindowsD3d11Error> {
        if placement.media_generation != media_generation || placement.preview_generation == 0 {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::StaleGeneration,
                WindowsD3d11PreviewFallbackReason::StaleGeneration.as_str(),
            ));
        }
        if placement.adapter_luid != device.adapter_luid() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::AdapterMismatch,
                WindowsD3d11PreviewFallbackReason::AdapterMismatch.as_str(),
            ));
        }
        Ok(())
    }

    fn validate_target_window(
        placement: WindowsD3d11PreviewPlacement,
    ) -> Result<HWND, WindowsD3d11Error> {
        let pointer = usize::try_from(placement.target_window_handle).map_err(|_| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                "trusted preview HWND does not fit this process pointer width",
            )
        })?;
        if pointer == 0 || pointer as u64 != placement.target_window_handle {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                "trusted preview HWND is zero or non-canonical",
            ));
        }
        let authenticated_pid = std::env::var("VIDEORC_SUPERVISOR_PID")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .ok_or_else(|| {
                WindowsD3d11Error::new(
                    WindowsD3d11ErrorCode::UnsupportedCapability,
                    "authenticated Electron supervisor PID is unavailable",
                )
            })?;
        if placement.expected_owner_process_id != authenticated_pid {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::UnsupportedCapability,
                "preview placement owner PID does not match the authenticated supervisor",
            ));
        }
        let hwnd = HWND(pointer as *mut core::ffi::c_void);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CompositorUnavailable,
                WindowsD3d11PreviewFallbackReason::DestroyedTargetWindow.as_str(),
            ));
        }
        let mut owner_pid = 0_u32;
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner_pid)) };
        if thread_id == 0 || owner_pid != authenticated_pid {
            return Err(WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CompositorUnavailable,
                WindowsD3d11PreviewFallbackReason::ForeignTargetOwner.as_str(),
            ));
        }
        Ok(hwnd)
    }

    fn read_window_contract(
        hwnd: HWND,
        target: HWND,
        placement: WindowsD3d11PreviewPlacement,
    ) -> Result<WindowsD3d11PreviewWindowReadback, WindowsD3d11Error> {
        let ex_style = WINDOW_EX_STYLE(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32);
        let mut affinity = 0_u32;
        unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.map_err(|error| {
            preview_error(
                WindowsD3d11PreviewFallbackReason::CaptureExclusionFailed,
                "GetWindowDisplayAffinity",
                error,
            )
        })?;
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| {
            preview_error(
                WindowsD3d11PreviewFallbackReason::WindowStyleReadbackFailed,
                "GetWindowRect",
                error,
            )
        })?;
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, None) };
        let mut gui = GUITHREADINFO {
            cbSize: u32::try_from(size_of::<GUITHREADINFO>()).unwrap_or(u32::MAX),
            ..GUITHREADINFO::default()
        };
        let gui_read = thread_id != 0 && unsafe { GetGUIThreadInfo(thread_id, &mut gui) }.is_ok();
        let mut owner_pid = 0_u32;
        let target_exists = unsafe { IsWindow(Some(target)) }.as_bool();
        let target_thread = unsafe { GetWindowThreadProcessId(target, Some(&mut owner_pid)) };
        let stacked_immediately_above = unsafe { GetWindow(target, GW_HWNDPREV) }
            .is_ok_and(|window_above| window_above == hwnd);
        let width = rect.right.saturating_sub(rect.left);
        let height = rect.bottom.saturating_sub(rect.top);
        Ok(WindowsD3d11PreviewWindowReadback {
            target_exists,
            owner_process_matches: target_thread != 0
                && owner_pid == placement.expected_owner_process_id,
            stacked_immediately_above,
            layered: ex_style.0 & WS_EX_LAYERED.0 != 0,
            transparent: ex_style.0 & WS_EX_TRANSPARENT.0 != 0,
            no_activate: ex_style.0 & WS_EX_NOACTIVATE.0 != 0,
            excluded_from_capture: affinity == WDA_EXCLUDEFROMCAPTURE.0,
            window_active: gui_read && gui.hwndActive == hwnd,
            window_focused: gui_read && gui.hwndFocus == hwnd,
            actual_bounds: (width > 0 && height > 0).then_some(WindowsD3d11PresenterBounds {
                x: rect.left,
                y: rect.top,
                width: width as u32,
                height: height as u32,
            }),
        })
    }

    fn register_presenter_class() -> Result<(), WindowsD3d11Error> {
        let result = PRESENTER_CLASS.get_or_init(|| {
            let module = unsafe { GetModuleHandleW(PCWSTR::null()) }
                .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
            let class = WNDCLASSEXW {
                cbSize: u32::try_from(size_of::<WNDCLASSEXW>()).unwrap_or(u32::MAX),
                lpfnWndProc: Some(presenter_wnd_proc),
                hInstance: HINSTANCE(module.0),
                lpszClassName: PRESENTER_CLASS_NAME,
                ..WNDCLASSEXW::default()
            };
            if unsafe { RegisterClassExW(&class) } == 0 {
                return Err(format!(
                    "RegisterClassExW failed: {}",
                    windows::core::Error::from_thread()
                ));
            }
            Ok(())
        });
        result.clone().map_err(|detail| {
            WindowsD3d11Error::new(
                WindowsD3d11ErrorCode::CompositorUnavailable,
                format!(
                    "{}: {detail}",
                    WindowsD3d11PreviewFallbackReason::WindowCreationFailed.as_str()
                ),
            )
        })
    }

    fn presenter_extended_style() -> WINDOW_EX_STYLE {
        WS_EX_LAYERED
            | WS_EX_TRANSPARENT
            | WS_EX_NOACTIVATE
            | WS_EX_TOOLWINDOW
            | WS_EX_NOREDIRECTIONBITMAP
    }

    fn presenter_swap_chain_descriptor(width: u32, height: u32) -> DXGI_SWAP_CHAIN_DESC1 {
        DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: 0,
        }
    }

    unsafe extern "system" fn presenter_wnd_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            // Only the media-authority teardown destroys this window.
            WM_CLOSE => LRESULT(0),
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn preview_error(
        reason: WindowsD3d11PreviewFallbackReason,
        operation: &str,
        error: windows::core::Error,
    ) -> WindowsD3d11Error {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::CompositorUnavailable,
            format!("{}: {operation} failed: {error}", reason.as_str()),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_d3d11_preview_extended_style_contains_click_through_noactivate_triple() {
            let style = presenter_extended_style();
            assert_ne!(style.0 & WS_EX_LAYERED.0, 0);
            assert_ne!(style.0 & WS_EX_TRANSPARENT.0, 0);
            assert_ne!(style.0 & WS_EX_NOACTIVATE.0, 0);
        }

        #[test]
        fn windows_d3d11_preview_wndproc_is_transparent_and_never_activates() {
            let hit = unsafe {
                presenter_wnd_proc(
                    HWND::default(),
                    WM_NCHITTEST,
                    WPARAM::default(),
                    LPARAM::default(),
                )
            };
            let activate = unsafe {
                presenter_wnd_proc(
                    HWND::default(),
                    WM_MOUSEACTIVATE,
                    WPARAM::default(),
                    LPARAM::default(),
                )
            };
            assert_eq!(hit.0, HTTRANSPARENT as isize);
            assert_eq!(activate.0, MA_NOACTIVATE as isize);
        }

        #[test]
        fn windows_d3d11_preview_swapchain_is_flip_model_bgra_and_double_buffered() {
            let descriptor = presenter_swap_chain_descriptor(1920, 1080);
            assert_eq!(descriptor.Width, 1920);
            assert_eq!(descriptor.Height, 1080);
            assert_eq!(descriptor.Format, DXGI_FORMAT_B8G8R8A8_UNORM);
            assert_eq!(descriptor.BufferCount, 2);
            assert_eq!(descriptor.SwapEffect, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL);
            assert_eq!(descriptor.AlphaMode, DXGI_ALPHA_MODE_PREMULTIPLIED);
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use runtime::{WindowsD3d11Presenter, WindowsD3d11PresenterStatus};

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(generation: u64, preview_generation: u64) -> WindowsD3d11PreviewPlacement {
        WindowsD3d11PreviewPlacement {
            media_generation: generation,
            preview_generation,
            adapter_luid: DxgiAdapterLuid::from_u64(7),
            target_window_handle: 55,
            expected_owner_process_id: 9001,
            screen_x: 100.0,
            screen_y: 200.0,
            width: 800.0,
            height: 450.0,
            clip_x: None,
            clip_y: None,
            clip_width: None,
            clip_height: None,
            visible: true,
        }
    }

    fn trusted_readback() -> WindowsD3d11PreviewWindowReadback {
        WindowsD3d11PreviewWindowReadback {
            target_exists: true,
            owner_process_matches: true,
            stacked_immediately_above: true,
            layered: true,
            transparent: true,
            no_activate: true,
            excluded_from_capture: true,
            window_active: false,
            window_focused: false,
            actual_bounds: Some(WindowsD3d11PresenterBounds {
                x: 100,
                y: 200,
                width: 800,
                height: 450,
            }),
        }
    }

    #[test]
    fn windows_d3d11_preview_diagnostics_identify_the_media_authority_generation() {
        let mut contract = WindowsD3d11PreviewContract::new(41, DxgiAdapterLuid::from_u64(7));
        assert_eq!(contract.diagnostics().media_generation, 41);
        assert_eq!(
            contract.diagnostics().fallback_reason.as_deref(),
            Some(WindowsD3d11PreviewFallbackReason::WaitingForTrustedWindow.as_str())
        );

        contract.configure(placement(41, 9), trusted_readback());
        assert_eq!(contract.diagnostics().media_generation, 41);
    }

    #[test]
    fn windows_d3d11_preview_claim_requires_first_present_and_source_liveness() {
        let mut contract = WindowsD3d11PreviewContract::new(3, DxgiAdapterLuid::from_u64(7));
        contract.configure(placement(3, 9), trusted_readback());
        assert!(!contract.canonical_claim_ready());
        contract.observe_present(
            WindowsD3d11PreviewFrameMetadata {
                media_generation: 3,
                preview_generation: 9,
                adapter_luid: DxgiAdapterLuid::from_u64(7),
                sequence: 1,
                source_live: false,
            },
            WindowsD3d11PreviewPresentOutcome::Presented,
        );
        assert!(!contract.canonical_claim_ready());
        contract.observe_present(
            WindowsD3d11PreviewFrameMetadata {
                media_generation: 3,
                preview_generation: 9,
                adapter_luid: DxgiAdapterLuid::from_u64(7),
                sequence: 2,
                source_live: true,
            },
            WindowsD3d11PreviewPresentOutcome::Presented,
        );
        assert!(contract.canonical_claim_ready());
    }

    #[test]
    fn windows_d3d11_preview_rejects_foreign_owner_and_stale_generation() {
        let mut contract = WindowsD3d11PreviewContract::new(3, DxgiAdapterLuid::from_u64(7));
        let mut readback = trusted_readback();
        readback.owner_process_matches = false;
        contract.configure(placement(3, 9), readback);
        assert_eq!(
            contract.diagnostics().fallback_reason.as_deref(),
            Some(WindowsD3d11PreviewFallbackReason::ForeignTargetOwner.as_str())
        );
        contract.configure(placement(4, 9), trusted_readback());
        assert_eq!(
            contract.diagnostics().fallback_reason.as_deref(),
            Some(WindowsD3d11PreviewFallbackReason::StaleGeneration.as_str())
        );
    }

    #[test]
    fn windows_d3d11_preview_rejects_missing_target_and_wrong_z_order() {
        let mut contract = WindowsD3d11PreviewContract::new(3, DxgiAdapterLuid::from_u64(7));
        let frame = WindowsD3d11PreviewFrameMetadata {
            media_generation: 3,
            preview_generation: 9,
            adapter_luid: DxgiAdapterLuid::from_u64(7),
            sequence: 1,
            source_live: true,
        };
        let mut readback = trusted_readback();
        readback.target_exists = false;
        contract.configure(placement(3, 9), readback);
        contract.observe_present(frame, WindowsD3d11PreviewPresentOutcome::Presented);
        assert!(!contract.canonical_claim_ready());
        assert_eq!(
            contract.diagnostics().fallback_reason.as_deref(),
            Some(WindowsD3d11PreviewFallbackReason::DestroyedTargetWindow.as_str())
        );

        let mut readback = trusted_readback();
        readback.stacked_immediately_above = false;
        contract.configure(placement(3, 10), readback);
        let mut frame = frame;
        frame.preview_generation = 10;
        contract.observe_present(frame, WindowsD3d11PreviewPresentOutcome::Presented);
        assert!(!contract.canonical_claim_ready());
        assert_eq!(
            contract.diagnostics().fallback_reason.as_deref(),
            Some(WindowsD3d11PreviewFallbackReason::WindowStackingFailed.as_str())
        );
    }

    #[test]
    fn windows_d3d11_preview_hidden_and_busy_frames_drop_without_revoking_claim() {
        let mut contract = WindowsD3d11PreviewContract::new(3, DxgiAdapterLuid::from_u64(7));
        contract.configure(placement(3, 9), trusted_readback());
        let frame = WindowsD3d11PreviewFrameMetadata {
            media_generation: 3,
            preview_generation: 9,
            adapter_luid: DxgiAdapterLuid::from_u64(7),
            sequence: 1,
            source_live: true,
        };
        contract.observe_present(frame, WindowsD3d11PreviewPresentOutcome::Presented);
        contract.observe_present(frame, WindowsD3d11PreviewPresentOutcome::Hidden);
        contract.observe_present(frame, WindowsD3d11PreviewPresentOutcome::Busy);
        let diagnostics = contract.diagnostics();
        assert!(contract.canonical_claim_ready());
        assert_eq!(diagnostics.successful_presents, 1);
        assert_eq!(diagnostics.hidden_drops, 1);
        assert_eq!(diagnostics.busy_drops, 1);
    }

    #[test]
    fn windows_d3d11_preview_clipped_actual_bounds_are_scalar_and_sanitized() {
        let mut placement = placement(3, 9);
        placement.clip_x = Some(120.0);
        placement.clip_y = Some(230.0);
        placement.clip_width = Some(600.0);
        placement.clip_height = Some(300.0);
        assert_eq!(
            placement.visible_bounds(),
            Some(WindowsD3d11PresenterBounds {
                x: 120,
                y: 230,
                width: 600,
                height: 300,
            })
        );
        assert_eq!(placement.visual_offset(), (-20.0, -30.0));
    }

    #[test]
    fn windows_d3d11_preview_latest_wins_drop_is_bounded_diagnostic() {
        let mut contract = WindowsD3d11PreviewContract::new(3, DxgiAdapterLuid::from_u64(7));
        contract.note_latest_wins_drop();
        contract.note_latest_wins_drop();
        assert_eq!(contract.diagnostics().latest_wins_drops, 2);
    }
}
