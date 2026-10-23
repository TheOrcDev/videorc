//! The soundboard's voices on the session bus (plan 189 S3): a pure renderer
//! over pre-decoded PCM. No I/O, no locks, and no allocation per chunk beyond
//! the output buffer; the bus thread calls [`SoundVoices::render`] once per
//! 10 ms chunk and sums the result after every existing tap, so the
//! microphone ISO file, captions, Buddy's ears and the echo guard never hear
//! a sound.
//!
//! Timing is sample arithmetic: a voice starts at the bus sample of its
//! press, a stop or restart ramps the old voice to zero over 240 frames, and
//! a loop wraps at its last frame. The board level is re-read per chunk and
//! ramps across the chunk so a fader move never zips.

use std::sync::Arc;

/// The stop and restart ramp: 5 ms at 48 kHz, the bus's own `RAMP_FRAMES`.
pub(crate) const SOUND_RAMP_FRAMES: u16 = 240;
/// At most this many voices at once; a ninth stops the oldest (D8).
pub(crate) const SOUND_MAX_VOICES: usize = 8;

/// A voice entering the bus.
#[derive(Debug, Clone)]
pub(crate) struct VoiceStart {
    /// The player's key for this voice; stops name it.
    pub key: u64,
    /// Interleaved stereo s16 at 48 kHz, trimmed at import.
    pub pcm: Arc<[i16]>,
    /// The bus sample of the press: `(received_at - epoch) * 48000`.
    pub start_sample: u64,
    /// `levelDb + volumeDb` as linear gain; the board level is applied per
    /// chunk by the renderer.
    pub gain: f32,
    pub looping: bool,
}

#[derive(Debug, Clone)]
struct Voice {
    key: u64,
    pcm: Arc<[i16]>,
    start: u64,
    gain: f32,
    looping: bool,
    /// Frames left in the ramp to zero; `None` while playing at unity.
    ramp: Option<u16>,
    /// Played to its end, or ramped to zero: dropped after this render.
    finished: bool,
}

impl Voice {
    fn frames(&self) -> u64 {
        (self.pcm.len() / 2) as u64
    }

    /// The source frame for bus sample `position`, or `None` before the
    /// voice starts or after a non-looping voice ends.
    fn source_frame(&self, position: u64) -> Option<usize> {
        let index = position.checked_sub(self.start)?;
        let frames = self.frames();
        if frames == 0 {
            return None;
        }
        if index < frames {
            Some(index as usize)
        } else if self.looping {
            Some((index % frames) as usize)
        } else {
            None
        }
    }
}

/// Every voice the bus is playing, oldest first.
#[derive(Debug, Default)]
pub(crate) struct SoundVoices {
    voices: Vec<Voice>,
    /// The board gain the previous chunk ended on; the next chunk ramps from
    /// it.
    board_gain: Option<f32>,
}

impl SoundVoices {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Nothing to render: the bus keeps its mic-only write path.
    pub(crate) fn is_idle(&self) -> bool {
        self.voices.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn keys(&self) -> Vec<u64> {
        self.voices.iter().map(|voice| voice.key).collect()
    }

    /// Adds a voice and returns the bus sample it starts at: the press
    /// sample, or `cursor` when the press arrived after its sample had
    /// passed (an output stall). A ninth voice ramps the oldest one out.
    pub(crate) fn start(&mut self, voice: VoiceStart, cursor: u64) -> u64 {
        let playing = self
            .voices
            .iter()
            .filter(|voice| voice.ramp.is_none())
            .count();
        if playing >= SOUND_MAX_VOICES
            && let Some(oldest) = self.voices.iter_mut().find(|voice| voice.ramp.is_none())
        {
            oldest.ramp = Some(SOUND_RAMP_FRAMES);
        }
        let start = voice.start_sample.max(cursor);
        self.voices.push(Voice {
            key: voice.key,
            pcm: voice.pcm,
            start,
            gain: voice.gain,
            looping: voice.looping,
            ramp: None,
            finished: false,
        });
        start
    }

    /// Ramps the voice to zero over [`SOUND_RAMP_FRAMES`] from the next
    /// rendered frame. False when no such voice plays.
    pub(crate) fn stop(&mut self, key: u64) -> bool {
        let mut found = false;
        for voice in self.voices.iter_mut().filter(|voice| voice.key == key) {
            found = true;
            if voice.ramp.is_none() {
                voice.ramp = Some(SOUND_RAMP_FRAMES);
            }
        }
        found
    }

    pub(crate) fn stop_all(&mut self) {
        for voice in self.voices.iter_mut() {
            if voice.ramp.is_none() {
                voice.ramp = Some(SOUND_RAMP_FRAMES);
            }
        }
    }

    /// Sums every voice into a fresh stereo chunk of `frames` frames that
    /// starts at bus sample `chunk_start`, at `voice gain × board gain`.
    /// `board_gain` is linear; a change from the previous chunk ramps across
    /// this one. `None` when no voice plays, so an idle board costs the bus
    /// nothing and the mic-only path stays byte-identical.
    pub(crate) fn render(
        &mut self,
        chunk_start: u64,
        frames: usize,
        board_gain: f32,
    ) -> Option<Vec<f32>> {
        if self.voices.is_empty() {
            self.board_gain = Some(board_gain);
            return None;
        }
        let board_from = self.board_gain.unwrap_or(board_gain);
        self.board_gain = Some(board_gain);
        let mut output = vec![0.0_f32; frames * 2];
        for voice in self.voices.iter_mut() {
            for (frame, out) in output.chunks_exact_mut(2).enumerate() {
                let position = chunk_start + frame as u64;
                let Some(source) = voice.source_frame(position) else {
                    if position >= voice.start {
                        // Past the end of a one-shot: it is over.
                        voice.finished = true;
                        break;
                    }
                    continue;
                };
                let ramp = match voice.ramp.as_mut() {
                    Some(remaining) => {
                        if *remaining == 0 {
                            voice.finished = true;
                            break;
                        }
                        *remaining -= 1;
                        f32::from(*remaining) / f32::from(SOUND_RAMP_FRAMES)
                    }
                    None => 1.0,
                };
                let board = if board_from == board_gain {
                    board_gain
                } else {
                    board_from + (board_gain - board_from) * ((frame + 1) as f32 / frames as f32)
                };
                let gain = voice.gain * board * ramp;
                out[0] += f32::from(voice.pcm[source * 2]) / 32_768.0 * gain;
                out[1] += f32::from(voice.pcm[source * 2 + 1]) / 32_768.0 * gain;
            }
            if voice.ramp == Some(0) {
                voice.finished = true;
            }
        }
        self.voices.retain(|voice| !voice.finished);
        Some(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK: usize = 480;

    /// A stereo ramp whose left sample is `frame + 1` (so frame 0 is 1, never
    /// a silent 0) and whose right sample is the negative.
    fn ramp_pcm(frames: usize) -> Arc<[i16]> {
        let mut pcm = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = (frame + 1) as i16;
            pcm.push(value);
            pcm.push(-value);
        }
        pcm.into()
    }

    fn voice(key: u64, frames: usize, start_sample: u64) -> VoiceStart {
        VoiceStart {
            key,
            pcm: ramp_pcm(frames),
            start_sample,
            gain: 1.0,
            looping: false,
        }
    }

    fn left(samples: &[f32], frame: usize) -> f32 {
        samples[frame * 2]
    }

    fn expected(value: usize) -> f32 {
        value as f32 / 32_768.0
    }

    #[test]
    fn idle_renders_none_and_costs_nothing() {
        let mut voices = SoundVoices::new();
        assert!(voices.is_idle());
        assert_eq!(voices.render(0, CHUNK, 1.0), None);
        assert_eq!(voices.render(480, CHUNK, 0.5), None);
    }

    #[test]
    fn a_voice_starts_at_its_press_sample() {
        let mut voices = SoundVoices::new();
        assert_eq!(voices.start(voice(1, 1_000, 1_000), 480), 1_000);
        // The chunk before the press is silent, but rendered (the voice is
        // scheduled).
        let before = voices.render(480, CHUNK, 1.0).unwrap();
        assert!(before.iter().all(|sample| *sample == 0.0));
        let chunk = voices.render(960, CHUNK, 1.0).unwrap();
        assert_eq!(left(&chunk, 39), 0.0);
        assert_eq!(left(&chunk, 40), expected(1));
        assert_eq!(left(&chunk, 41), expected(2));
        assert_eq!(chunk[41 * 2 + 1], -expected(2));
    }

    #[test]
    fn a_late_press_starts_at_the_cursor() {
        let mut voices = SoundVoices::new();
        // Pressed for sample 100 but the bus already rendered to 960.
        assert_eq!(voices.start(voice(1, 1_000, 100), 960), 960);
        let chunk = voices.render(960, CHUNK, 1.0).unwrap();
        assert_eq!(left(&chunk, 0), expected(1));
        assert_eq!(left(&chunk, 479), expected(480));
    }

    #[test]
    fn a_one_shot_ends_at_its_last_frame_and_leaves() {
        let mut voices = SoundVoices::new();
        voices.start(voice(1, 100, 0), 0);
        let chunk = voices.render(0, CHUNK, 1.0).unwrap();
        assert_eq!(left(&chunk, 99), expected(100));
        assert_eq!(left(&chunk, 100), 0.0);
        assert!(voices.is_idle(), "the finished voice is dropped");
        assert_eq!(voices.render(480, CHUNK, 1.0), None);
    }

    #[test]
    fn a_loop_wraps_sample_exact() {
        let mut voices = SoundVoices::new();
        voices.start(
            VoiceStart {
                looping: true,
                ..voice(1, 300, 0)
            },
            0,
        );
        let chunk = voices.render(0, CHUNK, 1.0).unwrap();
        assert_eq!(left(&chunk, 299), expected(300));
        assert_eq!(left(&chunk, 300), expected(1));
        assert_eq!(left(&chunk, 479), expected(180));
        let next = voices.render(480, CHUNK, 1.0).unwrap();
        assert_eq!(left(&next, 0), expected(181));
        assert!(!voices.is_idle(), "a loop never ends on its own");
    }

    #[test]
    fn a_stop_ramps_out_over_exactly_240_frames() {
        let mut voices = SoundVoices::new();
        let pcm: Arc<[i16]> = vec![16_384; 2_000 * 2].into();
        voices.start(
            VoiceStart {
                key: 7,
                pcm,
                start_sample: 0,
                gain: 1.0,
                looping: false,
            },
            0,
        );
        let steady = voices.render(0, CHUNK, 1.0).unwrap();
        assert!(steady.iter().all(|sample| *sample == 0.5));
        assert!(voices.stop(7));
        assert!(!voices.stop(8));
        let ramp = voices.render(480, CHUNK, 1.0).unwrap();
        // Frame 0 is 239/240, frame 239 is zero, and it stays zero.
        assert!((left(&ramp, 0) - 0.5 * 239.0 / 240.0).abs() < 1.0e-6);
        assert!((left(&ramp, 120) - 0.5 * 119.0 / 240.0).abs() < 1.0e-6);
        assert_eq!(left(&ramp, 239), 0.0);
        assert!(ramp[240 * 2..].iter().all(|sample| *sample == 0.0));
        assert!(voices.is_idle(), "the ramped voice is dropped");
    }

    #[test]
    fn a_restart_ramps_the_old_voice_out_while_the_new_one_starts() {
        let mut voices = SoundVoices::new();
        let pcm: Arc<[i16]> = vec![16_384; 2_000 * 2].into();
        let start = |key| VoiceStart {
            key,
            pcm: pcm.clone(),
            start_sample: 0,
            gain: 1.0,
            looping: false,
        };
        voices.start(start(1), 0);
        voices.render(0, CHUNK, 1.0);
        // The player's restart: stop the old key, start a new one at the
        // press sample.
        voices.stop(1);
        voices.start(
            VoiceStart {
                start_sample: 480,
                ..start(2)
            },
            480,
        );
        let chunk = voices.render(480, CHUNK, 1.0).unwrap();
        // Frame 0: old at 239/240 plus new at unity.
        assert!((left(&chunk, 0) - (0.5 * 239.0 / 240.0 + 0.5)).abs() < 1.0e-6);
        // Past the ramp only the new voice remains.
        assert_eq!(left(&chunk, 300), 0.5);
        assert_eq!(voices.keys(), vec![2]);
    }

    #[test]
    fn a_ninth_voice_ramps_the_oldest_out() {
        let mut voices = SoundVoices::new();
        for key in 1..=8 {
            voices.start(voice(key, 5_000, 0), 0);
        }
        voices.start(voice(9, 5_000, 0), 0);
        assert_eq!(voices.keys().len(), 9);
        // Render past the ramp: the oldest is gone, eight remain.
        voices.render(0, CHUNK, 1.0);
        assert_eq!(voices.keys(), (2..=9).collect::<Vec<_>>());
    }

    #[test]
    fn gain_is_voice_times_board_and_the_board_ramps_across_one_chunk() {
        let mut voices = SoundVoices::new();
        let pcm: Arc<[i16]> = vec![16_384; 3_000 * 2].into();
        voices.start(
            VoiceStart {
                key: 1,
                pcm,
                start_sample: 0,
                gain: 0.5,
                looping: false,
            },
            0,
        );
        // Voice 0.5 × board 1.0 on a 0.5 sample.
        let first = voices.render(0, CHUNK, 1.0).unwrap();
        assert!(first.iter().all(|sample| *sample == 0.25));
        // The board drops to 0.5: the chunk ramps from 1.0 toward 0.5 and
        // reaches it exactly on its last frame.
        let ramp = voices.render(480, CHUNK, 0.5).unwrap();
        assert!(left(&ramp, 0) < 0.25 && left(&ramp, 0) > 0.125);
        assert!((left(&ramp, 479) - 0.125).abs() < 1.0e-6);
        assert!(left(&ramp, 100) > left(&ramp, 300));
        // Steady at the new level: exact, no ramp.
        let steady = voices.render(960, CHUNK, 0.5).unwrap();
        assert!(steady.iter().all(|sample| *sample == 0.125));
    }

    #[test]
    fn voices_sum() {
        let mut voices = SoundVoices::new();
        let pcm: Arc<[i16]> = vec![8_192; 1_000 * 2].into();
        for key in [1, 2, 3] {
            voices.start(
                VoiceStart {
                    key,
                    pcm: pcm.clone(),
                    start_sample: 0,
                    gain: 1.0,
                    looping: false,
                },
                0,
            );
        }
        let chunk = voices.render(0, CHUNK, 1.0).unwrap();
        assert!(chunk.iter().all(|sample| *sample == 0.75));
        voices.stop_all();
        voices.render(480, CHUNK, 1.0);
        assert!(voices.is_idle());
    }
}
