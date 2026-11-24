//! Plan 260 S0.2b: the backend hands its Windows preview to another process.
//!
//! Today the backend shows its D3D11 preview in a window of its own
//! (`windows_d3d11_preview.rs`). The GPUI app wants the frames inside its own
//! window instead, and plan 260 measures three ways to get them there
//! (S0.2c). This module is the backend's half of two of them:
//!
//! - **(a) `composition-surface`:** a DirectComposition surface handle
//!   (`DCompositionCreateSurfaceHandle`). The backend's media thread presents
//!   into a swap chain made for that handle; the app shows the same surface
//!   as the content of a visual of its own
//!   (`IDCompositionDevice::CreateSurfaceFromHandle`). The presenter stays in
//!   the backend and no pixel is copied, as on macOS.
//! - **(b) `shared-texture`:** a ring of three BGRA textures shared by NT
//!   handle, each with a keyed mutex. The media thread copies each preview
//!   frame into a slot the app is not reading; the app draws the latest.
//!
//! Route (d), CPU frames in shared memory, is the CPU preview ring
//! (`videorc-preview-ring`, plan 260 S1.7) and lands with that crate.
//!
//! Both routes share one 4 KiB **header** in shared memory and one
//! auto-reset **frame event**. The backend duplicates every handle into the
//! app's process (`DuplicateHandle`, by the process id the app names), so
//! nothing is named and nothing can be opened by a third process. The
//! header's layout is fixed by [`HandoverHeader`] (little-endian, offsets in
//! its field comments, checked by a test), and the protocol is:
//!
//! - The backend writes each frame's fields between two increments of `seq`
//!   (odd while it writes) and then sets the frame event. A reader loads
//!   `seq`, retries while it is odd, reads the fields, and retries when `seq`
//!   moved ([`HandoverHeader::read`]).
//! - Route (b)'s textures come through the header, not the lease: the
//!   backend can only size them once a frame told it the preview's size, and
//!   a new size needs new textures. Each set has a `texture_generation`; the
//!   app opens the set's `slot_handles` (`ID3D11Device1::OpenSharedResource1`),
//!   closes the previous set's handles, and stores the generation in
//!   `texture_generation_seen`. The backend makes a new set only after the
//!   app has adopted the current one (frames of a new size drop until then),
//!   so no handle it duplicated goes unseen.
//! - Route (b)'s locking: one key, 0, on both sides. The app acquires the
//!   latest slot's mutex, draws it, and releases it; the backend never
//!   writes the latest slot and skips a slot whose mutex it cannot take at
//!   once, so with three slots it always finds one.
//! - `retired` turns nonzero when the hand-over ends (closed, the media
//!   generation ended, or it failed): the app closes what it holds and asks
//!   again. The app owns every handle it was given and closes each one.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering, fence};

/// `VRHANDOV` as little-endian bytes.
pub(crate) const HANDOVER_MAGIC: u64 = u64::from_le_bytes(*b"VRHANDOV");
/// The header's layout version; a reader refuses any other.
pub(crate) const HANDOVER_VERSION: u32 = 1;
/// The shared header's size: one page.
pub(crate) const HANDOVER_HEADER_BYTES: u32 = 4096;
/// Route (b)'s slot count: the latest, the one the app may hold, a free one.
pub(crate) const HANDOVER_TEXTURE_SLOTS: usize = 3;
/// `scene_revision` when the frame had no committed scene.
pub(crate) const HANDOVER_NO_SCENE_REVISION: u64 = u64::MAX;
/// `latest_slot` before route (b) published a frame (and always on (a)).
pub(crate) const HANDOVER_NO_SLOT: u32 = u32::MAX;

/// The wire code of each route in the header's `route` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum HandoverRouteCode {
    CompositionSurface = 1,
    SharedTexture = 2,
}

/// Why a hand-over ended, in the header's `retired` field (0 while open).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum HandoverRetireReason {
    /// The app closed the lease, or its connection to the backend ended.
    Closed = 1,
    /// The D3D11 media generation ended (the session stopped or recovered).
    MediaEnded = 2,
    /// Publishing failed; the backend's log names the error.
    Failed = 3,
}

/// The shared header. Every field is an atomic so the two processes never
/// race on plain memory; the comment on each field is its byte offset.
#[repr(C)]
#[derive(Debug, Default)]
pub(crate) struct HandoverHeader {
    /// 0: [`HANDOVER_MAGIC`].
    pub(crate) magic: AtomicU64,
    /// 8: [`HANDOVER_VERSION`].
    pub(crate) version: AtomicU32,
    /// 12: [`HandoverRouteCode`].
    pub(crate) route: AtomicU32,
    /// 16: 0 while open, else a [`HandoverRetireReason`].
    pub(crate) retired: AtomicU32,
    /// 20: route (b)'s slot count (0 on route (a)).
    pub(crate) slot_count: AtomicU32,
    /// 24: the seqlock word; odd while the backend writes the fields below.
    pub(crate) seq: AtomicU64,
    /// 32: frames published since the hand-over opened.
    pub(crate) frames_published: AtomicU64,
    /// 40: the media thread's sequence of the latest frame.
    pub(crate) media_sequence: AtomicU64,
    /// 48: the committed scene revision of the latest frame, or
    /// [`HANDOVER_NO_SCENE_REVISION`].
    pub(crate) scene_revision: AtomicU64,
    /// 56: `QueryPerformanceCounter` when the latest frame was published
    /// (the counter is system-wide, so the app can measure the hand-off).
    pub(crate) published_qpc: AtomicU64,
    /// 64: the latest frame's width in pixels.
    pub(crate) width: AtomicU32,
    /// 68: the latest frame's height in pixels.
    pub(crate) height: AtomicU32,
    /// 72: route (b)'s slot holding the latest frame, or [`HANDOVER_NO_SLOT`].
    pub(crate) latest_slot: AtomicU32,
    /// 76: reserved.
    pub(crate) reserved: AtomicU32,
    /// 80: route (b)'s current texture set (0 before the first).
    pub(crate) texture_generation: AtomicU64,
    /// 88: written by the app: the texture set it has opened.
    pub(crate) texture_generation_seen: AtomicU64,
    /// 96: route (b)'s slot handles, valid in the app's process.
    pub(crate) slot_handles: [AtomicU64; HANDOVER_TEXTURE_SLOTS],
    /// 120: frames the backend could not hand over (the swap chain busy, no
    /// free slot, or a new size waiting for the app to adopt its textures).
    pub(crate) frames_dropped: AtomicU64,
    /// 128: route (b)'s texture size; the slots are this size.
    pub(crate) texture_width: AtomicU32,
    /// 132: see `texture_width`.
    pub(crate) texture_height: AtomicU32,
}

const _: () = assert!(size_of::<HandoverHeader>() <= HANDOVER_HEADER_BYTES as usize);

/// One frame's fields, as the backend publishes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HandoverFrame {
    pub(crate) media_sequence: u64,
    pub(crate) scene_revision: Option<u64>,
    pub(crate) published_qpc: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) slot: Option<u32>,
}

/// A consistent read of the header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HandoverSnapshot {
    pub(crate) retired: u32,
    pub(crate) frames_published: u64,
    pub(crate) frame: HandoverFrame,
    pub(crate) texture_generation: u64,
    pub(crate) texture_width: u32,
    pub(crate) texture_height: u32,
    pub(crate) slot_handles: [u64; HANDOVER_TEXTURE_SLOTS],
    pub(crate) frames_dropped: u64,
}

impl HandoverHeader {
    pub(crate) fn initialize(&self, route: HandoverRouteCode) {
        self.version.store(HANDOVER_VERSION, Ordering::Relaxed);
        self.route.store(route as u32, Ordering::Relaxed);
        self.slot_count.store(
            match route {
                HandoverRouteCode::CompositionSurface => 0,
                HandoverRouteCode::SharedTexture => HANDOVER_TEXTURE_SLOTS as u32,
            },
            Ordering::Relaxed,
        );
        self.scene_revision
            .store(HANDOVER_NO_SCENE_REVISION, Ordering::Relaxed);
        self.latest_slot.store(HANDOVER_NO_SLOT, Ordering::Relaxed);
        // The magic goes last: a reader that sees it sees the rest.
        self.magic.store(HANDOVER_MAGIC, Ordering::Release);
    }

    fn write(&self, fields: impl FnOnce()) {
        let seq = self.seq.load(Ordering::Relaxed);
        self.seq.store(seq.wrapping_add(1), Ordering::Relaxed);
        fence(Ordering::Release);
        fields();
        self.seq.store(seq.wrapping_add(2), Ordering::Release);
    }

    pub(crate) fn publish_frame(&self, frame: HandoverFrame) {
        self.write(|| {
            self.media_sequence
                .store(frame.media_sequence, Ordering::Relaxed);
            self.scene_revision.store(
                frame.scene_revision.unwrap_or(HANDOVER_NO_SCENE_REVISION),
                Ordering::Relaxed,
            );
            self.published_qpc
                .store(frame.published_qpc, Ordering::Relaxed);
            self.width.store(frame.width, Ordering::Relaxed);
            self.height.store(frame.height, Ordering::Relaxed);
            self.latest_slot
                .store(frame.slot.unwrap_or(HANDOVER_NO_SLOT), Ordering::Relaxed);
            self.frames_published.fetch_add(1, Ordering::Relaxed);
        });
    }

    /// Route (b): a new texture set. The latest slot is cleared with it, so
    /// the app never pairs a slot index with the wrong set.
    pub(crate) fn publish_textures(
        &self,
        generation: u64,
        width: u32,
        height: u32,
        handles: [u64; HANDOVER_TEXTURE_SLOTS],
    ) {
        self.write(|| {
            for (slot, handle) in self.slot_handles.iter().zip(handles) {
                slot.store(handle, Ordering::Relaxed);
            }
            self.texture_width.store(width, Ordering::Relaxed);
            self.texture_height.store(height, Ordering::Relaxed);
            self.latest_slot.store(HANDOVER_NO_SLOT, Ordering::Relaxed);
            self.texture_generation.store(generation, Ordering::Relaxed);
        });
    }

    pub(crate) fn note_dropped(&self) {
        self.frames_dropped.fetch_add(1, Ordering::Relaxed);
    }

    /// The first reason wins: a later one never rewrites why it ended.
    pub(crate) fn retire(&self, reason: HandoverRetireReason) {
        let _ =
            self.retired
                .compare_exchange(0, reason as u32, Ordering::AcqRel, Ordering::Relaxed);
    }

    /// The app's side: a consistent snapshot, or `None` when the header is
    /// not initialized (or the backend wrote through every retry).
    pub(crate) fn read(&self) -> Option<HandoverSnapshot> {
        if self.magic.load(Ordering::Acquire) != HANDOVER_MAGIC
            || self.version.load(Ordering::Relaxed) != HANDOVER_VERSION
        {
            return None;
        }
        for _ in 0..64 {
            let before = self.seq.load(Ordering::Acquire);
            if before % 2 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let slot = self.latest_slot.load(Ordering::Relaxed);
            let scene_revision = self.scene_revision.load(Ordering::Relaxed);
            let snapshot = HandoverSnapshot {
                retired: self.retired.load(Ordering::Relaxed),
                frames_published: self.frames_published.load(Ordering::Relaxed),
                frame: HandoverFrame {
                    media_sequence: self.media_sequence.load(Ordering::Relaxed),
                    scene_revision: (scene_revision != HANDOVER_NO_SCENE_REVISION)
                        .then_some(scene_revision),
                    published_qpc: self.published_qpc.load(Ordering::Relaxed),
                    width: self.width.load(Ordering::Relaxed),
                    height: self.height.load(Ordering::Relaxed),
                    slot: (slot != HANDOVER_NO_SLOT).then_some(slot),
                },
                texture_generation: self.texture_generation.load(Ordering::Relaxed),
                texture_width: self.texture_width.load(Ordering::Relaxed),
                texture_height: self.texture_height.load(Ordering::Relaxed),
                slot_handles: std::array::from_fn(|index| {
                    self.slot_handles[index].load(Ordering::Relaxed)
                }),
                frames_dropped: self.frames_dropped.load(Ordering::Relaxed),
            };
            fence(Ordering::Acquire);
            if self.seq.load(Ordering::Relaxed) == before {
                return Some(snapshot);
            }
        }
        None
    }
}

/// What route (b) does with a frame, given its texture set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextureSetAction {
    /// The set fits the frame.
    Use,
    /// No set yet, or a new size the app is ready for: make a new set.
    Create,
    /// A new size, but the app has not opened the current set yet: drop the
    /// frame rather than duplicate handles it would never see.
    WaitForAdoption,
}

pub(crate) fn texture_set_action(
    current: Option<(u32, u32)>,
    frame: (u32, u32),
    generation: u64,
    seen_by_app: u64,
) -> TextureSetAction {
    match current {
        Some(size) if size == frame => TextureSetAction::Use,
        Some(_) if seen_by_app != generation => TextureSetAction::WaitForAdoption,
        _ => TextureSetAction::Create,
    }
}

/// The slots route (b) may write, in the order to try them: every slot but
/// the latest, starting after it.
pub(crate) fn writable_slots(latest: Option<u32>, count: u32) -> impl Iterator<Item = u32> {
    let start = latest.map_or(0, |slot| slot + 1);
    (0..count)
        .map(move |offset| (start + offset) % count.max(1))
        .filter(move |slot| Some(*slot) != latest)
}

#[cfg(target_os = "windows")]
#[path = "windows_d3d11_preview_handover_runtime.rs"]
mod runtime;
#[cfg(target_os = "windows")]
pub(crate) use runtime::{WindowsD3d11PreviewHandover, WindowsD3d11PreviewHandoverGrant};

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    #[test]
    fn preview_handover_header_layout_is_the_documented_one() {
        assert_eq!(offset_of!(HandoverHeader, magic), 0);
        assert_eq!(offset_of!(HandoverHeader, version), 8);
        assert_eq!(offset_of!(HandoverHeader, route), 12);
        assert_eq!(offset_of!(HandoverHeader, retired), 16);
        assert_eq!(offset_of!(HandoverHeader, slot_count), 20);
        assert_eq!(offset_of!(HandoverHeader, seq), 24);
        assert_eq!(offset_of!(HandoverHeader, frames_published), 32);
        assert_eq!(offset_of!(HandoverHeader, media_sequence), 40);
        assert_eq!(offset_of!(HandoverHeader, scene_revision), 48);
        assert_eq!(offset_of!(HandoverHeader, published_qpc), 56);
        assert_eq!(offset_of!(HandoverHeader, width), 64);
        assert_eq!(offset_of!(HandoverHeader, height), 68);
        assert_eq!(offset_of!(HandoverHeader, latest_slot), 72);
        assert_eq!(offset_of!(HandoverHeader, texture_generation), 80);
        assert_eq!(offset_of!(HandoverHeader, texture_generation_seen), 88);
        assert_eq!(offset_of!(HandoverHeader, slot_handles), 96);
        assert_eq!(offset_of!(HandoverHeader, frames_dropped), 120);
        assert_eq!(offset_of!(HandoverHeader, texture_width), 128);
        assert_eq!(offset_of!(HandoverHeader, texture_height), 132);
        assert_eq!(size_of::<HandoverHeader>(), 136);
    }

    #[test]
    fn preview_handover_header_reads_nothing_before_it_is_initialized() {
        let header = HandoverHeader::default();
        assert_eq!(header.read(), None);
        header.initialize(HandoverRouteCode::SharedTexture);
        let snapshot = header.read().unwrap();
        assert_eq!(snapshot.frames_published, 0);
        assert_eq!(snapshot.frame.slot, None);
        assert_eq!(snapshot.frame.scene_revision, None);
        assert_eq!(header.slot_count.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn preview_handover_header_round_trips_frames_and_texture_sets() {
        let header = HandoverHeader::default();
        header.initialize(HandoverRouteCode::SharedTexture);
        header.publish_textures(1, 3840, 2160, [11, 12, 13]);
        header.publish_frame(HandoverFrame {
            media_sequence: 7,
            scene_revision: Some(4),
            published_qpc: 99,
            width: 3840,
            height: 2160,
            slot: Some(2),
        });
        let snapshot = header.read().unwrap();
        assert_eq!(snapshot.frames_published, 1);
        assert_eq!(snapshot.frame.media_sequence, 7);
        assert_eq!(snapshot.frame.scene_revision, Some(4));
        assert_eq!(snapshot.frame.slot, Some(2));
        assert_eq!(snapshot.texture_generation, 1);
        assert_eq!(
            (snapshot.texture_width, snapshot.texture_height),
            (3840, 2160)
        );
        assert_eq!(snapshot.slot_handles, [11, 12, 13]);
        assert_eq!(header.seq.load(Ordering::Relaxed) % 2, 0);
        // A new set clears the latest slot, which named the old set's slot.
        header.publish_textures(2, 1920, 1080, [21, 22, 23]);
        let snapshot = header.read().unwrap();
        assert_eq!(snapshot.frame.slot, None);
        assert_eq!(snapshot.texture_generation, 2);
    }

    #[test]
    fn preview_handover_header_refuses_a_torn_read() {
        let header = HandoverHeader::default();
        header.initialize(HandoverRouteCode::CompositionSurface);
        header.seq.store(1, Ordering::Relaxed);
        assert_eq!(header.read(), None, "an odd seq is a write in progress");
        header.seq.store(2, Ordering::Relaxed);
        assert!(header.read().is_some());
    }

    #[test]
    fn preview_handover_header_reader_never_sees_a_half_written_frame() {
        let header = std::sync::Arc::new(HandoverHeader::default());
        header.initialize(HandoverRouteCode::CompositionSurface);
        let writer = {
            let header = std::sync::Arc::clone(&header);
            std::thread::spawn(move || {
                for sequence in 1..=20_000_u64 {
                    header.publish_frame(HandoverFrame {
                        media_sequence: sequence,
                        scene_revision: Some(sequence),
                        published_qpc: sequence,
                        width: sequence as u32,
                        height: sequence as u32,
                        slot: None,
                    });
                }
            })
        };
        let mut consistent = 0;
        while !writer.is_finished() {
            if let Some(snapshot) = header.read() {
                let frame = snapshot.frame;
                if frame.media_sequence != 0 {
                    assert_eq!(frame.scene_revision, Some(frame.media_sequence));
                    assert_eq!(frame.published_qpc, frame.media_sequence);
                    assert_eq!(u64::from(frame.width), frame.media_sequence);
                    assert_eq!(snapshot.frames_published, frame.media_sequence);
                }
                consistent += 1;
            }
        }
        writer.join().unwrap();
        assert!(consistent > 0);
        assert_eq!(header.read().unwrap().frames_published, 20_000);
    }

    #[test]
    fn preview_handover_retire_keeps_the_first_reason() {
        let header = HandoverHeader::default();
        header.initialize(HandoverRouteCode::CompositionSurface);
        header.retire(HandoverRetireReason::Failed);
        header.retire(HandoverRetireReason::Closed);
        assert_eq!(header.read().unwrap().retired, 3);
    }

    #[test]
    fn preview_handover_new_size_waits_until_the_app_adopted_the_current_set() {
        use TextureSetAction::*;
        assert_eq!(texture_set_action(None, (1920, 1080), 0, 0), Create);
        assert_eq!(
            texture_set_action(Some((1920, 1080)), (1920, 1080), 1, 0),
            Use
        );
        assert_eq!(
            texture_set_action(Some((1920, 1080)), (3840, 2160), 1, 0),
            WaitForAdoption
        );
        assert_eq!(
            texture_set_action(Some((1920, 1080)), (3840, 2160), 1, 1),
            Create
        );
    }

    #[test]
    fn preview_handover_writer_never_picks_the_latest_slot() {
        let order = |latest| writable_slots(latest, 3).collect::<Vec<_>>();
        assert_eq!(order(None), vec![0, 1, 2]);
        assert_eq!(order(Some(0)), vec![1, 2]);
        assert_eq!(order(Some(1)), vec![2, 0]);
        assert_eq!(order(Some(2)), vec![0, 1]);
    }
}
