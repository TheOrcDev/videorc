//! Plan 260 S1.7 (ported from plan 220 S4.1d): the backend writes the
//! CPU preview ring, the program as whole BGRA frames over shared memory.
//!
//! This is preview route (d): the app maps one `videorc-preview-ring` and
//! draws the newest frame (`videorc-preview`'s `cpu_frames.rs` is the
//! reader). It is the backend half S0.2c measures on Windows, and the
//! producer the Linux and macOS readers open.
//!
//! - **Which frames.** The program frame the Preview would show
//!   (`presented_frame_store`: the hold, the program leg, the backstop, the
//!   primary). Where the compositor composes on the CPU (Linux; Windows
//!   without the D3D11 path) the frame is I420 and is converted here. On
//!   macOS the Metal compositor's target is BGRA already and is copied
//!   straight into the slot. A Windows session on the D3D11 media path keeps
//!   its frames on the GPU (`D3d11Bgra8`/`D3d11Nv12`): the ring counts them
//!   as frames without pixels; routes (a) and (b) serve that session.
//! - **Pixels on demand.** The metadata-only preview (no GPU compositor)
//!   composes nothing while nobody reads; an open ring holds the
//!   compositor's `PixelDemand` (plan 214's counter) so every tick composes,
//!   exactly as Videorc Camera does, and releases it on close.
//! - **Off the compositor's tick.** The tick only notifies; this module's
//!   thread re-picks the store, writes the newest frame into a free slot and
//!   publishes it, latest wins. A slow reader or a slow conversion costs the
//!   recording nothing: the tick never waits on this thread, and the frame
//!   handle it holds is the store's own retained `Arc`.
//! - **The contracts the reader expects.** The reader leases the frame it
//!   draws (`reader_lease`); the writer never touches that slot or the
//!   latest one. A new frame size is a new ring with the next `generation`;
//!   the old one is retired (its reader wakes and asks again) and its memory
//!   stays open for [`RETIRED_GRACE`]. The first frame with pixels creates
//!   the first ring; until then the status says the ring is waiting for one,
//!   which is what the reader's first-frame contract reads.
//! - **Socket-owned.** `preview.cpu.open` and `preview.cpu.close` run inside
//!   the admin socket's loop like the frame leases and the Windows
//!   hand-over, so a client that goes away takes the ring with it;
//!   `preview.cpu.status` is a plain observation.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use videorc_preview_ring::{DEFAULT_SLOTS, RingWriter};
use videorc_protocol::{PreviewCpuRing, PreviewCpuRingStatus};

use crate::backend_authority::BackendRole;
use crate::compositor::{CompositorFrameStore, CompositorPixelFormat};
use crate::protocol::{ClientCommand, ServerResponse};
use crate::state::AppState;
use crate::virtual_camera::{PixelDemand, PixelDemandGuard};

/// How long the writer sleeps without a tick before looking again (a
/// stopped compositor, or a missed notify).
const IDLE_WAIT: Duration = Duration::from_millis(250);

/// Which store the writer reads each tick (the virtual camera's picker).
pub type StorePicker = Box<dyn FnMut() -> Option<CompositorFrameStore> + Send>;

/// Counters the status reads; the thread writes them.
#[derive(Debug, Default)]
struct Counters {
    rings_created: AtomicU64,
    frames_written: AtomicU64,
    frames_idle: AtomicU64,
    frames_without_pixels: AtomicU64,
    frames_skipped: AtomicU64,
    convert_us_last: AtomicU64,
    convert_us_max: AtomicU64,
    last_source_sequence: AtomicU64,
}

/// The thread's shared state: the stop flag, the tick's wake and the ring
/// the app should map now.
#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    ticked: StdMutex<bool>,
    tick: Condvar,
    ring: StdMutex<Option<PreviewCpuRing>>,
    counters: Counters,
}

impl Shared {
    fn wake(&self) {
        // Never block the compositor: a busy flag means the thread is about
        // to look anyway.
        if let Ok(mut ticked) = self.ticked.try_lock() {
            *ticked = true;
            self.tick.notify_one();
        }
    }

    /// Waits for a tick, the stop, or `IDLE_WAIT`.
    fn wait_tick(&self) {
        let mut ticked = self
            .ticked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*ticked && !self.stop.load(Ordering::Acquire) {
            let (guard, _) = self
                .tick
                .wait_timeout(ticked, IDLE_WAIT)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            ticked = guard;
        }
        *ticked = false;
    }
}

/// The running writer: its thread, stopped and joined on drop; the pixel
/// demand it holds goes with it.
struct Output {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
    /// The compositor's pixel demand (the preview's ring); none for a ring
    /// whose frames come from elsewhere (the playback's, `playback_cpu_ring`).
    _demand: Option<PixelDemandGuard>,
}

impl Drop for Output {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.wake();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// One per process, on `AppState`.
#[derive(Default)]
pub struct PreviewCpuRingService {
    output: StdMutex<Option<Output>>,
    /// The socket that opened the ring (its `owner` tag); a second socket's
    /// open is refused as busy.
    owner: StdMutex<Option<u64>>,
}

impl std::fmt::Debug for PreviewCpuRingService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreviewCpuRingService")
            .field("open", &self.is_open())
            .finish()
    }
}

/// What `open` answered with, for the socket's own guard.
pub struct PreviewCpuRingOwner {
    service: Arc<PreviewCpuRingService>,
    owner: u64,
}

impl Drop for PreviewCpuRingOwner {
    fn drop(&mut self) {
        self.service.close_for(self.owner);
    }
}

impl PreviewCpuRingService {
    pub fn is_open(&self) -> bool {
        self.output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// Opens the ring for `owner` (a socket's tag): the writer thread starts
    /// and holds pixel demand. A second open by the same owner answers the
    /// current status; another owner's is refused.
    pub fn open(
        self: &Arc<Self>,
        owner: u64,
        pixel_demand: PixelDemand,
        picker: StorePicker,
    ) -> Result<(PreviewCpuRingStatus, PreviewCpuRingOwner), String> {
        self.open_with(owner, Some(pixel_demand), picker)
    }

    /// [`Self::open`] for a ring whose frames come from a store something
    /// else fills (the playback's decoder): nothing is demanded of the
    /// compositor.
    pub fn open_without_demand(
        self: &Arc<Self>,
        owner: u64,
        picker: StorePicker,
    ) -> Result<(PreviewCpuRingStatus, PreviewCpuRingOwner), String> {
        self.open_with(owner, None, picker)
    }

    fn open_with(
        self: &Arc<Self>,
        owner: u64,
        pixel_demand: Option<PixelDemand>,
        picker: StorePicker,
    ) -> Result<(PreviewCpuRingStatus, PreviewCpuRingOwner), String> {
        {
            let mut current = self
                .owner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match *current {
                Some(existing) if existing != owner => {
                    return Err(
                        "another client holds the CPU preview ring; close it first".to_string()
                    );
                }
                Some(_) => {
                    return Ok((
                        self.status(),
                        PreviewCpuRingOwner {
                            service: self.clone(),
                            owner,
                        },
                    ));
                }
                None => *current = Some(owner),
            }
        }
        let shared = Arc::new(Shared::default());
        let demand = pixel_demand.map(|demand| demand.hold());
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-preview-ring".to_string())
            .spawn(move || Writer::new(thread_shared, picker).run())
            .map_err(|error| {
                *self
                    .owner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                format!("the CPU preview ring's writer thread did not start: {error}")
            })?;
        *self
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Output {
            shared,
            thread: Some(thread),
            _demand: demand,
        });
        Ok((
            self.status(),
            PreviewCpuRingOwner {
                service: self.clone(),
                owner,
            },
        ))
    }

    /// Closes the ring if `owner` holds it (the socket's guard, or its
    /// explicit close).
    pub fn close_for(&self, owner: u64) -> bool {
        let mine = {
            let mut current = self
                .owner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *current == Some(owner) {
                *current = None;
                true
            } else {
                false
            }
        };
        if !mine {
            return false;
        }
        let output = self
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        // Joins the thread outside the service lock.
        drop(output);
        true
    }

    /// The compositor's tick: wake the writer (never blocks).
    pub fn notify_frame(&self) {
        if let Ok(output) = self.output.try_lock()
            && let Some(output) = output.as_ref()
        {
            output.shared.wake();
        }
    }

    pub fn status(&self) -> PreviewCpuRingStatus {
        let output = self
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(output) = output.as_ref() else {
            return PreviewCpuRingStatus {
                open: false,
                message: Some(
                    "No CPU preview ring: no client has opened one (preview.cpu.open).".to_string(),
                ),
                ..PreviewCpuRingStatus::default()
            };
        };
        let counters = &output.shared.counters;
        let ring = output
            .shared
            .ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let last_sequence = counters.last_source_sequence.load(Ordering::Relaxed);
        PreviewCpuRingStatus {
            open: true,
            message: ring.is_none().then(|| {
                "CPU preview ring open: waiting for the first program frame with pixels."
                    .to_string()
            }),
            ring,
            rings_created: counters.rings_created.load(Ordering::Relaxed),
            frames_written: counters.frames_written.load(Ordering::Relaxed),
            frames_idle: counters.frames_idle.load(Ordering::Relaxed),
            frames_without_pixels: counters.frames_without_pixels.load(Ordering::Relaxed),
            frames_skipped: counters.frames_skipped.load(Ordering::Relaxed),
            convert_ms_last: counters.convert_us_last.load(Ordering::Relaxed) as f64 / 1000.0,
            convert_ms_max: counters.convert_us_max.load(Ordering::Relaxed) as f64 / 1000.0,
            last_source_sequence: (last_sequence > 0).then_some(last_sequence),
        }
    }
}

/// `preview.cpu.open` from the socket loop: the demand and the picker come
/// from the compositor runtime.
pub async fn open(
    state: &AppState,
    owner: u64,
) -> Result<(PreviewCpuRingStatus, PreviewCpuRingOwner), String> {
    let pixel_demand = crate::compositor::pixel_demand(state).await;
    let compositor = state.compositor.clone();
    let picker: StorePicker = Box::new(move || {
        compositor.try_lock().ok().map(|compositor| {
            crate::compositor::preview_frame_lease::presented_frame_store(&compositor)
        })
    });
    state.preview_cpu_ring.open(owner, pixel_demand, picker)
}

/// The compositor's tick, after a publish.
pub fn notify_frame(state: &AppState) {
    state.preview_cpu_ring.notify_frame();
}

/// A fresh owner tag for one socket (the ring's owner is the socket that
/// opened it; another socket's `preview.cpu.open` is refused as busy).
pub(crate) fn next_owner_tag() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// `preview.cpu.open` and `preview.cpu.close`, on the socket's own task (like
/// `preview_handover`): `None` for every other message. Main-process (admin)
/// credential only: the answer names shared memory another process maps.
pub(crate) async fn handle_preview_cpu_ring_control(
    state: &AppState,
    role: BackendRole,
    owner_tag: u64,
    owner: &mut Option<PreviewCpuRingOwner>,
    text: &str,
) -> Option<ServerResponse> {
    if !text.contains("preview.cpu.") {
        return None;
    }
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    if !matches!(
        command.method.as_str(),
        "preview.cpu.open" | "preview.cpu.close"
    ) {
        return None;
    }
    if role != BackendRole::Admin {
        return Some(ServerResponse::error(
            command.id,
            "forbidden",
            "The CPU preview ring requires the main-process credential.",
        ));
    }
    Some(if command.method == "preview.cpu.open" {
        if owner.is_some() {
            // This socket holds the ring already: answer its status. (A new
            // guard here would drop the held one and close the ring.)
            return Some(ServerResponse::ok(
                command.id,
                state.preview_cpu_ring.status(),
            ));
        }
        match open(state, owner_tag).await {
            Ok((status, guard)) => {
                *owner = Some(guard);
                ServerResponse::ok(command.id, status)
            }
            Err(message) => {
                ServerResponse::error(command.id, "preview-cpu-ring-unavailable", message)
            }
        }
    } else {
        let closed = owner.take().is_some();
        ServerResponse::ok(command.id, closed)
    })
}

/// The writer thread's state.
struct Writer {
    shared: Arc<Shared>,
    picker: StorePicker,
    last_store: Option<CompositorFrameStore>,
    last_sequence: Option<u64>,
    ring: Option<RingWriter>,
    /// Plan 220 S4.2c: rings replaced by a newer size stay open (retired)
    /// for [`RETIRED_GRACE`], so a reader that opens the old handle a moment
    /// late still finds the file and reads "retired" instead of ENOENT (a
    /// slot moving between windows changes size several times in a second).
    retired: Vec<(Instant, RingWriter)>,
    generation: u64,
}

/// How long a replaced ring's memory file stays open after its retirement.
const RETIRED_GRACE: Duration = Duration::from_secs(3);

impl Writer {
    fn new(shared: Arc<Shared>, picker: StorePicker) -> Self {
        Self {
            shared,
            picker,
            last_store: None,
            last_sequence: None,
            ring: None,
            retired: Vec::new(),
            generation: 0,
        }
    }

    fn run(mut self) {
        while !self.shared.stop.load(Ordering::Acquire) {
            self.tick();
            self.shared.wait_tick();
        }
        // The drop of the ring retires it, which wakes a waiting reader.
    }

    /// One look at the newest program frame.
    fn tick(&mut self) {
        self.retired
            .retain(|(retired_at, _)| retired_at.elapsed() < RETIRED_GRACE);
        if let Some(store) = (self.picker)() {
            let changed = self
                .last_store
                .as_ref()
                .is_none_or(|last| !Arc::ptr_eq(last, &store));
            if changed {
                self.last_sequence = None;
                self.last_store = Some(store);
            }
        }
        let Some(store) = self.last_store.as_ref() else {
            self.shared
                .counters
                .frames_idle
                .fetch_add(1, Ordering::Relaxed);
            return;
        };
        let latest = store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .latest();
        let Some(frame) = latest else {
            self.shared
                .counters
                .frames_idle
                .fetch_add(1, Ordering::Relaxed);
            return;
        };
        if self.last_sequence == Some(frame.sequence) {
            self.shared
                .counters
                .frames_idle
                .fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.last_sequence = Some(frame.sequence);
        let Some((source, width, height)) = FramePixels::of(&frame) else {
            self.shared
                .counters
                .frames_without_pixels
                .fetch_add(1, Ordering::Relaxed);
            return;
        };
        let ring_fits = self
            .ring
            .as_ref()
            .is_some_and(|ring| ring.info().width == width && ring.info().height == height);
        if !ring_fits && !self.replace_ring(width, height) {
            return;
        }
        let age = frame.captured_at.elapsed();
        let captured_at_micros =
            videorc_preview_ring::now_micros().saturating_sub(age.as_micros() as u64);
        let Some(ring) = self.ring.as_mut() else {
            return;
        };
        let Some(mut slot) = ring.begin() else {
            self.shared
                .counters
                .frames_skipped
                .fetch_add(1, Ordering::Relaxed);
            return;
        };
        let started = Instant::now();
        if !source.write_bgra(&frame, width, height, slot.pixels_mut()) {
            // The slot is dropped unpublished: the reader keeps the frame it
            // has, and the next tick tries again.
            self.shared
                .counters
                .frames_without_pixels
                .fetch_add(1, Ordering::Relaxed);
            return;
        }
        let convert_us = started.elapsed().as_micros() as u64;
        slot.publish(frame.sequence, captured_at_micros);
        let counters = &self.shared.counters;
        counters.frames_written.fetch_add(1, Ordering::Relaxed);
        counters
            .convert_us_last
            .store(convert_us, Ordering::Relaxed);
        counters
            .convert_us_max
            .fetch_max(convert_us, Ordering::Relaxed);
        counters
            .last_source_sequence
            .store(frame.sequence, Ordering::Relaxed);
    }

    /// A new ring for a new frame size; the old one retires (its reader
    /// wakes and asks for the new handle).
    fn replace_ring(&mut self, width: u32, height: u32) -> bool {
        self.generation += 1;
        match RingWriter::create(self.generation, width, height, DEFAULT_SLOTS) {
            Ok(ring) => {
                let info = *ring.info();
                let handle = ring.handle().clone();
                // The old ring retires now (its reader wakes and asks for
                // the new handle) and its file stays open for the grace.
                if let Some(old) = self.ring.replace(ring) {
                    old.retire();
                    self.retired.push((Instant::now(), old));
                }
                *self
                    .shared
                    .ring
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(PreviewCpuRing {
                    handle_kind: handle.kind.to_string(),
                    handle: handle.name,
                    bytes: handle.bytes,
                    pid: std::process::id(),
                    generation: info.generation,
                    slot_count: info.slot_count,
                    width: info.width,
                    height: info.height,
                    stride: info.stride,
                    pixel_format: "bgra8".to_string(),
                    header_bytes: info.header_bytes,
                    slot_offset: info.slot_offset,
                    slot_bytes: info.slot_bytes,
                });
                self.shared
                    .counters
                    .rings_created
                    .fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(error) => {
                eprintln!("[preview-cpu-ring] no ring for {width}x{height}: {error}");
                self.ring = None;
                *self
                    .shared
                    .ring
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                false
            }
        }
    }
}

type CompositorFrame = crate::frame_store::FrameHandle<
    CompositorPixelFormat,
    crate::compositor::CompositorFrameExportHandle,
>;

/// Where a program frame's pixels are, and the size the ring takes.
#[derive(Clone, Copy)]
enum FramePixels {
    /// The CPU compositor's I420 bytes (Linux; Windows off the D3D11 path).
    CpuI420,
    /// The Metal compositor's BGRA target (macOS).
    #[cfg(target_os = "macos")]
    MetalTarget,
}

impl FramePixels {
    /// `None` for a frame with no pixels to give: the metadata-only tick
    /// before pixel demand reached it, or a GPU-only frame (D3D11).
    fn of(frame: &CompositorFrame) -> Option<(Self, u32, u32)> {
        match frame.pixel_format {
            CompositorPixelFormat::Yuv420p {
                export: crate::compositor::CompositorFrameExportKind::CpuYuv420p,
            } => (frame.bytes.len() >= i420_len(frame.width, frame.height)
                && frame.width > 0
                && frame.height > 0)
                .then_some((Self::CpuI420, frame.width, frame.height)),
            #[cfg(target_os = "macos")]
            CompositorPixelFormat::Yuv420p {
                export: crate::compositor::CompositorFrameExportKind::MetalIosurfaceTarget { .. },
            } => {
                let target = frame.metadata.metal_target.as_ref()?;
                let width = u32::try_from(target.width()).ok()?;
                let height = u32::try_from(target.height()).ok()?;
                (width > 0 && height > 0).then_some((Self::MetalTarget, width, height))
            }
            _ => None,
        }
    }

    /// Writes the frame as BGRA rows into `dest`; `false` when it could not
    /// (the slot is then not published).
    fn write_bgra(self, frame: &CompositorFrame, width: u32, height: u32, dest: &mut [u8]) -> bool {
        match self {
            Self::CpuI420 => {
                yuv420p_to_bgra_into(width, height, &frame.bytes, dest);
                true
            }
            #[cfg(target_os = "macos")]
            Self::MetalTarget => frame
                .metadata
                .metal_target
                .as_ref()
                .is_some_and(|target| target.copy_bgra_into(dest)),
        }
    }
}

fn i420_len(width: u32, height: u32) -> usize {
    let width = width.max(1) as usize;
    let height = height.max(1) as usize;
    width * height + width.div_ceil(2) * height.div_ceil(2) * 2
}

// BT.709 video range, the compositor's `yuv420p_to_rgb` in 16.16 fixed point:
// R = 1.1644 (Y - 16) + 1.7927 (V - 128)
// G = 1.1644 (Y - 16) - 0.2132 (U - 128) - 0.5329 (V - 128)
// B = 1.1644 (Y - 16) + 2.1124 (U - 128)
const Y_SCALE: i32 = 76_309;
const R_CR: i32 = 117_489;
const G_CB: i32 = -13_975;
const G_CR: i32 = -34_925;
const B_CB: i32 = 138_438;
const ROUND: i32 = 1 << 15;

/// Converts one I420 frame into `dest`'s BGRA8 rows (`width * 4` bytes
/// each, at least `height` of them), within one level of the compositor's
/// float conversion. Plan 220 S4.2c: the rows go out in bands to a few
/// threads (`band_count`), and each row runs the AVX2 kernel where the CPU
/// has it, the scalar reference ([`yuv420p_to_bgra_row_scalar`]) for the
/// tail and everywhere else. The bytes are the reference's, bit for bit
/// (the tests prove it), so nothing downstream of the ring can tell.
pub(crate) fn yuv420p_to_bgra_into(width: u32, height: u32, src: &[u8], dest: &mut [u8]) {
    let (width, height) = (width as usize, height as usize);
    if width == 0 || height == 0 {
        return;
    }
    let chroma_width = width.div_ceil(2);
    let chroma_height = height.div_ceil(2);
    let luma_len = width * height;
    let chroma_len = chroma_width * chroma_height;
    if src.len() < luma_len + 2 * chroma_len || dest.len() < width * height * 4 {
        return;
    }
    let (luma, chroma) = src.split_at(luma_len);
    let (cb_plane, cr_plane) = chroma.split_at(chroma_len);
    let planes = Planes {
        width,
        height,
        chroma_width,
        luma,
        cb_plane,
        cr_plane,
    };
    let row_bytes = width * 4;
    let dest = &mut dest[..height * row_bytes];
    let bands = band_count(chroma_height);
    if bands <= 1 {
        convert_chroma_rows(&planes, 0, chroma_height, dest);
        return;
    }
    let band_chroma_rows = chroma_height.div_ceil(bands);
    std::thread::scope(|scope| {
        for (index, band) in dest
            .chunks_mut(band_chroma_rows * 2 * row_bytes)
            .enumerate()
        {
            let planes = &planes;
            let start = index * band_chroma_rows;
            let end = (start + band_chroma_rows).min(chroma_height);
            scope.spawn(move || convert_chroma_rows(planes, start, end, band));
        }
    });
}

/// The source planes of one frame.
struct Planes<'a> {
    width: usize,
    height: usize,
    chroma_width: usize,
    luma: &'a [u8],
    cb_plane: &'a [u8],
    cr_plane: &'a [u8],
}

/// How many bands a frame of `chroma_height` chroma rows is split into: one
/// for anything under 540 lines (the spawn would cost more than it saves),
/// else up to four, never more than the cores the box has.
fn band_count(chroma_height: usize) -> usize {
    if chroma_height < 270 {
        return 1;
    }
    let cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(1);
    cores.clamp(1, 4)
}

/// Converts chroma rows `start..end` (two luma rows each) into `out`, whose
/// first row is luma row `2 * start`.
fn convert_chroma_rows(planes: &Planes<'_>, start: usize, end: usize, out: &mut [u8]) {
    let row_bytes = planes.width * 4;
    #[cfg(target_arch = "x86_64")]
    let avx2 = std::arch::is_x86_feature_detected!("avx2");
    #[cfg(not(target_arch = "x86_64"))]
    let avx2 = false;
    for chroma_row in start..end {
        let cb_row = &planes.cb_plane
            [chroma_row * planes.chroma_width..(chroma_row + 1) * planes.chroma_width];
        let cr_row = &planes.cr_plane
            [chroma_row * planes.chroma_width..(chroma_row + 1) * planes.chroma_width];
        let top = chroma_row * 2;
        let rows = (planes.height - top).min(2);
        for row in top..top + rows {
            let luma_row = &planes.luma[row * planes.width..(row + 1) * planes.width];
            let out_row =
                &mut out[(row - 2 * start) * row_bytes..(row - 2 * start + 1) * row_bytes];
            let done = if avx2 {
                #[cfg(target_arch = "x86_64")]
                // SAFETY: the CPU reported AVX2 just above.
                unsafe {
                    yuv420p_to_bgra_row_avx2(luma_row, cb_row, cr_row, out_row)
                }
                #[cfg(not(target_arch = "x86_64"))]
                0
            } else {
                0
            };
            if done < planes.width {
                yuv420p_to_bgra_row_scalar(
                    &luma_row[done..],
                    &cb_row[done / 2..],
                    &cr_row[done / 2..],
                    &mut out_row[done * 4..],
                );
            }
        }
    }
}

/// The scalar reference for one row: one chroma sample per pixel pair, the
/// 16.16 fixed point above. S4.1d's conversion, row by row.
pub(crate) fn yuv420p_to_bgra_row_scalar(
    luma_row: &[u8],
    cb_row: &[u8],
    cr_row: &[u8],
    out_row: &mut [u8],
) {
    for (block, (out, luma_pair)) in out_row.chunks_mut(8).zip(luma_row.chunks(2)).enumerate() {
        let cb = i32::from(cb_row[block]) - 128;
        let cr = i32::from(cr_row[block]) - 128;
        let r_add = R_CR * cr + ROUND;
        let g_add = G_CB * cb + G_CR * cr + ROUND;
        let b_add = B_CB * cb + ROUND;
        for (pixel, &y) in out.chunks_mut(4).zip(luma_pair) {
            let luma_value = Y_SCALE * (i32::from(y) - 16);
            pixel[0] = ((luma_value + b_add) >> 16).clamp(0, 255) as u8;
            pixel[1] = ((luma_value + g_add) >> 16).clamp(0, 255) as u8;
            pixel[2] = ((luma_value + r_add) >> 16).clamp(0, 255) as u8;
            pixel[3] = 255;
        }
    }
}

/// The AVX2 kernel for one row: sixteen pixels (eight chroma samples) per
/// step, the same 32-bit integer arithmetic as the scalar reference (a
/// low-32 multiply, an arithmetic shift by 16, a clamp to 0..=255), so the
/// bytes are identical. Returns how many pixels it converted; the scalar
/// reference takes the tail.
///
/// # Safety
/// The CPU must have AVX2 (`is_x86_feature_detected!("avx2")`).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn yuv420p_to_bgra_row_avx2(
    luma_row: &[u8],
    cb_row: &[u8],
    cr_row: &[u8],
    out_row: &mut [u8],
) -> usize {
    use std::arch::x86_64::*;
    let pixels = luma_row.len().min(out_row.len() / 4);
    let blocks = pixels / 16;
    if blocks == 0 {
        return 0;
    }
    // The chroma rows cover `pixels.div_ceil(2)` samples; each block reads 8.
    debug_assert!(cb_row.len() >= blocks * 8 && cr_row.len() >= blocks * 8);
    // SAFETY (for every intrinsic below): the loads read 8 bytes at offsets
    // under the slices' lengths checked above, and the stores write 32 bytes
    // at offsets under `pixels * 4`.
    unsafe {
        let y_scale = _mm256_set1_epi32(Y_SCALE);
        let y_bias = _mm256_set1_epi32(16);
        let c_bias = _mm256_set1_epi32(128);
        let r_cr = _mm256_set1_epi32(R_CR);
        let g_cb = _mm256_set1_epi32(G_CB);
        let g_cr = _mm256_set1_epi32(G_CR);
        let b_cb = _mm256_set1_epi32(B_CB);
        let round = _mm256_set1_epi32(ROUND);
        let zero = _mm256_setzero_si256();
        let max = _mm256_set1_epi32(255);
        let alpha = _mm256_set1_epi32(0xFF00_0000_u32 as i32);
        // Each chroma sample serves two pixels: lanes a b c d e f g h become
        // a a b b c c d d for the first eight pixels, e e f f g g h h for
        // the next.
        let dup_lo = _mm256_setr_epi32(0, 0, 1, 1, 2, 2, 3, 3);
        let dup_hi = _mm256_setr_epi32(4, 4, 5, 5, 6, 6, 7, 7);
        for block in 0..blocks {
            let cb = _mm256_sub_epi32(
                _mm256_cvtepu8_epi32(_mm_loadl_epi64(
                    cb_row.as_ptr().add(block * 8) as *const __m128i
                )),
                c_bias,
            );
            let cr = _mm256_sub_epi32(
                _mm256_cvtepu8_epi32(_mm_loadl_epi64(
                    cr_row.as_ptr().add(block * 8) as *const __m128i
                )),
                c_bias,
            );
            let r_add = _mm256_add_epi32(_mm256_mullo_epi32(r_cr, cr), round);
            let g_add = _mm256_add_epi32(
                _mm256_add_epi32(_mm256_mullo_epi32(g_cb, cb), _mm256_mullo_epi32(g_cr, cr)),
                round,
            );
            let b_add = _mm256_add_epi32(_mm256_mullo_epi32(b_cb, cb), round);
            for (half, dup) in [dup_lo, dup_hi].into_iter().enumerate() {
                let first = block * 16 + half * 8;
                let r_add = _mm256_permutevar8x32_epi32(r_add, dup);
                let g_add = _mm256_permutevar8x32_epi32(g_add, dup);
                let b_add = _mm256_permutevar8x32_epi32(b_add, dup);
                let y = _mm256_mullo_epi32(
                    _mm256_sub_epi32(
                        _mm256_cvtepu8_epi32(_mm_loadl_epi64(
                            luma_row.as_ptr().add(first) as *const __m128i
                        )),
                        y_bias,
                    ),
                    y_scale,
                );
                let b = _mm256_max_epi32(
                    _mm256_min_epi32(_mm256_srai_epi32::<16>(_mm256_add_epi32(y, b_add)), max),
                    zero,
                );
                let g = _mm256_max_epi32(
                    _mm256_min_epi32(_mm256_srai_epi32::<16>(_mm256_add_epi32(y, g_add)), max),
                    zero,
                );
                let r = _mm256_max_epi32(
                    _mm256_min_epi32(_mm256_srai_epi32::<16>(_mm256_add_epi32(y, r_add)), max),
                    zero,
                );
                let pixel = _mm256_or_si256(
                    _mm256_or_si256(b, _mm256_slli_epi32::<8>(g)),
                    _mm256_or_si256(_mm256_slli_epi32::<16>(r), alpha),
                );
                _mm256_storeu_si256(out_row.as_mut_ptr().add(first * 4) as *mut __m256i, pixel);
            }
        }
    }
    blocks * 16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::FrameStore;
    use std::sync::Mutex as StdMutex;

    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (state >> 33) as u8
            })
            .collect()
    }

    #[test]
    fn the_fixed_point_conversion_matches_the_float_one_within_a_level() {
        for (width, height) in [(2, 2), (3, 3), (64, 36), (1920, 2)] {
            let src = noise(i420_len(width, height), u64::from(width * height));
            let rgb = crate::compositor::yuv420p_to_rgb(width, height, &src).unwrap();
            let mut bgra = vec![0_u8; width as usize * height as usize * 4];
            yuv420p_to_bgra_into(width, height, &src, &mut bgra);
            let mut worst = 0_u8;
            for (pixel, expected) in bgra.chunks(4).zip(rgb.chunks(3)) {
                assert_eq!(pixel[3], 255);
                worst = worst
                    .max(pixel[2].abs_diff(expected[0]))
                    .max(pixel[1].abs_diff(expected[1]))
                    .max(pixel[0].abs_diff(expected[2]));
            }
            assert!(worst <= 1, "{width}x{height}: {worst} levels off");
        }
    }

    /// The scalar reference, row by row on one thread: what S4.1d wrote.
    fn reference(width: u32, height: u32, src: &[u8]) -> Vec<u8> {
        let (width, height) = (width as usize, height as usize);
        let chroma_width = width.div_ceil(2);
        let chroma_height = height.div_ceil(2);
        let (luma, chroma) = src.split_at(width * height);
        let (cb_plane, cr_plane) = chroma.split_at(chroma_width * chroma_height);
        let mut out = vec![0_u8; width * height * 4];
        for row in 0..height {
            let chroma_row = row / 2;
            yuv420p_to_bgra_row_scalar(
                &luma[row * width..(row + 1) * width],
                &cb_plane[chroma_row * chroma_width..(chroma_row + 1) * chroma_width],
                &cr_plane[chroma_row * chroma_width..(chroma_row + 1) * chroma_width],
                &mut out[row * width * 4..(row + 1) * width * 4],
            );
        }
        out
    }

    /// Plan 220 S4.2c: the banded, AVX2 conversion writes the scalar
    /// reference's bytes, bit for bit, at every size that exercises a
    /// band split, an odd width or height, and a SIMD tail.
    #[test]
    fn the_fast_conversion_is_bit_identical_to_the_scalar_reference() {
        for (width, height) in [
            (2, 2),
            (3, 3),
            (17, 5),
            (33, 7),
            (64, 36),
            (640, 360),
            (1919, 1079),
            (1920, 1080),
            (1920, 1081),
        ] {
            let src = noise(
                i420_len(width, height),
                u64::from(width) * 7919 + u64::from(height),
            );
            let expected = reference(width, height, &src);
            let mut actual = vec![0xAA_u8; width as usize * height as usize * 4];
            yuv420p_to_bgra_into(width, height, &src, &mut actual);
            assert!(
                actual == expected,
                "{width}x{height}: the fast conversion differs from the scalar reference at byte {}",
                actual
                    .iter()
                    .zip(&expected)
                    .position(|(a, b)| a != b)
                    .unwrap_or(0)
            );
        }
        // The edge values too: every luma and chroma level at a width that
        // takes both the AVX2 path and the scalar tail.
        let (width, height) = (48, 2);
        let mut src = Vec::new();
        for level in 0..=255_u8 {
            src.clear();
            src.extend(std::iter::repeat_n(level, 96));
            src.extend(std::iter::repeat_n(255 - level, 24));
            src.extend(std::iter::repeat_n(level ^ 0x55, 24));
            let expected = reference(width, height, &src);
            let mut actual = vec![0_u8; 48 * 2 * 4];
            yuv420p_to_bgra_into(width, height, &src, &mut actual);
            assert_eq!(actual, expected, "level {level}");
        }
    }

    /// `VIDEORC_CONVERT_BENCH=1 cargo test … the_conversion_bench -- --nocapture`:
    /// the reference against the banded AVX2 conversion at 1080p, with the
    /// CPU clock the run saw (ogre throttles to 800 MHz after long compiles;
    /// the record names the clock beside every number).
    #[test]
    fn the_conversion_bench_when_asked() {
        if std::env::var("VIDEORC_CONVERT_BENCH").as_deref() != Ok("1") {
            return;
        }
        let (width, height) = (1920, 1080);
        let src = noise(i420_len(width, height), 42);
        let mut out = vec![0_u8; width as usize * height as usize * 4];
        let frames = 120;
        let clock = || {
            std::fs::read_to_string("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
                .ok()
                .and_then(|text| text.trim().parse::<u64>().ok())
                .map(|khz| format!("{:.2} GHz", khz as f64 / 1e6))
                .unwrap_or_else(|| "unknown clock".to_string())
        };
        let started = Instant::now();
        for _ in 0..frames {
            let _ = reference(width, height, &src);
        }
        let scalar_ms = started.elapsed().as_secs_f64() * 1000.0 / frames as f64;
        let started = Instant::now();
        for _ in 0..frames {
            yuv420p_to_bgra_into(width, height, &src, &mut out);
        }
        let fast_ms = started.elapsed().as_secs_f64() * 1000.0 / frames as f64;
        #[cfg(target_arch = "x86_64")]
        let avx2 = std::arch::is_x86_feature_detected!("avx2");
        #[cfg(not(target_arch = "x86_64"))]
        let avx2 = false;
        println!(
            "convert bench 1920x1080 over {frames} frames: scalar reference {scalar_ms:.2} ms/frame, banded AVX2 {fast_ms:.2} ms/frame ({} bands, avx2 {avx2}), clock {}",
            band_count(540),
            clock()
        );
    }

    #[test]
    fn a_short_source_or_destination_is_left_alone() {
        let mut dest = vec![7_u8; 16];
        yuv420p_to_bgra_into(2, 2, &[0; 5], &mut dest);
        assert!(dest.iter().all(|&byte| byte == 7));
        let mut short = vec![7_u8; 8];
        yuv420p_to_bgra_into(2, 2, &[128; 6], &mut short);
        assert!(short.iter().all(|&byte| byte == 7));
    }

    /// The shared wire fixture: absent fields are omitted, never `null`.
    #[test]
    fn the_wire_fixture_matches_the_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/preview-cpu-ring.json"
        ))
        .expect("protocol-fixtures/preview-cpu-ring.json is valid JSON");
        let closed = serde_json::to_value(PreviewCpuRingService::default().status()).unwrap();
        assert_eq!(closed, fixture["closed"]);
        let open = PreviewCpuRingStatus {
            open: true,
            ring: Some(PreviewCpuRing {
                handle_kind: "memfd-path".to_string(),
                handle: "/proc/4242/fd/17".to_string(),
                bytes: 4096 + 3 * 8_294_400,
                pid: 4242,
                generation: 1,
                slot_count: 3,
                width: 1920,
                height: 1080,
                stride: 7680,
                pixel_format: "bgra8".to_string(),
                header_bytes: 4096,
                slot_offset: 4096,
                slot_bytes: 8_294_400,
            }),
            rings_created: 1,
            frames_written: 300,
            frames_idle: 12,
            frames_without_pixels: 2,
            frames_skipped: 0,
            convert_ms_last: 1.8,
            convert_ms_max: 4.2,
            last_source_sequence: Some(314),
            message: None,
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            fixture["openWithRing"]
        );
        let round_trip: PreviewCpuRingStatus =
            serde_json::from_value(fixture["openWithRing"].clone()).unwrap();
        assert_eq!(round_trip, open);
    }

    #[test]
    fn the_status_names_the_absent_ring() {
        let service = PreviewCpuRingService::default();
        let status = service.status();
        assert!(!status.open);
        assert!(status.ring.is_none());
        assert!(status.message.unwrap().contains("No CPU preview ring"));
        assert!(!service.close_for(1));
    }

    #[test]
    fn the_writer_publishes_the_stores_cpu_frames_and_retires_on_close() {
        let store: CompositorFrameStore = Arc::new(StdMutex::new(FrameStore::new(2)));
        let (width, height) = (8_u32, 4_u32);
        let publish = |sequence: u64, fill: u8| {
            let bytes = vec![fill; i420_len(width, height)];
            store.lock().unwrap().publish(
                sequence,
                width,
                height,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                Instant::now(),
                bytes,
            );
        };
        publish(1, 128);
        let service = Arc::new(PreviewCpuRingService::default());
        let demand = PixelDemand::new();
        let picker_store = store.clone();
        let (status, owner) = service
            .open(
                7,
                demand.clone(),
                Box::new(move || Some(picker_store.clone())),
            )
            .unwrap();
        assert!(status.open);
        assert!(demand.demanded(), "an open ring demands pixels");
        // The thread's first tick runs at once; the ring appears with the
        // frame's size.
        let deadline = Instant::now() + Duration::from_secs(5);
        let ring = loop {
            if let Some(ring) = service.status().ring {
                break ring;
            }
            assert!(Instant::now() < deadline, "no ring within 5 s");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!((ring.width, ring.height, ring.stride), (8, 4, 32));
        assert_eq!(ring.pixel_format, "bgra8");
        let reader = videorc_preview_ring::RingReader::open(&videorc_preview_ring::RingHandle {
            kind: videorc_preview_ring::handle_kind(&ring.handle_kind).unwrap(),
            name: ring.handle.clone(),
            bytes: ring.bytes,
        })
        .unwrap();
        assert!(matches!(
            reader.wait_newer(0, Duration::from_secs(5)),
            videorc_preview_ring::Wait::NewFrame(1)
        ));
        {
            let leased = reader.lease_latest().unwrap();
            assert_eq!(leased.source_sequence, 1);
            // Y=U=V=128 is mid grey in video range: 1.1644*112 = 130.4.
            assert_eq!(&leased.pixels()[..4], &[130, 130, 130, 255]);
        }
        // A second frame wakes the thread through the tick notify.
        publish(2, 16);
        service.notify_frame();
        assert!(matches!(
            reader.wait_newer(1, Duration::from_secs(5)),
            videorc_preview_ring::Wait::NewFrame(2)
        ));
        {
            let leased = reader.lease_latest().unwrap();
            assert_eq!(leased.source_sequence, 2);
            // Y=U=V=16: black luma, chroma at -112 each: G = 0.2132*112 +
            // 0.5329*112 = 83.6 (the float reference rounds to 84).
            assert_eq!(&leased.pixels()[..4], &[0, 84, 0, 255]);
        }
        let status = service.status();
        assert_eq!(status.frames_written, 2);
        assert_eq!(status.rings_created, 1);
        assert_eq!(status.last_source_sequence, Some(2));
        // Another owner is refused; the same owner gets the status.
        let other = Arc::new(PixelDemand::new());
        assert!(
            service
                .open(8, (*other).clone(), Box::new(|| None))
                .is_err()
        );
        drop(owner);
        assert!(!service.is_open());
        assert!(!demand.demanded(), "the close released the pixel demand");
        assert!(matches!(
            reader.wait_newer(2, Duration::from_secs(5)),
            videorc_preview_ring::Wait::Retired
        ));
    }
}
