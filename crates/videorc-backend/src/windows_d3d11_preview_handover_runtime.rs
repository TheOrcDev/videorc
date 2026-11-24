//! The Windows half of plan 260 S0.2b (see `windows_d3d11_preview_handover.rs`
//! for the contract). Everything here runs on the D3D11 media thread, which
//! owns the device's immediate context.

use super::{
    HANDOVER_HEADER_BYTES, HANDOVER_MAGIC, HANDOVER_TEXTURE_SLOTS, HandoverFrame, HandoverHeader,
    HandoverRetireReason, HandoverRouteCode, TextureSetAction, texture_set_action, writable_slots,
};
use crate::protocol::PreviewHandoverRoute;
use crate::windows_d3d11_device::{DxgiAdapterLuid, WindowsD3d11Error, WindowsD3d11ErrorCode};
use std::sync::atomic::Ordering;
use windows::Win32::Foundation::{
    CloseHandle, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_TIMEOUT,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::DirectComposition::{
    COMPOSITIONOBJECT_READ, COMPOSITIONOBJECT_WRITE, DCompositionCreateSurfaceHandle,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_WAS_STILL_DRAWING, DXGI_PRESENT_DO_NOT_WAIT, DXGI_SCALING_STRETCH,
    DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, DXGI_SWAP_CHAIN_DESC1,
    DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT,
    IDXGIAdapter, IDXGIDevice, IDXGIFactoryMedia, IDXGIKeyedMutex, IDXGIOutput, IDXGIResource1,
    IDXGISwapChain1,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    PAGE_READWRITE, UnmapViewOfFile,
};
use windows::Win32::System::Performance::QueryPerformanceCounter;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, SetEvent,
};
use windows::core::{Interface, PCWSTR};

fn handover_error(operation: &str, error: impl std::fmt::Display) -> WindowsD3d11Error {
    WindowsD3d11Error::new(
        WindowsD3d11ErrorCode::CompositorUnavailable,
        format!("windows-d3d11-preview-handover: {operation} failed: {error}"),
    )
}

/// A handle this process owns and closes.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: a handle this module created or opened, closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn handle_value(handle: HANDLE) -> u64 {
    handle.0 as usize as u64
}

/// The app's process, and the handles duplicated into it so far. Until the
/// lease reaches the app, a failure closes them there again (the app cannot
/// have seen or reused their values yet).
struct Consumer {
    process: Owned,
    pending: Vec<HANDLE>,
}

impl Consumer {
    fn open(pid: u32) -> Result<Self, WindowsD3d11Error> {
        // SAFETY: only the right to duplicate handles into the process.
        let process = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, pid) }
            .map_err(|error| handover_error(&format!("OpenProcess({pid})"), error))?;
        Ok(Self {
            process: Owned(process),
            pending: Vec::new(),
        })
    }

    fn duplicate(&mut self, handle: HANDLE, what: &str) -> Result<u64, WindowsD3d11Error> {
        let mut target = HANDLE::default();
        // SAFETY: `handle` is live in this process; the copy lands in the
        // consumer's handle table with the same access.
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                self.process.0,
                &mut target,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        }
        .map_err(|error| handover_error(&format!("DuplicateHandle({what})"), error))?;
        self.pending.push(target);
        Ok(handle_value(target))
    }

    /// The app now knows every duplicated value: it owns them.
    fn handed_over(&mut self) {
        self.pending.clear();
    }
}

impl Drop for Consumer {
    fn drop(&mut self) {
        for handle in self.pending.drain(..) {
            // SAFETY: closes, in the consumer, a handle this process put
            // there and never told it about.
            let _ = unsafe {
                DuplicateHandle(
                    self.process.0,
                    handle,
                    HANDLE::default(),
                    std::ptr::null_mut(),
                    0,
                    false,
                    DUPLICATE_CLOSE_SOURCE,
                )
            };
        }
    }
}

/// The header's page, mapped in this process.
struct HeaderMapping {
    mapping: Owned,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}

impl HeaderMapping {
    fn create(route: HandoverRouteCode) -> Result<Self, WindowsD3d11Error> {
        // SAFETY: an unnamed page-file-backed mapping of one page.
        let mapping = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                HANDOVER_HEADER_BYTES,
                PCWSTR::null(),
            )
        }
        .map_err(|error| handover_error("CreateFileMappingW", error))?;
        let mapping = Owned(mapping);
        // SAFETY: maps the whole mapping just created.
        let view = unsafe {
            MapViewOfFile(
                mapping.0,
                FILE_MAP_ALL_ACCESS,
                0,
                0,
                HANDOVER_HEADER_BYTES as usize,
            )
        };
        if view.Value.is_null() {
            return Err(handover_error(
                "MapViewOfFile",
                windows::core::Error::from_thread(),
            ));
        }
        let header = Self { mapping, view };
        header.header().initialize(route);
        Ok(header)
    }

    fn header(&self) -> &HandoverHeader {
        // SAFETY: the view is a zeroed, page-aligned page that outlives the
        // borrow, and the header is all atomics (zero is a valid value).
        unsafe { &*self.view.Value.cast::<HandoverHeader>() }
    }
}

impl Drop for HeaderMapping {
    fn drop(&mut self) {
        // SAFETY: the view this mapping created, unmapped once.
        let _ = unsafe { UnmapViewOfFile(self.view) };
    }
}

/// Route (a): the composition surface and the swap chain presenting into it.
struct CompositionSurface {
    surface: Owned,
    swap_chain: Option<(IDXGISwapChain1, u32, u32)>,
}

pub(crate) fn handover_swap_chain_descriptor(width: u32, height: u32) -> DXGI_SWAP_CHAIN_DESC1 {
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
        // The program is opaque; the app clips and rounds its own visual.
        AlphaMode: DXGI_ALPHA_MODE_IGNORE,
        Flags: 0,
    }
}

impl CompositionSurface {
    /// `Ok(false)` when the swap chain was still busy with the last frame.
    fn present(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<bool, WindowsD3d11Error> {
        match self.swap_chain.as_mut() {
            Some((_, w, h)) if (*w, *h) == (width, height) => {}
            Some((swap_chain, w, h)) => {
                // The surface handle stays; only the buffers change size.
                unsafe {
                    swap_chain.ResizeBuffers(
                        0,
                        width,
                        height,
                        DXGI_FORMAT_UNKNOWN,
                        DXGI_SWAP_CHAIN_FLAG(0),
                    )
                }
                .map_err(|error| handover_error("IDXGISwapChain1::ResizeBuffers", error))?;
                (*w, *h) = (width, height);
            }
            None => {
                let factory: IDXGIFactoryMedia = unsafe {
                    let adapter: IDXGIAdapter = device
                        .cast::<IDXGIDevice>()
                        .and_then(|dxgi| dxgi.GetAdapter())
                        .map_err(|error| handover_error("IDXGIDevice::GetAdapter", error))?;
                    adapter.GetParent()
                }
                .map_err(|error| {
                    handover_error("IDXGIAdapter::GetParent<IDXGIFactoryMedia>", error)
                })?;
                let descriptor = handover_swap_chain_descriptor(width, height);
                let swap_chain = unsafe {
                    factory.CreateSwapChainForCompositionSurfaceHandle(
                        device,
                        Some(self.surface.0),
                        &descriptor,
                        None::<&IDXGIOutput>,
                    )
                }
                .map_err(|error| {
                    handover_error(
                        "IDXGIFactoryMedia::CreateSwapChainForCompositionSurfaceHandle",
                        error,
                    )
                })?;
                self.swap_chain = Some((swap_chain, width, height));
            }
        }
        let (swap_chain, _, _) = self
            .swap_chain
            .as_ref()
            .expect("the swap chain was just made");
        let back_buffer: ID3D11Texture2D = unsafe { swap_chain.GetBuffer(0) }
            .map_err(|error| handover_error("IDXGISwapChain1::GetBuffer", error))?;
        unsafe { context.CopyResource(&back_buffer, texture) };
        drop(back_buffer);
        let result = unsafe { swap_chain.Present(0, DXGI_PRESENT_DO_NOT_WAIT) };
        if result == DXGI_ERROR_WAS_STILL_DRAWING {
            return Ok(false);
        }
        result
            .ok()
            .map_err(|error| handover_error("IDXGISwapChain1::Present", error))?;
        Ok(true)
    }
}

/// Route (b): one set of shared textures, all one size.
struct SharedTextureSet {
    generation: u64,
    width: u32,
    height: u32,
    slots: Vec<(ID3D11Texture2D, IDXGIKeyedMutex, Owned)>,
}

pub(crate) fn shared_texture_descriptor(width: u32, height: u32) -> D3D11_TEXTURE2D_DESC {
    D3D11_TEXTURE2D_DESC {
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
        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32 | D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 as u32
            | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32,
    }
}

impl SharedTextureSet {
    fn create(
        device: &ID3D11Device,
        generation: u64,
        width: u32,
        height: u32,
    ) -> Result<Self, WindowsD3d11Error> {
        let descriptor = shared_texture_descriptor(width, height);
        let mut slots = Vec::with_capacity(HANDOVER_TEXTURE_SLOTS);
        for _ in 0..HANDOVER_TEXTURE_SLOTS {
            let mut texture = None;
            unsafe { device.CreateTexture2D(&descriptor, None, Some(&mut texture)) }
                .map_err(|error| handover_error("CreateTexture2D(shared, keyed mutex)", error))?;
            let texture: ID3D11Texture2D =
                texture.ok_or_else(|| handover_error("CreateTexture2D", "no texture returned"))?;
            let resource: IDXGIResource1 = texture
                .cast()
                .map_err(|error| handover_error("cast<IDXGIResource1>", error))?;
            let shared = unsafe {
                resource.CreateSharedHandle(
                    None,
                    (DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE).0,
                    PCWSTR::null(),
                )
            }
            .map_err(|error| handover_error("IDXGIResource1::CreateSharedHandle", error))?;
            let shared = Owned(shared);
            let mutex: IDXGIKeyedMutex = texture
                .cast()
                .map_err(|error| handover_error("cast<IDXGIKeyedMutex>", error))?;
            slots.push((texture, mutex, shared));
        }
        Ok(Self {
            generation,
            width,
            height,
            slots,
        })
    }
}

/// How one keyed-mutex acquire ended. `IDXGIKeyedMutex::AcquireSync` in
/// `windows-rs` maps `WAIT_TIMEOUT` (a success HRESULT) to `Ok`, so this
/// reads the raw HRESULT instead. The app's reader must do the same.
#[derive(Debug, PartialEq, Eq)]
enum KeyedAcquire {
    Acquired,
    Busy,
}

fn try_acquire(mutex: &IDXGIKeyedMutex) -> Result<KeyedAcquire, WindowsD3d11Error> {
    // SAFETY: a live keyed mutex; key 0 with no wait.
    let result = unsafe { (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), 0, 0) };
    match result.0 as u32 {
        0 => Ok(KeyedAcquire::Acquired),
        code if code == WAIT_TIMEOUT.0 => Ok(KeyedAcquire::Busy),
        code if code == WAIT_ABANDONED.0 => Err(handover_error(
            "IDXGIKeyedMutex::AcquireSync",
            "WAIT_ABANDONED: the app died holding a slot; the set must be remade",
        )),
        _ => Err(handover_error(
            "IDXGIKeyedMutex::AcquireSync",
            windows::core::Error::from_hresult(result),
        )),
    }
}

/// What `open` gives the app, every handle already duplicated into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11PreviewHandoverGrant {
    pub(crate) token: u64,
    pub(crate) route: PreviewHandoverRoute,
    pub(crate) media_generation: u64,
    pub(crate) adapter_luid: DxgiAdapterLuid,
    pub(crate) header_mapping_handle: u64,
    pub(crate) frame_event_handle: u64,
    pub(crate) composition_surface_handle: Option<u64>,
}

/// What one publish did, for the media thread's counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandoverPublish {
    Published,
    Dropped,
}

pub(crate) struct WindowsD3d11PreviewHandover {
    token: u64,
    consumer: Consumer,
    header: HeaderMapping,
    event: Owned,
    surface: Option<CompositionSurface>,
    textures: Option<SharedTextureSet>,
    next_texture_generation: u64,
    retire_reason: HandoverRetireReason,
}

impl WindowsD3d11PreviewHandover {
    pub(crate) fn open(
        token: u64,
        route: PreviewHandoverRoute,
        consumer_pid: u32,
        media_generation: u64,
        adapter_luid: DxgiAdapterLuid,
    ) -> Result<(Self, WindowsD3d11PreviewHandoverGrant), WindowsD3d11Error> {
        if consumer_pid == 0 {
            return Err(handover_error("open", "process 0 cannot take the preview"));
        }
        let mut consumer = Consumer::open(consumer_pid)?;
        let code = match route {
            PreviewHandoverRoute::CompositionSurface => HandoverRouteCode::CompositionSurface,
            PreviewHandoverRoute::SharedTexture => HandoverRouteCode::SharedTexture,
        };
        let header = HeaderMapping::create(code)?;
        // SAFETY: an unnamed auto-reset event, initially unset.
        let event = Owned(
            unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
                .map_err(|error| handover_error("CreateEventW", error))?,
        );
        let surface = match route {
            PreviewHandoverRoute::CompositionSurface => Some(CompositionSurface {
                // SAFETY: a new composition surface handle this module owns.
                surface: Owned(
                    unsafe {
                        DCompositionCreateSurfaceHandle(
                            (COMPOSITIONOBJECT_READ | COMPOSITIONOBJECT_WRITE) as u32,
                            None,
                        )
                    }
                    .map_err(|error| handover_error("DCompositionCreateSurfaceHandle", error))?,
                ),
                swap_chain: None,
            }),
            PreviewHandoverRoute::SharedTexture => None,
        };
        let grant = WindowsD3d11PreviewHandoverGrant {
            token,
            route,
            media_generation,
            adapter_luid,
            header_mapping_handle: consumer.duplicate(header.mapping.0, "header")?,
            frame_event_handle: consumer.duplicate(event.0, "frame event")?,
            composition_surface_handle: surface
                .as_ref()
                .map(|surface| consumer.duplicate(surface.surface.0, "composition surface"))
                .transpose()?,
        };
        consumer.handed_over();
        Ok((
            Self {
                token,
                consumer,
                header,
                event,
                surface,
                textures: None,
                next_texture_generation: 1,
                retire_reason: HandoverRetireReason::Closed,
            },
            grant,
        ))
    }

    pub(crate) const fn token(&self) -> u64 {
        self.token
    }

    /// Why the header will say it ended when this is dropped.
    pub(crate) fn retire_on_drop(&mut self, reason: HandoverRetireReason) {
        self.retire_reason = reason;
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn publish(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        media_sequence: u64,
        scene_revision: Option<u64>,
        width: u32,
        height: u32,
    ) -> Result<HandoverPublish, WindowsD3d11Error> {
        let slot = if let Some(surface) = self.surface.as_mut() {
            if !surface.present(device, context, texture, width, height)? {
                self.header.header().note_dropped();
                return Ok(HandoverPublish::Dropped);
            }
            None
        } else {
            match self.write_shared_slot(device, context, texture, width, height)? {
                Some(slot) => Some(slot),
                None => {
                    self.header.header().note_dropped();
                    return Ok(HandoverPublish::Dropped);
                }
            }
        };
        let mut published_qpc = 0_i64;
        // SAFETY: a valid out pointer; the counter cannot fail on XP or later.
        let _ = unsafe { QueryPerformanceCounter(&mut published_qpc) };
        self.header.header().publish_frame(HandoverFrame {
            media_sequence,
            scene_revision,
            published_qpc: published_qpc as u64,
            width,
            height,
            slot,
        });
        self.signal();
        Ok(HandoverPublish::Published)
    }

    /// Route (b): copies the frame into a slot the app is not reading.
    /// `Ok(None)` drops the frame (no free slot, or a new size waiting for
    /// the app to adopt the current set).
    fn write_shared_slot(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<Option<u32>, WindowsD3d11Error> {
        let header = self.header.header();
        let current = self.textures.as_ref();
        match texture_set_action(
            current.map(|set| (set.width, set.height)),
            (width, height),
            current.map_or(0, |set| set.generation),
            header.texture_generation_seen.load(Ordering::Acquire),
        ) {
            TextureSetAction::Use => {}
            TextureSetAction::WaitForAdoption => return Ok(None),
            TextureSetAction::Create => {
                let generation = self.next_texture_generation;
                let set = SharedTextureSet::create(device, generation, width, height)?;
                let mut handles = [0_u64; HANDOVER_TEXTURE_SLOTS];
                for (value, (_, _, shared)) in handles.iter_mut().zip(&set.slots) {
                    *value = self.consumer.duplicate(shared.0, "shared texture")?;
                }
                self.consumer.handed_over();
                self.header
                    .header()
                    .publish_textures(generation, width, height, handles);
                self.next_texture_generation += 1;
                self.textures = Some(set);
                self.signal();
            }
        }
        let set = self.textures.as_ref().expect("the texture set exists");
        let latest = self
            .header
            .header()
            .read()
            .and_then(|snapshot| snapshot.frame.slot);
        for slot in writable_slots(latest, set.slots.len() as u32) {
            let (target, mutex, _) = &set.slots[slot as usize];
            if try_acquire(mutex)? == KeyedAcquire::Busy {
                continue;
            }
            unsafe { context.CopyResource(target, texture) };
            unsafe { mutex.ReleaseSync(0) }
                .map_err(|error| handover_error("IDXGIKeyedMutex::ReleaseSync", error))?;
            return Ok(Some(slot));
        }
        Ok(None)
    }

    fn signal(&self) {
        // SAFETY: the event this hand-over created.
        let _ = unsafe { SetEvent(self.event.0) };
    }
}

impl Drop for WindowsD3d11PreviewHandover {
    fn drop(&mut self) {
        let header = self.header.header();
        debug_assert_eq!(header.magic.load(Ordering::Relaxed), HANDOVER_MAGIC);
        header.retire(self.retire_reason);
        self.signal();
    }
}

#[cfg(test)]
mod tests {
    //! Both routes end to end inside one process: the test is its own
    //! consumer (the handles are duplicated into this process), on a second
    //! D3D11 device as the app would use. Windows CI runs these; a contributor
    //! runs them on real hardware with
    //! `cargo test -p videorc-backend preview_handover`.
    use super::*;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_USAGE_STAGING, D3D11CreateDevice,
        ID3D11Device1, ID3D11RenderTargetView,
    };
    use windows::Win32::Graphics::DirectComposition::{
        DCompositionCreateDevice, IDCompositionDevice,
    };
    use windows::Win32::System::Memory::{FILE_MAP_READ, FILE_MAP_WRITE};
    use windows::Win32::System::Threading::WaitForSingleObject;

    fn new_device() -> (ID3D11Device, ID3D11DeviceContext) {
        for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
            let (mut device, mut context) = (None, None);
            let created = unsafe {
                D3D11CreateDevice(
                    None::<&IDXGIAdapter>,
                    driver,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            };
            if created.is_ok() {
                return (device.unwrap(), context.unwrap());
            }
        }
        panic!("no D3D11 device, hardware or WARP");
    }

    /// A BGRA frame cleared to one colour, as the compositor's preview
    /// target is (render target and shader resource).
    fn frame(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        (width, height): (u32, u32),
        rgba: [f32; 4],
    ) -> ID3D11Texture2D {
        let mut descriptor = shared_texture_descriptor(width, height);
        descriptor.MiscFlags = 0;
        let mut texture = None;
        unsafe { device.CreateTexture2D(&descriptor, None, Some(&mut texture)) }.unwrap();
        let texture = texture.unwrap();
        let mut view: Option<ID3D11RenderTargetView> = None;
        unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut view)) }.unwrap();
        unsafe { context.ClearRenderTargetView(&view.unwrap(), &rgba) };
        texture
    }

    fn header_of(grant: &WindowsD3d11PreviewHandoverGrant) -> &'static HandoverHeader {
        let handle = HANDLE(grant.header_mapping_handle as usize as *mut _);
        let view = unsafe {
            MapViewOfFile(
                handle,
                FILE_MAP_READ | FILE_MAP_WRITE,
                0,
                0,
                HANDOVER_HEADER_BYTES as usize,
            )
        };
        assert!(!view.Value.is_null(), "the app maps the header");
        // Leaked for the test's life, as an app keeps its mapping.
        unsafe { &*view.Value.cast::<HandoverHeader>() }
    }

    fn open(
        route: PreviewHandoverRoute,
    ) -> (
        WindowsD3d11PreviewHandover,
        WindowsD3d11PreviewHandoverGrant,
    ) {
        WindowsD3d11PreviewHandover::open(
            7,
            route,
            std::process::id(),
            3,
            DxgiAdapterLuid::from_u64(1),
        )
        .unwrap()
    }

    #[test]
    fn preview_handover_shared_texture_reaches_a_second_device_with_its_pixels() {
        let (device, context) = new_device();
        let (mut handover, grant) = open(PreviewHandoverRoute::SharedTexture);
        assert_eq!(grant.composition_surface_handle, None);
        let header = header_of(&grant);
        let red = frame(&device, &context, (64, 36), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(
            handover
                .publish(&device, &context, &red, 41, Some(5), 64, 36)
                .unwrap(),
            HandoverPublish::Published
        );
        let event = HANDLE(grant.frame_event_handle as usize as *mut _);
        assert_eq!(
            unsafe { WaitForSingleObject(event, 1000) }.0,
            0,
            "the frame event is set"
        );
        let snapshot = header.read().unwrap();
        assert_eq!(snapshot.frame.media_sequence, 41);
        assert_eq!(snapshot.frame.scene_revision, Some(5));
        assert_eq!(snapshot.texture_generation, 1);
        let slot = snapshot.frame.slot.expect("a slot");

        // The app: open the slot on its own device, take the key, read it.
        let (app_device, app_context) = new_device();
        let app_device: ID3D11Device1 = app_device.cast().unwrap();
        let shared = HANDLE(snapshot.slot_handles[slot as usize] as usize as *mut _);
        let texture: ID3D11Texture2D = unsafe { app_device.OpenSharedResource1(shared) }.unwrap();
        let mutex: IDXGIKeyedMutex = texture.cast().unwrap();
        assert_eq!(try_acquire(&mutex).unwrap(), KeyedAcquire::Acquired);
        let mut staging_descriptor = shared_texture_descriptor(64, 36);
        staging_descriptor.Usage = D3D11_USAGE_STAGING;
        staging_descriptor.BindFlags = 0;
        staging_descriptor.MiscFlags = 0;
        staging_descriptor.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        unsafe { app_device.CreateTexture2D(&staging_descriptor, None, Some(&mut staging)) }
            .unwrap();
        let staging = staging.unwrap();
        unsafe { app_context.CopyResource(&staging, &texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { app_context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.unwrap();
        let pixel = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), 4) }.to_vec();
        unsafe { app_context.Unmap(&staging, 0) };
        assert_eq!(pixel, vec![0, 0, 255, 255], "BGRA red crossed devices");

        // While the app holds that slot, the backend writes the others and
        // never blocks.
        for sequence in 42..48 {
            let green = frame(&device, &context, (64, 36), [0.0, 1.0, 0.0, 1.0]);
            assert_eq!(
                handover
                    .publish(&device, &context, &green, sequence, None, 64, 36)
                    .unwrap(),
                HandoverPublish::Published
            );
            assert_ne!(header.read().unwrap().frame.slot, Some(slot));
        }
        unsafe { mutex.ReleaseSync(0) }.unwrap();

        // A new size waits until the app adopted the current set.
        let big = frame(&device, &context, (128, 72), [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(
            handover
                .publish(&device, &context, &big, 50, None, 128, 72)
                .unwrap(),
            HandoverPublish::Dropped
        );
        header.texture_generation_seen.store(1, Ordering::Release);
        assert_eq!(
            handover
                .publish(&device, &context, &big, 51, None, 128, 72)
                .unwrap(),
            HandoverPublish::Published
        );
        let snapshot = header.read().unwrap();
        assert_eq!(snapshot.texture_generation, 2);
        assert_eq!((snapshot.texture_width, snapshot.texture_height), (128, 72));
        assert_eq!(snapshot.frames_dropped, 1);

        drop(handover);
        assert_eq!(
            header.read().unwrap().retired,
            HandoverRetireReason::Closed as u32
        );
    }

    #[test]
    fn preview_handover_composition_surface_presents_and_opens_in_the_app() {
        let (device, context) = new_device();
        let (mut handover, grant) = open(PreviewHandoverRoute::CompositionSurface);
        let surface =
            HANDLE(grant.composition_surface_handle.expect("a surface handle") as usize as *mut _);
        // The app's side: its own DirectComposition device opens the surface.
        let app: IDCompositionDevice =
            unsafe { DCompositionCreateDevice(None::<&IDXGIDevice>) }.unwrap();
        let _content = unsafe { app.CreateSurfaceFromHandle(surface) }.unwrap();
        let header = header_of(&grant);
        // Two sizes: a resize keeps the surface handle the app holds.
        for (sequence, size) in [(1, (64, 36)), (2, (64, 36)), (3, (128, 72)), (4, (128, 72))] {
            let red = frame(&device, &context, size, [1.0, 0.0, 0.0, 1.0]);
            let mut outcome = HandoverPublish::Dropped;
            for _ in 0..50 {
                outcome = handover
                    .publish(&device, &context, &red, sequence, None, size.0, size.1)
                    .unwrap();
                if outcome == HandoverPublish::Published {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert_eq!(
                outcome,
                HandoverPublish::Published,
                "frame {sequence} presented"
            );
            let snapshot = header.read().unwrap();
            assert_eq!(snapshot.frame.media_sequence, sequence);
            assert_eq!((snapshot.frame.width, snapshot.frame.height), size);
            assert_eq!(snapshot.frame.slot, None, "route (a) has no slots");
        }
        drop(handover);
        assert_eq!(
            header.read().unwrap().retired,
            HandoverRetireReason::Closed as u32
        );
    }
}
