//! Videorc Camera's Windows sink (plan 214 C3) and the backend's own view
//! of the Windows setup step (C2).
//!
//! The camera itself is `crates/videorc-virtual-camera-windows`: a Media
//! Foundation media source the Frame Server loads from a DLL registered in
//! HKLM. This module is Videorc's side of it:
//!
//! - `connect` creates the camera with `MFCreateVirtualCamera`
//!   (SoftwareCameraSource, Session, CurrentUser, "Videorc Camera", the
//!   source CLSID) and starts it; `disconnect` and drop stop and shut it
//!   down. Both run on the output thread, never on main.
//! - `push` writes NV12 into the shared ring: from the CPU path through
//!   A1's `i420_to_nv12`, or from a D3D11 session's texture through the
//!   media thread's staging readback (`WindowsD3d11MediaClient::
//!   readback_texture`), converted here and fitted with A1's `CpuFit`.
//! - `viewers` reads the ring header's viewer count (D13), and opens the
//!   ring when the media source has created it (a viewer opened the camera).
//!
//! `MFCreateVirtualCamera` lives in `mfsensorgroup.dll` and exists from
//! build 22000 on. It is resolved at run time so the backend binary itself
//! loads on any Windows; an older build gets a plain refusal.
//!
//! Hidden until a Windows box passes the P0b spike: [`PROVEN`] is the one
//! line to flip. Until then `platform_sink` answers
//! `VirtualCameraUnavailable::hidden_until_proven("Windows")` and the UI
//! hides the section.

use crate::protocol::VirtualCameraPlatformStep;
use crate::virtual_camera::I420Planes;

/// Flipped to `true` once a Windows box passes plan 214's P0b spike.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const PROVEN: bool = false;

// ---------------------------------------------------------------------------
// Pure (every platform)
// ---------------------------------------------------------------------------

/// Plan 214 C2: the backend's registry probe against main's last report.
/// `Ready` from the registry always wins (a setup that main is still
/// reporting as `setting-up` or `failed` has evidently landed). `NeedsSetup`
/// yields to main's `setting-up` and `failed`, which describe what the
/// person is looking at right now, and replaces anything else.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn merge_platform_probe(
    current: Option<(VirtualCameraPlatformStep, Option<String>)>,
    probe: (VirtualCameraPlatformStep, Option<String>),
) -> Option<(VirtualCameraPlatformStep, Option<String>)> {
    match (probe.0, current) {
        (VirtualCameraPlatformStep::Ready, _) => Some(probe),
        (
            VirtualCameraPlatformStep::NeedsSetup,
            Some(
                current @ (
                    VirtualCameraPlatformStep::SettingUp | VirtualCameraPlatformStep::Failed,
                    _,
                ),
            ),
        ) => Some(current),
        (_, _) => Some(probe),
    }
}

/// BT.709 video range, the compositor's and the camera's colour: one
/// 8-bit BGRA pixel to Y, and to Cb and Cr.
#[inline]
fn bgra_to_yuv(b: u8, g: u8, r: u8) -> (u8, u8, u8) {
    let (r, g, b) = (i32::from(r), i32::from(g), i32::from(b));
    let y = ((47 * r + 157 * g + 16 * b + 128) >> 8) + 16;
    let u = ((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
    (
        y.clamp(16, 235) as u8,
        u.clamp(16, 240) as u8,
        v.clamp(16, 240) as u8,
    )
}

fn ensure_planes(out: &mut I420Planes, width: u32, height: u32) {
    if out.width != width || out.height != height {
        *out = I420Planes::black(width, height);
    }
}

/// Tightly packed 8-bit BGRA (what a D3D11 BGRA8 readback hands back) to
/// planar I420. Chroma is the average of each 2×2 block.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn bgra_to_i420(bgra: &[u8], width: u32, height: u32, out: &mut I420Planes) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || bgra.len() < w * h * 4 {
        return;
    }
    ensure_planes(out, width, height);
    let cw = w.div_ceil(2);
    for y in 0..h {
        let row = &bgra[y * w * 4..(y + 1) * w * 4];
        let luma = &mut out.y[y * w..(y + 1) * w];
        for (x, pixel) in row.chunks_exact(4).enumerate() {
            luma[x] = bgra_to_yuv(pixel[0], pixel[1], pixel[2]).0;
        }
    }
    for cy in 0..h.div_ceil(2) {
        for cx in 0..cw {
            let mut sum_u = 0u32;
            let mut sum_v = 0u32;
            let mut count = 0u32;
            for dy in 0..2 {
                let y = cy * 2 + dy;
                if y >= h {
                    continue;
                }
                for dx in 0..2 {
                    let x = cx * 2 + dx;
                    if x >= w {
                        continue;
                    }
                    let p = &bgra[(y * w + x) * 4..(y * w + x) * 4 + 4];
                    let (_, u, v) = bgra_to_yuv(p[0], p[1], p[2]);
                    sum_u += u32::from(u);
                    sum_v += u32::from(v);
                    count += 1;
                }
            }
            let index = cy * cw + cx;
            out.u[index] = (sum_u / count.max(1)) as u8;
            out.v[index] = (sum_v / count.max(1)) as u8;
        }
    }
}

/// Tightly packed NV12 (a D3D11 NV12 readback) to planar I420: the luma
/// plane as is, the interleaved chroma split.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn nv12_to_i420(nv12: &[u8], width: u32, height: u32, out: &mut I420Planes) {
    let (w, h) = (width as usize, height as usize);
    let luma_len = w * h;
    let chroma_len = w.div_ceil(2) * h.div_ceil(2);
    if w == 0 || h == 0 || nv12.len() < luma_len + 2 * chroma_len {
        return;
    }
    ensure_planes(out, width, height);
    out.y.copy_from_slice(&nv12[..luma_len]);
    for (index, pair) in nv12[luma_len..luma_len + 2 * chroma_len]
        .chunks_exact(2)
        .enumerate()
    {
        out.u[index] = pair[0];
        out.v[index] = pair[1];
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod windows_sink {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex as StdMutex, Weak};
    use std::thread::ThreadId;
    use std::time::{Duration, Instant};

    use videorc_virtual_camera_windows::ring::{RingLayout, RingWriter};
    use videorc_virtual_camera_windows::setup::{CAMERA_DLL_VERSION, SetupState, setup_state};
    use videorc_virtual_camera_windows::windows::registration;
    use videorc_virtual_camera_windows::windows::section::{SectionError, SharedSection};
    use windows::Win32::Media::MediaFoundation::{
        IMFAsyncCallback, IMFVirtualCamera, MF_VERSION, MFSTARTUP_NOSOCKET, MFShutdown, MFStartup,
        MFVirtualCameraAccess, MFVirtualCameraAccess_CurrentUser, MFVirtualCameraLifetime,
        MFVirtualCameraLifetime_Session, MFVirtualCameraType,
        MFVirtualCameraType_SoftwareCameraSource,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::core::{GUID, HRESULT, HSTRING, Interface, PCSTR, PCWSTR};

    use super::{bgra_to_i420, nv12_to_i420};
    use crate::protocol::VirtualCameraPlatformStep;
    use crate::state::WindowsD3d11MediaCoordinator;
    use crate::virtual_camera::{
        CpuFit, I420Planes, VIRTUAL_CAMERA_HEIGHT, VIRTUAL_CAMERA_NAME, VIRTUAL_CAMERA_WIDTH,
        VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID, VirtualCameraFrame, VirtualCameraPts,
        VirtualCameraPush, VirtualCameraSink, VirtualCameraSinkError, VirtualCameraUnavailable,
        i420_to_nv12,
    };
    use crate::windows_d3d11_device::{
        WindowsD3d11TextureFormat, WindowsD3d11TextureLeaseTicket, WindowsD3d11TextureReadback,
    };

    /// `MFCreateVirtualCamera`'s C signature (mfvirtualcamera.h).
    type MfCreateVirtualCamera = unsafe extern "system" fn(
        MFVirtualCameraType,
        MFVirtualCameraLifetime,
        MFVirtualCameraAccess,
        PCWSTR,
        PCWSTR,
        *const GUID,
        u32,
        *mut *mut c_void,
    ) -> HRESULT;

    /// How long after a failed ring open the next attempt waits.
    const RING_OPEN_RETRY: Duration = Duration::from_secs(1);

    type CoordinatorSlot = Weak<StdMutex<WindowsD3d11MediaCoordinator>>;

    /// The sink without a D3D11 binding: CPU frames only.
    pub fn sink() -> Result<Box<dyn VirtualCameraSink>, VirtualCameraUnavailable> {
        sink_bound(Weak::new())
    }

    /// The sink bound to the process's D3D11 media coordinator, so a
    /// session's texture can be read back.
    pub fn sink_bound(
        d3d11: CoordinatorSlot,
    ) -> Result<Box<dyn VirtualCameraSink>, VirtualCameraUnavailable> {
        let create = resolve_create_virtual_camera().map_err(VirtualCameraUnavailable::new)?;
        let layout = RingLayout::nv12(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT)
            .map_err(|error| VirtualCameraUnavailable::new(error.to_string()))?;
        Ok(Box::new(WindowsCameraSink {
            create,
            d3d11,
            layout,
            apartment: None,
            camera: None,
            ring: RefCell::new(RingSlot::default()),
            nv12: Vec::with_capacity(layout.frame_bytes),
            source_planes: I420Planes::black(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT),
            fit: CpuFit::new(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT),
        }))
    }

    /// Plan 214 C2: what HKLM and the installed DLL say.
    pub fn platform_report() -> (VirtualCameraPlatformStep, Option<String>) {
        match setup_state(&registration::registered(), CAMERA_DLL_VERSION) {
            SetupState::Ready { .. } => (VirtualCameraPlatformStep::Ready, None),
            SetupState::NeedsSetup { reason } => {
                (VirtualCameraPlatformStep::NeedsSetup, Some(reason))
            }
        }
    }

    fn resolve_create_virtual_camera() -> Result<MfCreateVirtualCamera, String> {
        // SAFETY: a plain system DLL load by name; the handle is never freed
        // (the function pointer lives for the process).
        let module =
            unsafe { LoadLibraryW(&HSTRING::from("mfsensorgroup.dll")) }.map_err(|error| {
                format!("Videorc Camera needs Windows 11 (mfsensorgroup.dll: {error}).")
            })?;
        // SAFETY: the module is loaded; the name is NUL-terminated.
        let address = unsafe { GetProcAddress(module, PCSTR(b"MFCreateVirtualCamera\0".as_ptr())) }
            .ok_or_else(|| {
                "Videorc Camera needs Windows 11 (MFCreateVirtualCamera is missing).".to_string()
            })?;
        // SAFETY: the export has exactly this signature (mfvirtualcamera.h).
        Ok(unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, MfCreateVirtualCamera>(
                address,
            )
        })
    }

    /// COM and Media Foundation on the output thread, undone on the same
    /// thread.
    struct Apartment {
        thread: ThreadId,
        com_initialized: bool,
        mf_started: bool,
    }

    impl Apartment {
        fn enter() -> Result<Self, VirtualCameraSinkError> {
            // SAFETY: the standard COM init for this thread; S_FALSE (already
            // initialised) is fine, RPC_E_CHANGED_MODE is not.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_err() {
                return Err(VirtualCameraSinkError::disconnected(format!(
                    "COM could not initialise for Videorc Camera: {hr}"
                )));
            }
            // SAFETY: paired with MFShutdown in Drop.
            if let Err(error) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) } {
                // SAFETY: undo the init above on this thread.
                unsafe { CoUninitialize() };
                return Err(VirtualCameraSinkError::disconnected(format!(
                    "Media Foundation could not start for Videorc Camera: {error}"
                )));
            }
            Ok(Self {
                thread: std::thread::current().id(),
                com_initialized: true,
                mf_started: true,
            })
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            if std::thread::current().id() != self.thread {
                // Never uninitialise another thread's apartment.
                return;
            }
            // SAFETY: paired with `enter` on this thread.
            unsafe {
                if self.mf_started {
                    let _ = MFShutdown();
                }
                if self.com_initialized {
                    CoUninitialize();
                }
            }
        }
    }

    #[derive(Default)]
    struct RingSlot {
        ring: Option<(SharedSection, RingWriter)>,
        next_open_attempt: Option<Instant>,
        last_error: Option<String>,
    }

    pub struct WindowsCameraSink {
        create: MfCreateVirtualCamera,
        d3d11: CoordinatorSlot,
        layout: RingLayout,
        apartment: Option<Apartment>,
        camera: Option<IMFVirtualCamera>,
        /// Interior mutability: `viewers(&self)` opens the ring once the
        /// media source has created it, which is what tells the output a
        /// viewer exists at all.
        ring: RefCell<RingSlot>,
        nv12: Vec<u8>,
        /// A D3D11 readback converted at its own size, before the fit.
        source_planes: I420Planes,
        fit: CpuFit,
    }

    impl WindowsCameraSink {
        /// Open the ring when the media source has created it; a miss is
        /// retried once a second.
        fn ensure_ring(&self) -> bool {
            let mut slot = self.ring.borrow_mut();
            if slot.ring.is_some() {
                return true;
            }
            let now = Instant::now();
            if slot.next_open_attempt.is_some_and(|at| now < at) {
                return false;
            }
            slot.next_open_attempt = Some(now + RING_OPEN_RETRY);
            match SharedSection::open(&self.layout.section_name(), self.layout.total_bytes()) {
                Ok(section) => match RingWriter::attach(section.region(), &self.layout) {
                    Ok(writer) => {
                        slot.ring = Some((section, writer));
                        slot.last_error = None;
                        true
                    }
                    Err(error) => {
                        slot.last_error = Some(error.to_string());
                        false
                    }
                },
                Err(SectionError::Absent) => false,
                Err(error) => {
                    slot.last_error = Some(error.to_string());
                    false
                }
            }
        }

        fn drop_ring(&self) {
            let mut slot = self.ring.borrow_mut();
            slot.ring = None;
            slot.next_open_attempt = None;
        }

        fn readback(
            &self,
            ticket: &WindowsD3d11TextureLeaseTicket,
        ) -> Result<WindowsD3d11TextureReadback, VirtualCameraSinkError> {
            let coordinator = self.d3d11.upgrade().ok_or_else(|| {
                VirtualCameraSinkError::transient(
                    "The D3D11 session ended before its frame reached Videorc Camera.",
                )
            })?;
            let client = coordinator
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .media_client()
                .ok_or_else(|| {
                    VirtualCameraSinkError::transient(
                        "No D3D11 media thread is running for Videorc Camera's readback.",
                    )
                })?;
            client.readback_texture(ticket.clone()).map_err(|error| {
                VirtualCameraSinkError::transient(format!(
                    "Videorc Camera could not read the session's frame back: {error}"
                ))
            })
        }

        /// A readback at its own size, converted, fitted into the camera
        /// canvas and packed as NV12 into `self.nv12`.
        fn convert_readback(&mut self, readback: &WindowsD3d11TextureReadback) {
            match readback.format {
                WindowsD3d11TextureFormat::Bgra8Unorm => bgra_to_i420(
                    &readback.bytes,
                    readback.width,
                    readback.height,
                    &mut self.source_planes,
                ),
                WindowsD3d11TextureFormat::Nv12 => nv12_to_i420(
                    &readback.bytes,
                    readback.width,
                    readback.height,
                    &mut self.source_planes,
                ),
            }
            self.fit.fit_into(&self.source_planes.view());
            i420_to_nv12(&self.fit.planes().view(), &mut self.nv12);
        }

        fn stop_camera(&mut self) {
            if let Some(camera) = self.camera.take() {
                // SAFETY: the camera is ours; refusals at teardown are
                // nothing to act on.
                unsafe {
                    let _ = camera.Stop();
                    let _ = camera.Shutdown();
                }
            }
        }
    }

    impl VirtualCameraSink for WindowsCameraSink {
        fn label(&self) -> &'static str {
            "mf-ring"
        }

        fn connect(&mut self) -> Result<(), VirtualCameraSinkError> {
            if self.camera.is_some() {
                return Ok(());
            }
            // C2: without the HKLM registration the Frame Server has nothing
            // to load; the status shows the Set up button meanwhile.
            if let SetupState::NeedsSetup { reason } =
                setup_state(&registration::registered(), CAMERA_DLL_VERSION)
            {
                return Err(VirtualCameraSinkError::disconnected(reason));
            }
            if self.apartment.is_none() {
                self.apartment = Some(Apartment::enter()?);
            }
            let friendly_name = HSTRING::from(VIRTUAL_CAMERA_NAME);
            let source_id = HSTRING::from(VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID);
            let mut raw: *mut c_void = null_mut();
            // SAFETY: the resolved export with NUL-terminated strings, no
            // categories, and an out pointer for the interface.
            let created = unsafe {
                (self.create)(
                    MFVirtualCameraType_SoftwareCameraSource,
                    MFVirtualCameraLifetime_Session,
                    MFVirtualCameraAccess_CurrentUser,
                    PCWSTR(friendly_name.as_ptr()),
                    PCWSTR(source_id.as_ptr()),
                    null(),
                    0,
                    &mut raw,
                )
            };
            if let Err(error) = created.ok() {
                return Err(VirtualCameraSinkError::disconnected(format!(
                    "Windows could not create Videorc Camera: {error}"
                )));
            }
            if raw.is_null() {
                return Err(VirtualCameraSinkError::disconnected(
                    "Windows created no Videorc Camera object.",
                ));
            }
            // SAFETY: a fresh owned interface pointer from the create call.
            let camera = unsafe { IMFVirtualCamera::from_raw(raw) };
            // SAFETY: the camera is alive; no completion callback.
            if let Err(error) = unsafe { camera.Start(None::<&IMFAsyncCallback>) } {
                // SAFETY: tear the half-made camera down.
                unsafe {
                    let _ = camera.Shutdown();
                }
                return Err(VirtualCameraSinkError::disconnected(format!(
                    "Windows could not start Videorc Camera: {error}"
                )));
            }
            self.camera = Some(camera);
            Ok(())
        }

        fn disconnect(&mut self) {
            self.drop_ring();
            self.stop_camera();
        }

        fn push(
            &mut self,
            frame: &VirtualCameraFrame<'_>,
            pts: VirtualCameraPts,
        ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
            if self.camera.is_none() {
                return Err(VirtualCameraSinkError::disconnected(
                    "Videorc Camera is not running.",
                ));
            }
            if !self.ensure_ring() {
                // No viewer has opened the camera, so there is no ring to
                // write: counted as dropped, never an error.
                return Ok(VirtualCameraPush::Dropped);
            }
            match frame {
                VirtualCameraFrame::I420 { planes, .. } => {
                    i420_to_nv12(&planes.view(), &mut self.nv12);
                }
                VirtualCameraFrame::D3d11Texture { ticket, .. } => {
                    let readback = self.readback(ticket)?;
                    self.convert_readback(&readback);
                }
                #[cfg(target_os = "macos")]
                VirtualCameraFrame::MetalTarget { .. } => unreachable!("macOS only"),
            }
            let pts_100ns = (pts.nanos / 100) as i64;
            let now_ms = videorc_virtual_camera_windows::windows::boot_clock_ms();
            let written = {
                let mut slot = self.ring.borrow_mut();
                let (_, writer) = slot.ring.as_mut().expect("ensured above");
                writer.write_frame(&self.nv12, pts_100ns, now_ms)
            };
            match written {
                Ok(_) => Ok(VirtualCameraPush::Pushed),
                Err(error) => {
                    self.drop_ring();
                    Err(VirtualCameraSinkError::transient(format!(
                        "Videorc Camera's frame ring refused a frame: {error}"
                    )))
                }
            }
        }

        fn viewers(&self) -> Option<u32> {
            if !self.ensure_ring() {
                // Until the media source creates the ring, no app has
                // opened the camera.
                return Some(0);
            }
            let slot = self.ring.borrow();
            Some(slot.ring.as_ref().map_or(0, |(_, writer)| writer.viewers()))
        }
    }

    impl Drop for WindowsCameraSink {
        fn drop(&mut self) {
            self.drop_ring();
            self.stop_camera();
            // The apartment drops last, on this thread.
            self.apartment = None;
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_sink::{platform_report, sink, sink_bound};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_camera::i420_to_nv12;

    #[test]
    fn a_ready_registry_outranks_what_main_reported() {
        let setting_up = Some((
            VirtualCameraPlatformStep::SettingUp,
            Some("Setting up…".to_string()),
        ));
        assert_eq!(
            merge_platform_probe(setting_up, (VirtualCameraPlatformStep::Ready, None)),
            Some((VirtualCameraPlatformStep::Ready, None))
        );
    }

    #[test]
    fn needs_setup_yields_to_mains_transient_words_and_replaces_the_rest() {
        let probe = || {
            (
                VirtualCameraPlatformStep::NeedsSetup,
                Some("Videorc Camera isn't set up on this PC yet.".to_string()),
            )
        };
        let failed = Some((
            VirtualCameraPlatformStep::Failed,
            Some("You declined the permission prompt.".to_string()),
        ));
        assert_eq!(merge_platform_probe(failed.clone(), probe()), failed);
        let setting_up = Some((VirtualCameraPlatformStep::SettingUp, None));
        assert_eq!(
            merge_platform_probe(setting_up.clone(), probe()),
            setting_up
        );
        assert_eq!(merge_platform_probe(None, probe()), Some(probe()));
        let ready = Some((VirtualCameraPlatformStep::Ready, None));
        assert_eq!(merge_platform_probe(ready, probe()), Some(probe()));
    }

    #[test]
    fn bgra_black_and_white_land_on_video_range_luma_with_neutral_chroma() {
        let mut planes = I420Planes::black(4, 2);
        let mut bgra = vec![0u8; 4 * 2 * 4];
        for pixel in bgra[16..].chunks_exact_mut(4) {
            pixel.copy_from_slice(&[255, 255, 255, 255]);
        }
        bgra_to_i420(&bgra, 4, 2, &mut planes);
        assert_eq!(&planes.y[..4], &[16, 16, 16, 16], "black row");
        assert_eq!(&planes.y[4..], &[235, 235, 235, 235], "white row");
        assert!(
            planes.u.iter().all(|c| (127..=129).contains(c)),
            "{:?}",
            planes.u
        );
        assert!(
            planes.v.iter().all(|c| (127..=129).contains(c)),
            "{:?}",
            planes.v
        );
    }

    #[test]
    fn a_pure_red_pixel_has_bt709_chroma() {
        let mut planes = I420Planes::black(2, 2);
        let bgra: Vec<u8> = [[0u8, 0, 255, 255]; 4].concat();
        bgra_to_i420(&bgra, 2, 2, &mut planes);
        // BT.709 limited: red is Y 63, Cb 102, Cr 240.
        assert_eq!(planes.y[0], 63);
        assert_eq!(planes.u[0], 102);
        assert_eq!(planes.v[0], 240);
    }

    #[test]
    fn nv12_round_trips_through_i420() {
        let (w, h) = (6u32, 4u32);
        let luma: Vec<u8> = (0..24).collect();
        let chroma: Vec<u8> = (100..112).collect();
        let nv12: Vec<u8> = luma.iter().chain(chroma.iter()).copied().collect();
        let mut planes = I420Planes::black(1, 1);
        nv12_to_i420(&nv12, w, h, &mut planes);
        assert_eq!(planes.y, luma);
        assert_eq!(planes.u, vec![100, 102, 104, 106, 108, 110]);
        assert_eq!(planes.v, vec![101, 103, 105, 107, 109, 111]);
        let mut back = Vec::new();
        i420_to_nv12(&planes.view(), &mut back);
        assert_eq!(back, nv12);
    }

    #[test]
    fn a_short_buffer_leaves_the_planes_alone() {
        let mut planes = I420Planes::black(2, 2);
        let before = planes.clone();
        bgra_to_i420(&[0; 3], 2, 2, &mut planes);
        nv12_to_i420(&[0; 3], 2, 2, &mut planes);
        assert_eq!(planes, before);
    }
}
