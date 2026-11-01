//! Hide screen (plan 210 S7): the process-wide privacy gate every screen
//! capture publishes through, and the frost that replaces the live picture.
//!
//! The promise is made at the capture source. While hidden, each capture path's
//! publish point drops live frames and publishes one frosted still in its own
//! frame format, so the program, the aux stream leg, the vertical leg, the
//! Screen ISO file, Clips and the native preview, which all read the same
//! frame store, get the still and nothing else. The decision is pure
//! ([`admit_screen_frame`]) so a new capture path can't forget it, and the
//! platform glue around it stays thin.
//!
//! The frost is a pure function of one frame: an area average down to at most
//! [`FROST_MAX_HEIGHT`] rows, a Gaussian blur of σ [`FROST_SIGMA`] px at that
//! size, then one bilinear scale back up. Colours and shapes survive; text
//! does not. It runs once per hide, never per frame.

use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::protocol::{ScreenPrivacy, ScreenPrivacyReason};

/// The exact copy a `screen.hide` refusal carries while a legacy FFmpeg
/// session reads the display through FFmpeg itself (plan 210 S7.5).
pub const SCREEN_HIDE_UNAVAILABLE_LEGACY: &str =
    "Hide screen isn't available on this recording. Stop and record again.";

/// The frosted still is built from a picture at most this many rows tall.
pub const FROST_MAX_HEIGHT: u32 = 48;
/// Gaussian σ, in pixels of the small picture.
pub const FROST_SIGMA: f32 = 2.0;
/// The still with no frame to frost: a neutral grey, opaque.
pub const FROST_GREY: [u8; 4] = [0x80, 0x80, 0x80, 0xff];

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Process-wide Hide screen state, in memory only (cleared at launch, D9).
///
/// The hot path reads one atomic: bit 0 is `hidden`, the bits above it are
/// the hide span, bumped on every visible → hidden edge. A publish point
/// frosts once per span and holds every later live frame.
#[derive(Debug, Default)]
pub struct ScreenPrivacyGate {
    packed: AtomicU64,
    details: StdMutex<ScreenPrivacyDetails>,
}

#[derive(Debug, Default, Clone)]
struct ScreenPrivacyDetails {
    since: Option<String>,
    reason: Option<ScreenPrivacyReason>,
}

/// What a publish point needs from the gate: one atomic load.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenPrivacyView {
    pub hidden: bool,
    pub span: u64,
}

impl ScreenPrivacyGate {
    pub fn view(&self) -> ScreenPrivacyView {
        unpack(self.packed.load(Ordering::Acquire))
    }

    /// Hide. A second hide while hidden changes nothing except the reason: a
    /// hide by the streamer outranks a password-manager hide (D11: "unless
    /// you hid it yourself"), and `since` keeps the first edge.
    pub fn hide(&self, reason: ScreenPrivacyReason, since: String) -> ScreenPrivacy {
        let mut details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut current = self.packed.load(Ordering::Acquire);
        loop {
            let view = unpack(current);
            if view.hidden {
                if reason == ScreenPrivacyReason::You {
                    details.reason = Some(ScreenPrivacyReason::You);
                }
                break;
            }
            let next = pack(true, view.span.wrapping_add(1));
            match self.packed.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    details.since = Some(since);
                    details.reason = Some(reason);
                    break;
                }
                Err(observed) => current = observed,
            }
        }
        self.snapshot_locked(&details)
    }

    pub fn show(&self) -> ScreenPrivacy {
        let mut details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut current = self.packed.load(Ordering::Acquire);
        loop {
            let view = unpack(current);
            if !view.hidden {
                break;
            }
            match self.packed.compare_exchange_weak(
                current,
                pack(false, view.span),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
        details.since = None;
        details.reason = None;
        self.snapshot_locked(&details)
    }

    pub fn snapshot(&self) -> ScreenPrivacy {
        let details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.snapshot_locked(&details)
    }

    fn snapshot_locked(&self, details: &ScreenPrivacyDetails) -> ScreenPrivacy {
        let view = self.view();
        if view.hidden {
            ScreenPrivacy {
                hidden: true,
                since: details.since.clone(),
                reason: details.reason,
                unavailable: None,
            }
        } else {
            ScreenPrivacy::default()
        }
    }
}

fn pack(hidden: bool, span: u64) -> u64 {
    (span << 1) | u64::from(hidden)
}

fn unpack(packed: u64) -> ScreenPrivacyView {
    ScreenPrivacyView {
        hidden: packed & 1 == 1,
        span: packed >> 1,
    }
}

/// One publish point's memory of the gate: the span it last frosted for.
/// A new capture session starts with a fresh cursor, so a source started or
/// swapped while hidden frosts its very first frame.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScreenPrivacyCursor {
    frosted_span: Option<u64>,
}

/// What a publish point does with the live frame in its hands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenFrameAdmission {
    /// Visible: publish the live frame as always.
    Publish,
    /// Hidden and this store has no still for the current span yet: publish
    /// the frosted still built from this frame (or grey), once.
    Frost,
    /// Hidden and the still is already published: never publish this frame.
    Hold,
}

/// The one decision every publish point makes, under the store's lock, at the
/// moment it would publish. Taking it earlier (before a copy or a readback)
/// would open a window where a hide lands between the decision and the
/// publish and a live frame covers the still, so nothing decides early.
pub fn admit_screen_frame(
    view: ScreenPrivacyView,
    cursor: &mut ScreenPrivacyCursor,
) -> ScreenFrameAdmission {
    if !view.hidden {
        return ScreenFrameAdmission::Publish;
    }
    if cursor.frosted_span == Some(view.span) {
        return ScreenFrameAdmission::Hold;
    }
    cursor.frosted_span = Some(view.span);
    ScreenFrameAdmission::Frost
}

// ---------------------------------------------------------------------------
// The frost
// ---------------------------------------------------------------------------

/// The small picture the frost works at, for a frame of `width`×`height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrostPlan {
    pub width: u32,
    pub height: u32,
    pub small_width: u32,
    pub small_height: u32,
}

pub fn frost_plan(width: u32, height: u32) -> FrostPlan {
    let small_height = height.clamp(1, FROST_MAX_HEIGHT);
    let small_width = if height == 0 {
        1
    } else {
        ((u64::from(width) * u64::from(small_height) + u64::from(height) / 2) / u64::from(height))
            .clamp(1, u64::from(width.max(1))) as u32
    };
    FrostPlan {
        width,
        height,
        small_width,
        small_height,
    }
}

/// The frosted still for a BGRA8 frame with tight rows, at the frame's own
/// size. `None` (or a short buffer) gives the neutral grey still. Alpha is
/// opaque: capture alpha is never trustworthy and the still covers.
pub fn frost_bgra(width: u32, height: u32, bgra: Option<&[u8]>) -> Vec<u8> {
    let pixel_count = width as usize * height as usize;
    if pixel_count == 0 {
        return Vec::new();
    }
    let Some(bgra) = bgra.filter(|bytes| bytes.len() >= pixel_count * 4) else {
        return FROST_GREY.repeat(pixel_count);
    };
    let plan = frost_plan(width, height);
    let (w, h) = (width as usize, height as usize);
    let (sw, sh) = (plan.small_width as usize, plan.small_height as usize);

    // Three f32 planes (B, G, R); alpha is dropped and rewritten opaque.
    let mut planes = vec![0.0_f32; w * h * 3];
    for (index, pixel) in bgra[..pixel_count * 4].chunks_exact(4).enumerate() {
        planes[index * 3] = f32::from(pixel[0]);
        planes[index * 3 + 1] = f32::from(pixel[1]);
        planes[index * 3 + 2] = f32::from(pixel[2]);
    }
    let narrow = area_resample_horizontal(&planes, w, h, sw);
    let small = area_resample_vertical(&narrow, sw, h, sh);
    let blurred = gaussian_blur(&small, sw, sh, FROST_SIGMA);
    let full = bilinear_upscale(&blurred, sw, sh, w, h);

    let mut out = vec![0_u8; pixel_count * 4];
    for (index, pixel) in out.chunks_exact_mut(4).enumerate() {
        pixel[0] = quantize(full[index * 3]);
        pixel[1] = quantize(full[index * 3 + 1]);
        pixel[2] = quantize(full[index * 3 + 2]);
        pixel[3] = 0xff;
    }
    out
}

fn quantize(value: f32) -> u8 {
    (value + 0.5).clamp(0.0, 255.0) as u8
}

/// For each destination index, the source span it averages: start index and
/// the weight of each covered source index (exact fractional coverage).
fn area_spans(source_len: usize, dest_len: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = source_len as f64 / dest_len as f64;
    (0..dest_len)
        .map(|index| {
            let from = index as f64 * scale;
            let to = ((index + 1) as f64 * scale).min(source_len as f64);
            let start = from.floor() as usize;
            let end = (to.ceil() as usize).max(start + 1).min(source_len);
            let mut weights = Vec::with_capacity(end - start);
            for source in start..end {
                let lo = (source as f64).max(from);
                let hi = ((source + 1) as f64).min(to);
                weights.push(((hi - lo).max(0.0) / (to - from).max(f64::EPSILON)) as f32);
            }
            (start, weights)
        })
        .collect()
}

fn area_resample_horizontal(planes: &[f32], w: usize, h: usize, dest_w: usize) -> Vec<f32> {
    if dest_w == w {
        return planes.to_vec();
    }
    let spans = area_spans(w, dest_w);
    let mut out = vec![0.0_f32; dest_w * h * 3];
    for y in 0..h {
        let row = &planes[y * w * 3..(y + 1) * w * 3];
        for (dx, (start, weights)) in spans.iter().enumerate() {
            let mut acc = [0.0_f32; 3];
            for (offset, weight) in weights.iter().enumerate() {
                let sx = start + offset;
                acc[0] += row[sx * 3] * weight;
                acc[1] += row[sx * 3 + 1] * weight;
                acc[2] += row[sx * 3 + 2] * weight;
            }
            let base = (y * dest_w + dx) * 3;
            out[base..base + 3].copy_from_slice(&acc);
        }
    }
    out
}

fn area_resample_vertical(planes: &[f32], w: usize, h: usize, dest_h: usize) -> Vec<f32> {
    if dest_h == h {
        return planes.to_vec();
    }
    let spans = area_spans(h, dest_h);
    let mut out = vec![0.0_f32; w * dest_h * 3];
    for (dy, (start, weights)) in spans.iter().enumerate() {
        let dest_row = &mut out[dy * w * 3..(dy + 1) * w * 3];
        for (offset, weight) in weights.iter().enumerate() {
            let source_row = &planes[(start + offset) * w * 3..(start + offset + 1) * w * 3];
            for (dest, source) in dest_row.iter_mut().zip(source_row) {
                *dest += source * weight;
            }
        }
    }
    out
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil() as i32;
    let mut kernel: Vec<f32> = (-radius..=radius)
        .map(|x| (-(x as f32 * x as f32) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = kernel.iter().sum();
    for weight in &mut kernel {
        *weight /= sum;
    }
    kernel
}

/// A sample index reflected back into `0..len` at the edges, so a border
/// blurs with its own neighbourhood instead of a smeared edge column.
fn mirrored_index(index: isize, len: usize) -> usize {
    let last = len as isize - 1;
    if last <= 0 {
        return 0;
    }
    let period = 2 * last;
    let mut i = index.rem_euclid(period);
    if i > last {
        i = period - i;
    }
    i as usize
}

/// Separable Gaussian blur with mirrored edges.
fn gaussian_blur(planes: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let kernel = gaussian_kernel(sigma);
    let radius = (kernel.len() / 2) as isize;
    let mut horizontal = vec![0.0_f32; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0_f32; 3];
            for (k, weight) in kernel.iter().enumerate() {
                let sx = mirrored_index(x as isize + k as isize - radius, w);
                let base = (y * w + sx) * 3;
                acc[0] += planes[base] * weight;
                acc[1] += planes[base + 1] * weight;
                acc[2] += planes[base + 2] * weight;
            }
            let base = (y * w + x) * 3;
            horizontal[base..base + 3].copy_from_slice(&acc);
        }
    }
    let mut out = vec![0.0_f32; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0_f32; 3];
            for (k, weight) in kernel.iter().enumerate() {
                let sy = mirrored_index(y as isize + k as isize - radius, h);
                let base = (sy * w + x) * 3;
                acc[0] += horizontal[base] * weight;
                acc[1] += horizontal[base + 1] * weight;
                acc[2] += horizontal[base + 2] * weight;
            }
            let base = (y * w + x) * 3;
            out[base..base + 3].copy_from_slice(&acc);
        }
    }
    out
}

fn bilinear_upscale(planes: &[f32], sw: usize, sh: usize, w: usize, h: usize) -> Vec<f32> {
    if sw == w && sh == h {
        return planes.to_vec();
    }
    let mut out = vec![0.0_f32; w * h * 3];
    let x_scale = sw as f32 / w as f32;
    let y_scale = sh as f32 / h as f32;
    let max_x = (sw - 1) as f32;
    let max_y = (sh - 1) as f32;
    let xs: Vec<(usize, usize, f32)> = (0..w)
        .map(|x| {
            let u = (((x as f32 + 0.5) * x_scale) - 0.5).clamp(0.0, max_x);
            let x0 = u.floor() as usize;
            (x0, (x0 + 1).min(sw - 1), u - x0 as f32)
        })
        .collect();
    for y in 0..h {
        let v = (((y as f32 + 0.5) * y_scale) - 0.5).clamp(0.0, max_y);
        let y0 = v.floor() as usize;
        let y1 = (y0 + 1).min(sh - 1);
        let fy = v - y0 as f32;
        for (x, &(x0, x1, fx)) in xs.iter().enumerate() {
            let base = (y * w + x) * 3;
            for channel in 0..3 {
                let top = planes[(y0 * sw + x0) * 3 + channel] * (1.0 - fx)
                    + planes[(y0 * sw + x1) * 3 + channel] * fx;
                let bottom = planes[(y1 * sw + x0) * 3 + channel] * (1.0 - fx)
                    + planes[(y1 * sw + x1) * 3 + channel] * fx;
                out[base + channel] = top * (1.0 - fy) + bottom * fy;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// macOS: the still as an IOSurface, so the Metal path keeps zero-copy import
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub mod macos {
    use std::ptr::NonNull;

    use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFType};
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
        kCVPixelFormatType_32BGRA,
    };
    use objc2_io_surface::{
        IOSurfaceLockOptions, IOSurfaceRef, kIOSurfaceAllocSize, kIOSurfaceBytesPerElement,
        kIOSurfaceBytesPerRow, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
    };

    use crate::frame_store::{RetainedIoSurface, RetainedPixelBuffer};

    /// A new BGRA IOSurface holding `bgra` (tight rows). The compositor
    /// imports it exactly like a ScreenCaptureKit surface.
    pub fn create_bgra_iosurface(
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Option<RetainedIoSurface> {
        let (w, h) = (width as usize, height as usize);
        let tight_row = w.checked_mul(4)?;
        if w == 0 || h == 0 || bgra.len() < tight_row.checked_mul(h)? {
            return None;
        }
        // SAFETY: reading extern property-key statics.
        let (key_width, key_height, key_bpe, key_bpr, key_format, key_alloc) = unsafe {
            (
                kIOSurfaceWidth,
                kIOSurfaceHeight,
                kIOSurfaceBytesPerElement,
                kIOSurfaceBytesPerRow,
                kIOSurfacePixelFormat,
                kIOSurfaceAllocSize,
            )
        };
        let bytes_per_row = IOSurfaceRef::align_property(key_bpr, tight_row);
        let alloc_size = IOSurfaceRef::align_property(key_alloc, bytes_per_row.checked_mul(h)?);
        let width_number = CFNumber::new_i64(w as i64);
        let height_number = CFNumber::new_i64(h as i64);
        let bpe_number = CFNumber::new_i64(4);
        let bpr_number = CFNumber::new_i64(bytes_per_row as i64);
        let format_number = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
        let alloc_number = CFNumber::new_i64(alloc_size as i64);
        let properties = CFDictionary::<CFType, CFType>::from_slices(
            &[
                key_width.as_ref(),
                key_height.as_ref(),
                key_bpe.as_ref(),
                key_bpr.as_ref(),
                key_format.as_ref(),
                key_alloc.as_ref(),
            ],
            &[
                width_number.as_ref(),
                height_number.as_ref(),
                bpe_number.as_ref(),
                bpr_number.as_ref(),
                format_number.as_ref(),
                alloc_number.as_ref(),
            ],
        );
        // SAFETY: a well-formed property dictionary; the result is retained.
        let surface: CFRetained<IOSurfaceRef> =
            unsafe { IOSurfaceRef::new(properties.as_opaque()) }?;
        // SAFETY: lock for writing, copy rows at the surface's own pitch, unlock.
        unsafe {
            if surface.lock(IOSurfaceLockOptions::empty(), std::ptr::null_mut()) != 0 {
                return None;
            }
            let pitch = surface.bytes_per_row();
            let base = surface.base_address().as_ptr().cast::<u8>();
            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    bgra.as_ptr().add(row * tight_row),
                    base.add(row * pitch),
                    tight_row,
                );
            }
            surface.unlock(IOSurfaceLockOptions::empty(), std::ptr::null_mut());
        }
        Some(RetainedIoSurface::new(surface))
    }

    /// The BGRA pixels of a capture surface, tight rows.
    pub fn read_bgra_from_iosurface(
        surface: &RetainedIoSurface,
        width: u32,
        height: u32,
    ) -> Option<Vec<u8>> {
        let (w, h) = (width as usize, height as usize);
        let tight_row = w.checked_mul(4)?;
        let surface = surface.surface();
        if w == 0 || h == 0 || surface.width() < w || surface.height() < h {
            return None;
        }
        let mut out = vec![0_u8; tight_row * h];
        // SAFETY: a read-only lock around a bounded row copy.
        unsafe {
            if surface.lock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut()) != 0 {
                return None;
            }
            let pitch = surface.bytes_per_row();
            let base = surface.base_address().as_ptr().cast::<u8>();
            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    base.add(row * pitch),
                    out.as_mut_ptr().add(row * tight_row),
                    tight_row,
                );
            }
            surface.unlock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut());
        }
        Some(out)
    }

    /// The BGRA pixels of a retained CoreVideo buffer, tight rows.
    pub fn read_bgra_from_pixel_buffer(
        pixel_buffer: &RetainedPixelBuffer,
        width: u32,
        height: u32,
    ) -> Option<Vec<u8>> {
        let (w, h) = (width as usize, height as usize);
        let tight_row = w.checked_mul(4)?;
        if w == 0 || h == 0 {
            return None;
        }
        let pixel_buffer: &CVPixelBuffer = pixel_buffer.pixel_buffer();
        // SAFETY: a read-only base-address lock around a bounded row copy.
        unsafe {
            if CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
                return None;
            }
            let pitch = CVPixelBufferGetBytesPerRow(pixel_buffer);
            let Some(base) = NonNull::new(CVPixelBufferGetBaseAddress(pixel_buffer)) else {
                CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
                return None;
            };
            let base = base.as_ptr().cast::<u8>();
            let mut out = vec![0_u8; tight_row * h];
            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    base.add(row * pitch),
                    out.as_mut_ptr().add(row * tight_row),
                    tight_row,
                );
            }
            CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
            Some(out)
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: the still as a D3D11 texture, on the capture texture's own device
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub mod d3d11 {
    use anyhow::{Context, Result, ensure};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
        D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, ID3D11Device, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    use crate::frame_store::RetainedD3D11Texture;

    /// A capture texture's BGRA pixels (tight rows) through a staging copy on
    /// the texture's own device. The capture device is multithread-protected,
    /// so this runs from the capture thread or from the hide RPC alike.
    pub fn read_bgra_texture(texture: &RetainedD3D11Texture) -> Result<(u32, u32, Vec<u8>)> {
        let source = texture.texture();
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: querying a live COM texture.
        unsafe { source.GetDesc(&mut desc) };
        ensure!(
            desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM,
            "the screen texture is not BGRA8 ({:?})",
            desc.Format
        );
        ensure!(
            desc.Width > 0 && desc.Height > 0,
            "the screen texture is empty"
        );
        // SAFETY: the device and context that own the texture.
        let device: ID3D11Device = unsafe { source.GetDevice() }?;
        let context = unsafe { device.GetImmediateContext() }?;
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: desc.Width,
            Height: desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: desc.SampleDesc,
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        // SAFETY: a staging texture of the source's geometry.
        unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }
            .context("could not create the Hide screen staging texture")?;
        let staging = staging.context("D3D11 returned no staging texture")?;
        // SAFETY: GPU copy, then a CPU map of the staging texture.
        unsafe { context.CopyResource(&staging, source) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .context("could not map the Hide screen staging texture")?;
        let result = (|| -> Result<Vec<u8>> {
            ensure!(!mapped.pData.is_null(), "staging texture mapped to null");
            let (w, h) = (desc.Width as usize, desc.Height as usize);
            let tight_row = w * 4;
            let pitch = mapped.RowPitch as usize;
            ensure!(
                pitch >= tight_row,
                "staging row pitch is narrower than a row"
            );
            let mut out = vec![0_u8; tight_row * h];
            // SAFETY: bounded row copies from the mapped pointer.
            unsafe {
                let base = mapped.pData.cast::<u8>();
                for row in 0..h {
                    std::ptr::copy_nonoverlapping(
                        base.add(row * pitch),
                        out.as_mut_ptr().add(row * tight_row),
                        tight_row,
                    );
                }
            }
            Ok(out)
        })();
        // SAFETY: unmap what was mapped above.
        unsafe { context.Unmap(&staging, 0) };
        Ok((desc.Width, desc.Height, result?))
    }

    /// A new default-usage BGRA8 texture holding `bgra` (tight rows), on the
    /// same device and adapter as `like`, bindable as a shader resource and a
    /// render target like a WGC frame.
    pub fn create_bgra_texture(
        like: &RetainedD3D11Texture,
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Result<RetainedD3D11Texture> {
        ensure!(width > 0 && height > 0, "the still has no pixels");
        ensure!(
            bgra.len() >= width as usize * height as usize * 4,
            "the still's buffer is short"
        );
        // SAFETY: the device that owns the capture texture.
        let device: ID3D11Device = unsafe { like.texture().GetDevice() }?;
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
            BindFlags: (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET).0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: bgra.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        // SAFETY: `bgra` outlives the call; D3D11 copies the initial data.
        unsafe { device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture)) }
            .context("could not create the Hide screen still texture")?;
        let texture = texture.context("D3D11 returned no still texture")?;
        Ok(RetainedD3D11Texture::new(texture, like.adapter_luid()))
    }

    /// The frosted still of a capture texture, as a texture plus its pixels.
    pub fn frost_texture(
        texture: &RetainedD3D11Texture,
    ) -> Result<(u32, u32, RetainedD3D11Texture, Vec<u8>)> {
        let (width, height, live) = read_bgra_texture(texture)?;
        let frosted = super::frost_bgra(width, height, Some(&live));
        let still = create_bgra_texture(texture, width, height, &frosted)?;
        Ok((width, height, still, frosted))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> ScreenPrivacyGate {
        ScreenPrivacyGate::default()
    }

    #[test]
    fn gate_starts_visible_with_an_empty_snapshot() {
        let gate = gate();
        assert_eq!(
            gate.view(),
            ScreenPrivacyView {
                hidden: false,
                span: 0
            }
        );
        assert_eq!(gate.snapshot(), ScreenPrivacy::default());
    }

    #[test]
    fn hide_bumps_the_span_once_and_show_keeps_it() {
        let gate = gate();
        let hidden = gate.hide(ScreenPrivacyReason::You, "2026-10-28T10:00:00+00:00".into());
        assert!(hidden.hidden);
        assert_eq!(hidden.reason, Some(ScreenPrivacyReason::You));
        assert_eq!(hidden.since.as_deref(), Some("2026-10-28T10:00:00+00:00"));
        assert_eq!(gate.view().span, 1);
        // A second hide while hidden is not a new edge: the still stays.
        let again = gate.hide(
            ScreenPrivacyReason::PasswordManager,
            "2026-10-28T10:00:05+00:00".into(),
        );
        assert_eq!(gate.view().span, 1);
        assert_eq!(
            again.reason,
            Some(ScreenPrivacyReason::You),
            "you outrank the list"
        );
        assert_eq!(again.since.as_deref(), Some("2026-10-28T10:00:00+00:00"));
        let shown = gate.show();
        assert_eq!(shown, ScreenPrivacy::default());
        assert_eq!(gate.view().span, 1);
        gate.hide(ScreenPrivacyReason::PasswordManager, "t".into());
        assert_eq!(gate.view().span, 2);
        // The streamer's own hide outranks a password-manager hide.
        let upgraded = gate.hide(ScreenPrivacyReason::You, "later".into());
        assert_eq!(upgraded.reason, Some(ScreenPrivacyReason::You));
        assert_eq!(upgraded.since.as_deref(), Some("t"));
    }

    #[test]
    fn admission_frosts_once_per_span_and_holds_the_rest() {
        let gate = gate();
        let mut cursor = ScreenPrivacyCursor::default();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Publish
        );
        gate.hide(ScreenPrivacyReason::You, "t".into());
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Frost
        );
        for _ in 0..3 {
            assert_eq!(
                admit_screen_frame(gate.view(), &mut cursor),
                ScreenFrameAdmission::Hold
            );
        }
        // A source started while hidden has a fresh cursor: it frosts first.
        let mut fresh = ScreenPrivacyCursor::default();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut fresh),
            ScreenFrameAdmission::Frost
        );
        assert_eq!(
            admit_screen_frame(gate.view(), &mut fresh),
            ScreenFrameAdmission::Hold
        );
        gate.show();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Publish
        );
        // Hide again: a new span, one new still.
        gate.hide(ScreenPrivacyReason::PasswordManager, "t2".into());
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Frost
        );
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Hold
        );
    }

    #[test]
    fn frost_plan_keeps_the_aspect_ratio_and_never_upscales() {
        let plan = frost_plan(1920, 1080);
        assert_eq!((plan.small_width, plan.small_height), (85, 48));
        let plan = frost_plan(3840, 2160);
        assert_eq!((plan.small_width, plan.small_height), (85, 48));
        let plan = frost_plan(1080, 1920);
        assert_eq!((plan.small_width, plan.small_height), (27, 48));
        let plan = frost_plan(100, 30);
        assert_eq!((plan.small_width, plan.small_height), (100, 30));
        let plan = frost_plan(64, 36);
        assert_eq!((plan.small_width, plan.small_height), (64, 36));
        let plan = frost_plan(1, 1);
        assert_eq!((plan.small_width, plan.small_height), (1, 1));
    }

    #[test]
    fn frost_without_a_frame_is_neutral_grey() {
        let still = frost_bgra(8, 4, None);
        assert_eq!(still.len(), 8 * 4 * 4);
        assert!(still.chunks_exact(4).all(|px| px == FROST_GREY));
        let short = frost_bgra(8, 4, Some(&[0; 16]));
        assert!(short.chunks_exact(4).all(|px| px == FROST_GREY));
        assert!(frost_bgra(0, 4, None).is_empty());
    }

    #[test]
    fn frost_keeps_size_and_colour() {
        let (w, h) = (1920_u32, 1080_u32);
        let red = [0_u8, 0, 220, 0].repeat((w * h) as usize);
        let still = frost_bgra(w, h, Some(&red));
        assert_eq!(still.len(), red.len());
        for px in still.chunks_exact(4) {
            assert!(px[0] <= 1 && px[1] <= 1, "blue/green leaked in: {px:?}");
            assert!((219..=221).contains(&px[2]), "red drifted: {px:?}");
            assert_eq!(px[3], 0xff, "the still is opaque");
        }
    }

    /// A 5×7 block font, enough for the fixture's word.
    fn glyph(letter: char) -> [u8; 7] {
        match letter {
            'P' => [
                0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
            ],
            'A' => [
                0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
            ],
            'S' => [
                0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
            ],
            'W' => [
                0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
            ],
            'O' => [
                0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
            ],
            'R' => [
                0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
            ],
            'D' => [
                0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
            ],
            _ => [0; 7],
        }
    }

    /// White 1920×1080 with "PASSWORD" in 72 px black block glyphs across
    /// the middle, like a password field a screen capture would show.
    fn text_fixture(w: usize, h: usize) -> Vec<u8> {
        let mut bgra = vec![0xff_u8; w * h * 4];
        let glyph_height = 72_usize;
        let glyph_width = glyph_height * 5 / 7;
        let advance = glyph_width + glyph_height / 4;
        let top = h / 2 - glyph_height / 2;
        let mut left = w / 8;
        for letter in "PASSWORD".chars() {
            let rows = glyph(letter);
            for y in 0..glyph_height {
                let row = rows[y * 7 / glyph_height];
                for x in 0..glyph_width {
                    let column = 4 - x * 5 / glyph_width;
                    if row & (1 << column) != 0 {
                        let index = ((top + y) * w + left + x) * 4;
                        bgra[index..index + 3].copy_from_slice(&[0, 0, 0]);
                    }
                }
            }
            left += advance;
        }
        bgra
    }

    fn luma(bgra: &[u8], w: usize, h: usize) -> Vec<f32> {
        (0..w * h)
            .map(|i| {
                let px = &bgra[i * 4..i * 4 + 4];
                0.114 * f32::from(px[0]) + 0.587 * f32::from(px[1]) + 0.299 * f32::from(px[2])
            })
            .collect()
    }

    /// Mean and max absolute horizontal luma step: the high-frequency energy
    /// a glyph edge carries.
    fn horizontal_edges(luma: &[f32], w: usize, h: usize) -> (f32, f32) {
        let mut sum = 0.0_f32;
        let mut max = 0.0_f32;
        for y in 0..h {
            for x in 1..w {
                let step = (luma[y * w + x] - luma[y * w + x - 1]).abs();
                sum += step;
                max = max.max(step);
            }
        }
        (sum / ((w - 1) * h) as f32, max)
    }

    /// Row means over a band of rows. Inside the text band the rows differ
    /// while the letters are legible (a bar row is darker than a stem row);
    /// that is the variance between glyph rows that must collapse. The band
    /// as a whole staying a little darker than the margins is the shape the
    /// frost keeps on purpose.
    fn row_mean_spread(luma: &[f32], w: usize, rows: std::ops::Range<usize>) -> f32 {
        let means: Vec<f32> = rows
            .map(|y| luma[y * w..(y + 1) * w].iter().sum::<f32>() / w as f32)
            .collect();
        let max = means.iter().cloned().fold(f32::MIN, f32::max);
        let min = means.iter().cloned().fold(f32::MAX, f32::min);
        max - min
    }

    /// The glyph structure of a band's row means with the band's own smooth
    /// shading removed: each row mean minus the mean of its eleven nearest
    /// rows. Strokes of 72 px text are about ten rows tall, so a legible
    /// fixture has jumps at every stroke edge that an eleven-row average
    /// keeps; the frosted band is one smooth bump, which it removes.
    fn detrended_row_spread(luma: &[f32], w: usize, rows: std::ops::Range<usize>) -> f32 {
        let means: Vec<f32> = rows
            .map(|y| luma[y * w..(y + 1) * w].iter().sum::<f32>() / w as f32)
            .collect();
        (0..means.len())
            .map(|y| {
                let lo = y.saturating_sub(5);
                let hi = (y + 6).min(means.len());
                let local = means[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
                (means[y] - local).abs()
            })
            .fold(0.0_f32, f32::max)
    }

    #[test]
    fn frost_makes_seventy_two_pixel_text_unreadable() {
        let (w, h) = (1920_usize, 1080_usize);
        let band = (h / 2 - 36)..(h / 2 + 36);
        let live = text_fixture(w, h);
        let live_luma = luma(&live, w, h);
        let (live_mean_step, live_max_step) = horizontal_edges(&live_luma, w, h);
        let live_spread = detrended_row_spread(&live_luma, w, band.clone());
        assert!(live_max_step > 200.0, "the fixture has hard glyph edges");
        assert!(
            live_spread > 3.0,
            "glyph rows differ while legible: {live_spread}"
        );

        let still = frost_bgra(w as u32, h as u32, Some(&live));
        assert_eq!(still.len(), live.len());
        let still_luma = luma(&still, w, h);
        let (mean_step, max_step) = horizontal_edges(&still_luma, w, h);
        let spread = detrended_row_spread(&still_luma, w, band);

        // Why these bounds: a legible edge is a luma step of well over 40 within
        // a pixel or two. At 48 rows the 72 px glyphs are 3.2 px tall, under
        // the σ 2 px blur's support (±6 px), so every stroke averages into its
        // neighbours; scaled back up by 22.5×, the steepest surviving ramp is
        // spread over tens of pixels. Per-pixel steps under 2 luma and a mean
        // under 0.1 leave no edge to read. Inside the band, a stroke edge of
        // the legible fixture leaves a detrended row residual above 8 luma;
        // under 1 luma (and twenty times less than live) is what the bilinear
        // upscale's own kinks between small rows leave, with no glyph in it.
        assert!(
            max_step < 2.0,
            "an edge survived the frost: max step {max_step}"
        );
        assert!(
            mean_step < 0.1,
            "high-frequency energy survived: mean step {mean_step}"
        );
        assert!(
            spread < live_spread / 20.0 && spread < 1.0,
            "glyph rows still differ inside the band: spread {spread} vs live {live_spread}"
        );
        assert!(
            live_mean_step > mean_step * 20.0,
            "the frost removed too little energy: {live_mean_step} vs {mean_step}"
        );
        // The shape stays: the band is still a little darker than the margins.
        let margin_rows = 0..64;
        let margin = row_mean_spread(&still_luma, w, margin_rows);
        assert!(margin < 1.0, "the margins are flat: {margin}");
        let band_mean = still_luma[(h / 2) * w..(h / 2 + 1) * w].iter().sum::<f32>() / w as f32;
        let margin_mean = still_luma[..w].iter().sum::<f32>() / w as f32;
        assert!(band_mean < margin_mean, "the text band vanished entirely");
    }

    #[test]
    fn frost_keeps_large_shapes() {
        // A left black half and a right white half: the shape survives as a
        // ramp, so the viewer still sees "a dark app on the left".
        let (w, h) = (640_u32, 360_u32);
        let mut bgra = vec![0xff_u8; (w * h * 4) as usize];
        for y in 0..h as usize {
            for x in 0..(w / 2) as usize {
                let i = (y * w as usize + x) * 4;
                bgra[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let still = frost_bgra(w, h, Some(&bgra));
        let still_luma = luma(&still, w as usize, h as usize);
        let left = still_luma[(180 * w + 40) as usize];
        let right = still_luma[(180 * w + 600) as usize];
        assert!(left < 30.0, "the dark half went away: {left}");
        assert!(right > 225.0, "the light half went away: {right}");
    }

    /// The shared wire fixture: absent fields are omitted, never `null`, and
    /// the renderer's contract test reads the same file.
    #[test]
    fn screen_privacy_fixture_matches_the_backend_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/screen-privacy.json"
        ))
        .expect("protocol-fixtures/screen-privacy.json is valid JSON");
        let visible = serde_json::to_value(ScreenPrivacy::default()).unwrap();
        assert_eq!(visible, fixture["visible"]);
        assert_eq!(visible.to_string(), r#"{"hidden":false}"#, "no null fields");
        let gate = gate();
        let by_you = gate.hide(ScreenPrivacyReason::You, "2026-10-28T10:15:00+00:00".into());
        assert_eq!(
            serde_json::to_value(&by_you).unwrap(),
            fixture["hiddenByYou"]
        );
        gate.show();
        let by_list = gate.hide(
            ScreenPrivacyReason::PasswordManager,
            "2026-10-28T10:16:30+00:00".into(),
        );
        assert_eq!(
            serde_json::to_value(&by_list).unwrap(),
            fixture["hiddenByPasswordManager"]
        );
        let unavailable = ScreenPrivacy {
            unavailable: Some(SCREEN_HIDE_UNAVAILABLE_LEGACY.to_string()),
            ..ScreenPrivacy::default()
        };
        assert_eq!(
            serde_json::to_value(&unavailable).unwrap(),
            fixture["unavailableOnLegacySession"]
        );
        let params: crate::protocol::ScreenHideParams =
            serde_json::from_value(fixture["hideParams"].clone()).unwrap();
        assert_eq!(params.reason, ScreenPrivacyReason::PasswordManager);
        assert!(
            serde_json::from_value::<crate::protocol::ScreenHideParams>(
                serde_json::json!({ "reason": "someone-else" })
            )
            .is_err()
        );
        // Round trip through the wire shape.
        for value in [
            &visible,
            &fixture["hiddenByYou"],
            &fixture["hiddenByPasswordManager"],
        ] {
            let parsed: ScreenPrivacy = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(&serde_json::to_value(&parsed).unwrap(), value);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn frosted_iosurface_round_trips_its_pixels() {
        let (w, h) = (70_u32, 30_u32);
        let mut bgra = vec![0_u8; (w * h * 4) as usize];
        for (i, px) in bgra.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 251) as u8;
            px[1] = (i % 241) as u8;
            px[2] = (i % 239) as u8;
            px[3] = 0xff;
        }
        let surface = macos::create_bgra_iosurface(w, h, &bgra).expect("an IOSurface");
        assert_eq!(surface.surface().width(), w as usize);
        assert_eq!(surface.surface().height(), h as usize);
        assert!(surface.surface().bytes_per_row() >= (w * 4) as usize);
        let back = macos::read_bgra_from_iosurface(&surface, w, h).expect("readback");
        assert_eq!(back, bgra);
        assert!(macos::create_bgra_iosurface(0, 4, &bgra).is_none());
        assert!(macos::create_bgra_iosurface(w, h, &bgra[..8]).is_none());
    }
}
