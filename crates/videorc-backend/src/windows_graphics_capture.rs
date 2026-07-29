//! Opt-in Windows Graphics Capture foundation for the texture-native media graph.
//!
//! This first slice deliberately retains the existing CPU bytes alongside the
//! captured D3D11 texture. The bytes keep the current compositor/fallback
//! behavior intact while the retained texture becomes the handoff contract for
//! the direct-record path and the future Windows GPU compositor.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::{
    Common::DXGI_FORMAT_B8G8R8A8_UNORM, CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter,
    IDXGIAdapter1, IDXGIDevice, IDXGIFactory1,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::{IInspectable, Interface, factory};

use crate::frame_store::RetainedD3D11Texture;
use crate::screen_capture::WindowsDxgiSourceId;

const CAPTURE_QUEUE_DEPTH: usize = 2;
const CALLBACK_STOP_TIMEOUT: Duration = Duration::from_secs(2);

pub fn opt_in_enabled() -> bool {
    opt_in_value_enabled(
        std::env::var("VIDEORC_WINDOWS_GRAPHICS_CAPTURE")
            .ok()
            .as_deref(),
    )
}

fn opt_in_value_enabled(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[derive(Debug)]
pub struct WindowsCaptureFrame {
    texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    pub timestamp_100ns: i64,
}

impl WindowsCaptureFrame {
    pub fn retained_texture(&self, adapter_luid: u64) -> RetainedD3D11Texture {
        RetainedD3D11Texture::new(self.texture.clone(), adapter_luid)
    }
}

enum CaptureEvent {
    Frame(WindowsCaptureFrame),
    Failed(String),
}

struct RoApartment;

impl RoApartment {
    fn initialize() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .context("Windows Graphics Capture could not initialize WinRT MTA")?;
        Ok(Self)
    }
}

impl Drop for RoApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct CallbackActivity {
    active: Mutex<usize>,
    idle: Condvar,
}

impl CallbackActivity {
    fn new() -> Self {
        Self {
            active: Mutex::new(0),
            idle: Condvar::new(),
        }
    }

    fn enter(self: &Arc<Self>) -> CallbackActivityGuard {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active += 1;
        CallbackActivityGuard {
            activity: Arc::clone(self),
        }
    }

    fn wait_idle(&self, timeout: Duration) {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self
            .idle
            .wait_timeout_while(active, timeout, |active| *active > 0);
    }
}

struct CallbackActivityGuard {
    activity: Arc<CallbackActivity>,
}

impl Drop for CallbackActivityGuard {
    fn drop(&mut self) {
        let mut active = self
            .activity
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active = active.saturating_sub(1);
        if *active == 0 {
            self.activity.idle.notify_all();
        }
    }
}

pub struct WindowsGraphicsCapture {
    adapter_luid: u64,
    receiver: Receiver<CaptureEvent>,
    session: GraphicsCaptureSession,
    frame_pool: Direct3D11CaptureFramePool,
    frame_arrived_token: i64,
    callback_activity: Arc<CallbackActivity>,
    stop_flag: Arc<AtomicBool>,
    dropped_frames: Arc<AtomicU64>,
    readback: D3D11BgraReadback,
    _device: ID3D11Device,
    _apartment: RoApartment,
}

impl WindowsGraphicsCapture {
    pub fn start(source: WindowsDxgiSourceId, fps: u32, include_cursor: bool) -> Result<Self> {
        let apartment = RoApartment::initialize()?;
        ensure!(
            GraphicsCaptureSession::IsSupported().unwrap_or(false),
            "Windows Graphics Capture is not supported on this device"
        );
        let (adapter, monitor) = find_dxgi_output(source)?;
        let (device, context) = create_d3d11_device(&adapter)?;
        let item = create_capture_item(monitor)?;
        let size = item
            .Size()
            .context("Windows Graphics Capture item did not expose its size")?;
        ensure!(
            size.Width > 0 && size.Height > 0,
            "Windows Graphics Capture item returned invalid dimensions {}x{}",
            size.Width,
            size.Height
        );

        let dxgi_device: IDXGIDevice = device
            .cast()
            .context("D3D11 capture device did not expose IDXGIDevice")?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
            .context("Could not wrap the D3D11 capture device for WinRT")?;
        let direct3d_device: IDirect3DDevice = inspectable
            .cast()
            .context("WinRT D3D11 device wrapper did not expose IDirect3DDevice")?;
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct3d_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            CAPTURE_QUEUE_DEPTH as i32,
            size,
        )
        .context("Could not create the free-threaded Windows capture frame pool")?;
        let session = frame_pool
            .CreateCaptureSession(&item)
            .context("Could not create the Windows Graphics Capture session")?;
        session
            .SetIsCursorCaptureEnabled(include_cursor)
            .context("Could not configure Windows Graphics Capture cursor inclusion")?;
        let _ = session.SetMinUpdateInterval(TimeSpan {
            Duration: frame_interval_100ns(fps),
        });

        let (sender, receiver) = sync_channel(CAPTURE_QUEUE_DEPTH);
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let callback_activity = Arc::new(CallbackActivity::new());
        let frame_arrived_token = frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
                    let sender = sender.clone();
                    let dropped_frames = Arc::clone(&dropped_frames);
                    let stop_flag = Arc::clone(&stop_flag);
                    let callback_activity = Arc::clone(&callback_activity);
                    move |frame_pool, _| {
                        let _activity = callback_activity.enter();
                        if stop_flag.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let Some(frame_pool) = frame_pool.as_ref() else {
                            return Ok(());
                        };
                        match capture_next_frame(frame_pool) {
                            Ok(frame) => {
                                send_capture_event(
                                    &sender,
                                    CaptureEvent::Frame(frame),
                                    &dropped_frames,
                                );
                            }
                            Err(error) => {
                                send_capture_event(
                                    &sender,
                                    CaptureEvent::Failed(error.to_string()),
                                    &dropped_frames,
                                );
                            }
                        }
                        Ok(())
                    }
                }),
            )
            .context("Could not register the Windows Graphics Capture frame callback")?;
        session
            .StartCapture()
            .context("Could not start Windows Graphics Capture")?;

        Ok(Self {
            adapter_luid: source.adapter_luid,
            receiver,
            session,
            frame_pool,
            frame_arrived_token,
            callback_activity,
            stop_flag,
            dropped_frames,
            readback: D3D11BgraReadback::new(device.clone(), context),
            _device: device,
            _apartment: apartment,
        })
    }

    pub const fn adapter_luid(&self) -> u64 {
        self.adapter_luid
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames.load(Ordering::Relaxed)
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<Option<WindowsCaptureFrame>> {
        match self.receiver.recv_timeout(timeout) {
            Ok(CaptureEvent::Frame(frame)) => Ok(Some(frame)),
            Ok(CaptureEvent::Failed(error)) => Err(anyhow!(
                "Windows Graphics Capture frame callback failed: {error}"
            )),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                bail!("Windows Graphics Capture frame callback disconnected")
            }
        }
    }

    pub fn read_bgra(
        &mut self,
        frame: &WindowsCaptureFrame,
        output: &mut Vec<u8>,
    ) -> Result<Duration> {
        let started_at = Instant::now();
        self.readback
            .read(&frame.texture, frame.width, frame.height, output)?;
        Ok(started_at.elapsed())
    }

    fn stop(&mut self) {
        if self.stop_flag.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.frame_pool.RemoveFrameArrived(self.frame_arrived_token);
        self.callback_activity.wait_idle(CALLBACK_STOP_TIMEOUT);
        let _ = self.session.Close();
        let _ = self.frame_pool.Close();
    }
}

impl Drop for WindowsGraphicsCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn frame_interval_100ns(fps: u32) -> i64 {
    10_000_000_i64 / i64::from(fps.max(1))
}

fn send_capture_event(
    sender: &SyncSender<CaptureEvent>,
    event: CaptureEvent,
    dropped_frames: &AtomicU64,
) {
    match sender.try_send(event) {
        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
        Err(TrySendError::Full(_)) => {
            dropped_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn capture_next_frame(
    frame_pool: &Direct3D11CaptureFramePool,
) -> windows::core::Result<WindowsCaptureFrame> {
    let frame = frame_pool.TryGetNextFrame()?;
    let size = frame.ContentSize()?;
    let surface = frame.Surface()?;
    let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
    let texture = unsafe { access.GetInterface::<ID3D11Texture2D>() }?;
    let timestamp_100ns = frame.SystemRelativeTime()?.Duration;
    Ok(WindowsCaptureFrame {
        texture,
        width: size.Width.max(0) as u32,
        height: size.Height.max(0) as u32,
        timestamp_100ns,
    })
}

fn find_dxgi_output(
    source: WindowsDxgiSourceId,
) -> Result<(IDXGIAdapter1, windows::Win32::Graphics::Gdi::HMONITOR)> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("Could not create the DXGI factory")?;
    let mut adapter_index = 0;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("Could not enumerate DXGI adapters"),
        };
        let descriptor = unsafe { adapter.GetDesc1() }
            .context("Could not read the DXGI capture adapter identity")?;
        if luid_u64(descriptor.AdapterLuid) == source.adapter_luid {
            let output =
                unsafe { adapter.EnumOutputs(source.output_index) }.with_context(|| {
                    format!(
                        "DXGI adapter {:016x} does not expose output {}",
                        source.adapter_luid, source.output_index
                    )
                })?;
            let output_descriptor =
                unsafe { output.GetDesc() }.context("Could not read the DXGI output descriptor")?;
            ensure!(
                !output_descriptor.Monitor.is_invalid(),
                "DXGI output {} on adapter {:016x} has no monitor handle",
                source.output_index,
                source.adapter_luid
            );
            return Ok((adapter, output_descriptor.Monitor));
        }
        adapter_index += 1;
    }
    bail!(
        "DXGI capture adapter {:016x} is no longer available",
        source.adapter_luid
    )
}

fn luid_u64(luid: windows::Win32::Foundation::LUID) -> u64 {
    (u64::from(luid.HighPart as u32) << 32) | u64::from(luid.LowPart)
}

fn create_d3d11_device(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let adapter: IDXGIAdapter = adapter
        .cast()
        .context("Selected DXGI capture adapter did not expose IDXGIAdapter")?;
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            Some(&adapter),
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .context("Could not create a D3D11 device on the selected capture adapter")?;
    let device = device.context("D3D11CreateDevice returned no capture device")?;
    let context = context.context("D3D11CreateDevice returned no immediate context")?;
    if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
    }
    Ok((device, context))
}

fn create_capture_item(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
) -> Result<GraphicsCaptureItem> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .context("Could not load the GraphicsCaptureItem interop factory")?;
    unsafe { interop.CreateForMonitor(monitor) }
        .context("Could not create a Windows Graphics Capture item for the selected monitor")
}

struct D3D11BgraReadback {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<(ID3D11Texture2D, D3D11_TEXTURE2D_DESC)>,
}

impl D3D11BgraReadback {
    fn new(device: ID3D11Device, context: ID3D11DeviceContext) -> Self {
        Self {
            device,
            context,
            staging: None,
        }
    }

    fn read(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        output: &mut Vec<u8>,
    ) -> Result<()> {
        ensure!(
            width > 0 && height > 0,
            "Windows Graphics Capture returned an empty frame"
        );
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut source_desc) };
        ensure!(
            source_desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM,
            "Windows Graphics Capture returned unsupported DXGI format {:?}",
            source_desc.Format
        );
        ensure!(
            width <= source_desc.Width && height <= source_desc.Height,
            "Windows Graphics Capture content {}x{} exceeded texture {}x{}",
            width,
            height,
            source_desc.Width,
            source_desc.Height
        );
        let staging = self.staging_texture(source_desc)?;
        unsafe { self.context.CopyResource(&staging, texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .context("Could not map the Windows capture staging texture")?;
        let copy_result = copy_mapped_bgra(&mapped, width, height, output);
        unsafe { self.context.Unmap(&staging, 0) };
        copy_result
    }

    fn staging_texture(&mut self, source_desc: D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D> {
        if let Some((texture, descriptor)) = self.staging.as_ref()
            && descriptor.Width == source_desc.Width
            && descriptor.Height == source_desc.Height
            && descriptor.Format == source_desc.Format
        {
            return Ok(texture.clone());
        }
        let descriptor = D3D11_TEXTURE2D_DESC {
            Width: source_desc.Width,
            Height: source_desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: source_desc.Format,
            SampleDesc: source_desc.SampleDesc,
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&descriptor, None, Some(&mut texture))
        }
        .context("Could not create the reusable Windows capture staging texture")?;
        let texture = texture.context("D3D11 returned no capture staging texture")?;
        self.staging = Some((texture.clone(), descriptor));
        Ok(texture)
    }
}

fn copy_mapped_bgra(
    mapped: &D3D11_MAPPED_SUBRESOURCE,
    width: u32,
    height: u32,
    output: &mut Vec<u8>,
) -> Result<()> {
    ensure!(
        !mapped.pData.is_null(),
        "Windows capture staging texture mapped to a null pointer"
    );
    let row_bytes = usize::try_from(width)?
        .checked_mul(4)
        .context("Windows capture BGRA row size overflowed")?;
    let row_pitch = usize::try_from(mapped.RowPitch)?;
    ensure!(
        row_pitch >= row_bytes,
        "Windows capture row pitch {row_pitch} was smaller than {row_bytes}"
    );
    let height = usize::try_from(height)?;
    let source_len = row_pitch
        .checked_mul(height)
        .context("Windows capture mapped size overflowed")?;
    let source = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), source_len) };
    copy_strided_bgra(source, row_pitch, row_bytes, height, output)
}

fn copy_strided_bgra(
    source: &[u8],
    row_pitch: usize,
    row_bytes: usize,
    height: usize,
    output: &mut Vec<u8>,
) -> Result<()> {
    ensure!(
        row_pitch >= row_bytes,
        "Windows capture row pitch {row_pitch} was smaller than {row_bytes}"
    );
    let source_len = row_pitch
        .checked_mul(height)
        .context("Windows capture source size overflowed")?;
    ensure!(
        source.len() >= source_len,
        "Windows capture source contained {} bytes, expected at least {source_len}",
        source.len()
    );
    let output_len = row_bytes
        .checked_mul(height)
        .context("Windows capture output size overflowed")?;
    output.resize(output_len, 0);
    for row in 0..height {
        let source_start = row * row_pitch;
        let output_start = row * row_bytes;
        output[output_start..output_start + row_bytes]
            .copy_from_slice(&source[source_start..source_start + row_bytes]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opt_in_parser_is_false_for_missing_or_unrecognized_values() {
        assert!(!opt_in_value_enabled(None));
        assert!(!opt_in_value_enabled(Some("disabled")));
        assert!(opt_in_value_enabled(Some(" TRUE ")));
        assert!(opt_in_value_enabled(Some("1")));
    }

    #[test]
    fn frame_interval_uses_media_foundation_time_units() {
        assert_eq!(frame_interval_100ns(30), 333_333);
        assert_eq!(frame_interval_100ns(60), 166_666);
        assert_eq!(frame_interval_100ns(0), 10_000_000);
    }

    #[test]
    fn strided_bgra_copy_discards_row_padding() {
        let source = [
            1, 2, 3, 4, 5, 6, 7, 8, 90, 91, 92, 93, 9, 10, 11, 12, 13, 14, 15, 16, 94, 95, 96, 97,
        ];
        let mut output = Vec::new();

        copy_strided_bgra(&source, 12, 8, 2, &mut output).expect("strided BGRA copy");

        assert_eq!(
            output,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
    }

    #[test]
    fn strided_bgra_copy_rejects_short_source_rows() {
        let mut output = Vec::new();
        let error =
            copy_strided_bgra(&[0; 15], 8, 8, 2, &mut output).expect_err("short source must fail");

        assert!(error.to_string().contains("expected at least 16"));
    }
}
