//! Bounded, leased snapshots for the three local outputs of an ISO take.
//! Compositor publication never waits for readers. Readers latch a completed
//! compositor tick by CFR index; a slow reader cannot pin unbounded history.
//!
//! Plan 200 D1: Combined is never the output that fails. When any member
//! falls behind, the Screen and Camera members shed first (each ends at its
//! own last latched tick) and Combined continues alone.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{CompositorFrameExportHandle, CompositorPixelFormat};
use crate::frame_store::FrameHandle;

type Handle = FrameHandle<CompositorPixelFormat, CompositorFrameExportHandle>;
pub(crate) const COMBINED: usize = 0;
pub(crate) const SCREEN: usize = 1;
pub(crate) const CAMERA: usize = 2;
const MEMBERS: usize = 3;
const INDEXED_BATCHES: u64 = 2;
/// The separate files, which shed before Combined (plan 200 D1).
const SEPARATE_MEMBERS: [usize; 2] = [SCREEN, CAMERA];
pub(crate) const FELL_BEHIND: &str = "ISO output fell behind the bounded completed-frame history";
pub(crate) const LEFT_BATCH: &str = "ISO output left the completed-frame batch";

/// The content-clock instant a shed role's file ends at: the end of its
/// `frames`-th CFR frame from the take's epoch. Integer nanoseconds, so the
/// writer's terminal check (`ceil(elapsed * fps)`) lands on `frames` exactly.
pub(crate) fn source_iso_frame_boundary(epoch: Instant, fps: u32, frames: u64) -> Instant {
    let nanos = u128::from(frames) * 1_000_000_000 / u128::from(fps.max(1));
    epoch + Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

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
    /// The highest CFR index each member latched (plan 200 D1).
    last_index: [Option<u64>; MEMBERS],
    /// Frames a shed member's file keeps: its last latched index plus one.
    shed_frames: [Option<u64>; MEMBERS],
    /// The take's one shed notice has been claimed.
    shed_reported: bool,
}

impl BatchState {
    /// Plan 200 D1: retire every still-active separate member at its own last
    /// latched tick and rebase the history on Combined, which continues alone
    /// (or as the only member left). Leases move into `retired` so the caller
    /// drops them outside the lock. False when no separate member was active.
    fn shed_separate_members(&mut self, retired: &mut Vec<Arc<SourceIsoLeasedFrame>>) -> bool {
        let mut shed = false;
        for role in SEPARATE_MEMBERS {
            if self.membership.active[role] {
                self.membership.active[role] = false;
                self.shed_frames[role] = Some(self.last_index[role].map_or(0, |index| index + 1));
                shed = true;
            }
        }
        if !shed {
            return false;
        }
        self.membership.generation += 1;
        let generation = self.membership.generation;
        if let Some(batch) = self.latest.as_mut() {
            for role in SEPARATE_MEMBERS {
                retired.extend(batch.frames[role].take());
            }
            batch.generation = generation;
        }
        // Older latched ticks were fixed for the slowest member; Combined's
        // later indices read the newest completed tick instead of an older
        // latched one, so its content never steps backwards.
        retired.extend(
            self.indexed
                .drain(..)
                .flat_map(|(_, batch)| batch.frames.into_iter().flatten()),
        );
        self.highest_index = self.last_index[COMBINED];
        true
    }

    fn behind(&self, index: u64) -> bool {
        self.highest_index
            .is_some_and(|highest| index < highest.saturating_sub(INDEXED_BATCHES - 1))
    }
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
                last_index: [None; MEMBERS],
                shed_frames: [None; MEMBERS],
                shed_reported: false,
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
        // Declared before the guard so shed leases drop after it unlocks.
        let mut shed_leases = Vec::new();
        let selected = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if !state.membership.active[role] {
                return Err(LEFT_BATCH);
            }
            if state.behind(index) {
                // Plan 200 D1: the separate files shed first. A lagging
                // separate member ends here; a lagging Combined continues on
                // the rebased history. Only a Combined with no separate
                // member left to shed reports the lag.
                if !state.shed_separate_members(&mut shed_leases) {
                    return Err(FELL_BEHIND);
                }
                if role != COMBINED {
                    return Err(LEFT_BATCH);
                }
            }
            if let Some(selected) = state
                .indexed
                .iter()
                .find(|(at, _)| *at == index)
                .map(|(_, batch)| batch.frames[role].clone())
            {
                state.last_index[role] =
                    Some(state.last_index[role].map_or(index, |at| at.max(index)));
                return Ok(selected);
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
            state.last_index[role] = Some(state.last_index[role].map_or(index, |at| at.max(index)));
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
        drop(shed_leases);
        Ok(selected)
    }

    /// Plan 200 D1: an encoder fell behind real time (the bridge's lag
    /// trigger). Shed the separate files so Combined keeps up. True when this
    /// call shed at least one member.
    pub fn shed_separate_files(&self) -> bool {
        let mut retired = Vec::new();
        let shed = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .shed_separate_members(&mut retired);
        drop(retired);
        shed
    }

    /// Frames a shed member's file keeps, or `None` while it records (or
    /// when it left the batch any other way).
    pub fn shed_frames(&self, role: usize) -> Option<u64> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .shed_frames[role]
    }

    /// The take's one shed notice: true for exactly one caller after a shed.
    pub fn claim_shed_report(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let claim = !state.shed_reported && state.shed_frames.iter().any(Option::is_some);
        state.shed_reported |= claim;
        claim
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
        // A member that falls behind this history sheds the separate files
        // (plan 200 D1, covered below); here every member keeps up.
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
    /// Screen and Camera latch indices 0..=3 while Combined stays at 0.
    fn separate_files_ahead_of_combined(store: &SourceIsoBatchStore, at: Instant) {
        for index in 0..4 {
            assert!(store.publish(store.membership(), index + 10, frames(index + 10, at)));
            if index == 0 {
                store.select(0, COMBINED, |_| true).unwrap();
            }
            store.select(index, SCREEN, |_| true).unwrap();
            store.select(index, CAMERA, |_| true).unwrap();
        }
    }

    #[test]
    fn a_lagging_combined_sheds_the_separate_files_and_keeps_recording() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        separate_files_ahead_of_combined(&store, at);
        assert!(!store.claim_shed_report(), "nothing shed yet");
        // Index 1 is past the two-tick history the separate files fixed.
        // Before plan 200 this was Combined's terminal error.
        let combined = store
            .select(1, COMBINED, |_| true)
            .expect("Combined never fails while separate files can shed")
            .expect("the newest completed tick");
        assert_eq!(combined.frame.sequence, 13);
        assert_eq!(store.membership().active, [true, false, false]);
        // Each separate file ends at its own last latched tick.
        assert_eq!(store.shed_frames(SCREEN), Some(4));
        assert_eq!(store.shed_frames(CAMERA), Some(4));
        assert_eq!(store.shed_frames(COMBINED), None);
        assert_eq!(store.select(4, SCREEN, |_| true).unwrap_err(), LEFT_BATCH);
        assert_eq!(store.select(4, CAMERA, |_| true).unwrap_err(), LEFT_BATCH);
        // No separate lease outlives the shed.
        {
            let state = store.state.lock().unwrap();
            assert!(state.indexed.iter().all(|(_, batch)| {
                batch.frames[SCREEN].is_none() && batch.frames[CAMERA].is_none()
            }));
            let latest = state.latest.as_ref().unwrap();
            assert!(latest.frames[SCREEN].is_none() && latest.frames[CAMERA].is_none());
        }
        // Combined continues alone on the rebased history.
        let mut alone = frames(14, at);
        alone[SCREEN] = None;
        alone[CAMERA] = None;
        assert!(store.publish(store.membership(), 14, alone));
        for index in 2..6 {
            let frame = store.select(index, COMBINED, |_| true).unwrap().unwrap();
            assert_eq!(frame.frame.sequence, 14);
        }
        // One notice per take.
        assert!(store.claim_shed_report());
        assert!(!store.claim_shed_report());
        assert!(!store.shed_separate_files(), "nothing left to shed");
    }

    #[test]
    fn a_lagging_separate_file_sheds_both_and_combined_never_sees_the_lag() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        for index in 0..4 {
            assert!(store.publish(store.membership(), index + 10, frames(index + 10, at)));
            store.select(index, COMBINED, |_| true).unwrap();
            store.select(index, CAMERA, |_| true).unwrap();
            if index == 0 {
                store.select(0, SCREEN, |_| true).unwrap();
            }
        }
        assert_eq!(store.select(1, SCREEN, |_| true).unwrap_err(), LEFT_BATCH);
        assert_eq!(store.shed_frames(SCREEN), Some(1));
        assert_eq!(store.shed_frames(CAMERA), Some(4));
        let mut alone = frames(14, at);
        alone[SCREEN] = None;
        alone[CAMERA] = None;
        assert!(store.publish(store.membership(), 14, alone));
        assert_eq!(
            store
                .select(4, COMBINED, |_| true)
                .unwrap()
                .unwrap()
                .frame
                .sequence,
            14
        );
    }

    #[test]
    fn the_lag_trigger_sheds_once_and_a_retired_member_is_not_shed() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        assert!(store.publish(store.membership(), 10, frames(10, at)));
        for role in [COMBINED, SCREEN, CAMERA] {
            store.select(0, role, |_| true).unwrap();
        }
        // A source removal retires Camera first; it never reads as shed.
        store.retire(CAMERA, Some(at));
        assert!(store.shed_separate_files());
        assert_eq!(store.shed_frames(SCREEN), Some(1));
        assert_eq!(store.shed_frames(CAMERA), None);
        assert!(!store.shed_separate_files());
        assert!(store.claim_shed_report());
    }

    #[test]
    fn combined_alone_still_reports_its_lag() {
        let store = SourceIsoBatchStore::default();
        let at = Instant::now();
        store.retire(SCREEN, None);
        store.retire(CAMERA, None);
        let mut alone = frames(10, at);
        alone[SCREEN] = None;
        alone[CAMERA] = None;
        assert!(store.publish(store.membership(), 10, alone));
        store.select(5, COMBINED, |_| true).unwrap();
        assert_eq!(
            store.select(2, COMBINED, |_| true).unwrap_err(),
            FELL_BEHIND
        );
        assert!(!store.claim_shed_report());
    }

    #[test]
    fn a_shed_boundary_lands_on_its_frame_count() {
        let epoch = Instant::now();
        for fps in [24_u32, 30, 60] {
            for frames in [0_u64, 1, 29, 30, 1_234, 107_999] {
                let boundary = source_iso_frame_boundary(epoch, fps, frames);
                // The writer's terminal check: ceil(elapsed * fps).
                let covered = (boundary.duration_since(epoch).as_nanos() * u128::from(fps))
                    .div_ceil(1_000_000_000);
                assert_eq!(covered, u128::from(frames), "{frames} frames at {fps} fps");
            }
        }
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
