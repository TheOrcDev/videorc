//! Plan 157: per-source PCM taps for separate source recordings.
//!
//! The session audio bus writes ONE mixed stereo f32le stream to the Combined
//! recording. When separate source recordings are armed, the bus also offers
//! every written chunk's two ingredients to these taps: the processed
//! microphone (gain/mute applied, as written) and the gained system
//! contribution (zeros while no system slot is attached). Each tap owns a
//! writer thread and a bounded queue, so a stalled ISO muxer can never slow
//! the master bus: the tap drops its chunk and counts it instead.
//!
//! The byte cadence is the bus cadence: one chunk per [`crate::session_audio::CHUNK_FRAMES`]
//! frames, written as soon as the bus wrote the Combined chunk. That is the
//! same clock the Combined muxer sees, so each ISO file starts its PCM track at
//! the same instant as the Combined file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Queue depth before a tap drops chunks: 300 × 10 ms = 3 s of PCM. The ISO
/// muxer opens its FIFO within milliseconds of spawning; three seconds covers
/// a cold FFmpeg start on a slow disk without retaining unbounded memory.
const TAP_QUEUE_CHUNKS: usize = 300;
/// Wait for the FIFO reader this long before the tap gives up. Mirrors the
/// bus's own epoch deadline spirit: a muxer that never opened is a failed
/// writer, not a reason to block.
const READER_OPEN_RETRY: Duration = Duration::from_millis(5);

/// One PCM tap: a FIFO path plus the writer thread feeding it.
pub struct SourceAudioTap {
    path: PathBuf,
    sender: Mutex<Option<mpsc::SyncSender<Vec<f32>>>>,
    stop: Arc<AtomicBool>,
    offered: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    writer: Mutex<Option<thread::JoinHandle<()>>>,
}

impl std::fmt::Debug for SourceAudioTap {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SourceAudioTap")
            .field("path", &self.path)
            .field("offered", &self.offered.load(Ordering::Relaxed))
            .field("dropped", &self.dropped.load(Ordering::Relaxed))
            .finish()
    }
}

/// Counters a finished tap reports into the session diagnostics/log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SourceAudioTapReport {
    pub offered_chunks: u64,
    pub dropped_chunks: u64,
}

impl SourceAudioTap {
    /// Spawns the writer thread. The FIFO at `path` must already exist; the
    /// thread opens it once a reader attaches (or `stop` flips).
    pub fn spawn(path: PathBuf, label: &'static str) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let offered = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::sync_channel::<Vec<f32>>(TAP_QUEUE_CHUNKS);
        let writer = {
            let path = path.clone();
            let stop = stop.clone();
            thread::Builder::new()
                .name(format!("videorc-source-audio-tap-{label}"))
                .spawn(move || run_tap_writer(&path, &stop, receiver, label))
                .ok()
        };
        Self {
            path,
            sender: Mutex::new(Some(sender)),
            stop,
            offered,
            dropped,
            writer: Mutex::new(writer),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Offers one written chunk. Never blocks: a full queue drops the chunk.
    pub fn offer(&self, samples: &[f32]) {
        self.offered.fetch_add(1, Ordering::Relaxed);
        let sender = self.sender.lock().unwrap_or_else(|p| p.into_inner());
        let Some(sender) = sender.as_ref() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if sender.try_send(samples.to_vec()).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn report(&self) -> SourceAudioTapReport {
        SourceAudioTapReport {
            offered_chunks: self.offered.load(Ordering::Relaxed),
            dropped_chunks: self.dropped.load(Ordering::Relaxed),
        }
    }

    /// Closes the queue so the writer drains what it has and exits (EOF on
    /// the FIFO ends the ISO muxer's audio input), then joins it.
    pub fn close(&self) -> SourceAudioTapReport {
        drop(self.sender.lock().unwrap_or_else(|p| p.into_inner()).take());
        let writer = self.writer.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        self.report()
    }

    /// Stops without draining: the queue is abandoned and the writer exits at
    /// its next check. Used when the muxer is already gone.
    pub fn abort(&self) -> SourceAudioTapReport {
        self.stop.store(true, Ordering::Release);
        self.close()
    }
}

impl Drop for SourceAudioTap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.close();
    }
}

fn run_tap_writer(
    path: &Path,
    stop: &AtomicBool,
    receiver: mpsc::Receiver<Vec<f32>>,
    label: &'static str,
) {
    let mut file = match crate::fifo::open_audio_writer(
        path,
        stop,
        READER_OPEN_RETRY,
        "Source audio tap stopped before its muxer opened the FIFO",
    ) {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                "Source audio tap ({label}) could not open {}: {error}",
                path.display()
            );
            // Drain so the bus never observes a full queue as a stall signal.
            while receiver.recv().is_ok() {}
            return;
        }
    };
    let mut bytes = Vec::new();
    while let Ok(samples) = receiver.recv() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        bytes.clear();
        bytes.reserve(samples.len() * 4);
        for sample in &samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        if let Err(error) = write_fully(&mut file, &bytes, stop) {
            if error.kind() != std::io::ErrorKind::Interrupted {
                tracing::warn!("Source audio tap ({label}) ended: {error}");
            }
            break;
        }
    }
}

/// Finishes a whole chunk across partial / would-block writes; the FIFO is
/// opened non-blocking so a reader that stops draining never wedges `close`.
fn write_fully(file: &mut std::fs::File, bytes: &[u8], stop: &AtomicBool) -> std::io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        if stop.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Source audio tap stopped",
            ));
        }
        match file.write(&bytes[written..]) {
            Ok(0) => thread::sleep(Duration::from_millis(1)),
            Ok(count) => written += count,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// The two taps a separate-source session arms: microphone → Camera file,
/// system → Screen file. Either may be absent (role not recorded).
#[derive(Debug, Default)]
pub struct SourceAudioTaps {
    pub microphone: Option<SourceAudioTap>,
    pub system: Option<SourceAudioTap>,
}

impl SourceAudioTaps {
    /// Closes both taps in order: queued chunks drain, then each FIFO closes
    /// so the muxer's audio input sees EOF. Returns the counters
    /// (microphone, system).
    pub fn close_all(&self) -> (Option<SourceAudioTapReport>, Option<SourceAudioTapReport>) {
        (
            self.microphone.as_ref().map(SourceAudioTap::close),
            self.system.as_ref().map(SourceAudioTap::close),
        )
    }

    /// Stops both writers without draining and returns their counters
    /// (microphone, system).
    pub fn abort_all(&self) -> (Option<SourceAudioTapReport>, Option<SourceAudioTapReport>) {
        (
            self.microphone.as_ref().map(SourceAudioTap::abort),
            self.system.as_ref().map(SourceAudioTap::abort),
        )
    }

    /// Offers the bus's written ingredients for one chunk. `system` is `None`
    /// while the bus runs microphone-only; the system tap then receives
    /// silence of the same length so the Screen file's track stays continuous.
    pub fn offer_chunk(&self, microphone: &[f32], system: Option<&[f32]>) {
        if let Some(tap) = self.microphone.as_ref() {
            tap.offer(microphone);
        }
        if let Some(tap) = self.system.as_ref() {
            match system {
                Some(system) => tap.offer(system),
                None => tap.offer(&vec![0.0; microphone.len()]),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn tap_writes_offered_chunks_as_f32le_and_reports_counts() {
        let path = crate::fifo::transport_path(&format!(
            "videorc-source-audio-tap-test-{}.f32le",
            uuid::Uuid::new_v4()
        ));
        crate::fifo::create_audio(&path).unwrap();
        let tap = SourceAudioTap::spawn(path.clone(), "test");
        tap.offer(&[0.5, -0.5, 0.25, -0.25]);
        tap.offer(&[1.0, 1.0]);
        let reader_path = path.clone();
        let reader = thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let report = tap.close();
        let bytes = reader.join().unwrap();
        let samples = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(samples, vec![0.5, -0.5, 0.25, -0.25, 1.0, 1.0]);
        assert_eq!(
            report,
            SourceAudioTapReport {
                offered_chunks: 2,
                dropped_chunks: 0
            }
        );
        let _ = crate::fifo::cleanup(&path);
    }

    #[test]
    fn tap_drops_instead_of_blocking_when_no_reader_drains() {
        let path = crate::fifo::transport_path(&format!(
            "videorc-source-audio-tap-full-{}.f32le",
            uuid::Uuid::new_v4()
        ));
        crate::fifo::create_audio(&path).unwrap();
        let tap = SourceAudioTap::spawn(path.clone(), "test-full");
        let started = std::time::Instant::now();
        for _ in 0..(TAP_QUEUE_CHUNKS + 10) {
            tap.offer(&[0.0; 960]);
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "offer must never block on a missing reader"
        );
        let report = tap.report();
        assert_eq!(report.offered_chunks as usize, TAP_QUEUE_CHUNKS + 10);
        assert!(report.dropped_chunks >= 1, "queue overflow must be counted");
        let _ = tap.abort();
        let _ = crate::fifo::cleanup(&path);
    }

    #[test]
    fn taps_feed_silence_to_the_system_tap_while_the_bus_is_microphone_only() {
        let path = crate::fifo::transport_path(&format!(
            "videorc-source-audio-tap-silence-{}.f32le",
            uuid::Uuid::new_v4()
        ));
        crate::fifo::create_audio(&path).unwrap();
        let taps = SourceAudioTaps {
            microphone: None,
            system: Some(SourceAudioTap::spawn(path.clone(), "test-system")),
        };
        taps.offer_chunk(&[0.3, 0.3, 0.3, 0.3], None);
        let reader_path = path.clone();
        let reader = thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            bytes
        });
        taps.system.as_ref().unwrap().close();
        let bytes = reader.join().unwrap();
        assert_eq!(bytes.len(), 16, "four zero samples");
        assert!(bytes.iter().all(|byte| *byte == 0));
        let _ = crate::fifo::cleanup(&path);
    }
}
