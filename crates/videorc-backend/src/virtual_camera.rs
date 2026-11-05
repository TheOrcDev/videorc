//! Videorc Camera (plan 214, workstream A): the output tap every platform's
//! camera reads from.
//!
//! The camera shows the program as the Preview shows it (D5): the output
//! reads `presented_frame_store` and re-picks it every tick, so the hold
//! during a performance check and the packaged backstop reach a meeting
//! exactly as they reach the Preview. One format, 1920×1080 at 30 fps (D11);
//! a vertical program is pillarboxed on black, never cropped.
//!
//! This module is the pure half plus the output thread. It owns:
//!
//! - the shared identifiers every platform uses (the device UUID, the
//!   Windows CLSID, the Linux card label),
//! - fit-and-pillarbox geometry, the 30 fps cadence (at most one push per
//!   tick, repeats counted), and the tick clock,
//! - the CPU path: an I420 fit into the camera canvas, plus pure
//!   I420 → NV12 (Windows, C3) and I420 → YUYV (Linux, D2) converters,
//! - the [`VirtualCameraSink`] trait a platform sink implements (B4 macOS,
//!   C3 Windows, D2 Linux) and the frame it is handed,
//! - the output engine that polls the store, converts off the compositor
//!   tick and pushes, holding the compositor's pixel demand (A2) only while
//!   a viewer holds the camera (D13),
//! - the "never list yourself" filters (A5), one per platform,
//! - the status rule that turns the switch, the platform's report and the
//!   sink's health into one `VirtualCameraStatus`.
//!
//! The backend glue (the settings store, the RPCs, the weak lease) lives in
//! `virtual_camera_service.rs`. Nothing here runs on the compositor tick.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::compositor::{CompositorFrameExportKind, CompositorFrameStore, CompositorPixelFormat};
use crate::protocol::{VirtualCameraPlatformStep, VirtualCameraState, VirtualCameraStatus};

// ---------------------------------------------------------------------------
// Shared identifiers (fixed; the Swift extension, the Windows DLL and the
// Linux module load use the same values)
// ---------------------------------------------------------------------------

/// The camera's name in every other app (D2). Windows appends
/// [`VIRTUAL_CAMERA_WINDOWS_NAME_SUFFIX`] on its own.
pub const VIRTUAL_CAMERA_NAME: &str = "Videorc Camera";
/// D11: one format.
pub const VIRTUAL_CAMERA_WIDTH: u32 = 1920;
pub const VIRTUAL_CAMERA_HEIGHT: u32 = 1080;
pub const VIRTUAL_CAMERA_FPS: u32 = 30;
/// macOS: what `AVCaptureDevice.uniqueID` shows for the extension's device.
pub const VIRTUAL_CAMERA_MACOS_DEVICE_UUID: &str = "7C2B0687-25A9-44A9-A5FC-3293B79D2853";
/// macOS: the Camera Extension's bundle id (B1).
#[allow(dead_code)] // B3/B4 read it; shared here so Rust and Swift agree.
pub const VIRTUAL_CAMERA_MACOS_EXTENSION_BUNDLE_ID: &str = "dev.theorcdev.videorc.camera";
/// Windows: the media source CLSID (C1), as `MFCreateVirtualCamera` and the
/// HKLM registration name it.
pub const VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID: &str = "{B629EEBB-4B8E-4CAB-A549-EB17570B1382}";
/// Windows appends this to the friendly name of every virtual camera.
#[allow(dead_code)] // C3 and the smoke name the camera as Windows shows it.
pub const VIRTUAL_CAMERA_WINDOWS_NAME_SUFFIX: &str = " Windows Virtual Camera";
/// Linux: the v4l2loopback `card_label` and `video_nr` (D1, D2).
pub const VIRTUAL_CAMERA_LINUX_CARD_LABEL: &str = "Videorc Camera";
pub const VIRTUAL_CAMERA_LINUX_VIDEO_NR: u32 = 42;
/// The backend settings-store key for the switch (D4).
pub const VIRTUAL_CAMERA_SETTING_KEY: &str = "virtualCamera";
/// The lease id the camera arms the preview run under (A3).
pub const VIRTUAL_CAMERA_LEASE_SESSION_ID: &str = "virtual-camera";

/// How often the output re-reads the sink's viewer count (D13). Short, so
/// the first app to pick the camera gets the program within a moment and not
/// a still (plan 214 review). Connect retries keep their own second
/// (`CONNECT_RETRY_INTERVAL`, gated in `ensure_connected`).
pub const VIEWER_CHECK_INTERVAL: Duration = Duration::from_millis(250);
/// How often a failed sink connect is retried.
pub const CONNECT_RETRY_INTERVAL: Duration = Duration::from_secs(1);

// BT.709 video range black: Y 16, chroma 128.
const BLACK_Y: u8 = 16;
const BLACK_UV: u8 = 128;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Where the program lands inside the camera canvas: aspect-fit, centred,
/// even-aligned so the chroma planes stay whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FitRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl FitRect {
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    /// Whether the program fills the canvas (no bars): a GPU sink blits the
    /// whole target then, with no clear.
    #[allow(dead_code)] // B4/C3.
    pub fn is_full(&self, canvas_width: u32, canvas_height: u32) -> bool {
        self.x == 0 && self.y == 0 && self.width == canvas_width && self.height == canvas_height
    }
}

fn even_floor(value: u32) -> u32 {
    value & !1
}

/// Aspect-fit `source` into `canvas`: a vertical program is pillarboxed, a
/// wider-than-16:9 one letterboxed, never cropped (D11). Every edge is even.
/// A degenerate source fills the canvas.
pub fn fit_rect(
    source_width: u32,
    source_height: u32,
    canvas_width: u32,
    canvas_height: u32,
) -> FitRect {
    if source_width == 0 || source_height == 0 || canvas_width == 0 || canvas_height == 0 {
        return FitRect::full(canvas_width, canvas_height);
    }
    let scale_x = canvas_width as f64 / source_width as f64;
    let scale_y = canvas_height as f64 / source_height as f64;
    let scale = scale_x.min(scale_y);
    let width = even_floor(((source_width as f64 * scale).round() as u32).clamp(2, canvas_width));
    let height =
        even_floor(((source_height as f64 * scale).round() as u32).clamp(2, canvas_height));
    FitRect {
        x: even_floor((canvas_width - width) / 2),
        y: even_floor((canvas_height - height) / 2),
        width,
        height,
    }
}

// ---------------------------------------------------------------------------
// Cadence and clock
// ---------------------------------------------------------------------------

/// What one output tick does with the newest program frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickAction {
    /// A frame the camera has not shown yet: convert and push it.
    Push,
    /// The same frame as last tick (the run is slower than 30 fps, or paused):
    /// push the last camera frame again so the meeting never stalls.
    Repeat,
    /// Nothing composed yet and nothing to repeat.
    Idle,
}

/// At most one push per tick; repeats counted.
#[derive(Debug, Default, Clone)]
pub struct Cadence {
    last_sequence: Option<u64>,
    have_frame: bool,
}

impl Cadence {
    pub fn decide(&mut self, latest_sequence: Option<u64>) -> TickAction {
        match latest_sequence {
            Some(sequence) if self.last_sequence != Some(sequence) => {
                self.last_sequence = Some(sequence);
                self.have_frame = true;
                TickAction::Push
            }
            _ if self.have_frame => TickAction::Repeat,
            _ => TickAction::Idle,
        }
    }

    /// The camera lost its last frame (the sink reconnected, the converter was
    /// reset): the next frame is a push again, and nothing is repeated.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// The next tick deadline on a fixed 1/fps grid. A loop more than one
/// interval late re-syncs to `now` instead of bursting to catch up.
pub fn next_deadline(deadline: Instant, now: Instant, interval: Duration) -> Instant {
    let next = deadline + interval;
    if next + interval < now { now } else { next }
}

/// The presentation time of one pushed frame: a monotonic tick count on the
/// camera's own 1/fps clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualCameraPts {
    pub tick: u64,
    pub nanos: u64,
}

impl VirtualCameraPts {
    pub fn for_tick(tick: u64, fps: u32) -> Self {
        let fps = u64::from(fps.max(1));
        Self {
            tick,
            nanos: tick.saturating_mul(1_000_000_000) / fps,
        }
    }

    /// One frame's duration, for a sink that stamps durations (B4's CMTime).
    #[allow(dead_code)] // B4.
    pub fn duration_nanos(fps: u32) -> u64 {
        1_000_000_000 / u64::from(fps.max(1))
    }
}

// ---------------------------------------------------------------------------
// I420 planes and the converters
// ---------------------------------------------------------------------------

/// Borrowed planar I420 (BT.709, video range): what the CPU compositor
/// publishes, Y then U then V, tightly packed.
#[derive(Debug, Clone, Copy)]
pub struct I420View<'a> {
    pub width: u32,
    pub height: u32,
    pub y: &'a [u8],
    pub u: &'a [u8],
    pub v: &'a [u8],
}

impl<'a> I420View<'a> {
    /// Split the compositor's packed `bytes` (`raw_yuv420p_len`) into planes.
    /// `None` when the buffer is shorter than the planes need.
    pub fn from_packed(bytes: &'a [u8], width: u32, height: u32) -> Option<Self> {
        let (y_len, uv_len) = plane_lens(width, height);
        if bytes.len() < y_len + 2 * uv_len {
            return None;
        }
        Some(Self {
            width,
            height,
            y: &bytes[..y_len],
            u: &bytes[y_len..y_len + uv_len],
            v: &bytes[y_len + uv_len..y_len + 2 * uv_len],
        })
    }
}

/// Owned planar I420 at the camera format: the scratch the CPU path fills
/// and hands the sink. Reused across ticks; no per-frame allocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct I420Planes {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

impl I420Planes {
    pub fn black(width: u32, height: u32) -> Self {
        let (y_len, uv_len) = plane_lens(width, height);
        Self {
            width,
            height,
            y: vec![BLACK_Y; y_len],
            u: vec![BLACK_UV; uv_len],
            v: vec![BLACK_UV; uv_len],
        }
    }

    #[allow(dead_code)] // C3 and D2 hand the planes to the converters this way.
    pub fn view(&self) -> I420View<'_> {
        I420View {
            width: self.width,
            height: self.height,
            y: &self.y,
            u: &self.u,
            v: &self.v,
        }
    }
}

fn chroma_dims(width: u32, height: u32) -> (usize, usize) {
    (
        (width.max(1) as usize).div_ceil(2),
        (height.max(1) as usize).div_ceil(2),
    )
}

fn plane_lens(width: u32, height: u32) -> (usize, usize) {
    let (cw, ch) = chroma_dims(width, height);
    (width.max(1) as usize * height.max(1) as usize, cw * ch)
}

/// I420 → NV12 (Y plane, then interleaved U V pairs): what the Windows media
/// source wants (C3). `dst` is resized to the NV12 length.
#[allow(dead_code)] // C3.
pub fn i420_to_nv12(src: &I420View<'_>, dst: &mut Vec<u8>) {
    let (y_len, uv_len) = plane_lens(src.width, src.height);
    dst.clear();
    dst.resize(y_len + 2 * uv_len, 0);
    dst[..y_len].copy_from_slice(&src.y[..y_len]);
    let uv = &mut dst[y_len..];
    for ((pair, u), v) in uv
        .chunks_exact_mut(2)
        .zip(&src.u[..uv_len])
        .zip(&src.v[..uv_len])
    {
        pair[0] = *u;
        pair[1] = *v;
    }
}

/// I420 → YUYV 4:2:2 (per pixel pair `Y0 U Y1 V`): what v4l2loopback readers
/// want (D2). Both chroma rows of a pair share the I420 chroma row (no
/// vertical filter: the camera's 1080p source is already 4:2:0). An odd
/// width repeats the last luma. `dst` is resized to the YUYV length.
#[allow(dead_code)] // D2.
pub fn i420_to_yuyv(src: &I420View<'_>, dst: &mut Vec<u8>) {
    let width = src.width.max(1) as usize;
    let height = src.height.max(1) as usize;
    let (cw, _) = chroma_dims(src.width, src.height);
    let row_len = cw * 4;
    dst.clear();
    dst.resize(row_len * height, 0);
    for (row_index, out_row) in dst.chunks_exact_mut(row_len).enumerate() {
        let y_row = &src.y[row_index * width..(row_index + 1) * width];
        let chroma_row = row_index / 2;
        let u_row = &src.u[chroma_row * cw..(chroma_row + 1) * cw];
        let v_row = &src.v[chroma_row * cw..(chroma_row + 1) * cw];
        for (pair_index, quad) in out_row.chunks_exact_mut(4).enumerate() {
            let x0 = pair_index * 2;
            let x1 = (x0 + 1).min(width - 1);
            quad[0] = y_row[x0];
            quad[1] = u_row[pair_index];
            quad[2] = y_row[x1];
            quad[3] = v_row[pair_index];
        }
    }
}

/// Per-axis bilinear sampling table: for every destination index the first
/// source index and the weight of the next one (0..=256).
#[derive(Debug, Clone, PartialEq, Eq)]
struct AxisTable {
    index: Vec<usize>,
    weight: Vec<u16>,
}

impl AxisTable {
    fn new(source_len: usize, dest_len: usize) -> Self {
        let source_len = source_len.max(1);
        let dest_len = dest_len.max(1);
        let mut index = Vec::with_capacity(dest_len);
        let mut weight = Vec::with_capacity(dest_len);
        let scale = source_len as f64 / dest_len as f64;
        for d in 0..dest_len {
            // Pixel-centre mapping, clamped at the edges.
            let position = ((d as f64 + 0.5) * scale - 0.5).max(0.0);
            let mut i = position.floor() as usize;
            let mut w = ((position - i as f64) * 256.0).round() as u16;
            if i + 1 >= source_len {
                i = source_len - 1;
                w = 0;
            }
            index.push(i);
            weight.push(w);
        }
        Self { index, weight }
    }

    fn is_identity(&self) -> bool {
        self.weight.iter().all(|weight| *weight == 0)
            && self.index.iter().enumerate().all(|(d, i)| d == *i)
    }
}

/// Horizontal pass of one source row into 8.8 fixed point.
fn resample_row(source: &[u8], table: &AxisTable, out: &mut [u16]) {
    for ((out, &i), &w) in out.iter_mut().zip(&table.index).zip(&table.weight) {
        let a = u32::from(source[i]);
        let b = u32::from(source[(i + 1).min(source.len() - 1)]);
        *out = (a * (256 - u32::from(w)) + b * u32::from(w)) as u16;
    }
}

/// Separable bilinear resample of one plane into a rectangle of `dst`
/// (`dst_stride` wide). Rows outside the rectangle are untouched.
#[allow(clippy::too_many_arguments)]
fn scale_plane_into(
    src: &[u8],
    src_width: usize,
    src_height: usize,
    dst: &mut [u8],
    dst_stride: usize,
    rect_x: usize,
    rect_y: usize,
    x_table: &AxisTable,
    y_table: &AxisTable,
) {
    let dest_width = x_table.index.len();
    let dest_height = y_table.index.len();
    if src_width == 0 || src_height == 0 || dest_width == 0 || dest_height == 0 {
        return;
    }
    if x_table.is_identity() && y_table.is_identity() {
        for row in 0..dest_height {
            let src_row = &src[row * src_width..row * src_width + dest_width];
            let start = (rect_y + row) * dst_stride + rect_x;
            dst[start..start + dest_width].copy_from_slice(src_row);
        }
        return;
    }
    // Split the destination rows into bands so the luma plane uses every
    // core; each band resamples the source rows it needs itself.
    let band_rows = 64;
    let bands = dest_height.div_ceil(band_rows);
    let dst_rows: Vec<&mut [u8]> = dst
        .chunks_mut(dst_stride)
        .skip(rect_y)
        .take(dest_height)
        .collect();
    let mut dst_bands: Vec<Vec<&mut [u8]>> = Vec::with_capacity(bands);
    let mut rows = dst_rows.into_iter();
    for _ in 0..bands {
        dst_bands.push(rows.by_ref().take(band_rows).collect());
    }
    use rayon::prelude::*;
    dst_bands
        .into_par_iter()
        .enumerate()
        .for_each(|(band, band_rows_out)| {
            let mut cache_index = [usize::MAX; 2];
            let mut cache = [vec![0u16; dest_width], vec![0u16; dest_width]];
            let mut slot = 0usize;
            let fetch = |source_row: usize,
                         cache_index: &mut [usize; 2],
                         cache: &mut [Vec<u16>; 2],
                         slot: &mut usize|
             -> usize {
                if cache_index[0] == source_row {
                    return 0;
                }
                if cache_index[1] == source_row {
                    return 1;
                }
                let target = *slot;
                *slot ^= 1;
                let row = &src[source_row * src_width..(source_row + 1) * src_width];
                resample_row(row, x_table, &mut cache[target]);
                cache_index[target] = source_row;
                target
            };
            for (row_in_band, out_row) in band_rows_out.into_iter().enumerate() {
                let dest_row = band * band_rows + row_in_band;
                let y0 = y_table.index[dest_row];
                let wy = u32::from(y_table.weight[dest_row]);
                let y1 = (y0 + 1).min(src_height - 1);
                let a = fetch(y0, &mut cache_index, &mut cache, &mut slot);
                let b = if wy == 0 {
                    a
                } else {
                    fetch(y1, &mut cache_index, &mut cache, &mut slot)
                };
                let out = &mut out_row[rect_x..rect_x + dest_width];
                if wy == 0 || a == b {
                    for (out, value) in out.iter_mut().zip(&cache[a]) {
                        *out = ((u32::from(*value) + 128) >> 8) as u8;
                    }
                } else {
                    let (top, bottom) = (&cache[a], &cache[b]);
                    for ((out, &t), &btm) in out.iter_mut().zip(top).zip(bottom) {
                        let blended = u32::from(t) * (256 - wy) + u32::from(btm) * wy;
                        *out = ((blended + (1 << 15)) >> 16) as u8;
                    }
                }
            }
        });
}

/// Fits program frames into the camera canvas on the CPU: scratch planes,
/// cached sampling tables, bars painted once per fit change.
#[derive(Debug)]
pub struct CpuFit {
    planes: I420Planes,
    fit: Option<FitRect>,
    tables: Option<FitTables>,
}

#[derive(Debug)]
struct FitTables {
    source: (u32, u32),
    fit: FitRect,
    luma_x: AxisTable,
    luma_y: AxisTable,
    chroma_x: AxisTable,
    chroma_y: AxisTable,
}

impl CpuFit {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            planes: I420Planes::black(width, height),
            fit: None,
            tables: None,
        }
    }

    #[cfg(test)]
    pub fn planes(&self) -> &I420Planes {
        &self.planes
    }

    #[allow(dead_code)] // D2 reads the last fit for its format negotiation.
    pub fn fit(&self) -> Option<FitRect> {
        self.fit
    }

    /// Fit `src` into the canvas. Returns the rectangle it landed in.
    pub fn fit_into(&mut self, src: &I420View<'_>) -> FitRect {
        let canvas = (self.planes.width, self.planes.height);
        let fit = fit_rect(src.width, src.height, canvas.0, canvas.1);
        if self.fit != Some(fit) {
            // Bars once per fit change: the rectangle is overwritten below.
            self.planes.y.fill(BLACK_Y);
            self.planes.u.fill(BLACK_UV);
            self.planes.v.fill(BLACK_UV);
            self.fit = Some(fit);
        }
        let tables_stale = self
            .tables
            .as_ref()
            .is_none_or(|tables| tables.source != (src.width, src.height) || tables.fit != fit);
        if tables_stale {
            let (scw, sch) = chroma_dims(src.width, src.height);
            let (fcw, fch) = chroma_dims(fit.width, fit.height);
            self.tables = Some(FitTables {
                source: (src.width, src.height),
                fit,
                luma_x: AxisTable::new(src.width as usize, fit.width as usize),
                luma_y: AxisTable::new(src.height as usize, fit.height as usize),
                chroma_x: AxisTable::new(scw, fcw),
                chroma_y: AxisTable::new(sch, fch),
            });
        }
        let tables = self.tables.as_ref().expect("built above");
        let (canvas_cw, _) = chroma_dims(canvas.0, canvas.1);
        let (scw, sch) = chroma_dims(src.width, src.height);
        scale_plane_into(
            src.y,
            src.width as usize,
            src.height as usize,
            &mut self.planes.y,
            canvas.0 as usize,
            fit.x as usize,
            fit.y as usize,
            &tables.luma_x,
            &tables.luma_y,
        );
        scale_plane_into(
            src.u,
            scw,
            sch,
            &mut self.planes.u,
            canvas_cw,
            fit.x as usize / 2,
            fit.y as usize / 2,
            &tables.chroma_x,
            &tables.chroma_y,
        );
        scale_plane_into(
            src.v,
            scw,
            sch,
            &mut self.planes.v,
            canvas_cw,
            fit.x as usize / 2,
            fit.y as usize / 2,
            &tables.chroma_x,
            &tables.chroma_y,
        );
        fit
    }
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/// One program frame handed to a platform sink. Pixels are never copied on
/// the way here: the Metal and D3D11 variants carry the compositor's own
/// target, the CPU variant the camera's reusable planes.
pub enum VirtualCameraFrame<'a> {
    /// The CPU path: planar I420 (BT.709, video range) already fit into the
    /// camera canvas with black bars. C3 converts with [`i420_to_nv12`], D2
    /// with [`i420_to_yuyv`].
    #[allow(dead_code)] // The platform sinks read both; the fake sink reads `fit`.
    I420 {
        planes: &'a I420Planes,
        fit: FitRect,
    },
    /// macOS: the compositor's IOSurface-backed 32BGRA target (B4 GPU-blits
    /// it into its own pool inside `push`). The output holds the ring slot
    /// in flight until `push` returns; the slot may be re-rendered after.
    /// `fit` is where the program lands in the 1920×1080 camera canvas.
    #[cfg(target_os = "macos")]
    #[allow(dead_code)] // B4 reads the target; the fake sink reads only `fit`.
    MetalTarget {
        target: &'a Arc<crate::metal_compositor::MetalCompositorTargetPixelBuffer>,
        source_width: u32,
        source_height: u32,
        fit: FitRect,
    },
    /// Windows, during a D3D11 session: the compositor's texture lease ticket
    /// for C3's staging readback. `fit` as above. The ticket type exists on
    /// every platform, so this path type-checks everywhere; only Windows
    /// ever publishes one.
    #[allow(dead_code)] // C3 reads the ticket; the fake sink reads only `fit`.
    D3d11Texture {
        ticket: &'a crate::windows_d3d11_device::WindowsD3d11TextureLeaseTicket,
        source_width: u32,
        source_height: u32,
        fit: FitRect,
    },
}

impl VirtualCameraFrame<'_> {
    /// For diagnostics (Health, E3) and the fake sink.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::I420 { .. } => "i420",
            #[cfg(target_os = "macos")]
            Self::MetalTarget { .. } => "metal-target",
            Self::D3d11Texture { .. } => "d3d11-texture",
        }
    }
}

/// What a push did. Only a sink constructs it.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualCameraPush {
    Pushed,
    /// The sink had no room (a full queue, a reader not keeping up): counted,
    /// never an error.
    Dropped,
}

/// Why a sink could not connect or push. The message is plain copy for the
/// status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualCameraSinkError {
    pub message: String,
    /// The sink is gone for good until it reconnects (the device vanished,
    /// the ring closed): the output disconnects and retries once a second.
    pub disconnected: bool,
}

#[allow(dead_code)] // Only a sink constructs these.
impl VirtualCameraSinkError {
    pub fn disconnected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnected: true,
        }
    }

    #[allow(dead_code)] // The platform sinks report a full queue this way.
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnected: false,
        }
    }
}

/// A platform's camera. One per process; the output thread owns it.
///
/// Object-safe and `Send`: the output moves it onto its own thread and
/// never calls it from the compositor tick. Every method runs on that one
/// thread, in order: `connect`, then `push` and `viewers` until
/// `disconnect`.
pub trait VirtualCameraSink: Send {
    /// A short label for diagnostics (`cmio-sink`, `mf-ring`, `v4l2loopback`).
    #[allow(dead_code)] // Health (E3) prints it.
    fn label(&self) -> &'static str;

    /// Find the device and open it. Idempotent; called again once a second
    /// after an error that disconnected the sink.
    fn connect(&mut self) -> Result<(), VirtualCameraSinkError>;

    /// Close the device. Called on off and on a disconnecting error.
    fn disconnect(&mut self);

    /// Close the device because Videorc is quitting with the switch still
    /// on (the output is dropped, not stopped). Defaults to `disconnect`;
    /// macOS tells the extension nothing then, so its still says "Videorc
    /// isn't running" rather than "off" (D12), and the switch comes back on
    /// at the next launch (D4).
    fn disconnect_at_exit(&mut self) {
        self.disconnect();
    }

    /// Hand one frame to the device at `pts`. Returns inside the frame's
    /// lifetime: a GPU sink blits before returning.
    fn push(
        &mut self,
        frame: &VirtualCameraFrame<'_>,
        pts: VirtualCameraPts,
    ) -> Result<VirtualCameraPush, VirtualCameraSinkError>;

    /// How many apps hold the camera right now (D13). `None` means the
    /// platform cannot tell (Linux), which counts as demanded.
    fn viewers(&self) -> Option<u32>;
}

/// The platform has no camera sink yet, or this build cannot run one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualCameraUnavailable {
    /// Plain copy for the status line.
    pub reason: String,
    /// Owner, 2026-11-03: a platform whose camera hasn't passed its on-device
    /// spike stays hidden. The status reports `platformStep: unsupported`
    /// and the UI shows no section at all; a non-hidden unavailability shows
    /// the section with the reason.
    pub hidden: bool,
}

impl VirtualCameraUnavailable {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            hidden: false,
        }
    }

    /// Owner, 2026-11-03: a platform whose camera hasn't passed its on-device
    /// spike stays hidden.
    #[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))] // The Windows and Linux arms of `platform_sink` use it.
    pub fn hidden_until_proven(platform: &str) -> Self {
        Self {
            reason: format!("Videorc Camera isn't available on {platform} yet."),
            hidden: true,
        }
    }
}

/// The sink for this platform, or why there is none. Never a silent stub.
///
/// Windows (C) and Linux (D) land hidden and flip to their sink once each
/// machine passes its spike: `if PROVEN { sink() } else { hidden_until_proven(..) }`.
pub fn platform_sink() -> Result<Box<dyn VirtualCameraSink>, VirtualCameraUnavailable> {
    // `cargo test` on a Mac with the extension installed must never start
    // its sink stream: a unit test that turns the switch on gets no sink,
    // and a test that wants one injects a fake through
    // `VirtualCameraService::with_sink_factory`. The lab aids that do touch
    // CoreMediaIO are `#[ignore]` and build their transport directly.
    if cfg!(test) {
        return Err(VirtualCameraUnavailable::new(
            "Videorc Camera isn't available in unit tests (the sink is injected).",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(crate::virtual_camera_macos::CmioSink::system()))
    }
    #[cfg(target_os = "windows")]
    {
        Err(VirtualCameraUnavailable::hidden_until_proven("Windows"))
    }
    #[cfg(target_os = "linux")]
    {
        if crate::virtual_camera_linux::PROVEN {
            crate::virtual_camera_linux::sink()
        } else {
            Err(VirtualCameraUnavailable::hidden_until_proven("Linux"))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err(VirtualCameraUnavailable::new(
            "Videorc Camera isn't available on this platform.",
        ))
    }
}

// ---------------------------------------------------------------------------
// Pixel demand (A2)
// ---------------------------------------------------------------------------

/// A2: the compositor composes CPU pixels for the metadata-only preview
/// while this is held (one count per holder). The camera holds it only
/// while a viewer holds the camera (D13).
#[derive(Debug, Clone, Default)]
pub struct PixelDemand(Arc<AtomicU32>);

#[allow(dead_code)] // `new`, `demanded` and `count` serve tests and Health.
impl PixelDemand {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn from_counter(counter: Arc<AtomicU32>) -> Self {
        Self(counter)
    }

    pub fn hold(&self) -> PixelDemandGuard {
        self.0.fetch_add(1, Ordering::AcqRel);
        PixelDemandGuard(self.0.clone())
    }

    pub fn demanded(&self) -> bool {
        self.0.load(Ordering::Acquire) > 0
    }

    pub fn count(&self) -> u32 {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
pub struct PixelDemandGuard(Arc<AtomicU32>);

impl Drop for PixelDemandGuard {
    fn drop(&mut self) {
        let previous = self.0.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "pixel demand underflow");
    }
}

// ---------------------------------------------------------------------------
// Counters and the output's shared state
// ---------------------------------------------------------------------------

/// What the output did, for `framePipeline` and Health.
#[derive(Debug, Default)]
pub struct VirtualCameraCounters {
    pushed: AtomicU64,
    repeated: AtomicU64,
    dropped: AtomicU64,
    idle: AtomicU64,
    no_pixels: AtomicU64,
    convert_us_max: AtomicU64,
    push_errors: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VirtualCameraCountersSnapshot {
    pub pushed: u64,
    pub repeated: u64,
    pub dropped: u64,
    pub idle: u64,
    /// Ticks whose newest frame carried no pixels the output could read
    /// (the metadata-only preview before A2's demand reached the tick).
    pub no_pixels: u64,
    pub convert_us_max: u64,
    pub push_errors: u64,
}

impl VirtualCameraCounters {
    pub fn snapshot(&self) -> VirtualCameraCountersSnapshot {
        VirtualCameraCountersSnapshot {
            pushed: self.pushed.load(Ordering::Relaxed),
            repeated: self.repeated.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            idle: self.idle.load(Ordering::Relaxed),
            no_pixels: self.no_pixels.load(Ordering::Relaxed),
            convert_us_max: self.convert_us_max.load(Ordering::Relaxed),
            push_errors: self.push_errors.load(Ordering::Relaxed),
        }
    }

    fn note_convert(&self, elapsed: Duration) {
        let micros = elapsed.as_micros().min(u128::from(u64::MAX)) as u64;
        self.convert_us_max.fetch_max(micros, Ordering::Relaxed);
    }
}

const VIEWERS_UNKNOWN: i64 = -1;
const VIEWERS_UNCHECKED: i64 = -2;

/// The sink's health as the engine last saw it, for the status line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SinkHealth {
    pub connected: bool,
    /// The last connect or push error, cleared by a successful connect.
    pub error: Option<String>,
}

/// State the output thread shares with the service: stop, counters, demand.
#[derive(Debug)]
pub struct OutputShared {
    stop: StdMutex<bool>,
    wake: Condvar,
    counters: VirtualCameraCounters,
    demanded: AtomicBool,
    viewers: AtomicI64,
    health: StdMutex<SinkHealth>,
    /// The output was dropped with the switch on (Videorc is quitting), not
    /// stopped by the switch: the sink disconnects "at exit".
    exiting: AtomicBool,
}

impl Default for OutputShared {
    fn default() -> Self {
        Self {
            stop: StdMutex::new(false),
            wake: Condvar::new(),
            counters: VirtualCameraCounters::default(),
            demanded: AtomicBool::new(false),
            viewers: AtomicI64::new(VIEWERS_UNCHECKED),
            health: StdMutex::new(SinkHealth::default()),
            exiting: AtomicBool::new(false),
        }
    }
}

impl OutputShared {
    pub fn counters(&self) -> &VirtualCameraCounters {
        &self.counters
    }

    /// Whether a viewer holds the camera as of the last check (D13).
    pub fn demanded(&self) -> bool {
        self.demanded.load(Ordering::Acquire)
    }

    /// The sink's viewer count: `None` while unknown or unchecked.
    pub fn viewers(&self) -> Option<u32> {
        u32::try_from(self.viewers.load(Ordering::Acquire)).ok()
    }

    pub fn health(&self) -> SinkHealth {
        self.health
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_health(&self, health: SinkHealth) {
        *self
            .health
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = health;
    }

    /// Sleep until `deadline` or a stop. Returns true when stopping.
    fn wait_until(&self, deadline: Instant) -> bool {
        let mut stop = self
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if *stop {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (guard, _) = self
                .wake
                .wait_timeout(stop, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            stop = guard;
        }
    }

    fn request_stop(&self) {
        *self
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.wake.notify_all();
    }
}

// ---------------------------------------------------------------------------
// The output engine
// ---------------------------------------------------------------------------

/// Which store the camera reads this tick: the glue re-picks
/// `presented_frame_store` every call (the hold or the program leg can
/// appear mid-run); `None` keeps the last store (the compositor lock was
/// busy, or no run exists).
pub type StorePicker = Box<dyn FnMut() -> Option<CompositorFrameStore> + Send>;

/// What one tick did, for tests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickOutcome {
    /// The sink is not connected or no viewer holds the camera.
    Skipped,
    /// The newest frame carries no pixels this output can read.
    NoPixels,
    Pushed,
    Repeated,
    Dropped,
    Idle,
    /// The sink refused the push; `disconnected` sinks reconnect later.
    Failed,
}

/// The output's loop body, tick by tick, with the clock outside (the thread
/// below drives it; tests drive it directly).
pub struct OutputEngine {
    sink: Box<dyn VirtualCameraSink>,
    picker: StorePicker,
    pixel_demand: PixelDemand,
    shared: Arc<OutputShared>,
    fps: u32,
    cadence: Cadence,
    cpu: CpuFit,
    last_store: Option<CompositorFrameStore>,
    demand_guard: Option<PixelDemandGuard>,
    connected: bool,
    last_connect_attempt: Option<Instant>,
    last_viewer_check: Option<Instant>,
    tick: u64,
    /// The CPU planes hold a frame the sink was handed (repeats re-push it).
    cpu_frame_fit: Option<FitRect>,
}

impl OutputEngine {
    pub fn new(
        sink: Box<dyn VirtualCameraSink>,
        picker: StorePicker,
        pixel_demand: PixelDemand,
        shared: Arc<OutputShared>,
    ) -> Self {
        Self {
            sink,
            picker,
            pixel_demand,
            shared,
            fps: VIRTUAL_CAMERA_FPS,
            cadence: Cadence::default(),
            cpu: CpuFit::new(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT),
            last_store: None,
            demand_guard: None,
            connected: false,
            last_connect_attempt: None,
            last_viewer_check: None,
            tick: 0,
            cpu_frame_fit: None,
        }
    }

    #[cfg(test)]
    pub fn shared(&self) -> &Arc<OutputShared> {
        &self.shared
    }

    fn interval(&self) -> Duration {
        Duration::from_secs(1) / self.fps.max(1)
    }

    /// Re-read the viewer count every `VIEWER_CHECK_INTERVAL` (D13) and hold
    /// or release the pixel demand with it.
    fn refresh_demand(&mut self, now: Instant) {
        let due = self
            .last_viewer_check
            .is_none_or(|last| now.saturating_duration_since(last) >= VIEWER_CHECK_INTERVAL);
        if !due {
            return;
        }
        self.last_viewer_check = Some(now);
        let viewers = if self.connected {
            self.sink.viewers()
        } else {
            Some(0)
        };
        self.shared.viewers.store(
            viewers.map_or(VIEWERS_UNKNOWN, i64::from),
            Ordering::Release,
        );
        let demanded = viewers.is_none_or(|count| count > 0);
        self.shared.demanded.store(demanded, Ordering::Release);
        if demanded && self.demand_guard.is_none() {
            self.demand_guard = Some(self.pixel_demand.hold());
        } else if !demanded {
            self.demand_guard = None;
        }
    }

    fn ensure_connected(&mut self, now: Instant) {
        if self.connected {
            return;
        }
        let due = self
            .last_connect_attempt
            .is_none_or(|last| now.saturating_duration_since(last) >= CONNECT_RETRY_INTERVAL);
        if !due {
            return;
        }
        self.last_connect_attempt = Some(now);
        match self.sink.connect() {
            Ok(()) => {
                self.connected = true;
                self.cadence.reset();
                self.cpu_frame_fit = None;
                self.shared.set_health(SinkHealth {
                    connected: true,
                    error: None,
                });
                // A fresh connection is checked for viewers right away.
                self.last_viewer_check = None;
            }
            Err(error) => {
                self.shared.set_health(SinkHealth {
                    connected: false,
                    error: Some(error.message),
                });
            }
        }
    }

    fn note_push_result(
        &mut self,
        result: Result<VirtualCameraPush, VirtualCameraSinkError>,
        repeated: bool,
    ) -> TickOutcome {
        match result {
            Ok(VirtualCameraPush::Pushed) => {
                if repeated {
                    self.shared
                        .counters
                        .repeated
                        .fetch_add(1, Ordering::Relaxed);
                    TickOutcome::Repeated
                } else {
                    self.shared.counters.pushed.fetch_add(1, Ordering::Relaxed);
                    TickOutcome::Pushed
                }
            }
            Ok(VirtualCameraPush::Dropped) => {
                self.shared.counters.dropped.fetch_add(1, Ordering::Relaxed);
                TickOutcome::Dropped
            }
            Err(error) => {
                self.shared
                    .counters
                    .push_errors
                    .fetch_add(1, Ordering::Relaxed);
                if error.disconnected {
                    self.sink.disconnect();
                    self.connected = false;
                    self.cadence.reset();
                    self.cpu_frame_fit = None;
                    self.demand_guard = None;
                    self.shared.demanded.store(false, Ordering::Release);
                }
                self.shared.set_health(SinkHealth {
                    connected: self.connected,
                    error: Some(error.message),
                });
                TickOutcome::Failed
            }
        }
    }

    /// One tick at `now`: re-pick the store, decide, convert off the
    /// compositor tick, push. Never blocks on the compositor.
    pub fn tick(&mut self, now: Instant) -> TickOutcome {
        self.ensure_connected(now);
        self.refresh_demand(now);
        let pts = VirtualCameraPts::for_tick(self.tick, self.fps);
        self.tick = self.tick.saturating_add(1);
        if !self.connected || !self.shared.demanded() {
            return TickOutcome::Skipped;
        }
        if let Some(store) = (self.picker)() {
            self.last_store = Some(store);
        }
        let Some(store) = self.last_store.as_ref() else {
            self.shared.counters.idle.fetch_add(1, Ordering::Relaxed);
            return TickOutcome::Idle;
        };
        let latest = store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .latest();
        let latest_sequence = latest.as_ref().map(|frame| frame.sequence);
        match self.cadence.decide(latest_sequence) {
            TickAction::Idle => {
                self.shared.counters.idle.fetch_add(1, Ordering::Relaxed);
                TickOutcome::Idle
            }
            TickAction::Repeat => {
                // The same frame as last tick: push it again without converting.
                if let Some(fit) = self.cpu_frame_fit {
                    let frame = VirtualCameraFrame::I420 {
                        planes: &self.cpu.planes,
                        fit,
                    };
                    let result = self.sink.push(&frame, pts);
                    return self.note_push_result(result, true);
                }
                let Some(frame) = latest else {
                    self.shared.counters.idle.fetch_add(1, Ordering::Relaxed);
                    return TickOutcome::Idle;
                };
                self.push_gpu_frame(&frame, pts, true)
            }
            TickAction::Push => {
                let frame = latest.expect("a sequence came from a frame");
                if let Some(outcome) = self.try_push_gpu(&frame, pts) {
                    return outcome;
                }
                let cpu_yuv = matches!(
                    frame.pixel_format,
                    CompositorPixelFormat::Yuv420p {
                        export: CompositorFrameExportKind::CpuYuv420p
                    }
                );
                let view = cpu_yuv
                    .then(|| I420View::from_packed(&frame.bytes, frame.width, frame.height))
                    .flatten();
                let Some(view) = view else {
                    // Metadata only (no GPU, A2's demand not yet at the tick),
                    // or a format this output cannot read: nothing to show,
                    // and the cadence forgets it so the next pixels push.
                    self.cadence.reset();
                    self.shared
                        .counters
                        .no_pixels
                        .fetch_add(1, Ordering::Relaxed);
                    return TickOutcome::NoPixels;
                };
                let started = Instant::now();
                let fit = self.cpu.fit_into(&view);
                self.shared.counters.note_convert(started.elapsed());
                self.cpu_frame_fit = Some(fit);
                let frame = VirtualCameraFrame::I420 {
                    planes: &self.cpu.planes,
                    fit,
                };
                let result = self.sink.push(&frame, pts);
                self.note_push_result(result, false)
            }
        }
    }

    /// Push a GPU-backed frame when the compositor published one; `None`
    /// when this frame is not GPU-backed.
    fn try_push_gpu(
        &mut self,
        frame: &crate::frame_store::FrameHandle<
            CompositorPixelFormat,
            crate::compositor::CompositorFrameExportHandle,
        >,
        pts: VirtualCameraPts,
    ) -> Option<TickOutcome> {
        if !frame_is_gpu_backed(frame) {
            return None;
        }
        self.cpu_frame_fit = None;
        Some(self.push_gpu_frame(frame, pts, false))
    }

    fn push_gpu_frame(
        &mut self,
        frame: &crate::frame_store::FrameHandle<
            CompositorPixelFormat,
            crate::compositor::CompositorFrameExportHandle,
        >,
        pts: VirtualCameraPts,
        repeated: bool,
    ) -> TickOutcome {
        let fit = fit_rect(
            frame.width,
            frame.height,
            VIRTUAL_CAMERA_WIDTH,
            VIRTUAL_CAMERA_HEIGHT,
        );
        #[cfg(target_os = "macos")]
        if let Some(target) = frame.metadata.metal_target_pixel_buffer() {
            // The ring slot stays in flight until the sink's blit returns.
            let guard = target.begin_in_flight();
            let camera_frame = VirtualCameraFrame::MetalTarget {
                target: &target,
                source_width: frame.width,
                source_height: frame.height,
                fit,
            };
            let result = self.sink.push(&camera_frame, pts);
            drop(guard);
            return self.note_push_result(result, repeated);
        }
        if let Some(ticket) = frame.metadata.d3d11_texture_ticket() {
            let camera_frame = VirtualCameraFrame::D3d11Texture {
                ticket: &ticket,
                source_width: frame.width,
                source_height: frame.height,
                fit,
            };
            let result = self.sink.push(&camera_frame, pts);
            return self.note_push_result(result, repeated);
        }
        self.cadence.reset();
        self.shared
            .counters
            .no_pixels
            .fetch_add(1, Ordering::Relaxed);
        TickOutcome::NoPixels
    }

    fn shutdown(&mut self) {
        self.demand_guard = None;
        self.shared.demanded.store(false, Ordering::Release);
        if self.connected {
            if self.shared.exiting.load(Ordering::Acquire) {
                self.sink.disconnect_at_exit();
            } else {
                self.sink.disconnect();
            }
            self.connected = false;
        }
        self.shared.set_health(SinkHealth {
            connected: false,
            error: None,
        });
    }
}

fn frame_is_gpu_backed(
    frame: &crate::frame_store::FrameHandle<
        CompositorPixelFormat,
        crate::compositor::CompositorFrameExportHandle,
    >,
) -> bool {
    frame.metadata.has_metal_iosurface_target() || frame.metadata.has_d3d11_texture()
}

/// The running output: its thread, stopped and joined on drop.
pub struct VirtualCameraOutput {
    shared: Arc<OutputShared>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for VirtualCameraOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VirtualCameraOutput")
            .field("running", &self.thread.is_some())
            .finish()
    }
}

impl VirtualCameraOutput {
    /// Start the output on its own thread at the camera's cadence. While no
    /// viewer holds the camera (or the sink is disconnected) the thread
    /// wakes once a second instead of thirty times.
    pub fn spawn(mut engine: OutputEngine) -> std::io::Result<Self> {
        let shared = engine.shared.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-camera-output".to_string())
            .spawn(move || {
                let interval = engine.interval();
                let mut deadline = Instant::now();
                loop {
                    if engine.shared.wait_until(deadline) {
                        break;
                    }
                    let now = Instant::now();
                    let outcome = engine.tick(now);
                    deadline = if outcome == TickOutcome::Skipped {
                        now + VIEWER_CHECK_INTERVAL.min(CONNECT_RETRY_INTERVAL)
                    } else {
                        next_deadline(deadline, now, interval)
                    };
                }
                engine.shutdown();
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    pub fn shared(&self) -> &Arc<OutputShared> {
        &self.shared
    }

    /// The switch turned off: stop the thread and join it (at most one tick
    /// late). The sink disconnects as "off".
    pub fn stop(mut self) {
        self.stop_and_join();
    }

    fn stop_and_join(&mut self) {
        self.shared.request_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for VirtualCameraOutput {
    /// Dropped with the switch on: Videorc is quitting. `stop` joined the
    /// thread already when the switch turned off, and this is a no-op then.
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.shared.exiting.store(true, Ordering::Release);
        }
        self.stop_and_join();
    }
}

// ---------------------------------------------------------------------------
// Never list yourself (A5)
// ---------------------------------------------------------------------------

/// macOS: the extension's device, by its fixed `uniqueID`, with the exact
/// localized name as a belt.
pub fn is_videorc_camera_macos(unique_id: &str, localized_name: &str) -> bool {
    unique_id.eq_ignore_ascii_case(VIRTUAL_CAMERA_MACOS_DEVICE_UUID)
        || localized_name.trim() == VIRTUAL_CAMERA_NAME
}

/// Windows: the media source, by its CLSID when the symbolic link carries
/// it, and by the friendly-name prefix (Windows appends its own suffix).
pub fn is_videorc_camera_windows(symbolic_link: Option<&str>, friendly_name: &str) -> bool {
    let clsid = VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID.to_ascii_lowercase();
    symbolic_link.is_some_and(|link| link.to_ascii_lowercase().contains(&clsid))
        || friendly_name.trim().starts_with(VIRTUAL_CAMERA_NAME)
}

/// Linux: the loopback device, by its sysfs `name` (the `card_label`).
pub fn is_videorc_camera_linux(card_name: &str) -> bool {
    card_name.trim().trim_end_matches(':').trim() == VIRTUAL_CAMERA_LINUX_CARD_LABEL
}

/// Linux: the loopback node by its fixed number, for a saved id that names
/// it by path (`/dev/video42`).
pub fn is_videorc_camera_linux_path(device_path: &str) -> bool {
    let node = format!("video{VIRTUAL_CAMERA_LINUX_VIDEO_NR}");
    std::path::Path::new(device_path.trim())
        .file_name()
        .is_some_and(|name| name == node.as_str())
}

/// The FFmpeg avfoundation probe lists devices by name only.
pub fn is_videorc_camera_ffmpeg_name(name: &str) -> bool {
    name.trim() == VIRTUAL_CAMERA_NAME
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// What the status rule reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusInputs {
    pub on: bool,
    /// `Err` when this build has no sink for the platform; a hidden one
    /// (owner, 2026-11-03) reports `platformStep: unsupported`.
    pub sink: Result<(), VirtualCameraUnavailable>,
    /// What main reported for the platform (the extension's activation, the
    /// Windows setup step), with its message; `None` until it reports.
    pub platform: Option<(VirtualCameraPlatformStep, Option<String>)>,
    /// The sink's health as the output last saw it; `None` while off.
    pub health: Option<SinkHealth>,
    pub viewers: Option<u32>,
}

/// The one status every surface reads (A4): the switch, whether the camera
/// can run here, the state, the viewer count, the platform's step and plain
/// copy. A platform failure outranks the switch; `off` is only ever a
/// healthy camera that is off.
pub fn derive_status(inputs: &StatusInputs) -> VirtualCameraStatus {
    let platform_step = inputs.platform.as_ref().map(|(step, _)| *step);
    let platform_message = inputs
        .platform
        .as_ref()
        .and_then(|(_, message)| message.clone());
    let mut status = VirtualCameraStatus {
        on: inputs.on,
        available: true,
        state: VirtualCameraState::Off,
        viewers: None,
        platform_step,
        message: None,
    };
    if let Err(unavailable) = &inputs.sink {
        status.available = false;
        status.state = VirtualCameraState::Unavailable;
        status.message = Some(unavailable.reason.clone());
        if unavailable.hidden {
            // The UI hides the whole section exactly on `unsupported`.
            status.platform_step = Some(VirtualCameraPlatformStep::Unsupported);
        }
        return status;
    }
    match platform_step {
        Some(VirtualCameraPlatformStep::Failed | VirtualCameraPlatformStep::Unsupported) => {
            status.available = false;
            status.state = VirtualCameraState::Unavailable;
            status.message = platform_message
                .or_else(|| Some("Videorc Camera can't run on this computer.".to_string()));
            return status;
        }
        Some(VirtualCameraPlatformStep::NeedsSetup | VirtualCameraPlatformStep::SettingUp) => {
            status.state = VirtualCameraState::NeedsSetup;
            status.message = platform_message;
            return status;
        }
        Some(VirtualCameraPlatformStep::NeedsApproval | VirtualCameraPlatformStep::NeedsReboot) => {
            status.state = VirtualCameraState::NeedsApproval;
            status.message = platform_message;
            return status;
        }
        Some(VirtualCameraPlatformStep::Installing) => {
            status.state = VirtualCameraState::Installing;
            status.message = platform_message;
            return status;
        }
        Some(VirtualCameraPlatformStep::Ready) | None => {}
    }
    if !inputs.on {
        return status;
    }
    match &inputs.health {
        Some(SinkHealth {
            connected: true,
            error,
        }) => {
            status.viewers = inputs.viewers;
            // D13: a platform that cannot count viewers (Linux) counts as held.
            status.state = if inputs.viewers.is_none_or(|count| count > 0) {
                VirtualCameraState::Streaming
            } else {
                VirtualCameraState::Ready
            };
            status.message = error.clone();
        }
        Some(SinkHealth {
            connected: false,
            error: Some(error),
        }) => {
            status.state = VirtualCameraState::Unavailable;
            status.message = Some(error.clone());
        }
        // On, but the sink has not connected yet (or the output is starting).
        Some(SinkHealth {
            connected: false,
            error: None,
        })
        | None => {
            status.state = VirtualCameraState::Installing;
            status.message = Some("Starting Videorc Camera…".to_string());
        }
    }
    status
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// What a fake sink saw from one push.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FakePush {
        pub kind: &'static str,
        pub pts: VirtualCameraPts,
        pub fit: Option<FitRect>,
        /// The luma at the canvas centre, for CPU pushes.
        pub centre_luma: Option<u8>,
    }

    #[derive(Debug, Default)]
    pub struct FakeSinkState {
        pub pushes: Vec<FakePush>,
        pub connects: u32,
        pub disconnects: u32,
        /// `disconnect_at_exit` calls (the output dropped, not stopped).
        pub exit_disconnects: u32,
        pub viewers: Option<u32>,
        pub connect_error: Option<String>,
        pub push_result: Option<Result<VirtualCameraPush, VirtualCameraSinkError>>,
    }

    pub struct FakeSink {
        pub state: Arc<StdMutex<FakeSinkState>>,
    }

    impl FakeSink {
        pub fn new(viewers: Option<u32>) -> (Self, Arc<StdMutex<FakeSinkState>>) {
            let state = Arc::new(StdMutex::new(FakeSinkState {
                viewers,
                ..FakeSinkState::default()
            }));
            (
                Self {
                    state: state.clone(),
                },
                state,
            )
        }
    }

    impl VirtualCameraSink for FakeSink {
        fn label(&self) -> &'static str {
            "fake"
        }

        fn connect(&mut self) -> Result<(), VirtualCameraSinkError> {
            let mut state = self.state.lock().unwrap();
            state.connects += 1;
            match state.connect_error.clone() {
                Some(message) => Err(VirtualCameraSinkError::disconnected(message)),
                None => Ok(()),
            }
        }

        fn disconnect(&mut self) {
            self.state.lock().unwrap().disconnects += 1;
        }

        fn disconnect_at_exit(&mut self) {
            self.state.lock().unwrap().exit_disconnects += 1;
        }

        fn push(
            &mut self,
            frame: &VirtualCameraFrame<'_>,
            pts: VirtualCameraPts,
        ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
            let mut state = self.state.lock().unwrap();
            let (fit, centre_luma) = match frame {
                VirtualCameraFrame::I420 { planes, fit } => {
                    let centre = (planes.height / 2) as usize * planes.width as usize
                        + (planes.width / 2) as usize;
                    (Some(*fit), Some(planes.y[centre]))
                }
                #[cfg(target_os = "macos")]
                VirtualCameraFrame::MetalTarget { fit, .. } => (Some(*fit), None),
                VirtualCameraFrame::D3d11Texture { fit, .. } => (Some(*fit), None),
            };
            state.pushes.push(FakePush {
                kind: frame.kind(),
                pts,
                fit,
                centre_luma,
            });
            state
                .push_result
                .clone()
                .unwrap_or(Ok(VirtualCameraPush::Pushed))
        }

        fn viewers(&self) -> Option<u32> {
            self.state.lock().unwrap().viewers
        }
    }

    /// An empty CPU I420 store (two spare buffers, like the compositor's).
    pub fn cpu_store() -> CompositorFrameStore {
        Arc::new(StdMutex::new(crate::frame_store::FrameStore::new(2)))
    }

    pub fn publish_cpu_frame(
        store: &CompositorFrameStore,
        sequence: u64,
        width: u32,
        height: u32,
        luma: u8,
    ) {
        let (y_len, uv_len) = plane_lens(width, height);
        let mut bytes = vec![luma; y_len];
        bytes.extend(std::iter::repeat_n(BLACK_UV, 2 * uv_len));
        store.lock().unwrap().publish_with_metadata(
            sequence,
            width,
            height,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            crate::compositor::CompositorFrameExportHandle::default(),
            Instant::now(),
            bytes,
        );
    }

    pub fn publish_metadata_only_frame(
        store: &CompositorFrameStore,
        sequence: u64,
        width: u32,
        height: u32,
    ) {
        store.lock().unwrap().publish_with_metadata(
            sequence,
            width,
            height,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            crate::compositor::CompositorFrameExportHandle::default(),
            Instant::now(),
            Vec::new(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    // --- geometry ---

    #[test]
    fn fit_rect_keeps_a_16_9_program_whole_and_pillarboxes_a_vertical_one() {
        assert_eq!(fit_rect(1920, 1080, 1920, 1080), FitRect::full(1920, 1080));
        assert_eq!(fit_rect(3840, 2160, 1920, 1080), FitRect::full(1920, 1080));
        assert_eq!(
            fit_rect(640, 360, 1920, 1080),
            FitRect::full(1920, 1080),
            "a small program scales up, never letterboxes"
        );
        // 1080×1920 → 607.5 px wide → 608 even, centred at 656.
        assert_eq!(
            fit_rect(1080, 1920, 1920, 1080),
            FitRect {
                x: 656,
                y: 0,
                width: 608,
                height: 1080
            }
        );
        // Wider than 16:9 letterboxes.
        assert_eq!(
            fit_rect(2560, 1080, 1920, 1080),
            FitRect {
                x: 0,
                y: 134,
                width: 1920,
                height: 810
            }
        );
        // 5:4 pillarboxes with even edges.
        let five_four = fit_rect(1280, 1024, 1920, 1080);
        assert_eq!((five_four.width, five_four.height), (1350, 1080));
        assert_eq!(five_four.x % 2, 0);
        assert_eq!(five_four.x, 284);
        // A degenerate source fills the canvas instead of dividing by zero.
        assert_eq!(fit_rect(0, 0, 1920, 1080), FitRect::full(1920, 1080));
    }

    #[test]
    fn fit_rect_edges_are_always_even_and_inside_the_canvas() {
        for (w, h) in [
            (1, 1),
            (3, 7),
            (17, 9),
            (1279, 721),
            (4096, 2160),
            (9, 4000),
        ] {
            let fit = fit_rect(w, h, 1920, 1080);
            assert_eq!(fit.x % 2, 0, "{w}x{h}");
            assert_eq!(fit.y % 2, 0, "{w}x{h}");
            assert_eq!(fit.width % 2, 0, "{w}x{h}");
            assert_eq!(fit.height % 2, 0, "{w}x{h}");
            assert!(fit.x + fit.width <= 1920, "{w}x{h}");
            assert!(fit.y + fit.height <= 1080, "{w}x{h}");
            assert!(fit.width >= 2 && fit.height >= 2, "{w}x{h}");
        }
    }

    // --- cadence and clock ---

    #[test]
    fn cadence_pushes_a_new_frame_once_and_repeats_it_until_the_next() {
        let mut cadence = Cadence::default();
        assert_eq!(cadence.decide(None), TickAction::Idle);
        assert_eq!(cadence.decide(Some(1)), TickAction::Push);
        assert_eq!(cadence.decide(Some(1)), TickAction::Repeat);
        assert_eq!(cadence.decide(Some(1)), TickAction::Repeat);
        assert_eq!(cadence.decide(Some(2)), TickAction::Push);
        // A store that went empty (a run restart) repeats the last frame.
        assert_eq!(cadence.decide(None), TickAction::Repeat);
        assert_eq!(cadence.decide(Some(2)), TickAction::Repeat);
        assert_eq!(cadence.decide(Some(5)), TickAction::Push);
        cadence.reset();
        assert_eq!(cadence.decide(None), TickAction::Idle);
        assert_eq!(cadence.decide(Some(5)), TickAction::Push);
    }

    #[test]
    fn the_clock_stays_on_the_grid_and_resyncs_when_far_behind() {
        let interval = Duration::from_millis(100);
        let start = Instant::now();
        // On time: the next deadline is one interval later, whatever `now`.
        assert_eq!(
            next_deadline(start, start + Duration::from_millis(5), interval),
            start + interval
        );
        // Slightly late (less than one interval): still on the grid.
        assert_eq!(
            next_deadline(start, start + Duration::from_millis(150), interval),
            start + interval
        );
        // More than one interval late: resync to now, no burst.
        let late = start + Duration::from_millis(450);
        assert_eq!(next_deadline(start, late, interval), late);
    }

    #[test]
    fn pts_advance_on_the_camera_clock() {
        assert_eq!(VirtualCameraPts::for_tick(0, 30).nanos, 0);
        assert_eq!(VirtualCameraPts::for_tick(30, 30).nanos, 1_000_000_000);
        assert_eq!(VirtualCameraPts::for_tick(1, 30).nanos, 33_333_333);
        assert_eq!(VirtualCameraPts::duration_nanos(30), 33_333_333);
    }

    // --- converters ---

    fn fixture_i420() -> I420Planes {
        // 4×2: luma 10..18, U 100,101, V 200,201 (one chroma row of two).
        I420Planes {
            width: 4,
            height: 2,
            y: vec![10, 11, 12, 13, 14, 15, 16, 17],
            u: vec![100, 101],
            v: vec![200, 201],
        }
    }

    #[test]
    fn i420_to_nv12_interleaves_chroma_after_the_luma_plane() {
        let planes = fixture_i420();
        let mut nv12 = Vec::new();
        i420_to_nv12(&planes.view(), &mut nv12);
        assert_eq!(
            nv12,
            vec![10, 11, 12, 13, 14, 15, 16, 17, 100, 200, 101, 201]
        );
        // A second call reuses the buffer (no growth).
        let capacity = nv12.capacity();
        i420_to_nv12(&planes.view(), &mut nv12);
        assert_eq!(nv12.capacity(), capacity);
    }

    #[test]
    fn i420_to_yuyv_packs_pixel_pairs_and_shares_chroma_rows() {
        let planes = fixture_i420();
        let mut yuyv = Vec::new();
        i420_to_yuyv(&planes.view(), &mut yuyv);
        assert_eq!(
            yuyv,
            vec![
                10, 100, 11, 200, 12, 101, 13, 201, // row 0
                14, 100, 15, 200, 16, 101, 17, 201, // row 1 shares chroma row 0
            ]
        );
    }

    #[test]
    fn i420_to_yuyv_handles_an_odd_width_by_repeating_the_last_luma() {
        let planes = I420Planes {
            width: 3,
            height: 1,
            y: vec![1, 2, 3],
            u: vec![50, 51],
            v: vec![60, 61],
        };
        let mut yuyv = Vec::new();
        i420_to_yuyv(&planes.view(), &mut yuyv);
        assert_eq!(yuyv, vec![1, 50, 2, 60, 3, 51, 3, 61]);
    }

    #[test]
    fn packed_view_splits_the_compositor_buffer_and_refuses_a_short_one() {
        let planes = fixture_i420();
        let mut packed = planes.y.clone();
        packed.extend(&planes.u);
        packed.extend(&planes.v);
        let view = I420View::from_packed(&packed, 4, 2).unwrap();
        assert_eq!(view.y, &planes.y[..]);
        assert_eq!(view.u, &planes.u[..]);
        assert_eq!(view.v, &planes.v[..]);
        assert!(I420View::from_packed(&packed[..5], 4, 2).is_none());
        assert!(I420View::from_packed(&[], 4, 2).is_none());
    }

    #[test]
    fn cpu_fit_copies_a_same_size_program_and_centres_a_vertical_one_on_black() {
        let mut fit = CpuFit::new(16, 8);
        // Same size: every byte lands where it was.
        let same = I420Planes {
            width: 16,
            height: 8,
            y: (0..128).map(|i| i as u8).collect(),
            u: (0..32).map(|i| 100 + i as u8).collect(),
            v: (0..32).map(|i| 200 + i as u8).collect(),
        };
        assert_eq!(fit.fit_into(&same.view()), FitRect::full(16, 8));
        assert_eq!(fit.planes(), &same);

        // Vertical 4×8 into 16×8: 4 wide, centred at x=6, bars black.
        let vertical = I420Planes {
            width: 4,
            height: 8,
            y: vec![235; 32],
            u: vec![90; 16],
            v: vec![150; 16],
        };
        let rect = fit.fit_into(&vertical.view());
        assert_eq!(
            rect,
            FitRect {
                x: 6,
                y: 0,
                width: 4,
                height: 8
            }
        );
        let planes = fit.planes();
        for row in 0..8usize {
            for x in 0..16usize {
                let expected = if (6..10).contains(&x) { 235 } else { BLACK_Y };
                assert_eq!(planes.y[row * 16 + x], expected, "row {row} x {x}");
            }
        }
        for row in 0..4usize {
            for x in 0..8usize {
                let (eu, ev) = if (3..5).contains(&x) {
                    (90, 150)
                } else {
                    (BLACK_UV, BLACK_UV)
                };
                assert_eq!(planes.u[row * 8 + x], eu, "u row {row} x {x}");
                assert_eq!(planes.v[row * 8 + x], ev, "v row {row} x {x}");
            }
        }
    }

    #[test]
    fn cpu_fit_scales_a_small_program_up_with_a_smooth_ramp() {
        let mut fit = CpuFit::new(16, 8);
        // 8×4 with a horizontal luma ramp 0, 32, 64, ... 224.
        let small = I420Planes {
            width: 8,
            height: 4,
            y: (0..32).map(|i| ((i % 8) * 32) as u8).collect(),
            u: vec![128; 8],
            v: vec![128; 8],
        };
        assert_eq!(fit.fit_into(&small.view()), FitRect::full(16, 8));
        let row = &fit.planes().y[..16];
        // Monotonic ramp from 0 toward 224 with interpolated steps.
        assert!(row.windows(2).all(|pair| pair[0] <= pair[1]), "{row:?}");
        assert_eq!(row[0], 0);
        assert_eq!(row[15], 224);
        assert!(row[1] > 0 && row[1] < 32, "{row:?}");
    }

    #[test]
    fn axis_table_is_identity_at_one_to_one_and_clamps_at_the_edge() {
        assert!(AxisTable::new(8, 8).is_identity());
        let down = AxisTable::new(8, 4);
        assert!(!down.is_identity());
        assert!(down.index.iter().all(|i| *i < 8));
        let up = AxisTable::new(4, 8);
        assert_eq!(up.index[7], 3);
        assert_eq!(up.weight[7], 0, "the last sample never reads past the end");
    }

    // --- pixel demand ---

    #[test]
    fn pixel_demand_counts_holders_and_releases_on_drop() {
        let demand = PixelDemand::new();
        assert!(!demand.demanded());
        let a = demand.hold();
        let b = demand.hold();
        assert_eq!(demand.count(), 2);
        drop(a);
        assert!(demand.demanded());
        drop(b);
        assert!(!demand.demanded());
    }

    // --- the engine ---

    fn engine_with(
        sink: FakeSink,
        store: CompositorFrameStore,
        demand: &PixelDemand,
    ) -> OutputEngine {
        OutputEngine::new(
            Box::new(sink),
            Box::new(move || Some(store.clone())),
            demand.clone(),
            Arc::new(OutputShared::default()),
        )
    }

    #[test]
    fn a_fake_sink_sees_exactly_one_push_per_tick_and_repeats_are_counted() {
        let (sink, seen) = FakeSink::new(Some(1));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 120);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store.clone(), &demand);
        let t0 = Instant::now();
        assert_eq!(engine.tick(t0), TickOutcome::Pushed);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(33)),
            TickOutcome::Repeated
        );
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(66)),
            TickOutcome::Repeated
        );
        publish_cpu_frame(&store, 2, 16, 8, 200);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(99)),
            TickOutcome::Pushed
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.pushes.len(), 4, "one push per tick, repeats included");
        assert_eq!(seen.pushes[0].centre_luma, Some(120));
        assert_eq!(seen.pushes[1].centre_luma, Some(120));
        assert_eq!(seen.pushes[3].centre_luma, Some(200));
        assert_eq!(
            seen.pushes
                .iter()
                .map(|push| push.pts.tick)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "pts advance every tick on the camera clock"
        );
        assert!(seen.pushes.iter().all(|push| push.kind == "i420"));
        let counters = engine.shared().counters().snapshot();
        assert_eq!((counters.pushed, counters.repeated), (2, 2));
        assert!(demand.demanded(), "a viewer holds the camera: demand held");
    }

    #[test]
    fn the_store_is_re_picked_every_tick_so_the_hold_or_program_leg_appear_mid_run() {
        let (sink, seen) = FakeSink::new(Some(2));
        let primary = cpu_store();
        let program = cpu_store();
        publish_cpu_frame(&primary, 1, 16, 8, 50);
        publish_cpu_frame(&program, 2, 16, 8, 180);
        let which = Arc::new(AtomicBool::new(false));
        let picker = {
            let (primary, program, which) = (primary.clone(), program.clone(), which.clone());
            Box::new(move || {
                Some(if which.load(Ordering::Relaxed) {
                    program.clone()
                } else {
                    primary.clone()
                })
            })
        };
        let demand = PixelDemand::new();
        let mut engine = OutputEngine::new(
            Box::new(sink),
            picker,
            demand.clone(),
            Arc::new(OutputShared::default()),
        );
        let t0 = Instant::now();
        assert_eq!(engine.tick(t0), TickOutcome::Pushed);
        which.store(true, Ordering::Relaxed);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(33)),
            TickOutcome::Pushed
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.pushes[0].centre_luma, Some(50));
        assert_eq!(seen.pushes[1].centre_luma, Some(180));
    }

    #[test]
    fn a_metadata_only_frame_pushes_nothing_and_the_next_pixels_push() {
        let (sink, seen) = FakeSink::new(Some(1));
        let store = cpu_store();
        publish_metadata_only_frame(&store, 1, 16, 8);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store.clone(), &demand);
        let t0 = Instant::now();
        assert_eq!(engine.tick(t0), TickOutcome::NoPixels);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(33)),
            TickOutcome::NoPixels
        );
        publish_cpu_frame(&store, 2, 16, 8, 90);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(66)),
            TickOutcome::Pushed
        );
        assert_eq!(seen.lock().unwrap().pushes.len(), 1);
        assert_eq!(engine.shared().counters().snapshot().no_pixels, 2);
    }

    #[test]
    fn demand_is_held_only_while_a_viewer_holds_the_camera_rechecked_every_check_interval() {
        let (sink, seen) = FakeSink::new(Some(0));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store.clone(), &demand);
        let t0 = Instant::now();
        assert_eq!(
            engine.tick(t0),
            TickOutcome::Skipped,
            "no viewer: nothing pushed"
        );
        assert!(!demand.demanded());
        assert_eq!(engine.shared().viewers(), Some(0));
        // A viewer arrives; the count is re-read only after the check
        // interval (250 ms).
        seen.lock().unwrap().viewers = Some(1);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(200)),
            TickOutcome::Skipped
        );
        assert!(!demand.demanded());
        assert_eq!(
            engine.tick(t0 + VIEWER_CHECK_INTERVAL + Duration::from_millis(1)),
            TickOutcome::Pushed
        );
        assert!(demand.demanded());
        assert_eq!(engine.shared().viewers(), Some(1));
        // The viewer leaves: demand released at the next check.
        seen.lock().unwrap().viewers = Some(0);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(2002)),
            TickOutcome::Skipped
        );
        assert!(!demand.demanded());
        assert!(!engine.shared().demanded());
        assert_eq!(seen.lock().unwrap().pushes.len(), 1);
    }

    #[test]
    fn an_unknown_viewer_count_counts_as_demanded() {
        let (sink, _seen) = FakeSink::new(None);
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store, &demand);
        assert_eq!(engine.tick(Instant::now()), TickOutcome::Pushed);
        assert!(demand.demanded());
        assert_eq!(engine.shared().viewers(), None);
        assert!(engine.shared().demanded());
    }

    #[test]
    fn a_disconnecting_push_error_releases_demand_and_reconnects_a_second_later() {
        let (sink, seen) = FakeSink::new(Some(1));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store.clone(), &demand);
        let t0 = Instant::now();
        assert_eq!(engine.tick(t0), TickOutcome::Pushed);
        seen.lock().unwrap().push_result = Some(Err(VirtualCameraSinkError::disconnected(
            "The camera device went away.",
        )));
        publish_cpu_frame(&store, 2, 16, 8, 100);
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(33)),
            TickOutcome::Failed
        );
        assert!(!demand.demanded());
        assert_eq!(
            engine.shared().health(),
            SinkHealth {
                connected: false,
                error: Some("The camera device went away.".to_string())
            }
        );
        assert_eq!(seen.lock().unwrap().disconnects, 1);
        // Not yet a second since the last connect: still skipped.
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(66)),
            TickOutcome::Skipped
        );
        seen.lock().unwrap().push_result = None;
        assert_eq!(
            engine.tick(t0 + Duration::from_millis(1100)),
            TickOutcome::Pushed
        );
        assert_eq!(seen.lock().unwrap().connects, 2);
        assert!(demand.demanded());
        assert!(engine.shared().health().connected);
        assert_eq!(engine.shared().counters().snapshot().push_errors, 1);
    }

    #[test]
    fn a_sink_that_cannot_connect_reports_why_and_pushes_nothing() {
        let (sink, seen) = FakeSink::new(Some(1));
        seen.lock().unwrap().connect_error = Some("No Videorc Camera device.".to_string());
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store, &demand);
        assert_eq!(engine.tick(Instant::now()), TickOutcome::Skipped);
        assert_eq!(
            engine.shared().health(),
            SinkHealth {
                connected: false,
                error: Some("No Videorc Camera device.".to_string())
            }
        );
        assert!(!demand.demanded());
        assert!(seen.lock().unwrap().pushes.is_empty());
    }

    #[test]
    fn a_dropped_push_is_counted_not_failed() {
        let (sink, seen) = FakeSink::new(Some(1));
        seen.lock().unwrap().push_result = Some(Ok(VirtualCameraPush::Dropped));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let mut engine = engine_with(sink, store, &demand);
        assert_eq!(engine.tick(Instant::now()), TickOutcome::Dropped);
        assert_eq!(engine.shared().counters().snapshot().dropped, 1);
        assert!(engine.shared().health().connected);
    }

    #[test]
    fn the_output_thread_pushes_at_the_camera_cadence_and_stops_on_drop() {
        let (sink, seen) = FakeSink::new(Some(1));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let engine = engine_with(sink, store.clone(), &demand);
        let output = VirtualCameraOutput::spawn(engine).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().pushes.len() < 3 {
            assert!(
                Instant::now() < deadline,
                "the output never pushed three frames"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(demand.demanded());
        output.stop();
        assert!(!demand.demanded(), "stop releases the demand");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.disconnects, 1, "the switch turned off");
        assert_eq!(seen.exit_disconnects, 0);
        let counters = store.lock().unwrap().stats();
        assert!(counters.buffer_count >= 1);
    }

    /// D12: an output dropped with the switch on (Videorc quitting) tells
    /// the sink it is exiting, never that the camera is off.
    #[test]
    fn an_output_dropped_with_the_switch_on_disconnects_at_exit() {
        let (sink, seen) = FakeSink::new(Some(1));
        let store = cpu_store();
        publish_cpu_frame(&store, 1, 16, 8, 100);
        let demand = PixelDemand::new();
        let engine = engine_with(sink, store, &demand);
        let output = VirtualCameraOutput::spawn(engine).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().connects < 1 {
            assert!(Instant::now() < deadline, "the output never connected");
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(output);
        assert!(!demand.demanded(), "exit releases the demand");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.exit_disconnects, 1);
        assert_eq!(seen.disconnects, 0, "never off");
    }

    // --- never list yourself ---

    #[test]
    fn the_macos_filter_matches_the_fixed_uuid_and_the_exact_name() {
        assert!(is_videorc_camera_macos(
            VIRTUAL_CAMERA_MACOS_DEVICE_UUID,
            "Whatever"
        ));
        assert!(is_videorc_camera_macos(
            &VIRTUAL_CAMERA_MACOS_DEVICE_UUID.to_lowercase(),
            "x"
        ));
        assert!(is_videorc_camera_macos("other-id", "Videorc Camera"));
        assert!(!is_videorc_camera_macos("other-id", "Videorc Camera 2"));
        assert!(!is_videorc_camera_macos(
            "47B4B64B-7067-4B9C-AD2B-AE273A71F4B5",
            "FaceTime HD Camera"
        ));
        assert!(!is_videorc_camera_macos(
            "obs-virtual-cam",
            "OBS Virtual Camera"
        ));
    }

    #[test]
    fn the_windows_filter_matches_the_clsid_in_the_link_and_the_name_prefix() {
        assert!(is_videorc_camera_windows(
            Some(r"\\?\root#image#0000#{b629eebb-4b8e-4cab-a549-eb17570b1382}\global"),
            "Something"
        ));
        assert!(is_videorc_camera_windows(
            None,
            "Videorc Camera Windows Virtual Camera"
        ));
        assert!(is_videorc_camera_windows(None, "Videorc Camera"));
        assert!(!is_videorc_camera_windows(
            Some(r"\\?\usb#vid_046d&pid_085e#{e5323777-f976-4f5b-9b55-b94699c46e44}\global"),
            "Logitech BRIO"
        ));
        assert!(!is_videorc_camera_windows(
            None,
            "OBS Virtual Camera Windows Virtual Camera"
        ));
    }

    /// A5: a fixture list per platform, filtered as the listings filter.
    #[test]
    fn the_platform_listings_drop_videorc_camera_from_a_fixture_list() {
        let macos = [
            ("47B4B64B-7067-4B9C-AD2B-AE273A71F4B5", "FaceTime HD Camera"),
            (VIRTUAL_CAMERA_MACOS_DEVICE_UUID, "Videorc Camera"),
            ("obs-virtual-cam", "OBS Virtual Camera"),
            ("another-id", "Videorc Camera"),
        ];
        let kept = macos
            .iter()
            .filter(|(id, name)| !is_videorc_camera_macos(id, name))
            .map(|(_, name)| *name)
            .collect::<Vec<_>>();
        assert_eq!(kept, vec!["FaceTime HD Camera", "OBS Virtual Camera"]);

        let windows = [
            (
                Some(r"\\?\usb#vid_046d&pid_085e#{e5323777-f976-4f5b-9b55-b94699c46e44}\global"),
                "Logitech BRIO",
            ),
            (
                Some(r"\\?\root#image#0000#{B629EEBB-4B8E-4CAB-A549-EB17570B1382}\global"),
                "Videorc Camera Windows Virtual Camera",
            ),
            (None, "Videorc Camera Windows Virtual Camera"),
            (None, "OBS Virtual Camera"),
        ];
        let kept = windows
            .iter()
            .filter(|(link, name)| !is_videorc_camera_windows(*link, name))
            .map(|(_, name)| *name)
            .collect::<Vec<_>>();
        assert_eq!(kept, vec!["Logitech BRIO", "OBS Virtual Camera"]);
    }

    #[test]
    fn the_linux_filter_matches_the_card_label_and_the_fixed_node() {
        assert!(is_videorc_camera_linux("Videorc Camera"));
        assert!(is_videorc_camera_linux("Videorc Camera:\n"));
        assert!(!is_videorc_camera_linux("Videorc Camera 2"));
        assert!(!is_videorc_camera_linux("OBS Virtual Camera"));
        assert!(is_videorc_camera_linux_path("/dev/video42"));
        assert!(!is_videorc_camera_linux_path("/dev/video4"));
        assert!(!is_videorc_camera_linux_path(
            "/dev/v4l/by-id/usb-cam-video-index0"
        ));
        assert!(is_videorc_camera_ffmpeg_name("Videorc Camera"));
        assert!(!is_videorc_camera_ffmpeg_name("FaceTime HD Camera"));
    }

    // --- status ---

    /// The shared wire fixture: absent fields are omitted, never `null`, and
    /// the renderer's contract test reads the same file.
    #[test]
    fn virtual_camera_fixture_matches_the_backend_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/virtual-camera.json"
        ))
        .expect("protocol-fixtures/virtual-camera.json is valid JSON");
        let off = serde_json::to_value(VirtualCameraStatus::default()).unwrap();
        assert_eq!(off, fixture["off"]);
        assert_eq!(
            serde_json::to_string(&VirtualCameraStatus::default()).unwrap(),
            r#"{"on":false,"available":true,"state":"off"}"#,
            "no null fields"
        );
        let no_sink = derive_status(&StatusInputs {
            on: true,
            sink: Err(VirtualCameraUnavailable::new(
                fixture["unavailableNoSink"]["message"].as_str().unwrap(),
            )),
            ..inputs()
        });
        assert_eq!(
            serde_json::to_value(&no_sink).unwrap(),
            fixture["unavailableNoSink"]
        );
        // Owner, 2026-11-03: a hidden platform reports `unsupported` even
        // while off, so the UI shows no section at all.
        let hidden = derive_status(&StatusInputs {
            sink: Err(VirtualCameraUnavailable::hidden_until_proven("Windows")),
            ..inputs()
        });
        assert_eq!(
            serde_json::to_value(&hidden).unwrap(),
            fixture["unavailableHidden"]
        );
        let approval = derive_status(&StatusInputs {
            on: true,
            platform: Some((
                VirtualCameraPlatformStep::NeedsApproval,
                Some(
                    fixture["needsApproval"]["message"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                ),
            )),
            ..inputs()
        });
        assert_eq!(
            serde_json::to_value(&approval).unwrap(),
            fixture["needsApproval"]
        );
        let setup = derive_status(&StatusInputs {
            platform: Some((VirtualCameraPlatformStep::NeedsSetup, None)),
            ..inputs()
        });
        assert_eq!(serde_json::to_value(&setup).unwrap(), fixture["needsSetup"]);
        let connected = Some(SinkHealth {
            connected: true,
            error: None,
        });
        let ready = derive_status(&StatusInputs {
            on: true,
            platform: Some((VirtualCameraPlatformStep::Ready, None)),
            health: connected.clone(),
            viewers: Some(0),
            ..inputs()
        });
        assert_eq!(serde_json::to_value(&ready).unwrap(), fixture["ready"]);
        let streaming = derive_status(&StatusInputs {
            on: true,
            platform: Some((VirtualCameraPlatformStep::Ready, None)),
            health: connected.clone(),
            viewers: Some(2),
            ..inputs()
        });
        assert_eq!(
            serde_json::to_value(&streaming).unwrap(),
            fixture["streaming"]
        );
        let unknown_viewers = derive_status(&StatusInputs {
            on: true,
            health: connected,
            viewers: None,
            ..inputs()
        });
        assert_eq!(
            serde_json::to_value(&unknown_viewers).unwrap(),
            fixture["streamingUnknownViewers"]
        );
        let set: crate::protocol::VirtualCameraSetParams =
            serde_json::from_value(fixture["setParams"].clone()).unwrap();
        assert!(set.on);
        let report: crate::protocol::VirtualCameraPlatformReportParams =
            serde_json::from_value(fixture["platformReportParams"].clone()).unwrap();
        assert_eq!(report.platform_step, VirtualCameraPlatformStep::Failed);
        assert_eq!(
            report.message.as_deref(),
            Some("Move Videorc to the Applications folder.")
        );
        let bare: crate::protocol::VirtualCameraPlatformReportParams =
            serde_json::from_value(fixture["platformReportParamsBare"].clone()).unwrap();
        assert_eq!(bare.platform_step, VirtualCameraPlatformStep::Ready);
        assert!(bare.message.is_none());
        assert!(
            serde_json::from_value::<crate::protocol::VirtualCameraPlatformReportParams>(
                serde_json::json!({ "platformStep": "done" })
            )
            .is_err()
        );
        // Round trip through the wire shape, and an older payload without
        // the optional fields loads.
        for key in [
            "off",
            "unavailableNoSink",
            "unavailableHidden",
            "needsApproval",
            "needsSetup",
            "ready",
            "streaming",
            "streamingUnknownViewers",
        ] {
            let parsed: VirtualCameraStatus = serde_json::from_value(fixture[key].clone())
                .unwrap_or_else(|error| panic!("{key}: {error}"));
            assert_eq!(
                &serde_json::to_value(&parsed).unwrap(),
                &fixture[key],
                "{key}"
            );
        }
        assert!(
            serde_json::from_value::<VirtualCameraStatus>(fixture["rejected"][1].clone()).is_err(),
            "an unknown state never loads"
        );
    }

    fn inputs() -> StatusInputs {
        StatusInputs {
            on: false,
            sink: Ok(()),
            platform: None,
            health: None,
            viewers: None,
        }
    }

    #[test]
    fn status_is_off_when_healthy_and_off_and_unavailable_without_a_sink() {
        let off = derive_status(&inputs());
        assert_eq!(off.state, VirtualCameraState::Off);
        assert!(off.available && !off.on);
        assert!(off.message.is_none() && off.viewers.is_none());

        let no_sink = derive_status(&StatusInputs {
            on: true,
            sink: Err(VirtualCameraUnavailable::new("No sink here.")),
            ..inputs()
        });
        assert_eq!(no_sink.state, VirtualCameraState::Unavailable);
        assert!(!no_sink.available && no_sink.on);
        assert_eq!(no_sink.message.as_deref(), Some("No sink here."));
        assert!(no_sink.platform_step.is_none(), "shown, with the reason");
    }

    /// Owner, 2026-11-03: Windows and Linux code lands hidden until each
    /// machine passes its spike. Hidden outranks the switch and any platform
    /// report; a non-hidden unavailability keeps today's behaviour.
    #[test]
    fn a_hidden_platform_is_unsupported_on_and_off() {
        let hidden = VirtualCameraUnavailable::hidden_until_proven("Linux");
        assert_eq!(
            hidden.reason,
            "Videorc Camera isn't available on Linux yet."
        );
        assert!(hidden.hidden);
        assert!(!VirtualCameraUnavailable::new("x").hidden);
        for on in [false, true] {
            let status = derive_status(&StatusInputs {
                on,
                sink: Err(hidden.clone()),
                platform: Some((VirtualCameraPlatformStep::Ready, None)),
                ..inputs()
            });
            assert_eq!(status.on, on);
            assert!(!status.available);
            assert_eq!(status.state, VirtualCameraState::Unavailable);
            assert_eq!(
                status.platform_step,
                Some(VirtualCameraPlatformStep::Unsupported)
            );
            assert_eq!(status.message.as_deref(), Some(hidden.reason.as_str()));
        }
    }

    #[test]
    fn a_platform_report_outranks_the_switch() {
        let approval = derive_status(&StatusInputs {
            on: true,
            platform: Some((
                VirtualCameraPlatformStep::NeedsApproval,
                Some("Allow it in System Settings.".to_string()),
            )),
            health: Some(SinkHealth {
                connected: true,
                error: None,
            }),
            viewers: Some(1),
            ..inputs()
        });
        assert_eq!(approval.state, VirtualCameraState::NeedsApproval);
        assert_eq!(
            approval.platform_step,
            Some(VirtualCameraPlatformStep::NeedsApproval)
        );
        assert_eq!(
            approval.message.as_deref(),
            Some("Allow it in System Settings.")
        );
        assert!(approval.available);

        let failed = derive_status(&StatusInputs {
            on: false,
            platform: Some((VirtualCameraPlatformStep::Failed, None)),
            ..inputs()
        });
        assert_eq!(failed.state, VirtualCameraState::Unavailable);
        assert!(!failed.available);
        assert!(failed.message.is_some());

        let setup = derive_status(&StatusInputs {
            on: true,
            platform: Some((VirtualCameraPlatformStep::NeedsSetup, None)),
            ..inputs()
        });
        assert_eq!(setup.state, VirtualCameraState::NeedsSetup);

        let installing = derive_status(&StatusInputs {
            on: true,
            platform: Some((VirtualCameraPlatformStep::Installing, None)),
            ..inputs()
        });
        assert_eq!(installing.state, VirtualCameraState::Installing);
    }

    #[test]
    fn on_with_a_connected_sink_is_ready_then_streaming_with_a_viewer() {
        let ready = derive_status(&StatusInputs {
            on: true,
            platform: Some((VirtualCameraPlatformStep::Ready, None)),
            health: Some(SinkHealth {
                connected: true,
                error: None,
            }),
            viewers: Some(0),
            ..inputs()
        });
        assert_eq!(ready.state, VirtualCameraState::Ready);
        assert_eq!(ready.viewers, Some(0));
        assert!(ready.message.is_none());

        let streaming = derive_status(&StatusInputs {
            on: true,
            health: Some(SinkHealth {
                connected: true,
                error: None,
            }),
            viewers: Some(2),
            ..inputs()
        });
        assert_eq!(streaming.state, VirtualCameraState::Streaming);
        assert_eq!(streaming.viewers, Some(2));

        let starting = derive_status(&StatusInputs {
            on: true,
            ..inputs()
        });
        assert_eq!(starting.state, VirtualCameraState::Installing);
        assert!(starting.message.is_some());

        let broken = derive_status(&StatusInputs {
            on: true,
            health: Some(SinkHealth {
                connected: false,
                error: Some("No Videorc Camera device.".to_string()),
            }),
            ..inputs()
        });
        assert_eq!(broken.state, VirtualCameraState::Unavailable);
        assert!(
            broken.available,
            "the platform can run it; the sink can't right now"
        );
        assert_eq!(broken.message.as_deref(), Some("No Videorc Camera device."));
    }
}
