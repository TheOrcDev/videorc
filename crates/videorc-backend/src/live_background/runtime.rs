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

use std::sync::Mutex as StdMutex;
use std::time::Instant;

use super::clock::LiveBackgroundClock;
use super::looks::LiveLook;
use crate::protocol::{EffectiveSceneBackground, LiveBackgroundSpec, LiveBackgroundStatus};

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
    /// This tick's input for the background the runtime follows.
    pub fn frame_input(&self, background: &EffectiveSceneBackground) -> LiveBackgroundFrameInput {
        let (look, requested_look) = super::resolve(&self.spec);
        LiveBackgroundFrameInput {
            spec: self.spec.clone(),
            look,
            requested_look,
            clock: self.clock.clone(),
            dim: (background.dim_percent / 100.0).clamp(0.0, 0.8) as f32,
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
        let input = slot.unwrap().frame_input(&background);
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
    fn the_board_starts_empty_and_clears() {
        let board = LiveBackgroundBoard::default();
        assert_eq!(board.snapshot(), (None, 0, 0));
        board.set_resources(2, 1024);
        assert_eq!(board.snapshot().1, 2);
        board.clear();
        assert_eq!(board.snapshot(), (None, 0, 0));
    }
}
