//! Timestamp metadata framing for capture-only FFmpeg workers.
use anyhow::{Context, Result, bail};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_METADATA_BYTES: usize = 4096;
const MAX_ANCHORS: usize = 64;
const MAX_CAPTURE_AGE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy)]
struct PcmDescription {
    sequence: u64,
    pts: i64,
    frames: usize,
}

fn word_after<'a>(line: &'a str, marker: &str) -> Result<&'a str> {
    line.split_once(marker)
        .and_then(|(_, tail)| tail.split_whitespace().next())
        .context("Capture worker timestamp metadata is incomplete")
}
fn integer(line: &str, marker: &str) -> Result<i64> {
    word_after(line, marker)?
        .parse()
        .context("Capture worker timestamp metadata is malformed")
}
fn parse_pcm_description(line: &str) -> Result<PcmDescription> {
    if line.len() > MAX_METADATA_BYTES || !line.contains("ashowinfo") {
        bail!("Unexpected PCM metadata");
    }
    if word_after(line, "fmt:")? != "flt"
        || integer(line, "channels:")? != 2
        || integer(line, "rate:")? != 48000
    {
        bail!("Capture worker did not normalize PCM to 48 kHz float stereo");
    }
    let frames = usize::try_from(integer(line, "nb_samples:")?)?;
    let sequence = u64::try_from(integer(line, " n:")?)?;
    let pts = integer(line, " pts:")?;
    if frames == 0 || frames > 4800 || pts < 0 {
        bail!("Capture worker PCM metadata exceeds its bounded format");
    }
    Ok(PcmDescription {
        sequence,
        pts,
        frames,
    })
}

#[derive(Debug, Clone, Copy)]
struct CaptureAnchor {
    pts_us: i64,
    captured_start: Instant,
    input_duration: Option<Duration>,
}

struct ClockPair {
    monotonic: Instant,
    host_ns: Option<u64>,
    uncertainty: Duration,
}
impl ClockPair {
    fn instant_from_host(&self, host_ns: u64) -> Result<Instant> {
        let origin = self.host_ns.context("Host clock mapping unavailable")?;
        if host_ns >= origin {
            self.monotonic
                .checked_add(Duration::from_nanos(host_ns - origin))
        } else {
            self.monotonic
                .checked_sub(Duration::from_nanos(origin - host_ns))
        }
        .context("Capture clock lies outside the monotonic time range")
    }
}

fn avf_anchor(line: &str, clock: &ClockPair) -> Result<CaptureAnchor> {
    if line.len() > MAX_METADATA_BYTES || integer(line, "version=")? != 1 {
        bail!("Unsupported AVFoundation capture clock metadata");
    }
    let pts_us = integer(line, "pts_us=")?;
    let host = u64::try_from(integer(line, "host_ns=")?)?;
    let callback = u64::try_from(integer(line, "callback_ns=")?)?;
    let frames = u64::try_from(integer(line, "frames=")?)?;
    let rate = u64::try_from(integer(line, "rate=")?)?;
    if pts_us < 0
        || frames == 0
        || !(8000..=384000).contains(&rate)
        || callback < host
        || callback - host > 100_000_000
    {
        bail!("AVFoundation capture clock is stale or malformed");
    }
    let duration = Duration::from_secs_f64(frames as f64 / rate as f64);
    if duration > MAX_CAPTURE_AGE {
        bail!("AVFoundation capture packet exceeds the latency budget");
    }
    Ok(CaptureAnchor {
        pts_us,
        captured_start: clock.instant_from_host(host)?,
        input_duration: Some(duration),
    })
}

struct CaptureClock {
    anchors: VecDeque<CaptureAnchor>,
    last_sequence: Option<u64>,
    first_pts: Option<i64>,
    last_end_pts: Option<i64>,
}
impl CaptureClock {
    fn push(&mut self, anchor: CaptureAnchor) -> Result<()> {
        if let Some(previous) = self.anchors.back() {
            if anchor.pts_us <= previous.pts_us || anchor.captured_start <= previous.captured_start
            {
                bail!("Capture clock regressed");
            }
            let device_delta = Duration::from_micros((anchor.pts_us - previous.pts_us) as u64);
            let monotonic_delta = anchor
                .captured_start
                .duration_since(previous.captured_start);
            if device_delta.abs_diff(monotonic_delta) > Duration::from_millis(10) {
                bail!("Capture clock mapping is discontinuous");
            }
        }
        self.anchors.push_back(anchor);
        while self.anchors.len() > MAX_ANCHORS {
            self.anchors.pop_front();
        }
        Ok(())
    }
    fn interval(&mut self, packet: PcmDescription, now: Instant) -> Result<(u64, Instant)> {
        if self.last_sequence.is_none() && packet.sequence != 0 {
            bail!("Initial PCM metadata is missing");
        }
        if self
            .last_sequence
            .is_some_and(|last| packet.sequence != last + 1)
            || self.last_end_pts.is_some_and(|end| packet.pts < end)
        {
            bail!("Capture PCM metadata sequence regressed or skipped an interval");
        }
        let pts_us = packet
            .pts
            .checked_mul(1_000_000)
            .context("PCM timestamp overflow")?
            / 48000;
        let anchor = self
            .anchors
            .iter()
            .rev()
            .find(|anchor| anchor.pts_us <= pts_us + 25)
            .context("PCM has no exact capture clock anchor")?;
        let delta_us = pts_us - anchor.pts_us;
        if !(-25..=100_000).contains(&delta_us)
            || anchor
                .input_duration
                .is_some_and(|duration| delta_us > duration.as_micros() as i64 + 25)
        {
            bail!("PCM lies outside its captured packet clock interval");
        }
        let start = if delta_us >= 0 {
            anchor
                .captured_start
                .checked_add(Duration::from_micros(delta_us as u64))
        } else {
            anchor
                .captured_start
                .checked_sub(Duration::from_micros((-delta_us) as u64))
        }
        .context("PCM capture timestamp overflow")?;
        let end = start
            .checked_add(Duration::from_secs_f64(packet.frames as f64 / 48000.0))
            .context("PCM capture timestamp overflow")?;
        if end > now + Duration::from_millis(1) {
            bail!("PCM is ahead of its capture clock");
        }
        self.last_sequence = Some(packet.sequence);
        self.last_end_pts = Some(
            packet
                .pts
                .checked_add(packet.frames as i64)
                .context("PCM timestamp overflow")?,
        );
        let first = *self.first_pts.get_or_insert(packet.pts);
        Ok((((packet.pts - first) as u64) * 1_000_000 / 48000, end))
    }
}

use crate::audio::{AudioCaptureStats, AudioFrame};
use crate::process_job::{output_owned_std_with_timeout, spawn_owned_std};
use std::io::{BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;

type Failure = Arc<Mutex<Option<String>>>;

pub(crate) struct CapturedInput {
    pub device_name: String,
    pub receiver: mpsc::Receiver<AudioFrame>,
    pub stats: Arc<AudioCaptureStats>,
    pub owner: Box<dyn Send>,
    pub failure: Failure,
}

struct Worker {
    child: Child,
    stop: Arc<AtomicBool>,
    threads: Vec<thread::JoinHandle<()>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.child.kill();
        // The enclosing producer owner retains its permit through this reap.
        // Session callers have a separate five-second cleanup receipt deadline;
        // an OS-level stuck reap remains quarantined with its exact owner.
        let _ = self.child.wait();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn capture_command(ffmpeg: &str, device: &str) -> Command {
    let mut command = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.env("TZ", "UTC0").args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "repeat+datetime+verbose",
        "-copyts",
        "-thread_queue_size",
        "4",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
    ]);
    command.args([
        "-f",
        "avfoundation",
        "-videorc_audio_clock",
        "1",
        "-i",
        &format!("none:{device}"),
    ]);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        "aresample=48000:async=0,aformat=sample_fmts=flt:channel_layouts=stereo,ashowinfo",
        "-c:a",
        "pcm_f32le",
        "-f",
        "f32le",
        "pipe:1",
    ]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn resolve_target(ffmpeg: &str, id: &str) -> Result<(String, String)> {
    if let Some(index) = id.strip_prefix("microphone:avfoundation:") {
        if !cfg!(target_os = "macos") {
            bail!("AVFoundation microphones require macOS");
        }
        let parsed: usize = index
            .parse()
            .context("Invalid AVFoundation microphone identity")?;
        if index != parsed.to_string() {
            bail!("Microphone identity is not canonical");
        }
        let help = output_owned_std_with_timeout(
            Command::new(ffmpeg).args(["-hide_banner", "-h", "demuxer=avfoundation"]),
            Duration::from_secs(1),
        )?;
        let help = String::from_utf8_lossy(&help.stdout);
        if !help.contains("-videorc_audio_clock") || !help.contains("Videorc AVF clock protocol 1)")
        {
            bail!("This FFmpeg build lacks the required AVFoundation capture clock protocol");
        }
        let output = output_owned_std_with_timeout(
            Command::new(ffmpeg).args([
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ]),
            Duration::from_secs(2),
        )?;
        let devices =
            crate::devices::parse_avfoundation_devices(&String::from_utf8_lossy(&output.stderr));
        let matching: Vec<_> = devices
            .iter()
            .filter(|device| {
                device.kind == crate::devices::AvFoundationDeviceKind::Audio
                    && device.index == parsed
            })
            .collect();
        if matching.len() != 1 {
            bail!("The selected AVFoundation microphone is missing or ambiguous");
        }
        return Ok((index.to_string(), matching[0].name.clone()));
    }
    if crate::audio::parse_windows_dshow_microphone_id(id).is_some() {
        bail!(
            "Live DirectShow replacement requires a verified capture-clock mapping; this build supports the existing session-start microphone path only"
        );
    }
    bail!("This microphone capture adapter does not recognize the device identity")
}

#[cfg(target_os = "macos")]
mod host_clock {
    #[repr(C)]
    pub struct Timebase {
        pub numer: u32,
        pub denom: u32,
    }
    unsafe extern "C" {
        pub fn mach_timebase_info(info: *mut Timebase) -> i32;
        pub fn mach_absolute_time() -> u64;
    }
}

impl ClockPair {
    fn sample() -> Result<Self> {
        for _ in 0..3 {
            let before = Instant::now();
            #[cfg(target_os = "macos")]
            let host_ns = {
                let mut scale = host_clock::Timebase { numer: 0, denom: 0 };
                let result = unsafe { host_clock::mach_timebase_info(&mut scale) };
                if result != 0 || scale.denom == 0 {
                    bail!("The macOS capture host clock is unavailable");
                }
                Some(u64::try_from(
                    u128::from(unsafe { host_clock::mach_absolute_time() })
                        * u128::from(scale.numer)
                        / u128::from(scale.denom),
                )?)
            };
            #[cfg(not(target_os = "macos"))]
            let host_ns = None;
            let after = Instant::now();
            let uncertainty = after.duration_since(before);
            if uncertainty <= Duration::from_millis(1) {
                return Ok(Self {
                    monotonic: before + uncertainty / 2,
                    host_ns,
                    uncertainty,
                });
            }
        }
        bail!("The capture clock mapping could not meet its one-millisecond uncertainty budget")
    }
}

fn fail(failure: &Failure, message: impl Into<String>) {
    let mut slot = failure.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_none() {
        let message = message.into();
        tracing::warn!(reason = %message, "Capture worker stopped");
        *slot = Some(message);
    }
}

pub(crate) fn open(ffmpeg: &str, device_id: &str) -> Result<CapturedInput> {
    let (device, device_name) = resolve_target(ffmpeg, device_id)?;
    let clock_pair = ClockPair::sample()?;
    tracing::debug!(
        uncertainty_us = clock_pair.uncertainty.as_micros(),
        "Mapped capture worker clock"
    );
    let child = spawn_owned_std(&mut capture_command(ffmpeg, &device))?;
    let stop = Arc::new(AtomicBool::new(false));
    let failure: Failure = Arc::new(Mutex::new(None));
    let stats = Arc::new(AudioCaptureStats::default());
    let mut owner = Worker {
        child,
        stop: stop.clone(),
        threads: Vec::new(),
    };
    let stdout = owner
        .child
        .stdout
        .take()
        .context("Capture PCM pipe is unavailable")?;
    let stderr = owner
        .child
        .stderr
        .take()
        .context("Capture metadata pipe is unavailable")?;
    let (raw_tx, raw_rx) = mpsc::sync_channel::<Vec<u8>>(8);
    let (metadata_tx, metadata_rx) = mpsc::sync_channel::<String>(64);
    let (pcm_tx, receiver) = mpsc::sync_channel::<AudioFrame>(4);
    let read_stop = stop.clone();
    let read_failure = failure.clone();
    owner.threads.push(
        thread::Builder::new()
            .name("capture-pcm-read".into())
            .spawn(move || {
                let mut stdout = stdout;
                let mut bytes = [0u8; 8192];
                while !read_stop.load(Ordering::Acquire) {
                    match stdout.read(&mut bytes) {
                        Ok(0) => break,
                        Ok(count) => {
                            if raw_tx.try_send(bytes[..count].to_vec()).is_err() {
                                fail(&read_failure, "Capture PCM exceeded its bounded queue");
                                break;
                            }
                        }
                        Err(error) => {
                            fail(&read_failure, format!("Capture PCM read failed: {error}"));
                            break;
                        }
                    }
                }
            })?,
    );
    let read_stop = stop.clone();
    let read_failure = failure.clone();
    owner.threads.push(
        thread::Builder::new()
            .name("capture-clock-read".into())
            .spawn(move || {
                let mut stderr = BufReader::new(stderr);
                let mut bytes = [0u8; 1024];
                let mut line = Vec::new();
                while !read_stop.load(Ordering::Acquire) {
                    let count = match stderr.read(&mut bytes) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(_) => break,
                    };
                    for byte in &bytes[..count] {
                        if *byte == b'\n' {
                            let text = String::from_utf8_lossy(&line).into_owned();
                            line.clear();
                            let relevant = text.contains("VIDEORC_AVF_CLOCK")
                                || (text.contains("ashowinfo") && text.contains(" n:"));
                            if relevant && metadata_tx.try_send(text.clone()).is_err() {
                                fail(
                                    &read_failure,
                                    "Capture timestamp metadata exceeded its bounded queue",
                                );
                                return;
                            }
                            if text.contains("Error")
                                || text.contains("error")
                                || text.contains("denied")
                                || text.contains("Could not")
                            {
                                fail(&read_failure, text.chars().take(512).collect::<String>());
                            }
                        } else {
                            line.push(*byte);
                            if line.len() > MAX_METADATA_BYTES {
                                fail(
                                    &read_failure,
                                    "Capture worker emitted oversized timestamp metadata",
                                );
                                return;
                            }
                        }
                    }
                }
            })?,
    );
    let assemble_stop = stop.clone();
    let assemble_failure = failure.clone();
    let assemble_stats = stats.clone();
    owner.threads.push(
        thread::Builder::new()
            .name("capture-clock-pcm".into())
            .spawn(move || {
                let result = assemble_pcm(
                    clock_pair,
                    metadata_rx,
                    raw_rx,
                    pcm_tx,
                    &assemble_stop,
                    &assemble_stats,
                );
                if let Err(error) = result {
                    fail(&assemble_failure, error.to_string());
                }
                assemble_stop.store(true, Ordering::Release);
            })?,
    );
    Ok(CapturedInput {
        device_name,
        receiver,
        stats,
        owner: Box::new(owner),
        failure,
    })
}

fn assemble_pcm(
    clock_pair: ClockPair,
    metadata: mpsc::Receiver<String>,
    raw: mpsc::Receiver<Vec<u8>>,
    output: mpsc::SyncSender<AudioFrame>,
    stop: &AtomicBool,
    stats: &AudioCaptureStats,
) -> Result<()> {
    let mut clock = CaptureClock {
        anchors: VecDeque::new(),
        last_sequence: None,
        first_pts: None,
        last_end_pts: None,
    };
    let mut queued = VecDeque::<u8>::new();
    while !stop.load(Ordering::Acquire) {
        let line = match metadata.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("The capture worker stopped producing timestamped PCM")
            }
        };
        if line.contains("VIDEORC_AVF_CLOCK_INVALID") {
            bail!("AVFoundation could not convert the selected device capture clock");
        }
        if line.contains("VIDEORC_AVF_CLOCK version=") {
            clock.push(avf_anchor(&line, &clock_pair)?)?;
            continue;
        }
        let packet = parse_pcm_description(&line)?;
        let wanted = packet.frames * 8;
        let deadline = Instant::now() + Duration::from_millis(100);
        while queued.len() < wanted {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("Capture PCM did not match its timestamp metadata within 100ms");
            }
            match raw.recv_timeout(Duration::from_millis(5)) {
                Ok(bytes) => queued.extend(bytes),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    bail!("Capture PCM ended in a partial timestamped packet")
                }
            }
        }
        let bytes: Vec<_> = queued.drain(..wanted).collect();
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte PCM sample")))
            .collect();
        if samples.iter().any(|sample| !sample.is_finite()) {
            bail!("Capture PCM contains a non-finite sample");
        }
        let (timestamp_micros, captured_at) = clock.interval(packet, Instant::now())?;
        if captured_at > Instant::now() {
            thread::sleep(captured_at.saturating_duration_since(Instant::now()));
        }
        if captured_at.elapsed() > MAX_CAPTURE_AGE {
            stats.record_dropped_frames(packet.frames as u64);
            continue;
        }
        stats.record_captured_frames(packet.frames as u64);
        stats.record_live_peak(samples.iter().copied().map(f32::abs).fold(0.0, f32::max));
        match output.try_send(AudioFrame {
            timestamp_micros,
            captured_at,
            sample_rate: 48000,
            channels: 2,
            samples,
        }) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => stats.record_dropped_frames(packet.frames as u64),
            Err(mpsc::TrySendError::Disconnected(_)) => return Ok(()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(now: Instant) -> ClockPair {
        ClockPair {
            monotonic: now,
            host_ns: Some(1_000_000_000),
            uncertainty: Duration::ZERO,
        }
    }
    fn clock(now: Instant) -> CaptureClock {
        CaptureClock {
            anchors: VecDeque::from([CaptureAnchor {
                pts_us: 0,
                captured_start: now - Duration::from_millis(40),
                input_duration: Some(Duration::from_millis(40)),
            }]),
            last_sequence: None,
            first_pts: None,
            last_end_pts: None,
        }
    }
    fn pcm(n: u64, pts: i64, frames: usize) -> String {
        format!(
            "[Parsed_ashowinfo_2] n:{n} pts:{pts} pts_time:0 fmt:flt channels:2 chlayout:stereo rate:48000 nb_samples:{frames} checksum:0"
        )
    }
    fn metadata() -> String {
        "VIDEORC_AVF_CLOCK version=1 pts_us=0 host_ns=980000000 callback_ns=990000000 frames=480 rate=48000".into()
    }

    #[test]
    fn refuses_missing_first_metadata_duplicate_overlap_and_sequence_gaps() {
        let now = Instant::now();
        let first = PcmDescription {
            sequence: 0,
            pts: 0,
            frames: 480,
        };
        assert!(
            clock(now)
                .interval(
                    PcmDescription {
                        sequence: 1,
                        ..first
                    },
                    now
                )
                .is_err()
        );
        for (sequence, pts) in [(0, 0), (1, 0), (1, 240), (2, 480)] {
            let mut clock = clock(now);
            clock.interval(first, now).unwrap();
            assert!(
                clock
                    .interval(
                        PcmDescription {
                            sequence,
                            pts,
                            frames: 480
                        },
                        now
                    )
                    .is_err()
            );
        }
        let mut clock = clock(now);
        let (_, end) = clock.interval(first, now).unwrap();
        let (timestamp, next) = clock
            .interval(
                PcmDescription {
                    sequence: 1,
                    pts: 960,
                    frames: 480,
                },
                now,
            )
            .unwrap();
        assert_eq!(timestamp, 20_000);
        assert_eq!(next.duration_since(end), Duration::from_millis(20));
    }

    #[test]
    fn pcm_format_and_capture_clock_are_fail_closed() {
        assert_eq!(parse_pcm_description(&pcm(0, 0, 480)).unwrap().frames, 480);
        for malformed in [
            pcm(0, 0, 0),
            pcm(0, -1, 480),
            pcm(0, 0, 4801),
            pcm(0, 0, 480).replace("flt", "s16"),
            pcm(0, 0, 480).replace("channels:2", "channels:1"),
            pcm(0, 0, 480).replace("rate:48000", "rate:44100"),
        ] {
            assert!(parse_pcm_description(&malformed).is_err());
        }
        let pair = pair(Instant::now());
        assert!(avf_anchor(&metadata(), &pair).is_ok());
        for malformed in [
            metadata().replace("version=1", "version=10"),
            metadata().replace("callback_ns=990000000", "callback_ns=970000000"),
            metadata().replace("host_ns=980000000", "host_ns=1"),
            metadata().replace("rate=48000", "rate=NaN"),
            metadata().replace("frames=480", "frames=0"),
        ] {
            assert!(avf_anchor(&malformed, &pair).is_err());
        }
        let now = Instant::now();
        let mut clock = clock(now);
        assert!(
            clock
                .push(CaptureAnchor {
                    pts_us: 10_000,
                    captured_start: now + Duration::from_millis(50),
                    input_duration: None
                })
                .is_err()
        );
        assert!(
            CaptureClock {
                anchors: VecDeque::new(),
                ..super::tests::clock(now)
            }
            .interval(
                PcmDescription {
                    sequence: 0,
                    pts: 0,
                    frames: 480
                },
                now
            )
            .is_err()
        );
    }

    fn assembled(
        raw_bytes: Vec<Vec<u8>>,
        description: String,
        anchor: String,
        start: Instant,
    ) -> (Result<()>, Vec<AudioFrame>, Arc<AudioCaptureStats>) {
        let (meta_tx, meta_rx) = mpsc::channel();
        meta_tx.send(anchor).unwrap();
        meta_tx.send(description).unwrap();
        drop(meta_tx);
        let (raw_tx, raw_rx) = mpsc::channel();
        for bytes in raw_bytes {
            raw_tx.send(bytes).unwrap();
        }
        drop(raw_tx);
        let (out_tx, out_rx) = mpsc::sync_channel(4);
        let stats = Arc::new(AudioCaptureStats::default());
        let result = assemble_pcm(
            pair(start),
            meta_rx,
            raw_rx,
            out_tx,
            &AtomicBool::new(false),
            &stats,
        );
        (result, out_rx.try_iter().collect(), stats)
    }

    #[test]
    fn pcm_framing_handles_partial_reads_and_rejects_truncated_or_nonfinite_packets() {
        let bytes: Vec<u8> = (0..960).flat_map(|_| 0.25f32.to_le_bytes()).collect();
        let (_, frames, stats) = assembled(
            vec![
                bytes[..3].to_vec(),
                bytes[3..1000].to_vec(),
                bytes[1000..].to_vec(),
            ],
            pcm(0, 0, 480),
            metadata(),
            Instant::now(),
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].samples, vec![0.25; 960]);
        assert_eq!(stats.captured_frames(), 480);
        let (result, frames, _) = assembled(
            vec![bytes[..bytes.len() - 1].to_vec()],
            pcm(0, 0, 480),
            metadata(),
            Instant::now(),
        );
        assert!(result.unwrap_err().to_string().contains("partial"));
        assert!(frames.is_empty());
        let mut bad = bytes;
        bad[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        let (result, frames, _) = assembled(vec![bad], pcm(0, 0, 480), metadata(), Instant::now());
        assert!(result.unwrap_err().to_string().contains("non-finite"));
        assert!(frames.is_empty());
    }

    #[test]
    fn stale_capture_metadata_never_becomes_ready_pcm_even_with_fresh_pipe_arrival() {
        let bytes: Vec<u8> = (0..960).flat_map(|_| 0.25f32.to_le_bytes()).collect();
        let (_, frames, stats) = assembled(
            vec![bytes],
            pcm(0, 0, 480),
            metadata(),
            Instant::now() - Duration::from_secs(1),
        );
        assert!(frames.is_empty());
        assert_eq!(stats.captured_frames(), 0);
        assert_eq!(stats.dropped_frames(), 480);
    }

    #[test]
    fn worker_command_is_capture_only_and_preserves_source_clock() {
        let command = capture_command("ffmpeg", "3");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-i", "none:3"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-videorc_audio_clock", "1"])
        );
        assert!(args.contains(&"-copyts".into()));
        assert!(
            args.contains(
                &"aresample=48000:async=0,aformat=sample_fmts=flt:channel_layouts=stereo,ashowinfo"
                    .into()
            )
        );
        assert_eq!(args.last().unwrap(), "pipe:1");
        assert!(
            !args
                .iter()
                .any(|arg| arg.contains("volume") || arg.contains("rtmp") || arg.contains("amix"))
        );
    }
    #[test]
    #[ignore = "owned child fixture launched explicitly by the lifecycle test"]
    fn capture_worker_child() {
        use std::io::Write;
        let address =
            std::env::var("VIDEORC_CAPTURE_WORKER_TEST_ADDRESS").expect("fixture address");
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream.write_all(&[1]).unwrap();
        let mut stop = [0];
        let _ = stream.read_exact(&mut stop);
    }

    #[tokio::test]
    async fn capture_worker_drop_kills_and_reaps_only_its_ready_owned_child() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "audio_capture_adapter::tests::capture_worker_child",
                "--ignored",
            ])
            .env(
                "VIDEORC_CAPTURE_WORKER_TEST_ADDRESS",
                listener.local_addr().unwrap().to_string(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_owned_std(&mut command).unwrap();
        let pid = child.id();
        let owner = Worker {
            child,
            stop: Arc::new(AtomicBool::new(false)),
            threads: Vec::new(),
        };
        let ready = tokio::time::timeout(Duration::from_secs(5), async {
            let (mut socket, _) = listener.accept().await?;
            if socket.read_u8().await? != 1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid child readiness acknowledgement",
                ));
            }
            Ok::<_, std::io::Error>(socket)
        })
        .await;
        let (closed_tx, mut closed_rx) = tokio::sync::oneshot::channel();
        thread::spawn(move || {
            drop(owner);
            let _ = closed_tx.send(());
        });
        let closed = tokio::time::timeout(Duration::from_secs(5), &mut closed_rx).await;
        if closed.is_err() {
            let _ = crate::process_job::terminate_process(pid, true);
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut closed_rx).await;
        }
        assert!(
            closed.is_ok(),
            "capture worker cleanup did not finish within its deadline"
        );
        assert!(
            ready.is_ok_and(|ready| ready.is_ok()),
            "owned child did not acknowledge readiness"
        );
        assert!(!crate::process_job::process_is_running(pid).unwrap());
    }
}
