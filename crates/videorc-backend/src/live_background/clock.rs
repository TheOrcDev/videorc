//! The live background phase clock. One clock per compositor run; every leg
//! reads the same phase in the same tick, so preview, recording and stream
//! match frame for frame.

use std::time::Instant;

use super::looks::{look_or_first, motion_factor};
use crate::protocol::{LiveBackgroundId, LiveBackgroundSpec};

#[derive(Debug, Clone)]
pub struct LiveBackgroundClock {
    id: LiveBackgroundId,
    look: String,
    rate: f64,
    anchor: Instant,
    anchor_phase: f64,
}

impl LiveBackgroundClock {
    /// A new clock starts at the look's poster phase, so the first frame is
    /// the poster the streamer clicked.
    pub fn start(spec: &LiveBackgroundSpec, now: Instant) -> Self {
        let (look, _) = look_or_first(spec.id, &spec.look);
        Self {
            id: spec.id,
            look: look.id.to_string(),
            rate: look.rate * motion_factor(spec.motion),
            anchor: now,
            anchor_phase: look.poster_phase,
        }
    }

    /// The phase at `at`, in React Bits time units. Computed in `f64`; the
    /// shaders take `f32` (steps of 0.002–0.008 after 12 hours, invisible).
    pub fn phase_at(&self, at: Instant) -> f64 {
        self.anchor_phase + self.rate * at.saturating_duration_since(self.anchor).as_secs_f64()
    }

    /// Follow a new spec without a jump: the same background keeps its phase
    /// and changes only its rate (look or motion); a different background
    /// starts again at its poster phase. Returns whether anything changed.
    pub fn update(&mut self, spec: &LiveBackgroundSpec, now: Instant) -> bool {
        let (look, _) = look_or_first(spec.id, &spec.look);
        let rate = look.rate * motion_factor(spec.motion);
        if spec.id != self.id {
            *self = Self::start(spec, now);
            return true;
        }
        if look.id == self.look && rate == self.rate {
            return false;
        }
        self.anchor_phase = self.phase_at(now);
        self.anchor = now;
        self.rate = rate;
        self.look = look.id.to_string();
        true
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::protocol::LiveBackgroundMotion;

    fn spec(id: LiveBackgroundId, look: &str, motion: LiveBackgroundMotion) -> LiveBackgroundSpec {
        LiveBackgroundSpec {
            id,
            look: look.to_string(),
            motion,
        }
    }

    #[test]
    fn a_new_clock_starts_at_the_poster_and_calm_is_half_speed() {
        let now = Instant::now();
        let calm = LiveBackgroundClock::start(
            &spec(LiveBackgroundId::Silk, "satin", LiveBackgroundMotion::Calm),
            now,
        );
        assert_eq!(calm.phase_at(now), 3.0);
        assert!((calm.phase_at(now + Duration::from_secs(10)) - 5.5).abs() < 1e-9);
        let normal = LiveBackgroundClock::start(
            &spec(
                LiveBackgroundId::Silk,
                "satin",
                LiveBackgroundMotion::Normal,
            ),
            now,
        );
        assert!((normal.phase_at(now + Duration::from_secs(10)) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn changing_look_or_motion_never_jumps() {
        let now = Instant::now();
        let mut clock = LiveBackgroundClock::start(
            &spec(LiveBackgroundId::Silk, "satin", LiveBackgroundMotion::Calm),
            now,
        );
        let switch = now + Duration::from_secs(7);
        let before = clock.phase_at(switch);
        assert!(clock.update(
            &spec(
                LiveBackgroundId::Silk,
                "midnight",
                LiveBackgroundMotion::Normal
            ),
            switch
        ));
        assert!((clock.phase_at(switch) - before).abs() < 1e-9);
        // Midnight's speed 3.5 → 0.35 per second at Normal.
        assert!((clock.phase_at(switch + Duration::from_secs(1)) - before - 0.35).abs() < 1e-9);
        assert!(!clock.update(
            &spec(
                LiveBackgroundId::Silk,
                "midnight",
                LiveBackgroundMotion::Normal
            ),
            switch
        ));
    }

    #[test]
    fn another_background_starts_again_at_its_poster() {
        let now = Instant::now();
        let mut clock = LiveBackgroundClock::start(
            &spec(LiveBackgroundId::Silk, "satin", LiveBackgroundMotion::Calm),
            now,
        );
        let later = now + Duration::from_secs(30);
        clock.update(
            &spec(
                LiveBackgroundId::PlasmaWave,
                "ember",
                LiveBackgroundMotion::Calm,
            ),
            later,
        );
        assert_eq!(clock.phase_at(later), 6.0);
    }

    #[test]
    fn twelve_hours_of_phase_still_resolves_finer_than_a_hundredth() {
        // Side Rays at Normal is the fastest clock (2.5 per second).
        let phase = 2.5 * 12.0 * 3600.0;
        let as_f32 = phase as f32;
        let next = f32::from_bits(as_f32.to_bits() + 1);
        assert!(next - as_f32 < 0.01);
    }
}
