//! The compositor-side plumbing every renderer shares (plan 190).
//!
//! - [`LiveBackgroundRuntime`] lives in `CompositorRuntime`: one phase clock
//!   per compositor run, synced to the scene's `background.live` once per
//!   tick (a single `Option` check while no live background shows).
//! - [`LiveBackgroundFrameInput`] is what a leg draws this tick, cloned into
//!   the render cache: the spec, the resolved look, the clock and Dim.
//! - [`LiveBackgroundBoard`] is where a renderer reports how it draws (shader,
//!   half, still and why) and what it holds (programs, scratch bytes); the
//!   compositor status publishes it.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use super::clock::LiveBackgroundClock;
use super::looks::LiveLook;
use crate::protocol::{EffectiveSceneBackground, LiveBackgroundSpec, LiveBackgroundStatus};

/// The compositor tick a frame input is drawn on: the publish instant every
/// leg of the tick shares (so every leg reads the same phase), the loop's
/// frame interval and whether this tick missed its deadline (the loop's own
/// late-tick signal: a tick gap that skipped an interval, or a previous
/// publish that ran past the interval). The guard reads the last two.
#[derive(Debug, Clone, Copy)]
pub struct LiveBackgroundTick {
    pub at: Instant,
    pub frame_interval: Duration,
    pub missed_deadline: bool,
}

impl LiveBackgroundTick {
    pub fn new(at: Instant, frame_interval: Duration, missed_deadline: bool) -> Self {
        Self {
            at,
            frame_interval,
            missed_deadline,
        }
    }

    /// A tick whose deadline nobody measured (tests, the cache refresh before
    /// the publish stamps the real one): 60 fps, on time.
    pub fn unmeasured(at: Instant) -> Self {
        Self::new(at, Duration::from_nanos(16_666_667), false)
    }
}

#[derive(Debug, Clone)]
pub struct LiveBackgroundRuntime {
    spec: LiveBackgroundSpec,
    clock: LiveBackgroundClock,
}

/// Follow the scene's live spec: start, re-base (look or motion) or stop.
pub fn sync(
    slot: &mut Option<LiveBackgroundRuntime>,
    spec: Option<&LiveBackgroundSpec>,
    now: Instant,
) {
    match (slot.as_mut(), spec) {
        (_, None) => *slot = None,
        (None, Some(spec)) => {
            *slot = Some(LiveBackgroundRuntime {
                spec: spec.clone(),
                clock: LiveBackgroundClock::start(spec, now),
            })
        }
        (Some(runtime), Some(spec)) => {
            if runtime.spec != *spec {
                runtime.clock.update(spec, now);
                runtime.spec = spec.clone();
            }
        }
    }
}

impl LiveBackgroundRuntime {
    /// This tick's input for the background the runtime follows. `board` is
    /// where the leg's renderer reports; `tick` is re-stamped by the publish
    /// with the tick's real instant and deadline.
    pub fn frame_input(
        &self,
        background: &EffectiveSceneBackground,
        board: &Arc<LiveBackgroundBoard>,
        tick: LiveBackgroundTick,
    ) -> LiveBackgroundFrameInput {
        let (look, requested_look) = super::resolve(&self.spec);
        LiveBackgroundFrameInput {
            spec: self.spec.clone(),
            look,
            requested_look,
            clock: self.clock.clone(),
            dim: (background.dim_percent / 100.0).clamp(0.0, 0.8) as f32,
            board: Arc::clone(board),
            tick,
        }
    }
}

/// What a leg draws this tick.
#[derive(Debug, Clone)]
pub struct LiveBackgroundFrameInput {
    pub spec: LiveBackgroundSpec,
    pub look: &'static LiveLook,
    /// The spec's look when this build doesn't know it (status only).
    pub requested_look: Option<String>,
    clock: LiveBackgroundClock,
    /// Dim as 0–0.8.
    pub dim: f32,
    /// Where the leg's renderer reports how it draws and what it holds.
    pub board: Arc<LiveBackgroundBoard>,
    /// The tick this input is drawn on (`phase_at(tick.at)` is its phase).
    pub tick: LiveBackgroundTick,
}

impl LiveBackgroundFrameInput {
    /// The phase at a frame's publish instant; every leg of a tick passes the
    /// same instant, so every leg draws the same frame.
    pub fn phase_at(&self, at: Instant) -> f64 {
        self.clock.phase_at(at)
    }

    /// A status with this input's identity.
    pub fn status(
        &self,
        rendering: crate::protocol::LiveBackgroundRendering,
        reason: Option<crate::protocol::LiveBackgroundStillReason>,
        p95_ms: Option<f64>,
    ) -> LiveBackgroundStatus {
        LiveBackgroundStatus {
            id: self.spec.id,
            look: self.look.id.to_string(),
            rendering,
            reason,
            p95_ms,
            requested_look: self.requested_look.clone(),
        }
    }
}

/// Plan 190 D7: the start notice when the legacy FFmpeg graph (4K60, bridge
/// off) records a live background as its poster.
pub const LEGACY_GRAPH_NOTICE: &str =
    "Live backgrounds move up to 4K30. This session shows yours as a still frame.";

/// The health event when the budget guard falls back to the poster.
pub const GPU_BUDGET_NOTICE: &str =
    "Your graphics card is busy, so the live background is showing a still frame.";

/// Whether a status change is the guard's first fall back to the poster (say
/// it once, not on every status refresh).
pub fn entered_gpu_budget_still(
    previous: Option<&LiveBackgroundStatus>,
    next: Option<&LiveBackgroundStatus>,
) -> bool {
    let budget = |status: Option<&LiveBackgroundStatus>| {
        status.is_some_and(|status| {
            status.reason == Some(crate::protocol::LiveBackgroundStillReason::GpuBudget)
        })
    };
    budget(next) && !budget(previous)
}

/// A finished live frame for the CPU compositor (plan 190 S5): top-down BGRA
/// at the background's internal size, drawn up like a picture. The Linux GLES
/// renderer produces it; the compositor wraps it as an image source.
#[derive(Debug, Clone)]
pub struct CpuLiveFrame {
    pub bgra: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    /// Increments per frame; the CPU path's content revision.
    pub sequence: u64,
    pub rendering: crate::protocol::LiveBackgroundRendering,
}

#[derive(Debug, Default, Clone)]
struct BoardState {
    status: Option<LiveBackgroundStatus>,
    programs: u32,
    scratch_bytes: u64,
}

/// Renderers report here; `try_update_compositor_status` publishes it.
#[derive(Debug, Default)]
pub struct LiveBackgroundBoard {
    state: StdMutex<BoardState>,
}

impl LiveBackgroundBoard {
    pub fn report(&self, status: LiveBackgroundStatus) {
        self.lock().status = Some(status);
    }

    /// Report only when the status differs from the one on the board (the
    /// CPU fallbacks call this every frame).
    pub fn report_if_changed(&self, status: LiveBackgroundStatus) {
        let mut state = self.lock();
        if state.status.as_ref() != Some(&status) {
            state.status = Some(status);
        }
    }

    /// The programs built and scratch bytes held by the live background
    /// renderers of this run (both 0 while no live background shows).
    pub fn set_resources(&self, programs: u32, scratch_bytes: u64) {
        let mut state = self.lock();
        state.programs = programs;
        state.scratch_bytes = scratch_bytes;
    }

    pub fn clear(&self) {
        *self.lock() = BoardState::default();
    }

    pub fn snapshot(&self) -> (Option<LiveBackgroundStatus>, u32, u64) {
        let state = self.lock();
        (state.status.clone(), state.programs, state.scratch_bytes)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BoardState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::protocol::{
        LiveBackgroundId, LiveBackgroundMotion, LiveBackgroundRendering, LiveBackgroundStillReason,
    };

    fn spec(look: &str) -> LiveBackgroundSpec {
        LiveBackgroundSpec {
            id: LiveBackgroundId::Silk,
            look: look.to_string(),
            motion: LiveBackgroundMotion::Calm,
        }
    }

    #[test]
    fn sync_starts_rebases_and_stops() {
        let now = Instant::now();
        let mut slot = None;
        sync(&mut slot, None, now);
        assert!(slot.is_none());
        sync(&mut slot, Some(&spec("satin")), now);
        let started = slot.clone().unwrap();
        assert_eq!(started.clock.phase_at(now), 3.0);
        let later = now + Duration::from_secs(4);
        let before = started.clock.phase_at(later);
        sync(&mut slot, Some(&spec("midnight")), later);
        assert!((slot.as_ref().unwrap().clock.phase_at(later) - before).abs() < 1e-9);
        sync(&mut slot, None, later);
        assert!(slot.is_none());
    }

    #[test]
    fn frame_input_resolves_unknown_looks_and_dim() {
        let now = Instant::now();
        let mut slot = None;
        sync(&mut slot, Some(&spec("lava")), now);
        let background = EffectiveSceneBackground {
            asset_id: "live-silk-satin".to_string(),
            managed_asset_path: "live-silk-satin.webp".to_string(),
            fit: crate::protocol::BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 95.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
            live: Some(spec("lava")),
        };
        let input = slot.unwrap().frame_input(
            &background,
            &Arc::default(),
            LiveBackgroundTick::unmeasured(now),
        );
        assert_eq!(input.look.id, "satin");
        assert_eq!(input.requested_look.as_deref(), Some("lava"));
        assert_eq!(input.dim, 0.8);
        let status = input.status(
            LiveBackgroundRendering::Still,
            Some(LiveBackgroundStillReason::Forced),
            None,
        );
        assert_eq!(status.look, "satin");
        assert_eq!(status.requested_look.as_deref(), Some("lava"));
    }

    #[test]
    fn the_budget_notice_fires_once_on_entering_the_poster() {
        let input = {
            let mut slot = None;
            sync(&mut slot, Some(&spec("satin")), Instant::now());
            slot.unwrap()
        };
        let background = EffectiveSceneBackground {
            asset_id: "live-silk-satin".to_string(),
            managed_asset_path: "live-silk-satin.webp".to_string(),
            fit: crate::protocol::BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
            live: Some(spec("satin")),
        };
        let input = input.frame_input(
            &background,
            &Arc::default(),
            LiveBackgroundTick::unmeasured(Instant::now()),
        );
        let half = input.status(LiveBackgroundRendering::Half, None, Some(4.0));
        let still = input.status(
            LiveBackgroundRendering::Still,
            Some(LiveBackgroundStillReason::GpuBudget),
            Some(5.0),
        );
        let forced = input.status(
            LiveBackgroundRendering::Still,
            Some(LiveBackgroundStillReason::Forced),
            None,
        );
        assert!(entered_gpu_budget_still(Some(&half), Some(&still)));
        assert!(entered_gpu_budget_still(None, Some(&still)));
        assert!(!entered_gpu_budget_still(Some(&still), Some(&still)));
        assert!(!entered_gpu_budget_still(Some(&half), Some(&forced)));
        assert!(!entered_gpu_budget_still(Some(&still), None));
    }

    #[test]
    fn the_board_starts_empty_and_clears() {
        let board = LiveBackgroundBoard::default();
        assert_eq!(board.snapshot(), (None, 0, 0));
        board.set_resources(2, 1024);
        assert_eq!(board.snapshot().1, 2);
        board.clear();
        assert_eq!(board.snapshot(), (None, 0, 0));
    }
}
