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
const MAX_CAPTURE_AGE: Duration = Duration::from_millis(100);

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
    uncertainty: Duration,
}

struct ClockPair {
    monotonic: Instant,
    host_ns: Option<u64>,
    wall_ns: i128,
    uncertainty: Duration,
}
impl ClockPair {
    fn validate_wall(&self, now: Instant, wall: SystemTime) -> Result<()> {
        let actual = wall.duration_since(UNIX_EPOCH)?.as_nanos() as i128;
        let expected =
            self.wall_ns + now.saturating_duration_since(self.monotonic).as_nanos() as i128;
        if (actual - expected).unsigned_abs() > 5_000_000 {
            bail!("The capture wall clock changed; select the microphone again");
        }
        Ok(())
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
    if sample < 0
        || graph < sample
        || graph - sample > 1_000_000
        || before <= 0
        || after < before
        || after - before > 10_000
        || !(8000..=384000).contains(&rate)
        || !(1..=32).contains(&channels)
        || frames <= 0
        || frames > rate / 10
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
        uncertainty,
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

fn capture_command(ffmpeg: &str, device: &str, dshow: bool) -> Command {
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
    if dshow {
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
    bail!("This microphone capture adapter does not recognize the device identity")
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

fn fail(failure: &Failure, message: impl Into<String>) {
    let mut slot = failure.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_none() {
        let message = message.into();
        tracing::warn!(reason = %message, "Capture worker stopped");
        *slot = Some(message);
    }
}

pub(crate) fn open(ffmpeg: &str, device_id: &str) -> Result<CapturedInput> {
    let dshow = crate::audio::parse_windows_dshow_microphone_id(device_id).is_some();
    let worker = if dshow {
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
    let child = spawn_owned_std(&mut capture_command(&worker, &device, dshow))?;
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
                        if *byte == b'\n' || *byte == b'\r' {
                            let text = String::from_utf8_lossy(&line).into_owned();
                            line.clear();
                            for record in metadata_records(&text) {
                                if metadata_tx.try_send(record).is_err() {
                                    fail(
                                        &read_failure,
                                        "Capture timestamp metadata exceeded its bounded queue",
                                    );
                                    return;
                                }
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
    let mut diagnostics = CaptureDiagnostics::default();
    let mut last_diagnostic = Instant::now();
    while !stop.load(Ordering::Acquire) {
        let line = match metadata.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("The capture worker stopped producing timestamped PCM")
            }
        };
        if line.contains("VIDEORC_DSHOW_CLOCK_INVALID") {
            bail!("DirectShow could not map the selected device capture clock");
        }
        if line.contains("VIDEORC_DSHOW_CLOCK version=") {
            clock_pair.validate_wall(Instant::now(), SystemTime::now())?;
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
        diagnostics.pcm(packet, clock.last_end_pts);
        let (timestamp_micros, captured_at) = clock.interval(packet, Instant::now())?;
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
    fn interval_diagnostics_distinguish_native_overwrite_and_pcm_gaps() {
        let now = Instant::now();
        let mut diagnostics = CaptureDiagnostics::default();
        for (pts, overwritten) in [(0, 0), (10_667, 0), (32_000, 1)] {
            let anchor = CaptureAnchor {
                pts_us: pts,
                captured_start: now,
                input_duration: Some(Duration::from_secs_f64(512.0 / 48_000.0)),
                uncertainty: Duration::ZERO,
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
                    input_duration: None,
                    uncertainty: Duration::ZERO,
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
        let command = capture_command("ffmpeg", "6465736b", false);
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
        assert!(
            mapping
                .validate_wall(now, UNIX_EPOCH + Duration::from_secs(1))
                .is_ok()
        );
        assert!(
            mapping
                .validate_wall(now, UNIX_EPOCH + Duration::from_secs(2))
                .is_err()
        );
        let uncertain = ClockPair {
            uncertainty: Duration::from_millis(3),
            ..mapping
        };
        assert!(dshow_anchor(&dshow_metadata(), &uncertain).is_err());
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
