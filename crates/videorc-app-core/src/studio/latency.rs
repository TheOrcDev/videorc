//! Record start and stop latency (plan 220 S3.1a): a port of
//! `lib/record-latency.ts`'s tracker and `use-studio.tsx`'s
//! `noteRecordClick` / `takeRecordClickEpochMs`.
//!
//! A click (Record, Space, the stop button, End livestream's confirm, a
//! remote key) arms the clock; the next authoritative `recording.status`
//! that completes the transition closes the sample, and `starting` /
//! `stopping` fill the intermediate fields when they arrive first. The
//! click's wall-clock time goes to the backend as `requestedAtMs`, so its
//! own timeline measures from the click. Time is passed in, so the tests
//! drive it.

use std::time::{Duration, Instant};

use videorc_protocol::{RecordingState, RecordingStatus};

/// `RECORD_LATENCY_CLICK_TTL_MS`: a pending click older than this is stale
/// (the request was refused or lost).
pub const CLICK_TTL: Duration = Duration::from_secs(15);

/// `RecordLatencyKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatencyKind {
    Start,
    Stop,
}

/// `RecordLatencyOrigin`: a person's click (or key), or the session call
/// itself when nothing clicked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatencyOrigin {
    Click,
    SessionCall,
}

/// One closed sample (`RecordStartLatencySample` / `RecordStopLatencySample`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatencySample {
    pub kind: LatencyKind,
    pub origin: LatencyOrigin,
    /// Click → starting, or click → stopping, when that status came first.
    pub to_intermediate_ms: Option<u64>,
    /// Click → recording, or click → idle.
    pub to_done_ms: u64,
    pub session_id: Option<String>,
}

impl LatencySample {
    /// `formatRecordLatencyLog`.
    pub fn log_line(&self) -> String {
        let session = self
            .session_id
            .as_deref()
            .map(|id| format!(" (session {id})"))
            .unwrap_or_default();
        match self.kind {
            LatencyKind::Start => {
                let starting = self
                    .to_intermediate_ms
                    .map(|ms| format!("click→starting {ms} ms · "))
                    .unwrap_or_default();
                format!(
                    "[record-latency] start {starting}click→recording {} ms{session}",
                    self.to_done_ms
                )
            }
            LatencyKind::Stop => {
                let stopping = self
                    .to_intermediate_ms
                    .map(|ms| format!("click→stopping {ms} ms · "))
                    .unwrap_or_default();
                format!(
                    "[record-latency] stop {stopping}click→idle {} ms{session}",
                    self.to_done_ms
                )
            }
        }
    }
}

/// The last sample of each kind (`RecordLatencyState`), for Health.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordLatency {
    pub start: Option<LatencySample>,
    pub stop: Option<LatencySample>,
}

#[derive(Debug, Clone, Copy)]
struct Pending {
    at: Instant,
    origin: LatencyOrigin,
    intermediate_at: Option<Instant>,
}

/// `createRecordLatencyTracker`.
#[derive(Debug, Default)]
pub struct LatencyTracker {
    start: Option<Pending>,
    stop: Option<Pending>,
    /// `recordClickAtRef`: a person's click (when, and the wall clock then),
    /// kept for the request's `requestedAtMs` until the request takes it.
    clicked_at: [Option<(Instant, u64)>; 2],
    /// The status the tracker saw last, so a repeat isn't observed twice.
    seen: Option<(std::mem::Discriminant<RecordingState>, Option<String>)>,
    pub last: RecordLatency,
}

fn slot(kind: LatencyKind) -> usize {
    match kind {
        LatencyKind::Start => 0,
        LatencyKind::Stop => 1,
    }
}

fn fresh(pending: Option<Pending>, now: Instant) -> Option<Pending> {
    pending.filter(|click| now.saturating_duration_since(click.at) <= CLICK_TTL)
}

fn ms_between(from: Instant, to: Instant) -> u64 {
    // `Math.round`.
    (to.saturating_duration_since(from).as_secs_f64() * 1000.0).round() as u64
}

impl LatencyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn pending_mut(&mut self, kind: LatencyKind) -> &mut Option<Pending> {
        match kind {
            LatencyKind::Start => &mut self.start,
            LatencyKind::Stop => &mut self.stop,
        }
    }

    /// `noteRecordClick` / `markClick`: arms a click. A second click of the
    /// same kind while a real one is pending is ignored; a session-call mark
    /// keeps an earlier real click. A person's click is also kept for the
    /// request's `requestedAtMs` (`epoch_ms`, the wall clock at `now`).
    pub fn mark(&mut self, kind: LatencyKind, origin: LatencyOrigin, now: Instant, epoch_ms: u64) {
        let current = fresh(*self.pending_mut(kind), now);
        if current.is_some_and(|click| click.origin == LatencyOrigin::Click) {
            return;
        }
        *self.pending_mut(kind) = Some(current.unwrap_or(Pending {
            at: now,
            origin,
            intermediate_at: None,
        }));
        if origin == LatencyOrigin::Click {
            self.clicked_at[slot(kind)] = Some((now, epoch_ms));
        }
    }

    /// `hasPending`.
    pub fn has_pending(&self, kind: LatencyKind) -> bool {
        match kind {
            LatencyKind::Start => self.start.is_some(),
            LatencyKind::Stop => self.stop.is_some(),
        }
    }

    /// `takeRecordClickEpochMs`: the click's wall-clock time for the
    /// request, once; the request's own time when nothing clicked.
    pub fn take_click_epoch_ms(&mut self, kind: LatencyKind, now: Instant, epoch_ms: u64) -> u64 {
        match self.clicked_at[slot(kind)].take() {
            // A click older than the TTL belongs to no request any more.
            Some((at, at_epoch)) if now.saturating_duration_since(at) <= CLICK_TTL => at_epoch,
            _ => epoch_ms,
        }
    }

    /// `observe`: a status the Studio applied. A repeat of the last one is
    /// not observed again. Returns the sample a transition closed.
    pub fn observe(&mut self, status: &RecordingStatus, now: Instant) -> Option<LatencySample> {
        let key = (
            std::mem::discriminant(&status.state),
            status.session_id.clone(),
        );
        if self.seen.as_ref() == Some(&key) {
            return None;
        }
        self.seen = Some(key);
        let start = fresh(self.start, now);
        let stop = fresh(self.stop, now);
        self.start = start;
        self.stop = stop;
        let sample = match status.state {
            RecordingState::Starting => {
                if let Some(click) = self.start.as_mut()
                    && click.intermediate_at.is_none()
                {
                    click.intermediate_at = Some(now);
                }
                None
            }
            RecordingState::Recording | RecordingState::Streaming => {
                let click = self.start.take()?;
                Some(LatencySample {
                    kind: LatencyKind::Start,
                    origin: click.origin,
                    to_intermediate_ms: click.intermediate_at.map(|at| ms_between(click.at, at)),
                    to_done_ms: ms_between(click.at, now),
                    session_id: status.session_id.clone(),
                })
            }
            RecordingState::Stopping => {
                if let Some(click) = self.stop.as_mut()
                    && click.intermediate_at.is_none()
                {
                    click.intermediate_at = Some(now);
                }
                None
            }
            RecordingState::Idle | RecordingState::Failed => {
                // A failed start clears the pending start without a sample.
                if self.start.is_some() && self.stop.is_none() {
                    self.start = None;
                    return None;
                }
                let click = self.stop.take()?;
                self.start = None;
                Some(LatencySample {
                    kind: LatencyKind::Stop,
                    origin: click.origin,
                    to_intermediate_ms: click.intermediate_at.map(|at| ms_between(click.at, at)),
                    to_done_ms: ms_between(click.at, now),
                    session_id: status.session_id.clone(),
                })
            }
        };
        if let Some(sample) = &sample {
            match sample.kind {
                LatencyKind::Start => self.last.start = Some(sample.clone()),
                LatencyKind::Stop => self.last.stop = Some(sample.clone()),
            }
        }
        sample
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::session::initial_status;

    fn status(state: RecordingState, id: Option<&str>) -> RecordingStatus {
        RecordingStatus {
            state,
            session_id: id.map(str::to_string),
            ..initial_status()
        }
    }

    #[test]
    fn a_click_closes_on_the_status_that_completes_it() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut tracker = LatencyTracker::new();
        tracker.mark(LatencyKind::Start, LatencyOrigin::Click, t0, 1_000);
        // The session call marks too; the real click stays the start.
        tracker.mark(LatencyKind::Start, LatencyOrigin::SessionCall, ms(5), 1_005);
        assert!(tracker.has_pending(LatencyKind::Start));
        assert_eq!(
            tracker.observe(&status(RecordingState::Starting, None), ms(12)),
            None
        );
        let sample = tracker
            .observe(&status(RecordingState::Recording, Some("s1")), ms(57))
            .expect("the start closes");
        assert_eq!(
            sample,
            LatencySample {
                kind: LatencyKind::Start,
                origin: LatencyOrigin::Click,
                to_intermediate_ms: Some(12),
                to_done_ms: 57,
                session_id: Some("s1".to_string()),
            }
        );
        assert_eq!(
            sample.log_line(),
            "[record-latency] start click→starting 12 ms · click→recording 57 ms (session s1)"
        );
        assert_eq!(tracker.last.start, Some(sample));
        // A repeat of the same status closes nothing.
        assert_eq!(
            tracker.observe(&status(RecordingState::Recording, Some("s1")), ms(60)),
            None
        );

        tracker.mark(LatencyKind::Stop, LatencyOrigin::Click, ms(1_000), 2_000);
        tracker.observe(&status(RecordingState::Stopping, Some("s1")), ms(1_020));
        let stop = tracker
            .observe(&status(RecordingState::Idle, Some("s1")), ms(1_100))
            .expect("the stop closes");
        assert_eq!(stop.kind, LatencyKind::Stop);
        assert_eq!(stop.to_intermediate_ms, Some(20));
        assert_eq!(stop.to_done_ms, 100);
        assert_eq!(
            stop.log_line(),
            "[record-latency] stop click→stopping 20 ms · click→idle 100 ms (session s1)"
        );
    }

    #[test]
    fn a_refused_start_and_a_stale_click_close_nothing() {
        let t0 = Instant::now();
        let mut tracker = LatencyTracker::new();
        tracker.mark(LatencyKind::Start, LatencyOrigin::Click, t0, 0);
        assert_eq!(
            tracker.observe(&status(RecordingState::Idle, None), t0),
            None
        );
        assert!(
            !tracker.has_pending(LatencyKind::Start),
            "the refusal cleared it"
        );
        tracker.mark(LatencyKind::Start, LatencyOrigin::Click, t0, 0);
        let late = t0 + CLICK_TTL + Duration::from_millis(1);
        assert_eq!(
            tracker.observe(&status(RecordingState::Recording, Some("s")), late),
            None,
            "a click older than the TTL is stale"
        );
    }

    #[test]
    fn the_request_carries_the_click_s_wall_clock_once() {
        let t0 = Instant::now();
        let mut tracker = LatencyTracker::new();
        tracker.mark(LatencyKind::Start, LatencyOrigin::Click, t0, 5_000);
        assert_eq!(
            tracker.take_click_epoch_ms(LatencyKind::Start, t0 + Duration::from_millis(30), 5_030),
            5_000
        );
        assert_eq!(
            tracker.take_click_epoch_ms(LatencyKind::Start, t0, 9_000),
            9_000,
            "taken once; then the request's own time"
        );
        // A session call alone has no click to carry.
        tracker.mark(LatencyKind::Stop, LatencyOrigin::SessionCall, t0, 7_000);
        assert_eq!(
            tracker.take_click_epoch_ms(LatencyKind::Stop, t0, 7_010),
            7_010
        );
    }
}
