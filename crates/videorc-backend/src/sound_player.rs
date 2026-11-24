//! The soundboard player (plan 189 S3): playback for the whole app. It owns
//! the decoded library (PCM per sound, loaded on the first press and kept:
//! the five-minute total bounds it), the voice list every surface reads
//! through `sounds.playback`, the press logic of the audiocn pad modes, and
//! the end timers. With a session bus it hands each voice to
//! `SessionAudio::soundboard()`; without one a voice exists for the monitor
//! and the UI only (`onAir: false`).
//!
//! The monitor ("Hear sounds yourself", plan 260 S1.3b) is the backend's own
//! output (`sound_monitor.rs`): after every change to the voices or the board
//! the player tells it which voices the streamer hears, at what gain.
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
    Sound, SoundMode, SoundPlayResult, SoundPressResult, SoundVoice, SoundboardState,
    SoundsPlayback,
};
use crate::session_audio::{SoundPlacement, SoundVoiceStart, SoundboardHandle};
use crate::sound_mix::SOUND_MAX_VOICES;
use crate::sound_monitor::{MonitorVoice, SoundMonitor, late_join_offset};
use crate::sound_store::load_sound_pcm;
use crate::state::AppState;

pub(crate) const SOUNDS_PLAYBACK_EVENT: &str = "sounds.playback";

/// The session bus the player currently feeds.
#[derive(Clone)]
struct SessionBus {
    session_id: String,
    handle: SoundboardHandle,
    /// A recording or a stream. A buffer-only Clips session (plan 181) does
    /// not attach this bus: idle presses stay monitor-only and out of the
    /// ring. Record and Go Live attach with `on_air: true`.
    on_air: bool,
}

struct PlayerVoice {
    key: u64,
    sound_id: String,
    started_at_ms: u64,
    duration_ms: u32,
    looping: bool,
    on_air: bool,
    /// The press instant and the voice's gain, for the backend room's aux
    /// mix (plan 260 S1.8c c4d), which renders by the same arithmetic.
    started: Instant,
    gain: f32,
    /// Registered, but the bus has not answered yet: whether it is on air
    /// (and so whether the monitor hears it with the monitor off) is unknown.
    placing: bool,
    /// `levelDb + volumeDb` at the press, for the monitor while it has no
    /// board.
    gain_db: f64,
}

/// A playing voice as the backend room's aux mix needs it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone)]
pub(crate) struct RoomVoice {
    pub(crate) pcm: Arc<[i16]>,
    pub(crate) gain: f32,
    pub(crate) started: Instant,
    pub(crate) looping: bool,
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
    /// Reserved before decode: Stop/restart cancels an in-flight press.
    pending: HashMap<String, u64>,
    bus: Option<SessionBus>,
    /// A recording or stream published without a session bus: sounds can't
    /// reach it (release test 147, plan 0001). Its session id.
    unmixed_session: Option<String>,
    /// What the monitor needs from the board: read once, then kept current
    /// by `sound_store::on_sounds_changed`.
    board: Option<MonitorBoard>,
}

/// The board as the monitor hears it.
#[derive(Debug, Clone, PartialEq)]
struct MonitorBoard {
    /// "Hear sounds yourself": on-air voices too.
    monitor: bool,
    volume_db: i32,
    /// Each sound's `levelDb + volumeDb`.
    sound_gain_db: HashMap<String, f64>,
}

impl MonitorBoard {
    fn from_state(board: &SoundboardState) -> Self {
        Self {
            monitor: board.monitor,
            volume_db: board.volume_db,
            sound_gain_db: board
                .sounds
                .iter()
                .map(|sound| {
                    (
                        sound.id.clone(),
                        sound.level_db + f64::from(sound.volume_db),
                    )
                })
                .collect(),
        }
    }
}

impl PlayerState {
    /// The voices the streamer hears (plan 189 D2: off air always, on air
    /// with the monitor on), each with its gain and, for a voice the monitor
    /// would start late, where in its sound to start.
    fn monitor_voices(&self, now_ms: u64) -> Vec<MonitorVoice> {
        self.voices
            .iter()
            .filter(|voice| !voice.placing)
            .filter_map(|voice| {
                let (monitor, board_db, sound_db) = match self.board.as_ref() {
                    // A sound the board no longer has is never heard.
                    Some(board) => (
                        board.monitor,
                        board.volume_db,
                        *board.sound_gain_db.get(&voice.sound_id)?,
                    ),
                    None => (true, 0, voice.gain_db),
                };
                if voice.on_air && !monitor {
                    return None;
                }
                let pcm = self.library.get(&voice.sound_id)?.clone();
                let frames = pcm.len() / 2;
                // The offset only places a voice the monitor starts now: a
                // one-shot already over never starts, but one the monitor is
                // playing plays on. Its wall-clock age runs a little ahead of
                // the monitor, which started after the press.
                let offset_frames =
                    late_join_offset(voice.started_at_ms, now_ms, frames, voice.looping)
                        .unwrap_or(frames);
                Some(MonitorVoice {
                    key: voice.key,
                    pcm,
                    gain: crate::audio::db_to_gain((sound_db + f64::from(board_db)) as f32),
                    looping: voice.looping,
                    offset_frames,
                })
            })
            .collect()
    }
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
    monitor: SoundMonitor,
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

impl SoundPlayer {
    /// Plays a short cue on the monitor (plan 260 S1.3c, the join chime).
    pub(crate) fn play_cue(&self, key: u64, pcm: Arc<[i16]>) -> bool {
        self.monitor.play_cue(key, pcm)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PlayerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every playing voice, oldest first.
    pub(crate) fn playback(&self) -> SoundsPlayback {
        let inner = self.lock();
        SoundsPlayback {
            voices: inner.voices.iter().map(PlayerVoice::wire).collect(),
            session_without_sounds: inner.unmixed_session.is_some(),
        }
    }

    /// Every playing voice with its decoded PCM, for the backend room's aux
    /// mix (plan 260 S1.8c c4d).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn room_voices(&self) -> Vec<RoomVoice> {
        let inner = self.lock();
        inner
            .voices
            .iter()
            .filter_map(|voice| {
                Some(RoomVoice {
                    pcm: inner.library.get(&voice.sound_id)?.clone(),
                    gain: voice.gain,
                    started: voice.started,
                    looping: voice.looping,
                })
            })
            .collect()
    }

    /// A recording or stream published without a session bus (a Linux
    /// microphone FFmpeg had to open directly): every surface says sounds
    /// can't reach it instead of claiming they play on stream (release test
    /// 147, plan 0001). Emits `sounds.playback`.
    pub(crate) fn session_without_bus(&self, state: &AppState, session_id: &str) {
        self.lock().unmixed_session = Some(session_id.to_string());
        self.emit(state);
    }

    /// A session with native audio published: its bus takes every voice
    /// from now on, at the board level from Sources.
    pub(crate) fn session_started(
        &self,
        session_id: &str,
        handle: SoundboardHandle,
        volume_db: i32,
        on_air: bool,
    ) {
        handle.set_volume_db(volume_db as f32);
        self.lock().bus = Some(SessionBus {
            session_id: session_id.to_string(),
            handle,
            on_air,
        });
    }

    /// The session ended: the bus ended every voice; a one-shot keeps
    /// playing in the monitor until its timer, a loop stops. Emits
    /// `sounds.playback` when anything changed.
    pub(crate) fn session_ended(&self, state: &AppState, session_id: &str) {
        let changed = {
            let mut inner = self.lock();
            if inner.unmixed_session.as_deref() == Some(session_id) {
                inner.unmixed_session = None;
                drop(inner);
                self.emit(state);
                return;
            }
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
        self.sync_monitor(state);
        state.emit_event(SOUNDS_PLAYBACK_EVENT, self.playback());
    }

    /// Tells the monitor which voices the streamer hears now. The plan is
    /// built and handed over under the player's lock, so an older plan never
    /// lands after a newer one.
    fn sync_monitor(&self, state: &AppState) {
        let board = if self.lock().board.is_none() {
            state
                .database
                .soundboard_state()
                .ok()
                .map(|board| MonitorBoard::from_state(&board))
        } else {
            None
        };
        let mut inner = self.lock();
        if inner.board.is_none() {
            inner.board = board;
        }
        self.monitor.sync(&inner.monitor_voices(now_ms()));
    }

    /// The board changed (`sound_store::on_sounds_changed`): the monitor
    /// follows the switch, the board level and each sound's level and trim.
    pub(crate) fn board_changed(&self, board: &SoundboardState) {
        let mut inner = self.lock();
        inner.board = Some(MonitorBoard::from_state(board));
        self.monitor.sync(&inner.monitor_voices(now_ms()));
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
        let started_at_ms = now_ms();
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
        let key = {
            let mut inner = self.lock();
            inner.next_key += 1;
            let key = inner.next_key;
            inner.pending.insert(sound.id.clone(), key);
            key
        };
        let decoded = self.ensure_loaded(state, &sound).await;
        let pcm = match decoded {
            Ok(pcm) => pcm,
            Err(error) => {
                let mut inner = self.lock();
                if inner.pending.get(&sound.id) == Some(&key) {
                    inner.pending.remove(&sound.id);
                }
                return Err(error);
            }
        };
        let looping = sound.mode == SoundMode::Loop;
        let gain = crate::audio::db_to_gain((sound.level_db + f64::from(sound.volume_db)) as f32);
        // Register the voice first, so a stop that races the bus's answer
        // still finds it; the bus hears about it next.
        let (bus, stopped) = {
            let mut inner = self.lock();
            if inner.pending.get(&sound.id) != Some(&key) {
                return Ok(SoundPlayResult {
                    voice_id: voice_id(key),
                    on_air: false,
                });
            }
            inner.pending.remove(&sound.id);
            if !looping
                && received_at.elapsed() >= Duration::from_millis(u64::from(sound.duration_ms))
            {
                return Ok(SoundPlayResult {
                    voice_id: voice_id(key),
                    on_air: false,
                });
            }
            inner.library.insert(sound.id.clone(), pcm.clone());
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
            inner.voices.push(PlayerVoice {
                key,
                sound_id: sound.id.clone(),
                started_at_ms,
                duration_ms: sound.duration_ms,
                looping,
                on_air: false,
                started: received_at,
                gain,
                placing: true,
                gain_db: sound.level_db + f64::from(sound.volume_db),
            });
            (inner.bus.clone(), stopped)
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
        let on_air = matches!(placement, SoundPlacement::OnAir { .. })
            && bus.as_ref().is_some_and(|bus| bus.on_air);
        {
            let mut inner = self.lock();
            match inner.voices.iter_mut().find(|voice| voice.key == key) {
                Some(voice) => {
                    voice.on_air = on_air;
                    voice.placing = false;
                }
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
            let remaining = Duration::from_millis(u64::from(sound.duration_ms))
                .saturating_sub(received_at.elapsed());
            tokio::spawn(async move {
                tokio::time::sleep(remaining).await;
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
            let pending = self.lock().pending.remove(sound_id).is_some();
            let playing: Vec<u64> = self
                .lock()
                .voices
                .iter()
                .filter(|voice| voice.sound_id == sound.id)
                .map(|voice| voice.key)
                .collect();
            if pending || !playing.is_empty() {
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
        self.lock()
            .pending
            .retain(|id, _| sound_id.is_some_and(|stopped| id != stopped));
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

    #[cfg(test)]
    fn render_monitor_for_test(&self) {
        self.monitor.render_for_test(512);
    }

    /// The end timer of a one-shot voice: gone from the list, if a stop did
    /// not take it first. The monitor lets it play out.
    fn end_voice(&self, state: &AppState, key: u64) {
        let ended = {
            let mut inner = self.lock();
            let before = inner.voices.len();
            inner.voices.retain(|voice| voice.key != key);
            let ended = inner.voices.len() != before;
            if ended {
                self.monitor.release(key);
            }
            ended
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
    use crate::test_temp_dir::TestTempDir;
    use tokio::sync::broadcast;

    /// The guard comes first so it drops after the state's database
    /// (Windows cannot remove a folder holding an open SQLite file).
    fn player_state() -> (TestTempDir, AppState, broadcast::Receiver<ServerEvent>) {
        let dir = TestTempDir::new("sound-player");
        let (events, receiver) = broadcast::channel(256);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_file_for_tests(&dir.join("videorc.sqlite3")),
        );
        (dir, state, receiver)
    }

    #[test]
    fn stop_and_evict_invalidate_pending_decode_keys_without_reusing_voice_ids() {
        let (_dir, state, _) = player_state();
        let player = &state.soundboard;
        {
            let mut inner = player.lock();
            inner.next_key = 42;
            inner.pending.insert("first".into(), 41);
            inner.pending.insert("second".into(), 42);
        }
        player.stop(&state, Some("first"));
        assert!(!player.lock().pending.contains_key("first"));
        assert_eq!(player.lock().pending.get("second"), Some(&42));
        player.evict(&state, "second");
        assert!(player.lock().pending.is_empty());
        player.lock().pending.insert("third".into(), 43);
        player.stop(&state, None);
        assert!(player.lock().pending.is_empty());
        assert_eq!(player.lock().next_key, 42);
        assert!(player.playback().voices.is_empty());
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
    async fn a_session_without_a_bus_is_announced_and_cleared_at_its_end() {
        // Release test 147, plan 0001: a session whose audio skips the bus
        // can't carry sounds, and the board says so until it ends.
        let (dir, state, mut receiver) = player_state();
        let player = SoundPlayer::default();
        assert!(!player.playback().session_without_sounds);
        player.session_without_bus(&state, "s-1");
        assert!(player.playback().session_without_sounds);
        // Another session ending changes nothing.
        player.session_ended(&state, "s-2");
        assert!(player.playback().session_without_sounds);
        player.session_ended(&state, "s-1");
        assert!(!player.playback().session_without_sounds);
        let flags: Vec<bool> = playback_events(&mut receiver)
            .into_iter()
            .map(|playback| playback.session_without_sounds)
            .collect();
        assert_eq!(flags, vec![true, false]);
        // The wire omits the flag when false (never `false` or null).
        assert_eq!(
            serde_json::to_value(player.playback()).unwrap(),
            serde_json::json!({ "voices": [] })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn play_press_and_stop_follow_the_pad_modes_without_a_session() {
        let (dir, state, mut events) = player_state();
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
        let (dir, state, mut events) = player_state();
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
        let (dir, state, _events) = player_state();
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

    fn key_of(voice_id: &str) -> u64 {
        voice_id.trim_start_matches("v-").parse().unwrap()
    }

    /// The monitor's voices as (key, target gain, fading out).
    fn monitored(player: &SoundPlayer) -> Vec<(u64, f32, bool)> {
        player
            .monitor
            .voices_for_test()
            .into_iter()
            .map(|(key, gain, _, fading)| (key, gain, fading))
            .collect()
    }

    fn settings(state: &AppState, params: crate::protocol::SoundboardSettingsParams) {
        state.database.update_sound_settings(&params).unwrap();
        crate::sound_store::on_sounds_changed(state).unwrap();
    }

    #[tokio::test]
    async fn the_monitor_plays_what_the_streamer_hears_at_the_board_gain() {
        // Plan 260 S1.3b: the backend's monitor, by plan 189 D2's rule: off
        // air every press is heard, on air only with "Hear sounds yourself"
        // on, at level + trim + board, following every board change.
        use crate::audio::db_to_gain;
        use crate::protocol::SoundboardSettingsParams;

        let (dir, state, _events) = player_state();
        let player = state.soundboard.clone();
        let ding = seed_sound(&state, "Ding", SoundMode::OneShot, 10_000);
        let gong = seed_sound(&state, "Gong", SoundMode::Toggle, 10_000);
        // Before any board event: the first change reads the board.
        state
            .database
            .update_sound_settings(&SoundboardSettingsParams {
                volume_db: Some(-6),
                ..Default::default()
            })
            .unwrap();

        let idle = key_of(&player.play(&state, &ding.id).await.unwrap().voice_id);
        assert_eq!(
            monitored(&player),
            vec![(idle, db_to_gain(2.0 - 6.0), false)]
        );

        // A trim change glides the playing voice to its new gain.
        state
            .database
            .update_sound(
                &ding.id,
                crate::sound_store::SoundUpdate {
                    volume_db: Some(-3),
                    ..Default::default()
                },
            )
            .unwrap();
        crate::sound_store::on_sounds_changed(&state).unwrap();
        assert_eq!(
            monitored(&player),
            vec![(idle, db_to_gain(2.0 - 3.0 - 6.0), false)]
        );

        // On air with the switch off: not heard; the idle voice still is.
        let (handle, _starts) = SoundboardHandle::test_recording_bus();
        player.session_started("record", handle, -6, true);
        settings(
            &state,
            SoundboardSettingsParams {
                monitor: Some(false),
                ..Default::default()
            },
        );
        let live = player.play(&state, &gong.id).await.unwrap();
        assert!(live.on_air);
        let live = key_of(&live.voice_id);
        assert_eq!(monitored(&player), vec![(idle, db_to_gain(-7.0), false)]);

        // The switch on: the on-air voice joins; off again: it fades out.
        settings(
            &state,
            SoundboardSettingsParams {
                monitor: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            monitored(&player),
            vec![
                (idle, db_to_gain(-7.0), false),
                (live, db_to_gain(-4.0), false)
            ]
        );
        settings(
            &state,
            SoundboardSettingsParams {
                monitor: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(
            monitored(&player),
            vec![
                (idle, db_to_gain(-7.0), false),
                (live, db_to_gain(-4.0), true)
            ]
        );

        // The session ends: the voice is off air, so heard again (a fresh
        // monitor voice for the same key, after the faded one).
        player.render_monitor_for_test();
        player.session_ended(&state, "record");
        assert_eq!(
            monitored(&player),
            vec![
                (idle, db_to_gain(-7.0), false),
                (live, db_to_gain(-4.0), false)
            ]
        );
        // The board level moves every voice; Stop all fades them all.
        settings(
            &state,
            SoundboardSettingsParams {
                volume_db: Some(0),
                ..Default::default()
            },
        );
        assert_eq!(
            monitored(&player),
            vec![
                (idle, db_to_gain(-1.0), false),
                (live, db_to_gain(2.0), false)
            ]
        );
        player.stop(&state, None);
        assert!(monitored(&player).iter().all(|(_, _, fading)| *fading));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_voice_the_monitor_plays_is_never_cut_by_its_wall_clock_age() {
        // smoke:soundboard caught it: a sync near a one-shot's end (here a
        // board change) saw its age past its length and faded it out, though
        // the monitor, which starts after the press, still had 70 ms to play.
        let (dir, state, _events) = player_state();
        let player = state.soundboard.clone();
        let ding = seed_sound(&state, "Ding", SoundMode::OneShot, 10_000);
        let key = key_of(&player.play(&state, &ding.id).await.unwrap().voice_id);
        player.lock().voices[0].started_at_ms -= 20_000;
        let board = state.database.soundboard_state().unwrap();
        player.board_changed(&board);
        assert_eq!(
            monitored(&player)
                .iter()
                .map(|(key, _, fading)| (*key, *fading))
                .collect::<Vec<_>>(),
            vec![(key, false)]
        );
        // A voice that old the monitor is not playing yet never starts.
        player.stop(&state, None);
        player.render_monitor_for_test();
        assert!(monitored(&player).is_empty());
        player.lock().voices.push(PlayerVoice {
            key: key + 1,
            sound_id: ding.id.clone(),
            started_at_ms: now_ms() - 20_000,
            duration_ms: 10_000,
            looping: false,
            on_air: false,
            started: Instant::now() - Duration::from_secs(20),
            gain: crate::audio::db_to_gain(2.0),
            placing: false,
            gain_db: 2.0,
        });
        player.board_changed(&board);
        assert!(monitored(&player).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_one_shot_plays_out_in_the_monitor_past_its_timer_and_a_restart_fades_the_old_voice()
    {
        let (dir, state, _events) = player_state();
        let player = state.soundboard.clone();
        let short = seed_sound(&state, "Tick", SoundMode::OneShot, 100);
        let first = key_of(&player.play(&state, &short.id).await.unwrap().voice_id);
        let second = key_of(&player.play(&state, &short.id).await.unwrap().voice_id);
        // Play once restarts: the old voice fades, the new one plays.
        assert_eq!(
            monitored(&player)
                .iter()
                .map(|(key, _, fading)| (*key, *fading))
                .collect::<Vec<_>>(),
            vec![(first, true), (second, false)]
        );
        player.render_monitor_for_test();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(player.playback().voices.is_empty(), "the timer ended it");
        // Not faded: the monitor started it a little after the press, so it
        // ends a little after the timer, on its own.
        assert_eq!(
            monitored(&player)
                .iter()
                .map(|(key, _, fading)| (*key, *fading))
                .collect::<Vec<_>>(),
            vec![(second, false)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_replay_only_session_does_not_mix_idle_presses_into_the_bus() {
        // Option A: recording.rs skips session_started on a buffer-only
        // Clips session. The handle exists (the ring has a bus) but the
        // player never attaches, so a press is monitor-only and the bus
        // gets no Start. Record / Go Live attach with on_air: true and
        // mix once. The old path attached with on_air: false, which still
        // mixed voices into the ring while sounds.press answered false.
        use std::sync::atomic::Ordering;

        let (dir, state, _events) = player_state();
        let player = state.soundboard.clone();
        let ding = seed_sound(&state, "Ding", SoundMode::OneShot, 10_000);
        let (handle, starts) = SoundboardHandle::test_recording_bus();

        let idle = player.press(&state, &ding.id).await.unwrap();
        assert!(!idle.on_air);
        assert_eq!(
            starts.load(Ordering::SeqCst),
            0,
            "an unattached replay-only bus must not hear the press"
        );
        player.stop(&state, None);

        player.session_started("record", handle, 0, true);
        let live = player.press(&state, &ding.id).await.unwrap();
        assert!(live.on_air);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        player.stop(&state, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
