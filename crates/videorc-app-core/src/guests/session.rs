//! A talk show as the transport sees it (plan 224 C-G6, D10, D17;
//! `lib/talk-show-session.ts`), and back in the room after a backend
//! restart (owner call 2026-11-19; `lib/talk-show-auto-rejoin.ts`).
//!
//! Record and Go Live stay the same buttons: while the room is open the
//! cloud recording and the runner's legs project into the recording-state
//! view the transport already reads.

use serde::Deserialize;

use super::wire::{RecordingStatus, RoomPhase, RoomStatus};

/// The show as `CloudStatus.show` names it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShowFacts {
    pub id: String,
    /// `solo`, `talk` or `test`.
    pub kind: Option<String>,
    pub resumable: bool,
}

/// `CloudStatus.onAir`: the device on air (plan 243).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OnAirFacts {
    pub this_device: bool,
    pub waiting: bool,
}

/// `CloudStatus.controller` (plan 249 S24), the parts the rejoin reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ControllerFacts {
    pub controller_epoch: u64,
    /// `this-device` or `another-device`.
    pub taken_over_from: Option<String>,
    pub lost: bool,
}

/// What a talk show reads from `CloudStatus`. S1.6c's mirror (#1779) maps
/// into it once it is on `main`; until then the Studio driver fills it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TalkShowFacts {
    /// `off`, `connecting`, `live`, `hold`, `resuming`, `ending` or `failed`.
    pub phase: String,
    pub show: Option<ShowFacts>,
    pub room: Option<RoomStatus>,
    pub recording: Option<RecordingStatus>,
    pub live_seconds: Option<u64>,
    /// `hand-off` or `taken-over`.
    pub stopped_by: Option<String>,
    pub on_air: Option<OnAirFacts>,
    pub controller: Option<ControllerFacts>,
}

impl TalkShowFacts {
    fn room_open(&self) -> bool {
        self.room
            .as_ref()
            .is_some_and(|room| room.phase == RoomPhase::Open)
    }
}

/// The `streamUrl` a live talk show reads as: never a real address.
pub const TALK_SHOW_STREAM_URL: &str = "videorc-cloud";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TalkShowSessionState {
    /// On air: the pill reads "On air".
    Streaming,
    /// The cloud recording alone.
    Recording,
}

/// When the show went on air, as the transport's clock reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveStartedAt {
    /// This desktop's hand-over stamp (`room.liveSince`), as the backend sent it.
    Stamp(String),
    /// After a resume: the runner's clock, `now - liveSeconds`.
    EpochMs(i64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TalkShowSessionView {
    pub state: TalkShowSessionState,
    /// The show id: the live chat and the comment cards key on it.
    pub session_id: String,
    pub stream_url: Option<&'static str>,
    pub started_at: Option<LiveStartedAt>,
}

/// The transport's view of an open room, or None when the room is closed or
/// nothing runs in it. On air wins over the recording: End livestream keeps
/// the room and the recording (D17).
pub fn talk_show_session_view(
    status: Option<&TalkShowFacts>,
    live_started_at: Option<LiveStartedAt>,
) -> Option<TalkShowSessionView> {
    let status = status?;
    let show_id = status.show.as_ref().map(|show| show.id.clone())?;
    let room = status
        .room
        .as_ref()
        .filter(|room| room.phase == RoomPhase::Open)?;
    if show_id.is_empty() {
        return None;
    }
    if room.live {
        return Some(TalkShowSessionView {
            state: TalkShowSessionState::Streaming,
            session_id: show_id,
            stream_url: Some(TALK_SHOW_STREAM_URL),
            started_at: live_started_at,
        });
    }
    let recording = status
        .recording
        .as_ref()
        .filter(|recording| recording.active)?;
    Some(TalkShowSessionView {
        state: TalkShowSessionState::Recording,
        session_id: show_id,
        stream_url: None,
        started_at: recording.since.clone().map(LiveStartedAt::Stamp),
    })
}

/// A plausible RFC 3339 instant ("2026-11-24T10:00:00Z", with an offset or
/// fractions): the page trusts `Date.parse`, this reader the shape.
fn looks_like_instant(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
}

/// When the show went on air: this desktop's hand-over stamp, or after a
/// resume the runner's clock. Taken once when the room turns live so the
/// clock does not jitter with every status tick.
pub fn talk_show_live_started_at(status: Option<&TalkShowFacts>, now_ms: i64) -> LiveStartedAt {
    let since = status
        .and_then(|status| status.room.as_ref())
        .and_then(|room| room.live_since.clone())
        .filter(|since| looks_like_instant(since));
    if let Some(since) = since {
        return LiveStartedAt::Stamp(since);
    }
    let live_seconds = status.and_then(|status| status.live_seconds).unwrap_or(0);
    LiveStartedAt::EpochMs(now_ms - (live_seconds as i64) * 1000)
}

/// Record while the room is open means the cloud recording (D10).
pub const RECORDING_GOES_TO_CLOUD: &str = "Recording goes to Videorc Cloud while the room is open.";

/// The Program monitor before the return arrives (D7).
pub const PROGRAM_MONITOR_EMPTY: &str = "Program appears when the show starts.";

/// Why Record cannot start a cloud recording, from the runner's
/// `recording.problem`; None when it can.
pub fn talk_show_recording_blocked_reason(status: Option<&TalkShowFacts>) -> Option<String> {
    let status = status?;
    let problem = status
        .recording
        .as_ref()
        .and_then(|recording| recording.problem.as_deref())
        .filter(|problem| !problem.is_empty())?;
    if !status.room_open() {
        return None;
    }
    Some(
        if problem == "no-target" || problem.starts_with("bad-target") {
            "Cloud recordings aren't set up for this show.".to_string()
        } else if problem == "credentials-expired" {
            "The cloud recording stopped: its storage access expired.".to_string()
        } else if problem == "upload-failed" {
            "The cloud recording stopped: the upload didn't go through.".to_string()
        } else {
            format!("The cloud recording isn't available ({problem}).")
        },
    )
}

/// Why this Record or Go Live can't start in a talk show; None when it can.
pub fn talk_show_start_blocked_reason(
    status: Option<&TalkShowFacts>,
    record: bool,
    stream: bool,
) -> Option<String> {
    let live = status
        .and_then(|status| status.room.as_ref())
        .is_some_and(|room| room.live);
    let recording = status
        .and_then(|status| status.recording.as_ref())
        .is_some_and(|recording| recording.active);
    if stream && live {
        return Some("This show is already live.".to_string());
    }
    if record && !stream && recording {
        return Some("The cloud recording is already running.".to_string());
    }
    if record && !recording {
        return talk_show_recording_blocked_reason(status);
    }
    None
}

/// Record and live are independent cloud outputs: the recording is started
/// and acknowledged before the destinations go on air
/// (`startTalkShowLivestream`). True when the recording must start first.
pub fn talk_show_starts_recording_first(record: bool, recording_active: bool) -> bool {
    record && !recording_active
}

// --- Back in the room after a backend restart ---------------------------------

/// The room this app had open when its backend connection went away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRejoinHeld {
    pub show_id: String,
}

/// How long the new backend gets to find the show and renew its controller.
pub const AUTO_REJOIN_WAIT_MS: u64 = 1_000;
pub const AUTO_REJOIN_WAITS: u32 = 30;
/// The pause after each failed resume; one more failure than this gives up.
pub const AUTO_REJOIN_RETRY_MS: [u64; 2] = [2_000, 5_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoRejoinStop {
    /// No room was open here when the backend went away, or the host closed it.
    NothingHeld,
    /// This backend already failed as often as it may: Resume is the host's now.
    GaveUp,
    /// The backend still holds the room (a reconnect, not a restart).
    RoomOpen,
    OtherShow,
    /// Ended, ending, failed, or not a talk show to rejoin.
    ShowOver,
    /// Another device is on air or controls the show.
    Elsewhere,
    /// The show waits for a device after a hand-off.
    HandedOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoRejoinWaitOn {
    Backend,
    Show,
    Controller,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoRejoinDecision {
    Resume,
    /// The new backend has not said enough yet: ask it again.
    Wait(AutoRejoinWaitOn),
    Stop(AutoRejoinStop),
}

/// Whether the app asks the backend to resume the room by itself. It
/// resumes only a show the current backend confirmed as this computer's:
/// the same talk show, resumable, with this computer's controller epoch
/// renewed and not lost, and no other device on air.
pub fn auto_rejoin_decision(
    held: Option<&AutoRejoinHeld>,
    failures: usize,
    status: Option<&TalkShowFacts>,
) -> AutoRejoinDecision {
    use AutoRejoinDecision::{Resume, Stop, Wait};
    let Some(held) = held else {
        return Stop(AutoRejoinStop::NothingHeld);
    };
    if status.is_some_and(TalkShowFacts::room_open) {
        return Stop(AutoRejoinStop::RoomOpen);
    }
    if failures > AUTO_REJOIN_RETRY_MS.len() {
        return Stop(AutoRejoinStop::GaveUp);
    }
    let Some(status) = status else {
        return Wait(AutoRejoinWaitOn::Backend);
    };
    let Some(show) = &status.show else {
        return Wait(AutoRejoinWaitOn::Show);
    };
    if show.id != held.show_id {
        return Stop(AutoRejoinStop::OtherShow);
    }
    if show.kind.as_deref() != Some("talk") || !show.resumable {
        return Stop(AutoRejoinStop::ShowOver);
    }
    if matches!(status.phase.as_str(), "off" | "ending" | "failed") {
        return Stop(AutoRejoinStop::ShowOver);
    }
    if status.stopped_by.as_deref() == Some("hand-off")
        || status.on_air.is_some_and(|on_air| on_air.waiting)
    {
        return Stop(AutoRejoinStop::HandedOff);
    }
    if status.stopped_by.as_deref() == Some("taken-over")
        || status.on_air.is_some_and(|on_air| !on_air.this_device)
    {
        return Stop(AutoRejoinStop::Elsewhere);
    }
    match &status.controller {
        Some(controller)
            if controller.lost
                || controller.taken_over_from.as_deref() == Some("another-device") =>
        {
            Stop(AutoRejoinStop::Elsewhere)
        }
        Some(controller) if controller.controller_epoch > 0 => Resume,
        _ => Wait(AutoRejoinWaitOn::Controller),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoRejoinFailure {
    /// A show whose controller never came back is not confirmed as ours.
    Unconfirmed,
    ResumeFailed(Option<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AutoRejoinOutcome {
    /// The backend holds the room again; the app's join follows.
    Resumed(Box<TalkShowFacts>),
    /// Not this computer's to rejoin by itself. Nothing is said.
    Stopped(AutoRejoinStop),
    /// It tried and could not: the Studio's Resume is the way back in.
    Failed(AutoRejoinFailure),
    /// The backend connection changed again meanwhile.
    Cancelled,
}

/// What one backend's attempt needs from the app.
#[allow(async_fn_in_trait)]
pub trait AutoRejoinIo {
    async fn read_status(&mut self) -> anyhow::Result<TalkShowFacts>;
    async fn resume(&mut self) -> anyhow::Result<TalkShowFacts>;
    async fn sleep(&mut self, ms: u64);
    fn cancelled(&self) -> bool;
    /// Each status the backend answered, for the Studio to show.
    fn on_status(&mut self, _status: &TalkShowFacts) {}
    /// Once, when there is a show to go back to: the host is told from here.
    fn on_reconnecting(&mut self) {}
}

/// One backend's attempt. It ends by itself: bounded waits, bounded retries.
pub async fn run_auto_rejoin(
    held: &AutoRejoinHeld,
    io: &mut impl AutoRejoinIo,
) -> AutoRejoinOutcome {
    let mut waits = 0;
    let mut failures = 0;
    let mut told = false;
    let mut last_error: Option<String> = None;
    loop {
        // The connection is not up yet, or the read was dropped: ask again.
        let status = io.read_status().await.ok();
        if io.cancelled() {
            return AutoRejoinOutcome::Cancelled;
        }
        if let Some(status) = &status {
            io.on_status(status);
        }
        let decision = auto_rejoin_decision(Some(held), failures, status.as_ref());
        match decision {
            AutoRejoinDecision::Stop(AutoRejoinStop::GaveUp) => {
                return AutoRejoinOutcome::Failed(AutoRejoinFailure::ResumeFailed(last_error));
            }
            AutoRejoinDecision::Stop(reason) => return AutoRejoinOutcome::Stopped(reason),
            AutoRejoinDecision::Resume | AutoRejoinDecision::Wait(AutoRejoinWaitOn::Controller)
                if !told =>
            {
                told = true;
                io.on_reconnecting();
            }
            _ => {}
        }
        if let AutoRejoinDecision::Wait(_) = decision {
            waits += 1;
            if waits > AUTO_REJOIN_WAITS {
                return if status.is_some_and(|status| status.show.is_some()) {
                    AutoRejoinOutcome::Failed(AutoRejoinFailure::Unconfirmed)
                } else {
                    AutoRejoinOutcome::Stopped(AutoRejoinStop::ShowOver)
                };
            }
            io.sleep(AUTO_REJOIN_WAIT_MS).await;
            if io.cancelled() {
                return AutoRejoinOutcome::Cancelled;
            }
            continue;
        }
        match io.resume().await {
            Ok(resumed) => {
                if io.cancelled() {
                    return AutoRejoinOutcome::Cancelled;
                }
                if resumed.room_open() {
                    return AutoRejoinOutcome::Resumed(Box::new(resumed));
                }
                last_error = Some("The room did not open.".to_string());
            }
            Err(error) => {
                if io.cancelled() {
                    return AutoRejoinOutcome::Cancelled;
                }
                last_error = Some(error.to_string());
            }
        }
        failures += 1;
        let Some(pause) = AUTO_REJOIN_RETRY_MS.get(failures - 1) else {
            continue;
        };
        io.sleep(*pause).await;
        if io.cancelled() {
            return AutoRejoinOutcome::Cancelled;
        }
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
