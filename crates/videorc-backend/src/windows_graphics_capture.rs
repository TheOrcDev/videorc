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
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice,
    ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
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
/// Capture-owned frame copies: the two the channel can queue, the one the
/// preview thread reads back, the latest one the frame store retains, and
/// two for a direct D3D11 recording that is still blitting the previous one.
const OWNED_FRAME_SLOTS: usize = 6;

pub fn enabled() -> bool {
    graphics_capture_value_enabled(
        std::env::var("VIDEORC_WINDOWS_GRAPHICS_CAPTURE")
            .ok()
            .as_deref(),
    )
}

fn graphics_capture_value_enabled(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off" | "disabled"
        )
    })
}

#[derive(Debug)]
pub struct WindowsCaptureFrame {
    /// A capture-owned copy, never the frame pool's own buffer: the pool
    /// recycles that buffer for a later frame as soon as the frame is closed.
    texture: Arc<ID3D11Texture2D>,
    pub width: u32,
    pub height: u32,
    pub timestamp_100ns: i64,
}

impl WindowsCaptureFrame {
    pub fn retained_texture(&self, adapter_luid: u64) -> RetainedD3D11Texture {
        RetainedD3D11Texture::new(Arc::clone(&self.texture), adapter_luid)
    }
}

/// Which owned slot takes the next frame: one nobody holds any more, grown
/// while the pool is under its cap, or none when every slot is still being
/// read (the consumers are slower than the display; the frame is dropped and
/// counted, never overwritten under a reader).
#[derive(Debug, PartialEq, Eq)]
enum SlotChoice {
    /// A free slot whose texture already matches the frame.
    Reuse(usize),
    /// A free slot whose texture must be recreated for the frame's shape.
    Replace(usize),
    Grow,
    Full,
}

/// Pure: `holders` is each slot's strong count (1 = only the pool holds it)
/// and whether its texture matches the incoming frame's shape.
fn choose_slot(holders: &[(usize, bool)], max_slots: usize) -> SlotChoice {
    let free = holders.iter().position(|(count, _)| *count == 1);
    match free {
        Some(index) if holders[index].1 => SlotChoice::Reuse(index),
        Some(index) => SlotChoice::Replace(index),
        None if holders.len() < max_slots => SlotChoice::Grow,
        None => SlotChoice::Full,
    }
}

/// Capture-owned copies of the frames Windows Graphics Capture delivers.
///
/// The textures inside a `Direct3D11CaptureFrame` belong to the frame pool:
/// closing the frame hands its buffer back, and with a two-deep pool the
/// buffer carries frame N+2 while a consumer may still be reading frame N
/// (the preview readback's staging copy, the direct recording's blit). Every
/// delivered frame is therefore copied on the capture device into a slot no
/// consumer holds before the frame is closed, and the slot's `Arc` count says
/// when it is free again.
struct OwnedFrameSlots {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    slots: Vec<(Arc<ID3D11Texture2D>, D3D11_TEXTURE2D_DESC)>,
}

impl OwnedFrameSlots {
    fn new(device: ID3D11Device, context: ID3D11DeviceContext) -> Self {
        Self {
            device,
            context,
            slots: Vec::with_capacity(OWNED_FRAME_SLOTS),
        }
    }

    /// A copy of `source` in a slot nobody else holds, or `None` when every
    /// slot is still in use.
    fn copy_from(
        &mut self,
        source: &ID3D11Texture2D,
    ) -> windows::core::Result<Option<Arc<ID3D11Texture2D>>> {
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { source.GetDesc(&mut source_desc) };
        let holders: Vec<(usize, bool)> = self
            .slots
            .iter()
            .map(|(texture, desc)| (Arc::strong_count(texture), same_shape(desc, &source_desc)))
            .collect();
        let slot = match choose_slot(&holders, OWNED_FRAME_SLOTS) {
            SlotChoice::Reuse(index) => Arc::clone(&self.slots[index].0),
            SlotChoice::Replace(index) => {
                let texture = self.create(&source_desc)?;
                self.slots[index] = (Arc::clone(&texture), owned_desc(&source_desc));
                texture
            }
            SlotChoice::Grow => {
                let texture = self.create(&source_desc)?;
                self.slots
                    .push((Arc::clone(&texture), owned_desc(&source_desc)));
                texture
            }
            SlotChoice::Full => return Ok(None),
        };
        // SAFETY: same device, matching single-slice BGRA textures; a GPU-only
        // copy on the multithread-protected immediate context.
        unsafe { self.context.CopyResource(&*slot, source) };
        Ok(Some(slot))
    }

    fn create(
        &self,
        source_desc: &D3D11_TEXTURE2D_DESC,
    ) -> windows::core::Result<Arc<ID3D11Texture2D>> {
        let descriptor = owned_desc(source_desc);
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&descriptor, None, Some(&mut texture))?
        };
        texture
            .map(Arc::new)
            .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
    }
}

fn same_shape(owned: &D3D11_TEXTURE2D_DESC, source: &D3D11_TEXTURE2D_DESC) -> bool {
    owned.Width == source.Width
        && owned.Height == source.Height
        && owned.Format == source.Format
        && owned.MipLevels == source.MipLevels
        && owned.ArraySize == source.ArraySize
        && owned.SampleDesc.Count == source.SampleDesc.Count
}

/// The owned copy mirrors the pool texture's shape and can feed both the
/// staging readback and the recording's video processor.
fn owned_desc(source: &D3D11_TEXTURE2D_DESC) -> D3D11_TEXTURE2D_DESC {
    D3D11_TEXTURE2D_DESC {
        Width: source.Width,
        Height: source.Height,
        MipLevels: source.MipLevels.max(1),
        ArraySize: source.ArraySize.max(1),
        Format: source.Format,
        SampleDesc: source.SampleDesc,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
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
        let owned_frames = Arc::new(Mutex::new(OwnedFrameSlots::new(
            device.clone(),
            context.clone(),
        )));
        let frame_arrived_token = frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
                    let sender = sender.clone();
                    let dropped_frames = Arc::clone(&dropped_frames);
                    let stop_flag = Arc::clone(&stop_flag);
                    let callback_activity = Arc::clone(&callback_activity);
                    let owned_frames = Arc::clone(&owned_frames);
                    move |frame_pool, _| {
                        let _activity = callback_activity.enter();
                        if stop_flag.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let Some(frame_pool) = frame_pool.as_ref() else {
                            return Ok(());
                        };
                        match capture_next_frame(frame_pool, &owned_frames) {
                            Ok(Some(frame)) => {
                                send_capture_event(
                                    &sender,
                                    CaptureEvent::Frame(frame),
                                    &dropped_frames,
                                );
                            }
                            Ok(None) => {
                                // Every owned slot is still being read.
                                dropped_frames.fetch_add(1, Ordering::Relaxed);
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

/// The next pooled frame copied into a capture-owned texture, or `None` when
/// no owned slot is free. The pool's texture is only touched here: the frame
/// is closed before this returns, which hands its buffer back to the pool.
fn capture_next_frame(
    frame_pool: &Direct3D11CaptureFramePool,
    owned_frames: &Mutex<OwnedFrameSlots>,
) -> windows::core::Result<Option<WindowsCaptureFrame>> {
    let frame = frame_pool.TryGetNextFrame()?;
    let size = frame.ContentSize()?;
    let timestamp_100ns = frame.SystemRelativeTime()?.Duration;
    let copied = {
        let surface = frame.Surface()?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let pool_texture = unsafe { access.GetInterface::<ID3D11Texture2D>() }?;
        owned_frames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .copy_from(&pool_texture)?
    };
    frame.Close()?;
    Ok(copied.map(|texture| WindowsCaptureFrame {
        texture,
        width: size.Width.max(0) as u32,
        height: size.Height.max(0) as u32,
        timestamp_100ns,
    }))
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
    // ID3D11Multithread lives on the immediate context, not the device: the
    // frame callback copies on one thread while the preview thread reads back
    // and a direct recording blits on others, all through this context.
    let multithread = context
        .cast::<ID3D11Multithread>()
        .context("The D3D11 capture context does not expose ID3D11Multithread")?;
    unsafe {
        let _ = multithread.SetMultithreadProtected(true);
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
    fn owned_frame_slots_never_reuse_a_slot_a_consumer_still_holds() {
        // Only the pool holds slot 1: reuse it. Slot 0 is in the channel or
        // a consumer's hands (count 2+), so it is never written under them.
        assert_eq!(
            choose_slot(&[(2, true), (1, true), (3, true)], OWNED_FRAME_SLOTS),
            SlotChoice::Reuse(1)
        );
        // A free slot of the wrong shape (display resolution changed) is
        // recreated rather than copied into.
        assert_eq!(
            choose_slot(&[(2, true), (1, false)], OWNED_FRAME_SLOTS),
            SlotChoice::Replace(1)
        );
        // Everything held and room to grow: allocate; at the cap: drop the
        // frame instead of overwriting a reader.
        assert_eq!(
            choose_slot(&[(2, true)], OWNED_FRAME_SLOTS),
            SlotChoice::Grow
        );
        assert_eq!(choose_slot(&[], OWNED_FRAME_SLOTS), SlotChoice::Grow);
        let all_held = vec![(2, true); OWNED_FRAME_SLOTS];
        assert_eq!(choose_slot(&all_held, OWNED_FRAME_SLOTS), SlotChoice::Full);
    }

    #[test]
    fn graphics_capture_is_default_with_an_explicit_escape_hatch() {
        assert!(graphics_capture_value_enabled(None));
        assert!(!graphics_capture_value_enabled(Some("disabled")));
        assert!(!graphics_capture_value_enabled(Some(" 0 ")));
        assert!(graphics_capture_value_enabled(Some(" TRUE ")));
        assert!(graphics_capture_value_enabled(Some("1")));
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
