//! Audio facts from the 16 kHz mono PCM extraction: a streaming WAV reader
//! (a 4-hour recording is 460 MB of samples and is never held whole), RMS per
//! 50 ms frame, chunk windows that end at the quietest point of their last
//! seconds, and the speech bounds used when a recording has no words at all.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use super::rules::{
    CHUNK_CUT_SEARCH_MS, CHUNK_MAX_MS, CHUNK_OVERLAP_MS, RMS_FRAME_MS, SAMPLE_RATE,
    SILENCE_BELOW_SPEECH_DB, SILENCE_FLOOR_DBFS,
};

/// Digital silence, in dBFS, for an all-zero frame.
pub const SILENT_DBFS: f64 = -120.0;

/// A canonical PCM s16le mono 16 kHz WAV on disk, located but not loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WavInfo {
    pub path: PathBuf,
    pub data_offset: u64,
    pub data_len: u64,
}

/// Parse the RIFF chunk list up to `data`. Extra chunks (`LIST`, `fact`) are
/// skipped; a `data` length of 0 or past the file end (a writer that could
/// not seek back) is clamped to the file.
pub fn open_wav(path: &Path) -> Result<WavInfo> {
    let mut file =
        File::open(path).with_context(|| format!("Could not open {}", path.display()))?;
    let file_len = file.metadata()?.len();
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff)
        .context("Clean cut audio is not a WAV file")?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        bail!("Clean cut audio is not a RIFF/WAVE file");
    }
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<(u64, u64)> = None;
    let mut offset: u64 = 12;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let length = u64::from(u32::from_le_bytes([
            header[4], header[5], header[6], header[7],
        ]));
        let payload = offset + 8;
        if &header[0..4] == b"fmt " {
            if length < 16 {
                bail!("Clean cut audio has a short fmt chunk");
            }
            let mut fmt = [0_u8; 16];
            file.read_exact(&mut fmt)?;
            format = Some((
                u16::from_le_bytes([fmt[0], fmt[1]]),
                u16::from_le_bytes([fmt[2], fmt[3]]),
                u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]),
                u16::from_le_bytes([fmt[14], fmt[15]]),
            ));
        } else if &header[0..4] == b"data" {
            let available = file_len.saturating_sub(payload);
            let length = if length == 0 || length > available {
                available
            } else {
                length
            };
            data = Some((payload, length - length % 2));
            break;
        }
        offset = payload + length + (length % 2);
    }
    let (audio_format, channels, sample_rate, bits) =
        format.context("Clean cut audio has no fmt chunk")?;
    if audio_format != 1 || channels != 1 || sample_rate != SAMPLE_RATE || bits != 16 {
        bail!(
            "Clean cut audio must be PCM s16le mono {SAMPLE_RATE} Hz (got format {audio_format}, \
             {channels} channel(s), {sample_rate} Hz, {bits} bits)"
        );
    }
    let (data_offset, data_len) = data.context("Clean cut audio has no data chunk")?;
    Ok(WavInfo {
        path: path.to_path_buf(),
        data_offset,
        data_len,
    })
}

impl WavInfo {
    pub fn sample_count(&self) -> u64 {
        self.data_len / 2
    }

    pub fn duration_ms(&self) -> u64 {
        self.sample_count() * 1_000 / u64::from(SAMPLE_RATE)
    }

    /// The samples of `[start_ms, end_ms)`, clamped to the file.
    pub fn read_samples_ms(&self, start_ms: u64, end_ms: u64) -> Result<Vec<i16>> {
        let start = ms_to_sample(start_ms).min(self.sample_count());
        let end = ms_to_sample(end_ms).min(self.sample_count()).max(start);
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_offset + start * 2))?;
        let mut bytes = vec![0_u8; usize::try_from((end - start) * 2)?];
        file.read_exact(&mut bytes)?;
        Ok(bytes_to_samples(&bytes))
    }

    /// One streaming pass over the file.
    pub fn rms_frames(&self) -> Result<RmsFrames> {
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_offset))?;
        let frame_samples = frame_sample_count(RMS_FRAME_MS);
        let mut dbfs =
            Vec::with_capacity((self.sample_count() / frame_samples as u64 + 1) as usize);
        let mut remaining = self.data_len;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut sum_squares = 0.0_f64;
        let mut in_frame = 0_usize;
        while remaining > 0 {
            let want = buffer.len().min(usize::try_from(remaining)?);
            let read = file.read(&mut buffer[..want])?;
            if read == 0 {
                break;
            }
            remaining -= read as u64;
            for pair in buffer[..read - read % 2].chunks_exact(2) {
                let sample = f64::from(i16::from_le_bytes([pair[0], pair[1]]));
                sum_squares += sample * sample;
                in_frame += 1;
                if in_frame == frame_samples {
                    dbfs.push(sample_dbfs(sum_squares, in_frame));
                    sum_squares = 0.0;
                    in_frame = 0;
                }
            }
        }
        if in_frame > 0 {
            dbfs.push(sample_dbfs(sum_squares, in_frame));
        }
        Ok(RmsFrames {
            frame_ms: RMS_FRAME_MS,
            dbfs,
        })
    }
}

pub fn ms_to_sample(ms: u64) -> u64 {
    ms * u64::from(SAMPLE_RATE) / 1_000
}

fn frame_sample_count(frame_ms: u64) -> usize {
    (frame_ms * u64::from(SAMPLE_RATE) / 1_000).max(1) as usize
}

fn bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// RMS of one frame in dBFS from its sum of squares.
pub fn sample_dbfs(sum_squares: f64, count: usize) -> f64 {
    if count == 0 {
        return SILENT_DBFS;
    }
    let rms = (sum_squares / count as f64).sqrt() / f64::from(i16::MAX);
    if rms <= 1e-6 {
        SILENT_DBFS
    } else {
        (20.0 * rms.log10()).max(SILENT_DBFS)
    }
}

/// Per-frame loudness in dBFS, frame `i` covering `[i * frame_ms, (i + 1) * frame_ms)`.
#[derive(Debug, Clone, PartialEq)]
pub struct RmsFrames {
    pub frame_ms: u64,
    pub dbfs: Vec<f64>,
}

impl RmsFrames {
    /// Pure construction for tests; production streams the file.
    #[cfg(test)]
    pub fn from_samples(samples: &[i16], frame_ms: u64) -> Self {
        let frame_samples = frame_sample_count(frame_ms);
        let dbfs = samples
            .chunks(frame_samples)
            .map(|frame| {
                let sum_squares = frame
                    .iter()
                    .map(|sample| {
                        let value = f64::from(*sample);
                        value * value
                    })
                    .sum::<f64>();
                sample_dbfs(sum_squares, frame.len())
            })
            .collect();
        Self { frame_ms, dbfs }
    }

    pub fn frame_start_ms(&self, index: usize) -> u64 {
        index as u64 * self.frame_ms
    }

    /// The frames that start inside `[start_ms, end_ms)`.
    pub fn slice(&self, start_ms: u64, end_ms: u64) -> &[f64] {
        if end_ms <= start_ms || self.dbfs.is_empty() {
            return &[];
        }
        let first = (start_ms / self.frame_ms) as usize;
        let last = ((end_ms - 1) / self.frame_ms) as usize + 1;
        let first = first.min(self.dbfs.len());
        let last = last.clamp(first, self.dbfs.len());
        &self.dbfs[first..last]
    }

    /// The level that `percentile` (0..1) of the frames in the range sit at
    /// or below. `None` when the range holds no frame.
    pub fn percentile_dbfs(&self, start_ms: u64, end_ms: u64, percentile: f64) -> Option<f64> {
        let mut levels = self.slice(start_ms, end_ms).to_vec();
        if levels.is_empty() {
            return None;
        }
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let rank = ((levels.len() as f64 - 1.0) * percentile.clamp(0.0, 1.0)).round() as usize;
        levels.get(rank.min(levels.len() - 1)).copied()
    }

    /// Start of the quietest frame in `[start_ms, end_ms)`; the latest wins a
    /// tie, so uniform audio still gets the longest allowed window. `None`
    /// when the range holds no frame.
    pub fn quietest_frame_start_ms(&self, start_ms: u64, end_ms: u64) -> Option<u64> {
        if end_ms <= start_ms || self.dbfs.is_empty() {
            return None;
        }
        let first = ((start_ms / self.frame_ms) as usize).min(self.dbfs.len());
        let last = (((end_ms - 1) / self.frame_ms) as usize + 1).clamp(first, self.dbfs.len());
        let mut best: Option<(usize, f64)> = None;
        for (offset, level) in self.dbfs[first..last].iter().enumerate() {
            if best.is_none_or(|(_, best_level)| *level <= best_level) {
                best = Some((first + offset, *level));
            }
        }
        best.map(|(index, _)| self.frame_start_ms(index))
    }

    /// Median level over the frames inside any of `ranges`.
    pub fn median_dbfs_in_ranges(&self, ranges: &[(u64, u64)]) -> Option<f64> {
        let mut levels: Vec<f64> = ranges
            .iter()
            .flat_map(|(start, end)| self.slice(*start, *end).iter().copied())
            .collect();
        if levels.is_empty() {
            return None;
        }
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(levels[levels.len() / 2])
    }
}

/// The silence threshold for one recording: the lower of the fixed floor and
/// 18 dB under the median level inside the spoken words (decision 16).
pub fn silence_threshold_dbfs(frames: &RmsFrames, speech_ranges: &[(u64, u64)]) -> f64 {
    match frames.median_dbfs_in_ranges(speech_ranges) {
        Some(median) => SILENCE_FLOOR_DBFS.min(median - SILENCE_BELOW_SPEECH_DB),
        None => SILENCE_FLOOR_DBFS,
    }
}

/// Start of the first and end of the last frame above `threshold_dbfs`.
pub fn speech_bounds_ms(frames: &RmsFrames, threshold_dbfs: f64) -> Option<(u64, u64)> {
    let first = frames
        .dbfs
        .iter()
        .position(|level| *level >= threshold_dbfs)?;
    let last = frames
        .dbfs
        .iter()
        .rposition(|level| *level >= threshold_dbfs)?;
    Some((
        frames.frame_start_ms(first),
        frames.frame_start_ms(last) + frames.frame_ms,
    ))
}

/// One upload window of the recording, in recording time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkWindow {
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Cut the recording into windows of at most `CHUNK_MAX_MS`. Each window ends
/// at the quietest frame inside the last `CHUNK_CUT_SEARCH_MS` of its span,
/// and the next window starts `CHUNK_OVERLAP_MS` earlier so no word is lost
/// at a boundary. Deterministic for the same audio, which is what makes a
/// resumed job reuse its chunks.
pub fn plan_chunk_windows(frames: &RmsFrames, duration_ms: u64) -> Vec<ChunkWindow> {
    let mut windows = Vec::new();
    let mut start = 0_u64;
    while start < duration_ms {
        let index = windows.len() as u32;
        let remaining = duration_ms - start;
        if remaining <= CHUNK_MAX_MS {
            windows.push(ChunkWindow {
                index,
                start_ms: start,
                end_ms: duration_ms,
            });
            break;
        }
        let search_start = start + CHUNK_MAX_MS - CHUNK_CUT_SEARCH_MS;
        let search_end = start + CHUNK_MAX_MS;
        let cut = frames
            .quietest_frame_start_ms(search_start, search_end)
            .unwrap_or(search_end)
            .clamp(search_start, search_end);
        windows.push(ChunkWindow {
            index,
            start_ms: start,
            end_ms: cut,
        });
        start = cut - CHUNK_OVERLAP_MS;
    }
    windows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::captions::encode_wav_16k_mono;

    fn tone(duration_ms: u64, amplitude: i16) -> Vec<i16> {
        (0..ms_to_sample(duration_ms))
            .map(|index| {
                if index % 2 == 0 {
                    amplitude
                } else {
                    -amplitude
                }
            })
            .collect()
    }

    #[test]
    fn rms_frames_measure_silence_and_level() {
        let mut samples = tone(100, 0);
        samples.extend(tone(100, 8_000));
        let frames = RmsFrames::from_samples(&samples, 50);
        assert_eq!(frames.dbfs.len(), 4);
        assert_eq!(frames.dbfs[0], SILENT_DBFS);
        assert_eq!(frames.dbfs[1], SILENT_DBFS);
        assert!(
            (frames.dbfs[2] - (-12.25)).abs() < 0.5,
            "{}",
            frames.dbfs[2]
        );
        assert_eq!(frames.frame_start_ms(3), 150);
        assert_eq!(frames.slice(0, 100).len(), 2);
        assert_eq!(frames.slice(60, 160).len(), 3);
        assert_eq!(frames.percentile_dbfs(0, 100, 0.9), Some(SILENT_DBFS));
        assert_eq!(
            frames.median_dbfs_in_ranges(&[(100, 200)]),
            Some(frames.dbfs[3])
        );
        assert_eq!(speech_bounds_ms(&frames, -45.0), Some((100, 200)));
        assert_eq!(speech_bounds_ms(&frames, 0.0), None);
    }

    #[test]
    fn silence_threshold_is_the_lower_of_floor_and_speech_minus_18() {
        let loud = RmsFrames {
            frame_ms: 50,
            dbfs: vec![-10.0, -10.0, -10.0],
        };
        assert_eq!(silence_threshold_dbfs(&loud, &[(0, 150)]), -45.0);
        let quiet = RmsFrames {
            frame_ms: 50,
            dbfs: vec![-40.0, -40.0, -40.0],
        };
        assert_eq!(silence_threshold_dbfs(&quiet, &[(0, 150)]), -58.0);
        assert_eq!(silence_threshold_dbfs(&quiet, &[]), -45.0);
    }

    #[test]
    fn windows_cut_at_the_quietest_frame_and_overlap_by_one_second() {
        // 300 s of speech-level noise with one silent frame at 115.0 s and
        // another at 231.5 s.
        let total_ms = 300_000;
        let mut dbfs = vec![-20.0; (total_ms / 50) as usize];
        dbfs[115_000 / 50] = SILENT_DBFS;
        dbfs[231_500 / 50] = SILENT_DBFS;
        let frames = RmsFrames { frame_ms: 50, dbfs };
        let windows = plan_chunk_windows(&frames, total_ms);

        assert_eq!(windows[0].start_ms, 0);
        assert_eq!(windows[0].end_ms, 115_000);
        assert_eq!(windows[1].start_ms, 114_000, "one second of overlap");
        assert_eq!(windows[1].end_ms, 231_500);
        assert_eq!(windows[2].start_ms, 230_500);
        assert_eq!(windows.last().unwrap().end_ms, total_ms);
        for (index, window) in windows.iter().enumerate() {
            assert_eq!(window.index as usize, index);
            let duration = window.end_ms - window.start_ms;
            assert!(duration <= CHUNK_MAX_MS);
            assert!(duration > CHUNK_OVERLAP_MS);
            assert!(
                (duration * u64::from(SAMPLE_RATE) / 1_000 * 2 + 44) as usize
                    <= super::super::rules::CHUNK_MAX_BYTES
            );
        }
        for pair in windows.windows(2) {
            assert_eq!(pair[0].end_ms - pair[1].start_ms, CHUNK_OVERLAP_MS);
        }
    }

    #[test]
    fn windows_without_a_quiet_frame_cut_at_the_limit_and_short_audio_is_one_window() {
        let frames = RmsFrames {
            frame_ms: 50,
            dbfs: vec![-20.0; 250_000 / 50],
        };
        let windows = plan_chunk_windows(&frames, 250_000);
        assert_eq!(
            windows[0].end_ms, 119_950,
            "ties pick the latest frame in the search span"
        );
        assert_eq!(windows[1].start_ms, 118_950);
        assert_eq!(windows[1].end_ms, 238_900);
        assert_eq!(windows.len(), 3);
        let short = plan_chunk_windows(&RmsFrames::from_samples(&[], 50), 30_000);
        assert_eq!(
            short,
            vec![ChunkWindow {
                index: 0,
                start_ms: 0,
                end_ms: 30_000
            }]
        );
        assert!(plan_chunk_windows(&frames, 0).is_empty());
    }

    #[test]
    fn wav_reader_streams_the_file_it_wrote() {
        let dir =
            std::env::temp_dir().join(format!("videorc-clean-cut-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audio-16k.wav");
        let mut samples = tone(100, 0);
        samples.extend(tone(100, 8_000));
        std::fs::write(&path, encode_wav_16k_mono(&samples)).unwrap();

        let wav = open_wav(&path).unwrap();
        assert_eq!(wav.data_offset, 44);
        assert_eq!(wav.sample_count(), samples.len() as u64);
        assert_eq!(wav.duration_ms(), 200);
        let frames = wav.rms_frames().unwrap();
        assert_eq!(frames, RmsFrames::from_samples(&samples, 50));
        let window = wav.read_samples_ms(100, 150).unwrap();
        assert_eq!(window, &samples[1_600..2_400]);
        assert!(wav.read_samples_ms(190, 400).unwrap().len() == 160);

        std::fs::write(&path, b"not a wav").unwrap();
        assert!(open_wav(&path).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
