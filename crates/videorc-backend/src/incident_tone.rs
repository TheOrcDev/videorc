//! The debug FFmpeg-tone incident control (plan 112, #1008).
//!
//! The control proves whether a stream or recording fault lives in the app's
//! audio bus: it carries an 880 Hz tone that never touches that bus. It used
//! to be an FFmpeg `lavfi` source, which FFmpeg generates as fast as it can.
//! Every real audio input instead arrives at wall-clock pace through a session
//! PCM FIFO, so the control measured a source no session has: when the video
//! pipe ended, `-shortest` still let 117-267 ms of buffered tone through on
//! every RTMP leg (recordings hid it only because MP4 export trims to the
//! shorter stream). Pacing the lavfi source inside FFmpeg (`-re`, `arealtime`)
//! fixed that tail but made the start race: about half the sessions froze for
//! FFmpeg's 10 s `-shortest` buffer when video reached the sync queue first.
//!
//! This writer feeds the tone the way the bus feeds a microphone: the same
//! f32le FIFO, written from the video epoch at wall-clock pace, so FFmpeg sees
//! the production input shape while the bus stays out of the picture.

use std::f64::consts::TAU;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::audio::{NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_SAMPLE_RATE};

/// The tone FFmpeg's `sine=frequency=880` source produced, at its default
/// 1/8 amplitude, so retained control evidence stays comparable.
const TONE_HZ: u64 = 880;
const TONE_AMPLITUDE: f64 = 0.125;
/// Writes at most 10 ms per pass: a catch-up after a scheduling hiccup is
/// spread over several writes instead of one large blocking burst.
const MAX_CHUNK_FRAMES: u64 = NATIVE_AUDIO_SAMPLE_RATE as u64 / 100;
const IDLE_SLEEP: Duration = Duration::from_millis(5);
/// The bus's own bound for a video epoch that never arrives.
const EPOCH_DEADLINE: Duration = Duration::from_secs(30);
/// A reader that accepts no byte for this long has gone.
const STALL_DEADLINE: Duration = Duration::from_secs(30);

/// Owns the writer thread's start. Dropping it before FFmpeg opens the FIFO
/// or before the video epoch arrives abandons the tone; once writing, the
/// thread runs until FFmpeg closes its read end, exactly like the bus, so
/// audio never ends before the video-owned FFmpeg exit.
#[derive(Debug)]
pub(crate) struct IncidentToneWriter {
    abandon: Arc<AtomicBool>,
}

impl IncidentToneWriter {
    pub(crate) fn spawn(
        path: PathBuf,
        video_epoch: Option<Arc<OnceLock<Instant>>>,
    ) -> io::Result<Self> {
        let abandon = Arc::new(AtomicBool::new(false));
        let thread_abandon = abandon.clone();
        thread::Builder::new()
            .name("videorc-incident-tone".to_string())
            .spawn(move || {
                if let Err(error) = run(&path, video_epoch, &thread_abandon) {
                    tracing::debug!("Incident tone writer ended: {error}");
                }
            })?;
        Ok(Self { abandon })
    }
}

impl Drop for IncidentToneWriter {
    fn drop(&mut self) {
        self.abandon.store(true, Ordering::Release);
    }
}

fn run(
    path: &Path,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    abandon: &AtomicBool,
) -> io::Result<()> {
    let mut file = crate::fifo::open_audio_writer(
        path,
        abandon,
        Duration::from_millis(5),
        "Incident tone stopped before FFmpeg opened it",
    )?;
    let epoch = match video_epoch {
        Some(epoch) => {
            let wait_started = Instant::now();
            loop {
                if abandon.load(Ordering::Acquire) {
                    return Ok(());
                }
                if let Some(epoch) = epoch.get() {
                    break *epoch;
                }
                if wait_started.elapsed() >= EPOCH_DEADLINE {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Video epoch did not arrive",
                    ));
                }
                thread::sleep(Duration::from_millis(2));
            }
        }
        None => Instant::now(),
    };
    let mut written = 0u64;
    let mut chunk = Vec::new();
    loop {
        let due = frames_due(epoch.elapsed());
        let frames = due.saturating_sub(written).min(MAX_CHUNK_FRAMES);
        if frames == 0 {
            thread::sleep(IDLE_SLEEP);
            continue;
        }
        tone_chunk(written, frames, &mut chunk);
        write_paced(&mut file, &chunk)?;
        written += frames;
    }
}

/// Writes all of `bytes` through a FIFO that may refuse them for a while.
/// On Windows the session audio pipe is `PIPE_NOWAIT`: a full pipe reports
/// a zero-byte write, which `write_all` turns into a fatal `WriteZero` and
/// would end the tone 40 ms in. Like the bus, treat it as pressure and retry;
/// a reader that accepts nothing for `STALL_DEADLINE` is gone.
fn write_paced(file: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    let mut written = 0;
    let mut last_progress = Instant::now();
    while written < bytes.len() {
        match file.write(&bytes[written..]) {
            Ok(0) => {}
            Ok(count) => {
                written += count;
                last_progress = Instant::now();
                continue;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(error),
        }
        if last_progress.elapsed() >= STALL_DEADLINE {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "FFmpeg stopped accepting the incident tone",
            ));
        }
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

/// Frames a wall-clock source has produced `elapsed` after its first sample.
fn frames_due(elapsed: Duration) -> u64 {
    (elapsed.as_nanos() * u128::from(NATIVE_AUDIO_SAMPLE_RATE) / 1_000_000_000) as u64
}

/// Interleaved f32le frames `[start, start + frames)` of the tone, the same
/// sample on every channel. The phase is exact per frame index: 880 Hz
/// completes whole cycles every second, so `start` wraps at the sample rate.
fn tone_chunk(start: u64, frames: u64, out: &mut Vec<u8>) {
    let rate = u64::from(NATIVE_AUDIO_SAMPLE_RATE);
    out.clear();
    for frame in start..start + frames {
        let phase = ((frame % rate) * TONE_HZ) as f64 / rate as f64;
        let sample = (TONE_AMPLITUDE * (TAU * phase).sin()) as f32;
        for _ in 0..NATIVE_AUDIO_CHANNELS {
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    }

    /// A pipe that refuses, then takes partial writes, like a full
    /// `PIPE_NOWAIT` Windows pipe whose reader drains slowly.
    struct PressuredPipe {
        refusals: Vec<io::Result<usize>>,
        received: Vec<u8>,
    }

    impl Write for PressuredPipe {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            match self.refusals.pop() {
                Some(Ok(limit)) => {
                    let count = limit.min(bytes.len());
                    self.received.extend_from_slice(&bytes[..count]);
                    Ok(count)
                }
                Some(Err(error)) => Err(error),
                None => {
                    self.received.extend_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_full_pipe_is_pressure_not_the_end_of_the_tone() {
        let mut bytes = Vec::new();
        tone_chunk(0, MAX_CHUNK_FRAMES, &mut bytes);
        let mut pipe = PressuredPipe {
            // Popped from the end: zero, would-block, a partial write, zero.
            refusals: vec![
                Ok(0),
                Ok(1_000),
                Err(io::ErrorKind::WouldBlock.into()),
                Ok(0),
            ],
            received: Vec::new(),
        };
        write_paced(&mut pipe, &bytes).expect("pressure is retried");
        assert_eq!(pipe.received, bytes);
    }

    #[test]
    fn a_closed_reader_ends_the_writer() {
        let mut pipe = PressuredPipe {
            refusals: vec![Err(io::ErrorKind::BrokenPipe.into())],
            received: Vec::new(),
        };
        let error = write_paced(&mut pipe, &[0; 8]).expect_err("a gone reader ends it");
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn frames_due_follow_the_wall_clock_at_the_session_rate() {
        assert_eq!(frames_due(Duration::ZERO), 0);
        assert_eq!(frames_due(Duration::from_millis(10)), 480);
        assert_eq!(frames_due(Duration::from_secs(12)), 576_000);
    }

    #[test]
    fn tone_chunks_are_continuous_across_writes_and_channels() {
        let mut whole = Vec::new();
        tone_chunk(0, 1_000, &mut whole);
        let mut joined = Vec::new();
        let mut part = Vec::new();
        for (start, frames) in [(0, 333), (333, 1), (334, 666)] {
            tone_chunk(start, frames, &mut part);
            joined.extend_from_slice(&part);
        }
        assert_eq!(joined, whole);
        let samples = samples(&whole);
        assert_eq!(samples.len(), 1_000 * NATIVE_AUDIO_CHANNELS as usize);
        for frame in samples.chunks_exact(NATIVE_AUDIO_CHANNELS as usize) {
            assert!(frame.iter().all(|sample| *sample == frame[0]));
        }
    }

    #[test]
    fn the_tone_is_880_hz_at_lavfi_amplitude_and_never_digital_silence() {
        let rate = u64::from(NATIVE_AUDIO_SAMPLE_RATE);
        let mut bytes = Vec::new();
        tone_chunk(0, rate, &mut bytes);
        let left: Vec<f32> = samples(&bytes)
            .chunks_exact(NATIVE_AUDIO_CHANNELS as usize)
            .map(|frame| frame[0])
            .collect();
        let rising_zero_crossings = left
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        assert!((879..=881).contains(&rising_zero_crossings));
        let peak = left.iter().fold(0f32, |peak, s| peak.max(s.abs()));
        assert!((peak - TONE_AMPLITUDE as f32).abs() < 1e-3);
        // The recording matrix's digital-zero gate reads this tone: no run of
        // exact zeros longer than a single crossing sample.
        assert!(left.windows(2).all(|pair| pair[0] != 0.0 || pair[1] != 0.0));
        // One second later the phase is where it started.
        let mut next = Vec::new();
        tone_chunk(rate, 4, &mut next);
        let mut first = Vec::new();
        tone_chunk(0, 4, &mut first);
        assert_eq!(next, first);
    }
}
