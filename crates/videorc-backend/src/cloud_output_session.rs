//! Plan 249 S25: a cloud show's live intervals as output sessions, for the
//! observers that count and report streams (stream report and history,
//! usage stats, Discord, the /live status).
//!
//! The server owns the interval (S16, `CloudStatus::live_interval`). An
//! interval counts as a stream only once a leg went live (`liveSince`), and
//! it is over only when the server says so (`endedAt`), so the time a room
//! is open but off air is never counted. One interval is one stream, however
//! often this computer reconnects, relaunches or resumes during it, and
//! whichever computer controls the show:
//!
//! - every effect is keyed by show and interval, never by a local session
//!   id (a solo resume starts a new local session, the stream goes on);
//! - the ids the web dedupes on (report id, usage event ids) are derived
//!   from show and interval, so another computer derives the same ones;
//! - only the computer that may act for the show (S24
//!   `cloud_controller::ownership_allows`) produces effects.
//!
//! Pure: the observers feed `cloud.state` and act on what comes out.

use std::collections::VecDeque;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::cloud_show::CloudStatus;
use crate::streaming::{StreamPlatform, StreamTargetRuntime, StreamTargetState};

/// One live interval of one show, as this computer saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSession {
    pub show_id: String,
    pub interval_id: String,
    /// `solo` or `talk` (a test show is never a stream).
    pub kind: Option<String>,
    /// The server's time the first leg went live.
    pub live_since: DateTime<Utc>,
    /// The platforms of the interval's real legs (never a "Videorc Cloud"
    /// destination: the cloud is the transport, not a platform).
    pub platforms: Vec<StreamPlatform>,
    /// The local session feeding a solo show, when one does.
    pub local_session_id: Option<String>,
}

impl OutputSession {
    /// The key effects use in place of a local session id.
    pub fn key(&self) -> String {
        interval_key(&self.show_id, &self.interval_id)
    }
}

/// How the interval's end is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndBasis {
    /// The server's `endedAt`.
    Confirmed,
    /// The show or interval disappeared before an `endedAt` reached this
    /// computer: the end is the last time it was seen live, so the duration
    /// is a lower bound and never more than what was observed.
    LastSeen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputEvent {
    /// The interval is live (once per interval and process).
    Live(OutputSession),
    /// The interval ended (once per interval and process). Every consumer
    /// must be idempotent across processes and computers.
    Ended {
        session: OutputSession,
        ended_at: DateTime<Utc>,
        basis: EndBasis,
    },
}

impl OutputEvent {
    pub fn session(&self) -> &OutputSession {
        match self {
            Self::Live(session) | Self::Ended { session, .. } => session,
        }
    }

    /// Seconds on air, for an end.
    pub fn seconds_live(&self) -> Option<i64> {
        match self {
            Self::Ended {
                session, ended_at, ..
            } => Some((*ended_at - session.live_since).num_seconds().max(0)),
            Self::Live(_) => None,
        }
    }
}

const REMEMBERED: usize = 64;

/// Folds `cloud.state` into interval events. One per observer.
#[derive(Debug, Default)]
pub struct OutputSessionTracker {
    open: Option<(OutputSession, DateTime<Utc>)>,
    /// Intervals already announced live, then ended, in this process.
    live: VecDeque<String>,
    ended: VecDeque<String>,
}

fn remember(list: &mut VecDeque<String>, key: String) {
    if list.contains(&key) {
        return;
    }
    list.push_back(key);
    while list.len() > REMEMBERED {
        list.pop_front();
    }
}

fn parse_utc(value: Option<&str>) -> Option<DateTime<Utc>> {
    let value = value?.trim();
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

/// The platforms whose legs reached the platform at least once.
pub fn leg_platforms(legs: &[StreamTargetRuntime]) -> Vec<StreamPlatform> {
    let mut platforms: Vec<StreamPlatform> = Vec::new();
    for leg in legs {
        let reached = matches!(
            leg.state,
            StreamTargetState::Live | StreamTargetState::Warning | StreamTargetState::Reconnecting
        );
        if reached && !platforms.contains(&leg.platform) {
            platforms.push(leg.platform);
        }
    }
    platforms
}

impl OutputSessionTracker {
    /// `allowed(show_id)`: this computer may act for the show (S24). A
    /// computer that lost the show stops producing effects at once; the one
    /// that took it over continues the same interval with the same ids.
    pub fn observe(
        &mut self,
        status: &CloudStatus,
        now: DateTime<Utc>,
        allowed: impl Fn(&str) -> bool,
    ) -> Vec<OutputEvent> {
        let mut events = Vec::new();
        let current = current_interval(status);
        // The open interval is over without its `endedAt` reaching us, and
        // something positive says so: the same show reports another interval,
        // or the show itself ended (cleared with an end reason). A status
        // that only lacks the show (a reconnect, a handoff) ends nothing.
        if let Some((open, last_seen)) = self.open.take() {
            let replaced = current.as_ref().is_some_and(|(session, _)| {
                session.show_id == open.show_id && session.interval_id != open.interval_id
            });
            let show_ended = status.show.is_none() && status.end_reason.is_some();
            if !(replaced || show_ended) {
                self.open = Some((open, last_seen));
            } else if allowed(&open.show_id) {
                remember(&mut self.ended, open.key());
                events.push(OutputEvent::Ended {
                    session: open,
                    ended_at: last_seen,
                    basis: EndBasis::LastSeen,
                });
            }
        }
        let Some((mut session, ended_at)) = current else {
            return events;
        };
        if self
            .open
            .as_ref()
            .is_some_and(|(open, _)| open.show_id != session.show_id)
        {
            // Another show while one is still open here: this tracker follows
            // one stream at a time; the earlier one stays unreported rather
            // than invented to have ended.
            self.open = None;
        }
        if !allowed(&session.show_id) {
            // Lost or never ours: forget, so a takeover back starts clean.
            self.open = None;
            return events;
        }
        let key = session.key();
        if let Some((open, _)) = self.open.as_mut() {
            // Platforms only grow: a leg that went live once was streamed to.
            for platform in &session.platforms {
                if !open.platforms.contains(platform) {
                    open.platforms.push(*platform);
                }
            }
            session.platforms = open.platforms.clone();
        }
        match ended_at {
            None => {
                if !self.ended.contains(&key) {
                    if !self.live.contains(&key) {
                        remember(&mut self.live, key);
                        events.push(OutputEvent::Live(session.clone()));
                    }
                    self.open = Some((session, now));
                }
            }
            Some(ended_at) => {
                self.open = None;
                if !self.ended.contains(&key) {
                    remember(&mut self.ended, key);
                    events.push(OutputEvent::Ended {
                        session,
                        ended_at,
                        basis: EndBasis::Confirmed,
                    });
                }
            }
        }
        events
    }
}

/// The interval this status reports as a stream: a show that is not a test,
/// an interval with an id that went live. `endedAt` comes as the second.
fn current_interval(status: &CloudStatus) -> Option<(OutputSession, Option<DateTime<Utc>>)> {
    let show = status.show.as_ref()?;
    if show.kind.as_deref() == Some("test") {
        return None;
    }
    let interval = status.live_interval.as_ref()?;
    let interval_id = interval.id.trim();
    if interval_id.is_empty() || show.id.trim().is_empty() {
        return None;
    }
    let live_since = parse_utc(interval.live_since.as_deref())?;
    let ended_at = parse_utc(interval.ended_at.as_deref()).map(|at| at.max(live_since));
    Some((
        OutputSession {
            show_id: show.id.clone(),
            interval_id: interval_id.to_string(),
            kind: show.kind.clone(),
            live_since,
            platforms: leg_platforms(&status.legs),
            local_session_id: status.session_id.clone(),
        },
        ended_at,
    ))
}

pub fn interval_key(show_id: &str, interval_id: &str) -> String {
    format!("cloud:{show_id}:{interval_id}")
}

/// A UUID (RFC 9562 version 8) derived from the show, the interval and the
/// purpose: every computer derives the same id, so the web's own dedupe on
/// it (one report, one usage event) holds across a controller replacement.
pub fn derived_id(purpose: &str, show_id: &str, interval_id: &str) -> String {
    let digest = Sha256::digest(format!("videorc/249-s25/{purpose}/{show_id}/{interval_id}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

pub fn report_id(session: &OutputSession) -> String {
    derived_id("stream-report", &session.show_id, &session.interval_id)
}

// ---------------------------------------------------------------------------
// Local sessions a cloud interval replaces
// ---------------------------------------------------------------------------

/// Local capture sessions that fed a show while it had a live interval. Their
/// own (per local session) report and usage are replaced by the interval's,
/// so a solo resume is never a second stream.
static BOUND: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Called on every `cloud.state`.
pub fn note_status(status: &CloudStatus) {
    let bound = status.show.is_some()
        && status
            .live_interval
            .as_ref()
            .is_some_and(|interval| !interval.id.trim().is_empty());
    if !bound {
        return;
    }
    if let Some(session_id) = status.session_id.as_deref().map(str::trim)
        && !session_id.is_empty()
    {
        remember(
            &mut BOUND.lock().unwrap_or_else(|p| p.into_inner()),
            session_id.to_string(),
        );
    }
}

/// This local session fed a cloud interval: the interval reports it.
pub fn local_session_bound(session_id: &str) -> bool {
    BOUND
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .any(|bound| bound == session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_show::{CloudLiveInterval, CloudShowSummary};

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-17T18:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::TimeDelta::seconds(seconds)
    }

    fn stamp(seconds: i64) -> String {
        at(seconds).to_rfc3339()
    }

    fn leg(platform: StreamPlatform, state: StreamTargetState) -> StreamTargetRuntime {
        StreamTargetRuntime {
            target_id: format!("{platform:?}"),
            platform,
            label: "Main".to_string(),
            state,
            message: None,
            redacted_url: None,
            uplink_overflows: None,
            uplink_overflow_at: None,
        }
    }

    fn status(
        show: Option<(&str, &str)>,
        interval: Option<(&str, Option<i64>, Option<i64>)>,
        legs: Vec<StreamTargetRuntime>,
    ) -> CloudStatus {
        let mut status = crate::cloud_show::CloudShowRuntime::default().status();
        status.show = show.map(|(id, kind)| CloudShowSummary {
            id: id.to_string(),
            node_id: "livekit".to_string(),
            created_at: None,
            expires_at: None,
            resumable: false,
            kind: Some(kind.to_string()),
        });
        status.live_interval = interval.map(|(id, live, ended)| CloudLiveInterval {
            id: id.to_string(),
            requested_at: stamp(0),
            live_since: live.map(stamp),
            end_requested_at: None,
            ended_at: ended.map(stamp),
        });
        status.legs = legs;
        status
    }

    const ANY: fn(&str) -> bool = |_| true;

    #[test]
    fn an_interval_is_one_stream_from_live_to_ended_off_air_time_excluded() {
        let mut tracker = OutputSessionTracker::default();
        // The room is open, the interval requested, nothing live yet.
        let requested = status(Some(("sh_1", "talk")), Some(("iv_1", None, None)), vec![]);
        assert!(tracker.observe(&requested, at(5), ANY).is_empty());
        let live = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", Some(30), None)),
            vec![leg(StreamPlatform::Youtube, StreamTargetState::Live)],
        );
        let events = tracker.observe(&live, at(31), ANY);
        assert!(matches!(&events[..], [OutputEvent::Live(session)]
            if session.live_since == at(30) && session.platforms == vec![StreamPlatform::Youtube]));
        // Polling, reconnects and resumes change nothing.
        for second in 32..40 {
            assert!(tracker.observe(&live, at(second), ANY).is_empty());
        }
        let ended = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", Some(30), Some(630))),
            vec![],
        );
        let events = tracker.observe(&ended, at(640), ANY);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seconds_live(), Some(600));
        assert!(matches!(
            events[0],
            OutputEvent::Ended {
                basis: EndBasis::Confirmed,
                ..
            }
        ));
        // The platform from the live phase is kept after its leg went.
        assert_eq!(events[0].session().platforms, vec![StreamPlatform::Youtube]);
        assert!(tracker.observe(&ended, at(650), ANY).is_empty());
    }

    #[test]
    fn end_then_go_live_again_in_one_show_is_a_second_interval() {
        let mut tracker = OutputSessionTracker::default();
        let first = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", Some(0), None)),
            vec![],
        );
        tracker.observe(&first, at(1), ANY);
        let second = status(
            Some(("sh_1", "talk")),
            Some(("iv_2", Some(100), None)),
            vec![],
        );
        let events = tracker.observe(&second, at(101), ANY);
        // The first ended where last seen (its endedAt never reached us).
        assert!(matches!(&events[..], [
            OutputEvent::Ended { session, ended_at, basis: EndBasis::LastSeen },
            OutputEvent::Live(next),
        ] if session.interval_id == "iv_1" && *ended_at == at(1) && next.interval_id == "iv_2"));
        assert_ne!(
            report_id(events[0].session()),
            report_id(events[1].session())
        );
    }

    #[test]
    fn a_status_without_the_show_ends_nothing_an_ended_show_ends_it_where_last_seen() {
        let mut tracker = OutputSessionTracker::default();
        let live = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", Some(0), None)),
            vec![],
        );
        tracker.observe(&live, at(100), ANY);
        // A reconnect or a handoff: no show for a moment.
        let mut gone = status(None, None, vec![]);
        assert!(tracker.observe(&gone, at(110), ANY).is_empty());
        assert!(tracker.observe(&live, at(120), ANY).is_empty());
        // The show ended and was cleared before its endedAt reached us.
        gone.end_reason = Some("host-ended".to_string());
        let events = tracker.observe(&gone, at(130), ANY);
        assert!(
            matches!(&events[..], [OutputEvent::Ended { ended_at, basis: EndBasis::LastSeen, .. }]
            if *ended_at == at(120))
        );
        assert!(tracker.observe(&gone, at(140), ANY).is_empty());
    }

    #[test]
    fn a_test_show_and_an_interval_never_live_are_not_streams() {
        let mut tracker = OutputSessionTracker::default();
        let test = status(
            Some(("sh_t", "test")),
            Some(("iv_t", Some(0), Some(60))),
            vec![],
        );
        assert!(tracker.observe(&test, at(70), ANY).is_empty());
        let never = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", None, Some(60))),
            vec![],
        );
        assert!(tracker.observe(&never, at(70), ANY).is_empty());
    }

    #[test]
    fn only_the_computer_that_may_act_produces_effects() {
        let mut lost = OutputSessionTracker::default();
        let live = status(
            Some(("sh_1", "solo")),
            Some(("iv_1", Some(0), None)),
            vec![],
        );
        assert!(lost.observe(&live, at(1), |_| false).is_empty());
        let ended = status(
            Some(("sh_1", "solo")),
            Some(("iv_1", Some(0), Some(60))),
            vec![],
        );
        assert!(lost.observe(&ended, at(61), |_| false).is_empty());
        // The successor continues the interval from its server start.
        let mut successor = OutputSessionTracker::default();
        let events = successor.observe(&live, at(30), ANY);
        assert!(matches!(&events[..], [OutputEvent::Live(session)] if session.live_since == at(0)));
    }

    #[test]
    fn an_ended_interval_seen_first_after_a_relaunch_still_ends_once() {
        let mut tracker = OutputSessionTracker::default();
        let ended = status(
            Some(("sh_1", "talk")),
            Some(("iv_1", Some(0), Some(400))),
            vec![],
        );
        let events = tracker.observe(&ended, at(900), ANY);
        assert!(matches!(&events[..], [OutputEvent::Ended { .. }]));
        assert_eq!(events[0].seconds_live(), Some(400));
    }

    #[test]
    fn derived_ids_are_stable_uuids_per_purpose() {
        let a = derived_id("stream-report", "sh_1", "iv_1");
        assert_eq!(a, derived_id("stream-report", "sh_1", "iv_1"));
        assert_ne!(a, derived_id("stream-report", "sh_1", "iv_2"));
        assert_ne!(a, derived_id("usage-start", "sh_1", "iv_1"));
        let parsed = uuid::Uuid::parse_str(&a).expect("a uuid");
        assert_eq!(parsed.get_version_num(), 8);
        assert_eq!(&a[14..15], "8");
    }

    #[test]
    fn only_legs_that_reached_the_platform_count_and_never_a_cloud_platform() {
        let legs = vec![
            leg(StreamPlatform::Youtube, StreamTargetState::Live),
            leg(StreamPlatform::Twitch, StreamTargetState::Connecting),
            leg(StreamPlatform::Kick, StreamTargetState::Failed),
            leg(StreamPlatform::Youtube, StreamTargetState::Reconnecting),
        ];
        assert_eq!(leg_platforms(&legs), vec![StreamPlatform::Youtube]);
    }

    #[test]
    fn a_solo_session_feeding_an_interval_is_bound() {
        let mut solo = status(
            Some(("sh_s", "solo")),
            Some(("iv_s", Some(0), None)),
            vec![],
        );
        solo.session_id = Some("local-1".to_string());
        note_status(&solo);
        assert!(local_session_bound("local-1"));
        let mut node = status(Some(("sh_n", "solo")), None, vec![]);
        node.session_id = Some("local-2".to_string());
        note_status(&node);
        assert!(!local_session_bound("local-2"));
    }
}
