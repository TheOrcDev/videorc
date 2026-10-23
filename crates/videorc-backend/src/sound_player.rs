//! The soundboard player (plan 189 S3): playback for the whole app. It owns
//! the decoded library (PCM per sound, loaded on the first press and kept:
//! the five-minute total bounds it), the voice list every surface reads
//! through `sounds.playback`, the press logic of the audiocn pad modes, and
//! the end timers. With a session bus it hands each voice to
//! `SessionAudio::soundboard()`; without one a voice exists for the monitor
//! and the UI only (`onAir: false`).
//!
//! The bus renders by the same arithmetic (start sample plus duration), so
//! no message ever comes back from the bus thread: a voice ends here on its
//! timer, there at its last frame.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::protocol::{
    Sound, SoundMode, SoundPlayResult, SoundPressResult, SoundVoice, SoundsPlayback,
};
use crate::session_audio::{SoundPlacement, SoundVoiceStart, SoundboardHandle};
use crate::sound_mix::SOUND_MAX_VOICES;
use crate::sound_store::load_sound_pcm;
use crate::state::AppState;

pub(crate) const SOUNDS_PLAYBACK_EVENT: &str = "sounds.playback";

/// The session bus the player currently feeds.
#[derive(Clone)]
struct SessionBus {
    session_id: String,
    handle: SoundboardHandle,
}

struct PlayerVoice {
    key: u64,
    sound_id: String,
    started_at_ms: u64,
    duration_ms: u32,
    looping: bool,
    on_air: bool,
}

impl PlayerVoice {
    fn wire(&self) -> SoundVoice {
        SoundVoice {
            voice_id: voice_id(self.key),
            sound_id: self.sound_id.clone(),
            started_at_ms: self.started_at_ms,
            duration_ms: self.duration_ms,
            r#loop: self.looping,
            on_air: self.on_air,
        }
    }
}

#[derive(Default)]
struct PlayerState {
    library: HashMap<String, Arc<[i16]>>,
    /// Oldest first.
    voices: Vec<PlayerVoice>,
    next_key: u64,
    bus: Option<SessionBus>,
}

/// The voice id on the wire: `v-<key>`.
fn voice_id(key: u64) -> String {
    format!("v-{key}")
}

/// Shared through `AppState`; every method takes the lock briefly and never
/// across an await.
#[derive(Default)]
pub struct SoundPlayer {
    inner: StdMutex<PlayerState>,
}

impl SoundPlayer {
    fn lock(&self) -> std::sync::MutexGuard<'_, PlayerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every playing voice, oldest first.
    pub(crate) fn playback(&self) -> SoundsPlayback {
        SoundsPlayback {
            voices: self.lock().voices.iter().map(PlayerVoice::wire).collect(),
        }
    }

    /// A session with native audio published: its bus takes every voice
    /// from now on, at the board level from Sources.
    pub(crate) fn session_started(
        &self,
        session_id: &str,
        handle: SoundboardHandle,
        volume_db: i32,
    ) {
        handle.set_volume_db(volume_db as f32);
        self.lock().bus = Some(SessionBus {
            session_id: session_id.to_string(),
            handle,
        });
    }

    /// The session ended: the bus ended every voice; a one-shot keeps
    /// playing in the monitor until its timer, a loop stops. Emits
    /// `sounds.playback` when anything changed.
    pub(crate) fn session_ended(&self, state: &AppState, session_id: &str) {
        let changed = {
            let mut inner = self.lock();
            if inner
                .bus
                .as_ref()
                .is_none_or(|bus| bus.session_id != session_id)
            {
                return;
            }
            inner.bus = None;
            let before = inner.voices.len();
            inner.voices.retain(|voice| !voice.looping);
            let mut changed = inner.voices.len() != before;
            for voice in inner.voices.iter_mut().filter(|voice| voice.on_air) {
                voice.on_air = false;
                changed = true;
            }
            changed
        };
        if changed {
            self.emit(state);
        }
    }

    /// `sounds.settings` moved the board level: the running bus follows.
    pub(crate) fn set_board_volume_db(&self, volume_db: i32) {
        if let Some(bus) = self.lock().bus.as_ref() {
            bus.handle.set_volume_db(volume_db as f32);
        }
    }

    fn emit(&self, state: &AppState) {
        state.emit_event(SOUNDS_PLAYBACK_EVENT, self.playback());
    }

    /// The sound's PCM, from the library or its file.
    async fn ensure_loaded(&self, state: &AppState, sound: &Sound) -> Result<Arc<[i16]>> {
        if let Some(pcm) = self.lock().library.get(&sound.id) {
            return Ok(pcm.clone());
        }
        let database = state.database.clone();
        let row = sound.clone();
        let pcm = tokio::task::spawn_blocking(move || load_sound_pcm(&database, &row))
            .await
            .unwrap_or_else(|error| Err(anyhow::anyhow!("Sound load worker failed: {error}")))?;
        self.lock().library.insert(sound.id.clone(), pcm.clone());
        Ok(pcm)
    }

    /// Stops the given voices on the bus and drops them from the list.
    /// Returns whether any of them was on air.
    fn stop_keys(&self, keys: &[u64]) -> bool {
        if keys.is_empty() {
            return false;
        }
        let mut inner = self.lock();
        let bus = inner.bus.clone();
        let mut on_air = false;
        inner.voices.retain(|voice| {
            if keys.contains(&voice.key) {
                on_air |= voice.on_air;
                if let Some(bus) = bus.as_ref() {
                    bus.handle.stop(Some(voice.key));
                }
                false
            } else {
                true
            }
        });
        on_air
    }

    /// `sounds.play`: Play once and While held restart (the old voice ramps
    /// out on the bus); Play/stop and Loop return the voice already playing.
    pub(crate) async fn play(&self, state: &AppState, sound_id: &str) -> Result<SoundPlayResult> {
        // The press instant, before any load: the voice lands where the
        // streamer pressed, not where the file finished reading.
        let received_at = Instant::now();
        let started_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let sound = state.database.sound_by_id(sound_id)?;
        let restart = matches!(sound.mode, SoundMode::OneShot | SoundMode::Hold);
        if !restart
            && let Some(voice) = self
                .lock()
                .voices
                .iter()
                .find(|voice| voice.sound_id == sound.id)
        {
            return Ok(SoundPlayResult {
                voice_id: voice_id(voice.key),
                on_air: voice.on_air,
            });
        }
        let pcm = self.ensure_loaded(state, &sound).await?;
        let looping = sound.mode == SoundMode::Loop;
        let gain = crate::audio::db_to_gain((sound.level_db + f64::from(sound.volume_db)) as f32);
        // Register the voice first, so a stop that races the bus's answer
        // still finds it; the bus hears about it next.
        let (key, bus, stopped) = {
            let mut inner = self.lock();
            let mut stopped: Vec<u64> = inner
                .voices
                .iter()
                .filter(|voice| voice.sound_id == sound.id)
                .map(|voice| voice.key)
                .collect();
            let playing = inner.voices.len() - stopped.len();
            if playing >= SOUND_MAX_VOICES
                && let Some(oldest) = inner
                    .voices
                    .iter()
                    .find(|voice| !stopped.contains(&voice.key))
            {
                stopped.push(oldest.key);
            }
            inner.next_key += 1;
            let key = inner.next_key;
            inner.voices.push(PlayerVoice {
                key,
                sound_id: sound.id.clone(),
                started_at_ms,
                duration_ms: sound.duration_ms,
                looping,
                on_air: false,
            });
            (key, inner.bus.clone(), stopped)
        };
        self.stop_keys(&stopped);
        let placement = match bus.as_ref() {
            Some(bus) => {
                bus.handle
                    .start(
                        SoundVoiceStart {
                            key,
                            pcm,
                            gain,
                            looping,
                        },
                        received_at,
                    )
                    .await
            }
            None => SoundPlacement::MonitorOnly,
        };
        let on_air = matches!(placement, SoundPlacement::OnAir { .. });
        {
            let mut inner = self.lock();
            match inner.voices.iter_mut().find(|voice| voice.key == key) {
                Some(voice) => voice.on_air = on_air,
                // Stopped while the bus was answering: take it back out.
                None => {
                    if let Some(bus) = bus.as_ref() {
                        bus.handle.stop(Some(key));
                    }
                }
            }
        }
        if !looping {
            let player = state.soundboard.clone();
            let timer_state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(u64::from(sound.duration_ms))).await;
                player.end_voice(&timer_state, key);
            });
        }
        self.emit(state);
        Ok(SoundPlayResult {
            voice_id: voice_id(key),
            on_air,
        })
    }

    /// `sounds.press`: the pad's mapping for keys, remotes and `/sound`.
    /// Play/stop and Loop stop a playing sound and start a stopped one; Play
    /// once and While held restart.
    pub(crate) async fn press(&self, state: &AppState, sound_id: &str) -> Result<SoundPressResult> {
        let sound = state.database.sound_by_id(sound_id)?;
        if matches!(sound.mode, SoundMode::Toggle | SoundMode::Loop) {
            let playing: Vec<u64> = self
                .lock()
                .voices
                .iter()
                .filter(|voice| voice.sound_id == sound.id)
                .map(|voice| voice.key)
                .collect();
            if !playing.is_empty() {
                let on_air = self.stop_keys(&playing);
                self.emit(state);
                return Ok(SoundPressResult {
                    voice_id: None,
                    on_air,
                });
            }
        }
        let played = self.play(state, sound_id).await?;
        Ok(SoundPressResult {
            voice_id: Some(played.voice_id),
            on_air: played.on_air,
        })
    }

    /// `sounds.stop`: one sound's voices, or every voice.
    pub(crate) fn stop(&self, state: &AppState, sound_id: Option<&str>) -> SoundsPlayback {
        let keys: Vec<u64> = self
            .lock()
            .voices
            .iter()
            .filter(|voice| sound_id.is_none_or(|id| voice.sound_id == id))
            .map(|voice| voice.key)
            .collect();
        if !keys.is_empty() {
            self.stop_keys(&keys);
            self.emit(state);
        }
        self.playback()
    }

    /// A deleted sound: its voices stop and its PCM leaves the library.
    pub(crate) fn evict(&self, state: &AppState, sound_id: &str) {
        self.stop(state, Some(sound_id));
        self.lock().library.remove(sound_id);
    }

    /// The end timer of a one-shot voice: gone from the list, if a stop did
    /// not take it first.
    fn end_voice(&self, state: &AppState, key: u64) {
        let ended = {
            let mut inner = self.lock();
            let before = inner.voices.len();
            inner.voices.retain(|voice| voice.key != key);
            inner.voices.len() != before
        };
        if ended {
            self.emit(state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerEvent;
    use crate::sound_store::{NewSound, sound_file_name, write_wav_s16_stereo_48k};
    use crate::storage::Database;
    use tokio::sync::broadcast;

    fn player_state() -> (
        AppState,
        broadcast::Receiver<ServerEvent>,
        std::path::PathBuf,
    ) {
        let dir =
            std::env::temp_dir().join(format!("videorc-sound-player-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (events, receiver) = broadcast::channel(256);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_file_for_tests(&dir.join("videorc.sqlite3")),
        );
        (state, receiver, dir)
    }

    /// A sound row with a real managed file of `duration_ms` of a tone.
    fn seed_sound(state: &AppState, name: &str, mode: SoundMode, duration_ms: u32) -> Sound {
        let id = uuid::Uuid::new_v4().to_string();
        let root = state.database.sound_assets_dir();
        std::fs::create_dir_all(&root).unwrap();
        let frames = duration_ms as usize * 48;
        let pcm: Vec<i16> = (0..frames)
            .flat_map(|frame| {
                let value = (16_000.0
                    * (std::f64::consts::TAU * 1_000.0 * frame as f64 / 48_000.0).sin())
                    as i16;
                [value, value]
            })
            .collect();
        std::fs::write(
            root.join(sound_file_name(&id)),
            write_wav_s16_stereo_48k(&pcm),
        )
        .unwrap();
        let sound = state
            .database
            .insert_sound(NewSound {
                id,
                name: name.into(),
                duration_ms,
                loudness_lufs: -20.0,
                level_db: 2.0,
                starter: None,
                hotkey: None,
            })
            .unwrap();
        state
            .database
            .update_sound(
                &sound.id,
                crate::sound_store::SoundUpdate {
                    mode: Some(mode),
                    ..Default::default()
                },
            )
            .unwrap()
    }

    fn playback_events(receiver: &mut broadcast::Receiver<ServerEvent>) -> Vec<SoundsPlayback> {
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            if event.event == SOUNDS_PLAYBACK_EVENT {
                events.push(serde_json::from_value(event.payload).unwrap());
            }
        }
        events
    }

    #[tokio::test]
    async fn play_press_and_stop_follow_the_pad_modes_without_a_session() {
        let (state, mut events, dir) = player_state();
        let player = state.soundboard.clone();
        // Long enough that no timer fires during the test on a loaded host.
        let once = seed_sound(&state, "Airhorn", SoundMode::OneShot, 10_000);
        let toggle = seed_sound(&state, "Gong", SoundMode::Toggle, 10_000);
        let looped = seed_sound(&state, "Crickets", SoundMode::Loop, 500);

        // No session: monitor only.
        let first = player.play(&state, &once.id).await.unwrap();
        assert!(!first.on_air);
        assert_eq!(first.voice_id, "v-1");
        // Play once restarts: a new voice, the old one gone.
        let second = player.play(&state, &once.id).await.unwrap();
        assert_eq!(second.voice_id, "v-2");
        let playback = player.playback();
        assert_eq!(playback.voices.len(), 1);
        assert_eq!(playback.voices[0].voice_id, "v-2");
        assert_eq!(playback.voices[0].sound_id, once.id);
        assert_eq!(playback.voices[0].duration_ms, 10_000);
        assert!(!playback.voices[0].r#loop);

        // Play/stop: play is idempotent, press stops it.
        let gong = player.play(&state, &toggle.id).await.unwrap();
        let again = player.play(&state, &toggle.id).await.unwrap();
        assert_eq!(gong.voice_id, again.voice_id);
        assert_eq!(player.playback().voices.len(), 2);
        let pressed = player.press(&state, &toggle.id).await.unwrap();
        assert_eq!(pressed.voice_id, None);
        assert!(!pressed.on_air);
        assert_eq!(player.playback().voices.len(), 1);
        let pressed = player.press(&state, &toggle.id).await.unwrap();
        assert!(pressed.voice_id.is_some());

        // Loop: outlives its duration until stopped.
        let crickets = player.press(&state, &looped.id).await.unwrap();
        assert!(crickets.voice_id.is_some());
        assert!(player.playback().voices.iter().any(|voice| voice.r#loop));
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            player
                .playback()
                .voices
                .iter()
                .any(|voice| voice.sound_id == looped.id),
            "a loop never ends on its own"
        );
        // Stop one, then all.
        let left = player.stop(&state, Some(&looped.id));
        assert!(left.voices.iter().all(|voice| voice.sound_id != looped.id));
        assert_eq!(left.voices.len(), 2);
        let none = player.stop(&state, None);
        assert!(none.voices.is_empty());
        // Every change emitted the whole list.
        let emitted = playback_events(&mut events);
        assert!(emitted.len() >= 8, "{}", emitted.len());
        assert!(emitted.last().unwrap().voices.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_one_shot_ends_on_its_timer_and_a_ninth_voice_stops_the_oldest() {
        let (state, mut events, dir) = player_state();
        let player = state.soundboard.clone();
        let short = seed_sound(&state, "Ding", SoundMode::OneShot, 100);
        player.play(&state, &short.id).await.unwrap();
        assert_eq!(player.playback().voices.len(), 1);
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(player.playback().voices.is_empty(), "the timer ended it");
        let emitted = playback_events(&mut events);
        assert!(emitted.last().unwrap().voices.is_empty());

        let mut sounds = Vec::new();
        for index in 0..9 {
            sounds.push(seed_sound(
                &state,
                &format!("S{index}"),
                SoundMode::Toggle,
                5_000,
            ));
        }
        for sound in &sounds {
            player.play(&state, &sound.id).await.unwrap();
        }
        let playback = player.playback();
        assert_eq!(playback.voices.len(), SOUND_MAX_VOICES);
        assert!(
            playback
                .voices
                .iter()
                .all(|voice| voice.sound_id != sounds[0].id),
            "the oldest voice was stopped"
        );
        assert_eq!(playback.voices.last().unwrap().sound_id, sounds[8].id);
        player.stop(&state, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_missing_sound_or_file_is_an_error_and_delete_evicts() {
        let (state, _events, dir) = player_state();
        let player = state.soundboard.clone();
        assert!(player.play(&state, "nope").await.is_err());
        let sound = seed_sound(&state, "Boom", SoundMode::OneShot, 1_000);
        std::fs::remove_file(state.database.sound_assets_dir().join(&sound.file)).unwrap();
        let error = player
            .play(&state, &sound.id)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("missing"), "{error}");
        assert!(player.playback().voices.is_empty());
        let gong = seed_sound(&state, "Gong", SoundMode::Toggle, 1_000);
        player.play(&state, &gong.id).await.unwrap();
        player.evict(&state, &gong.id);
        assert!(player.playback().voices.is_empty());
        assert!(player.lock().library.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
