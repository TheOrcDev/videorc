//! Plan 157: per-source PCM taps for separate source recordings.
//!
//! The session audio bus writes ONE mixed stereo f32le stream to the Combined
//! recording. When separate source recordings are armed, the bus also offers
//! every written chunk's two ingredients to these taps: the processed
//! microphone (gain/mute applied, as written) and the gained system
//! contribution (zeros while no system slot is attached). Each tap owns a
//! writer thread and a bounded queue, so a stalled ISO muxer can never slow
//! the master bus: the tap drops its chunk and counts it instead. A dropped
//! chunk is owed back as silence in queue order (ahead of the next chunk that
//! does get queued, or at EOF), so the raw f32le byte timeline (FFmpeg dates
//! samples by position) never shifts.
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
/// `close` drains the queue, then waits this long for the writer to finish
/// before forcing it: a muxer that stopped reading its FIFO must not wedge
/// Stop (the caller kills it next, which ends the writer with EPIPE anyway).
const CLOSE_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

/// One queued bus chunk plus the silence owed for chunks dropped right
/// before it, so the writer lays both down in bus order.
struct TapChunk {
    leading_silence_samples: usize,
    samples: Vec<f32>,
}

/// One PCM tap: a FIFO path plus the writer thread feeding it.
pub struct SourceAudioTap {
    path: PathBuf,
    sender: Mutex<Option<mpsc::SyncSender<TapChunk>>>,
    stop: Arc<AtomicBool>,
    offered: Arc<AtomicU64>,
    offered_samples: AtomicU64,
    end_frame: AtomicU64,
    dropped: Arc<AtomicU64>,
    /// Samples dropped at `offer` that the writer still owes as silence.
    owed_silence: Arc<AtomicU64>,
    writer: Mutex<Option<thread::JoinHandle<()>>>,
    failure: Arc<Mutex<Option<String>>>,
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
        let owed_silence = Arc::new(AtomicU64::new(0));
        let failure = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::sync_channel::<TapChunk>(TAP_QUEUE_CHUNKS);
        let writer = {
            let path = path.clone();
            let stop = stop.clone();
            let owed_silence = owed_silence.clone();
            let failure = failure.clone();
            thread::Builder::new()
                .name(format!("videorc-source-audio-tap-{label}"))
                .spawn(move || {
                    if let Err(error) = run_tap_writer(&path, &stop, receiver, &owed_silence, label)
                    {
                        *failure.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some(error.to_string());
                    }
                })
                .ok()
        };
        if writer.is_none() {
            *failure.lock().unwrap_or_else(|p| p.into_inner()) =
                Some("Could not spawn audio tap writer".into());
        }
        Self {
            path,
            sender: Mutex::new(Some(sender)),
            stop,
            offered,
            offered_samples: AtomicU64::new(0),
            end_frame: AtomicU64::new(u64::MAX),
            dropped,
            owed_silence,
            failure,
            writer: Mutex::new(writer),
        }
    }

    pub fn end_at_frame(&self, frame: u64) {
        self.end_frame.fetch_min(frame, Ordering::AcqRel);
    }

    pub fn offered_frames(&self) -> u64 {
        self.offered_samples.load(Ordering::Acquire) / 2
    }

    pub fn terminal_failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Offers one written chunk. Never blocks: a full queue drops the chunk
    /// and its length is owed back as silence ahead of the next chunk that
    /// does get queued, so the file's sample position keeps tracking the bus
    /// clock.
    pub fn offer(&self, samples: &[f32]) {
        self.offered.fetch_add(1, Ordering::Relaxed);
        let sender = self.sender.lock().unwrap_or_else(|p| p.into_inner());
        let Some(sender) = sender.as_ref() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let start = self.offered_samples.load(Ordering::Relaxed) / 2;
        let remaining = self.end_frame.load(Ordering::Acquire).saturating_sub(start);
        let mut owned_samples = samples.to_vec();
        let keep = remaining.saturating_mul(2).min(owned_samples.len() as u64) as usize;
        owned_samples[keep..].fill(0.0);
        let owed = self.owed_silence.swap(0, Ordering::AcqRel);
        let chunk = TapChunk {
            leading_silence_samples: usize::try_from(owed).unwrap_or(usize::MAX),
            samples: owned_samples,
        };
        if sender.try_send(chunk).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.owed_silence
                .fetch_add(owed + samples.len() as u64, Ordering::AcqRel);
        }
        // Publish coverage after queue/debt ownership, under close's mutex.
        self.offered_samples
            .fetch_add(samples.len() as u64, Ordering::Release);
    }

    pub fn report(&self) -> SourceAudioTapReport {
        SourceAudioTapReport {
            offered_chunks: self.offered.load(Ordering::Relaxed),
            dropped_chunks: self.dropped.load(Ordering::Relaxed),
        }
    }

    /// Closes the queue so the writer drains what it has and exits (EOF on
    /// the FIFO ends the ISO muxer's audio input), then joins it. The drain
    /// is bounded by [`CLOSE_DRAIN_DEADLINE`]: past it the writer is stopped
    /// so a muxer that no longer reads cannot hold the session's Stop.
    pub fn close(&self) -> SourceAudioTapReport {
        drop(self.sender.lock().unwrap_or_else(|p| p.into_inner()).take());
        let writer = self.writer.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(writer) = writer {
            let started = std::time::Instant::now();
            while !writer.is_finished() && started.elapsed() < CLOSE_DRAIN_DEADLINE {
                thread::sleep(Duration::from_millis(2));
            }
            if !writer.is_finished() {
                tracing::warn!(
                    "Source audio tap {} did not drain within {}s; forcing it closed",
                    self.path.display(),
                    CLOSE_DRAIN_DEADLINE.as_secs()
                );
                *self.failure.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some("Audio tap did not drain before its deadline".into());
                self.stop.store(true, Ordering::Release);
            }
            let _ = writer.join();
        }
        self.report()
    }

    pub fn request_abort(&self) {
        self.stop.store(true, Ordering::Release);
        self.sender.lock().unwrap_or_else(|p| p.into_inner()).take();
    }

    /// Stops without draining: the queue is abandoned and the writer exits at
    /// its next check. Used when the muxer is already gone.
    pub fn abort(&self) -> SourceAudioTapReport {
        self.request_abort();
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
    receiver: mpsc::Receiver<TapChunk>,
    owed_silence: &AtomicU64,
    label: &'static str,
) -> std::io::Result<()> {
    let mut file = crate::fifo::open_audio_writer(
        path,
        stop,
        READER_OPEN_RETRY,
        "Source audio tap stopped before its muxer opened the FIFO",
    )?;
    let mut bytes = Vec::new();
    while let Ok(chunk) = receiver.recv() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        bytes.clear();
        bytes.reserve((chunk.leading_silence_samples + chunk.samples.len()) * 4);
        // Chunks dropped right before this one come back as silence FIRST so
        // this chunk lands at its bus position; the file never runs early.
        bytes.resize(chunk.leading_silence_samples * 4, 0);
        for sample in &chunk.samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        if let Err(error) = write_fully(&mut file, &bytes, stop) {
            if error.kind() != std::io::ErrorKind::Interrupted {
                tracing::warn!("Source audio tap ({label}) ended: {error}");
            }
            return Err(error);
        }
    }
    // Chunks dropped after the last queued one still owe their span at EOF.
    let owed = usize::try_from(owed_silence.swap(0, Ordering::AcqRel)).unwrap_or(0);
    if owed > 0 && !stop.load(Ordering::Acquire) {
        write_fully(&mut file, &vec![0u8; owed * 4], stop)?;
    }
    Ok(())
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
    #[cfg(test)]
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

    fn queued_test_tap() -> (SourceAudioTap, mpsc::Receiver<TapChunk>) {
        let (sender, receiver) = mpsc::sync_channel(4);
        let tap = SourceAudioTap {
            path: PathBuf::from("unused-cutoff-test"),
            sender: Mutex::new(Some(sender)),
            stop: Arc::new(AtomicBool::new(false)),
            offered: Arc::new(AtomicU64::new(0)),
            offered_samples: AtomicU64::new(0),
            end_frame: AtomicU64::new(u64::MAX),
            dropped: Arc::new(AtomicU64::new(0)),
            owed_silence: Arc::new(AtomicU64::new(0)),
            writer: Mutex::new(None),
            failure: Arc::new(Mutex::new(None)),
        };
        (tap, receiver)
    }

    #[tokio::test]
    async fn source_iso_supervisor_waits_for_final_chunk_and_clips_exact_stop_sample() {
        use crate::source_iso::RecordingRole;
        for role in [RecordingRole::Camera, RecordingRole::Screen] {
            let (tap, receiver) = queued_test_tap();
            let elapsed = Duration::from_nanos(3_543_602_083);
            let required = crate::source_iso::source_iso_audio_boundary_frames(role, elapsed, -120);
            // Camera's negative advance cannot consume post-Stop microphone;
            // Screen still owes its delayed, already captured system samples.
            let expected = 170_093
                + if role == RecordingRole::Screen {
                    5_760
                } else {
                    0
                };
            assert_eq!(required, expected);
            tap.offer(&vec![0.25; (required as usize - 480) * 2]);
            let mut wait = std::pin::pin!(crate::source_iso::wait_for_source_iso_audio_boundary(
                &tap, required
            ));
            assert!(
                futures_util::poll!(wait.as_mut()).is_pending(),
                "the final 10ms chunk is required even though it is less than one video frame"
            );
            tap.offer(&vec![0.5; 960 * 2]);
            tokio::time::timeout(Duration::from_secs(1), wait)
                .await
                .expect("coverage must wake after the final offer")
                .expect("queued PCM covers the committed boundary");
            tap.close();
            assert_eq!(
                receiver.recv().unwrap().samples.len(),
                (required as usize - 480) * 2
            );
            let final_chunk = receiver.recv().unwrap().samples;
            assert!(final_chunk[..480 * 2].iter().all(|sample| *sample == 0.5));
            assert!(final_chunk[480 * 2..].iter().all(|sample| *sample == 0.0));
            assert!(receiver.recv().is_err());
        }
    }

    #[test]
    fn source_iso_tap_clips_at_exact_stereo_frame_and_closed_offers_never_claim_coverage() {
        let (tap, receiver) = queued_test_tap();
        tap.end_at_frame(3);
        tap.offer(&[0.1, 0.2, 0.3, 0.4]);
        tap.offer(&[0.5, 0.6, 0.7, 0.8]);
        assert_eq!(tap.offered_frames(), 4);
        tap.close();
        tap.offer(&[1.0, 1.0]);
        assert_eq!(
            tap.offered_frames(),
            4,
            "closed offers cannot satisfy role readiness"
        );
        assert_eq!(receiver.recv().unwrap().samples, vec![0.1, 0.2, 0.3, 0.4]);
        assert_eq!(receiver.recv().unwrap().samples, vec![0.5, 0.6, 0.0, 0.0]);
        assert!(receiver.recv().is_err());
    }

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
    fn dropped_chunks_are_paid_back_as_silence_so_the_timeline_never_shifts() {
        let path = crate::fifo::transport_path(&format!(
            "videorc-source-audio-tap-owed-{}.f32le",
            uuid::Uuid::new_v4()
        ));
        crate::fifo::create_audio(&path).unwrap();
        let tap = SourceAudioTap::spawn(path.clone(), "test-owed");
        // Fill the queue with no reader, then overflow it by two chunks.
        for _ in 0..TAP_QUEUE_CHUNKS {
            tap.offer(&[0.5; 4]);
        }
        tap.offer(&[0.9; 4]);
        tap.offer(&[0.9; 4]);
        assert_eq!(tap.report().dropped_chunks, 2);
        let reader_path = path.clone();
        let (drained_tx, drained_rx) = mpsc::sync_channel(1);
        let (finished_tx, finished_rx) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let result = (|| -> std::io::Result<Vec<u8>> {
                #[cfg(unix)]
                let mut file = {
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(reader_path)?
                };
                #[cfg(not(unix))]
                let mut file = std::fs::File::open(reader_path)?;
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut bytes = Vec::new();
                let mut acknowledged = false;
                let mut buffer = [0; 4096];
                loop {
                    if std::time::Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "tap reader deadline",
                        ));
                    }
                    match file.read(&mut buffer) {
                        Ok(0) if acknowledged => break,
                        Ok(0) => thread::yield_now(),
                        Ok(count) => {
                            bytes.extend_from_slice(&buffer[..count]);
                            if !acknowledged && bytes.len() >= TAP_QUEUE_CHUNKS * 4 * 4 {
                                acknowledged = true;
                                let _ = drained_tx.send(());
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::yield_now()
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(bytes)
            })();
            let _ = finished_tx.send(result);
        });
        let drained = drained_rx.recv_timeout(Duration::from_secs(5));
        if drained.is_ok() {
            tap.offer(&[0.7; 4]);
            tap.close();
        } else {
            tap.abort();
        }
        let finished = finished_rx.recv_timeout(Duration::from_secs(12));
        let _ = crate::fifo::cleanup(&path);
        reader.join().unwrap();
        drained.expect("reader acknowledged every initially queued sample");
        let bytes = finished.expect("reader stopped within deadline").unwrap();
        let samples = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            samples.len(),
            (TAP_QUEUE_CHUNKS + 3) * 4,
            "every offered chunk occupies its span, dropped ones as silence"
        );
        assert_eq!(
            &samples[TAP_QUEUE_CHUNKS * 4..(TAP_QUEUE_CHUNKS + 2) * 4],
            &[0.0; 8]
        );
        assert_eq!(&samples[(TAP_QUEUE_CHUNKS + 2) * 4..], &[0.7; 4]);
        let _ = crate::fifo::cleanup(&path);
    }

    #[test]
    fn close_is_bounded_when_the_reader_stops_draining() {
        let path = crate::fifo::transport_path(&format!(
            "videorc-source-audio-tap-wedged-{}.f32le",
            uuid::Uuid::new_v4()
        ));
        crate::fifo::create_audio(&path).unwrap();
        let tap = SourceAudioTap::spawn(path.clone(), "test-wedged");
        // A reader that opens the FIFO and never reads: the writer fills the
        // pipe buffer and then sees WouldBlock forever.
        let reader = std::fs::File::open(&path).unwrap();
        for _ in 0..TAP_QUEUE_CHUNKS {
            tap.offer(&[0.1; 4096]);
        }
        let started = std::time::Instant::now();
        let _ = tap.close();
        assert!(
            started.elapsed() < CLOSE_DRAIN_DEADLINE + Duration::from_secs(2),
            "close must give up on a reader that stopped draining"
        );
        drop(reader);
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
