//! Plan 260 S1.6b part 5c: the bus's levels as the microphone rows read
//! them (`audio.levels`, about 20 a second): each tap's peak for the
//! meters, the silence watchdog's report, and when the last reading
//! arrived (`isLive`). From `videorc-rust`'s `inspector::MicLevels`, without
//! the Session line's sliver bars (they land with the Session section).
//!
//! The levels move apart from the snapshot ([`super::Studio::mic_levels`]):
//! they change far more often than anything else the Studio holds.

use std::time::{Duration, Instant};

use serde_json::Value;

/// How long without `audio.levels` before the meters fall
/// (`BACKEND_AUDIO_LEVELS_STALE_MS`, the levels store's live window).
pub const LEVELS_STALE: Duration = Duration::from_millis(1000);

/// The last `audio.levels`, and when it arrived.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MicLevels {
    pub at: Option<Instant>,
    pub microphone_peak_db: Option<f64>,
    pub system_audio_peak_db: Option<f64>,
    /// The soundboard's sounds as mixed (the Sources page's Sounds).
    pub sounds_peak_db: Option<f64>,
    /// The backend's silence watchdog reports the captured microphone
    /// silent (issue 1064).
    pub microphone_silent: bool,
    /// The levels came from a session's bus (else the standing-by
    /// microphone).
    pub from_session: bool,
}

fn peak_db(event: &Value, tap: &str) -> Option<f64> {
    event
        .get(tap)?
        .get("peakDb")
        .and_then(Value::as_f64)
        .filter(|db| db.is_finite())
}

impl MicLevels {
    /// One `audio.levels` event, arrived at `now`.
    pub fn read(&mut self, event: &Value, now: Instant) {
        self.microphone_peak_db = peak_db(event, "microphone");
        self.system_audio_peak_db = peak_db(event, "systemAudio");
        self.sounds_peak_db = peak_db(event, "sounds");
        self.microphone_silent =
            event.get("microphoneSilent").and_then(Value::as_bool) == Some(true);
        self.from_session = event.get("sessionId").is_some_and(Value::is_string);
        self.at = Some(now);
    }

    /// The levels keep arriving (`isLive`).
    pub fn live_at(&self, now: Instant) -> bool {
        self.at
            .is_some_and(|at| now.saturating_duration_since(at) <= LEVELS_STALE)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_reading_keeps_each_taps_peak_and_falls_stale_after_a_second() {
        let now = Instant::now();
        let mut levels = MicLevels::default();
        assert!(!levels.live_at(now));
        levels.read(
            &json!({
                "sessionId": "s1",
                "microphone": {"peakDb": -12.5, "rmsDb": -18.0},
                "systemAudio": {"peakDb": -30.0},
                "microphoneSilent": true
            }),
            now,
        );
        assert_eq!(levels.microphone_peak_db, Some(-12.5));
        assert_eq!(levels.system_audio_peak_db, Some(-30.0));
        assert_eq!(levels.sounds_peak_db, None);
        assert!(levels.microphone_silent && levels.from_session);
        assert!(levels.live_at(now + Duration::from_millis(1000)));
        assert!(!levels.live_at(now + Duration::from_millis(1001)));
    }
}
