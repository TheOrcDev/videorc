//! Bounded, leased snapshots for the three local outputs of an ISO take.
//! Compositor publication never waits for readers. Readers latch a completed
//! compositor tick by CFR index; a slow reader cannot pin unbounded history.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::{CompositorFrameExportHandle, CompositorPixelFormat};
use crate::frame_store::FrameHandle;

type Handle = FrameHandle<CompositorPixelFormat, CompositorFrameExportHandle>;
pub(crate) const COMBINED: usize = 0;
pub(crate) const SCREEN: usize = 1;
pub(crate) const CAMERA: usize = 2;
const MEMBERS: usize = 3;
const INDEXED_BATCHES: u64 = 2;

pub(crate) struct SourceIsoLeasedFrame {
    pub frame: Handle,
    #[cfg(target_os = "macos")]
    _native_lease: Option<crate::metal_compositor::MetalTargetInFlightGuard>,
}

impl std::fmt::Debug for SourceIsoLeasedFrame {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SourceIsoLeasedFrame")
            .field("sequence", &self.frame.sequence)
            .finish()
    }
}

impl SourceIsoLeasedFrame {
    // Called on the compositor thread before it can compose the next tick.
    fn new(frame: Handle) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(target_os = "macos")]
            _native_lease: frame
                .metadata
                .metal_target_pixel_buffer()
                .map(|target| target.begin_in_flight()),
            frame,
        })
    }
}

#[derive(Clone, Debug)]
struct SourceIsoCompletedBatch {
    generation: u64,
    pub frames: [Option<Arc<SourceIsoLeasedFrame>>; MEMBERS],
}

#[derive(Clone, Copy)]
pub(crate) struct SourceIsoFrameTiming {
    pub captured_at: Instant,
    pub presented_at: Instant,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SourceIsoBatchMembership {
    generation: u64,
    pub active: [bool; MEMBERS],
}

#[derive(Debug)]
struct BatchState {
    membership: SourceIsoBatchMembership,
    latest: Option<SourceIsoCompletedBatch>,
    indexed: VecDeque<(u64, SourceIsoCompletedBatch)>,
    highest_index: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct SourceIsoBatchStore {
    state: Mutex<BatchState>,
}

impl Default for SourceIsoBatchStore {
    fn default() -> Self {
        Self {
            state: Mutex::new(BatchState {
                membership: SourceIsoBatchMembership {
                    generation: 0,
                    active: [true; MEMBERS],
                },
                latest: None,
                indexed: VecDeque::new(),
                highest_index: None,
            }),
        }
    }
}

impl SourceIsoBatchStore {
    pub fn membership(&self) -> SourceIsoBatchMembership {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .membership
    }

    /// Promote only a completely rendered tick. Held/busy targets never become
    /// fresh evidence. Native pins are acquired outside the shared lock while
    /// the compositor still owns this tick, before any target can be reused.
    pub fn publish(
        &self,
        membership: SourceIsoBatchMembership,
        sequence: u64,
        frames: [Option<Handle>; MEMBERS],
    ) -> bool {
        if !membership.active.iter().any(|active| *active)
            || frames.iter().zip(membership.active).any(|(frame, active)| {
                active
                    && frame
                        .as_ref()
                        .is_none_or(|frame| frame.sequence != sequence)
            })
        {
            return false;
        }
        let candidate = SourceIsoCompletedBatch {
            generation: membership.generation,
            frames: std::array::from_fn(|role| {
                membership.active[role]
                    .then(|| frames[role].clone().map(SourceIsoLeasedFrame::new))
                    .flatten()
            }),
        };
        let retired = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.membership.generation != membership.generation {
                return false;
            }
            state.latest.replace(candidate)
        };
        drop(retired);
        true
    }

    /// The first reader fixes this CFR index for all live local outputs. The
    /// eligibility predicate only sees copied clock metadata, never native
    /// leases. It must be pure, bounded and may not acquire any other lock.
    pub fn select(
        &self,
        index: u64,
        role: usize,
        eligible: impl FnOnce([Option<SourceIsoFrameTiming>; MEMBERS]) -> bool,
    ) -> Result<Option<Arc<SourceIsoLeasedFrame>>, &'static str> {
        let mut retired = Vec::new();
        let selected = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if !state.membership.active[role] {
                return Err("ISO output left the completed-frame batch");
            }
            if state
                .highest_index
                .is_some_and(|highest| index < highest.saturating_sub(INDEXED_BATCHES - 1))
            {
                return Err("ISO output fell behind the bounded completed-frame history");
            }
            if let Some((_, batch)) = state.indexed.iter().find(|(at, _)| *at == index) {
                return Ok(batch.frames[role].clone());
            }
            let Some(candidate) = state.latest.as_ref() else {
                return Ok(None);
            };
            let timing = std::array::from_fn(|role| {
                candidate.frames[role]
                    .as_ref()
                    .map(|frame| SourceIsoFrameTiming {
                        captured_at: frame.frame.captured_at,
                        presented_at: frame
                            .frame
                            .metadata
                            .presentation_at()
                            .unwrap_or(frame.frame.captured_at),
                    })
            });
            if !eligible(timing) {
                return Ok(None);
            }
            let candidate = candidate.clone();
            let selected = candidate.frames[role].clone();
            let highest = state
                .highest_index
                .map_or(index, |previous| previous.max(index));
            state.highest_index = Some(highest);
            state.indexed.push_back((index, candidate));
            let floor = highest.saturating_sub(INDEXED_BATCHES - 1);
            let mut position = 0;
            while position < state.indexed.len() {
                if state.indexed[position].0 < floor {
                    retired.push(state.indexed.remove(position).unwrap());
                } else {
                    position += 1;
                }
            }
            selected
        };
        drop(retired);
        Ok(selected)
    }

    /// Membership is terminal for this take: re-adding a source does not
    /// resurrect its recording. Return a pre-boundary snapshot for a local
    /// removal tail, then release all coordinator-held leases for this role.
    pub fn retire(
        &self,
        role: usize,
        boundary: Option<Instant>,
    ) -> Option<Arc<SourceIsoLeasedFrame>> {
        let mut retired = Vec::new();
        let eligible = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if !state.membership.active[role] {
                return None;
            }
            let eligible = boundary.and_then(|boundary| {
                state
                    .latest
                    .iter()
                    .chain(state.indexed.iter().map(|(_, batch)| batch))
                    .filter_map(|batch| batch.frames[role].as_ref())
                    .filter(|frame| frame.frame.captured_at <= boundary)
                    .max_by_key(|frame| frame.frame.sequence)
                    .cloned()
            });
            state.membership.active[role] = false;
            state.membership.generation += 1;
            let generation = state.membership.generation;
            if let Some(batch) = state.latest.as_mut() {
                retired.extend(batch.frames[role].take());
                batch.generation = generation;
            }
            for (_, batch) in &mut state.indexed {
                retired.extend(batch.frames[role].take());
                batch.generation = generation;
            }
            eligible
        };
        drop(retired);
        eligible
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::FrameStore;
    use std::time::Duration;

    fn frames(sequence: u64, at: Instant) -> [Option<Handle>; MEMBERS] {
        std::array::from_fn(|role| {
            let mut store = FrameStore::new(1);
            store.publish_with_metadata(
                sequence,
                2,
                2,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                CompositorFrameExportHandle::default().with_presentation_time(at),
                at - Duration::from_millis(role as u64),
                vec![sequence as u8; 6],
            );
            store.latest()
        })
    }

    #[test]
    fn source_iso_completed_batch_latches_a_tick_across_interleaved_publication() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        assert!(store.publish(store.membership(), 145, frames(145, at)));
        let mut partial = frames(146, at + Duration::from_millis(16));
        partial[CAMERA] = frames(145, at)[CAMERA].take();
        assert!(!store.publish(store.membership(), 146, partial));
        let combined = store.select(129, COMBINED, |_| true).unwrap().unwrap();
        assert!(store.publish(
            store.membership(),
            146,
            frames(146, at + Duration::from_millis(16))
        ));
        let camera = store.select(129, CAMERA, |_| true).unwrap().unwrap();
        assert_eq!(combined.frame.sequence, 145);
        assert_eq!(camera.frame.sequence, 145);
        assert_eq!(camera.frame.captured_at, at - Duration::from_millis(2));
        assert_eq!(
            store
                .select(130, SCREEN, |_| true)
                .unwrap()
                .unwrap()
                .frame
                .sequence,
            146
        );
    }

    #[test]
    fn source_iso_completed_batches_bound_history_and_retire_members_permanently() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        for index in 0..4 {
            store.publish(store.membership(), index + 10, frames(index + 10, at));
            store.select(index, COMBINED, |_| true).unwrap();
        }
        assert!(
            store
                .select(1, CAMERA, |_| true)
                .unwrap_err()
                .contains("bounded")
        );
        assert_eq!(store.state.lock().unwrap().indexed.len(), 2);
        let stale_membership = store.membership();
        assert!(store.retire(CAMERA, Some(at)).is_some());
        assert!(store.select(3, CAMERA, |_| true).is_err());
        assert!(!store.publish(stale_membership, 14, frames(14, at)));
        let mut remaining = frames(14, at);
        remaining[CAMERA] = None;
        assert!(store.publish(store.membership(), 14, remaining));
        assert_eq!(
            store
                .select(4, SCREEN, |_| true)
                .unwrap()
                .unwrap()
                .frame
                .sequence,
            14
        );
        store.retire(SCREEN, None);
        store.retire(COMBINED, None);
        let state = store.state.lock().unwrap();
        assert!(
            state
                .latest
                .as_ref()
                .unwrap()
                .frames
                .iter()
                .all(Option::is_none)
        );
        assert!(
            state
                .indexed
                .iter()
                .all(|(_, batch)| batch.frames.iter().all(Option::is_none))
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn source_iso_completed_batch_native_leases_hold_at_ring_cap_and_resume() {
        let Some(mut gpu) = crate::metal_compositor::MetalSceneCompositor::new() else {
            return;
        };
        let batches = SourceIsoBatchStore::default();
        batches.retire(SCREEN, None);
        batches.retire(CAMERA, None);
        let mut encoder_guards = Vec::new();
        let at = Instant::now();
        let mut freed_surface = None;
        for sequence in 1..=5 {
            let pixels = gpu
                .compose_bgra(8, 4, [sequence as f64 / 5.0, 0.0, 0.0, 1.0], &[])
                .unwrap();
            let target = gpu.latest_target_pixel_buffer().expect("native target");
            if sequence <= 2 {
                if sequence == 2 {
                    freed_surface = target.iosurface_id();
                }
                encoder_guards.push(target.begin_in_flight());
            } else {
                let mut frames = FrameStore::new(1);
                frames.publish_with_metadata(
                    sequence,
                    8,
                    4,
                    CompositorPixelFormat::yuv420p_with_metal_iosurface_target(8, 4),
                    CompositorFrameExportHandle::metal_target(target).with_presentation_time(at),
                    at,
                    pixels,
                );
                assert!(batches.publish(
                    batches.membership(),
                    sequence,
                    [frames.latest(), None, None]
                ));
                if sequence < 5 {
                    batches.select(sequence - 3, COMBINED, |_| true).unwrap();
                }
            }
        }
        // Two old VT targets plus two indexed batches and latest consume the
        // existing five slots. A sixth render must hold, never overwrite.
        assert!(gpu.compose_bgra(8, 4, [0.0, 1.0, 0.0, 1.0], &[]).is_none());
        assert!(gpu.target_ring_busy());
        let selected = batches.select(1, COMBINED, |_| true).unwrap().unwrap();
        assert_eq!(selected.frame.sequence, 4);
        assert_eq!(selected.frame.captured_at, at);
        encoder_guards.pop();
        assert!(gpu.compose_bgra(8, 4, [0.0, 1.0, 0.0, 1.0], &[]).is_some());
        assert_eq!(
            gpu.latest_target_pixel_buffer().unwrap().iosurface_id(),
            freed_surface
        );
        drop(selected);
        batches.retire(COMBINED, None);
        drop(encoder_guards);
        // All indexed, latest, selected and VT ownership has been released.
        for _ in 0..10 {
            assert!(gpu.compose_bgra(8, 4, [0.0, 0.0, 0.0, 1.0], &[]).is_some());
        }
    }
}
