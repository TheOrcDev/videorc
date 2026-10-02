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
//!
//! Plan 092: while it stands by, the warm source is also the Studio meter's
//! feed. Its callback keeps a level window, and `stream_standby_levels` sends
//! it as `audio.levels` (microphone only, no session) about 20 times a second,
//! so the meter shows the microphone whenever Studio is open, not only during
//! a session.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::audio::{AudioCaptureStats, AudioProcessingSettings, parse_coreaudio_microphone_id};
use crate::protocol::{
    AudioLevelReading, AudioLevelsEvent, WarmMicrophoneArmParams, WarmMicrophoneStatus,
};
use crate::session_audio::InitialAudioSource;
use crate::state::AppState;

pub struct WarmMicrophone {
    device_id: u32,
    source: InitialAudioSource,
    armed_at: Instant,
    /// The configured gain, applied to standby meter readings only: the PCM
    /// stays raw and the session bus owns gain and mute.
    gain_db: f32,
    /// The opening that installed this source; its standby meter runs while
    /// this source is the one in the slot.
    generation: u64,
}

/// Plan 092: how often a standing-by warm microphone reports its level.
const STANDBY_LEVELS_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub struct WarmMicrophoneSlot {
    inner: StdMutex<Option<WarmMicrophone>>,
    opening: AtomicBool,
    generation: AtomicU64,
    changed: tokio::sync::Notify,
}

struct WarmOpenGuard<'a> {
    slot: &'a WarmMicrophoneSlot,
    generation: u64,
}
impl WarmOpenGuard<'_> {
    fn current(&self) -> bool {
        self.slot.generation.load(Ordering::Acquire) == self.generation
    }
}
impl Drop for WarmOpenGuard<'_> {
    fn drop(&mut self) {
        self.slot.opening.store(false, Ordering::Release);
        self.slot.changed.notify_waiters();
    }
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
    #[cfg(test)]
    pub(crate) fn hold_open_for_test(&self) -> impl Drop + '_ {
        self.begin_open().expect("one warm opening")
    }

    #[cfg(test)]
    fn begin_open(&self) -> Option<WarmOpenGuard<'_>> {
        self.begin_open_if(|| true)
    }
    fn begin_open_if(&self, admitted: impl FnOnce() -> bool) -> Option<WarmOpenGuard<'_>> {
        let _slot = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !admitted() {
            return None;
        }
        self.opening
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        Some(WarmOpenGuard {
            slot: self,
            generation,
        })
    }
    pub async fn wait_for_open(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let _slot = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                    if !self.opening.load(Ordering::Acquire) {
                        return;
                    }
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    pub fn owned_producer_count(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map_or(0, |warm| warm.source.owned_producer_count())
    }
    pub fn status(&self) -> WarmMicrophoneStatus {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(warm) => WarmMicrophoneStatus {
                armed: true,
                device_id: Some(warm.device_id),
                device_name: Some(warm.source.device_name()),
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
    #[cfg(test)]
    pub fn install(&self, device_id: u32, source: InitialAudioSource) -> WarmMicrophoneStatus {
        let previous = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.replace(WarmMicrophone {
                device_id,
                source,
                armed_at: Instant::now(),
                gain_db: 0.0,
                generation: self.generation.load(Ordering::Acquire),
            })
        };
        drop(previous);
        self.status()
    }

    fn install_if_current(
        &self,
        opening: &WarmOpenGuard<'_>,
        device_id: u32,
        source: InitialAudioSource,
        gain_db: f32,
    ) -> Option<WarmMicrophoneStatus> {
        let previous = {
            let mut slot = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Disarm and open admission share this lock. Either it wins this
            // check, or it removes our installed source afterward.
            if !opening.current() {
                return None;
            }
            slot.replace(WarmMicrophone {
                device_id,
                source,
                armed_at: Instant::now(),
                gain_db,
                generation: opening.generation,
            })
        };
        drop(previous);
        Some(self.status())
    }

    /// The standby meter's inputs while the warm source installed by
    /// `generation` is still in the slot: None once it was disarmed, replaced
    /// or taken by a session. An opening that fails leaves it running.
    fn standby_meter(&self, generation: u64) -> Option<(Arc<AudioCaptureStats>, f32)> {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .as_ref()
            .filter(|warm| warm.generation == generation)
            .map(|warm| (warm.source.stats_handle(), warm.gain_db))
    }

    /// Applies live gain/mute changes to the warm source of `device_id`.
    pub fn update_processing_settings(
        &self,
        device_id: u32,
        settings: AudioProcessingSettings,
    ) -> bool {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(warm) if warm.device_id == device_id => {
                // Standby PCM stays raw; the session bus owns gain/mute. Only
                // the standby meter applies the gain.
                warm.gain_db = settings.gain_db;
                true
            }
            _ => false,
        }
    }

    /// Stops and releases the warm microphone. Returns true when one was armed.
    pub fn disarm(&self) -> bool {
        let previous = {
            let mut slot = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            self.generation.fetch_add(1, Ordering::AcqRel);
            slot.take()
        };
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
        _settings: AudioProcessingSettings,
    ) -> Option<InitialAudioSource> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.as_ref()?.device_id != device_id {
            return None;
        }
        let warm = guard.take()?;
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
    // Active-session admission precedes even an idempotent standby update.
    let work = state.ffmpeg_work.snapshot();
    if work.capture_active
        || work.capture_waiting > 0
        || !state.capture_interruption.capture_admission_is_idle()
    {
        return refused("session-active", None);
    }
    if crate::session_audio::cleanup_pending(state.warm_microphone.owned_producer_count()) {
        return refused("cleanup-pending", None);
    }
    if state
        .warm_microphone
        .update_processing_settings(device_id, settings)
    {
        return state.warm_microphone.status();
    }
    let Some(opening) = state
        .warm_microphone
        .begin_open_if(|| state.capture_interruption.capture_admission_is_idle())
    else {
        return refused(
            if state.capture_interruption.capture_admission_is_idle() {
                "opening"
            } else {
                "session-active"
            },
            None,
        );
    };
    let source = match crate::session_audio::prepare_initial_native(device_id).await {
        Ok(source) => source,
        Err(error) => {
            state.emit_log(
                "warn",
                format!("Warm microphone could not open CoreAudio device {device_id}: {error}"),
            );
            return refused("open-failed", Some(error.to_string()));
        }
    };
    if !opening.current() {
        drop(source);
        return refused("superseded", None);
    }
    // The renderer may have started a session while the device was opening.
    let work = state.ffmpeg_work.snapshot();
    if work.capture_active || work.capture_waiting > 0 {
        drop(source);
        return refused("session-active", None);
    }
    let generation = opening.generation;
    let Some(status) =
        state
            .warm_microphone
            .install_if_current(&opening, device_id, source, settings.gain_db)
    else {
        return refused("superseded", None);
    };
    tokio::spawn(stream_standby_levels(state.clone(), generation));
    state.emit_log(
        "info",
        format!(
            "Warm microphone armed: {} (CoreAudio device {device_id}).",
            status.device_name.as_deref().unwrap_or("unknown device")
        ),
    );
    status
}

/// Plan 092: the standing-by warm microphone's level, about 20 times a second,
/// as `audio.levels` with the microphone only and no session. Readings carry
/// the configured gain, like the session bus's, so the meter always shows the
/// level a recording would get. Ends once that warm source leaves the slot.
async fn stream_standby_levels(state: AppState, generation: u64) {
    let mut ticker = tokio::time::interval(STANDBY_LEVELS_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let Some((stats, gain_db)) = state.warm_microphone.standby_meter(generation) else {
            return;
        };
        state.emit_event("audio.levels", standby_levels_event(&stats, gain_db));
    }
}

/// One standby reading: the window since the last one, with the gain applied.
fn standby_levels_event(stats: &AudioCaptureStats, gain_db: f32) -> AudioLevelsEvent {
    let (peak, rms) = stats.take_level_window();
    let gain = 10_f32.powf(gain_db / 20.0);
    let rms = f64::from(rms * gain);
    AudioLevelsEvent {
        session_id: None,
        microphone: Some(AudioLevelReading::from_window(peak * gain, rms * rms)),
        system_audio: None,
        master: None,
        master_clipped_samples: 0,
    }
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
        let installed = slot.install(7, InitialAudioSource::warm(warm));
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
    fn standby_meter_follows_the_installed_source_and_its_gain() {
        let slot = WarmMicrophoneSlot::default();
        let warm = test_native_audio_source(settings(0.0));
        let warm_stats = warm.stats_handle();
        slot.install(7, InitialAudioSource::warm(warm));
        let generation = slot.generation.load(Ordering::Acquire);
        let (stats, gain_db) = slot
            .standby_meter(generation)
            .expect("a warm source meters");
        assert!(
            Arc::ptr_eq(&stats, &warm_stats),
            "the warm source's own window"
        );
        assert_eq!(gain_db, 0.0);
        assert!(slot.update_processing_settings(7, settings(6.0)));
        assert_eq!(
            slot.standby_meter(generation).map(|(_, gain)| gain),
            Some(6.0)
        );
        {
            let _opening = slot.hold_open_for_test();
            assert!(
                slot.standby_meter(generation).is_some(),
                "an opening that installed nothing leaves the meter running"
            );
        }
        assert!(slot.take_for_capture(7, settings(0.0)).is_some());
        assert!(
            slot.standby_meter(generation).is_none(),
            "a session that takes the source ends the standby meter"
        );
    }

    #[test]
    fn standby_levels_carry_the_gain_and_no_session() {
        let stats = AudioCaptureStats::default();
        stats.record_level_window(0.25, 0.1);
        stats.record_level_window(0.5, 0.2);
        let event = standby_levels_event(&stats, 6.0);
        assert_eq!(event.session_id, None);
        assert_eq!(event.system_audio, None);
        assert_eq!(event.master, None);
        let microphone = event.microphone.expect("a microphone reading");
        // The loudest callback wins, and +6 dB lifts 0.5 to about full scale.
        assert!(microphone.peak_db.abs() < 0.1, "{microphone:?}");
        let rms_db = 20.0 * (0.2_f32 * 10_f32.powf(0.3)).log10();
        assert!((microphone.rms_db - rms_db).abs() < 0.1, "{microphone:?}");
        // Read and cleared: the next window is silence until a callback lands.
        let silent = standby_levels_event(&stats, 6.0)
            .microphone
            .expect("still a reading");
        assert_eq!(silent.peak_db, crate::protocol::AUDIO_LEVEL_FLOOR_DB);
        assert_eq!(silent.rms_db, crate::protocol::AUDIO_LEVEL_FLOOR_DB);
    }

    #[test]
    fn install_replaces_and_disarm_releases() {
        let slot = WarmMicrophoneSlot::default();
        slot.install(
            1,
            InitialAudioSource::warm(test_native_audio_source(settings(0.0))),
        );
        let replaced = slot.install(
            2,
            InitialAudioSource::warm(test_native_audio_source(settings(0.0))),
        );
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
    #[test]
    fn disarm_cannot_split_open_admission_and_generation_allocation() {
        let slot = Arc::new(WarmMicrophoneSlot::default());
        let opening_slot = slot.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (disarmed_tx, disarmed_rx) = std::sync::mpsc::channel();
        let opener = std::thread::spawn(move || {
            let opening = opening_slot
                .begin_open_if(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                    true
                })
                .unwrap();
            disarmed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(
                !opening.current(),
                "later disarm invalidates the entire earlier admission"
            );
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            slot.inner.try_lock().is_err(),
            "admission check and generation share the slot lock"
        );
        let disarming = slot.clone();
        let disarm = std::thread::spawn(move || {
            disarming.disarm();
            disarmed_tx.send(()).unwrap();
        });
        release_tx.send(()).unwrap();
        opener.join().unwrap();
        disarm.join().unwrap();
        assert!(!slot.status().armed);
    }

    #[tokio::test]
    async fn session_start_admission_refuses_a_later_standby_open_before_capture_permit() {
        let (events, _) = tokio::sync::broadcast::channel(8);
        let state = AppState::new(
            "test-token".into(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let _admission = state
            .capture_interruption
            .try_begin_session_start()
            .unwrap();
        assert!(!state.ffmpeg_work.snapshot().capture_active);
        assert_eq!(
            arm_warm_microphone(
                &state,
                WarmMicrophoneArmParams {
                    microphone_id: Some("microphone:coreaudio:99".into()),
                    microphone_gain_db: 0.0,
                    microphone_muted: false
                }
            )
            .await
            .reason
            .as_deref(),
            Some("session-active")
        );
        assert!(state.warm_microphone.wait_for_open().await);
    }

    #[tokio::test]
    async fn record_waits_for_pending_warm_open_and_takes_the_same_source() {
        let slot = Arc::new(WarmMicrophoneSlot::default());
        let opening = slot.begin_open().unwrap();
        let waiting = slot.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let record = tokio::spawn(async move {
            let _ = started_tx.send(());
            assert!(waiting.wait_for_open().await);
            waiting.take_for_capture(7, settings(0.0))
        });
        started_rx.await.unwrap();
        assert!(!record.is_finished());
        let source = test_native_audio_source(settings(0.0));
        let stats = source.stats_handle();
        slot.install(7, InitialAudioSource::warm(source));
        drop(opening);
        let taken = tokio::time::timeout(Duration::from_secs(1), record)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&stats, &taken.stats_handle()));
        assert!(!slot.status().armed);
        let opening = slot.begin_open().unwrap();
        slot.disarm();
        assert!(
            !opening.current(),
            "disarm fences a delayed open installation"
        );
        assert!(
            slot.install_if_current(
                &opening,
                7,
                InitialAudioSource::warm(test_native_audio_source(settings(0.0))),
                0.0
            )
            .is_none()
        );
        assert!(!slot.status().armed);
    }
}
