//! Plan 260 S1.6b part 5c: the microphone and System audio controls in the
//! Studio, from `videorc-rust`'s S3.1d port: every control writes the
//! capture config (`setAudio`), and the System audio facts the switch reads
//! (the session's confirmed mix, its join, a health event's issue).
//!
//! The mute is Electron's `requestRemoteMicrophoneMute`
//! ([`Studio::request_microphone_mute`] over the existing
//! [`Studio::set_microphone_muted`]): idle it commits at once; during a
//! session the session applies it and the config follows.
//!
//! Not here yet: the renderer's latest-wins live audio sync (plan 069,
//! `use-studio.tsx` ~13041). While a recording or livestream runs, a Gain,
//! Noise reduction, System audio or echo guard change is written and then
//! sent to the session once (`audio.processing.update`), with no queue and
//! no retry; the standing-by microphone (`audio.mic.arm`) is not armed, so
//! the idle meter reads only what a session's bus sends. Rooms (plan 249)
//! don't exist in app-core.

use serde_json::{Value, json};
use videorc_protocol::{AudioProcessingUpdateParams, RecordingState};

use super::audio_mixer::{self, SystemAudioIssue};
use super::{Inner, MicrophoneMode, Studio, StudioBackend, capture_config};
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
    /// sync's `disabled`; always false until it lands).
    pub live_controls_disabled: bool,
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
            live_controls_disabled: false,
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

    /// `setSystemAudioEnabled`: the switch, a key or a remote.
    pub async fn set_system_audio_enabled(&self, enabled: bool) {
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
    /// recording or livestream runs, into the session.
    async fn write_audio(&self, field: &str, value: Value) {
        if let Err(error) = self
            .update_capture_config(|config| {
                capture_config::set_path(config, &["audio", field], Some(value));
            })
            .await
            && !super::settings_write_kept(&error)
        {
            self.config.logger.warn(format!(
                "Studio: the audio setting {field} was not saved: {}",
                error.message
            ));
            return;
        }
        self.send_live_audio().await;
    }

    /// The session takes the audio the config holds now (one
    /// `audio.processing.update`; the live sync's queue is not ported yet).
    async fn send_live_audio(&self) {
        let params = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if !inner.session.is_active() || super::session_is_replay_only(inner.session.status()) {
                return;
            }
            let Some(session_id) = inner.session.status().session_id.clone() else {
                return;
            };
            inner
                .capture
                .sync(inner.settings.get(super::keys::CAPTURE_CONFIG));
            let audio = &inner.capture.view.config.audio;
            AudioProcessingUpdateParams {
                microphone_noise_suppression: Some(audio.microphone_noise_suppression),
                session_id,
                microphone_gain_db: audio.microphone_gain_db,
                microphone_muted: audio.microphone_muted,
                system_audio_enabled: Some(audio.system_audio_enabled),
                system_audio_gain_db: Some(audio.system_audio_gain_db),
                system_audio_echo_guard: Some(audio.system_audio_echo_guard),
            }
        };
        match self.backend.audio_processing_update(params).await {
            Ok(result) if result.applied => {}
            Ok(result) => self.config.logger.warn(format!(
                "Studio: audio.processing.update not applied for {} ({})",
                result.session_id,
                result.reason_code.as_deref().unwrap_or("no reason")
            )),
            Err(error) => {
                self.note_error(&mut self.lock(), "audio.processing.update", &error);
                self.publish();
            }
        }
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
