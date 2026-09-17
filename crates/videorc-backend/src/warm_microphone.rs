//! Warm microphone (instant-record plan, P5).
//!
//! While Studio is visible the renderer asks the backend to keep the selected
//! CoreAudio microphone open (`audio.mic.arm`). `session.start` then takes the
//! running source straight out of this slot: no device open, no wait for the
//! first CoreAudio callback. The ring inside the source is bounded and every
//! pre-epoch frame is discarded at attach, so a microphone that has been warm
//! for an hour costs nothing at Record. Hiding the window, muting, changing
//! device or switching the setting off disarms it (`audio.mic.disarm`).
//!
//! The slot is never load-bearing: when it is empty, `start_session` opens the
//! device exactly as before.

use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::audio::{
    AudioProcessingSettings, NativeAudioSource, parse_coreaudio_microphone_id,
    start_native_audio_source,
};
use crate::protocol::{WarmMicrophoneArmParams, WarmMicrophoneStatus};
use crate::state::AppState;

/// Bounded CoreAudio open, mirroring the session-start budget.
const WARM_MICROPHONE_OPEN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct WarmMicrophone {
    device_id: u32,
    source: NativeAudioSource,
    armed_at: Instant,
}

#[derive(Default)]
pub struct WarmMicrophoneSlot {
    inner: StdMutex<Option<WarmMicrophone>>,
}

impl std::fmt::Debug for WarmMicrophoneSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WarmMicrophoneSlot")
            .field("status", &self.status())
            .finish()
    }
}

impl WarmMicrophoneSlot {
    pub fn status(&self) -> WarmMicrophoneStatus {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(warm) => WarmMicrophoneStatus {
                armed: true,
                device_id: Some(warm.device_id),
                device_name: Some(warm.source.device_name.clone()),
                reason: None,
                captured_frames: warm.source.stats_handle().captured_frames(),
                armed_for_ms: Some(warm.armed_at.elapsed().as_millis() as u64),
            },
            None => WarmMicrophoneStatus {
                armed: false,
                device_id: None,
                device_name: None,
                reason: Some("disarmed".to_string()),
                captured_frames: 0,
                armed_for_ms: None,
            },
        }
    }

    #[cfg(test)]
    pub fn is_armed_for(&self, device_id: u32) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|warm| warm.device_id == device_id)
    }

    /// Installs an opened source; a previous one is dropped (stopped).
    pub fn install(&self, device_id: u32, source: NativeAudioSource) -> WarmMicrophoneStatus {
        let previous = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.replace(WarmMicrophone {
                device_id,
                source,
                armed_at: Instant::now(),
            })
        };
        drop(previous);
        self.status()
    }

    /// Applies live gain/mute changes to the warm source of `device_id`.
    pub fn update_processing_settings(
        &self,
        device_id: u32,
        settings: AudioProcessingSettings,
    ) -> bool {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(warm) if warm.device_id == device_id => {
                warm.source.update_processing_settings(settings);
                true
            }
            _ => false,
        }
    }

    /// Stops and releases the warm microphone. Returns true when one was armed.
    pub fn disarm(&self) -> bool {
        let previous = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let was_armed = previous.is_some();
        drop(previous);
        was_armed
    }

    /// Hands the warm source to a capture when it is the requested device,
    /// applying the session's processing settings. The slot is empty
    /// afterwards; the renderer re-arms once the session ends.
    pub fn take_for_capture(
        &self,
        device_id: u32,
        settings: AudioProcessingSettings,
    ) -> Option<NativeAudioSource> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.as_ref()?.device_id != device_id {
            return None;
        }
        let warm = guard.take()?;
        warm.source.update_processing_settings(settings);
        Some(warm.source)
    }
}

fn refused(reason: &str, message: Option<String>) -> WarmMicrophoneStatus {
    WarmMicrophoneStatus {
        armed: false,
        device_id: None,
        device_name: message,
        reason: Some(reason.to_string()),
        captured_frames: 0,
        armed_for_ms: None,
    }
}

/// `audio.mic.arm`. Idempotent for the same device (only the processing
/// settings are refreshed); a different device replaces the warm source.
pub async fn arm_warm_microphone(
    state: &AppState,
    params: WarmMicrophoneArmParams,
) -> WarmMicrophoneStatus {
    let Some(device_id) = params
        .microphone_id
        .as_deref()
        .and_then(parse_coreaudio_microphone_id)
    else {
        return refused("not-coreaudio", None);
    };
    if crate::recording::native_microphone_disabled_for_smoke() {
        return refused("disabled-for-smoke", None);
    }
    let settings = AudioProcessingSettings {
        gain_db: params.microphone_gain_db,
        muted: params.microphone_muted,
    };
    if state
        .warm_microphone
        .update_processing_settings(device_id, settings)
    {
        return state.warm_microphone.status();
    }
    // A capture owns the microphone for its whole lifetime; the renderer
    // re-arms when the session ends.
    let work = state.ffmpeg_work.snapshot();
    if work.capture_active || work.capture_waiting > 0 {
        return refused("session-active", None);
    }
    let opened = tokio::time::timeout(
        WARM_MICROPHONE_OPEN_TIMEOUT,
        tokio::task::spawn_blocking(move || start_native_audio_source(device_id, settings)),
    )
    .await;
    let source = match opened {
        Ok(Ok(Ok(source))) => source,
        Ok(Ok(Err(error))) => {
            state.emit_log(
                "warn",
                format!("Warm microphone could not open CoreAudio device {device_id}: {error}"),
            );
            return refused("open-failed", Some(error.to_string()));
        }
        Ok(Err(join_error)) => {
            return refused("open-failed", Some(join_error.to_string()));
        }
        Err(_) => {
            state.emit_log(
                "warn",
                format!(
                    "Warm microphone open for CoreAudio device {device_id} did not finish within {}s.",
                    WARM_MICROPHONE_OPEN_TIMEOUT.as_secs()
                ),
            );
            return refused("open-failed", Some("timed out".to_string()));
        }
    };
    // The renderer may have started a session while the device was opening.
    let work = state.ffmpeg_work.snapshot();
    if work.capture_active || work.capture_waiting > 0 {
        drop(source);
        return refused("session-active", None);
    }
    let status = state.warm_microphone.install(device_id, source);
    state.emit_log(
        "info",
        format!(
            "Warm microphone armed: {} (CoreAudio device {device_id}).",
            status.device_name.as_deref().unwrap_or("unknown device")
        ),
    );
    status
}

/// `audio.mic.disarm`.
pub fn disarm_warm_microphone(state: &AppState) -> WarmMicrophoneStatus {
    if state.warm_microphone.disarm() {
        state.emit_log("info", "Warm microphone disarmed.".to_string());
    }
    state.warm_microphone.status()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::audio::test_native_audio_source;

    fn settings(gain_db: f32) -> AudioProcessingSettings {
        AudioProcessingSettings {
            gain_db,
            muted: false,
        }
    }

    #[test]
    fn slot_installs_reports_and_hands_over_the_matching_device() {
        let slot = WarmMicrophoneSlot::default();
        assert!(!slot.status().armed);
        assert_eq!(slot.status().reason.as_deref(), Some("disarmed"));

        let warm = test_native_audio_source(settings(0.0));
        let warm_stats = warm.stats_handle();
        let installed = slot.install(7, warm);
        assert!(installed.armed);
        assert_eq!(installed.device_id, Some(7));
        assert!(slot.is_armed_for(7));
        assert!(!slot.is_armed_for(8));
        assert!(slot.update_processing_settings(7, settings(3.0)));
        assert!(!slot.update_processing_settings(8, settings(3.0)));

        assert!(
            slot.take_for_capture(8, settings(0.0)).is_none(),
            "another device never takes the warm source"
        );
        assert!(slot.status().armed, "a refused take leaves the source warm");
        let taken = slot
            .take_for_capture(7, settings(6.0))
            .expect("the matching device takes the warm source");
        // The test source carries the caption-contract device id; the slot's
        // own bookkeeping is what the handoff is keyed on.
        assert!(
            Arc::ptr_eq(&taken.stats_handle(), &warm_stats),
            "the very source that was kept warm is handed over"
        );
        assert!(!slot.status().armed, "the slot is empty after a handoff");
        assert!(!slot.disarm());
    }

    #[test]
    fn install_replaces_and_disarm_releases() {
        let slot = WarmMicrophoneSlot::default();
        slot.install(1, test_native_audio_source(settings(0.0)));
        let replaced = slot.install(2, test_native_audio_source(settings(0.0)));
        assert_eq!(replaced.device_id, Some(2));
        assert!(!slot.is_armed_for(1));
        assert!(slot.disarm());
        assert!(!slot.status().armed);
    }

    #[tokio::test]
    async fn arm_refuses_non_coreaudio_ids_and_active_captures() {
        let (events, _) = tokio::sync::broadcast::channel(8);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let refusal = arm_warm_microphone(
            &state,
            WarmMicrophoneArmParams {
                microphone_id: Some("microphone:avfoundation:0".to_string()),
                microphone_gain_db: 0.0,
                microphone_muted: false,
            },
        )
        .await;
        assert_eq!(refusal.reason.as_deref(), Some("not-coreaudio"));

        let _capture = state.ffmpeg_work.begin_capture_when_available().await;
        let refusal = arm_warm_microphone(
            &state,
            WarmMicrophoneArmParams {
                microphone_id: Some("microphone:coreaudio:99".to_string()),
                microphone_gain_db: 0.0,
                microphone_muted: false,
            },
        )
        .await;
        assert_eq!(refusal.reason.as_deref(), Some("session-active"));
        assert!(!state.warm_microphone.status().armed);
        assert_eq!(
            disarm_warm_microphone(&state).reason.as_deref(),
            Some("disarmed")
        );
    }
}
