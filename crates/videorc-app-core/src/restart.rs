//! The restart policy (`index.ts`, F-014 supervisor): a dead backend used to
//! leave the app a zombie that still reported Ready with a clickable Record
//! button. Restart with backoff; after too many crashes inside the window,
//! stop and say so. Never lie.
//!
//! Pure, so it is unit-tested with a fake clock.

use std::time::{Duration, Instant};

/// `BACKEND_RESTART_BACKOFF_MS`: one delay per attempt; the sixth crash in
/// the window exhausts the budget.
pub const RESTART_BACKOFF: [Duration; 5] = [
    Duration::from_millis(500),
    Duration::from_millis(1_000),
    Duration::from_millis(2_000),
    Duration::from_millis(4_000),
    Duration::from_millis(8_000),
];
/// `BACKEND_RESTART_WINDOW_MS`: crashes older than this no longer count.
pub const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
/// `BACKEND_STABLE_UPTIME_MS`: a generation that ran this long forgives every
/// earlier crash (sleep/wake storms must not permanently exhaust the budget).
pub const STABLE_UPTIME: Duration = Duration::from_secs(60);

/// What to do after an unexpected exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Start generation `attempt` of the ladder after `delay`.
    Restart { attempt: u32, delay: Duration },
    /// The budget is spent: stop restarting and say so.
    GiveUp { attempt: u32 },
}

impl RestartDecision {
    pub fn attempt(&self) -> u32 {
        match self {
            RestartDecision::Restart { attempt, .. } | RestartDecision::GiveUp { attempt } => {
                *attempt
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct RestartPolicy {
    crash_timestamps: Vec<Instant>,
    last_start: Option<Instant>,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// A generation was started at `at` (`backendLastStartAt`).
    pub fn started(&mut self, at: Instant) {
        self.last_start = Some(at);
    }

    /// An unexpected exit at `now`: `scheduleBackendRestart`.
    pub fn on_crash(&mut self, now: Instant) -> RestartDecision {
        if let Some(started) = self.last_start
            && now.saturating_duration_since(started) >= STABLE_UPTIME
        {
            self.crash_timestamps.clear();
        }
        self.crash_timestamps
            .retain(|at| now.saturating_duration_since(*at) < RESTART_WINDOW);
        self.crash_timestamps.push(now);
        let attempt = self.crash_timestamps.len() as u32;
        match RESTART_BACKOFF.get(attempt as usize - 1) {
            Some(delay) => RestartDecision::Restart {
                attempt,
                delay: *delay,
            },
            None => RestartDecision::GiveUp { attempt },
        }
    }

    pub fn ladder_len() -> u32 {
        RESTART_BACKOFF.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_restarts_then_give_up() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for (index, delay) in RESTART_BACKOFF.iter().enumerate() {
            let now = t0 + Duration::from_secs(index as u64);
            policy.started(now);
            assert_eq!(
                policy.on_crash(now + Duration::from_millis(100)),
                RestartDecision::Restart {
                    attempt: index as u32 + 1,
                    delay: *delay
                }
            );
        }
        let now = t0 + Duration::from_secs(10);
        policy.started(now);
        assert_eq!(
            policy.on_crash(now + Duration::from_millis(100)),
            RestartDecision::GiveUp { attempt: 6 }
        );
    }

    #[test]
    fn a_stable_minute_forgives_earlier_crashes() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        policy.started(t0);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(1)).attempt(), 1);
        policy.started(t0 + Duration::from_secs(2));
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(3)).attempt(), 2);
        // The third generation runs for a minute before dying.
        policy.started(t0 + Duration::from_secs(4));
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(64)).attempt(), 1);
    }

    #[test]
    fn crashes_outside_the_window_fall_off() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        policy.started(t0);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(1)).attempt(), 1);
        // Short-lived generations six minutes later: the first crash is gone.
        let later = t0 + RESTART_WINDOW + Duration::from_secs(60);
        policy.started(later);
        assert_eq!(policy.on_crash(later + Duration::from_secs(1)).attempt(), 1);
    }
}
