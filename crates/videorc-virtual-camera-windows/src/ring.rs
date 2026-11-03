//! The frame ring Videorc and the media source share (plan 214 C1).
//!
//! The media source, inside the Frame Server (session 0), creates a named
//! `Global\` section and initialises this layout in it. Videorc opens the
//! section from the user's session and writes NV12 frames; the media source
//! reads the newest one for every sample the Frame Server requests.
//!
//! Layout, little endian, one 4 KiB header page then three page-aligned
//! slots (`slot_stride` is the NV12 frame rounded up to a page):
//!
//! | offset | size | field                                                      |
//! | ------ | ---- | ---------------------------------------------------------- |
//! | 0      | 4    | magic `VCAM`                                               |
//! | 4      | 4    | layout version (1)                                         |
//! | 8      | 4    | width                                                      |
//! | 12     | 4    | height                                                     |
//! | 16     | 4    | fourcc `NV12`                                              |
//! | 20     | 4    | frame bytes (width × height × 3 / 2)                       |
//! | 24     | 4    | slot count (3)                                             |
//! | 28     | 4    | slot stride                                                |
//! | 32     | 8    | producer heartbeat: `GetTickCount64` ms at the last write  |
//! | 40     | 8    | latest frame sequence (0: none yet)                        |
//! | 48     | 4    | latest slot index                                          |
//! | 52     | 4    | viewers: how many started streams hold the camera (D13)    |
//! | 56     | 8    | reserved                                                   |
//! | 64     | 3×32 | slot descriptors: seqlock word, frame sequence, pts 100 ns |
//! | 4096   |      | slot 0, then slot 1, then slot 2                           |
//!
//! Seqlock: the single writer rotates through the slots; before it touches a
//! slot it makes the slot's word odd, after the frame and its descriptor are
//! in place it makes the word even and publishes the slot in the header. A
//! reader copies the published slot and keeps the copy only when the word
//! was even and unchanged around the copy; a torn copy is retried, then the
//! previous frame is kept. With three slots the writer is two frames away
//! from the slot a reader is copying, so a retry is rare.
//!
//! Staleness: the writer refreshes the heartbeat with every frame. A reader
//! treats a heartbeat older than [`STALE_AFTER_MS`] (or a never-written
//! ring) as "Videorc isn't running". Both sides read the same boot clock
//! (`GetTickCount64`), so no wall-clock skew is involved.
//!
//! A different size is a different section: the name carries the geometry
//! ([`RingLayout::section_name`]) and the header repeats it, so an old
//! reader and a new writer never meet on one section, and a writer attaching
//! to a header that names another size is refused.
//!
//! Everything here is plain Rust over a raw region: the section's view on
//! Windows, an aligned buffer in tests.

use std::fmt;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering, fence};

/// `VCAM`.
pub const RING_MAGIC: u32 = u32::from_le_bytes(*b"VCAM");
pub const RING_VERSION: u32 = 1;
/// `NV12`.
pub const NV12_FOURCC: u32 = u32::from_le_bytes(*b"NV12");
pub const SLOT_COUNT: usize = 3;
/// Slots and the header are page aligned.
pub const PAGE_BYTES: usize = 4096;
pub const HEADER_BYTES: usize = PAGE_BYTES;
/// A producer silent for this long is "not running".
pub const STALE_AFTER_MS: u64 = 1000;
/// How many torn copies a reader retries before keeping its previous frame.
pub const READ_RETRIES: usize = 4;

const OFF_MAGIC: usize = 0;
const OFF_VERSION: usize = 4;
const OFF_WIDTH: usize = 8;
const OFF_HEIGHT: usize = 12;
const OFF_FOURCC: usize = 16;
const OFF_FRAME_BYTES: usize = 20;
const OFF_SLOT_COUNT: usize = 24;
const OFF_SLOT_STRIDE: usize = 28;
const OFF_HEARTBEAT: usize = 32;
const OFF_LATEST_SEQUENCE: usize = 40;
const OFF_LATEST_SLOT: usize = 48;
const OFF_VIEWERS: usize = 52;
const OFF_SLOTS: usize = 64;
const SLOT_DESCRIPTOR_BYTES: usize = 32;
const DESC_SEQLOCK: usize = 0;
const DESC_SEQUENCE: usize = 8;
const DESC_PTS: usize = 16;

/// Why a ring could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RingError {
    /// Zero or odd dimensions: NV12 needs even ones.
    InvalidSize { width: u32, height: u32 },
    /// The region is shorter than the layout needs.
    RegionTooSmall { needed: usize, len: usize },
    /// No valid header: the media source has not initialised the section.
    NotInitialized,
    /// A header from another layout version.
    VersionMismatch { found: u32 },
    /// The header names another geometry than the one asked for.
    SizeMismatch {
        expected: (u32, u32),
        found: (u32, u32),
    },
    /// A frame of the wrong length was offered.
    FrameLength { expected: usize, found: usize },
}

impl fmt::Display for RingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSize { width, height } => {
                write!(f, "{width}x{height} is not a valid NV12 size")
            }
            Self::RegionTooSmall { needed, len } => {
                write!(f, "the ring needs {needed} bytes, the region has {len}")
            }
            Self::NotInitialized => write!(f, "the ring has no header yet"),
            Self::VersionMismatch { found } => {
                write!(
                    f,
                    "ring layout version {found}, this build speaks {RING_VERSION}"
                )
            }
            Self::SizeMismatch { expected, found } => write!(
                f,
                "the ring is {}x{}, {}x{} was expected",
                found.0, found.1, expected.0, expected.1
            ),
            Self::FrameLength { expected, found } => {
                write!(
                    f,
                    "a frame of {found} bytes was offered, the ring takes {expected}"
                )
            }
        }
    }
}

impl std::error::Error for RingError {}

/// The geometry of one ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingLayout {
    pub width: u32,
    pub height: u32,
    /// One tightly packed NV12 frame.
    pub frame_bytes: usize,
    /// `frame_bytes` rounded up to a page.
    pub slot_stride: usize,
}

impl RingLayout {
    pub fn nv12(width: u32, height: u32) -> Result<Self, RingError> {
        if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(RingError::InvalidSize { width, height });
        }
        let frame_bytes = width as usize * height as usize * 3 / 2;
        Ok(Self {
            width,
            height,
            frame_bytes,
            slot_stride: frame_bytes.div_ceil(PAGE_BYTES) * PAGE_BYTES,
        })
    }

    /// The whole section: the header page plus the slots.
    pub fn total_bytes(&self) -> usize {
        HEADER_BYTES + SLOT_COUNT * self.slot_stride
    }

    /// The section's kernel object name. The geometry is part of it, so a
    /// size change is a new section rather than a reinterpreted one.
    pub fn section_name(&self) -> String {
        format!("Global\\VideorcCamera.{}x{}", self.width, self.height)
    }

    fn slot_offset(&self, slot: usize) -> usize {
        HEADER_BYTES + slot * self.slot_stride
    }
}

/// A mapped region the ring lives in. The pointer is shared with another
/// process; every access goes through atomics or raw copies, never through
/// Rust references to the frame bytes.
pub struct RingRegion {
    base: NonNull<u8>,
    len: usize,
}

// SAFETY: the region is a view of memory another process also maps; moving
// the handle between threads changes nothing about that. The writer and the
// reader each use their region from one thread at a time.
unsafe impl Send for RingRegion {}

impl RingRegion {
    /// # Safety
    ///
    /// `base` must point at `len` bytes that stay mapped, readable and
    /// writable for as long as the region is used, aligned to 8 bytes.
    pub unsafe fn from_raw(base: *mut u8, len: usize) -> Self {
        debug_assert!(
            (base as usize).is_multiple_of(8),
            "the ring header holds u64 atomics"
        );
        Self {
            base: NonNull::new(base).expect("a ring region is never null"),
            len,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn u32_at(&self, offset: usize) -> &AtomicU32 {
        debug_assert!(offset + 4 <= self.len && offset.is_multiple_of(4));
        // SAFETY: in bounds and aligned (checked above); the memory stays
        // mapped for the region's lifetime (`from_raw`'s contract).
        unsafe { AtomicU32::from_ptr(self.base.as_ptr().add(offset).cast()) }
    }

    fn u64_at(&self, offset: usize) -> &AtomicU64 {
        debug_assert!(offset + 8 <= self.len && offset.is_multiple_of(8));
        // SAFETY: as above.
        unsafe { AtomicU64::from_ptr(self.base.as_ptr().add(offset).cast()) }
    }

    fn bytes_at(&self, offset: usize, len: usize) -> *mut u8 {
        debug_assert!(offset + len <= self.len);
        // SAFETY: in bounds (checked above).
        unsafe { self.base.as_ptr().add(offset) }
    }
}

/// A page-aligned, zeroed heap region for tests and for an in-process ring.
/// Raw memory, not a `Vec`: the ring writes through shared handles, which a
/// `Vec` behind `&self` would not allow.
pub struct OwnedRegion {
    base: NonNull<u8>,
    layout: std::alloc::Layout,
}

impl OwnedRegion {
    pub fn zeroed(len: usize) -> Self {
        let layout = std::alloc::Layout::from_size_align(len.max(8), PAGE_BYTES)
            .expect("a small, page-aligned layout");
        // SAFETY: the layout has a non-zero size.
        let base = unsafe { std::alloc::alloc_zeroed(layout) };
        let base = NonNull::new(base).unwrap_or_else(|| std::alloc::handle_alloc_error(layout));
        Self { base, layout }
    }

    pub fn region(&self) -> RingRegion {
        // SAFETY: the allocation lives until this owner drops and is page
        // aligned.
        unsafe { RingRegion::from_raw(self.base.as_ptr(), self.layout.size()) }
    }
}

impl Drop for OwnedRegion {
    fn drop(&mut self) {
        // SAFETY: allocated in `zeroed` with this layout, freed once.
        unsafe { std::alloc::dealloc(self.base.as_ptr(), self.layout) };
    }
}

struct SlotDescriptor<'a> {
    region: &'a RingRegion,
    offset: usize,
}

impl SlotDescriptor<'_> {
    fn seqlock(&self) -> &AtomicU64 {
        self.region.u64_at(self.offset + DESC_SEQLOCK)
    }

    fn sequence(&self) -> &AtomicU64 {
        self.region.u64_at(self.offset + DESC_SEQUENCE)
    }

    fn pts(&self) -> &AtomicU64 {
        self.region.u64_at(self.offset + DESC_PTS)
    }
}

/// The header fields both sides touch.
struct Header<'a> {
    region: &'a RingRegion,
}

impl<'a> Header<'a> {
    fn new(region: &'a RingRegion) -> Result<Self, RingError> {
        if region.len() < HEADER_BYTES {
            return Err(RingError::RegionTooSmall {
                needed: HEADER_BYTES,
                len: region.len(),
            });
        }
        Ok(Self { region })
    }

    /// The layout the header describes, when it is a valid header of this
    /// version and the region is long enough for it.
    fn read_layout(&self) -> Result<RingLayout, RingError> {
        let r = self.region;
        if r.u32_at(OFF_MAGIC).load(Ordering::Acquire) != RING_MAGIC {
            return Err(RingError::NotInitialized);
        }
        let version = r.u32_at(OFF_VERSION).load(Ordering::Acquire);
        if version != RING_VERSION {
            return Err(RingError::VersionMismatch { found: version });
        }
        let width = r.u32_at(OFF_WIDTH).load(Ordering::Acquire);
        let height = r.u32_at(OFF_HEIGHT).load(Ordering::Acquire);
        let layout = RingLayout::nv12(width, height)?;
        let consistent = r.u32_at(OFF_FOURCC).load(Ordering::Acquire) == NV12_FOURCC
            && r.u32_at(OFF_FRAME_BYTES).load(Ordering::Acquire) as usize == layout.frame_bytes
            && r.u32_at(OFF_SLOT_COUNT).load(Ordering::Acquire) as usize == SLOT_COUNT
            && r.u32_at(OFF_SLOT_STRIDE).load(Ordering::Acquire) as usize == layout.slot_stride;
        if !consistent {
            return Err(RingError::NotInitialized);
        }
        if r.len() < layout.total_bytes() {
            return Err(RingError::RegionTooSmall {
                needed: layout.total_bytes(),
                len: r.len(),
            });
        }
        Ok(layout)
    }

    fn write_layout(&self, layout: &RingLayout) {
        let r = self.region;
        // The magic goes last: a reader that sees it sees the rest.
        r.u32_at(OFF_VERSION).store(RING_VERSION, Ordering::Release);
        r.u32_at(OFF_WIDTH).store(layout.width, Ordering::Release);
        r.u32_at(OFF_HEIGHT).store(layout.height, Ordering::Release);
        r.u32_at(OFF_FOURCC).store(NV12_FOURCC, Ordering::Release);
        r.u32_at(OFF_FRAME_BYTES)
            .store(layout.frame_bytes as u32, Ordering::Release);
        r.u32_at(OFF_SLOT_COUNT)
            .store(SLOT_COUNT as u32, Ordering::Release);
        r.u32_at(OFF_SLOT_STRIDE)
            .store(layout.slot_stride as u32, Ordering::Release);
        r.u64_at(OFF_HEARTBEAT).store(0, Ordering::Release);
        r.u64_at(OFF_LATEST_SEQUENCE).store(0, Ordering::Release);
        r.u32_at(OFF_LATEST_SLOT).store(0, Ordering::Release);
        r.u32_at(OFF_VIEWERS).store(0, Ordering::Release);
        for slot in 0..SLOT_COUNT {
            let descriptor = self.slot(slot);
            descriptor.seqlock().store(0, Ordering::Release);
            descriptor.sequence().store(0, Ordering::Release);
            descriptor.pts().store(0, Ordering::Release);
        }
        fence(Ordering::SeqCst);
        r.u32_at(OFF_MAGIC).store(RING_MAGIC, Ordering::SeqCst);
    }

    fn slot(&self, slot: usize) -> SlotDescriptor<'a> {
        SlotDescriptor {
            region: self.region,
            offset: OFF_SLOTS + slot * SLOT_DESCRIPTOR_BYTES,
        }
    }

    fn heartbeat(&self) -> &AtomicU64 {
        self.region.u64_at(OFF_HEARTBEAT)
    }

    fn latest_sequence(&self) -> &AtomicU64 {
        self.region.u64_at(OFF_LATEST_SEQUENCE)
    }

    fn latest_slot(&self) -> &AtomicU32 {
        self.region.u32_at(OFF_LATEST_SLOT)
    }

    fn viewers(&self) -> &AtomicU32 {
        self.region.u32_at(OFF_VIEWERS)
    }
}

/// Videorc's side: writes frames into a ring the media source initialised.
pub struct RingWriter {
    region: RingRegion,
    layout: RingLayout,
    next_slot: usize,
    sequence: u64,
}

impl RingWriter {
    /// Attach to an initialised ring of exactly `expected`'s geometry.
    pub fn attach(region: RingRegion, expected: &RingLayout) -> Result<Self, RingError> {
        let header = Header::new(&region)?;
        let layout = header.read_layout()?;
        if layout != *expected {
            return Err(RingError::SizeMismatch {
                expected: (expected.width, expected.height),
                found: (layout.width, layout.height),
            });
        }
        // Continue the sequence a previous writer left (a relaunch over a
        // surviving section): a reader never sees a number go backwards.
        let sequence = header.latest_sequence().load(Ordering::Acquire);
        let next_slot = if sequence == 0 {
            0
        } else {
            (header.latest_slot().load(Ordering::Acquire) as usize + 1) % SLOT_COUNT
        };
        Ok(Self {
            region,
            layout,
            next_slot,
            sequence,
        })
    }

    pub fn layout(&self) -> &RingLayout {
        &self.layout
    }

    /// Publish one tightly packed NV12 frame. `now_ms` is the boot clock
    /// (`GetTickCount64`), the heartbeat readers judge staleness by. Returns
    /// the frame's sequence number.
    pub fn write_frame(
        &mut self,
        nv12: &[u8],
        pts_100ns: i64,
        now_ms: u64,
    ) -> Result<u64, RingError> {
        if nv12.len() != self.layout.frame_bytes {
            return Err(RingError::FrameLength {
                expected: self.layout.frame_bytes,
                found: nv12.len(),
            });
        }
        let header = Header::new(&self.region)?;
        let slot = self.next_slot;
        let descriptor = header.slot(slot);
        // Odd: a reader that sees this word retries. The word is normalised
        // to even first in case an earlier writer died mid-write.
        let opened = (descriptor.seqlock().load(Ordering::Acquire) & !1) + 1;
        descriptor.seqlock().store(opened, Ordering::SeqCst);
        fence(Ordering::SeqCst);
        let destination = self
            .region
            .bytes_at(self.layout.slot_offset(slot), nv12.len());
        // SAFETY: the slot is in bounds for `frame_bytes` (the layout was
        // validated against the region's length) and `nv12` is exactly that
        // long. Readers copy the bytes without forming references; the
        // seqlock word tells them whether the copy was torn.
        unsafe { std::ptr::copy_nonoverlapping(nv12.as_ptr(), destination, nv12.len()) };
        self.sequence += 1;
        descriptor
            .sequence()
            .store(self.sequence, Ordering::Release);
        descriptor.pts().store(pts_100ns as u64, Ordering::Release);
        fence(Ordering::SeqCst);
        descriptor.seqlock().store(opened + 1, Ordering::SeqCst);
        header.latest_slot().store(slot as u32, Ordering::Release);
        header
            .latest_sequence()
            .store(self.sequence, Ordering::Release);
        header.heartbeat().store(now_ms, Ordering::Release);
        self.next_slot = (slot + 1) % SLOT_COUNT;
        Ok(self.sequence)
    }

    /// How many started streams hold the camera, as the media source last
    /// wrote it (D13).
    pub fn viewers(&self) -> u32 {
        Header::new(&self.region)
            .map(|header| header.viewers().load(Ordering::Acquire))
            .unwrap_or(0)
    }
}

/// What a read found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOutcome {
    /// A frame newer than the last one this reader returned was copied.
    Fresh { sequence: u64, pts_100ns: i64 },
    /// Nothing newer than the reader's last frame (or the newest frame was
    /// torn too often: keep the previous one).
    Unchanged,
    /// The producer has not written for [`STALE_AFTER_MS`].
    Stale,
    /// The producer has never written.
    Empty,
}

/// The media source's side: owns the header, reads the newest frame.
pub struct RingReader {
    region: RingRegion,
    layout: RingLayout,
    last_sequence: u64,
}

impl RingReader {
    /// Take ownership of a region: keep a valid header of the same geometry
    /// (the section outlived a media source instance; frames and sequence
    /// stay, viewers restart at zero), else write a fresh one.
    pub fn initialize(region: RingRegion, layout: RingLayout) -> Result<Self, RingError> {
        if region.len() < layout.total_bytes() {
            return Err(RingError::RegionTooSmall {
                needed: layout.total_bytes(),
                len: region.len(),
            });
        }
        let header = Header::new(&region)?;
        match header.read_layout() {
            Ok(found) if found == layout => {}
            _ => header.write_layout(&layout),
        }
        header.viewers().store(0, Ordering::Release);
        Ok(Self {
            region,
            layout,
            last_sequence: 0,
        })
    }

    pub fn layout(&self) -> &RingLayout {
        &self.layout
    }

    /// D13: the number of started streams on this source.
    pub fn set_viewers(&self, viewers: u32) {
        if let Ok(header) = Header::new(&self.region) {
            header.viewers().store(viewers, Ordering::Release);
        }
    }

    pub fn viewers(&self) -> u32 {
        Header::new(&self.region)
            .map(|header| header.viewers().load(Ordering::Acquire))
            .unwrap_or(0)
    }

    /// Whether the producer wrote within [`STALE_AFTER_MS`] of `now_ms`.
    pub fn producer_alive(&self, now_ms: u64) -> bool {
        let Ok(header) = Header::new(&self.region) else {
            return false;
        };
        let heartbeat = header.heartbeat().load(Ordering::Acquire);
        heartbeat != 0 && now_ms.saturating_sub(heartbeat) <= STALE_AFTER_MS
    }

    /// Copy the newest frame into `dst` (one tightly packed NV12 frame) when
    /// it is newer than the last frame this reader returned.
    pub fn read_latest_into(&mut self, dst: &mut [u8], now_ms: u64) -> ReadOutcome {
        let Ok(header) = Header::new(&self.region) else {
            return ReadOutcome::Empty;
        };
        let latest = header.latest_sequence().load(Ordering::Acquire);
        if latest == 0 {
            return ReadOutcome::Empty;
        }
        if !self.producer_alive(now_ms) {
            return ReadOutcome::Stale;
        }
        if latest <= self.last_sequence {
            return ReadOutcome::Unchanged;
        }
        if dst.len() < self.layout.frame_bytes {
            return ReadOutcome::Unchanged;
        }
        for _ in 0..READ_RETRIES {
            let slot = header.latest_slot().load(Ordering::Acquire) as usize % SLOT_COUNT;
            let descriptor = header.slot(slot);
            let before = descriptor.seqlock().load(Ordering::Acquire);
            if before & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let source = self
                .region
                .bytes_at(self.layout.slot_offset(slot), self.layout.frame_bytes);
            // SAFETY: in bounds (validated layout); the writer may be
            // overwriting these bytes concurrently, which the seqlock word
            // detects after the copy. No reference to the shared bytes is
            // formed.
            unsafe {
                std::ptr::copy_nonoverlapping(source, dst.as_mut_ptr(), self.layout.frame_bytes)
            };
            let sequence = descriptor.sequence().load(Ordering::Acquire);
            let pts_100ns = descriptor.pts().load(Ordering::Acquire) as i64;
            fence(Ordering::SeqCst);
            let after = descriptor.seqlock().load(Ordering::Acquire);
            if before != after {
                continue;
            }
            if sequence <= self.last_sequence {
                // The slot was recycled under us and now holds an older
                // frame than the one we have: nothing new.
                return ReadOutcome::Unchanged;
            }
            self.last_sequence = sequence;
            return ReadOutcome::Fresh {
                sequence,
                pts_100ns,
            };
        }
        ReadOutcome::Unchanged
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> RingLayout {
        RingLayout::nv12(64, 32).unwrap()
    }

    fn ring() -> (OwnedRegion, RingLayout) {
        let layout = layout();
        (OwnedRegion::zeroed(layout.total_bytes()), layout)
    }

    fn frame(layout: &RingLayout, fill: u8) -> Vec<u8> {
        vec![fill; layout.frame_bytes]
    }

    #[test]
    fn the_camera_layout_rounds_slots_to_pages_and_names_the_section_by_size() {
        let hd = RingLayout::nv12(1920, 1080).unwrap();
        assert_eq!(hd.frame_bytes, 3_110_400);
        assert_eq!(hd.slot_stride, 3_112_960);
        assert_eq!(hd.total_bytes(), 4096 + 3 * 3_112_960);
        assert_eq!(hd.section_name(), r"Global\VideorcCamera.1920x1080");
        let small = RingLayout::nv12(1280, 720).unwrap();
        assert_ne!(small.section_name(), hd.section_name());
        assert_eq!(
            RingLayout::nv12(1919, 1080),
            Err(RingError::InvalidSize {
                width: 1919,
                height: 1080
            })
        );
        assert!(RingLayout::nv12(0, 2).is_err());
    }

    #[test]
    fn a_writer_attaching_before_the_source_initialised_is_refused() {
        let (owned, layout) = ring();
        assert_eq!(
            RingWriter::attach(owned.region(), &layout).err(),
            Some(RingError::NotInitialized)
        );
    }

    #[test]
    fn a_writer_refuses_a_ring_whose_header_names_another_size() {
        let other = RingLayout::nv12(32, 16).unwrap();
        let owned = OwnedRegion::zeroed(layout().total_bytes());
        RingReader::initialize(owned.region(), other).unwrap();
        assert_eq!(
            RingWriter::attach(owned.region(), &layout()).err(),
            Some(RingError::SizeMismatch {
                expected: (64, 32),
                found: (32, 16)
            })
        );
        let short = OwnedRegion::zeroed(HEADER_BYTES);
        assert!(matches!(
            RingReader::initialize(short.region(), layout()),
            Err(RingError::RegionTooSmall { .. })
        ));
    }

    #[test]
    fn a_written_frame_reads_back_once_then_unchanged_and_slots_rotate() {
        let (owned, layout) = ring();
        let mut reader = RingReader::initialize(owned.region(), layout).unwrap();
        let mut writer = RingWriter::attach(owned.region(), &layout).unwrap();
        let mut dst = vec![0u8; layout.frame_bytes];
        assert_eq!(reader.read_latest_into(&mut dst, 10), ReadOutcome::Empty);

        assert_eq!(writer.write_frame(&frame(&layout, 7), 333, 10).unwrap(), 1);
        assert_eq!(
            reader.read_latest_into(&mut dst, 20),
            ReadOutcome::Fresh {
                sequence: 1,
                pts_100ns: 333
            }
        );
        assert!(dst.iter().all(|byte| *byte == 7));
        assert_eq!(
            reader.read_latest_into(&mut dst, 30),
            ReadOutcome::Unchanged
        );

        for fill in 8..12u8 {
            writer
                .write_frame(&frame(&layout, fill), i64::from(fill), 40)
                .unwrap();
        }
        assert_eq!(
            reader.read_latest_into(&mut dst, 50),
            ReadOutcome::Fresh {
                sequence: 5,
                pts_100ns: 11
            }
        );
        assert!(dst.iter().all(|byte| *byte == 11));
        // Five frames over three slots: the newest sits in slot 1.
        let region = owned.region();
        let header = Header::new(&region).unwrap();
        assert_eq!(header.latest_slot().load(Ordering::Relaxed), 1);
        assert_eq!(
            writer.write_frame(&frame(&layout, 1)[..10], 0, 0).err(),
            Some(RingError::FrameLength {
                expected: layout.frame_bytes,
                found: 10
            })
        );
    }

    #[test]
    fn the_ring_is_stale_one_second_after_the_last_write() {
        let (owned, layout) = ring();
        let mut reader = RingReader::initialize(owned.region(), layout).unwrap();
        let mut writer = RingWriter::attach(owned.region(), &layout).unwrap();
        let mut dst = vec![0u8; layout.frame_bytes];
        assert!(!reader.producer_alive(5_000));
        writer.write_frame(&frame(&layout, 1), 0, 5_000).unwrap();
        assert!(reader.producer_alive(5_000 + STALE_AFTER_MS));
        assert!(!reader.producer_alive(5_000 + STALE_AFTER_MS + 1));
        assert!(matches!(
            reader.read_latest_into(&mut dst, 5_999),
            ReadOutcome::Fresh { .. }
        ));
        assert_eq!(reader.read_latest_into(&mut dst, 6_001), ReadOutcome::Stale);
        // A new frame wakes it up again.
        writer.write_frame(&frame(&layout, 2), 0, 6_001).unwrap();
        assert!(matches!(
            reader.read_latest_into(&mut dst, 6_002),
            ReadOutcome::Fresh { sequence: 2, .. }
        ));
    }

    #[test]
    fn viewers_flow_from_the_source_to_the_writer() {
        let (owned, layout) = ring();
        let reader = RingReader::initialize(owned.region(), layout).unwrap();
        let writer = RingWriter::attach(owned.region(), &layout).unwrap();
        assert_eq!(writer.viewers(), 0);
        reader.set_viewers(1);
        assert_eq!(writer.viewers(), 1);
        assert_eq!(reader.viewers(), 1);
    }

    #[test]
    fn a_source_restart_over_a_surviving_section_keeps_frames_and_resets_viewers() {
        let (owned, layout) = ring();
        let reader = RingReader::initialize(owned.region(), layout).unwrap();
        let mut writer = RingWriter::attach(owned.region(), &layout).unwrap();
        writer.write_frame(&frame(&layout, 3), 7, 100).unwrap();
        writer.write_frame(&frame(&layout, 4), 8, 101).unwrap();
        reader.set_viewers(2);
        let mut restarted = RingReader::initialize(owned.region(), layout).unwrap();
        assert_eq!(restarted.viewers(), 0);
        let mut dst = vec![0u8; layout.frame_bytes];
        assert_eq!(
            restarted.read_latest_into(&mut dst, 102),
            ReadOutcome::Fresh {
                sequence: 2,
                pts_100ns: 8
            }
        );
        assert!(dst.iter().all(|byte| *byte == 4));
        // A relaunched writer continues the numbering.
        let mut relaunched = RingWriter::attach(owned.region(), &layout).unwrap();
        assert_eq!(
            relaunched.write_frame(&frame(&layout, 5), 9, 103).unwrap(),
            3
        );
    }

    #[test]
    fn a_slot_left_odd_by_a_dead_writer_is_skipped_until_rewritten() {
        let (owned, layout) = ring();
        let mut reader = RingReader::initialize(owned.region(), layout).unwrap();
        let mut writer = RingWriter::attach(owned.region(), &layout).unwrap();
        writer.write_frame(&frame(&layout, 1), 0, 10).unwrap();
        let region = owned.region();
        let header = Header::new(&region).unwrap();
        // Simulate a writer that died mid-write of the published slot.
        let descriptor = header.slot(0);
        descriptor.seqlock().fetch_add(1, Ordering::SeqCst);
        let mut dst = vec![0u8; layout.frame_bytes];
        assert_eq!(
            reader.read_latest_into(&mut dst, 11),
            ReadOutcome::Unchanged
        );
        // The next writer normalises the word and the frame reads cleanly.
        let mut relaunched = RingWriter::attach(owned.region(), &layout).unwrap();
        // The relaunched writer continues at slot 1; write three so slot 0
        // is rewritten and published.
        for fill in 2..5u8 {
            relaunched
                .write_frame(&frame(&layout, fill), 0, 12)
                .unwrap();
        }
        assert!(matches!(
            reader.read_latest_into(&mut dst, 13),
            ReadOutcome::Fresh { sequence: 4, .. }
        ));
        assert!(dst.iter().all(|byte| *byte == 4));
    }

    #[test]
    fn a_concurrent_writer_never_hands_the_reader_a_mixed_frame() {
        struct Shared(RingRegion);
        // SAFETY: the test keeps the backing vector alive and unmoved for both
        // threads; the ring protocol handles the concurrent access.
        unsafe impl Sync for Shared {}

        let layout = RingLayout::nv12(256, 128).unwrap();
        let owned = OwnedRegion::zeroed(layout.total_bytes());
        let mut reader = RingReader::initialize(owned.region(), layout).unwrap();
        let writer_region = Shared(owned.region());
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            let writer_thread = scope.spawn(|| {
                let Shared(region) = writer_region;
                let mut writer = RingWriter::attach(region, &layout).unwrap();
                let mut fill = 1u8;
                let mut frames = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    writer
                        .write_frame(&frame(&layout, fill), i64::from(fill), 1)
                        .unwrap();
                    fill = fill.wrapping_add(1).max(1);
                    frames += 1;
                }
                frames
            });
            let mut dst = vec![0u8; layout.frame_bytes];
            let mut fresh = 0;
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(80);
            while std::time::Instant::now() < deadline {
                if let ReadOutcome::Fresh { pts_100ns, .. } = reader.read_latest_into(&mut dst, 1) {
                    fresh += 1;
                    let fill = dst[0];
                    assert!(
                        dst.iter().all(|byte| *byte == fill),
                        "a frame was mixed from two writes"
                    );
                    assert_eq!(i64::from(fill), pts_100ns, "descriptor and pixels disagree");
                }
            }
            stop.store(true, Ordering::Relaxed);
            let written = writer_thread.join().unwrap();
            assert!(written > 0 && fresh > 0, "written {written}, fresh {fresh}");
        });
    }
}
