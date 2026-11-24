//! Plan 260 S1.6b part 5d: the running session's microphone and System
//! audio, kept in step with the capture config as
//! `lib/live-audio-processing.ts` keeps them (plan 069): one
//! `audio.processing.update` in flight and the newest complete state waiting
//! (a Gain drag never becomes a queue of requests), the System audio fields
//! sent only when the session doesn't hold them, a rejected change rolled
//! back to what the backend last accepted, and a capture that proves it has
//! no live controls pinned for the rest of the session
//! (`disableForSession`). From `videorc-rust`'s S3.1d port, caught up with
//! today's Electron. Pure: the Studio drives it (`super::audio_actions`).

use tokio::sync::oneshot;
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, AudioSettings,
    MicrophoneNoiseSuppression, RecordingState,
};

/// The microphone values a live update always carries
/// (`LiveAudioProcessingValues`).
#[derive(Debug, Clone, PartialEq)]
pub struct MicValues {
    pub noise_suppression: MicrophoneNoiseSuppression,
    pub gain_db: f32,
    pub muted: bool,
}

impl MicValues {
    pub fn of(audio: &AudioSettings) -> Self {
        Self {
            noise_suppression: audio.microphone_noise_suppression,
            gain_db: audio.microphone_gain_db,
            muted: audio.microphone_muted,
        }
    }

    /// A request's microphone values (an absent mode is Off).
    pub fn requested(params: &AudioProcessingUpdateParams) -> Self {
        Self {
            noise_suppression: params.microphone_noise_suppression.unwrap_or_default(),
            gain_db: params.microphone_gain_db,
            muted: params.microphone_muted,
        }
    }
}

/// The System audio switch, level and echo guard (`LiveSystemAudioValues`).
/// The echo guard is a plain bool: the protocol's default (On) stands in
/// for Electron's "absent means On" (plan 076).
#[derive(Debug, Clone, PartialEq)]
pub struct SystemValues {
    pub enabled: bool,
    pub gain_db: f32,
    pub echo_guard: bool,
}

impl SystemValues {
    pub fn of(audio: &AudioSettings) -> Self {
        Self {
            enabled: audio.system_audio_enabled,
            gain_db: audio.system_audio_gain_db,
            echo_guard: audio.system_audio_echo_guard,
        }
    }
}

/// `LiveAudioProcessingSessionStartSnapshot`: the exact audio a
/// `session.start` sent, for the session it started.
#[derive(Debug, Clone, PartialEq)]
pub struct StartSnapshot {
    pub session_id: String,
    pub mic: MicValues,
    /// What the start sent for System audio; `None` when it sent none.
    pub system: Option<SystemValues>,
}

/// `activeAudioProcessingUpdateParams`: the update for the running
/// recording or livestream, or `None` when no session with an id runs.
pub fn active_update_params(
    state: &RecordingState,
    session_id: Option<&str>,
    mic: &MicValues,
) -> Option<AudioProcessingUpdateParams> {
    if !matches!(state, RecordingState::Recording | RecordingState::Streaming) {
        return None;
    }
    let session_id = session_id.filter(|id| !id.is_empty())?;
    Some(AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(mic.noise_suppression),
        session_id: session_id.to_string(),
        microphone_gain_db: mic.gain_db,
        microphone_muted: mic.muted,
        system_audio_enabled: None,
        system_audio_gain_db: None,
        system_audio_echo_guard: None,
    })
}

/// The System audio fields an update carries (`Partial<LiveSystemAudioValues>`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SystemDelta {
    pub enabled: Option<bool>,
    pub gain_db: Option<f32>,
    pub echo_guard: Option<bool>,
}

impl SystemDelta {
    pub fn is_empty(&self) -> bool {
        self.enabled.is_none() && self.gain_db.is_none() && self.echo_guard.is_none()
    }

    /// `{ ...params, ...systemAudioDelta }`.
    pub fn apply_to(&self, params: &mut AudioProcessingUpdateParams) {
        if let Some(enabled) = self.enabled {
            params.system_audio_enabled = Some(enabled);
        }
        if let Some(gain_db) = self.gain_db {
            params.system_audio_gain_db = Some(gain_db);
        }
        if let Some(echo_guard) = self.echo_guard {
            params.system_audio_echo_guard = Some(echo_guard);
        }
    }
}

/// `systemAudioProcessingDelta`: only the System audio fields the session
/// doesn't hold. `known` is what the session was last sent (its start, then
/// each queued update); `None` is unknown, so every field is sent.
pub fn system_audio_delta(desired: &SystemValues, known: Option<&SystemValues>) -> SystemDelta {
    SystemDelta {
        enabled: (known.map(|known| known.enabled) != Some(desired.enabled))
            .then_some(desired.enabled),
        gain_db: (known.map(|known| known.gain_db) != Some(desired.gain_db))
            .then_some(desired.gain_db),
        echo_guard: (known.map(|known| known.echo_guard) != Some(desired.echo_guard))
            .then_some(desired.echo_guard),
    }
}

/// `mergeAudioProcessingParams`: newest value per field wins; an optional
/// field the newer request omits keeps the older one's, and stays omitted
/// when neither set it.
pub fn merge_params(
    older: &AudioProcessingUpdateParams,
    newer: &AudioProcessingUpdateParams,
) -> AudioProcessingUpdateParams {
    AudioProcessingUpdateParams {
        microphone_noise_suppression: newer
            .microphone_noise_suppression
            .or(older.microphone_noise_suppression),
        session_id: newer.session_id.clone(),
        microphone_gain_db: newer.microphone_gain_db,
        microphone_muted: newer.microphone_muted,
        system_audio_enabled: newer.system_audio_enabled.or(older.system_audio_enabled),
        system_audio_gain_db: newer.system_audio_gain_db.or(older.system_audio_gain_db),
        system_audio_echo_guard: newer
            .system_audio_echo_guard
            .or(older.system_audio_echo_guard),
    }
}

/// `sameAudioProcessingParams`: sending `left` after `right` changes
/// nothing (same session, same microphone state, and every optional field
/// `left` sets already matches).
fn same_params(
    left: &AudioProcessingUpdateParams,
    right: Option<&AudioProcessingUpdateParams>,
) -> bool {
    let Some(right) = right else {
        return false;
    };
    left.session_id == right.session_id
        && left.microphone_gain_db == right.microphone_gain_db
        && left.microphone_muted == right.microphone_muted
        && (left.microphone_noise_suppression.is_none()
            || left.microphone_noise_suppression == right.microphone_noise_suppression)
        && (left.system_audio_enabled.is_none()
            || left.system_audio_enabled == right.system_audio_enabled)
        && (left.system_audio_gain_db.is_none()
            || left.system_audio_gain_db == right.system_audio_gain_db)
        && (left.system_audio_echo_guard.is_none()
            || left.system_audio_echo_guard == right.system_audio_echo_guard)
}

/// `LatestWinsLiveAudioProcessingQueue` for one session: one request in
/// flight, the newest complete state waiting. FFmpeg polls runtime commands
/// on its stats cadence, so a slider drag must never become a FIFO of
/// several-second requests. Stopping drops the waiting request and makes
/// the reply in flight inert.
///
/// The queue holds no task: whoever finds no drain running claims it
/// ([`Self::claim_drain`]) and loops [`Self::take_next`], the send and
/// [`Self::settle`] until `take_next` answers `None` (Electron's
/// `drainPromise`).
#[derive(Debug, Clone, Default)]
pub struct LatestWins {
    session_id: String,
    in_flight: Option<AudioProcessingUpdateParams>,
    pending: Option<AudioProcessingUpdateParams>,
    draining: bool,
    stopped: bool,
}

impl LatestWins {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            ..Self::default()
        }
    }

    /// `hasOutstandingWork`.
    pub fn has_outstanding_work(&self) -> bool {
        self.in_flight.is_some() || self.pending.is_some()
    }

    /// The request waiting, if any.
    pub fn pending(&self) -> Option<&AudioProcessingUpdateParams> {
        self.pending.as_ref()
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// `enqueue`: another session's request, or one after the stop, is
    /// dropped; a newer request folds into the waiting one (newest value per
    /// field), and one that changes nothing is no work.
    pub fn enqueue(&mut self, params: AudioProcessingUpdateParams) {
        if self.stopped || params.session_id != self.session_id {
            return;
        }
        let next = match &self.pending {
            Some(pending) => merge_params(pending, &params),
            None => params,
        };
        if same_params(&next, self.pending.as_ref().or(self.in_flight.as_ref())) {
            return;
        }
        self.pending = Some(next);
    }

    /// Work waits and nobody drains it.
    pub fn wants_drain(&self) -> bool {
        !self.stopped && !self.draining && self.pending.is_some()
    }

    /// The caller becomes the drainer when the queue [`Self::wants_drain`].
    pub fn claim_drain(&mut self) -> bool {
        if !self.wants_drain() {
            return false;
        }
        self.draining = true;
        true
    }

    /// The drain's next request, now in flight; `None` ends the drain.
    pub fn take_next(&mut self) -> Option<AudioProcessingUpdateParams> {
        if self.stopped {
            self.draining = false;
            return None;
        }
        // Never two in flight (the drainer settles before it takes again).
        if self.in_flight.is_some() {
            return None;
        }
        let Some(next) = self.pending.take() else {
            self.draining = false;
            return None;
        };
        self.in_flight = Some(next.clone());
        Some(next)
    }

    /// The reply in flight arrived: true when it still counts (the queue was
    /// not stopped meanwhile), so `onSettled` runs.
    pub fn settle(&mut self) -> bool {
        self.in_flight = None;
        if self.stopped {
            self.draining = false;
            return false;
        }
        true
    }

    /// A drain that ended without its reply (its future was dropped): the
    /// next request claims the queue again.
    pub fn abandon_drain(&mut self) {
        self.in_flight = None;
        self.draining = false;
    }

    /// `stop`.
    pub fn stop(&mut self) {
        self.stopped = true;
        self.pending = None;
    }
}

/// `LiveAudioProcessingSessionSyncDecision`.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSyncDecision {
    pub last_applied: MicValues,
    pub enqueue_desired: bool,
}

/// `liveAudioProcessingSessionSyncDecision`: a newly active session is
/// seeded from the exact microphone values its start sent; an edit made
/// while the start was in flight is sent, an untouched start is not. A
/// start that asked for noise reduction is confirmed once: a microphone
/// that bypasses the session audio bus starts without it, and the
/// confirmation brings back the rejection whose rollback shows Off. Any
/// other session is sent the desired state once.
pub fn session_sync_decision(
    desired: &AudioProcessingUpdateParams,
    start: Option<&StartSnapshot>,
) -> SessionSyncDecision {
    let desired_mic = MicValues::requested(desired);
    let start = start.filter(|start| start.session_id == desired.session_id);
    let last_applied = start
        .map(|start| start.mic.clone())
        .unwrap_or_else(|| desired_mic.clone());
    let enqueue_desired = start.is_none()
        || last_applied.noise_suppression == MicrophoneNoiseSuppression::Rnnoise
        || desired_mic != last_applied;
    SessionSyncDecision {
        last_applied,
        enqueue_desired,
    }
}

/// `RejectedLiveAudioProcessingUpdate`.
#[derive(Debug, Clone, PartialEq)]
pub struct Rejection {
    pub rollback: MicValues,
    pub disable_for_session: bool,
    pub message: &'static str,
}

/// `rejectedLiveAudioProcessingUpdate`'s sentences.
pub mod copy {
    pub const NOISE_UNAVAILABLE: &str =
        "Noise reduction is unavailable for this capture. It is Off.";
    pub const STATE_UNKNOWN: &str = "The live microphone change couldn't be confirmed, and the captured audio state may differ from the controls shown. Stop and restart this capture before relying on microphone gain or mute.";
    pub const CONTROLS_UNAVAILABLE: &str = "Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.";
    pub const NOT_APPLIED: &str = "The live microphone change wasn't applied. The previous gain and mute settings were restored.";
    /// `onSettled`'s protocol error: the answer named another session.
    pub const OTHER_RECORDING: &str = "The microphone update came back for a different recording.";
}

/// `rejectedLiveAudioProcessingUpdate`'s input.
#[derive(Debug, Clone, Copy)]
pub struct RejectionInput<'a> {
    /// The session as the Studio holds it now.
    pub state: &'a RecordingState,
    pub session_id: Option<&'a str>,
    /// What the controls show now.
    pub current: &'a MicValues,
    pub requested: &'a AudioProcessingUpdateParams,
    /// `None` when the request itself failed.
    pub result: Option<&'a AudioProcessingUpdateResult>,
    pub last_applied: &'a MicValues,
}

/// `rejectedLiveAudioProcessingUpdate`: a successful reply is not enough;
/// the backend can truthfully reject a live change when the capture has no
/// native post-controls audio path. Rolls back only while the controls
/// still show the rejected request (a late reply never overwrites a newer
/// edit or a newer session); a missing or unhealthy controller pins the
/// session to the last acknowledged values.
pub fn rejected_update(input: RejectionInput<'_>) -> Option<Rejection> {
    let result = input.result;
    if !matches!(
        input.state,
        RecordingState::Recording | RecordingState::Streaming
    ) || input.session_id != Some(input.requested.session_id.as_str())
        || result.is_some_and(|result| {
            result.applied
                || result.reason_code.as_deref() == Some("session-ended")
                || result.session_id != input.requested.session_id
        })
    {
        return None;
    }
    let reason = result.and_then(|result| result.reason_code.as_deref());
    let state_unknown = result.is_none() || reason == Some("live-audio-control-state-unknown");
    let unavailable = state_unknown
        || matches!(
            reason,
            Some("native-audio-unavailable" | "live-audio-control-unavailable")
        );
    let still_visible = input.current.gain_db == input.requested.microphone_gain_db
        && input.current.muted == input.requested.microphone_muted
        && input.current.noise_suppression
            == input
                .requested
                .microphone_noise_suppression
                .unwrap_or_default();
    if !unavailable && !still_visible {
        return None;
    }
    let confirmed = result.and_then(|result| {
        Some(MicValues {
            noise_suppression: result
                .confirmed_microphone_noise_suppression
                .unwrap_or(input.last_applied.noise_suppression),
            gain_db: result.confirmed_microphone_gain_db?,
            muted: result.confirmed_microphone_muted?,
        })
    });
    let mut rollback = confirmed.unwrap_or_else(|| input.last_applied.clone());
    if let Some(mode) = result.and_then(|result| result.confirmed_microphone_noise_suppression) {
        rollback.noise_suppression = mode;
    }
    Some(Rejection {
        rollback,
        disable_for_session: unavailable,
        message: if reason == Some("microphone-noise-suppression-unavailable") {
            copy::NOISE_UNAVAILABLE
        } else if state_unknown {
            copy::STATE_UNKNOWN
        } else if unavailable {
            copy::CONTROLS_UNAVAILABLE
        } else {
            copy::NOT_APPLIED
        },
    })
}

/// The live sync for one running session (`liveAudioProcessingSyncRef`).
#[derive(Debug)]
pub struct LiveAudioSync {
    /// Which sync this is: a reply for an older one is inert (`token`).
    pub token: u64,
    pub session_id: String,
    pub last_applied: MicValues,
    /// System audio as last sent to this session (its start, then each
    /// queued update); `None` until known, and again after an update the
    /// session did not apply, so it is sent again.
    pub system_sent: Option<SystemValues>,
    /// `last_applied` is what the backend acknowledged (the start's
    /// snapshot, an applied reply, or a confirmed rollback).
    pub authoritative: bool,
    /// The session proved it has no live controls (`disableForSession`).
    pub disabled: bool,
    pub queue: LatestWins,
}

/// `liveMicrophoneSettlementWaitersRef`: a remote's or a key's mute
/// waiting for the session to apply it.
#[derive(Debug, Default)]
pub struct MicrophoneWaiters {
    waiting: Vec<(String, bool, oneshot::Sender<bool>)>,
}

impl MicrophoneWaiters {
    /// A waiter for `muted` on `session_id`; the receiver hears whether it
    /// landed (a dropped sender is a no).
    pub fn wait(&mut self, session_id: &str, muted: bool) -> oneshot::Receiver<bool> {
        let (sender, receiver) = oneshot::channel();
        self.waiting.push((session_id.to_string(), muted, sender));
        receiver
    }

    pub fn len(&self) -> usize {
        self.waiting.len()
    }

    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }

    /// `settleLiveMicrophoneWaiters`: the session holds `muted` now; a
    /// waiter for it hears yes, and when nothing more is coming
    /// (`terminal`) the others hear no.
    pub fn settle(&mut self, session_id: &str, muted: bool, terminal: bool) {
        let mut kept = Vec::with_capacity(self.waiting.len());
        for (session, wanted, sender) in self.waiting.drain(..) {
            if session != session_id {
                kept.push((session, wanted, sender));
            } else if wanted == muted {
                let _ = sender.send(true);
            } else if terminal {
                let _ = sender.send(false);
            } else {
                kept.push((session, wanted, sender));
            }
        }
        self.waiting = kept;
    }

    /// `failLiveMicrophoneWaiters`: the waiters for `session_id` (every
    /// one, for `None`) hear no.
    pub fn fail(&mut self, session_id: Option<&str>) {
        let mut kept = Vec::with_capacity(self.waiting.len());
        for (session, wanted, sender) in self.waiting.drain(..) {
            if session_id.is_some_and(|id| id != session) {
                kept.push((session, wanted, sender));
            } else {
                let _ = sender.send(false);
            }
        }
        self.waiting = kept;
    }
}

#[cfg(test)]
#[path = "live_audio_tests.rs"]
mod tests;
