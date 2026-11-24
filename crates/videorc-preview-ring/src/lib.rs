//! Plan 220 S4.1d: the CPU preview's frames over shared memory.
//!
//! The backend composes the program on the CPU where no GPU compositor runs
//! (Linux; Windows without the D3D11 path). Until this slice the only way to
//! show those frames was the BMP poll over HTTP (`preview_bmp.rs`): one
//! encode and one copy per poll, 25 times a second. This crate is the
//! transport that replaces it for the Rust app: a ring of whole BGRA frames
//! in one shared memory region, written by the backend and mapped by the
//! app, where the latest frame wins and the reader leases the one frame it
//! is drawing so the writer never overwrites it underneath.
//!
//! - **The region** is a memory file: `memfd_create` on Linux, handed to
//!   the app as its `/proc/<pid>/fd/<n>` path (same user; the app opens it
//!   read-write for the lease word); a named file mapping on Windows. The
//!   platform halves are in `linux.rs` and `windows.rs`; everything about
//!   the layout and the protocol is here and runs on every platform (tests
//!   use a heap region).
//! - **The layout** (`Header`, `SlotHeader`) is little-endian, page-aligned,
//!   and carries its own dimensions, so a reader needs nothing but the
//!   handle. A new size is a new ring; the old one is marked `retired` and
//!   the reader asks the backend for the next handle.
//! - **The lease.** The reader publishes the frame id it holds
//!   (`reader_lease`). The writer never picks the latest slot or the leased
//!   one; the reader validates the slot after taking the lease and retries
//!   when the writer had already started on it. Both sides use sequentially
//!   consistent atomics for that handshake, so one of them always sees the
//!   other (the Dekker argument), and the pixels under a lease are never
//!   written.
//! - **The wake.** A futex on the header's `wake` word on Linux (a named
//!   event on Windows): the reader sleeps until the writer publishes, with
//!   a timeout, so an idle preview costs nothing and a live one needs no
//!   polling.
//!
//! The format is `bgra8`, row-major, top-down, `stride = width * 4`: what the
//! compositor's BMP route carried, what `wl_shm`'s ARGB8888 and X11's
//! ZPixmap are, and what Slint's wgpu image accepts (the vendored BGRA8
//! arm).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(not(any(target_os = "linux", windows)))]
mod unsupported;
#[cfg(not(any(target_os = "linux", windows)))]
use unsupported as platform;

/// The ring's magic, `VRCPUPRV` as little-endian bytes.
pub const MAGIC: u64 = u64::from_le_bytes(*b"VRCPUPRV");
/// The layout version; a reader refuses any other.
pub const VERSION: u32 = 1;
/// The header page; slot descriptors live inside it.
pub const HEADER_BYTES: usize = 4096;
/// Bytes per slot descriptor inside the header.
pub const SLOT_HEADER_BYTES: usize = 64;
/// Where the first slot descriptor starts in the header.
pub const SLOT_HEADERS_AT: usize = 256;
/// The most slots a ring may have (the descriptors must fit the header).
pub const MAX_SLOTS: u32 = ((HEADER_BYTES - SLOT_HEADERS_AT) / SLOT_HEADER_BYTES) as u32;
/// The slot count the backend uses: the latest, the leased, and one free.
pub const DEFAULT_SLOTS: u32 = 3;
/// The only pixel format of version 1.
pub const PIXEL_FORMAT_BGRA8: u32 = 1;
/// Page alignment of each slot (`mmap` and `wl_shm` want it).
const PAGE: usize = 4096;

/// Why `create` or `open` refused.
#[derive(Debug)]
pub enum RingError {
    Unsupported(&'static str),
    Io(std::io::Error),
    Dimensions(String),
    Layout(String),
}

impl std::fmt::Display for RingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RingError::Unsupported(what) => write!(
                f,
                "the CPU preview ring is Windows and Linux only (plan 220 S4.1d): {what}"
            ),
            RingError::Io(error) => write!(f, "{error}"),
            RingError::Dimensions(what) => {
                write!(f, "the ring's dimensions are out of range ({what})")
            }
            RingError::Layout(what) => write!(f, "{what}"),
        }
    }
}

impl std::error::Error for RingError {}

impl From<std::io::Error> for RingError {
    fn from(error: std::io::Error) -> Self {
        RingError::Io(error)
    }
}

/// What the app needs to map the ring: the platform's name for the region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingHandle {
    /// `memfd-path` (Linux: a `/proc/<pid>/fd/<n>` path) or `file-mapping`
    /// (Windows: a `Local\…` mapping name; the wake event is `<name>-wake`).
    pub kind: &'static str,
    pub name: String,
    /// The region's size in bytes (Windows maps by size; Linux checks it).
    pub bytes: u64,
}

/// The ring's geometry, from the header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingInfo {
    pub generation: u64,
    pub slot_count: u32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixel_format: u32,
    pub header_bytes: u64,
    pub slot_offset: u64,
    pub slot_bytes: u64,
    pub total_bytes: u64,
}

impl RingInfo {
    /// The layout for a frame size: slots page-aligned after the header.
    pub fn plan(
        generation: u64,
        width: u32,
        height: u32,
        slot_count: u32,
    ) -> Result<Self, RingError> {
        if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
            return Err(RingError::Dimensions(format!("{width}x{height}")));
        }
        if !(2..=MAX_SLOTS).contains(&slot_count) {
            return Err(RingError::Dimensions(format!("{slot_count} slots")));
        }
        let stride = width * 4;
        let frame_bytes = u64::from(stride) * u64::from(height);
        let slot_bytes = frame_bytes.div_ceil(PAGE as u64) * PAGE as u64;
        let slot_offset = HEADER_BYTES as u64;
        let total_bytes = slot_offset + slot_bytes * u64::from(slot_count);
        Ok(Self {
            generation,
            slot_count,
            width,
            height,
            stride,
            pixel_format: PIXEL_FORMAT_BGRA8,
            header_bytes: HEADER_BYTES as u64,
            slot_offset,
            slot_bytes,
            total_bytes,
        })
    }

    /// The bytes one frame uses inside its slot.
    pub fn frame_bytes(&self) -> usize {
        self.stride as usize * self.height as usize
    }

    pub fn slot_start(&self, slot: u32) -> usize {
        (self.slot_offset + self.slot_bytes * u64::from(slot)) as usize
    }
}

// Header field offsets (bytes). Fixed fields first, then the atomics.
const AT_MAGIC: usize = 0;
const AT_VERSION: usize = 8;
const AT_HEADER_BYTES: usize = 12;
const AT_SLOT_COUNT: usize = 16;
const AT_WIDTH: usize = 20;
const AT_HEIGHT: usize = 24;
const AT_STRIDE: usize = 28;
const AT_PIXEL_FORMAT: usize = 32;
const AT_SLOT_BYTES: usize = 40;
const AT_SLOT_OFFSET: usize = 48;
const AT_GENERATION: usize = 56;
const AT_LATEST_FRAME_ID: usize = 64;
const AT_LATEST_SLOT: usize = 72;
const AT_WAKE: usize = 76;
const AT_READER_LEASE: usize = 80;
const AT_RETIRED: usize = 88;
const AT_FRAMES_WRITTEN: usize = 96;
const AT_FRAMES_SKIPPED: usize = 104;
const AT_TOTAL_BYTES: usize = 112;
// Slot descriptor offsets (bytes, from the descriptor's start).
const SLOT_STATE: usize = 0;
const SLOT_FRAME_ID: usize = 8;
const SLOT_SOURCE_SEQUENCE: usize = 16;
const SLOT_CAPTURED_AT: usize = 24;
const SLOT_STATE_FREE: u32 = 0;
const SLOT_STATE_WRITING: u32 = 1;
const SLOT_STATE_READY: u32 = 2;

/// A mapped region: the platform's, or a heap buffer in tests.
pub(crate) trait Region: Send + Sync {
    fn ptr(&self) -> *mut u8;
    fn len(&self) -> usize;
}

/// The shared header and slot table over a region. All accesses go through
/// atomics on the mapped bytes; the fixed fields are written once by the
/// writer before anyone else can map the region.
struct Layout<R: Region> {
    region: R,
}

// SAFETY of the raw accesses below: every offset is inside the header page,
// which `plan` sizes and `create`/`open` map in full; each atomic sits at
// its natural alignment (the page is 4096-aligned, the offsets are multiples
// of 8 or 4); the mapping outlives the `Layout`.
impl<R: Region> Layout<R> {
    fn u32_at(&self, at: usize) -> &AtomicU32 {
        unsafe { AtomicU32::from_ptr(self.region.ptr().add(at).cast::<u32>()) }
    }

    fn u64_at(&self, at: usize) -> &AtomicU64 {
        unsafe { AtomicU64::from_ptr(self.region.ptr().add(at).cast::<u64>()) }
    }

    fn slot_u32(&self, slot: u32, at: usize) -> &AtomicU32 {
        self.u32_at(SLOT_HEADERS_AT + slot as usize * SLOT_HEADER_BYTES + at)
    }

    fn slot_u64(&self, slot: u32, at: usize) -> &AtomicU64 {
        self.u64_at(SLOT_HEADERS_AT + slot as usize * SLOT_HEADER_BYTES + at)
    }

    fn write_fixed(&self, info: &RingInfo) {
        self.u64_at(AT_MAGIC).store(MAGIC, Ordering::Relaxed);
        self.u32_at(AT_VERSION).store(VERSION, Ordering::Relaxed);
        self.u32_at(AT_HEADER_BYTES)
            .store(info.header_bytes as u32, Ordering::Relaxed);
        self.u32_at(AT_SLOT_COUNT)
            .store(info.slot_count, Ordering::Relaxed);
        self.u32_at(AT_WIDTH).store(info.width, Ordering::Relaxed);
        self.u32_at(AT_HEIGHT).store(info.height, Ordering::Relaxed);
        self.u32_at(AT_STRIDE).store(info.stride, Ordering::Relaxed);
        self.u32_at(AT_PIXEL_FORMAT)
            .store(info.pixel_format, Ordering::Relaxed);
        self.u64_at(AT_SLOT_BYTES)
            .store(info.slot_bytes, Ordering::Relaxed);
        self.u64_at(AT_SLOT_OFFSET)
            .store(info.slot_offset, Ordering::Relaxed);
        self.u64_at(AT_GENERATION)
            .store(info.generation, Ordering::Relaxed);
        self.u64_at(AT_TOTAL_BYTES)
            .store(info.total_bytes, Ordering::Relaxed);
        self.u64_at(AT_LATEST_FRAME_ID).store(0, Ordering::Relaxed);
        self.u32_at(AT_LATEST_SLOT)
            .store(u32::MAX, Ordering::Relaxed);
        self.u32_at(AT_WAKE).store(0, Ordering::Relaxed);
        self.u64_at(AT_READER_LEASE).store(0, Ordering::Relaxed);
        self.u32_at(AT_RETIRED).store(0, Ordering::Relaxed);
        self.u64_at(AT_FRAMES_WRITTEN).store(0, Ordering::Relaxed);
        self.u64_at(AT_FRAMES_SKIPPED).store(0, Ordering::Relaxed);
        for slot in 0..info.slot_count {
            self.slot_u32(slot, SLOT_STATE)
                .store(SLOT_STATE_FREE, Ordering::Relaxed);
            self.slot_u64(slot, SLOT_FRAME_ID)
                .store(0, Ordering::Relaxed);
            self.slot_u64(slot, SLOT_SOURCE_SEQUENCE)
                .store(0, Ordering::Relaxed);
            self.slot_u64(slot, SLOT_CAPTURED_AT)
                .store(0, Ordering::Relaxed);
        }
        std::sync::atomic::fence(Ordering::SeqCst);
    }

    /// Reads and validates the fixed fields of a region someone else wrote.
    fn read_fixed(&self) -> Result<RingInfo, RingError> {
        if self.region.len() < HEADER_BYTES {
            return Err(RingError::Layout(format!(
                "the region is {} bytes, shorter than the header",
                self.region.len()
            )));
        }
        std::sync::atomic::fence(Ordering::SeqCst);
        let magic = self.u64_at(AT_MAGIC).load(Ordering::Relaxed);
        if magic != MAGIC {
            return Err(RingError::Layout(format!(
                "not a preview ring (magic {magic:#018x})"
            )));
        }
        let version = self.u32_at(AT_VERSION).load(Ordering::Relaxed);
        if version != VERSION {
            return Err(RingError::Layout(format!(
                "preview ring version {version}; this reader speaks {VERSION}"
            )));
        }
        let info = RingInfo {
            generation: self.u64_at(AT_GENERATION).load(Ordering::Relaxed),
            slot_count: self.u32_at(AT_SLOT_COUNT).load(Ordering::Relaxed),
            width: self.u32_at(AT_WIDTH).load(Ordering::Relaxed),
            height: self.u32_at(AT_HEIGHT).load(Ordering::Relaxed),
            stride: self.u32_at(AT_STRIDE).load(Ordering::Relaxed),
            pixel_format: self.u32_at(AT_PIXEL_FORMAT).load(Ordering::Relaxed),
            header_bytes: u64::from(self.u32_at(AT_HEADER_BYTES).load(Ordering::Relaxed)),
            slot_offset: self.u64_at(AT_SLOT_OFFSET).load(Ordering::Relaxed),
            slot_bytes: self.u64_at(AT_SLOT_BYTES).load(Ordering::Relaxed),
            total_bytes: self.u64_at(AT_TOTAL_BYTES).load(Ordering::Relaxed),
        };
        let expected = RingInfo::plan(info.generation, info.width, info.height, info.slot_count)?;
        if info != expected || info.pixel_format != PIXEL_FORMAT_BGRA8 {
            return Err(RingError::Layout(
                "the ring's header does not describe a version 1 BGRA8 layout".to_string(),
            ));
        }
        if (self.region.len() as u64) < info.total_bytes {
            return Err(RingError::Layout(format!(
                "the region is {} bytes, the ring needs {}",
                self.region.len(),
                info.total_bytes
            )));
        }
        Ok(info)
    }

    fn slot_pixels(&self, info: &RingInfo, slot: u32) -> *mut u8 {
        unsafe { self.region.ptr().add(info.slot_start(slot)) }
    }
}

/// What the reader's wait ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// A frame newer than the one asked about is published.
    NewFrame(u64),
    Timeout,
    /// The writer retired this ring: ask for the next handle.
    Retired,
}

/// The writer's side: the backend's.
pub struct RingWriter {
    layout: Layout<platform::Mapping>,
    info: RingInfo,
    handle: RingHandle,
    next_frame_id: u64,
    wake: platform::Wake,
}

impl RingWriter {
    /// Creates a fresh ring for frames of `width` x `height` with
    /// `slot_count` slots. `generation` tells rings apart in the status.
    pub fn create(
        generation: u64,
        width: u32,
        height: u32,
        slot_count: u32,
    ) -> Result<Self, RingError> {
        let info = RingInfo::plan(generation, width, height, slot_count)?;
        let (mapping, handle, wake) = platform::create(&info)?;
        let layout = Layout { region: mapping };
        layout.write_fixed(&info);
        Ok(Self {
            layout,
            info,
            handle,
            next_frame_id: 1,
            wake,
        })
    }

    pub fn info(&self) -> &RingInfo {
        &self.info
    }

    pub fn handle(&self) -> &RingHandle {
        &self.handle
    }

    pub fn frames_written(&self) -> u64 {
        self.layout
            .u64_at(AT_FRAMES_WRITTEN)
            .load(Ordering::Relaxed)
    }

    pub fn frames_skipped(&self) -> u64 {
        self.layout
            .u64_at(AT_FRAMES_SKIPPED)
            .load(Ordering::Relaxed)
    }

    pub fn latest_frame_id(&self) -> u64 {
        self.layout
            .u64_at(AT_LATEST_FRAME_ID)
            .load(Ordering::Acquire)
    }

    /// The frame id the reader holds, 0 for none.
    pub fn reader_lease(&self) -> u64 {
        self.layout.u64_at(AT_READER_LEASE).load(Ordering::SeqCst)
    }

    /// Picks a slot that is neither the latest nor leased and marks it
    /// writing. `None` when every other slot is busy (counted as skipped);
    /// with three slots that cannot happen for one reader.
    pub fn begin(&mut self) -> Option<SlotWrite<'_>> {
        let latest_slot = self.layout.u32_at(AT_LATEST_SLOT).load(Ordering::Acquire);
        for slot in 0..self.info.slot_count {
            if slot == latest_slot {
                continue;
            }
            let state = self.layout.slot_u32(slot, SLOT_STATE);
            let frame_id = self.layout.slot_u64(slot, SLOT_FRAME_ID);
            let previous_state = state.load(Ordering::SeqCst);
            let previous_id = frame_id.load(Ordering::SeqCst);
            if previous_id != 0 && previous_id == self.reader_lease() {
                continue;
            }
            // Mark first, then look at the lease again (the Dekker pair with
            // the reader's lease-then-validate).
            state.store(SLOT_STATE_WRITING, Ordering::SeqCst);
            frame_id.store(0, Ordering::SeqCst);
            if previous_id != 0 && previous_id == self.reader_lease() {
                // The reader took it meanwhile: give it back untouched.
                frame_id.store(previous_id, Ordering::SeqCst);
                state.store(previous_state, Ordering::SeqCst);
                continue;
            }
            let frame_id_value = self.next_frame_id;
            return Some(SlotWrite {
                writer: self,
                slot,
                frame_id: frame_id_value,
            });
        }
        self.layout
            .u64_at(AT_FRAMES_SKIPPED)
            .fetch_add(1, Ordering::Relaxed);
        None
    }

    /// Marks the ring retired (a new size, or the writer going away) and
    /// wakes the reader so it asks for the next handle.
    pub fn retire(&self) {
        self.layout.u32_at(AT_RETIRED).store(1, Ordering::SeqCst);
        self.layout.u32_at(AT_WAKE).fetch_add(1, Ordering::SeqCst);
        self.wake.wake(self.layout.u32_at(AT_WAKE));
    }
}

impl Drop for RingWriter {
    fn drop(&mut self) {
        self.retire();
    }
}

/// One slot checked out for writing; `publish` makes it the latest frame.
pub struct SlotWrite<'a> {
    writer: &'a mut RingWriter,
    slot: u32,
    frame_id: u64,
}

impl SlotWrite<'_> {
    pub fn frame_id(&self) -> u64 {
        self.frame_id
    }

    /// The slot's pixels: `height` rows of `stride` bytes, BGRA8.
    pub fn pixels_mut(&mut self) -> &mut [u8] {
        let info = self.writer.info;
        // SAFETY: the slot is inside the mapping (`plan` sized it), marked
        // writing, neither latest nor leased, so no reader touches it.
        unsafe {
            std::slice::from_raw_parts_mut(
                self.writer.layout.slot_pixels(&info, self.slot),
                info.frame_bytes(),
            )
        }
    }

    /// Publishes the slot as the latest frame and wakes the reader.
    /// `captured_at_micros` is the frame's monotonic stamp (the reader
    /// measures its age with the same clock, `now_micros`).
    pub fn publish(self, source_sequence: u64, captured_at_micros: u64) -> u64 {
        let layout = &self.writer.layout;
        layout
            .slot_u64(self.slot, SLOT_SOURCE_SEQUENCE)
            .store(source_sequence, Ordering::Relaxed);
        layout
            .slot_u64(self.slot, SLOT_CAPTURED_AT)
            .store(captured_at_micros, Ordering::Relaxed);
        layout
            .slot_u64(self.slot, SLOT_FRAME_ID)
            .store(self.frame_id, Ordering::SeqCst);
        layout
            .slot_u32(self.slot, SLOT_STATE)
            .store(SLOT_STATE_READY, Ordering::SeqCst);
        layout
            .u32_at(AT_LATEST_SLOT)
            .store(self.slot, Ordering::SeqCst);
        layout
            .u64_at(AT_LATEST_FRAME_ID)
            .store(self.frame_id, Ordering::SeqCst);
        layout
            .u64_at(AT_FRAMES_WRITTEN)
            .fetch_add(1, Ordering::Relaxed);
        layout.u32_at(AT_WAKE).fetch_add(1, Ordering::SeqCst);
        self.writer.wake.wake(layout.u32_at(AT_WAKE));
        self.writer.next_frame_id += 1;
        self.frame_id
    }
}

/// The reader's side: the app's.
pub struct RingReader {
    layout: Layout<platform::Mapping>,
    info: RingInfo,
    wake: platform::Wake,
}

impl RingReader {
    /// Maps the ring the handle names and validates its header.
    pub fn open(handle: &RingHandle) -> Result<Self, RingError> {
        let (mapping, wake) = platform::open(handle)?;
        let layout = Layout { region: mapping };
        let info = layout.read_fixed()?;
        Ok(Self { layout, info, wake })
    }

    pub fn info(&self) -> &RingInfo {
        &self.info
    }

    pub fn retired(&self) -> bool {
        self.layout.u32_at(AT_RETIRED).load(Ordering::SeqCst) != 0
    }

    pub fn latest_frame_id(&self) -> u64 {
        self.layout
            .u64_at(AT_LATEST_FRAME_ID)
            .load(Ordering::SeqCst)
    }

    pub fn frames_written(&self) -> u64 {
        self.layout
            .u64_at(AT_FRAMES_WRITTEN)
            .load(Ordering::Relaxed)
    }

    /// Linux: the memory file's descriptor, for a consumer that hands the
    /// region to the display server itself (a `wl_shm` pool over the ring,
    /// an X11 shared segment): the slot's `offset` addresses the frame.
    #[cfg(target_os = "linux")]
    pub fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        self.layout.region.fd()
    }

    /// Sleeps until a frame newer than `after` is published, the ring is
    /// retired, or `timeout` passes.
    pub fn wait_newer(&self, after: u64, timeout: Duration) -> Wait {
        let wake = self.layout.u32_at(AT_WAKE);
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let seen = wake.load(Ordering::SeqCst);
            if self.retired() {
                return Wait::Retired;
            }
            let latest = self.latest_frame_id();
            if latest > after {
                return Wait::NewFrame(latest);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Wait::Timeout;
            }
            self.wake.wait(wake, seen, deadline - now);
        }
    }

    /// Leases the latest frame: the writer leaves its slot alone until the
    /// lease drops. `None` while no frame is published, or when the writer
    /// kept winning the race (it moves on; the next wait sees a newer one).
    pub fn lease_latest(&self) -> Option<LeasedFrame<'_>> {
        let lease = self.layout.u64_at(AT_READER_LEASE);
        for _ in 0..8 {
            let frame_id = self.latest_frame_id();
            if frame_id == 0 {
                return None;
            }
            let slot = self.layout.u32_at(AT_LATEST_SLOT).load(Ordering::SeqCst);
            if slot >= self.info.slot_count {
                return None;
            }
            lease.store(frame_id, Ordering::SeqCst);
            let state = self
                .layout
                .slot_u32(slot, SLOT_STATE)
                .load(Ordering::SeqCst);
            let slot_frame = self
                .layout
                .slot_u64(slot, SLOT_FRAME_ID)
                .load(Ordering::SeqCst);
            if state == SLOT_STATE_READY && slot_frame == frame_id {
                let source_sequence = self
                    .layout
                    .slot_u64(slot, SLOT_SOURCE_SEQUENCE)
                    .load(Ordering::Relaxed);
                let captured_at_micros = self
                    .layout
                    .slot_u64(slot, SLOT_CAPTURED_AT)
                    .load(Ordering::Relaxed);
                return Some(LeasedFrame {
                    reader: self,
                    slot,
                    frame_id,
                    source_sequence,
                    captured_at_micros,
                });
            }
            lease.store(0, Ordering::SeqCst);
        }
        None
    }
}

/// A frame the reader holds; the slot stays as it is until this drops.
pub struct LeasedFrame<'a> {
    reader: &'a RingReader,
    slot: u32,
    pub frame_id: u64,
    pub source_sequence: u64,
    pub captured_at_micros: u64,
}

impl LeasedFrame<'_> {
    pub fn width(&self) -> u32 {
        self.reader.info.width
    }

    pub fn height(&self) -> u32 {
        self.reader.info.height
    }

    pub fn stride(&self) -> u32 {
        self.reader.info.stride
    }

    /// The slot's index: a consumer that mapped the region itself (a
    /// `wl_shm` pool over the same file) addresses the slot by it.
    pub fn slot(&self) -> u32 {
        self.slot
    }

    pub fn offset(&self) -> usize {
        self.reader.info.slot_start(self.slot)
    }

    /// The frame's pixels: `height` rows of `stride` bytes, BGRA8.
    pub fn pixels(&self) -> &[u8] {
        let info = &self.reader.info;
        // SAFETY: the slot is inside the mapping and leased, so the writer
        // does not touch it while this borrow lives.
        unsafe {
            std::slice::from_raw_parts(
                self.reader.layout.slot_pixels(info, self.slot),
                info.frame_bytes(),
            )
        }
    }
}

impl Drop for LeasedFrame<'_> {
    fn drop(&mut self) {
        self.reader
            .layout
            .u64_at(AT_READER_LEASE)
            .store(0, Ordering::SeqCst);
    }
}

/// The monotonic clock both sides stamp frames with, in microseconds.
pub fn now_micros() -> u64 {
    platform::now_micros()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_pages_its_slots_and_refuses_bad_sizes() {
        let info = RingInfo::plan(7, 1920, 1080, 3).unwrap();
        assert_eq!(info.stride, 7680);
        assert_eq!(info.frame_bytes(), 8_294_400);
        assert_eq!(info.slot_bytes, 8_294_400);
        assert_eq!(info.slot_offset, 4096);
        assert_eq!(info.total_bytes, 4096 + 3 * 8_294_400);
        let odd = RingInfo::plan(1, 3, 3, 2).unwrap();
        assert_eq!(odd.slot_bytes, 4096);
        assert!(RingInfo::plan(1, 0, 1, 3).is_err());
        assert!(RingInfo::plan(1, 1, 1, 1).is_err());
        assert!(RingInfo::plan(1, 1, 1, MAX_SLOTS + 1).is_err());
        assert!(RingInfo::plan(1, 20_000, 1, 3).is_err());
    }

    #[test]
    fn the_magic_reads_as_its_letters() {
        assert_eq!(&MAGIC.to_le_bytes(), b"VRCPUPRV");
    }

    #[cfg(any(target_os = "linux", windows))]
    mod live {
        use super::super::*;
        use std::sync::Arc;
        use std::sync::atomic::AtomicBool;

        #[test]
        fn a_reader_maps_the_writers_ring_and_sees_the_latest_frame() {
            let mut writer = RingWriter::create(3, 64, 8, 3).unwrap();
            let reader = RingReader::open(writer.handle()).unwrap();
            assert_eq!(reader.info(), writer.info());
            assert_eq!(reader.latest_frame_id(), 0);
            assert!(reader.lease_latest().is_none());
            assert_eq!(
                reader.wait_newer(0, Duration::from_millis(20)),
                Wait::Timeout
            );

            let mut slot = writer.begin().unwrap();
            slot.pixels_mut().fill(0x11);
            let id = slot.publish(900, 1234);
            assert_eq!(id, 1);
            assert_eq!(
                reader.wait_newer(0, Duration::from_secs(1)),
                Wait::NewFrame(1)
            );
            let leased = reader.lease_latest().unwrap();
            assert_eq!(leased.frame_id, 1);
            assert_eq!(leased.source_sequence, 900);
            assert_eq!(leased.captured_at_micros, 1234);
            assert_eq!(
                (leased.width(), leased.height(), leased.stride()),
                (64, 8, 256)
            );
            assert!(leased.pixels().iter().all(|&byte| byte == 0x11));
            assert_eq!(writer.reader_lease(), 1);
            drop(leased);
            assert_eq!(writer.reader_lease(), 0);
            assert_eq!(writer.frames_written(), 1);
        }

        #[test]
        fn the_writer_never_takes_the_latest_or_the_leased_slot() {
            let mut writer = RingWriter::create(4, 16, 2, 3).unwrap();
            let reader = RingReader::open(writer.handle()).unwrap();
            let first = writer.begin().unwrap();
            let first_slot = first.slot;
            first.publish(1, 0);
            let leased = reader.lease_latest().unwrap();
            assert_eq!(leased.slot(), first_slot);
            // Two more frames: neither lands in the leased slot.
            for sequence in 2..=4 {
                let write = writer.begin().unwrap();
                assert_ne!(write.slot, first_slot, "the leased slot was overwritten");
                write.publish(sequence, 0);
            }
            assert_eq!(leased.frame_id, 1);
            drop(leased);
            // Released: the slot comes back into rotation.
            let slots: Vec<u32> = (0..3)
                .map(|_| {
                    let write = writer.begin().unwrap();
                    let slot = write.slot;
                    write.publish(9, 0);
                    slot
                })
                .collect();
            assert!(slots.contains(&first_slot));
            assert_eq!(writer.frames_skipped(), 0);
        }

        #[test]
        fn retiring_wakes_the_reader_with_the_reason() {
            let writer = RingWriter::create(5, 16, 2, 3).unwrap();
            let reader = RingReader::open(writer.handle()).unwrap();
            let waiter = std::thread::spawn(move || reader.wait_newer(0, Duration::from_secs(5)));
            std::thread::sleep(Duration::from_millis(30));
            writer.retire();
            assert_eq!(waiter.join().unwrap(), Wait::Retired);
        }

        #[test]
        fn a_torn_frame_is_never_leased_under_a_racing_writer() {
            // The writer fills each frame with its own id; the reader must
            // only ever see whole frames, however the two race.
            let mut writer = RingWriter::create(6, 256, 16, 3).unwrap();
            let reader = RingReader::open(writer.handle()).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_writer = stop.clone();
            let producer = std::thread::spawn(move || {
                let mut sequence = 0_u64;
                while !stop_writer.load(Ordering::Relaxed) {
                    if let Some(mut write) = writer.begin() {
                        let id = write.frame_id();
                        write.pixels_mut().fill((id & 0xff) as u8);
                        write.publish(sequence, now_micros());
                        sequence += 1;
                    }
                }
                (writer.frames_written(), writer.frames_skipped())
            });
            let mut seen = 0_u64;
            let mut last = 0_u64;
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_millis(300) {
                if let Wait::NewFrame(_) = reader.wait_newer(last, Duration::from_millis(50))
                    && let Some(leased) = reader.lease_latest()
                {
                    let expected = (leased.frame_id & 0xff) as u8;
                    assert!(
                        leased.pixels().iter().all(|&byte| byte == expected),
                        "frame {} was torn",
                        leased.frame_id
                    );
                    assert!(leased.frame_id > last);
                    last = leased.frame_id;
                    seen += 1;
                }
            }
            stop.store(true, Ordering::Relaxed);
            let (written, skipped) = producer.join().unwrap();
            assert!(seen > 10, "the reader saw {seen} frames of {written}");
            assert_eq!(skipped, 0, "three slots never run out for one reader");
        }

        #[test]
        fn a_wrong_handle_is_refused_by_name() {
            let handle = RingHandle {
                kind: "memfd-path",
                name: "/nonexistent/videorc-ring".to_string(),
                bytes: 8192,
            };
            assert!(RingReader::open(&handle).is_err());
        }
    }
}
