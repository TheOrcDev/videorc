//! Plan 260 S1.6b part 5c: the microphone and System audio controls in the
//! Studio, from `videorc-rust`'s S3.1d port: every control writes the
//! capture config (`setAudio`), and the System audio facts the switch reads
//! (the session's confirmed mix, its join, a health event's issue).
//!
//! Part 5d: while a recording or livestream runs, every control reaches the
//! session through the live audio sync (plan 069, [`super::live_audio`]):
//! the control writes the capture config, then the sync's pass (Electron's
//! microphone sync effect in `use-studio.tsx`) queues the newest state on
//! the session's latest-wins queue. Only [`Studio::drive`] drains it (the
//! callers kick it), beside the events, so an update in flight never holds
//! up the events, a control never waits for the store's round trip to reach
//! the session, and a control's future dropped partway strands nothing
//! (review of #1862). Every capture config writer runs the pass
//! ([`Studio::update_capture_config`] included), so a saved scene's System
//! audio reaches a running session too. A rejection rolls the controls back
//! and a capture without live controls pins them for the session.
//!
//! The mute is Electron's `requestRemoteMicrophoneMute`
//! ([`Studio::request_microphone_mute`] over [`Studio::set_microphone_muted`]):
//! idle it commits at once; during a session it is saved to the capture
//! config first, then the live sync sends it, and the call answers once the
//! session applied it (or refused it).
//!
//! Not here yet: the standing-by microphone (`audio.mic.arm`) is not armed,
//! so the idle meter reads only what a session's bus sends; a refused live
//! change is `lastError` and a log line, its bell entry lands with the bell
//! (S1.6e). Rooms (plan 249) don't exist in app-core.

use std::sync::Mutex;

use serde_json::{Value, json};
use videorc_protocol::{AudioProcessingUpdateParams, AudioProcessingUpdateResult, RecordingState};

use super::audio_mixer::{self, SystemAudioIssue};
use super::live_audio::{self, LiveAudioSync, MicValues, RejectionInput, SystemValues};
use super::{Connection, Inner, MicrophoneMode, Studio, StudioBackend, capture_config};
use crate::client::RpcError;
use crate::notices::{NoticeCommand, ids};

/// The System audio facts the Audio section reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SystemAudioFacts {
    /// What the running session mixes (`confirmedSystemAudioMix`).
    pub confirmed: Option<bool>,
    pub issue: Option<SystemAudioIssue>,
    pub joining: bool,
    /// A recording, livestream or Clips ring runs the bus.
    pub audio_bus_active: bool,
    /// The live controls proved unavailable for this session (the live
    /// sync's `disabled`).
    pub live_controls_disabled: bool,
    /// While a session runs, the mute it holds: what it last acknowledged
    /// (`activeSessionAppliedAudio`), else what its start sent; `None` when
    /// idle or not known yet (a remote's mute then reads the controls).
    pub applied_microphone_muted: Option<bool>,
}

/// `isCoreAudioMicrophoneId`.
pub fn is_core_audio_microphone_id(id: &str) -> bool {
    id.starts_with("microphone:coreaudio:")
}

/// The microphones the backend meters while idle: a CoreAudio device on
/// macOS, and on Linux a PulseAudio/PipeWire source.
pub fn is_backend_metered_microphone_id(id: &str) -> bool {
    is_core_audio_microphone_id(id)
        || (cfg!(target_os = "linux") && id.starts_with("microphone:linux-pulse:"))
}

impl Inner {
    /// The System audio facts for the snapshot (and the join latch moved on).
    pub(super) fn system_audio_facts(&mut self) -> SystemAudioFacts {
        let status = self.session.status();
        let mixing = matches!(
            status.state,
            RecordingState::Recording | RecordingState::Streaming
        ) && status.session_id.is_some();
        let session_id = status.session_id.clone().filter(|_| mixing);
        let confirmed = if mixing {
            audio_mixer::confirmed_system_audio_mix(&status.audio_tracks)
        } else {
            None
        };
        let issue = match (&session_id, &self.system_audio_issue) {
            (Some(session), Some((issue_session, issue))) if session == issue_session => {
                Some(*issue)
            }
            _ => None,
        };
        let applied_microphone_muted = status
            .session_id
            .as_deref()
            .filter(|_| self.session.is_active())
            .and_then(|id| {
                self.live_audio_applied
                    .as_ref()
                    .filter(|(applied, _)| applied.as_str() == id)
                    .map(|(_, values)| values.muted)
                    .or_else(|| {
                        self.live_audio_start
                            .as_ref()
                            .filter(|start| start.session_id == id)
                            .map(|start| start.mic.muted)
                    })
            });
        let requested = self.capture.view.config.audio.system_audio_enabled;
        self.system_audio_join = audio_mixer::next_system_audio_join(
            self.system_audio_join.as_ref(),
            session_id.as_deref(),
            requested,
            confirmed,
            issue.is_some(),
        );
        SystemAudioFacts {
            confirmed,
            issue,
            joining: audio_mixer::system_audio_joining(
                self.system_audio_join.as_ref(),
                requested,
                confirmed,
            ),
            audio_bus_active: self.session.is_active(),
            live_controls_disabled: self.live_audio.as_ref().is_some_and(|sync| sync.disabled),
            applied_microphone_muted,
        }
    }

    // --- the live audio sync (plan 069) ---

    /// The live sync's pass: Electron's microphone sync effect, run after
    /// every change it depends on (the session, the connection, a stop, the
    /// start in flight, the capture config's audio). It ends the sync when no
    /// recording or livestream runs, seeds a new session's sync (from its
    /// start's snapshot when the Studio started it), and queues the newest
    /// state with the System audio fields the session lacks. Answers the
    /// values to pin the controls back to while the session's live controls
    /// are disabled.
    pub(super) fn live_audio_pass(&mut self) -> Option<MicValues> {
        self.capture
            .sync(self.settings.get(super::keys::CAPTURE_CONFIG));
        let audio = self.capture.view.config.audio.clone();
        let mic = MicValues::of(&audio);
        let status = self.session.status();
        let params =
            live_audio::active_update_params(&status.state, status.session_id.as_deref(), &mic);
        let connected = matches!(self.connection, Connection::Connected { .. });
        let stop_pending = self.session.stop_pending();
        let Some(params) = params.filter(|_| connected && !stop_pending) else {
            self.end_live_audio();
            return None;
        };
        let start_matches = self
            .live_audio_start
            .as_ref()
            .is_some_and(|start| start.session_id == params.session_id);
        if (self.live_audio_start_in_flight || self.session.start_pending()) && !start_matches {
            return None;
        }
        let mut enqueue_new = false;
        if self
            .live_audio
            .as_ref()
            .is_none_or(|sync| sync.session_id != params.session_id)
        {
            if let Some(mut old) = self.live_audio.take() {
                old.queue.stop();
                self.live_audio_waiters.fail(Some(old.session_id.as_str()));
            }
            let start = if start_matches {
                self.live_audio_start.take()
            } else {
                None
            };
            let decision = live_audio::session_sync_decision(&params, start.as_ref());
            let authoritative = start.is_some();
            self.live_audio_tokens += 1;
            self.live_audio = Some(LiveAudioSync {
                token: self.live_audio_tokens,
                session_id: params.session_id.clone(),
                last_applied: decision.last_applied.clone(),
                system_sent: start.and_then(|start| start.system),
                authoritative,
                disabled: false,
                queue: live_audio::LatestWins::new(params.session_id.clone()),
            });
            if authoritative {
                self.live_audio_waiters.settle(
                    &params.session_id,
                    decision.last_applied.muted,
                    false,
                );
                self.live_audio_applied = Some((params.session_id.clone(), decision.last_applied));
            }
            enqueue_new = decision.enqueue_desired;
        }
        let sync = self.live_audio.as_mut()?;
        // Once the session proves it has no live controls, every surface is
        // pinned to the last settings the backend accepted; the next session
        // starts a fresh sync.
        if sync.disabled {
            return (sync.last_applied != mic).then(|| sync.last_applied.clone());
        }
        // System audio rides the same queue, with only the fields this
        // session doesn't hold: a microphone edit never re-sends the switch.
        let system = SystemValues::of(&audio);
        let delta = live_audio::system_audio_delta(&system, sync.system_sent.as_ref());
        if !enqueue_new
            && !sync.queue.has_outstanding_work()
            && sync.last_applied == mic
            && delta.is_empty()
        {
            return None;
        }
        let mut update = params;
        delta.apply_to(&mut update);
        sync.system_sent = Some(system);
        sync.queue.enqueue(update);
        // A new switch state supersedes the last issue (PR #477 review).
        if delta.enabled.is_some() {
            self.system_audio_issue = None;
        }
        None
    }

    /// The sync ends (no session runs, the engine is away, a stop was asked
    /// for): its queue stops, its reply in flight is inert, and every mute
    /// waiting on it hears no.
    pub(super) fn end_live_audio(&mut self) {
        if let Some(mut sync) = self.live_audio.take() {
            sync.queue.stop();
        }
        self.live_audio_waiters.fail(None);
    }

    /// The sync's queue, claimed by a caller that drains it.
    fn claim_live_audio_drain(&mut self) -> Option<u64> {
        let sync = self.live_audio.as_mut()?;
        sync.queue.claim_drain().then_some(sync.token)
    }

    fn live_audio_wants_drain(&self) -> bool {
        self.live_audio
            .as_ref()
            .is_some_and(|sync| sync.queue.wants_drain())
    }

    /// `requestRemoteMicrophoneMute`'s `applied`: what `session_id` holds
    /// for the mute (the sync's acknowledged values, the last applied ones,
    /// or its start's), if known.
    fn live_microphone_muted(&self, session_id: &str) -> Option<bool> {
        if let Some(sync) = self
            .live_audio
            .as_ref()
            .filter(|sync| sync.session_id == session_id && sync.authoritative)
        {
            return Some(sync.last_applied.muted);
        }
        if let Some((_, applied)) = self
            .live_audio_applied
            .as_ref()
            .filter(|(id, _)| id.as_str() == session_id)
        {
            return Some(applied.muted);
        }
        self.live_audio_start
            .as_ref()
            .filter(|start| start.session_id == session_id)
            .map(|start| start.mic.muted)
    }
}

/// The microphone's three live values into the capture config.
fn write_microphone(config: &mut Value, values: &MicValues) {
    capture_config::set_path(
        config,
        &["audio", "microphoneGainDb"],
        Some(json!(values.gain_db)),
    );
    capture_config::set_path(
        config,
        &["audio", "microphoneMuted"],
        Some(Value::Bool(values.muted)),
    );
    capture_config::set_path(
        config,
        &["audio", "microphoneNoiseSuppression"],
        serde_json::to_value(values.noise_suppression).ok(),
    );
}

/// [`Studio::drive`]'s claim on the queue while it drains, given back if the
/// drive is dropped before the drain ends (the Studio stopping: its reply
/// never arrives, and no drain follows it); dropped with the Studio's lock
/// free. No control drains inline, so a control's dropped future never
/// abandons a request the backend may still be applying.
struct DrainClaim<'a> {
    inner: &'a Mutex<Inner>,
    token: u64,
    armed: bool,
}

impl Drop for DrainClaim<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sync) = inner
            .live_audio
            .as_mut()
            .filter(|sync| sync.token == self.token)
        {
            sync.queue.abandon_drain();
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    // --- the controls ---

    /// The row's mute (`onMutedChange`): `requestRemoteMicrophoneMute(muted
    /// ? 'mute' : 'unmute')`. True when the mute landed.
    pub async fn request_microphone_mute(&self, muted: bool) -> bool {
        let mode = if muted {
            MicrophoneMode::Mute
        } else {
            MicrophoneMode::Unmute
        };
        self.set_microphone_muted(mode).await
    }

    /// `requestRemoteMicrophoneMute`, for the row, a key or a remote. Idle,
    /// the mute is written to the capture config and the next session
    /// starts with it. While a session runs, the toggle reads what the
    /// session holds (not the controls); the mute is saved to the capture
    /// config first (the Studio's config, as `commitRequestedMute`), then the
    /// live sync sends it from [`Self::drive`] while the store's write goes
    /// out beside it, and this answers once the session applied it. Dropping
    /// this future only drops the answer. False when the session's state is
    /// unknown, its live controls are disabled, or it refused the mute (the
    /// rejection rolls the controls back).
    pub async fn set_microphone_muted(&self, mode: MicrophoneMode) -> bool {
        let pick = move |muted: bool| match mode {
            MicrophoneMode::Mute => true,
            MicrophoneMode::Unmute => false,
            MicrophoneMode::Toggle => !muted,
        };
        let (session_id, muted, applied) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner
                .capture
                .sync(inner.settings.get(super::keys::CAPTURE_CONFIG));
            let idle = !inner.session.is_active();
            let current = inner.capture.view.config.audio.microphone_muted;
            let session_id = inner.session.status().session_id.clone();
            if idle {
                (None, pick(current), current)
            } else {
                let Some(session_id) = session_id else {
                    return false;
                };
                let Some(applied) = inner.live_microphone_muted(&session_id) else {
                    return false;
                };
                let muted = pick(applied);
                let disabled = inner
                    .live_audio
                    .as_ref()
                    .is_some_and(|sync| sync.session_id == session_id && sync.disabled);
                if disabled && muted != applied {
                    return false;
                }
                (Some(session_id), muted, applied)
            }
        };
        let Some(session_id) = session_id else {
            return self.commit_microphone_muted(muted).await;
        };
        // Saved first (`commitRequestedMute`), then the live sync sends it.
        let waiter = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if let Err(error) = self.stage_capture_config(inner, |config| {
                capture_config::set_path(
                    config,
                    &["audio", "microphoneMuted"],
                    Some(Value::Bool(muted)),
                );
            }) {
                self.config.logger.warn(format!(
                    "Studio: the microphone mute was not saved: {}",
                    error.message
                ));
                return false;
            }
            let outstanding = inner.live_audio.as_ref().is_some_and(|sync| {
                sync.session_id == session_id && sync.queue.has_outstanding_work()
            });
            let waiter = if muted != applied || outstanding {
                let gain_db = inner.capture.view.config.audio.microphone_gain_db;
                if let Some(sync) = inner
                    .live_audio
                    .as_mut()
                    .filter(|sync| sync.session_id == session_id)
                {
                    sync.queue.enqueue(AudioProcessingUpdateParams {
                        microphone_noise_suppression: None,
                        session_id: session_id.clone(),
                        microphone_gain_db: gain_db,
                        microphone_muted: muted,
                        system_audio_enabled: None,
                        system_audio_gain_db: None,
                        system_audio_echo_guard: None,
                    });
                }
                Some(inner.live_audio_waiters.wait(&session_id, muted))
            } else {
                None
            };
            // The capture config changed: the sync's pass runs, and the drive
            // sends the mute at once, without waiting for the store.
            self.stage_live_audio_and_kick(inner);
            waiter
        };
        self.publish();
        self.flush_audio_write("the microphone mute").await;
        match waiter {
            Some(waiter) => waiter.await.unwrap_or(false),
            None => true,
        }
    }

    /// The Microphone's Gain: whole dB within the fader's range.
    pub async fn set_microphone_gain(&self, gain_db: f32) {
        let (low, high) = audio_mixer::MICROPHONE_GAIN_RANGE;
        let gain = gain_db.round().clamp(low, high);
        self.write_audio("microphoneGainDb", json!(gain)).await;
    }

    /// System audio's Gain: whole dB within its fader's range.
    pub async fn set_system_audio_gain(&self, gain_db: f32) {
        let (low, high) = audio_mixer::SYSTEM_AUDIO_GAIN_RANGE;
        let gain = gain_db.round().clamp(low, high);
        self.write_audio("systemAudioGainDb", json!(gain)).await;
    }

    /// `setSystemAudioEnabled`: the switch, a key or a remote. The session
    /// is sent the switch again whatever it held (the retry after a failed
    /// start or a lost update).
    pub async fn set_system_audio_enabled(&self, enabled: bool) {
        {
            let mut inner = self.lock();
            if let Some(sync) = inner.live_audio.as_mut() {
                sync.system_sent = None;
            }
        }
        self.write_audio("systemAudioEnabled", json!(enabled)).await;
    }

    /// Noise reduction (`microphoneNoiseSuppression`): never On without a
    /// microphone.
    pub async fn set_microphone_noise_suppression(&self, on: bool) {
        let no_microphone = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner
                .capture
                .sync(inner.settings.get(super::keys::CAPTURE_CONFIG));
            inner.capture.view.config.sources.microphone_id.is_none()
        };
        if on && no_microphone {
            return;
        }
        let mode = if on { "rnnoise" } else { "off" };
        self.write_audio("microphoneNoiseSuppression", json!(mode))
            .await;
    }

    /// Microphone sync (`applySyncChange`): a trim is user-set; the reset
    /// puts 0 ms back and clears the flag. It applies from the next
    /// recording or stream.
    pub async fn set_microphone_sync_offset(&self, offset_ms: i32, reset: bool) {
        let (low, high) = super::sources_audio::SYNC_OFFSET_RANGE_MS;
        let offset = if reset { 0 } else { offset_ms.clamp(low, high) };
        if let Err(error) = self
            .update_capture_config(|config| {
                capture_config::set_path(
                    config,
                    &["audio", "microphoneSyncOffsetMs"],
                    Some(json!(offset)),
                );
                capture_config::set_path(
                    config,
                    &["audio", "microphoneSyncOffsetUserSet"],
                    (!reset).then_some(Value::Bool(true)),
                );
            })
            .await
            && !super::settings_write_kept(&error)
        {
            self.config.logger.warn(format!(
                "Studio: the microphone sync was not saved: {}",
                error.message
            ));
        }
    }

    /// Pause if your stream echoes back (plan 076).
    pub async fn set_system_audio_echo_guard(&self, on: bool) {
        self.write_audio("systemAudioEchoGuard", json!(on)).await;
    }

    /// Keep microphone ready (`keepMicrophoneWarm`).
    pub async fn set_keep_microphone_warm(&self, on: bool) {
        if let Err(error) = self
            .update_studio_settings(|settings| settings.set("keepMicrophoneWarm", Value::Bool(on)))
            .await
            && !super::settings_write_kept(&error)
        {
            self.config.logger.warn(format!(
                "Studio: Keep microphone ready was not saved: {}",
                error.message
            ));
        }
    }

    /// Plan 076: Resume after the echo guard paused System audio. Electron
    /// resolves its bell entry (`requestSystemAudioResume`); until the bell
    /// lands (S1.6e) the pause is a toast, which goes.
    pub async fn resume_system_audio(&self) {
        self.post(vec![NoticeCommand::Dismiss(
            ids::SYSTEM_AUDIO_ECHO.to_string(),
        )]);
        self.set_system_audio_enabled(true).await;
    }

    /// `setAudio`: one audio field into the capture config, then, while a
    /// recording or livestream runs, the live sync's pass; [`Self::drive`]
    /// sends it while the store's write goes out.
    async fn write_audio(&self, field: &str, value: Value) {
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if let Err(error) = self.stage_capture_config(inner, |config| {
                capture_config::set_path(config, &["audio", field], Some(value));
            }) {
                self.config.logger.warn(format!(
                    "Studio: the audio setting {field} was not saved: {}",
                    error.message
                ));
                return;
            }
            self.stage_live_audio_and_kick(inner);
        }
        self.publish();
        self.flush_audio_write(field).await;
    }

    /// The store takes the audio write (it waits in the journal while the
    /// engine is away).
    async fn flush_audio_write(&self, what: &str) {
        if let Err(error) = self.flush_settings().await
            && !super::settings_write_kept(&error)
        {
            self.config
                .logger
                .warn(format!("Studio: {what} was not saved: {}", error.message));
        }
    }

    // --- the live audio sync (plan 069) ---

    /// The sync's pass under the lock, its pin-back staged in the same step
    /// (`setCaptureConfig(current => ...)`). True when a write was staged.
    fn stage_live_audio_pass(&self, inner: &mut Inner) -> bool {
        let Some(values) = inner.live_audio_pass() else {
            return false;
        };
        match self.stage_capture_config(inner, |config| write_microphone(config, &values)) {
            Ok(()) => true,
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: the live microphone settings were not restored: {}",
                    error.message
                ));
                false
            }
        }
    }

    /// The sync's pass under the lock, and [`Self::drive`] woken when its
    /// queue holds work nobody drains. Every capture config writer runs it
    /// (review of #1862). True when a pin-back write was staged (the
    /// caller's flush sends it).
    pub(super) fn stage_live_audio_and_kick(&self, inner: &mut Inner) -> bool {
        let staged = self.stage_live_audio_pass(inner);
        if inner.live_audio_wants_drain() {
            self.live_audio_kick.notify_one();
        }
        staged
    }

    /// The sync's pass after a change the Studio heard on its own (a status,
    /// the connection, a start's or a stop's answer, another window's
    /// edit). Its drain is [`Self::drive`]'s, never this caller's.
    pub(super) async fn follow_live_audio(&self) {
        let (staged, kick) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let staged = self.stage_live_audio_pass(inner);
            (staged, inner.live_audio_wants_drain())
        };
        if kick {
            self.live_audio_kick.notify_one();
        }
        if staged || kick {
            self.publish();
        }
        if staged {
            self.flush_audio_write("the live microphone rollback").await;
        }
    }

    /// [`Self::drive`]'s drain, the queue's only drainer: woken by every
    /// pass that leaves work waiting.
    pub(super) async fn drain_live_audio_when_kicked(&self) {
        loop {
            self.live_audio_kick.notified().await;
            let claimed = self.lock().claim_live_audio_drain();
            if let Some(token) = claimed {
                self.drain_live_audio(token).await;
            }
        }
    }

    /// The queue's `drain`: one request in flight, the newest waiting, until
    /// nothing waits, the queue stops, or its sync ended. Never holds the
    /// Studio's lock across the request.
    async fn drain_live_audio(&self, token: u64) {
        let mut claim = DrainClaim {
            inner: &self.inner,
            token,
            armed: true,
        };
        loop {
            let requested = {
                let mut inner = self.lock();
                inner
                    .live_audio
                    .as_mut()
                    .filter(|sync| sync.token == token)
                    .and_then(|sync| sync.queue.take_next())
            };
            let Some(requested) = requested else {
                claim.armed = false;
                return;
            };
            let answer = self
                .backend
                .audio_processing_update(requested.clone())
                .await;
            let staged = self.settle_live_audio(token, &requested, answer);
            self.publish();
            if staged {
                self.flush_audio_write("the live microphone rollback").await;
            }
        }
    }

    /// `onSettled`: the session's answer to one update. An applied one is
    /// what the session holds now; a rejection rolls the controls back
    /// while they still show it (staged under this lock), may disable the
    /// session's live controls, and is reported (`reportUnasked`: the sync
    /// runs on its own, so `lastError` and a log line; the bell's entry
    /// lands with the bell). True when the rollback was staged.
    fn settle_live_audio(
        &self,
        token: u64,
        requested: &AudioProcessingUpdateParams,
        answer: Result<AudioProcessingUpdateResult, RpcError>,
    ) -> bool {
        let (result, error) = match answer {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        };
        let mut guard = self.lock();
        let inner = &mut *guard;
        inner
            .capture
            .sync(inner.settings.get(super::keys::CAPTURE_CONFIG));
        let current = MicValues::of(&inner.capture.view.config.audio);
        let status = inner.session.status().clone();
        let session_id = requested.session_id.as_str();
        let Some(sync) = inner.live_audio.as_mut().filter(|sync| sync.token == token) else {
            // A sync that ended: its waiters heard no when it did.
            return false;
        };
        if !sync.queue.settle() {
            return false;
        }
        let running = matches!(
            status.state,
            RecordingState::Recording | RecordingState::Streaming
        ) && status.session_id.as_deref() == Some(session_id);
        if !running {
            sync.queue.stop();
            inner.live_audio_waiters.fail(Some(session_id));
            return false;
        }
        let valid = result
            .as_ref()
            .filter(|result| result.session_id == requested.session_id);
        let protocol_error = result.is_some() && valid.is_none();
        if let Some(applied) = valid.filter(|result| result.applied) {
            sync.last_applied = MicValues {
                noise_suppression: applied.microphone_noise_suppression,
                gain_db: applied.microphone_gain_db,
                muted: applied.microphone_muted,
            };
            sync.authoritative = true;
            let last_applied = sync.last_applied.clone();
            let terminal = !sync.queue.has_outstanding_work();
            inner
                .live_audio_waiters
                .settle(session_id, last_applied.muted, terminal);
            inner.live_audio_applied = Some((requested.session_id.clone(), last_applied));
            return false;
        }
        // Not applied: the System audio fields are sent again (PR #477).
        sync.system_sent = None;
        let reason = valid.and_then(|result| result.reason_code.as_deref());
        if reason == Some("session-ended") {
            sync.queue.stop();
            inner.live_audio_waiters.fail(Some(session_id));
            return false;
        }
        let Some(rejection) = live_audio::rejected_update(RejectionInput {
            state: &status.state,
            session_id: status.session_id.as_deref(),
            current: &current,
            requested,
            result: valid,
            last_applied: &sync.last_applied,
        }) else {
            let muted = sync.last_applied.muted;
            let terminal = !sync.queue.has_outstanding_work();
            inner.live_audio_waiters.settle(session_id, muted, terminal);
            return false;
        };
        sync.disabled = rejection.disable_for_session;
        let authoritative = sync.authoritative
            || valid.is_some_and(|result| {
                result.confirmed_microphone_gain_db.is_some()
                    && result.confirmed_microphone_muted.is_some()
            });
        sync.last_applied = rejection.rollback.clone();
        sync.authoritative = authoritative;
        let outstanding = sync.queue.has_outstanding_work();
        if rejection.disable_for_session {
            // `onSettled` answered false: nothing more goes to this session.
            sync.queue.stop();
        }
        if authoritative {
            inner.live_audio_applied =
                Some((requested.session_id.clone(), rejection.rollback.clone()));
        }
        if !authoritative || valid.is_none() || reason == Some("live-audio-control-state-unknown") {
            inner.live_audio_waiters.fail(Some(session_id));
        } else {
            inner.live_audio_waiters.settle(
                session_id,
                rejection.rollback.muted,
                rejection.disable_for_session || !outstanding,
            );
        }
        // The controls still show the rejected request (`current` was read
        // under this lock): they go back.
        let staged = match self.stage_capture_config(inner, |config| {
            write_microphone(config, &rejection.rollback)
        }) {
            Ok(()) => true,
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: the live microphone settings were not restored: {}",
                    error.message
                ));
                false
            }
        };
        let detail = if protocol_error {
            format!(" {}", live_audio::copy::OTHER_RECORDING)
        } else if let Some(error) = &error {
            format!(" {}", error.message)
        } else {
            String::new()
        };
        let message = format!("{}{detail}", rejection.message);
        self.config.logger.warn(format!("Studio: {message}"));
        inner.last_error = Some(message);
        staged
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_coreaudio_microphones_are_metered_while_idle_on_a_mac() {
        assert!(is_core_audio_microphone_id("microphone:coreaudio:42"));
        assert!(!is_core_audio_microphone_id("microphone:avfoundation:0"));
        assert!(is_backend_metered_microphone_id("microphone:coreaudio:42"));
        let linux_metered = is_backend_metered_microphone_id("microphone:linux-pulse:alsa_input");
        if cfg!(target_os = "linux") {
            assert!(linux_metered, "a PulseAudio source on Linux");
        } else {
            assert!(!linux_metered, "only on Linux");
        }
    }
}
