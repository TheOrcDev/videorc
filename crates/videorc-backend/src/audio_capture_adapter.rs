//! Timestamp metadata framing for capture-only FFmpeg workers.
use anyhow::{Context, Result, bail};
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_METADATA_BYTES: usize = 4096;

/// Why a capture worker could not start, so a session can choose between
/// the direct DirectShow input and silence (plan 065, A3). A timeout or a
/// missing protocol says nothing about the device; only an inventory that
/// lacks the device means a direct input would fail too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerStartFailureKind {
    /// The device is not in the DirectShow inventory, or its name is
    /// ambiguous there: the direct `audio=<name>` input cannot open it either.
    DeviceNotInInventory,
    /// A probe child (protocol help or device inventory) exceeded its limit.
    ProbeTimedOut,
    /// The worker binary lacks the timestamped capture protocol.
    ProtocolMissing,
}

#[derive(Debug)]
pub(crate) struct WorkerStartError {
    pub kind: WorkerStartFailureKind,
    message: String,
}

impl WorkerStartError {
    fn new(kind: WorkerStartFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(kind: WorkerStartFailureKind, message: &str) -> Self {
        Self::new(kind, message)
    }
}

impl std::fmt::Display for WorkerStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WorkerStartError {}

/// The typed start failure inside an error chain, if any.
pub(crate) fn worker_start_failure_kind(error: &anyhow::Error) -> Option<WorkerStartFailureKind> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<WorkerStartError>())
        .map(|failure| failure.kind)
}

fn probe_error(label: &str, error: std::io::Error) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::TimedOut {
        WorkerStartError::new(
            WorkerStartFailureKind::ProbeTimedOut,
            format!("The capture worker's {label} probe timed out: {error}"),
        )
        .into()
    } else {
        anyhow::Error::new(error).context(format!("The capture worker's {label} probe failed"))
    }
}
const MAX_ANCHORS: usize = 64;
/// A packet whose END is older than this when it reaches the assembler is
/// dropped as stale. `captured_at` is the end of the packet (plan 195 W2: a
/// driver that hands over 500 ms buffers is judged by when the audio was
/// handed over, not by how old its first sample is).
const MAX_CAPTURE_AGE: Duration = Duration::from_millis(100);
/// The Pulse worker (Linux) stamps packets on a busy desktop: FFmpeg's demuxer,
/// pipes and reader threads add tens of ms under load. The session bus gives it
/// `SYSTEM_AUDIO_PLAYOUT_DELAY` (150 ms) to arrive, so the worker must not drop
/// what the bus would still place (retest 150: 37 s of a 12-minute take lost).
const PULSE_MAX_CAPTURE_AGE: Duration = Duration::from_millis(250);

fn max_capture_age(protocol: CaptureProtocol) -> Duration {
    match protocol {
        CaptureProtocol::Pulse => PULSE_MAX_CAPTURE_AGE,
        CaptureProtocol::AvFoundation | CaptureProtocol::DirectShow => MAX_CAPTURE_AGE,
    }
}
/// The largest PCM record the worker may describe: one second at 48 kHz.
/// Big-buffer DirectShow drivers deliver 500 ms packets (plan 195 W2); the
/// 20 ms the worker asks for is a request, not a contract.
const MAX_PCM_PACKET_FRAMES: usize = 48_000;
/// Raw PCM bytes buffered between the stdout reader and the assembler: a
/// 1 s float-stereo packet (384 KB) must fit when its metadata line is late.
const RAW_PCM_QUEUE_CHUNKS: usize = 64;

fn capture_output_channel(
    protocol: CaptureProtocol,
) -> (mpsc::SyncSender<AudioFrame>, mpsc::Receiver<AudioFrame>) {
    // Pulse delivers 10 ms fragments. Four packets discarded still-fresh PCM
    // during an 87 ms bus write stall, even though Linux's existing playout
    // window is 150 ms. Hold one full window plus the packet at its boundary;
    // this adds capacity, not a delay. The capture and bus age checks still
    // reject stale audio. Other workers keep their existing packet budget.
    let capacity = match protocol {
        CaptureProtocol::Pulse => 16,
        CaptureProtocol::AvFoundation | CaptureProtocol::DirectShow => 4,
    };
    mpsc::sync_channel(capacity)
}

#[derive(Debug, Clone, Copy)]
struct PcmDescription {
    sequence: u64,
    pts: i64,
    frames: usize,
}

fn word_after<'a>(line: &'a str, marker: &str) -> Result<&'a str> {
    line.split_whitespace()
        .find_map(|word| word.strip_prefix(marker.trim()))
        .filter(|word| !word.is_empty())
        .with_context(|| {
            format!(
                "Capture metadata is missing field {marker:?}: {}",
                line.chars().take(1024).collect::<String>()
            )
        })
}
fn integer(line: &str, marker: &str) -> Result<i64> {
    let word = word_after(line, marker)?;
    word.parse().with_context(|| {
        format!(
            "Capture metadata field {marker:?} has malformed token {:?}: {}",
            word.chars().take(80).collect::<String>(),
            line.chars().take(1024).collect::<String>()
        )
    })
}

// ashowinfo emits its header and checksum tail in separate log calls. A
// capture-clock record may therefore share that physical line. Retain both
// records in their emitted order; never let a stats substring become a field.
fn metadata_records(line: &str) -> Vec<String> {
    let mut starts: Vec<(usize, bool)> = Vec::new();
    for (index, _) in line.char_indices() {
        if index != 0 && !line.as_bytes()[index - 1].is_ascii_whitespace() {
            continue;
        }
        let tail = &line[index..];
        if tail.starts_with("VIDEORC_AVF_CLOCK") || tail.starts_with("VIDEORC_DSHOW_CLOCK") {
            starts.push((index, false));
        } else if tail.starts_with("n:") && line.contains("fmt:") && line.contains("nb_samples:") {
            starts.push((index, true));
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(position, (start, pcm))| {
            let end = starts
                .get(position + 1)
                .map_or(line.len(), |(index, _)| *index);
            if *pcm {
                format!("ashowinfo {}", &line[*start..end])
            } else {
                line[*start..end].to_string()
            }
        })
        .collect()
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
    if frames == 0 || frames > MAX_PCM_PACKET_FRAMES || pts < 0 {
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
    uncertainty: Duration,
    /// How far the packet's own stamp may sit from the PCM sample count.
    stamp_jitter: Duration,
}

/// A legacy DirectShow wave capture filter (field Intel SST microphone) stamps
/// each buffer from the 1 ms system clock at delivery: 1-3 ms of jitter around
/// a constant offset from the sample count, with no drift over 60 s. The PCM
/// interval match allows this much, and the mapping uncertainty carries it.
const DSHOW_STAMP_JITTER: Duration = Duration::from_millis(10);
/// FFmpeg carries those stamps into the PCM `pts` (one packet started 95
/// samples before the previous one ended), so DirectShow PCM is placed on a
/// sample count by `PulseTimeline`; only a stamp more than the jitter allowance
/// late, confirmed by the next buffer at the device's own cadence, is lost
/// audio (`PulseTimeline::place_delivery_stamped`).
const DSHOW_DROPOUT_FRAMES: i64 = DSHOW_STAMP_JITTER.as_millis() as i64 * 48;
/// How far a delivery-stamped packet's smoothed clock may sit past the anchor
/// it matches. After a capture-thread stall the held buffers arrive in a
/// burst whose stamps run ahead of the smoothed count, so each matches the
/// last pre-stall anchor, one packet plus the stall behind. Every anchor maps
/// through the same graph clock, so that extrapolation is as exact as the
/// anchor's own bracket; `MAX_CAPTURE_AGE`, not this window, decides what a
/// stall loses (twice it, so the age check always judges first).
const DSHOW_STALL_ALLOWANCE: Duration = Duration::from_millis(200);

/// The worker names the check a refused packet failed (`reason=wall-bracket
/// sample_100ns=...`). A field stop 32 s into an idle session carried no
/// reason, so it could not be told from a broken device. Bounded, printable.
fn dshow_invalid_detail(line: &str) -> String {
    let Some((_, detail)) = line.split_once("VIDEORC_DSHOW_CLOCK_INVALID") else {
        return String::new();
    };
    let detail: String = detail
        .trim()
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(200)
        .collect();
    if detail.is_empty() {
        String::new()
    } else {
        format!(" ({detail})")
    }
}

const WALL_TOLERANCE_NS: u128 = 5_000_000;
const WALL_STEP_NS: u128 = 50_000_000;
const WALL_STEP_STREAK: u8 = 3;
const WALL_BRACKET_BUDGET: Duration = Duration::from_millis(1);
const PULSE_WALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);

struct ClockPair {
    monotonic: Instant,
    host_ns: Option<u64>,
    wall_ns: i128,
    uncertainty: Duration,
}

/// How far wall has drifted from the pair's linear prediction.
fn wall_offset_ns(pair: &ClockPair, now: Instant, wall_ns: i128) -> i128 {
    let expected = pair.wall_ns + now.saturating_duration_since(pair.monotonic).as_nanos() as i128;
    wall_ns - expected
}

/// Midpoint of a mono → wall → mono bracket. `None` when the two monotonic
/// reads are more than 1 ms apart (preemption): skip the check, do not stop.
fn bracket_wall_sample(before: Instant, wall_ns: i128, after: Instant) -> Option<(Instant, i128)> {
    let uncertainty = after.checked_duration_since(before)?;
    if uncertainty > WALL_BRACKET_BUDGET {
        return None;
    }
    Some((before + uncertainty / 2, wall_ns))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WallOffsetKind {
    Steady,
    Drift,
    Step,
}

fn classify_wall_offset(offset_ns: i128) -> WallOffsetKind {
    let abs = offset_ns.unsigned_abs();
    if abs <= WALL_TOLERANCE_NS {
        WallOffsetKind::Steady
    } else if abs > WALL_STEP_NS {
        WallOffsetKind::Step
    } else {
        WallOffsetKind::Drift
    }
}

/// Confirms a real clock step: one offset past 50 ms, or three consecutive
/// drifts past the 5 ms tolerance. A confirmed step re-takes the pair.
#[derive(Default)]
struct WallStepWatch {
    consecutive_drifts: u8,
}

impl WallStepWatch {
    fn observe(&mut self, kind: WallOffsetKind) -> bool {
        match kind {
            WallOffsetKind::Steady => {
                self.consecutive_drifts = 0;
                false
            }
            WallOffsetKind::Step => {
                self.consecutive_drifts = 0;
                true
            }
            WallOffsetKind::Drift => {
                self.consecutive_drifts = self.consecutive_drifts.saturating_add(1);
                if self.consecutive_drifts >= WALL_STEP_STREAK {
                    self.consecutive_drifts = 0;
                    true
                } else {
                    false
                }
            }
        }
    }
}

impl ClockPair {
    fn sample_wall_now() -> Option<(Instant, i128)> {
        for _ in 0..3 {
            let before = Instant::now();
            let wall_ns = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos() as i128;
            let after = Instant::now();
            if let Some(sample) = bracket_wall_sample(before, wall_ns, after) {
                return Some(sample);
            }
        }
        None
    }
    fn instant_from_wall(&self, wall_ns: i128) -> Result<Instant> {
        let delta = wall_ns - self.wall_ns;
        let duration = Duration::from_nanos(u64::try_from(delta.unsigned_abs())?);
        if delta >= 0 {
            self.monotonic.checked_add(duration)
        } else {
            self.monotonic.checked_sub(duration)
        }
        .context("Capture wall clock is outside the monotonic range")
    }
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
        uncertainty: clock.uncertainty,
        stamp_jitter: Duration::ZERO,
    })
}

fn dshow_anchor(line: &str, clock: &ClockPair) -> Result<CaptureAnchor> {
    if line.len() > MAX_METADATA_BYTES || integer(line, "version=")? != 1 {
        bail!("Unsupported DirectShow capture clock metadata");
    }
    let sample = integer(line, "sample_100ns=")?;
    let graph = integer(line, "graph_100ns=")?;
    let before = integer(line, "wall_before_100ns=")?;
    let after = integer(line, "wall_after_100ns=")?;
    let bytes = integer(line, "bytes=")?;
    let frames = integer(line, "frames=")?;
    let rate = integer(line, "rate=")?;
    let channels = integer(line, "channels=")?;
    let bits = integer(line, "bits=")?;
    let format = integer(line, "format=")?;
    // The callback may run up to one second after the packet's first sample
    // (a 500 ms driver buffer, plan 195 W2); the age check judges delivery.
    if sample < 0
        || graph < sample
        || graph - sample > 10_000_000
        || before <= 0
        || after < before
        || after - before > 10_000
        || !(8000..=384000).contains(&rate)
        || !(1..=32).contains(&channels)
        || frames <= 0
        // Up to one second per packet (plan 195 W2); the age check judges it.
        || frames > rate
        || !((format == 1 && [8, 16, 24, 32].contains(&bits))
            || (format == 3 && [32, 64].contains(&bits)))
        || bytes != frames * channels * (bits / 8)
    {
        bail!("DirectShow capture clock or PCM shape is invalid");
    }
    // The worker brackets the graph read before logging; log/pipe delay never
    // enters the mapping. Include both sampling brackets and a conservative
    // one-microsecond PreciseFileTime resolution allowance.
    let uncertainty = clock.uncertainty
        + Duration::from_nanos((after - before) as u64 * 100)
        + Duration::from_micros(1);
    if uncertainty > Duration::from_millis(2) {
        bail!("DirectShow clock mapping exceeds its two-millisecond uncertainty budget");
    }
    let midpoint_ns = (i128::from(before) + i128::from(after)) * 50;
    let callback = clock.instant_from_wall(midpoint_ns)?;
    let captured_start = callback
        .checked_sub(Duration::from_nanos((graph - sample) as u64 * 100))
        .context("DirectShow clock offset overflow")?;
    Ok(CaptureAnchor {
        pts_us: sample / 10,
        captured_start,
        input_duration: Some(Duration::from_secs_f64(frames as f64 / rate as f64)),
        uncertainty: uncertainty + DSHOW_STAMP_JITTER,
        stamp_jitter: DSHOW_STAMP_JITTER,
    })
}

/// Linux (release test 147, plan 0001): the stock FFmpeg pulse demuxer
/// stamps every packet with the wall clock at its first sample (`-wallclock
/// 1`, the default: `av_gettime()` less the latency PulseAudio reports), and
/// `-copyts` keeps that through `aresample` into `ashowinfo`'s `pts` in
/// 1/48000 s. So each PCM record carries its own capture clock and becomes
/// its own anchor: there is no separate clock record as the patched
/// AVFoundation and DirectShow workers print.
const PULSE_CLOCK_UNCERTAINTY: Duration = Duration::from_millis(20);
/// A pulse stamp this far past the expected capture instant is a real
/// dropout (an overrun lost audio): the count and the clock jump together.
const PULSE_DROPOUT_FRAMES: i64 = 960;
/// How far the capture instant may move toward a packet's stamp per packet:
/// 1 ms per 10 ms packet, far faster than any device drift and well inside
/// `CaptureClock`'s 10 ms continuity check.
const PULSE_SLEW_FRAMES: i64 = 48;

/// Places pulse packets on a sample count and a capture clock (release test
/// 147, plan 0001). The demuxer's stamps are smoothed wall-clock readings:
/// on ogre they jittered by a couple of milliseconds from packet to packet
/// (one started 85 samples before the previous one ended) and, under encode
/// load, jumped by more than 10 ms. Taken raw, the first is a "regressed"
/// sequence and the second a "discontinuous" clock. So samples are counted
/// contiguously, and each packet's capture instant is its position plus an
/// offset that slews toward the packet's own stamp by at most
/// `PULSE_SLEW_FRAMES`: jitter averages out, drift between the sound card and
/// the wall clock is followed, and only a stamp more than
/// `PULSE_DROPOUT_FRAMES` past the expected instant (lost audio) moves the
/// count and the clock forward together.
#[derive(Debug, Default)]
struct PulseTimeline {
    next: Option<i64>,
    offset: Option<i64>,
    /// The last delivery-stamped packet's stamp and lateness, for
    /// [`Self::place_delivery_stamped`].
    previous_late: Option<(i64, i64)>,
}

impl PulseTimeline {
    /// The packet's sample position and the stamp (1/48000 s, wall clock) of
    /// its capture instant.
    fn place(&mut self, stamp: i64, frames: usize) -> (i64, i64) {
        self.place_within(stamp, frames, PULSE_DROPOUT_FRAMES)
    }

    /// [`Self::place`] with the stamp lateness that counts as lost audio.
    /// DirectShow reuses this timeline (plan 046 amendment 2026-10-28): FFmpeg
    /// carries a delivery-stamped wave buffer's stamp into the PCM `pts`.
    fn place_within(&mut self, stamp: i64, frames: usize, dropout_frames: i64) -> (i64, i64) {
        let (position, offset) = match (self.next, self.offset) {
            (Some(next), Some(offset)) => {
                let late = stamp - (next + offset);
                if late > dropout_frames {
                    // Audio was lost: the gap goes into the count, and the
                    // clock moves with it, so both stay continuous.
                    (next + late, offset)
                } else {
                    let target = stamp - next;
                    (
                        next,
                        offset + (target - offset).clamp(-PULSE_SLEW_FRAMES, PULSE_SLEW_FRAMES),
                    )
                }
            }
            _ => (stamp, 0),
        };
        self.offset = Some(offset);
        self.next = Some(position + frames as i64);
        (position, position + offset)
    }

    /// [`Self::place_within`] for delivery-stamped DirectShow buffers: a
    /// stamp more than `dropout_frames` late is lost audio only once the next
    /// buffer confirms it at the device's own cadence. A capture thread that
    /// stalls under load (field: the MP4 finalization after a take) hands
    /// over the buffers the driver held in a burst, their stamps a
    /// millisecond apart. Counted as lost audio on the first of them, a 40 ms
    /// stall became a silence gap, put every later sample 40 ms late, and
    /// left the burst's stamps so far behind the count that the worker
    /// stopped ("PCM lies outside its captured packet clock interval"). Lost
    /// audio keeps every later stamp late at a normal cadence; a burst drains
    /// back to on time.
    fn place_delivery_stamped(
        &mut self,
        stamp: i64,
        frames: usize,
        dropout_frames: i64,
    ) -> (i64, i64) {
        let late = match (self.next, self.offset) {
            (Some(next), Some(offset)) => stamp - (next + offset),
            _ => 0,
        };
        let previous = self.previous_late.replace((stamp, late));
        let confirmed = late > dropout_frames
            && previous.is_some_and(|(previous_stamp, previous_late)| {
                previous_late > dropout_frames
                    && stamp - previous_stamp >= frames as i64 - dropout_frames
            });
        let dropout_frames = if confirmed { dropout_frames } else { i64::MAX };
        self.place_within(stamp, frames, dropout_frames)
    }
}

/// The newest stamp (1/48000 s, wall clock) a pulse packet of `frames` can
/// carry when it reaches the worker at wall time `wall_now` (1/48000 s): its
/// last sample cannot be later than its arrival. After a stall long enough to
/// overrun the Pulse stream, the demuxer's stamps (wall clock less the latency
/// Pulse reports) ran up to ~17 ms past the packets' arrival for a while (ends
/// 27 ms past it on ogre). Their capture instants then crossed the 20 ms
/// `PULSE_CLOCK_UNCERTAINTY`, `CaptureClock` stopped the worker as "PCM is
/// ahead of its capture clock" and the microphone stayed silent for the rest
/// of the session (retest 151: 27 minutes of a 30-minute soak).
fn latest_pulse_stamp_at(wall_now: i64, frames: usize) -> i64 {
    wall_now.saturating_sub(frames as i64)
}

/// [`latest_pulse_stamp_at`] for a packet arriving at `now`, read through the
/// same wall/monotonic pair that maps its anchor back to an `Instant`.
fn latest_pulse_stamp(clock: &ClockPair, now: Instant, frames: usize) -> i64 {
    let wall_now_ns =
        clock.wall_ns + now.saturating_duration_since(clock.monotonic).as_nanos() as i128;
    let wall_now = i64::try_from(wall_now_ns * 48_000 / 1_000_000_000).unwrap_or(i64::MAX);
    latest_pulse_stamp_at(wall_now, frames)
}

/// A pulse packet's anchor: its counted sample position, captured at the
/// wall-clock stamp `PulseTimeline::place` gave it. Both in 1/48000 s.
fn pulse_anchor(
    position: i64,
    stamp: i64,
    frames: usize,
    clock: &ClockPair,
) -> Result<CaptureAnchor> {
    let micros = |pts: i64| -> Result<i64> {
        Ok(i64::try_from(
            i128::from(pts)
                .checked_mul(1_000_000)
                .context("Pulse capture timestamp overflow")?
                / 48_000,
        )?)
    };
    let captured_start = clock.instant_from_wall(i128::from(micros(stamp)?) * 1_000)?;
    Ok(CaptureAnchor {
        pts_us: micros(position)?,
        captured_start,
        input_duration: Some(Duration::from_secs_f64(frames as f64 / 48_000.0)),
        uncertainty: clock.uncertainty + PULSE_CLOCK_UNCERTAINTY,
        stamp_jitter: Duration::ZERO,
    })
}

/// Which capture protocol a worker speaks: how its PCM gets a capture time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureProtocol {
    /// Patched macOS FFmpeg: `VIDEORC_AVF_CLOCK` records.
    AvFoundation,
    /// The Windows capture worker: `VIDEORC_DSHOW_CLOCK` records.
    DirectShow,
    /// Stock Linux FFmpeg `-f pulse`: wall-clock PCM timestamps.
    Pulse,
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
    /// [`Self::interval_at`] for a packet whose own `pts` is its stamp (the
    /// AVFoundation and Pulse workers); the assembler calls `interval_at`.
    #[cfg(test)]
    fn interval(&mut self, packet: PcmDescription, now: Instant) -> Result<(u64, Instant)> {
        self.interval_at(packet, packet.pts, now)
    }

    /// `packet.pts` is the sample-count position; `clock_pts` (same 1/48000 s
    /// scale) is the stamp matched against the capture clock anchors. They
    /// differ only for DirectShow, whose stamps `PulseTimeline` smooths.
    fn interval_at(
        &mut self,
        packet: PcmDescription,
        clock_pts: i64,
        now: Instant,
    ) -> Result<(u64, Instant)> {
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
        // i128: a Linux pulse PTS is the wall clock in 1/48000 s (about 9e13),
        // so the microsecond product overflows i64 (release test 147).
        let pts_us = i64::try_from(i128::from(clock_pts) * 1_000_000 / 48000)
            .context("PCM timestamp overflow")?;
        let anchor = self
            .anchors
            .iter()
            .rev()
            .find(|anchor| anchor.pts_us <= pts_us + 25)
            .context("PCM has no exact capture clock anchor")?;
        // PCM may start up to one packet after its anchor (plus 25 µs of
        // resampler slack). A 500 ms DirectShow packet (plan 195 W2) is as
        // valid as a 10 ms one; only an anchor of unknown length keeps the
        // 100 ms bound. A delivery-stamped DirectShow packet widens both sides
        // by its stamp jitter.
        let delta_us = pts_us - anchor.pts_us;
        let slack_us = anchor.stamp_jitter.as_micros() as i64 + 25;
        let stall_allowance_us = if anchor.stamp_jitter.is_zero() {
            0
        } else {
            DSHOW_STALL_ALLOWANCE.as_micros() as i64
        };
        let max_delta_us = anchor
            .input_duration
            .map_or(100_000, |duration| duration.as_micros() as i64)
            + slack_us
            + stall_allowance_us;
        if delta_us < -slack_us || delta_us > max_delta_us {
            bail!(
                "PCM lies outside its captured packet clock interval (pcm at {pts_us} us is {delta_us} us past its anchor at {} us; allowed -{slack_us}..{max_delta_us} us for a {}-frame packet)",
                anchor.pts_us,
                packet.frames
            );
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
        if end > now + anchor.uncertainty + Duration::from_micros(25) {
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

/// How much of the worker's stderr a readiness failure may carry (plan 195
/// S1): the last few diagnostic lines, never the PCM metadata stream.
const STDERR_TAIL_LINES: usize = 3;
const STDERR_TAIL_BYTES: usize = 300;
const STDERR_TAIL_LINE_BYTES: usize = 120;

/// The worker's last stderr lines, with the device name and its DirectShow
/// moniker redacted, so a failure reason in a support bundle says what FFmpeg
/// said (a device busy, a format it could not open, a dropped real-time
/// buffer) without naming the user's hardware.
#[derive(Debug, Default)]
pub(crate) struct WorkerStderrTail {
    lines: VecDeque<String>,
    redact: Vec<String>,
}

pub(crate) type StderrTail = Arc<Mutex<WorkerStderrTail>>;

impl WorkerStderrTail {
    pub(crate) fn new(redact: Vec<String>) -> Self {
        Self {
            lines: VecDeque::new(),
            redact: redact
                .into_iter()
                .filter(|needle| !needle.is_empty())
                .collect(),
        }
    }

    /// Keeps a diagnostic line; metadata records and blank lines are skipped.
    pub(crate) fn push(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() || !metadata_records(line).is_empty() {
            return;
        }
        let mut redacted = line.to_string();
        for needle in &self.redact {
            redacted = redacted.replace(needle, "<device>");
        }
        let redacted = bounded_prefix(&redacted, STDERR_TAIL_LINE_BYTES);
        self.lines.push_back(redacted);
        while self.lines.len() > STDERR_TAIL_LINES {
            self.lines.pop_front();
        }
    }

    /// `line | line | line`, at most `STDERR_TAIL_BYTES`, or `None` when the
    /// worker printed nothing but metadata.
    pub(crate) fn render(&self) -> Option<String> {
        if self.lines.is_empty() {
            return None;
        }
        let joined = self.lines.iter().cloned().collect::<Vec<_>>().join(" | ");
        Some(bounded_prefix(&joined, STDERR_TAIL_BYTES))
    }
}

/// The first `max_bytes` of `text` on a char boundary, with an ellipsis when
/// anything was cut.
fn bounded_prefix(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes.saturating_sub(1);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

pub(crate) struct CapturedInput {
    pub device_name: String,
    pub receiver: mpsc::Receiver<AudioFrame>,
    pub stats: Arc<AudioCaptureStats>,
    pub owner: Box<dyn Send>,
    pub failure: Failure,
    pub stderr_tail: StderrTail,
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

fn capture_command(ffmpeg: &str, device: &str, protocol: CaptureProtocol) -> Command {
    let mut command = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.env("TZ", "UTC0").args([
        "-hide_banner",
        "-nostdin",
        "-nostats",
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
    if protocol == CaptureProtocol::Pulse {
        command.envs(crate::linux_pulse_audio::pulse_pinned_source_env());
        // 10 ms fragments (480 stereo s16 frames): one bounded PCM record per
        // fragment. `-wallclock` is FFmpeg's default and spelled out because
        // the capture clock depends on it.
        command.args([
            "-f",
            "pulse",
            "-wallclock",
            "1",
            "-sample_rate",
            "48000",
            "-channels",
            "2",
            "-fragment_size",
            "1920",
            "-i",
            device,
        ]);
    } else if protocol == CaptureProtocol::DirectShow {
        command.args([
            "-f",
            "dshow",
            "-videorc_audio_clock",
            "1",
            "-audio_buffer_size",
            "20",
            "-rtbufsize",
            "65536",
            "-i",
            &format!("audio={device}"),
        ]);
    } else {
        command.args([
            "-f",
            "avfoundation",
            "-videorc_audio_clock",
            "1",
            "-videorc_audio_uid",
            device,
            "-i",
            "none:none",
        ]);
    }
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
    if id.starts_with("microphone:avfoundation:") {
        bail!(
            "This saved AVFoundation microphone uses an unbound device index. Select the microphone again to confirm its stable identity"
        );
    }
    if let Some(uid) = crate::devices::parse_avfoundation_microphone_uid(id) {
        if !cfg!(target_os = "macos") {
            bail!("AVFoundation microphones require macOS");
        }
        let help = output_owned_std_with_timeout(
            Command::new(ffmpeg).args(["-hide_banner", "-h", "demuxer=avfoundation"]),
            Duration::from_secs(1),
        )?;
        let help = String::from_utf8_lossy(&help.stdout);
        if !help.contains("-videorc_audio_clock")
            || !help.contains("Videorc AVF clock protocol 1)")
            || !help.contains("-videorc_audio_uid")
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
                    && device.uid_hex.as_deref() == Some(uid)
            })
            .collect();
        if matching.len() != 1 {
            bail!("The selected AVFoundation microphone is missing or ambiguous");
        }
        return Ok((uid.to_string(), matching[0].name.clone()));
    }
    if let Some(name) = crate::audio::parse_windows_dshow_microphone_id(id) {
        if !cfg!(target_os = "windows") {
            bail!("DirectShow microphones require Windows");
        }
        if name.is_empty() || name.contains(['\0', '\r', '\n']) {
            bail!("Invalid DirectShow device identity");
        }
        ensure_dshow_protocol(ffmpeg)?;
        let target = resolve_with_inventory_cache(
            dshow_inventory_cache(),
            std::path::Path::new(ffmpeg),
            Instant::now(),
            |inventory| resolve_dshow_name(inventory, &name),
            || fetch_dshow_inventory(ffmpeg),
        )?;
        return Ok((target, name));
    }
    if let Some(source) = crate::linux_pulse_audio::parse_linux_pulse_microphone_id(id) {
        if !cfg!(target_os = "linux") {
            bail!("PulseAudio microphones require Linux");
        }
        if source.starts_with('-') || source.contains(['\0', '\r', '\n']) {
            bail!("Invalid PulseAudio source identity");
        }
        // Retest 154 (C4): an unplugged source is not opened at all, so the
        // session records silence and says so instead of another mic.
        #[cfg(target_os = "linux")]
        let listing = crate::linux_pulse_audio::linux_pulse_sources_blocking(ffmpeg);
        #[cfg(not(target_os = "linux"))]
        let listing: Option<Vec<crate::linux_pulse_audio::PulseSource>> = None;
        ensure_pulse_source_present(listing.as_deref(), &source)?;
        return Ok((source.clone(), source));
    }
    bail!("This microphone capture adapter does not recognize the device identity")
}

fn ensure_pulse_source_present(
    listing: Option<&[crate::linux_pulse_audio::PulseSource]>,
    source: &str,
) -> Result<()> {
    if crate::linux_pulse_audio::pulse_source_missing(listing, source) {
        return Err(WorkerStartError::new(
            WorkerStartFailureKind::DeviceNotInInventory,
            crate::linux_pulse_audio::pulse_source_not_connected_message(source),
        )
        .into());
    }
    Ok(())
}

/// Limits for the worker's two probe children. A cold `ffmpeg-capture.exe`
/// under antivirus scanning, or a DirectShow enumeration that walks virtual
/// devices and capture cards, took longer than the old 1 s / 2 s on a
/// tester's Iris Xe laptop and cost the whole session its microphone.
const DSHOW_PROTOCOL_PROBE_LIMIT: Duration = Duration::from_secs(4);
const DSHOW_INVENTORY_PROBE_LIMIT: Duration = Duration::from_secs(8);
/// A cached inventory older than this is refreshed before use, so a device
/// that was replaced (new moniker, same name) is not resolved stale forever.
const DSHOW_INVENTORY_TTL: Duration = Duration::from_secs(10 * 60);

fn probe_command(worker: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(worker);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, like the capture command itself.
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Workers whose protocol probe passed, keyed by path, size and mtime so a
/// replaced binary is checked again. Failures are never cached.
fn verified_workers() -> &'static Mutex<std::collections::HashSet<WorkerIdentity>> {
    static VERIFIED: std::sync::OnceLock<Mutex<std::collections::HashSet<WorkerIdentity>>> =
        std::sync::OnceLock::new();
    VERIFIED.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WorkerIdentity {
    path: std::path::PathBuf,
    len: Option<u64>,
    modified: Option<SystemTime>,
}

impl WorkerIdentity {
    fn of(worker: &str) -> Self {
        let metadata = std::fs::metadata(worker).ok();
        Self {
            path: std::path::PathBuf::from(worker),
            len: metadata.as_ref().map(std::fs::Metadata::len),
            modified: metadata.and_then(|metadata| metadata.modified().ok()),
        }
    }
}

fn ensure_dshow_protocol(worker: &str) -> Result<()> {
    let identity = WorkerIdentity::of(worker);
    if verified_workers()
        .lock()
        .map(|verified| verified.contains(&identity))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let help = output_owned_std_with_timeout(
        probe_command(worker).args(["-hide_banner", "-h", "demuxer=dshow"]),
        DSHOW_PROTOCOL_PROBE_LIMIT,
    )
    .map_err(|error| probe_error("protocol", error))?;
    let help = String::from_utf8_lossy(&help.stdout);
    if !help.contains("-videorc_audio_clock") || !help.contains("Videorc DShow clock protocol 1)") {
        return Err(WorkerStartError::new(
            WorkerStartFailureKind::ProtocolMissing,
            "The capture worker lacks DirectShow clock protocol 1",
        )
        .into());
    }
    if let Ok(mut verified) = verified_workers().lock() {
        verified.insert(identity);
    }
    Ok(())
}

fn fetch_dshow_inventory(worker: &str) -> Result<String> {
    let output = output_owned_std_with_timeout(
        probe_command(worker).args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ]),
        DSHOW_INVENTORY_PROBE_LIMIT,
    )
    .map_err(|error| probe_error("device inventory", error))?;
    Ok(String::from_utf8_lossy(&output.stderr).into_owned())
}

/// The last DirectShow inventory the worker printed. Held while it is
/// refreshed, so a session start waits for an in-flight warm-up instead of
/// running a second enumeration beside it.
#[derive(Debug, Clone)]
pub(crate) struct CachedDshowInventory {
    worker: std::path::PathBuf,
    fetched_at: Instant,
    text: String,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    microphone_names: Option<Vec<String>>,
}

pub(crate) type DshowInventoryCache = Mutex<Option<CachedDshowInventory>>;

fn dshow_inventory_cache() -> &'static DshowInventoryCache {
    static CACHE: std::sync::OnceLock<DshowInventoryCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Resolves against the cached inventory, refreshing it when it is missing,
/// stale, from another worker, or lacks the device (a newly connected mic).
/// At most one refresh per call.
fn resolve_with_inventory_cache(
    cache: &DshowInventoryCache,
    worker: &std::path::Path,
    now: Instant,
    mut resolve: impl FnMut(&str) -> Result<String>,
    refresh: impl FnOnce() -> Result<String>,
) -> Result<String> {
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = cached.as_ref()
        && entry.worker == worker
        && now.saturating_duration_since(entry.fetched_at) < DSHOW_INVENTORY_TTL
    {
        match resolve(&entry.text) {
            Ok(target) => {
                tracing::debug!("Capture worker resolved its device from the cached inventory");
                return Ok(target);
            }
            Err(error)
                if worker_start_failure_kind(&error)
                    != Some(WorkerStartFailureKind::DeviceNotInInventory) =>
            {
                return Err(error);
            }
            Err(_) => {}
        }
    }
    let text = refresh()?;
    let target = resolve(&text);
    *cached = Some(CachedDshowInventory {
        worker: worker.to_path_buf(),
        fetched_at: now,
        text,
        microphone_names: None,
    });
    target
}

/// Refreshes the cached inventory off the start path when the microphone set
/// that discovery reports changed, or the cache is stale. Discovery calls it
/// after every Windows device listing; one warm-up runs at a time.
#[cfg(target_os = "windows")]
pub(crate) fn warm_dshow_inventory(output_ffmpeg: &str, microphone_names: Vec<String>) {
    static WARMING: AtomicBool = AtomicBool::new(false);
    let worker = windows_worker_path(output_ffmpeg);
    if !worker.is_file() || WARMING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = thread::Builder::new()
        .name("dshow-inventory-warm".into())
        .spawn(move || {
            let worker_text = worker.to_string_lossy().into_owned();
            let _ = warm_inventory_cache(
                dshow_inventory_cache(),
                &worker,
                microphone_names,
                Instant::now(),
                || {
                    ensure_dshow_protocol(&worker_text)?;
                    fetch_dshow_inventory(&worker_text)
                },
            );
            WARMING.store(false, Ordering::Release);
        });
    if spawned.is_err() {
        WARMING.store(false, Ordering::Release);
    }
}

/// Returns whether a refresh ran.
#[cfg(any(test, target_os = "windows"))]
fn warm_inventory_cache(
    cache: &DshowInventoryCache,
    worker: &std::path::Path,
    microphone_names: Vec<String>,
    now: Instant,
    refresh: impl FnOnce() -> Result<String>,
) -> Result<bool> {
    let mut microphone_names = microphone_names;
    microphone_names.sort();
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = cached.as_ref().is_some_and(|entry| {
        entry.worker == worker
            && now.saturating_duration_since(entry.fetched_at) < DSHOW_INVENTORY_TTL
            && entry.microphone_names.as_ref() == Some(&microphone_names)
    });
    if current {
        return Ok(false);
    }
    match refresh() {
        Ok(text) => {
            *cached = Some(CachedDshowInventory {
                worker: worker.to_path_buf(),
                fetched_at: now,
                text,
                microphone_names: Some(microphone_names),
            });
            Ok(true)
        }
        Err(error) => {
            tracing::warn!("Capture worker inventory warm-up failed: {error:#}");
            Err(error)
        }
    }
}

pub(crate) fn windows_worker_path(output_ffmpeg: &str) -> std::path::PathBuf {
    std::path::Path::new(output_ffmpeg).with_file_name("ffmpeg-capture.exe")
}

fn resolve_dshow_name(inventory: &str, selected: &str) -> Result<String> {
    resolve_dshow_kind(inventory, selected, "(audio)")
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn resolve_dshow_video_name(inventory: &str, selected: &str) -> Result<String> {
    resolve_dshow_kind(inventory, selected, "(video)")
}

fn resolve_dshow_kind(inventory: &str, selected: &str, kind: &str) -> Result<String> {
    let mut audio: Vec<(String, Option<String>)> = Vec::new();
    let mut current_audio = false;
    for line in inventory.lines() {
        if line.contains("Alternative name") {
            if current_audio && let Some((_, alternate)) = audio.last_mut() {
                *alternate = quoted_name(line);
            }
        } else if line.contains("(audio)") || line.contains("(video)") {
            current_audio = line.contains(kind);
            if current_audio && let Some(name) = quoted_name(line) {
                audio.push((name, None));
            }
        }
    }
    let matching: Vec<_> = audio.iter().filter(|(name, _)| name == selected).collect();
    if matching.len() != 1 {
        return Err(WorkerStartError::new(
            WorkerStartFailureKind::DeviceNotInInventory,
            "The selected DirectShow device is missing or its friendly name is ambiguous",
        )
        .into());
    }
    let target = matching[0].1.as_deref().unwrap_or(selected);
    if target.is_empty()
        || target.contains(['\0', '\r', '\n', ':', '='])
        || audio
            .iter()
            .filter(|(_, alternate)| alternate.as_deref() == Some(target))
            .count()
            > 1
    {
        bail!("The selected DirectShow alternative name is ambiguous");
    }
    Ok(target.into())
}
fn quoted_name(line: &str) -> Option<String> {
    let first = line.find('"')?;
    let last = line.rfind('"')?;
    (last > first).then(|| line[first + 1..last].to_string())
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
            let wall_ns = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as i128;
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
                    wall_ns,
                    uncertainty,
                });
            }
        }
        bail!("The capture clock mapping could not meet its one-millisecond uncertainty budget")
    }
}

/// What a worker stderr line says about why the worker is stopping, if
/// anything. A named capture-clock refusal comes first: the patched worker
/// prints it just before FFmpeg's generic "Error during demuxing" line, and
/// the first failure recorded is the one the session reports. Left to the
/// metadata thread (which polls every 10 ms) the generic line won that race
/// on the field Intel SST microphone, and the check that killed the capture
/// went unnamed.
fn stderr_line_failure(text: &str) -> Option<String> {
    if text.contains("VIDEORC_DSHOW_CLOCK_INVALID") {
        return Some(format!(
            "DirectShow could not map the selected device capture clock{}",
            dshow_invalid_detail(text)
        ));
    }
    if text.contains("VIDEORC_AVF_CLOCK_INVALID") {
        return Some(
            "AVFoundation could not convert the selected device capture clock".to_string(),
        );
    }
    if text.contains("Error")
        || text.contains("error")
        || text.contains("denied")
        || text.contains("Could not")
    {
        return Some(text.chars().take(512).collect());
    }
    None
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
    let protocol = if crate::audio::parse_windows_dshow_microphone_id(device_id).is_some() {
        CaptureProtocol::DirectShow
    } else if crate::linux_pulse_audio::parse_linux_pulse_microphone_id(device_id).is_some() {
        CaptureProtocol::Pulse
    } else {
        CaptureProtocol::AvFoundation
    };
    let worker = if protocol == CaptureProtocol::DirectShow {
        windows_worker_path(ffmpeg).to_string_lossy().into_owned()
    } else {
        ffmpeg.into()
    };
    let (device, device_name) = resolve_target(&worker, device_id)?;
    let clock_pair = ClockPair::sample()?;
    tracing::debug!(
        uncertainty_us = clock_pair.uncertainty.as_micros(),
        "Mapped capture worker clock"
    );
    let child = spawn_owned_std(&mut capture_command(&worker, &device, protocol))?;
    let stop = Arc::new(AtomicBool::new(false));
    let failure: Failure = Arc::new(Mutex::new(None));
    let stderr_tail: StderrTail = Arc::new(Mutex::new(WorkerStderrTail::new(vec![
        device_name.clone(),
        device.clone(),
    ])));
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
    let (raw_tx, raw_rx) = mpsc::sync_channel::<Vec<u8>>(RAW_PCM_QUEUE_CHUNKS);
    // Two records per packet (clock, then ashowinfo). FFmpeg drains its
    // 17-packet real-time buffer in a burst after a stall; with the assembler
    // starved by the same load, 64 records overflowed 9.7 s into a field
    // session. 256 holds 2.5 s of 20 ms packets; the age check drops what
    // arrives stale.
    let (metadata_tx, metadata_rx) = mpsc::sync_channel::<String>(256);
    let (pcm_tx, receiver) = capture_output_channel(protocol);
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
    let read_tail = stderr_tail.clone();
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
                        if *byte == b'\n' || *byte == b'\r' {
                            let text = String::from_utf8_lossy(&line).into_owned();
                            line.clear();
                            read_tail
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .push(&text);
                            for record in metadata_records(&text) {
                                if metadata_tx.try_send(record).is_err() {
                                    fail(
                                        &read_failure,
                                        "Capture timestamp metadata exceeded its bounded queue",
                                    );
                                    return;
                                }
                            }
                            if let Some(reason) = stderr_line_failure(&text) {
                                fail(&read_failure, reason);
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
                    protocol,
                    clock_pair,
                    metadata_rx,
                    raw_rx,
                    pcm_tx,
                    &assemble_stop,
                    &assemble_stats,
                );
                if let Err(error) = result
                    && !assemble_stop.load(Ordering::Acquire)
                {
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
        stderr_tail,
    })
}

/// Cumulative interval evidence; logs contain no audio, device name, or path.
#[derive(Default)]
struct CaptureDiagnostics {
    packets: u64,
    input_frames: u64,
    input_rate: u64,
    native_overwritten: Option<u64>,
    last_input_end_us: Option<i64>,
    input_gap_us: u64,
    max_input_gap_us: u64,
    pcm_frames: u64,
    pcm_gap_frames: u64,
    max_pcm_gap_frames: u64,
}
impl CaptureDiagnostics {
    fn input(&mut self, line: &str, anchor: CaptureAnchor) -> Result<()> {
        let frames = u64::try_from(integer(line, "frames=")?)?;
        let rate = u64::try_from(integer(line, "rate=")?)?;
        if let Some(end) = self.last_input_end_us {
            // Microsecond export rounds sub-sample intervals; ignore <=1us.
            let gap = anchor.pts_us.saturating_sub(end).max(0) as u64;
            if gap > 1 {
                self.input_gap_us += gap;
                self.max_input_gap_us = self.max_input_gap_us.max(gap);
            }
        }
        self.last_input_end_us = Some(anchor.pts_us + (frames * 1_000_000 / rate) as i64);
        self.packets += 1;
        self.input_frames += frames;
        self.input_rate = rate;
        // Older protocol-v1 binaries predate this optional diagnostic field.
        if word_after(line, "overwritten=").is_ok() {
            self.native_overwritten = Some(u64::try_from(integer(line, "overwritten=")?)?);
        }
        Ok(())
    }
    fn pcm(&mut self, packet: PcmDescription, previous_end: Option<i64>) {
        self.pcm_frames += packet.frames as u64;
        if let Some(end) = previous_end {
            let gap = packet.pts.saturating_sub(end).max(0) as u64;
            self.pcm_gap_frames += gap;
            self.max_pcm_gap_frames = self.max_pcm_gap_frames.max(gap);
        }
    }
}

fn observe_wall(
    clock_pair: &mut ClockPair,
    watch: &mut WallStepWatch,
    last_check: &mut Instant,
    rate_limit: bool,
) {
    let now = Instant::now();
    if rate_limit && now.saturating_duration_since(*last_check) < PULSE_WALL_CHECK_INTERVAL {
        return;
    }
    *last_check = now;
    let Some((sampled_now, wall_ns)) = ClockPair::sample_wall_now() else {
        return;
    };
    let offset = wall_offset_ns(clock_pair, sampled_now, wall_ns);
    if watch.observe(classify_wall_offset(offset))
        && let Ok(next) = ClockPair::sample()
    {
        // Rare by design: a real step or a sustained drift. Logged so a
        // capture timeline jump can be matched to it.
        tracing::warn!(
            offset_us = (offset / 1_000) as i64,
            "Capture wall clock moved; the capture clock pair was re-taken"
        );
        *clock_pair = next;
    }
}

/// Wait for the raw bytes belonging to one metadata record. Keep receipt and
/// time injectable so protocol budgets can be tested without scheduler sleeps.
/// `false` means capture was cancelled before the packet was complete.
fn match_pcm_bytes(
    queued: &mut VecDeque<u8>,
    wanted: usize,
    match_budget: Duration,
    stop: &AtomicBool,
    mut receive: impl FnMut(Duration) -> std::result::Result<Vec<u8>, mpsc::RecvTimeoutError>,
    mut now: impl FnMut() -> Instant,
) -> Result<bool> {
    let deadline = now() + match_budget;
    while queued.len() < wanted {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        if now() >= deadline {
            bail!(
                "Capture PCM did not match its timestamp metadata within {}ms",
                match_budget.as_millis()
            );
        }
        match receive(Duration::from_millis(5)) {
            Ok(bytes) => queued.extend(bytes),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("Capture PCM ended in a partial timestamped packet")
            }
        }
    }
    Ok(true)
}

fn assemble_pcm(
    protocol: CaptureProtocol,
    mut clock_pair: ClockPair,
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
    let mut diagnostics = CaptureDiagnostics::default();
    // Pulse and DirectShow: the sample count and capture clock (see
    // `PulseTimeline`).
    let mut pulse = PulseTimeline::default();
    let mut last_diagnostic = Instant::now();
    let mut wall_watch = WallStepWatch::default();
    let mut last_wall_check = Instant::now()
        .checked_sub(PULSE_WALL_CHECK_INTERVAL)
        .unwrap_or_else(Instant::now);
    while !stop.load(Ordering::Acquire) {
        let line = match metadata.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("The capture worker stopped producing timestamped PCM")
            }
        };
        if line.contains("VIDEORC_DSHOW_CLOCK_INVALID") {
            bail!(
                "DirectShow could not map the selected device capture clock{}",
                dshow_invalid_detail(&line)
            );
        }
        if line.contains("VIDEORC_DSHOW_CLOCK version=") {
            observe_wall(
                &mut clock_pair,
                &mut wall_watch,
                &mut last_wall_check,
                false,
            );
            clock.push(dshow_anchor(&line, &clock_pair)?)?;
            continue;
        }
        if line.contains("VIDEORC_AVF_CLOCK_INVALID") {
            bail!("AVFoundation could not convert the selected device capture clock");
        }
        if line.contains("VIDEORC_AVF_CLOCK version=") {
            let anchor = avf_anchor(&line, &clock_pair)?;
            diagnostics.input(&line, anchor)?;
            clock.push(anchor)?;
            continue;
        }
        let mut packet = parse_pcm_description(&line)?;
        if protocol == CaptureProtocol::Pulse {
            observe_wall(&mut clock_pair, &mut wall_watch, &mut last_wall_check, true);
            let stamp = packet.pts.min(latest_pulse_stamp(
                &clock_pair,
                Instant::now(),
                packet.frames,
            ));
            let (position, captured) = pulse.place(stamp, packet.frames);
            packet.pts = position;
            clock.push(pulse_anchor(
                position,
                captured,
                packet.frames,
                &clock_pair,
            )?)?;
        }
        let mut clock_pts = packet.pts;
        if protocol == CaptureProtocol::DirectShow {
            (packet.pts, clock_pts) =
                pulse.place_delivery_stamped(packet.pts, packet.frames, DSHOW_DROPOUT_FRAMES);
        }
        let wanted = packet.frames * 8;
        // FFmpeg logs the record and writes its PCM from different threads, so
        // the PCM may trail it by as long as the packet may age (Pulse: the
        // worker stopped on a loaded Linux desktop at 100 ms, retest 153).
        if !match_pcm_bytes(
            &mut queued,
            wanted,
            max_capture_age(protocol),
            stop,
            |wait| raw.recv_timeout(wait),
            Instant::now,
        )? {
            return Ok(());
        }
        let bytes: Vec<_> = queued.drain(..wanted).collect();
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte PCM sample")))
            .collect();
        if samples.iter().any(|sample| !sample.is_finite()) {
            bail!("Capture PCM contains a non-finite sample");
        }
        diagnostics.pcm(packet, clock.last_end_pts);
        let (timestamp_micros, captured_at) =
            clock.interval_at(packet, clock_pts, Instant::now())?;
        if last_diagnostic.elapsed() >= Duration::from_secs(5) {
            tracing::info!(
                packets = diagnostics.packets,
                input_frames = diagnostics.input_frames,
                input_rate = diagnostics.input_rate,
                native_overwritten = diagnostics.native_overwritten,
                input_gap_us = diagnostics.input_gap_us,
                max_input_gap_us = diagnostics.max_input_gap_us,
                pcm_frames = diagnostics.pcm_frames,
                pcm_gap_frames = diagnostics.pcm_gap_frames,
                max_pcm_gap_frames = diagnostics.max_pcm_gap_frames,
                "Capture worker interval diagnostics"
            );
            last_diagnostic = Instant::now();
        }
        if captured_at > Instant::now() {
            thread::sleep(captured_at.saturating_duration_since(Instant::now()));
        }
        if captured_at.elapsed() > max_capture_age(protocol) {
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

    #[test]
    fn pulse_output_retains_a_playout_window_without_waiting_for_the_consumer() {
        let (sender, receiver) = capture_output_channel(CaptureProtocol::Pulse);
        let epoch = Instant::now();
        let packet_duration = Duration::from_millis(10);
        let packets = crate::session_audio::SYSTEM_AUDIO_PLAYOUT_DELAY.as_millis()
            / packet_duration.as_millis();
        // The bus is deliberately not drained until a whole playout window
        // has arrived. This models a bounded consumer stall without sleeps or
        // relying on the test runner's scheduler. The old four-packet queue
        // loses packet 5 even though its capture time is inside that window.
        for index in 0..packets as u64 {
            sender
                .try_send(AudioFrame {
                    timestamp_micros: index * 10_000,
                    captured_at: epoch + packet_duration * (index + 1) as u32,
                    sample_rate: 48_000,
                    channels: 2,
                    samples: vec![index as f32 / 100.0; 960],
                })
                .expect("fresh Pulse PCM must fit through the playout window");
        }
        for index in 0..packets as u64 {
            let frame = receiver
                .try_recv()
                .expect("every captured packet is retained");
            assert_eq!(frame.timestamp_micros, index * 10_000);
            assert_eq!(frame.samples, vec![index as f32 / 100.0; 960]);
        }
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn pulse_output_capacity_remains_bounded_and_preserves_refused_pcm() {
        let (sender, receiver) = capture_output_channel(CaptureProtocol::Pulse);
        let packet = AudioFrame {
            timestamp_micros: 0,
            captured_at: Instant::now(),
            sample_rate: 48_000,
            channels: 2,
            samples: vec![0.25; 960],
        };
        // Do not permit a future capacity change to become an unbounded
        // backlog. Refused packets remain available to the caller so its
        // existing dropped-frame counter can account for every sample.
        let maximum_packets = PULSE_MAX_CAPTURE_AGE.as_millis() / 10;
        let mut accepted = 0;
        loop {
            match sender.try_send(packet.clone()) {
                Ok(()) => {
                    accepted += 1;
                    assert!(accepted <= maximum_packets);
                }
                Err(mpsc::TrySendError::Full(refused)) => {
                    assert_eq!(refused.samples, packet.samples);
                    break;
                }
                Err(error) => panic!("unexpected queue failure: {error}"),
            }
        }
        assert_eq!(receiver.try_iter().count(), accepted as usize);
    }

    #[test]
    fn future_pcm_validation_uses_accepted_clock_uncertainty() {
        let now = Instant::now();
        for (ahead, accepted) in [(1_900, true), (2_100, false)] {
            let mut clock = CaptureClock {
                anchors: VecDeque::from([CaptureAnchor {
                    pts_us: 0,
                    captured_start: now - Duration::from_millis(10) + Duration::from_micros(ahead),
                    input_duration: Some(Duration::from_millis(10)),
                    uncertainty: Duration::from_millis(2),
                    stamp_jitter: Duration::ZERO,
                }]),
                last_sequence: None,
                first_pts: None,
                last_end_pts: None,
            };
            let result = clock.interval(
                PcmDescription {
                    sequence: 0,
                    pts: 0,
                    frames: 480,
                },
                now,
            );
            assert_eq!(result.is_ok(), accepted);
        }
    }

    #[test]
    fn a_named_clock_refusal_is_the_stop_reason_not_ffmpegs_generic_error_line() {
        // The worker prints the named check first; FFmpeg's demux error
        // follows. The reader must record the named one so a stop is never
        // reported as "Invalid data found when processing input".
        assert_eq!(
            stderr_line_failure(
                "[dshow @ 0x1] VIDEORC_DSHOW_CLOCK_INVALID reason=wall-bracket sample_100ns=1 graph_100ns=2 wall_bracket_100ns=24000 bytes=3840"
            )
            .as_deref(),
            Some(
                "DirectShow could not map the selected device capture clock (reason=wall-bracket sample_100ns=1 graph_100ns=2 wall_bracket_100ns=24000 bytes=3840)"
            )
        );
        assert_eq!(
            stderr_line_failure("VIDEORC_AVF_CLOCK_INVALID").as_deref(),
            Some("AVFoundation could not convert the selected device capture clock")
        );
        assert_eq!(
            stderr_line_failure(
                "[in#0/dshow @ 0x1] Error during demuxing: Invalid data found when processing input"
            )
            .as_deref(),
            Some(
                "[in#0/dshow @ 0x1] Error during demuxing: Invalid data found when processing input"
            )
        );
        assert_eq!(
            stderr_line_failure("VIDEORC_DSHOW_CLOCK version=1 sample_100ns=0 bytes=3840"),
            None
        );
        assert_eq!(stderr_line_failure("size=  12kB time=00:00:01"), None);
    }

    #[test]
    fn stderr_tail_keeps_the_last_diagnostic_lines_redacted_and_bounded() {
        // Plan 195 S1: a readiness failure carries what FFmpeg said, without
        // the device name or its moniker, and never the metadata stream.
        let mut tail = WorkerStderrTail::new(vec![
            "Digital Microphone (2- Cirrus Logic High Definition Audio)".into(),
            "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{ABC}".into(),
        ]);
        assert_eq!(tail.render(), None);
        tail.push("");
        tail.push(&metadata());
        tail.push(&pcm(0, 0, 480));
        assert_eq!(tail.render(), None, "metadata never enters the tail");
        tail.push(
            "[dshow @ 0x1] Could not open \"Digital Microphone (2- Cirrus Logic High Definition Audio)\"",
        );
        tail.push("[dshow @ 0x1] Selecting pin Capture on @device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{ABC}");
        let rendered = tail.render().unwrap();
        assert!(
            rendered.contains("Could not open \"<device>\""),
            "{rendered}"
        );
        assert!(rendered.contains("pin Capture on <device>"), "{rendered}");
        assert!(!rendered.contains("Cirrus"), "{rendered}");
        assert!(!rendered.contains("wave_"), "{rendered}");
        for index in 0..10 {
            tail.push(&format!("line {index} {}", "x".repeat(200)));
        }
        let rendered = tail.render().unwrap();
        assert!(rendered.starts_with("line 7 "), "{rendered}");
        assert!(
            rendered.len() <= STDERR_TAIL_BYTES + '…'.len_utf8(),
            "{}",
            rendered.len()
        );
        assert!(
            !rendered.contains("line 6 "),
            "only the last three lines stay"
        );
    }

    #[test]
    fn interval_diagnostics_distinguish_native_overwrite_and_pcm_gaps() {
        let now = Instant::now();
        let mut diagnostics = CaptureDiagnostics::default();
        for (pts, overwritten) in [(0, 0), (10_667, 0), (32_000, 1)] {
            let anchor = CaptureAnchor {
                pts_us: pts,
                captured_start: now,
                input_duration: Some(Duration::from_secs_f64(512.0 / 48_000.0)),
                uncertainty: Duration::ZERO,
                stamp_jitter: Duration::ZERO,
            };
            diagnostics
                .input(
                    &format!("frames=512 rate=48000 overwritten={overwritten}"),
                    anchor,
                )
                .unwrap();
        }
        assert_eq!(diagnostics.packets, 3);
        assert_eq!(diagnostics.input_frames, 1536);
        assert_eq!(diagnostics.native_overwritten, Some(1));
        assert_eq!(diagnostics.input_gap_us, 10667);
        assert_eq!(diagnostics.max_input_gap_us, 10667);
        diagnostics.pcm(
            PcmDescription {
                sequence: 2,
                pts: 1536,
                frames: 512,
            },
            Some(1024),
        );
        assert_eq!(diagnostics.pcm_gap_frames, 512);
        assert_eq!(diagnostics.max_pcm_gap_frames, 512);
    }

    fn pair(now: Instant) -> ClockPair {
        ClockPair {
            monotonic: now,
            host_ns: Some(1_000_000_000),
            wall_ns: 1_000_000_000,
            uncertainty: Duration::ZERO,
        }
    }
    fn clock(now: Instant) -> CaptureClock {
        CaptureClock {
            anchors: VecDeque::from([CaptureAnchor {
                pts_us: 0,
                captured_start: now - Duration::from_millis(40),
                input_duration: Some(Duration::from_millis(40)),
                uncertainty: Duration::ZERO,
                stamp_jitter: Duration::ZERO,
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
        assert_eq!(
            parse_pcm_description(&pcm(0, 0, 48_000)).unwrap().frames,
            48_000,
            "a one-second packet is the bound (plan 195 W2)"
        );
        for malformed in [
            pcm(0, 0, 0),
            pcm(0, -1, 480),
            pcm(0, 0, 48_001),
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
                    input_duration: None,
                    uncertainty: Duration::ZERO,
                    stamp_jitter: Duration::ZERO,
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
            CaptureProtocol::AvFoundation,
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

    /// A `VIDEORC_DSHOW_CLOCK` record for a packet of `frames` s16 stereo
    /// frames whose capture started `started_ago` before the callback that
    /// delivered it, the callback being `pair.monotonic`.
    fn dshow_clock_line(
        pair: &ClockPair,
        sample_100ns: i64,
        frames: i64,
        started_ago: Duration,
    ) -> String {
        let callback_wall_100ns = pair.wall_ns / 100;
        let graph_100ns = sample_100ns + started_ago.as_nanos() as i64 / 100;
        format!(
            "VIDEORC_DSHOW_CLOCK version=1 sample_100ns={sample_100ns} graph_100ns={graph_100ns} wall_before_100ns={callback_wall_100ns} wall_after_100ns={callback_wall_100ns} bytes={} frames={frames} rate=48000 channels=2 bits=16 format=1",
            frames * 4
        )
    }

    #[test]
    fn a_big_directshow_packet_handed_over_at_its_end_is_fresh_pcm() {
        // Plan 195 W2: a driver that ignores the 20 ms request and delivers
        // 500 ms packets. Each packet's first sample is 500 ms old when the
        // callback runs; the packet is judged by its end, which is now.
        let pair = ClockPair::sample().unwrap();
        let packet = Duration::from_millis(500);
        let anchor = dshow_anchor(&dshow_clock_line(&pair, 0, 24_000, packet), &pair).unwrap();
        assert_eq!(anchor.input_duration, Some(packet));
        // The wall clock is exported in 100 ns units, so the start may sit
        // under 100 ns from the exact instant.
        let expected_start = pair.monotonic - packet;
        let skew = if anchor.captured_start >= expected_start {
            anchor.captured_start - expected_start
        } else {
            expected_start - anchor.captured_start
        };
        assert!(skew < Duration::from_micros(1), "{skew:?}");
        let bytes: Vec<u8> = (0..48_000).flat_map(|_| 0.25f32.to_le_bytes()).collect();
        let (meta_tx, meta_rx) = mpsc::channel();
        meta_tx
            .send(dshow_clock_line(&pair, 0, 24_000, packet))
            .unwrap();
        meta_tx.send(pcm(0, 0, 24_000)).unwrap();
        drop(meta_tx);
        let (raw_tx, raw_rx) = mpsc::channel();
        raw_tx.send(bytes).unwrap();
        drop(raw_tx);
        let (out_tx, out_rx) = mpsc::sync_channel(4);
        let stats = Arc::new(AudioCaptureStats::default());
        let result = assemble_pcm(
            CaptureProtocol::DirectShow,
            pair,
            meta_rx,
            raw_rx,
            out_tx,
            &AtomicBool::new(false),
            &stats,
        );
        assert!(
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.to_string().contains("stopped producing")),
            "the fixture ends at EOF, not at a rejection: {result:?}"
        );
        let frames: Vec<AudioFrame> = out_rx.try_iter().collect();
        assert_eq!(frames.len(), 1, "the 500 ms packet is fresh, not stale");
        assert_eq!(frames[0].samples.len(), 48_000);
        assert_eq!(stats.captured_frames(), 24_000);
        assert_eq!(stats.dropped_frames(), 0);
        assert!(frames[0].captured_at.elapsed() < MAX_CAPTURE_AGE);
    }

    /// Contiguous 20 ms PCM from 20 ms DirectShow packets stamped at delivery:
    /// packet `n` is stamped `late_ms[n]` after its sample-count position and
    /// read from the graph clock 20 ms later. FFmpeg carries the stamp into
    /// the PCM `pts`; `placed` runs it through the production placement. Returns
    /// each packet's sample position.
    fn delivery_stamped_intervals(
        late_ms: &[i64],
        stamp_jitter: Duration,
        placed: bool,
    ) -> Result<Vec<i64>> {
        let pair = ClockPair::sample().unwrap();
        let mut clock = CaptureClock {
            anchors: VecDeque::new(),
            last_sequence: None,
            first_pts: None,
            last_end_pts: None,
        };
        let count = late_ms.len() as i64;
        let mut timeline = PulseTimeline::default();
        let mut positions = Vec::new();
        // The worker prints each packet's clock record just before its PCM.
        for (n, late) in late_ms.iter().enumerate() {
            let sample_100ns = n as i64 * 200_000 + late * 10_000;
            let callback_wall_100ns =
                pair.wall_ns as i64 / 100 - (count - n as i64) * 200_000 + late * 10_000;
            let line = format!(
                "VIDEORC_DSHOW_CLOCK version=1 sample_100ns={sample_100ns} graph_100ns={} wall_before_100ns={callback_wall_100ns} wall_after_100ns={callback_wall_100ns} bytes=3840 frames=960 rate=48000 channels=2 bits=16 format=1",
                sample_100ns + 200_000
            );
            let mut anchor = dshow_anchor(&line, &pair)?;
            anchor.stamp_jitter = stamp_jitter;
            clock.push(anchor)?;
            let stamp = (n as i64 * 20 + late) * 48;
            let (position, clock_pts) = if placed {
                timeline.place_delivery_stamped(stamp, 960, DSHOW_DROPOUT_FRAMES)
            } else {
                (stamp, stamp)
            };
            clock.interval_at(
                PcmDescription {
                    sequence: n as u64,
                    pts: position,
                    frames: 960,
                },
                clock_pts,
                pair.monotonic,
            )?;
            positions.push(position);
        }
        Ok(positions)
    }

    #[test]
    fn delivery_stamped_directshow_packets_map_within_their_stamp_jitter() {
        // Field Intel SST microphone, 60 s: the legacy wave filter stamps each
        // buffer from the 1 ms system clock at delivery, 0-4 ms around a
        // constant offset from the sample count, and FFmpeg carries each stamp
        // into the PCM `pts`.
        let field = [3, 0, 4, 1, 3, 0, 2, 4, 1, 0];
        let positions = delivery_stamped_intervals(&field, DSHOW_STAMP_JITTER, true).unwrap();
        assert!(
            positions.windows(2).all(|pair| pair[1] - pair[0] == 960),
            "jitter is not lost or doubled audio: {positions:?}"
        );
        // Taken raw, packet 1 starts 3 ms before packet 0 ends (field retest:
        // "Capture PCM metadata sequence regressed or skipped an interval").
        let raw = delivery_stamped_intervals(&field, DSHOW_STAMP_JITTER, false).unwrap_err();
        assert!(raw.to_string().contains("regressed"), "{raw:#}");
        let exact = delivery_stamped_intervals(&field, Duration::ZERO, true).unwrap_err();
        assert!(
            exact
                .to_string()
                .contains("outside its captured packet clock interval"),
            "{exact:#}"
        );
    }

    #[test]
    fn a_refused_directshow_packet_names_its_failed_check() {
        assert_eq!(
            dshow_invalid_detail(
                "[in#0/dshow @ 0x1] VIDEORC_DSHOW_CLOCK_INVALID reason=wall-bracket sample_100ns=5 graph_100ns=9 wall_bracket_100ns=12000 bytes=3528"
            ),
            " (reason=wall-bracket sample_100ns=5 graph_100ns=9 wall_bracket_100ns=12000 bytes=3528)"
        );
        // A worker from before the reasons existed still stops cleanly.
        assert_eq!(dshow_invalid_detail("VIDEORC_DSHOW_CLOCK_INVALID"), "");
        let long = format!(
            "VIDEORC_DSHOW_CLOCK_INVALID reason=\u{7}{}",
            "x".repeat(400)
        );
        let detail = dshow_invalid_detail(&long);
        assert!(detail.len() <= 203 && !detail.contains('\u{7}'), "{detail}");
    }

    #[test]
    fn delivery_stamped_directshow_follows_drift_and_counts_a_lost_buffer() {
        let jitter = [3, 0, 4, 1, 3, 0, 2, 4, 1, 0];
        // 1 ms of drift per second (far beyond a sound card's) for 20 s.
        let drift: Vec<i64> = (0..1000)
            .map(|n| n / 50 + jitter[n as usize % 10])
            .collect();
        delivery_stamped_intervals(&drift, DSHOW_STAMP_JITTER, true).unwrap();
        // A lost 20 ms buffer moves every later stamp: the gap goes into the
        // count instead of failing the session.
        let lost: Vec<i64> = (0..40)
            .map(|n| jitter[n % 10] + if n >= 20 { 20 } else { 0 })
            .collect();
        let positions = delivery_stamped_intervals(&lost, DSHOW_STAMP_JITTER, true).unwrap();
        let steps: Vec<i64> = positions.windows(2).map(|pair| pair[1] - pair[0]).collect();
        assert_eq!(steps.iter().filter(|step| **step != 960).count(), 1);
        // On the buffer after the first late one: that one confirms the loss.
        assert!(steps[20] >= 960 + DSHOW_DROPOUT_FRAMES, "{steps:?}");
    }

    #[test]
    fn delivery_stamped_directshow_counts_through_a_stall_burst() {
        // Field (idle session after a take, MP4 finalization load): the
        // capture thread stalled 40 ms, then handed over the three buffers
        // the driver held a millisecond apart. Against each buffer's own
        // slot the stamps run +43, +24, +5, then on time again. The audio
        // was never lost: the count stays contiguous, and the burst's PCM
        // (its smoothed clock up to the stall past the last pre-stall
        // anchor) still maps. Before: a 40 ms silence gap, every later
        // sample 40 ms late, and the worker stopped on the burst's third
        // buffer ("PCM lies outside its captured packet clock interval").
        let jitter = [3, 0, 4, 1, 3, 0, 2, 4, 1, 0];
        let burst: Vec<i64> = (0..30)
            .map(|n| {
                jitter[n % 10]
                    + match n {
                        10 => 40,
                        11 => 24,
                        12 => 1,
                        _ => 0,
                    }
            })
            .collect();
        let positions = delivery_stamped_intervals(&burst, DSHOW_STAMP_JITTER, true).unwrap();
        assert!(
            positions.windows(2).all(|pair| pair[1] - pair[0] == 960),
            "a stall is not lost audio: {positions:?}"
        );
    }

    #[test]
    fn a_delivery_stamped_stall_is_lost_audio_only_once_the_next_buffer_confirms_it() {
        let place = |timeline: &mut PulseTimeline, stamp: i64| {
            timeline.place_delivery_stamped(stamp, 960, DSHOW_DROPOUT_FRAMES)
        };
        // 40 ms late, then the held buffers a millisecond apart: counted.
        let mut timeline = PulseTimeline::default();
        place(&mut timeline, 0);
        assert_eq!(place(&mut timeline, 960 + 1_920).0, 960);
        assert_eq!(place(&mut timeline, 960 + 1_920 + 48).0, 1_920);
        assert_eq!(place(&mut timeline, 960 + 1_920 + 96).0, 2_880);
        // 40 ms late twice at the device's cadence: lost, the count jumps
        // once and the clock lands on the confirming stamp.
        let mut timeline = PulseTimeline::default();
        place(&mut timeline, 0);
        assert_eq!(place(&mut timeline, 960 + 1_920).0, 960);
        let (position, captured) = place(&mut timeline, 1_920 + 1_920);
        assert_eq!(captured, 1_920 + 1_920);
        assert!(
            position <= 1_920 + 1_920 && position >= 1_920 + 1_920 - 2 * PULSE_SLEW_FRAMES,
            "{position}"
        );
        assert_eq!(place(&mut timeline, 2_880 + 1_920).0, position + 960);
    }

    #[test]
    fn a_directshow_packet_over_one_second_is_still_refused() {
        let pair = ClockPair::sample().unwrap();
        assert!(
            dshow_anchor(
                &dshow_clock_line(&pair, 0, 48_000, Duration::from_secs(1)),
                &pair
            )
            .is_ok()
        );
        assert!(
            dshow_anchor(
                &dshow_clock_line(&pair, 0, 48_001, Duration::from_secs(1)),
                &pair
            )
            .is_err()
        );
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
        let command = capture_command("ffmpeg", "6465736b", CaptureProtocol::AvFoundation);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-i", "none:none"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-videorc_audio_uid", "6465736b"])
        );
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
    fn pulse_command_opens_the_source_with_wall_clock_timestamps() {
        // Release test 147, plan 0001: a Linux microphone joins the session
        // bus through this worker instead of FFmpeg's direct output input.
        let command = capture_command(
            "ffmpeg",
            "alsa_input.pci-0000_02_00.3.HiFi__Mic__source",
            CaptureProtocol::Pulse,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|pair| pair == ["-f", "pulse"]));
        assert!(args.windows(2).any(|pair| pair == ["-wallclock", "1"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-fragment_size", "1920"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-i", "alsa_input.pci-0000_02_00.3.HiFi__Mic__source"])
        );
        assert!(args.contains(&"-copyts".into()));
        assert!(!args.iter().any(|arg| arg.contains("videorc_audio")));
        assert_eq!(args.last().unwrap(), "pipe:1");
        // Retest 154 (C4): pinned to the chosen source, never the default.
        let pulse_prop = command
            .get_envs()
            .find(|(key, _)| *key == "PULSE_PROP")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned());
        assert_eq!(
            pulse_prop.as_deref(),
            Some("node.dont-fallback=true node.dont-move=true")
        );
    }

    #[test]
    fn non_pulse_capture_commands_carry_no_pulse_stream_properties() {
        for protocol in [CaptureProtocol::AvFoundation, CaptureProtocol::DirectShow] {
            let command = capture_command("ffmpeg", "6465736b", protocol);
            assert!(!command.get_envs().any(|(key, _)| key == "PULSE_PROP"));
        }
    }

    #[test]
    fn an_unplugged_pulse_source_is_refused_as_not_in_inventory() {
        // Retest 154 (C4): the session then records silence instead of the
        // direct Pulse input, which would also open nothing else now.
        let listed = crate::linux_pulse_audio::parse_pulse_sources(
            "Auto-detected sources for pulse:\n* alsa_input.builtin [Internal Microphone] (none)\n  usb_mic [USB Mic] (none)\n",
        );
        assert!(ensure_pulse_source_present(Some(&listed), "usb_mic").is_ok());
        let error = ensure_pulse_source_present(Some(&listed[..1]), "usb_mic").unwrap_err();
        assert_eq!(
            worker_start_failure_kind(&error),
            Some(WorkerStartFailureKind::DeviceNotInInventory)
        );
        assert!(error.to_string().contains("\"usb_mic\" is not connected"));
        // An unreadable listing says nothing about the device: it still opens.
        assert!(ensure_pulse_source_present(None, "usb_mic").is_ok());
    }

    #[test]
    fn a_pulse_record_anchors_its_counted_position_at_its_own_stamp() {
        let now = Instant::now();
        // The pair maps wall 1.000 s to `now`; a packet stamped 20 ms earlier
        // (1/48000 s) started 20 ms before `now`, whatever position it got.
        let anchor = pulse_anchor(47_000, 47_040, 480, &pair(now)).unwrap();
        assert_eq!(anchor.pts_us, 979_166);
        assert_eq!(anchor.captured_start, now - Duration::from_millis(20));
        assert_eq!(anchor.input_duration, Some(Duration::from_millis(10)));
        assert_eq!(anchor.uncertainty, PULSE_CLOCK_UNCERTAINTY);
    }

    #[test]
    fn a_pulse_stamp_never_puts_its_packet_past_its_arrival() {
        // The pair maps wall 1.000 s to `now`: a 10 ms packet arriving then
        // can start no later than 0.990 s.
        let now = Instant::now();
        assert_eq!(latest_pulse_stamp(&pair(now), now, 480), 47_520);
        assert_eq!(
            latest_pulse_stamp(&pair(now), now + Duration::from_millis(5), 480),
            47_760
        );
        // Retest 151: after an overrun the demuxer stamped packets ~17 ms past
        // their arrival for a while (ends 27.4 ms past it, beyond the 20 ms
        // `PULSE_CLOCK_UNCERTAINTY`). Clamped, the capture clock follows the
        // arrivals instead: no packet ends after it arrived, so `CaptureClock`
        // keeps the worker (and the microphone) running.
        let future = 835_i64;
        assert!(
            Duration::from_secs_f64((future + 480) as f64 / 48_000.0) > PULSE_CLOCK_UNCERTAINTY
        );
        let mut timeline = PulseTimeline::default();
        let mut worst_end_past_arrival = i64::MIN;
        for index in 0..200_i64 {
            let arrival = 100_000 + index * 480;
            let stamp = arrival + future;
            let (position, captured) =
                timeline.place(stamp.min(latest_pulse_stamp_at(arrival, 480)), 480);
            assert_eq!(position, 100_000 - 480 + index * 480);
            worst_end_past_arrival = worst_end_past_arrival.max(captured + 480 - arrival);
        }
        assert!(worst_end_past_arrival <= 0, "{worst_end_past_arrival}");
        // On-time stamps are untouched.
        assert_eq!(47_000_i64.min(latest_pulse_stamp_at(47_520, 480)), 47_000);
    }

    #[test]
    fn pulse_samples_count_through_stamp_jitter_and_jump_only_on_a_dropout() {
        // Release test 147: on ogre the second packet was stamped 85 samples
        // before the first one ended and the worker stopped as "regressed".
        let mut timeline = PulseTimeline::default();
        assert_eq!(timeline.place(1_000, 480), (1_000, 1_000));
        let (position, captured) = timeline.place(1_395, 480);
        assert_eq!(position, 1_480);
        assert_eq!(
            captured,
            1_480 - 48,
            "the clock slews toward the early stamp"
        );
        let (position, captured) = timeline.place(1_987, 480);
        assert_eq!(position, 1_960);
        assert!(captured > 1_480 - 48 + 480 - 48 && captured <= 1_987);
        // Over 20 ms past the count: audio was lost, both jump.
        let mut timeline = PulseTimeline::default();
        timeline.place(0, 480);
        assert_eq!(timeline.place(480 + 961, 480), (1_441, 1_441));
    }

    #[test]
    fn pulse_capture_clock_stays_continuous_through_stalls_and_follows_drift() {
        // Under encode load the stamps jumped by more than 10 ms and the
        // worker stopped as "discontinuous". Adjacent capture instants must
        // stay within 1 ms of the 10 ms the samples say, and increasing.
        let mut timeline = PulseTimeline::default();
        let mut previous: Option<i64> = None;
        let mut stamp = 0_i64;
        for packet in 0..2_000_i64 {
            // A sound card 200 ppm slow against the wall clock, plus a
            // 15 ms stall every 100 packets that the next ones catch up.
            stamp += 480 + 480 * 200 / 1_000_000 + 1;
            let late = if packet % 100 == 50 { 720 } else { 0 };
            let (_, captured) = timeline.place(stamp + late, 480);
            if let Some(previous) = previous {
                let delta = captured - previous;
                assert!(delta > 0, "packet {packet}: the clock regressed");
                assert!(
                    (delta - 480).abs() <= PULSE_SLEW_FRAMES,
                    "packet {packet}: {delta}"
                );
            }
            previous = Some(captured);
        }
        // Drift is followed: the clock ends within a millisecond of the stamps.
        assert!((stamp - previous.unwrap()).abs() <= PULSE_SLEW_FRAMES);
    }

    #[test]
    fn pulse_pcm_assembles_from_its_own_timestamps_and_avf_refuses_it() {
        let clock = ClockPair::sample().unwrap();
        let wall_us = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;
        // Three 10 ms packets from 50 ms ago, stamped with the jitter seen on
        // ogre: the second 85 samples early, the third 27 samples late.
        let first_pts = i64::try_from(i128::from(wall_us - 50_000) * 48_000 / 1_000_000).unwrap();
        let records = vec![
            pcm(0, first_pts, 480),
            pcm(1, first_pts + 480 - 85, 480),
            pcm(2, first_pts + 960 + 27, 480),
        ];
        let bytes: Vec<u8> = (0..2880).flat_map(|_| 0.25f32.to_le_bytes()).collect();
        let run = |protocol: CaptureProtocol, pair: ClockPair| {
            let (meta_tx, meta_rx) = mpsc::channel();
            for record in &records {
                meta_tx.send(record.clone()).unwrap();
            }
            drop(meta_tx);
            let (raw_tx, raw_rx) = mpsc::channel();
            raw_tx.send(bytes.clone()).unwrap();
            drop(raw_tx);
            let (out_tx, out_rx) = mpsc::sync_channel(4);
            let stats = Arc::new(AudioCaptureStats::default());
            let result = assemble_pcm(
                protocol,
                pair,
                meta_rx,
                raw_rx,
                out_tx,
                &AtomicBool::new(false),
                &stats,
            );
            (result, out_rx.try_iter().collect::<Vec<_>>())
        };
        let (result, frames) = run(CaptureProtocol::Pulse, clock);
        assert!(
            result.as_ref().map_or_else(
                |error| error.to_string().contains("stopped producing"),
                |_| true
            ),
            "{result:?}"
        );
        assert_eq!(frames.len(), 3);
        // Counted contiguously through the jitter.
        assert_eq!(frames[0].timestamp_micros, 0);
        assert_eq!(frames[1].timestamp_micros, 10_000);
        assert_eq!(frames[2].timestamp_micros, 20_000);
        // Each packet keeps its own measured capture instant.
        assert!(frames[1].captured_at < frames[2].captured_at);
        assert_eq!(frames[0].samples, vec![0.25; 960]);
        // A protocol that expects separate clock records has no anchor here.
        let (result, frames) = run(CaptureProtocol::AvFoundation, ClockPair::sample().unwrap());
        assert!(result.unwrap_err().to_string().contains("anchor"));
        assert!(frames.is_empty());
    }

    #[test]
    fn pulse_pcm_may_trail_its_record_within_the_pulse_age_budget() {
        // Exercise the production byte matcher with the actual protocol budgets.
        // A real sleep also aged the capture timestamp and could correctly drop
        // the packet on a loaded CI runner, obscuring this matching contract.
        let late = Duration::from_millis(130);
        let bytes: Vec<u8> = (0..960).flat_map(|_| 0.25f32.to_le_bytes()).collect();
        for protocol in [
            CaptureProtocol::Pulse,
            CaptureProtocol::AvFoundation,
            CaptureProtocol::DirectShow,
        ] {
            let now = std::cell::Cell::new(Instant::now());
            let arrival = now.get() + late;
            let mut queued = VecDeque::new();
            let result = match_pcm_bytes(
                &mut queued,
                bytes.len(),
                max_capture_age(protocol),
                &AtomicBool::new(false),
                |wait| {
                    now.set(now.get() + wait);
                    if now.get() >= arrival {
                        Ok(bytes.clone())
                    } else {
                        Err(mpsc::RecvTimeoutError::Timeout)
                    }
                },
                || now.get(),
            );
            if protocol == CaptureProtocol::Pulse {
                assert!(result.unwrap());
                assert_eq!(queued, bytes);
                assert_eq!(now.get(), arrival);
            } else {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("did not match its timestamp metadata within 100ms")
                );
                assert!(queued.is_empty());
            }
        }
    }

    #[test]
    fn pcm_match_still_expires_at_each_protocol_budget() {
        for protocol in [
            CaptureProtocol::Pulse,
            CaptureProtocol::AvFoundation,
            CaptureProtocol::DirectShow,
        ] {
            let start = Instant::now();
            let now = std::cell::Cell::new(start);
            let budget = max_capture_age(protocol);
            let mut queued = VecDeque::from([1]);
            let result = match_pcm_bytes(
                &mut queued,
                2,
                budget,
                &AtomicBool::new(false),
                |wait| {
                    now.set(now.get() + wait);
                    Err(mpsc::RecvTimeoutError::Timeout)
                },
                || now.get(),
            );
            assert_eq!(
                result.unwrap_err().to_string(),
                format!(
                    "Capture PCM did not match its timestamp metadata within {}ms",
                    budget.as_millis()
                )
            );
            assert_eq!(now.get() - start, budget);
            assert_eq!(queued, [1]);
        }
    }

    #[test]
    fn pcm_match_cancellation_stops_receiving() {
        let now = Instant::now();
        let stop = AtomicBool::new(false);
        let mut reads = 0;
        let mut queued = VecDeque::new();
        let matched = match_pcm_bytes(
            &mut queued,
            8,
            PULSE_MAX_CAPTURE_AGE,
            &stop,
            |_| {
                reads += 1;
                stop.store(true, Ordering::Release);
                Ok(vec![1, 2, 3, 4])
            },
            || now,
        )
        .unwrap();
        assert!(!matched);
        assert_eq!(reads, 1);
        assert_eq!(queued, [1, 2, 3, 4]);
    }

    #[test]
    fn pcm_match_rejects_disconnected_partial_packets() {
        let now = Instant::now();
        let mut queued = VecDeque::from([1, 2]);
        let result = match_pcm_bytes(
            &mut queued,
            8,
            PULSE_MAX_CAPTURE_AGE,
            &AtomicBool::new(false),
            |_| Err(mpsc::RecvTimeoutError::Disconnected),
            || now,
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "Capture PCM ended in a partial timestamped packet"
        );
        assert_eq!(queued, [1, 2]);
    }

    #[test]
    fn pcm_match_keeps_bytes_for_the_next_packet() {
        let now = Instant::now();
        let mut queued = VecDeque::from([1, 2]);
        assert!(
            match_pcm_bytes(
                &mut queued,
                4,
                PULSE_MAX_CAPTURE_AGE,
                &AtomicBool::new(false),
                |_| Ok(vec![3, 4, 5, 6]),
                || now,
            )
            .unwrap()
        );
        assert_eq!(queued.drain(..4).collect::<Vec<_>>(), [1, 2, 3, 4]);
        assert!(
            match_pcm_bytes(
                &mut queued,
                2,
                PULSE_MAX_CAPTURE_AGE,
                &AtomicBool::new(false),
                |_| panic!("already buffered PCM must not wait for another read"),
                || now,
            )
            .unwrap()
        );
        assert_eq!(queued, [5, 6]);
    }

    /// On-device check (release test 147, plan 0001): opens the real Pulse
    /// worker on `VIDEORC_PULSE_TEST_SOURCE` with `VIDEORC_PULSE_TEST_FFMPEG`
    /// and requires ~8 s of continuous, finite PCM without the worker
    /// stopping. A loaded-host false wall-clock stop needs a longer run
    /// (1080p encode + `stress-ng --cpu` on the same cores).
    /// `cargo test … pulse_worker_keeps_delivering -- --ignored`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a PulseAudio/PipeWire source and the bundled FFmpeg"]
    fn pulse_worker_keeps_delivering_from_a_real_source() {
        let source = std::env::var("VIDEORC_PULSE_TEST_SOURCE").expect("VIDEORC_PULSE_TEST_SOURCE");
        let ffmpeg = std::env::var("VIDEORC_PULSE_TEST_FFMPEG").expect("VIDEORC_PULSE_TEST_FFMPEG");
        let id = crate::linux_pulse_audio::linux_pulse_microphone_id(&source);
        let input = open(&ffmpeg, &id).unwrap();
        let started = Instant::now();
        let mut frames = 0_usize;
        let mut last_micros = None;
        while started.elapsed() < Duration::from_secs(8) {
            match input.receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(frame) => {
                    assert!(frame.samples.iter().all(|sample| sample.is_finite()));
                    if let Some(last) = last_micros {
                        assert!(frame.timestamp_micros > last, "timestamps regressed");
                    }
                    last_micros = Some(frame.timestamp_micros);
                    frames += frame.samples.len() / 2;
                }
                Err(error) => panic!(
                    "the worker stopped delivering ({error}): {:?}",
                    input.failure.lock().unwrap()
                ),
            }
        }
        let failure = input.failure.lock().unwrap().clone();
        assert!(failure.is_none(), "{failure:?}");
        assert!(frames >= 48_000 * 7, "only {frames} frames in 8 s");
        eprintln!(
            "pulse worker: {frames} frames in {:?}, last timestamp {:?} us",
            started.elapsed(),
            last_micros
        );
    }

    #[test]
    fn a_pulse_microphone_id_resolves_to_its_source_name_on_linux_only() {
        let id = crate::linux_pulse_audio::linux_pulse_microphone_id("videorc_test_tone");
        // No FFmpeg to list sources with: an unknown listing still resolves.
        let resolved = resolve_target("/nonexistent/videorc-ffmpeg", &id);
        if cfg!(target_os = "linux") {
            let (device, name) = resolved.unwrap();
            assert_eq!(device, "videorc_test_tone");
            assert_eq!(name, "videorc_test_tone");
        } else {
            assert!(resolved.unwrap_err().to_string().contains("require Linux"));
        }
        let hostile = crate::linux_pulse_audio::linux_pulse_microphone_id("-filter_complex");
        if cfg!(target_os = "linux") {
            assert!(resolve_target("/nonexistent/videorc-ffmpeg", &hostile).is_err());
        }
    }

    #[test]
    fn capture_metadata_refuses_stats_substrings_and_keeps_interleaved_log_records() {
        let now = Instant::now();
        let with_stats = format!("size=0 bitrate=N/A rate=48000 {}", metadata());
        assert!(avf_anchor(&with_stats, &pair(now)).is_ok());
        let clock_line = format!("size=0 bitrate=N/A {}", metadata());
        assert!(avf_anchor(&clock_line, &pair(now)).is_ok());
        let audio = pcm(0, 0, 480);
        for combined in [
            format!("{audio} {}", metadata()),
            format!("{} {audio}", metadata()),
        ] {
            let records = metadata_records(&combined);
            assert_eq!(records.len(), 2);
            let clock = records
                .iter()
                .find(|line| line.contains("VIDEORC_AVF_CLOCK"))
                .unwrap();
            let pcm = records
                .iter()
                .find(|line| line.starts_with("ashowinfo"))
                .unwrap();
            assert!(avf_anchor(clock, &pair(now)).is_ok());
            assert_eq!(parse_pcm_description(pcm).unwrap().frames, 480);
        }
        let malformed = metadata().replace("rate=48000", "rate=oops");
        let error = avf_anchor(&malformed, &pair(now)).unwrap_err().to_string();
        assert!(error.contains("rate="));
        assert!(error.contains("oops"));
        assert!(metadata_records("bitrate=N/A progress=continue").is_empty());
    }

    fn dshow_metadata() -> String {
        "VIDEORC_DSHOW_CLOCK version=1 sample_100ns=100000 graph_100ns=200000 wall_before_100ns=9900000 wall_after_100ns=9900100 bytes=1920 frames=480 rate=48000 channels=2 bits=16 format=1".into()
    }

    #[test]
    fn dshow_mapping_uses_capture_bracket_not_log_delivery_and_rejects_clock_errors() {
        let now = Instant::now();
        let mapping = pair(now);
        let anchor = dshow_anchor(&dshow_metadata(), &mapping).unwrap();
        // The packet starts10ms before callback; callback UTC is~10ms before
        // backend paired sample. No stderr-arrival argument enters this mapping.
        assert_eq!(
            now.duration_since(anchor.captured_start),
            Duration::from_micros(19_995)
        );
        for bad in [
            dshow_metadata().replace("wall_after_100ns=9900100", "wall_after_100ns=9899999"),
            dshow_metadata().replace("wall_after_100ns=9900100", "wall_after_100ns=9920000"),
            dshow_metadata().replace("graph_100ns=200000", "graph_100ns=1"),
            dshow_metadata().replace("frames=480", "frames=481"),
            dshow_metadata().replace("format=1", "format=6"),
            dshow_metadata().replace("bits=16", "bits=12"),
            dshow_metadata().replace("sample_100ns=100000", "sample_100ns=-1"),
        ] {
            assert!(dshow_anchor(&bad, &mapping).is_err());
        }
        assert_eq!(
            classify_wall_offset(wall_offset_ns(&mapping, now, 1_000_000_000)),
            WallOffsetKind::Steady
        );
        assert_eq!(
            classify_wall_offset(wall_offset_ns(&mapping, now, 2_000_000_000)),
            WallOffsetKind::Step
        );
        let uncertain = ClockPair {
            uncertainty: Duration::from_millis(3),
            ..mapping
        };
        assert!(dshow_anchor(&dshow_metadata(), &uncertain).is_err());
    }

    #[test]
    fn a_six_millisecond_preemption_gap_is_not_a_wall_clock_change() {
        let now = Instant::now();
        let pair = pair(now);
        // The two monotonic reads are 6 ms apart: skip, never treat as a step.
        assert!(bracket_wall_sample(now, pair.wall_ns, now + Duration::from_millis(6)).is_none());
        let tight =
            bracket_wall_sample(now, pair.wall_ns, now + Duration::from_micros(400)).unwrap();
        assert_eq!(
            classify_wall_offset(wall_offset_ns(&pair, tight.0, tight.1)),
            WallOffsetKind::Steady
        );
    }

    #[test]
    fn a_persistent_thirty_millisecond_step_reanchors_and_slew_never_does() {
        let now = Instant::now();
        let pair = pair(now);
        let mut watch = WallStepWatch::default();
        let drift = classify_wall_offset(30_000_000);
        assert_eq!(drift, WallOffsetKind::Drift);
        assert!(!watch.observe(drift));
        assert!(!watch.observe(drift));
        assert!(
            watch.observe(drift),
            "three consecutive 30 ms drifts confirm a step"
        );

        let mut once = WallStepWatch::default();
        assert!(once.observe(classify_wall_offset(50_000_001)));

        let mut slew = WallStepWatch::default();
        // ±2.5 ms of NTP slew for 10 minutes at 1 Hz never confirms.
        for index in 0..(10 * 60) {
            let sign = if index % 2 == 0 { 1 } else { -1 };
            let kind = classify_wall_offset(sign * 2_500_000);
            assert_eq!(kind, WallOffsetKind::Steady);
            assert!(!slew.observe(kind));
        }
        // A 6 ms preemption-sized offset is a single drift, not a stop.
        assert_eq!(classify_wall_offset(6_000_000), WallOffsetKind::Drift);
        let mut one = WallStepWatch::default();
        assert!(!one.observe(WallOffsetKind::Drift));
        assert_eq!(
            wall_offset_ns(&pair, now, pair.wall_ns + 6_000_000).unsigned_abs(),
            6_000_000
        );
    }

    #[test]
    fn dshow_video_identity_uses_only_unique_video_monikers() {
        let inventory = r#"[dshow] "Studio" (audio)
[dshow] Alternative name "@device_audio"
[dshow] "Studio" (video)
[dshow] Alternative name "@device_video"
[dshow] "Other" (video)
[dshow] Alternative name "@device_other""#;
        assert_eq!(
            resolve_dshow_video_name(inventory, "Studio").unwrap(),
            "@device_video"
        );
        assert_eq!(
            resolve_dshow_name(inventory, "Studio").unwrap(),
            "@device_audio"
        );
        assert!(
            resolve_dshow_video_name(
                &format!("{inventory}\n[dshow] \"Studio\" (video)"),
                "Studio"
            )
            .is_err()
        );
        assert!(
            resolve_dshow_video_name(
                "[dshow] \"Camera:audio=Other\" (video)",
                "Camera:audio=Other"
            )
            .is_err()
        );
    }

    #[test]
    fn dshow_identity_is_resolved_in_actual_audio_inventory_and_never_by_arbitrary_name() {
        let inventory = "[dshow] \"Camera\" (video)\n[dshow] Alternative name \"@video\"\n[dshow] \"Microphone\" (audio)\n[dshow] Alternative name \"@audio-1\"\n";
        assert_eq!(
            resolve_dshow_name(inventory, "Microphone").unwrap(),
            "@audio-1"
        );
        assert!(resolve_dshow_name(inventory, "Camera").is_err());
        assert!(resolve_dshow_name(inventory, "Missing").is_err());
        // Plan 065: a device absent from the inventory is the one failure a
        // direct DirectShow input cannot recover from, so it is typed.
        assert_eq!(
            worker_start_failure_kind(&resolve_dshow_name(inventory, "Missing").unwrap_err()),
            Some(WorkerStartFailureKind::DeviceNotInInventory)
        );
        let duplicate = format!(
            "{inventory}[dshow] \"Microphone\" (audio)\n[dshow] Alternative name \"@audio-2\"\n"
        );
        assert!(resolve_dshow_name(&duplicate, "Microphone").is_err());
        let aliased = format!(
            "{inventory}[dshow] \"Other\" (audio)\n[dshow] Alternative name \"@audio-1\"\n"
        );
        assert!(resolve_dshow_name(&aliased, "Microphone").is_err());
        for target in [
            "@audio:video=Camera",
            "Microphone=Other",
            "Microphone:Other",
        ] {
            let injected =
                format!("[dshow] \"Microphone\" (audio)\n[dshow] Alternative name \"{target}\"\n");
            let error = resolve_dshow_name(&injected, "Microphone").unwrap_err();
            // The friendly name is present; only its moniker is unusable, so
            // the direct `audio=<name>` input can still open it.
            assert_eq!(worker_start_failure_kind(&error), None);
        }
        assert!(
            resolve_target("must-not-spawn", "microphone:avfoundation:1")
                .unwrap_err()
                .to_string()
                .contains("unbound device index")
        );
    }

    #[test]
    fn the_dshow_inventory_is_enumerated_once_and_refreshed_only_when_it_must_be() {
        use std::cell::Cell;
        let cache: DshowInventoryCache = Mutex::new(None);
        let worker = std::path::Path::new("ffmpeg-capture.exe");
        let first = "[dshow] \"Mic\" (audio)\n[dshow] Alternative name \"@mic\"\n";
        let refreshes = Cell::new(0);
        let fetch = |text: &'static str| {
            let refreshes = &refreshes;
            move || {
                refreshes.set(refreshes.get() + 1);
                Ok(text.to_string())
            }
        };
        let now = Instant::now();
        let resolve =
            |name: &'static str| move |inventory: &str| resolve_dshow_name(inventory, name);

        assert_eq!(
            resolve_with_inventory_cache(&cache, worker, now, resolve("Mic"), fetch(first))
                .unwrap(),
            "@mic"
        );
        assert_eq!(refreshes.get(), 1);
        // A second session start costs no child process.
        assert_eq!(
            resolve_with_inventory_cache(&cache, worker, now, resolve("Mic"), fetch(first))
                .unwrap(),
            "@mic"
        );
        assert_eq!(refreshes.get(), 1);

        // A microphone connected after the last enumeration triggers exactly
        // one refresh, and the refreshed inventory is kept.
        let with_usb = "[dshow] \"Mic\" (audio)\n[dshow] Alternative name \"@mic\"\n[dshow] \"USB\" (audio)\n[dshow] Alternative name \"@usb\"\n";
        assert_eq!(
            resolve_with_inventory_cache(&cache, worker, now, resolve("USB"), fetch(with_usb))
                .unwrap(),
            "@usb"
        );
        assert_eq!(refreshes.get(), 2);
        assert_eq!(
            resolve_with_inventory_cache(&cache, worker, now, resolve("USB"), fetch(with_usb))
                .unwrap(),
            "@usb"
        );
        assert_eq!(refreshes.get(), 2);

        // Still missing after the refresh: typed, so the session records silence.
        let missing =
            resolve_with_inventory_cache(&cache, worker, now, resolve("Gone"), fetch(with_usb))
                .unwrap_err();
        assert_eq!(
            worker_start_failure_kind(&missing),
            Some(WorkerStartFailureKind::DeviceNotInInventory)
        );
        assert_eq!(refreshes.get(), 3);

        // A stale entry or another worker binary is never trusted.
        let later = now + DSHOW_INVENTORY_TTL + Duration::from_secs(1);
        resolve_with_inventory_cache(&cache, worker, later, resolve("Mic"), fetch(first)).unwrap();
        assert_eq!(refreshes.get(), 4);
        resolve_with_inventory_cache(
            &cache,
            std::path::Path::new("other-capture.exe"),
            Instant::now(),
            resolve("Mic"),
            fetch(first),
        )
        .unwrap();
        assert_eq!(refreshes.get(), 5);

        // A failed refresh surfaces its typed error and keeps the old entry.
        let timed_out =
            resolve_with_inventory_cache(&cache, worker, Instant::now(), resolve("Nope"), || {
                Err(probe_error(
                    "device inventory",
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "slow"),
                ))
            })
            .unwrap_err();
        assert_eq!(
            worker_start_failure_kind(&timed_out),
            Some(WorkerStartFailureKind::ProbeTimedOut)
        );
        assert!(cache.lock().unwrap().is_some());
    }

    #[test]
    fn discovery_warms_the_inventory_only_when_the_microphone_set_changed() {
        let cache: DshowInventoryCache = Mutex::new(None);
        let worker = std::path::Path::new("ffmpeg-capture.exe");
        let now = Instant::now();
        let names = |list: &[&str]| {
            list.iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>()
        };
        let inventory = || Ok("[dshow] \"A\" (audio)\n".to_string());
        assert!(warm_inventory_cache(&cache, worker, names(&["B", "A"]), now, inventory).unwrap());
        // Same set in another order: nothing to do.
        assert!(!warm_inventory_cache(&cache, worker, names(&["A", "B"]), now, inventory).unwrap());
        // A device came or went: enumerate again.
        assert!(warm_inventory_cache(&cache, worker, names(&["A"]), now, inventory).unwrap());
        // A session-start refresh leaves the set unknown, so the next
        // discovery re-warms once rather than trusting it.
        resolve_with_inventory_cache(
            &cache,
            worker,
            now + DSHOW_INVENTORY_TTL,
            |text| resolve_dshow_name(text, "A"),
            inventory,
        )
        .unwrap();
        assert!(warm_inventory_cache(&cache, worker, names(&["A"]), now, inventory).unwrap());
    }

    #[test]
    fn probe_failures_are_typed_so_a_session_can_fall_back() {
        let timed_out = probe_error(
            "device inventory",
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Owned child exceeded its 2000ms deadline.",
            ),
        );
        assert_eq!(
            worker_start_failure_kind(&timed_out),
            Some(WorkerStartFailureKind::ProbeTimedOut)
        );
        assert!(
            timed_out
                .to_string()
                .contains("device inventory probe timed out")
        );
        let spawn_failed = probe_error(
            "protocol",
            std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
        );
        assert_eq!(worker_start_failure_kind(&spawn_failed), None);
        // The typed kind survives the context layers session_audio adds.
        let wrapped = anyhow::Error::from(timed_out).context("Microphone opening failed");
        assert_eq!(
            worker_start_failure_kind(&wrapped),
            Some(WorkerStartFailureKind::ProbeTimedOut)
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
