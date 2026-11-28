//! What the Studio's transport shows (plan 260 S1.6a part 6a, from
//! `videorc-rust`'s plan 220 S2.4b): the session's status words and tone,
//! the clock, the stop control's words, and Record's and Go Live's states.
//! A port of `lib/studio-session-view.ts`, `lib/go-live-copy.ts`'s button
//! words, `components/studio/session-panel.tsx`'s `SessionTransport`,
//! `components/status-bar-session.tsx` and the sidebar's `SessionClock`,
//! caught up with today's Electron:
//!
//! - plan 235 D1 (`f8fa7c460`): no state row above the buttons. The state,
//!   "· Rec" and the clock are the status bar's ([`StatusBarView`]) and the
//!   sidebar Studio row's; the Studio pill's "Not ready" and its glyph have
//!   no caller left, so they are gone here too.
//! - plan 235 D2: the Studio button reads "Go Live", without the "…".
//! - `f7aa92613`: Go Live is a button with a Checking… state while its
//!   first checks run (the Go Live preflight, S1.6c, says when).
//! - The stop button takes a click while a stop is in flight (busy, never
//!   dimmed: `!canStop && !stopRequestPending`), and a start this Studio
//!   did not start falls back to the saved `streamEnabled` for "Cancel
//!   livestream" (`sessionStartIntent?.stream ?? captureConfig.streamEnabled`).
//!
//! The Go live sheet and its custom RTMP destination are S1.6c's. Nothing
//! here knows the UI framework.

use chrono::{DateTime, Utc};
use videorc_protocol::RecordingState;

use super::inspector::{self, BlockedJump, StartGates};
use super::session::{RECORDING_STOPS_TOO, session_is_live};
use super::timecode::format_timecode;
use super::{Connection, SessionView, StudioSnapshot};

/// The Studio transport's record button (`RECORD_LABEL`).
pub const RECORD_LABEL: &str = "Record";
/// The Studio transport's Go Live button (`GO_LIVE_LABEL`). It opens the Go
/// Live dialog, yet reads without the "…" (plan 235 D2); ⌘K keeps "Go
/// live…".
pub const GO_LIVE_LABEL: &str = "Go Live";
/// `GO_LIVE_CHECKING_LABEL`: Go Live while its first checks run (B-7).
pub const GO_LIVE_CHECKING_LABEL: &str = "Checking…";
/// `OPEN_DESTINATIONS_LABEL`: the jump to the page that fixes a Go Live.
pub const OPEN_DESTINATIONS_LABEL: &str = "Open Destinations";
/// The status bar's mark beside "On air" when the livestream records too.
pub const ALSO_RECORDS_LABEL: &str = "· Rec";

/// `STOP_FINALIZE_OVERRUN_ALERT`: the warning under Force stop once a stop
/// overran its finalize window (B-16).
pub mod stop_overrun_copy {
    pub const TITLE: &str = "Stopping is taking longer than expected";
    pub const DESCRIPTION: &str = "A destination isn't responding, so Videorc is finishing the stop in the background. Force stop ends it now; the last seconds may be lost.";
}

/// The session status's tone (`SessionStatusTone`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Good,
    Live,
    Warn,
    Error,
}

impl StatusTone {
    /// The word the UI reads.
    pub fn as_str(self) -> &'static str {
        match self {
            StatusTone::Neutral => "neutral",
            StatusTone::Good => "good",
            StatusTone::Live => "live",
            StatusTone::Warn => "warn",
            StatusTone::Error => "error",
        }
    }
}

/// `sessionStatusLabel` and `sessionStatusTone`: one state machine, one
/// word per state (plan 174 S1.3, D4). Boot-time waiting reads
/// "Connecting…", a dropped socket "Videorc is reconnecting…" (F-014: never
/// Ready over a dead socket), a buffer-only session stays at Ready (plan
/// 181), and on air reads "On air" whether or not it also records.
pub fn session_status(
    session: &SessionView,
    connection: &Connection,
) -> (&'static str, StatusTone) {
    match connection {
        Connection::Waiting => return ("Connecting…", StatusTone::Neutral),
        Connection::Disconnected { .. } => {
            return ("Videorc is reconnecting…", StatusTone::Warn);
        }
        Connection::Connected { .. } => {}
    }
    let status = &session.status;
    if status.replay_only {
        return ("Ready", StatusTone::Good);
    }
    if session_is_live(status) {
        return ("On air", StatusTone::Live);
    }
    match status.state {
        RecordingState::Idle => ("Ready", StatusTone::Good),
        RecordingState::Starting => ("Starting…", StatusTone::Neutral),
        RecordingState::Recording => ("Recording", StatusTone::Live),
        RecordingState::Streaming => ("On air", StatusTone::Live),
        RecordingState::Stopping => ("Stopping…", StatusTone::Neutral),
        RecordingState::Failed => ("Failed", StatusTone::Error),
    }
}

/// `sessionStatusPulses`: the status dot pulses, and the clock runs, only
/// while a file is being written or on air (A-4).
pub fn session_status_pulses(session: &SessionView, connection: &Connection) -> bool {
    matches!(
        session_status(session, connection).0,
        "Recording" | "On air"
    )
}

/// `isSessionTransportActive`: the transport shows the stop button. A
/// buffer-only session leaves Record and Go Live in place.
pub fn transport_active(session: &SessionView) -> bool {
    !session.status.replay_only && session.phase.is_active()
}

/// `sessionAlsoRecords`: a live session that also writes a file (Go Live
/// records by default, D19).
pub fn session_also_records(session: &SessionView) -> bool {
    matches!(session.status.state, RecordingState::Recording) && session_is_live(&session.status)
}

/// `sessionStopControl`: the stop button's words, and the visible line
/// under it when the stop also ends a recording. A Go Live still starting
/// is cancelled, not stopped (B-16): `streaming` is the start's own intent,
/// or the saved mode for a session this Studio did not start
/// ([`stop_control_of`]).
pub fn stop_control(
    session: &SessionView,
    streaming: bool,
) -> (&'static str, Option<&'static str>) {
    if session.stop_pending {
        return ("Stopping…", None);
    }
    if matches!(session.status.state, RecordingState::Stopping) {
        return ("Force stop", None);
    }
    if session_is_live(&session.status) {
        return if session_also_records(session) {
            ("End livestream", Some(RECORDING_STOPS_TOO))
        } else {
            ("End livestream", None)
        };
    }
    if matches!(session.status.state, RecordingState::Starting) && streaming {
        return ("Cancel livestream", None);
    }
    ("Stop recording", None)
}

/// The stop control as the Studio tab asks for it:
/// `sessionStartIntent?.stream ?? captureConfig.streamEnabled`.
pub fn stop_control_of(snapshot: &StudioSnapshot) -> (&'static str, Option<&'static str>) {
    let session = &snapshot.session;
    let streaming = session
        .intent
        .map_or(snapshot.settings.capture.stream_enabled, |intent| {
            intent.stream
        });
    stop_control(session, streaming)
}

/// `sessionElapsedMs`: the running clock counts from `startedAt` (running
/// statuses carry no duration); unreadable or missing gives nothing, a start
/// in the future (clock skew) reads 0.
pub fn session_elapsed_ms(started_at: Option<&str>, now: DateTime<Utc>) -> Option<i64> {
    let started = DateTime::parse_from_rfc3339(started_at?.trim()).ok()?;
    Some(
        (now - started.with_timezone(&Utc))
            .num_milliseconds()
            .max(0),
    )
}

/// `sessionClockLabel`: the one timecode; missing reads 0:00.
pub fn session_clock_label(elapsed_ms: Option<i64>) -> String {
    format_timecode(elapsed_ms.unwrap_or(0))
}

/// The status bar's state (`StatusBarSessionState`, plan 235 D1): the
/// session's one word since the Studio's Ready badge went, "· Rec" on air
/// when the livestream records too, and the elapsed time while it pulses.
/// It opens Health. The sidebar's Studio row carries the same clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusBarView {
    pub label: &'static str,
    pub tone: StatusTone,
    pub pulse: bool,
    /// [`ALSO_RECORDS_LABEL`] beside the word, while connected.
    pub also_records: bool,
    /// The status bar's clock: while it pulses and `startedAt` reads.
    pub clock: Option<String>,
    /// The sidebar Studio row's clock (`SessionClock`): while it pulses,
    /// 0:00 when `startedAt` doesn't read.
    pub sidebar_clock: Option<String>,
}

impl StatusBarView {
    pub fn from_snapshot(snapshot: &StudioSnapshot, now: DateTime<Utc>) -> Self {
        let session = &snapshot.session;
        let (label, tone) = session_status(session, &snapshot.connection);
        let pulse = session_status_pulses(session, &snapshot.connection);
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        let elapsed = if pulse {
            session_elapsed_ms(session.status.started_at.as_deref(), now)
        } else {
            None
        };
        Self {
            label,
            tone,
            pulse,
            also_records: connected && session_also_records(session),
            clock: elapsed.map(|ms| session_clock_label(Some(ms))),
            sidebar_clock: pulse.then(|| session_clock_label(elapsed)),
        }
    }
}

/// Where the Record button stands (`RecordButtonState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordButtonState {
    Idle,
    Starting,
    Running,
    Stopping,
}

impl RecordButtonState {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordButtonState::Idle => "idle",
            RecordButtonState::Starting => "starting",
            RecordButtonState::Running => "running",
            RecordButtonState::Stopping => "stopping",
        }
    }
}

/// Where the Go Live button stands (`GoLiveButton`'s `idle | checking`; its
/// `live` state is a talk show's, which this Studio has no room for).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoLiveButtonState {
    Idle,
    Checking,
}

/// Everything the transport draws, from one snapshot (`SessionTransport`'s
/// props, computed where the Studio tab computes them). Pure, so the UI only
/// copies fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportView {
    /// A session owns the transport: Record's place holds the stop button,
    /// Go Live hides.
    pub active: bool,
    pub record_state: RecordButtonState,
    /// Record's words at idle and while it starts.
    pub record_label: &'static str,
    /// The stop button's words while the session runs.
    pub stop_label: &'static str,
    /// "Your recording stops too." under the stop button (D19), or none.
    pub stop_note: Option<&'static str>,
    /// Whether the Record / stop button takes a click.
    pub record_enabled: bool,
    /// Why Record is off (its hover and focus), never while active.
    pub record_blocked: Option<String>,
    /// Go Live shows beside Record (not while a session runs).
    pub go_live_shown: bool,
    pub go_live_state: GoLiveButtonState,
    pub go_live_label: &'static str,
    pub go_live_enabled: bool,
    /// Why Go Live is off (its hover), never while its checks run.
    pub go_live_blocked: Option<String>,
    /// The one line under the buttons (`visibleStartBlockedReason`), and the
    /// jump to the page that fixes it.
    pub blocked_reason: Option<String>,
    pub blocked_jump: Option<BlockedJump>,
    /// A stop that overran its finalize window: [`stop_overrun_copy`].
    pub stop_overrun: bool,
}

impl TransportView {
    /// `gates` are the start-block reasons app-core doesn't hold yet
    /// ([`StartGates`]); `go_live_pending` is the Go Live preflight running
    /// (`goLiveConfirmationPending`, S1.6c).
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        gates: &StartGates,
        go_live_pending: bool,
    ) -> Self {
        let session = &snapshot.session;
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        let ready = connected && snapshot.bootstrapped;
        let record_blocked = inspector::record_blocked_reason(snapshot, gates);
        let go_live_blocked = inspector::live_stream_blocked_reason(snapshot, gates);
        let active = transport_active(session);
        let starting_livestream = session.intent.is_some_and(|intent| intent.stream);
        // `startsBusy`: a start in flight or Go Live's checks.
        let starts_busy = session.start_pending || go_live_pending;
        // As Electron (`session-panel.tsx` ~136-143): a session that holds
        // the transport is tested first, so the optimistic `starting` status
        // of a Record start shows an enabled "Stop recording" in Record's
        // place (owner decision Q156, 2026-11-24, replacing videorc-rust's
        // S2.2b rule that kept Record lit and busy). That Stop joins the start
        // and stops what it started once `session.start` answers, or at its
        // 120 s deadline (`client::timeouts`), as Electron's `stopSession`
        // joins `sessionStartInFlightRef`. Record's own "starting" is left for
        // a start no session shows yet. A Go Live start, its checks included,
        // is Go Live's to answer: the same stop button cancels the livestream
        // (B-16).
        let record_starting =
            !active && session.start_pending && !go_live_pending && !starting_livestream;
        let record_state = if record_starting {
            RecordButtonState::Starting
        } else if active {
            if session.stop_pending {
                RecordButtonState::Stopping
            } else {
                RecordButtonState::Running
            }
        } else {
            RecordButtonState::Idle
        };
        let (stop_label, stop_note) = stop_control_of(snapshot);
        let record_enabled = if record_starting {
            false
        } else if active {
            // `!canStop && !stopRequestPending` disables it: a stop in
            // flight is busy, never dimmed.
            connected || session.stop_pending
        } else {
            ready && record_blocked.is_none() && !starts_busy
        };
        Self {
            active,
            record_state,
            record_label: RECORD_LABEL,
            stop_label,
            stop_note: if active { stop_note } else { None },
            record_enabled,
            record_blocked: if active { None } else { record_blocked },
            go_live_shown: !active,
            go_live_state: if go_live_pending {
                GoLiveButtonState::Checking
            } else {
                GoLiveButtonState::Idle
            },
            go_live_label: if go_live_pending {
                GO_LIVE_CHECKING_LABEL
            } else {
                GO_LIVE_LABEL
            },
            go_live_enabled: ready && !active && !starts_busy && go_live_blocked.is_none(),
            go_live_blocked: if go_live_pending {
                None
            } else {
                go_live_blocked
            },
            blocked_reason: if active {
                None
            } else {
                inspector::visible_start_blocked_reason(snapshot, gates)
            },
            blocked_jump: if active {
                None
            } else {
                inspector::blocked_jump(snapshot, gates)
            },
            stop_overrun: active && session.stop_overrun,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::session::{SessionStartIntent, initial_status};
    use crate::studio::test_support::{destination, ready_snapshot, set_destinations, set_status};
    use chrono::TimeZone;
    use videorc_protocol::RecordingStatus;

    /// The session as the Studio publishes it with `status`, nothing else
    /// pending (from the fixture, so a new field never breaks it).
    fn view(status: RecordingStatus) -> SessionView {
        snapshot_with(status).session
    }

    fn status(state: RecordingState, stream: bool) -> RecordingStatus {
        RecordingStatus {
            state,
            session_id: Some("s".to_string()),
            stream_url: stream.then(|| "rtmp://127.0.0.1/live".to_string()),
            ..initial_status()
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 8, 12, 0, 0).unwrap()
    }

    fn snapshot_with(status: RecordingStatus) -> StudioSnapshot {
        let mut snapshot = ready_snapshot();
        set_status(&mut snapshot, status);
        snapshot
    }

    #[test]
    fn the_status_words_follow_the_one_state_machine() {
        let connected = Connection::Connected { pid: 1 };
        let word = |state: RecordingState, stream: bool| {
            session_status(&view(status(state, stream)), &connected)
        };
        assert_eq!(
            word(RecordingState::Idle, false),
            ("Ready", StatusTone::Good)
        );
        assert_eq!(
            word(RecordingState::Starting, false),
            ("Starting…", StatusTone::Neutral)
        );
        assert_eq!(
            word(RecordingState::Recording, false),
            ("Recording", StatusTone::Live)
        );
        assert_eq!(
            word(RecordingState::Recording, true),
            ("On air", StatusTone::Live),
            "record+stream is on air"
        );
        assert_eq!(
            word(RecordingState::Streaming, false),
            ("On air", StatusTone::Live)
        );
        assert_eq!(
            word(RecordingState::Stopping, false),
            ("Stopping…", StatusTone::Neutral)
        );
        assert_eq!(
            word(RecordingState::Failed, false),
            ("Failed", StatusTone::Error)
        );
        let mut ring = status(RecordingState::Recording, false);
        ring.replay_only = true;
        assert_eq!(
            session_status(&view(ring.clone()), &connected),
            ("Ready", StatusTone::Good),
            "the replay buffer is never Recording"
        );
        assert!(!session_status_pulses(&view(ring), &connected));
        assert_eq!(
            session_status(
                &view(status(RecordingState::Recording, false)),
                &Connection::Waiting
            ),
            ("Connecting…", StatusTone::Neutral)
        );
        let away = Connection::Disconnected {
            reason: "x".to_string(),
        };
        assert_eq!(
            session_status(&view(status(RecordingState::Idle, false)), &away),
            ("Videorc is reconnecting…", StatusTone::Warn),
            "never Ready over a dead socket"
        );
        assert!(
            !session_status_pulses(&view(status(RecordingState::Recording, false)), &away),
            "a dropped socket never pulses"
        );
    }

    #[test]
    fn the_stop_control_says_what_it_does() {
        assert_eq!(
            stop_control(&view(status(RecordingState::Recording, false)), false),
            ("Stop recording", None)
        );
        assert_eq!(
            stop_control(&view(status(RecordingState::Recording, true)), false),
            ("End livestream", Some("Your recording stops too."))
        );
        assert_eq!(
            stop_control(&view(status(RecordingState::Streaming, false)), false),
            ("End livestream", None)
        );
        assert_eq!(
            stop_control(&view(status(RecordingState::Stopping, false)), false),
            ("Force stop", None)
        );
        let mut pending = view(status(RecordingState::Recording, true));
        pending.stop_pending = true;
        assert_eq!(stop_control(&pending, false), ("Stopping…", None));
        assert_eq!(
            stop_control(&view(status(RecordingState::Starting, false)), true),
            ("Cancel livestream", None)
        );
    }

    #[test]
    fn a_start_this_studio_did_not_start_cancels_by_the_saved_mode() {
        // Electron: `sessionStartIntent?.stream ?? captureConfig.streamEnabled`.
        let mut snapshot = snapshot_with(status(RecordingState::Starting, false));
        snapshot.settings.capture.stream_enabled = true;
        assert_eq!(stop_control_of(&snapshot).0, "Cancel livestream");
        snapshot.settings.capture.stream_enabled = false;
        assert_eq!(stop_control_of(&snapshot).0, "Stop recording");
        // The start's own intent wins over the saved mode.
        snapshot.session.intent = Some(SessionStartIntent::livestream(false));
        assert_eq!(stop_control_of(&snapshot).0, "Cancel livestream");
        snapshot.settings.capture.stream_enabled = true;
        snapshot.session.intent = Some(SessionStartIntent::RECORD);
        assert_eq!(stop_control_of(&snapshot).0, "Stop recording");
    }

    #[test]
    fn the_clock_counts_from_started_at() {
        let now = now();
        assert_eq!(
            session_elapsed_ms(Some("2026-11-08T11:59:30Z"), now),
            Some(30_000)
        );
        assert_eq!(
            session_elapsed_ms(Some("2026-11-08T13:59:30.250+02:00"), now),
            Some(29_750)
        );
        assert_eq!(
            session_elapsed_ms(Some("2026-11-08T12:00:01Z"), now),
            Some(0),
            "never negative"
        );
        assert_eq!(session_elapsed_ms(Some("yesterday"), now), None);
        assert_eq!(session_elapsed_ms(None, now), None);
        assert_eq!(session_clock_label(None), "0:00");
        assert_eq!(session_clock_label(Some(125_000)), "2:05");
    }

    #[test]
    fn the_status_bar_says_the_state_rec_and_the_clock() {
        let now = now();
        let ready = StatusBarView::from_snapshot(&ready_snapshot(), now);
        assert_eq!((ready.label, ready.tone), ("Ready", StatusTone::Good));
        assert!(!ready.pulse && !ready.also_records);
        assert_eq!((ready.clock, ready.sidebar_clock), (None, None));

        let mut recording = status(RecordingState::Recording, false);
        recording.started_at = Some("2026-11-08T11:58:00Z".to_string());
        let bar = StatusBarView::from_snapshot(&snapshot_with(recording), now);
        assert_eq!(bar.label, "Recording");
        assert!(bar.pulse && !bar.also_records);
        assert_eq!(bar.clock.as_deref(), Some("2:00"));
        assert_eq!(bar.sidebar_clock.as_deref(), Some("2:00"));

        let mut live = status(RecordingState::Recording, true);
        live.started_at = Some("2026-11-08T11:59:50Z".to_string());
        let bar = StatusBarView::from_snapshot(&snapshot_with(live), now);
        assert_eq!((bar.label, bar.also_records), ("On air", true));
        assert_eq!(bar.clock.as_deref(), Some("0:10"));

        // No start time: the status bar shows no clock, the sidebar 0:00.
        let bar = StatusBarView::from_snapshot(
            &snapshot_with(status(RecordingState::Recording, false)),
            now,
        );
        assert_eq!(bar.clock, None);
        assert_eq!(bar.sidebar_clock.as_deref(), Some("0:00"));

        // An ended session's duration is no running clock.
        let mut ended = status(RecordingState::Idle, false);
        ended.duration_ms = Some(125_000);
        let bar = StatusBarView::from_snapshot(&snapshot_with(ended), now);
        assert_eq!((bar.clock, bar.sidebar_clock), (None, None));
    }

    #[test]
    fn the_transport_view_follows_the_session() {
        let gates = StartGates::default();
        // Idle, ready: Record and Go Live take clicks; no stop.
        let idle = TransportView::from_snapshot(&ready_snapshot(), &gates, false);
        assert!(!idle.active && idle.go_live_shown);
        assert_eq!(idle.record_state, RecordButtonState::Idle);
        assert!(idle.record_enabled && idle.go_live_enabled);
        assert_eq!(idle.record_label, "Record");
        assert_eq!(idle.go_live_label, "Go Live", "plan 235 D2: no …");
        assert_eq!(idle.stop_note, None);
        assert_eq!(idle.blocked_reason, None);

        // Not bootstrapped yet: nothing starts.
        let mut waiting = ready_snapshot();
        waiting.bootstrapped = false;
        let waiting = TransportView::from_snapshot(&waiting, &gates, false);
        assert!(!waiting.record_enabled && !waiting.go_live_enabled);

        // Go Live's checks run: it reads Checking…, Record waits for it.
        let checking = TransportView::from_snapshot(&ready_snapshot(), &gates, true);
        assert_eq!(checking.go_live_state, GoLiveButtonState::Checking);
        assert_eq!(checking.go_live_label, "Checking…");
        assert!(!checking.record_enabled && !checking.go_live_enabled);

        // A Record start in flight (owner Q156, as Electron): Record's place
        // holds an enabled "Stop recording" that stops what the start
        // starts; Go Live is gone.
        let mut starting = snapshot_with(status(RecordingState::Starting, false));
        starting.session.start_pending = true;
        starting.session.intent = Some(SessionStartIntent::RECORD);
        let starting = TransportView::from_snapshot(&starting, &gates, false);
        assert!(starting.active && !starting.go_live_shown);
        assert_eq!(starting.record_state, RecordButtonState::Running);
        assert_eq!(starting.stop_label, "Stop recording");
        assert!(starting.record_enabled && !starting.go_live_enabled);

        // A Go Live start in flight: Record's place holds the stop button
        // that cancels the livestream (B-16).
        let mut going_live = snapshot_with(status(RecordingState::Starting, false));
        going_live.session.start_pending = true;
        going_live.session.intent = Some(SessionStartIntent::livestream(true));
        let going_live = TransportView::from_snapshot(&going_live, &gates, false);
        assert_eq!(going_live.record_state, RecordButtonState::Running);
        assert_eq!(going_live.stop_label, "Cancel livestream");
        assert!(going_live.record_enabled && !going_live.go_live_shown);

        // Recording: the stop button, no Go Live, no blocked line.
        let running = TransportView::from_snapshot(
            &snapshot_with(status(RecordingState::Recording, false)),
            &gates,
            false,
        );
        assert!(running.active && !running.go_live_shown);
        assert_eq!(running.record_state, RecordButtonState::Running);
        assert_eq!(running.stop_label, "Stop recording");
        assert!(running.record_enabled && !running.go_live_enabled);
        assert_eq!(
            (running.record_blocked, running.blocked_reason),
            (None, None)
        );

        // On air and recording: End livestream, with the D19 line.
        let live = TransportView::from_snapshot(
            &snapshot_with(status(RecordingState::Recording, true)),
            &gates,
            false,
        );
        assert_eq!(live.stop_label, "End livestream");
        assert_eq!(live.stop_note, Some("Your recording stops too."));

        // A stop in flight: Stopping…, busy, never dimmed.
        let mut stopping = snapshot_with(status(RecordingState::Recording, true));
        stopping.session.stop_pending = true;
        let stopping = TransportView::from_snapshot(&stopping, &gates, false);
        assert_eq!(stopping.record_state, RecordButtonState::Stopping);
        assert_eq!(stopping.stop_label, "Stopping…");
        assert!(stopping.record_enabled, "busy, not disabled");

        // A stop that overran: the warning shows while it runs.
        let mut overran = snapshot_with(status(RecordingState::Stopping, false));
        overran.session.stop_overrun = true;
        let overran = TransportView::from_snapshot(&overran, &gates, false);
        assert!(overran.stop_overrun);
        assert_eq!(overran.stop_label, "Force stop");
    }

    #[test]
    fn a_destination_on_but_not_ready_disables_go_live_and_offers_the_jump() {
        // What the GPUI app builds for its transport: the gate from the
        // saved settings (`SessionControls::of`).
        let mut snapshot = ready_snapshot();
        let mut unfinished = destination("custom", "Custom RTMP", true);
        unfinished.stream_key.clear();
        unfinished.stream_key_present = false;
        set_destinations(&mut snapshot, vec![unfinished]);
        let view =
            TransportView::from_snapshot(&snapshot, &StartGates::of_snapshot(&snapshot), false);
        assert!(view.record_enabled && !view.go_live_enabled);
        let reason = "Finish setting up your destination in Destinations before you go live.";
        assert_eq!(view.go_live_blocked.as_deref(), Some(reason));
        assert_eq!(view.blocked_reason.as_deref(), Some(reason));
        assert_eq!(
            view.blocked_jump,
            Some(BlockedJump {
                label: "Open Destinations",
                page: crate::nav::PageId::Live,
            })
        );
    }

    #[test]
    fn a_blocked_go_live_says_why_and_where_it_is_fixed() {
        let gates = StartGates {
            go_live: Some("You can stream to up to 5 destinations at once.".to_string()),
            ..StartGates::default()
        };
        let view = TransportView::from_snapshot(&ready_snapshot(), &gates, false);
        assert!(view.record_enabled && !view.go_live_enabled);
        assert_eq!(
            view.go_live_blocked.as_deref(),
            Some("You can stream to up to 5 destinations at once.")
        );
        assert_eq!(
            view.blocked_reason.as_deref(),
            Some("You can stream to up to 5 destinations at once.")
        );
        assert_eq!(
            view.blocked_jump,
            Some(BlockedJump {
                label: "Open Destinations",
                page: crate::nav::PageId::Live,
            })
        );
        // While Go Live's checks run, its hover says nothing.
        let checking = TransportView::from_snapshot(&ready_snapshot(), &gates, true);
        assert_eq!(checking.go_live_blocked, None);
    }
}
