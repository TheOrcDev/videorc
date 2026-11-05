//! Linux system audio capture through PipeWire (plan 212).
//!
//! [`SystemAudioCapture`] owns one PipeWire capture stream on its own thread
//! and links every playback stream into it, turning each graph cycle into a
//! 48 kHz stereo interleaved f32 [`AudioFrame`] on a bounded channel. It is
//! the Linux twin of the ScreenCaptureKit and WASAPI producers, with the same
//! public API; `system_audio_capture.rs` re-exports it so consumers import one
//! path.
//!
//! Contract for the consumer (identical to macOS):
//! - [`SystemAudioCapture::start`] blocks for up to
//!   [`SYSTEM_AUDIO_START_BUDGET`] (connect, format negotiation, input ports).
//!   Call it from a blocking context, never from an async task directly.
//! - Frames: `timestamp_micros` is the graph cycle's CLOCK_MONOTONIC time
//!   placed on a sample-counted timeline (in µs); `captured_at` is the
//!   `Instant` at the END of the buffer (the convention `SourceClock::new`
//!   reads).
//! - Silence is not loss (decision 11). With no playback stream linked, the
//!   `node.always-process` stream delivers silence or nothing; this producer
//!   has no silence watchdog.
//! - Loss is explicit: [`SystemAudioCapture::failure`] turns `Some` when the
//!   stream errors or disconnects or the PipeWire connection is lost, and the
//!   frame channel then disconnects. A disconnect with no failure means the
//!   capture was stopped on purpose.
//! - [`SystemAudioCapture::stop`] and `Drop` are bounded by
//!   [`SYSTEM_AUDIO_STOP_BUDGET`]; they never block forever.
//!
//! Own-app exclusion (decision 9) is decided per playback stream, before it
//! is linked. A stream whose process is verified (its executable or `comm`
//! matches the binary it reports) is left out when it descends from the
//! Electron main process, whose pid the app passes in
//! `VIDEORC_ELECTRON_MAIN_PID`, and captured when it does not. A stream with
//! no usable pid is left out when it carries the `videorc.app-instance`
//! marker the app sets through `PULSE_PROP`
//! (`apps/desktop/src/main/linux-audio-instance.ts`). A verified foreign
//! process beats a leaked marker. Excluded streams are never linked, so none
//! of their audio reaches the capture.
//!
//! Format: the stream asks for 48 kHz stereo F32LE (FL, FR) and its adapter
//! converts. Playback ports are linked by channel: a mono stream feeds both
//! sides, FL/SL/RL the left, FR/SR/RR the right, FC both; LFE and unnamed
//! channels are dropped.
//!
//! Known limits: playback into null or virtual sinks is captured too;
//! 5.1 sides and rears are summed at full gain; streams in a link group
//! (filter chains, loopbacks) are skipped; a link the user removes is not
//! recreated while the stream lives.
//!
//! [`AudioFrame`]: crate::audio::AudioFrame
//! [`SYSTEM_AUDIO_START_BUDGET`]: crate::system_audio_capture::SYSTEM_AUDIO_START_BUDGET
//! [`SYSTEM_AUDIO_STOP_BUDGET`]: crate::system_audio_capture::SYSTEM_AUDIO_STOP_BUDGET

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::{Duration, Instant};

use crate::system_audio_capture::{
    HostClockAnchor, SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_SAMPLE_RATE, SystemAudioFailure,
    SystemAudioPhase,
};

/// Env var the Electron main process sets to its own pid when it spawns the
/// backend (`apps/desktop/src/main/index.ts`). It roots the exclusion tree.
pub(crate) const ELECTRON_MAIN_PID_ENV: &str = "VIDEORC_ELECTRON_MAIN_PID";

/// The PipeWire property the app marks its own playback with, through
/// `PULSE_PROP` (`apps/desktop/src/main/linux-audio-instance.ts`). Its value
/// is the Electron main pid.
pub(crate) const APP_INSTANCE_PROP: &str = "videorc.app-instance";

/// `media.class` of an application's playback stream.
const PLAYBACK_MEDIA_CLASS: &str = "Stream/Output/Audio";

/// Bound on the parent walk, so a pid cycle (pid reuse mid-walk) ends.
const MAX_ANCESTRY: usize = 64;

/// How long a new playback stream waits for its client's properties before
/// it is judged on its own. Its audio is not linked meanwhile.
const CLIENT_INFO_WAIT: Duration = Duration::from_millis(500);

/// How long the capture thread waits for the stream to connect and expose
/// its input ports. Under `SYSTEM_AUDIO_START_BUDGET` so the thread, not the
/// caller's timeout, names what was missing.
const READY_DEADLINE: Duration = Duration::from_secs(10);

/// Longest the capture thread sleeps in the PipeWire loop between checks of
/// the stop channel and the graph.
const LOOP_WAIT: Duration = Duration::from_millis(50);

/// Bytes per interleaved 32-bit float stereo frame.
const FRAME_BYTES: usize = SYSTEM_AUDIO_CHANNELS as usize * 4;

/// A cycle this far (or four buffers, if longer) from the timeline's
/// prediction is a gap, not jitter.
const MIN_GAP_NANOS: i64 = 100_000_000;

/// The parent pid in a `/proc/<pid>/stat` line. The command name may hold
/// spaces and parentheses, so the fields are read after its last `)`.
fn stat_parent_pid(stat: &str) -> Option<u32> {
    let (_, rest) = stat.rsplit_once(')')?;
    let mut fields = rest.split_whitespace();
    fields.next()?; // state
    fields.next()?.parse().ok()
}

fn proc_parent_pid(pid: u32) -> Option<u32> {
    stat_parent_pid(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// Whether a process sits in the exclusion root's tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PidVerdict {
    /// The root itself or one of its descendants.
    Descends,
    /// Its ancestry reaches init without passing the root.
    Foreign,
    /// The walk could not finish, or the pid is not the process it claims.
    Unverified,
}

fn descends_from(pid: u32, root: u32, parent_of: impl Fn(u32) -> Option<u32>) -> PidVerdict {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current == root {
            return PidVerdict::Descends;
        }
        if current <= 1 {
            return PidVerdict::Foreign;
        }
        match parent_of(current) {
            Some(parent) => current = parent,
            None => return PidVerdict::Unverified,
        }
    }
    PidVerdict::Unverified
}

/// `comm` is the executable's name cut to 15 bytes.
fn comm_matches(comm: &str, binary: &str) -> bool {
    let comm = comm.trim_end_matches('\n');
    let name = binary.rsplit('/').next().unwrap_or(binary);
    let truncated = name.as_bytes().get(..15).unwrap_or(name.as_bytes());
    !comm.is_empty() && comm.as_bytes() == truncated
}

fn exe_name_matches(name: &str, binary: &str) -> bool {
    let name = name.strip_suffix(" (deleted)").unwrap_or(name);
    let binary = binary.rsplit('/').next().unwrap_or(binary);
    !name.is_empty() && name == binary
}

/// Whether `pid` is still the process that reported `binary`, so its pid is
/// not a sandbox's or a reused one. Chromium's child processes run from
/// `/proc/self/exe`, so their `comm` is `exe`; their executable still names
/// the binary libpulse reports.
fn process_is(pid: u32, binary: &str) -> bool {
    if let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe"))
        && let Some(name) = exe.file_name().and_then(|name| name.to_str())
    {
        return exe_name_matches(name, binary);
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .is_ok_and(|comm| comm_matches(&comm, binary))
}

/// Judges a reported process against the root. With a `binary`, the pid must
/// be that process; without one, only a `Descends` verdict means anything.
fn judge_process(pid: u32, binary: Option<&str>, root: u32) -> PidVerdict {
    if binary.is_some_and(|binary| !process_is(pid, binary)) {
        return PidVerdict::Unverified;
    }
    descends_from(pid, root, proc_parent_pid)
}

/// This process's parent, unless it was reparented to a systemd instance
/// (the app that spawned the backend is gone).
pub(crate) fn parent_pid() -> Option<u32> {
    // SAFETY: getppid has no preconditions and cannot fail.
    let parent = u32::try_from(unsafe { libc::getppid() }).ok()?;
    let comm = std::fs::read_to_string(format!("/proc/{parent}/comm")).ok()?;
    (comm.trim() != "systemd").then_some(parent)
}

/// CLOCK_MONOTONIC in nanoseconds, the clock PipeWire stamps graph cycles
/// with.
fn monotonic_nanos() -> u64 {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: a valid out pointer; CLOCK_MONOTONIC always exists on Linux.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    u64::try_from(now.tv_sec)
        .unwrap_or(0)
        .saturating_mul(1_000_000_000)
        .saturating_add(u64::try_from(now.tv_nsec).unwrap_or(0))
}

/// Reads an anchor with the CLOCK_MONOTONIC read bracketed by two
/// `Instant`s, retrying until the bracket is under 50 µs. `Instant` is
/// CLOCK_MONOTONIC on Linux, so the offset is constant and one anchor per
/// stream is enough.
fn sample_anchor() -> HostClockAnchor {
    let mut best: Option<(HostClockAnchor, Duration)> = None;
    for _ in 0..5 {
        let before = Instant::now();
        let host_nanos = monotonic_nanos();
        let after = Instant::now();
        let bracket = after.duration_since(before);
        let anchor = HostClockAnchor {
            host_nanos,
            instant: before + bracket / 2,
        };
        if best.is_none_or(|(_, previous)| bracket < previous) {
            best = Some((anchor, bracket));
        }
        if bracket <= Duration::from_micros(50) {
            break;
        }
    }
    best.expect("at least one anchor sample").0
}

/// Where the exclusion root pid came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ExclusionRootSource {
    /// `VIDEORC_ELECTRON_MAIN_PID`: the Electron main process, whose tree is
    /// all of Videorc.
    ElectronMain,
    /// The backend's parent. In the packaged app that is the Electron main
    /// process; under `pnpm dev` it is cargo, so Videorc's sounds may leak.
    ParentProcess,
    /// Nothing better: only this backend (which plays nothing) is excluded.
    #[default]
    CurrentProcess,
}

/// The process whose tree, and whose marker, the capture leaves out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExclusionRoot {
    pub(crate) process_id: u32,
    pub(crate) source: ExclusionRootSource,
}

/// Pid 1 is init (or a container's), never Videorc.
fn usable_root_pid(pid: u32, current_pid: u32) -> bool {
    pid > 1 && pid != current_pid
}

impl ExclusionRoot {
    /// Picks the exclusion root: the Electron main pid from the env var when
    /// it parses to a usable pid, else the parent pid, else this process.
    pub(crate) fn resolve(
        electron_main_env: Option<&str>,
        parent_pid: Option<u32>,
        current_pid: u32,
    ) -> Self {
        if let Some(pid) = electron_main_env
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|pid| usable_root_pid(*pid, current_pid))
        {
            return Self {
                process_id: pid,
                source: ExclusionRootSource::ElectronMain,
            };
        }
        if let Some(pid) = parent_pid.filter(|pid| usable_root_pid(*pid, current_pid)) {
            return Self {
                process_id: pid,
                source: ExclusionRootSource::ParentProcess,
            };
        }
        Self {
            process_id: current_pid,
            source: ExclusionRootSource::CurrentProcess,
        }
    }

    /// Whether the root is known to be the Electron main process. False means
    /// Videorc's own audio may reach the capture.
    pub(crate) fn names_electron_main(&self) -> bool {
        self.source == ExclusionRootSource::ElectronMain
    }
}

/// A process an object reports for itself.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportedProcess {
    pid: u32,
    binary: Option<String>,
}

/// What a node's or client's properties say about where it came from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ObjectFacts {
    media_class: Option<String>,
    client_id: Option<u32>,
    link_group: Option<String>,
    /// `application.process.id` and `application.process.binary`.
    process: Option<ReportedProcess>,
    /// The [`APP_INSTANCE_PROP`] value.
    marker: Option<String>,
    /// The pid PipeWire read from the client's socket credentials. It only
    /// ever proves a descendant: it is unverified and may name a sandbox or
    /// a proxy.
    sec_pid: Option<u32>,
}

impl ObjectFacts {
    fn from_props<'a>(get: impl Fn(&str) -> Option<&'a str>) -> Self {
        let text = |key: &str| {
            get(key)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let pid = |key: &str| {
            get(key)
                .and_then(|value| value.trim().parse::<u32>().ok())
                .filter(|pid| *pid > 0)
        };
        Self {
            media_class: text("media.class"),
            client_id: get("client.id").and_then(|value| value.trim().parse().ok()),
            link_group: text("node.link-group"),
            process: pid("application.process.id").map(|pid| ReportedProcess {
                pid,
                binary: text("application.process.binary"),
            }),
            marker: text(APP_INSTANCE_PROP),
            sec_pid: pid("pipewire.sec.pid"),
        }
    }

    fn is_playback(&self) -> bool {
        self.media_class.as_deref() == Some(PLAYBACK_MEDIA_CLASS)
    }

    fn marks(&self, root: u32) -> bool {
        self.marker
            .as_deref()
            .and_then(|marker| marker.parse::<u32>().ok())
            == Some(root)
    }
}

/// What is known about a playback stream's client.
#[derive(Debug, Clone, Copy)]
enum ClientView<'a> {
    /// No client, or its properties never came.
    Absent,
    /// Its properties may still come.
    Pending,
    Known(&'a ObjectFacts),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackDecision {
    /// Not an application's playback stream (or one in a link group).
    NotPlayback,
    /// Videorc's own playback: never linked.
    Own,
    /// Not decided yet: its client's properties may still come.
    WaitForClient,
    Capture,
}

/// Decides whether a playback stream is captured. A verified process decides
/// first (the stream's, then its client's); then an unverified socket pid
/// that descends from the root; then the marker.
fn classify_playback(
    stream: &ObjectFacts,
    client: ClientView<'_>,
    root: u32,
    judge: impl Fn(u32, Option<&str>) -> PidVerdict,
) -> PlaybackDecision {
    if !stream.is_playback() || stream.link_group.is_some() {
        return PlaybackDecision::NotPlayback;
    }
    let known = match client {
        ClientView::Known(facts) => Some(facts),
        ClientView::Absent | ClientView::Pending => None,
    };
    for facts in std::iter::once(stream).chain(known) {
        if let Some(ReportedProcess {
            pid,
            binary: Some(binary),
        }) = &facts.process
        {
            match judge(*pid, Some(binary)) {
                PidVerdict::Descends => return PlaybackDecision::Own,
                PidVerdict::Foreign => return PlaybackDecision::Capture,
                PidVerdict::Unverified => {}
            }
        }
    }
    if matches!(client, ClientView::Pending) {
        return PlaybackDecision::WaitForClient;
    }
    if let Some(pid) = known.and_then(|client| client.sec_pid)
        && judge(pid, None) == PidVerdict::Descends
    {
        return PlaybackDecision::Own;
    }
    if stream.marks(root) || known.is_some_and(|client| client.marks(root)) {
        return PlaybackDecision::Own;
    }
    PlaybackDecision::Capture
}

/// The registry properties of one port.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PortFacts {
    node_id: u32,
    output: bool,
    channel: Option<String>,
    /// A DSP audio port (`format.dsp` names audio), not MIDI or video.
    audio: bool,
    monitor: bool,
}

impl PortFacts {
    fn from_props<'a>(get: impl Fn(&str) -> Option<&'a str>) -> Option<Self> {
        let node_id = get("node.id")?.trim().parse().ok()?;
        let output = match get("port.direction")? {
            "out" => true,
            "in" => false,
            _ => return None,
        };
        Some(Self {
            node_id,
            output,
            channel: get("audio.channel").map(str::to_owned),
            audio: get("format.dsp").is_some_and(|format| format.contains("audio")),
            monitor: get("port.monitor") == Some("true"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelSide {
    Left,
    Right,
    Both,
}

fn channel_side(channel: Option<&str>) -> Option<ChannelSide> {
    match channel? {
        "FL" | "SL" | "RL" | "FLC" | "AUX0" => Some(ChannelSide::Left),
        "FR" | "SR" | "RR" | "FRC" | "AUX1" => Some(ChannelSide::Right),
        "MONO" | "FC" | "RC" => Some(ChannelSide::Both),
        _ => None,
    }
}

/// The capture stream's left and right input ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptureInputs {
    node: u32,
    left: u32,
    right: u32,
}

fn capture_inputs(ports: &HashMap<u32, PortFacts>, node: u32) -> Option<CaptureInputs> {
    let input = |channel: &str| {
        ports
            .iter()
            .filter(|(_, port)| {
                port.node_id == node
                    && !port.output
                    && port.audio
                    && !port.monitor
                    && port.channel.as_deref() == Some(channel)
            })
            .map(|(id, _)| *id)
            .min()
    };
    Some(CaptureInputs {
        node,
        left: input("FL")?,
        right: input("FR")?,
    })
}

/// One link from a playback port into a capture port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct PortLink {
    output_node: u32,
    output_port: u32,
    input_node: u32,
    input_port: u32,
}

/// Every link the captured streams need: each output port to the capture
/// side its channel belongs to. A stream with one port is mono.
fn desired_links(
    ports: &HashMap<u32, PortFacts>,
    capture: CaptureInputs,
    captured: &BTreeSet<u32>,
) -> BTreeSet<PortLink> {
    let mut outputs: BTreeMap<u32, Vec<(u32, Option<&str>)>> = BTreeMap::new();
    for (id, port) in ports {
        if port.output && port.audio && !port.monitor && captured.contains(&port.node_id) {
            outputs
                .entry(port.node_id)
                .or_default()
                .push((*id, port.channel.as_deref()));
        }
    }
    let mut links = BTreeSet::new();
    for (node, mut node_ports) in outputs {
        node_ports.sort_unstable();
        let mono = node_ports.len() == 1;
        for (port, channel) in node_ports {
            let side = if mono {
                Some(ChannelSide::Both)
            } else {
                channel_side(channel)
            };
            let targets = match side {
                Some(ChannelSide::Left) => [Some(capture.left), None],
                Some(ChannelSide::Right) => [None, Some(capture.right)],
                Some(ChannelSide::Both) => [Some(capture.left), Some(capture.right)],
                None => [None, None],
            };
            for input_port in targets.into_iter().flatten() {
                links.insert(PortLink {
                    output_node: node,
                    output_port: port,
                    input_node: capture.node,
                    input_port,
                });
            }
        }
    }
    links
}

fn frames_to_nanos(frames: u64) -> u64 {
    (u128::from(frames) * 1_000_000_000 / u128::from(SYSTEM_AUDIO_SAMPLE_RATE)) as u64
}

fn signed_difference(a: u64, b: u64) -> i64 {
    (i128::from(a) - i128::from(b)).clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

/// Places buffers on a sample-counted timeline anchored to the first cycle's
/// time, so `timestamp_micros` advances by exact sample counts (S0 Q7). The
/// graph clock's drift against CLOCK_MONOTONIC is tracked, not corrected
/// here: the bus's `SourceClock` regresses it from `captured_at`. A cycle
/// that comes much later than predicted (an xrun, a suspended graph)
/// restarts the timeline, so the gap is silence on the bus; one that comes
/// earlier never moves the timeline back.
#[derive(Debug, Default)]
struct DeviceTimeline {
    anchor_nanos: Option<u64>,
    frames: u64,
    drift_nanos: i64,
}

impl DeviceTimeline {
    /// The placed start of a buffer of `frames` measured to start at
    /// `measured` (CLOCK_MONOTONIC nanos).
    fn place(&mut self, measured: u64, frames: u64) -> u64 {
        let Some(anchor) = self.anchor_nanos else {
            *self = Self {
                anchor_nanos: Some(measured),
                frames,
                drift_nanos: 0,
            };
            return measured;
        };
        let predicted = anchor.saturating_add(frames_to_nanos(self.frames));
        let deviation = signed_difference(measured, predicted);
        let tolerance = i64::try_from(frames_to_nanos(frames).saturating_mul(4))
            .unwrap_or(i64::MAX)
            .max(MIN_GAP_NANOS);
        let excess = deviation.saturating_sub(self.drift_nanos);
        let placed = if excess.unsigned_abs() <= tolerance.unsigned_abs() {
            self.drift_nanos = self.drift_nanos.saturating_add(excess / 32);
            predicted
        } else if excess > 0 {
            let restart = measured.max(predicted);
            self.anchor_nanos = Some(restart);
            self.frames = 0;
            self.drift_nanos = signed_difference(measured, restart);
            restart
        } else {
            self.drift_nanos = deviation;
            predicted
        };
        self.frames = self.frames.saturating_add(frames);
        placed
    }
}

/// The measured start of each buffer of one cycle, the last ending at `end`.
fn measured_starts(end: u64, frames: &[usize]) -> Vec<u64> {
    let mut starts = vec![0; frames.len()];
    let mut cursor = end;
    for (start, count) in starts.iter_mut().zip(frames).rev() {
        cursor = cursor.saturating_sub(frames_to_nanos(*count as u64));
        *start = cursor;
    }
    starts
}

/// The cycle's time: the stream's `pw_time.now` when it is a sane recent
/// CLOCK_MONOTONIC reading, else the clock read now.
fn cycle_now(stream_now: Option<i64>, mono: u64) -> u64 {
    stream_now
        .and_then(|now| u64::try_from(now).ok())
        .filter(|now| *now > 0 && *now <= mono && mono - *now <= 1_000_000_000)
        .unwrap_or(mono)
}

/// Decodes one buffer chunk of interleaved F32LE stereo. `offset` wraps in
/// the mapped data, as the SPA ring convention allows.
fn decode_chunk(
    data: &[u8],
    offset: u32,
    size: u32,
    stride: i32,
    corrupted: bool,
) -> Result<Vec<f32>, String> {
    if corrupted {
        return Err("PipeWire marked the buffer corrupted".into());
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    if stride != 0 && usize::try_from(stride).ok() != Some(FRAME_BYTES) {
        return Err(format!(
            "PipeWire delivered a stride of {stride} bytes; 32-bit float stereo needs {FRAME_BYTES}"
        ));
    }
    if data.is_empty() {
        return Err("PipeWire delivered a buffer with no mapped data".into());
    }
    let size = (size as usize).min(data.len());
    if !size.is_multiple_of(FRAME_BYTES) {
        return Err(format!(
            "PipeWire delivered {size} bytes, not whole 32-bit float stereo frames"
        ));
    }
    let start = offset as usize % data.len();
    let head = size.min(data.len() - start);
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(&data[start..start + head]);
    bytes.extend_from_slice(&data[..size - head]);
    Ok(bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]))
        .collect())
}

fn check_negotiated_format(
    is_f32le: bool,
    rate: u32,
    channels: u32,
) -> Result<(), SystemAudioFailure> {
    if is_f32le && rate == SYSTEM_AUDIO_SAMPLE_RATE && channels == u32::from(SYSTEM_AUDIO_CHANNELS)
    {
        return Ok(());
    }
    let format = if is_f32le {
        "32-bit float"
    } else {
        "a sample format other than 32-bit float"
    };
    Err(SystemAudioFailure::UnsupportedFormat(format!(
        "PipeWire negotiated {format} at {rate} Hz with {channels} channels; system audio needs 32-bit float at {SYSTEM_AUDIO_SAMPLE_RATE} Hz with {SYSTEM_AUDIO_CHANNELS} channels"
    )))
}

/// What the capture still lacks before it can announce itself.
fn readiness_gap(connected: bool, has_inputs: bool) -> Option<&'static str> {
    if !connected {
        Some("the capture stream did not connect")
    } else if !has_inputs {
        Some("the capture stream exposed no left and right input ports")
    } else {
        None
    }
}

fn phase_failure(phase: SystemAudioPhase, message: String) -> SystemAudioFailure {
    match phase {
        SystemAudioPhase::Starting => SystemAudioFailure::StartFailed(message),
        SystemAudioPhase::Running => SystemAudioFailure::StreamStopped(message),
    }
}

/// A fatal error on the PipeWire core. A refusal is still not
/// `PermissionDenied`: that kind points the user at macOS's Screen Recording
/// pane, and Linux has no grant to give.
fn core_failure(phase: SystemAudioPhase, res: i32, message: &str) -> SystemAudioFailure {
    let detail = match message.trim() {
        "" => std::io::Error::from_raw_os_error(res.saturating_neg()).to_string(),
        message => message.to_owned(),
    };
    if res == -libc::EACCES || res == -libc::EPERM {
        return phase_failure(
            phase,
            format!("PipeWire refused access to the audio graph: {detail}"),
        );
    }
    let what = match phase {
        SystemAudioPhase::Starting => "PipeWire connection failed",
        SystemAudioPhase::Running => "PipeWire connection lost",
    };
    phase_failure(phase, format!("{what}: {detail}"))
}

/// The capture stream's state, as the loop reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum StreamCondition {
    #[default]
    Connecting,
    /// Paused or streaming: connected, with a node id.
    Ready,
    Unconnected,
    Error(String),
}

fn stream_failure(
    phase: SystemAudioPhase,
    condition: &StreamCondition,
) -> Option<SystemAudioFailure> {
    match condition {
        StreamCondition::Error(message) => Some(phase_failure(
            phase,
            format!("the PipeWire capture stream failed: {message}"),
        )),
        StreamCondition::Unconnected => Some(phase_failure(
            phase,
            "the PipeWire capture stream disconnected".into(),
        )),
        StreamCondition::Connecting | StreamCondition::Ready => None,
    }
}

#[allow(unused_imports)] // `SystemAudioCaptureInfo` serves the tests
pub(crate) use capture::{SystemAudioCapture, SystemAudioCaptureInfo, SystemAudioCaptureOptions};

mod capture {
    use std::cell::RefCell;
    use std::collections::{BTreeSet, HashMap, HashSet};
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use pipewire as pw;
    use pw::proxy::ProxyT;
    use pw::spa;
    use pw::spa::pod::Pod;

    use super::*;
    use crate::audio::{AudioCaptureStats, AudioFrame};
    use crate::system_audio_capture::{
        BadBufferRun, SYSTEM_AUDIO_QUEUE_CAPACITY, SYSTEM_AUDIO_START_BUDGET,
        SYSTEM_AUDIO_STOP_BUDGET, SystemAudioCaptureStats, SystemAudioFailureSlot,
        system_audio_frame,
    };

    impl ExclusionRoot {
        /// Videorc's exclusion root for this backend process.
        pub(crate) fn videorc() -> Self {
            Self::resolve(
                std::env::var(ELECTRON_MAIN_PID_ENV).ok().as_deref(),
                parent_pid(),
                std::process::id(),
            )
        }
    }

    /// Options for [`SystemAudioCapture::start`].
    #[derive(Debug, Clone)]
    pub(crate) struct SystemAudioCaptureOptions {
        pub(crate) root: ExclusionRoot,
        pub(crate) queue_capacity: usize,
    }

    impl Default for SystemAudioCaptureOptions {
        fn default() -> Self {
            Self {
                root: ExclusionRoot::videorc(),
                queue_capacity: SYSTEM_AUDIO_QUEUE_CAPACITY,
            }
        }
    }

    /// What the running stream excludes and which node it is, for
    /// diagnostics.
    #[derive(Debug, Clone, Default)]
    pub(crate) struct SystemAudioCaptureInfo {
        /// Root of the excluded process tree.
        pub(crate) target_process_id: u32,
        pub(crate) root_source: ExclusionRootSource,
        /// Whether the excluded tree is known to be the Electron main
        /// process's. False means Videorc's own audio may leak.
        pub(crate) pid_excluded: bool,
        /// The capture stream's PipeWire node.
        pub(crate) node_id: u32,
        pub(crate) start_latency: Duration,
    }

    /// State shared by the capture thread and the consumer handle.
    struct CaptureShared {
        sender: Mutex<Option<mpsc::SyncSender<AudioFrame>>>,
        stats: Arc<AudioCaptureStats>,
        rejected_buffers: AtomicU64,
        failure: SystemAudioFailureSlot,
        /// Set before a deliberate stop so a late error is not reported as
        /// loss.
        stopping: AtomicBool,
    }

    impl CaptureShared {
        fn push(&self, frame: AudioFrame) {
            let frames = frame.frame_count() as u64;
            self.stats.record_captured_frames(frames);
            let sender = self.sender.lock().unwrap_or_else(|p| p.into_inner());
            let Some(sender) = sender.as_ref() else {
                return;
            };
            if let Err(mpsc::TrySendError::Full(_)) = sender.try_send(frame) {
                self.stats.record_dropped_frames(frames);
            }
        }

        /// Records a terminal failure (unless this is a deliberate stop) and
        /// disconnects the frame channel. The failure is stored before the
        /// disconnect, so a consumer that sees the disconnect can read it.
        fn fail(&self, failure: SystemAudioFailure) {
            if !self.stopping.load(Ordering::Acquire) && self.failure.record(failure.clone()) {
                tracing::warn!(
                    kind = failure.health_kind(),
                    reason = %failure,
                    "System audio capture failed"
                );
            }
            self.stopping.store(true, Ordering::Release);
            self.close();
        }

        fn close(&self) {
            self.sender.lock().unwrap_or_else(|p| p.into_inner()).take();
        }
    }

    /// A running system-audio capture. Dropping it stops the stream
    /// (bounded).
    ///
    /// Every PipeWire object lives on a dedicated capture thread, so this
    /// handle is `Send` and can be a session producer's owner.
    pub(crate) struct SystemAudioCapture {
        receiver: Option<mpsc::Receiver<AudioFrame>>,
        shared: Arc<CaptureShared>,
        info: SystemAudioCaptureInfo,
        stop_tx: Option<mpsc::Sender<()>>,
        done_rx: Option<mpsc::Receiver<()>>,
        owner: Option<thread::JoinHandle<()>>,
    }

    impl SystemAudioCapture {
        /// Connects a PipeWire capture stream that links every playback
        /// stream except `options.root`'s. Blocks for up to
        /// [`SYSTEM_AUDIO_START_BUDGET`].
        pub(crate) fn start(
            options: SystemAudioCaptureOptions,
        ) -> Result<Self, SystemAudioFailure> {
            let (sender, receiver) = mpsc::sync_channel(options.queue_capacity.max(1));
            let shared = Arc::new(CaptureShared {
                sender: Mutex::new(Some(sender)),
                stats: Arc::new(AudioCaptureStats::default()),
                rejected_buffers: AtomicU64::new(0),
                failure: SystemAudioFailureSlot::default(),
                stopping: AtomicBool::new(false),
            });
            let (startup_tx, startup_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (done_tx, done_rx) = mpsc::channel::<()>();
            let owner_shared = Arc::clone(&shared);
            let owner = thread::Builder::new()
                .name("system-audio-pipewire".into())
                .spawn(move || {
                    run_owner(&options, &owner_shared, &startup_tx, &stop_rx);
                    let _ = done_tx.send(());
                })
                .map_err(|error| {
                    SystemAudioFailure::StartFailed(format!(
                        "could not spawn the system audio capture thread: {error}"
                    ))
                })?;
            let mut capture = Self {
                receiver: Some(receiver),
                shared,
                info: SystemAudioCaptureInfo::default(),
                stop_tx: Some(stop_tx),
                done_rx: Some(done_rx),
                owner: Some(owner),
            };
            match startup_rx.recv_timeout(SYSTEM_AUDIO_START_BUDGET) {
                Ok(Ok(info)) => {
                    tracing::info!(
                        target_pid = info.target_process_id,
                        root_source = ?info.root_source,
                        pid_excluded = info.pid_excluded,
                        node_id = info.node_id,
                        start_ms = info.start_latency.as_millis() as u64,
                        "System audio capture started"
                    );
                    capture.info = info;
                    Ok(capture)
                }
                Ok(Err(failure)) => Err(failure),
                Err(_) => Err(SystemAudioFailure::StartFailed(format!(
                    "system audio did not start within {} s",
                    SYSTEM_AUDIO_START_BUDGET.as_secs()
                ))),
            }
            // On every Err path `capture` drops here: the capture thread is
            // told to stop and releases whatever it managed to open (bounded).
        }

        /// The frame channel. `None` after the first call.
        pub(crate) fn take_receiver(&mut self) -> Option<mpsc::Receiver<AudioFrame>> {
            self.receiver.take()
        }

        /// The counters as the bus's `AudioCaptureStats` (captured/dropped).
        pub(crate) fn stats_handle(&self) -> Arc<AudioCaptureStats> {
            Arc::clone(&self.shared.stats)
        }

        pub(crate) fn stats(&self) -> SystemAudioCaptureStats {
            SystemAudioCaptureStats {
                captured_frames: self.shared.stats.captured_frames(),
                dropped_frames: self.shared.stats.dropped_frames(),
                rejected_buffers: self.shared.rejected_buffers.load(Ordering::Relaxed),
            }
        }

        /// The terminal failure, once one happened.
        pub(crate) fn failure(&self) -> Option<SystemAudioFailure> {
            self.shared.failure.get()
        }

        /// A clone of the failure slot, for a consumer that polls it after
        /// this handle moved into a producer owner.
        pub(crate) fn failure_slot(&self) -> SystemAudioFailureSlot {
            self.shared.failure.clone()
        }

        pub(crate) fn info(&self) -> &SystemAudioCaptureInfo {
            &self.info
        }

        /// Stops the stream and waits up to [`SYSTEM_AUDIO_STOP_BUDGET`].
        /// Returns false if the capture thread did not finish in time (it is
        /// then left to finish on its own).
        pub(crate) fn stop(mut self) -> bool {
            self.shutdown()
        }

        fn shutdown(&mut self) -> bool {
            let Some(stop_tx) = self.stop_tx.take() else {
                return true;
            };
            self.shared.stopping.store(true, Ordering::Release);
            let _ = stop_tx.send(());
            let finished = self
                .done_rx
                .take()
                .is_some_and(|done| done.recv_timeout(SYSTEM_AUDIO_STOP_BUDGET).is_ok());
            if finished {
                if let Some(owner) = self.owner.take() {
                    let _ = owner.join();
                }
            } else {
                // Never block forever: detach the thread; it still stops and
                // releases the stream when PipeWire answers.
                self.owner.take();
                self.shared.close();
                tracing::warn!(
                    "System audio capture did not stop within {} s",
                    SYSTEM_AUDIO_STOP_BUDGET.as_secs()
                );
            }
            finished
        }
    }

    impl Drop for SystemAudioCapture {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    fn stop_requested(stop_rx: &mpsc::Receiver<()>) -> bool {
        !matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty))
    }

    type StartupSender = mpsc::Sender<Result<SystemAudioCaptureInfo, SystemAudioFailure>>;

    fn run_owner(
        options: &SystemAudioCaptureOptions,
        shared: &Arc<CaptureShared>,
        startup_tx: &StartupSender,
        stop_rx: &mpsc::Receiver<()>,
    ) {
        // An Err comes only before the announcement; later failures go
        // through `shared.fail`.
        if let Err(failure) = run_pipewire(options, shared, startup_tx, stop_rx) {
            shared.failure.record(failure.clone());
            shared.close();
            let _ = startup_tx.send(Err(failure));
            return;
        }
        shared.close();
    }

    /// One playback stream the registry announced.
    struct PlaybackNode {
        /// Its registry properties, a subset of the node's own.
        global: ObjectFacts,
        /// The node's own properties, once its info came.
        facts: Option<ObjectFacts>,
        seen_at: Instant,
        decision: Option<PlaybackDecision>,
        logged: Option<PlaybackDecision>,
    }

    impl PlaybackNode {
        fn current(&self) -> &ObjectFacts {
            self.facts.as_ref().unwrap_or(&self.global)
        }
    }

    /// What the registry and the bound objects said, shared by the PipeWire
    /// callbacks and the loop. Never borrowed across a PipeWire call.
    #[derive(Default)]
    struct GraphFacts {
        playback: HashMap<u32, PlaybackNode>,
        clients: HashMap<u32, ObjectFacts>,
        ports: HashMap<u32, PortFacts>,
        bind_nodes: Vec<pw::registry::GlobalObject<pw::properties::PropertiesBox>>,
        bind_clients: Vec<pw::registry::GlobalObject<pw::properties::PropertiesBox>>,
        unbind: Vec<u32>,
        /// Links PipeWire refused or removed: never recreated while wanted.
        failed_links: HashSet<PortLink>,
        core_error: Option<(i32, String)>,
        /// The links may be out of date.
        dirty: bool,
    }

    impl GraphFacts {
        fn forget(&mut self, id: u32) {
            self.playback.remove(&id);
            self.clients.remove(&id);
            self.ports.remove(&id);
            self.bind_nodes.retain(|global| global.id != id);
            self.bind_clients.retain(|global| global.id != id);
            self.unbind.push(id);
            self.dirty = true;
        }

        fn node_props(&mut self, id: u32, facts: ObjectFacts) {
            let Some(node) = self.playback.get_mut(&id) else {
                return;
            };
            if node.facts.as_ref() != Some(&facts) {
                node.facts = Some(facts);
                node.decision = None;
                self.dirty = true;
            }
        }

        fn client_props(&mut self, id: u32, facts: ObjectFacts) {
            if self.clients.get(&id) == Some(&facts) {
                return;
            }
            self.clients.insert(id, facts);
            for node in self.playback.values_mut() {
                if node.current().client_id == Some(id) {
                    node.decision = None;
                    self.dirty = true;
                }
            }
        }

        fn decide(&mut self, root: u32) {
            let mut waiting = false;
            for (id, node) in &mut self.playback {
                if node.decision.is_some() {
                    continue;
                }
                let fresh = node.seen_at.elapsed() < CLIENT_INFO_WAIT;
                let decision = if node.facts.is_none() && fresh {
                    PlaybackDecision::WaitForClient
                } else {
                    let client = match node
                        .current()
                        .client_id
                        .and_then(|client| self.clients.get(&client))
                    {
                        Some(facts) => ClientView::Known(facts),
                        None if fresh => ClientView::Pending,
                        None => ClientView::Absent,
                    };
                    classify_playback(node.current(), client, root, |pid, binary| {
                        judge_process(pid, binary, root)
                    })
                };
                if decision == PlaybackDecision::WaitForClient {
                    waiting = true;
                    continue;
                }
                node.decision = Some(decision);
                if node.logged != Some(decision) {
                    node.logged = Some(decision);
                    let process = node.current().process.as_ref();
                    let pid = process.map(|process| process.pid);
                    let binary = process.and_then(|process| process.binary.as_deref());
                    match decision {
                        PlaybackDecision::Own => tracing::info!(
                            node = id,
                            ?pid,
                            ?binary,
                            "System audio leaves out Videorc's own playback stream"
                        ),
                        PlaybackDecision::Capture => tracing::debug!(
                            node = id,
                            ?pid,
                            ?binary,
                            "System audio captures a playback stream"
                        ),
                        PlaybackDecision::NotPlayback | PlaybackDecision::WaitForClient => {}
                    }
                }
            }
            if waiting {
                self.dirty = true;
            }
        }

        fn captured(&self) -> BTreeSet<u32> {
            self.playback
                .iter()
                .filter(|(_, node)| node.decision == Some(PlaybackDecision::Capture))
                .map(|(id, _)| *id)
                .collect()
        }
    }

    /// A bound node or client and the listener reading its info. The
    /// listener is declared first so it is dropped first.
    struct Bound<P> {
        _listener: Box<dyn std::any::Any>,
        _proxy: P,
    }

    /// A link this capture created. Dropping it destroys the proxy, and with
    /// `object.linger` off PipeWire then removes the link.
    struct OwnedLink {
        _listener: pw::proxy::ProxyListener,
        _proxy: pw::link::Link,
    }

    fn bind_pending(
        registry: &pw::registry::RegistryRc,
        graph: &Rc<RefCell<GraphFacts>>,
        nodes: &mut HashMap<u32, Bound<pw::node::Node>>,
        clients: &mut HashMap<u32, Bound<pw::client::Client>>,
    ) {
        let (unbind, bind_nodes, bind_clients) = {
            let mut facts = graph.borrow_mut();
            (
                std::mem::take(&mut facts.unbind),
                std::mem::take(&mut facts.bind_nodes),
                std::mem::take(&mut facts.bind_clients),
            )
        };
        for id in unbind {
            nodes.remove(&id);
            clients.remove(&id);
        }
        for global in bind_nodes {
            let id = global.id;
            match registry.bind::<pw::node::Node, _>(&global) {
                Ok(proxy) => {
                    let graph = Rc::clone(graph);
                    let listener = proxy
                        .add_listener_local()
                        .info(move |info| {
                            if info.change_mask().contains(pw::node::NodeChangeMask::PROPS)
                                && let Some(props) = info.props()
                            {
                                graph
                                    .borrow_mut()
                                    .node_props(id, ObjectFacts::from_props(|key| props.get(key)));
                            }
                        })
                        .register();
                    nodes.insert(
                        id,
                        Bound {
                            _listener: Box::new(listener),
                            _proxy: proxy,
                        },
                    );
                }
                Err(error) => tracing::warn!(
                    node = id,
                    reason = %error,
                    "System audio could not read a playback stream's properties; judging it by its registry entry"
                ),
            }
        }
        for global in bind_clients {
            let id = global.id;
            match registry.bind::<pw::client::Client, _>(&global) {
                Ok(proxy) => {
                    let graph = Rc::clone(graph);
                    // `change_mask()` panics on bits it does not know; the
                    // props are compared instead.
                    let listener = proxy
                        .add_listener_local()
                        .info(move |info| {
                            if let Some(props) = info.props() {
                                graph.borrow_mut().client_props(
                                    id,
                                    ObjectFacts::from_props(|key| props.get(key)),
                                );
                            }
                        })
                        .register();
                    clients.insert(
                        id,
                        Bound {
                            _listener: Box::new(listener),
                            _proxy: proxy,
                        },
                    );
                }
                Err(error) => tracing::debug!(
                    client = id,
                    reason = %error,
                    "System audio could not read a PipeWire client's properties"
                ),
            }
        }
    }

    fn create_link(
        core: &pw::core::CoreRc,
        graph: &Rc<RefCell<GraphFacts>>,
        link: PortLink,
    ) -> Result<OwnedLink, pw::Error> {
        let props = pw::properties::properties! {
            *pw::keys::LINK_OUTPUT_NODE => link.output_node.to_string(),
            *pw::keys::LINK_OUTPUT_PORT => link.output_port.to_string(),
            *pw::keys::LINK_INPUT_NODE => link.input_node.to_string(),
            *pw::keys::LINK_INPUT_PORT => link.input_port.to_string(),
            *pw::keys::OBJECT_LINGER => "false",
        };
        let proxy: pw::link::Link = core.create_object("link-factory", &props)?;
        let listener = proxy
            .upcast_ref()
            .add_listener_local()
            .removed({
                let graph = Rc::clone(graph);
                move || {
                    let mut facts = graph.borrow_mut();
                    facts.failed_links.insert(link);
                    facts.dirty = true;
                }
            })
            .error({
                let graph = Rc::clone(graph);
                move |_seq, res, message| {
                    tracing::warn!(
                        ?link,
                        res,
                        message,
                        "System audio could not link a playback stream"
                    );
                    let mut facts = graph.borrow_mut();
                    facts.failed_links.insert(link);
                    facts.dirty = true;
                }
            })
            .register();
        Ok(OwnedLink {
            _listener: listener,
            _proxy: proxy,
        })
    }

    /// Brings the capture's links in line with the decided playback streams.
    fn reconcile(
        core: &pw::core::CoreRc,
        graph: &Rc<RefCell<GraphFacts>>,
        capture_node: u32,
        root: u32,
        links: &mut HashMap<PortLink, OwnedLink>,
    ) {
        let (stale, create) = {
            let mut facts = graph.borrow_mut();
            facts.dirty = false;
            facts.decide(root);
            let desired = match capture_inputs(&facts.ports, capture_node) {
                Some(inputs) => desired_links(&facts.ports, inputs, &facts.captured()),
                None => BTreeSet::new(),
            };
            facts.failed_links.retain(|link| desired.contains(link));
            let failed = &facts.failed_links;
            let stale: Vec<PortLink> = links
                .keys()
                .filter(|link| !desired.contains(link) || failed.contains(link))
                .copied()
                .collect();
            let create: Vec<PortLink> = desired
                .iter()
                .filter(|link| !links.contains_key(link) && !failed.contains(link))
                .copied()
                .collect();
            (stale, create)
        };
        for link in stale {
            links.remove(&link);
        }
        for link in create {
            match create_link(core, graph, link) {
                Ok(owned) => {
                    links.insert(link, owned);
                }
                Err(error) => {
                    tracing::warn!(
                        ?link,
                        reason = %error,
                        "System audio could not link a playback stream"
                    );
                    graph.borrow_mut().failed_links.insert(link);
                }
            }
        }
    }

    /// What the capture stream's callbacks said, shared with the loop.
    #[derive(Default)]
    struct StreamFacts {
        condition: StreamCondition,
        format_ok: bool,
        failure: Option<SystemAudioFailure>,
        /// Announced: buffers become frames.
        live: bool,
        timeline: DeviceTimeline,
        bad_run: BadBufferRun,
    }

    fn read_buffer(buffer: &mut pw::buffer::Buffer<'_>) -> Result<Vec<f32>, String> {
        let Some(data) = buffer.datas_mut().first_mut() else {
            return Err("PipeWire delivered a buffer with no data planes".into());
        };
        let chunk = data.chunk();
        let (offset, size, stride) = (chunk.offset(), chunk.size(), chunk.stride());
        let corrupted = chunk.flags().contains(spa::buffer::ChunkFlags::CORRUPTED);
        let bytes = data.data().map_or(&[][..], |bytes| &*bytes);
        decode_chunk(bytes, offset, size, stride, corrupted)
    }

    fn process_cycle(
        stream: &pw::stream::Stream,
        facts: &RefCell<StreamFacts>,
        shared: &CaptureShared,
        anchor: HostClockAnchor,
    ) {
        let now = cycle_now(stream.time().ok().map(|time| time.now()), monotonic_nanos());
        let mut facts = facts.borrow_mut();
        let accept = facts.live && facts.format_ok && !shared.stopping.load(Ordering::Acquire);
        let mut chunks = Vec::new();
        // Every queued buffer is taken; dropping one hands it back.
        while let Some(mut buffer) = stream.dequeue_buffer() {
            if !accept {
                continue;
            }
            match read_buffer(&mut buffer) {
                Ok(samples) => {
                    facts.bad_run.good();
                    if !samples.is_empty() {
                        chunks.push(samples);
                    }
                }
                Err(reason) => {
                    let previous = shared.rejected_buffers.fetch_add(1, Ordering::Relaxed);
                    if facts.bad_run.bad(Instant::now()) {
                        facts
                            .failure
                            .get_or_insert(SystemAudioFailure::UnsupportedFormat(format!(
                                "PipeWire kept delivering buffers that cannot be read: {reason}"
                            )));
                    } else if previous == 0 {
                        tracing::warn!(%reason, "System audio rejected a PipeWire buffer");
                    }
                }
            }
        }
        if chunks.is_empty() {
            return;
        }
        let counts: Vec<usize> = chunks
            .iter()
            .map(|samples| samples.len() / usize::from(SYSTEM_AUDIO_CHANNELS))
            .collect();
        let starts = measured_starts(now, &counts);
        for ((samples, frames), measured) in chunks.into_iter().zip(counts).zip(starts) {
            let placed = facts.timeline.place(measured, frames as u64);
            let mut frame = system_audio_frame(samples, placed, &anchor);
            frame.captured_at = anchor
                .buffer_end_instant(measured, frames, SYSTEM_AUDIO_SAMPLE_RATE)
                .min(Instant::now());
            shared.push(frame);
        }
    }

    fn pending_failure(
        graph: &RefCell<GraphFacts>,
        stream: &RefCell<StreamFacts>,
        phase: SystemAudioPhase,
    ) -> Option<SystemAudioFailure> {
        if let Some((res, message)) = &graph.borrow().core_error {
            return Some(core_failure(phase, *res, message));
        }
        let stream = stream.borrow();
        stream
            .failure
            .clone()
            .or_else(|| stream_failure(phase, &stream.condition))
    }

    fn start_failed(what: &str, error: impl std::fmt::Display) -> SystemAudioFailure {
        SystemAudioFailure::StartFailed(format!("could not {what}: {error}"))
    }

    /// The format the capture asks for: 48 kHz stereo F32LE, FL and FR.
    fn format_pod() -> Result<Vec<u8>, SystemAudioFailure> {
        let mut info = spa::param::audio::AudioInfoRaw::new();
        info.set_format(spa::param::audio::AudioFormat::F32LE);
        info.set_rate(SYSTEM_AUDIO_SAMPLE_RATE);
        info.set_channels(u32::from(SYSTEM_AUDIO_CHANNELS));
        let mut position = [0; spa::param::audio::MAX_CHANNELS];
        position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
        position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
        info.set_position(position);
        let object = spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: spa::param::ParamType::EnumFormat.as_raw(),
            properties: info.into(),
        };
        spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &spa::pod::Value::Object(object),
        )
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|error| start_failed("build the PipeWire audio format", format!("{error:?}")))
    }

    fn on_format(facts: &mut StreamFacts, param: Option<&Pod>) {
        let Some(param) = param else {
            facts.format_ok = false;
            return;
        };
        let raw_audio = spa::param::format_utils::parse_format(param).is_ok_and(
            |(media_type, media_subtype)| {
                media_type == spa::param::format::MediaType::Audio
                    && media_subtype == spa::param::format::MediaSubtype::Raw
            },
        );
        let mut info = spa::param::audio::AudioInfoRaw::new();
        if !raw_audio || info.parse(param).is_err() {
            facts
                .failure
                .get_or_insert(SystemAudioFailure::UnsupportedFormat(
                    "PipeWire negotiated a format that is not raw audio".into(),
                ));
            return;
        }
        tracing::info!(
            format = ?info.format(),
            rate = info.rate(),
            channels = info.channels(),
            "System audio PipeWire stream negotiated"
        );
        match check_negotiated_format(
            info.format() == spa::param::audio::AudioFormat::F32LE,
            info.rate(),
            info.channels(),
        ) {
            Ok(()) => facts.format_ok = true,
            Err(failure) => {
                facts.failure.get_or_insert(failure);
            }
        }
    }

    fn run_pipewire(
        options: &SystemAudioCaptureOptions,
        shared: &Arc<CaptureShared>,
        startup_tx: &StartupSender,
        stop_rx: &mpsc::Receiver<()>,
    ) -> Result<(), SystemAudioFailure> {
        let started = Instant::now();
        pw::init();
        let mainloop = pw::main_loop::MainLoopRc::new(None)
            .map_err(|error| start_failed("create the PipeWire main loop", error))?;
        let context = pw::context::ContextRc::new(&mainloop, None)
            .map_err(|error| start_failed("create the PipeWire context", error))?;
        let core = context
            .connect_rc(None)
            .map_err(|error| start_failed("connect to PipeWire", error))?;
        let registry = core
            .get_registry_rc()
            .map_err(|error| start_failed("read the PipeWire registry", error))?;
        let root = options.root;
        if !root.names_electron_main() {
            tracing::warn!(
                target_pid = root.process_id,
                source = ?root.source,
                "System audio could not name the Videorc app to exclude ({ELECTRON_MAIN_PID_ENV} unset); its own audio may be captured"
            );
        }

        let graph = Rc::new(RefCell::new(GraphFacts::default()));
        let _core_listener = core
            .add_listener_local()
            .error({
                let graph = Rc::clone(&graph);
                move |id, seq, res, message| {
                    // ENOENT on the core is a stale id (a bind racing a
                    // removal), not a lost connection.
                    if id == pw::core::PW_ID_CORE && res != -libc::ENOENT {
                        graph
                            .borrow_mut()
                            .core_error
                            .get_or_insert((res, message.to_owned()));
                    } else {
                        tracing::debug!(
                            id,
                            seq,
                            res,
                            message,
                            "System audio PipeWire object error"
                        );
                    }
                }
            })
            .register();
        let _registry_listener = registry
            .add_listener_local()
            .global({
                let graph = Rc::clone(&graph);
                move |global| {
                    let mut facts = graph.borrow_mut();
                    match global.type_ {
                        pw::types::ObjectType::Node => {
                            let Some(props) = global.props else {
                                return;
                            };
                            let node = ObjectFacts::from_props(|key| props.get(key));
                            if node.is_playback() {
                                facts.playback.insert(
                                    global.id,
                                    PlaybackNode {
                                        global: node,
                                        facts: None,
                                        seen_at: Instant::now(),
                                        decision: None,
                                        logged: None,
                                    },
                                );
                                facts.bind_nodes.push(global.to_owned());
                                facts.dirty = true;
                            }
                        }
                        pw::types::ObjectType::Client => facts.bind_clients.push(global.to_owned()),
                        pw::types::ObjectType::Port => {
                            if let Some(port) = global
                                .props
                                .and_then(|props| PortFacts::from_props(|key| props.get(key)))
                            {
                                facts.ports.insert(global.id, port);
                                facts.dirty = true;
                            }
                        }
                        _ => {}
                    }
                }
            })
            .global_remove({
                let graph = Rc::clone(&graph);
                move |id| graph.borrow_mut().forget(id)
            })
            .register();

        let anchor = sample_anchor();
        let stream_facts = Rc::new(RefCell::new(StreamFacts::default()));
        let stream = pw::stream::StreamBox::new(
            &core,
            "videorc-system-audio",
            pw::properties::properties! {
                *pw::keys::MEDIA_TYPE => "Audio",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::NODE_NAME => "videorc-system-audio",
                *pw::keys::NODE_DESCRIPTION => "Videorc system audio",
                *pw::keys::APP_NAME => "Videorc",
                // This capture links the playback streams itself.
                *pw::keys::NODE_AUTOCONNECT => "false",
                *pw::keys::NODE_DONT_RECONNECT => "true",
                "node.dont-move" => "true",
                *pw::keys::NODE_ALWAYS_PROCESS => "true",
            },
        )
        .map_err(|error| start_failed("create the PipeWire capture stream", error))?;
        let _stream_listener = stream
            .add_local_listener_with_user_data(())
            .state_changed({
                let facts = Rc::clone(&stream_facts);
                move |_, _, _old, new| {
                    facts.borrow_mut().condition = match new {
                        pw::stream::StreamState::Paused | pw::stream::StreamState::Streaming => {
                            StreamCondition::Ready
                        }
                        pw::stream::StreamState::Connecting => StreamCondition::Connecting,
                        pw::stream::StreamState::Unconnected => StreamCondition::Unconnected,
                        pw::stream::StreamState::Error(message) => StreamCondition::Error(message),
                    };
                }
            })
            .param_changed({
                let facts = Rc::clone(&stream_facts);
                move |_, _, id, param| {
                    if id == spa::param::ParamType::Format.as_raw() {
                        on_format(&mut facts.borrow_mut(), param);
                    }
                }
            })
            .process({
                let facts = Rc::clone(&stream_facts);
                let shared = Arc::clone(shared);
                move |stream, _| process_cycle(stream, &facts, &shared, anchor)
            })
            .register()
            .map_err(|error| start_failed("listen to the PipeWire capture stream", error))?;
        let format = format_pod()?;
        let mut params = [Pod::from_bytes(&format).ok_or_else(|| {
            SystemAudioFailure::StartFailed("the PipeWire audio format is not a pod".into())
        })?];
        stream
            .connect(
                spa::utils::Direction::Input,
                None,
                pw::stream::StreamFlags::MAP_BUFFERS,
                &mut params,
            )
            .map_err(|error| start_failed("connect the PipeWire capture stream", error))?;

        // Declared after the stream, so links and bound proxies are released
        // before it, and everything before the core.
        let mut nodes = HashMap::new();
        let mut clients = HashMap::new();
        let mut links: HashMap<PortLink, OwnedLink> = HashMap::new();
        let mut announced = false;
        loop {
            if stop_requested(stop_rx) {
                break;
            }
            let phase = if announced {
                SystemAudioPhase::Running
            } else {
                SystemAudioPhase::Starting
            };
            if let Some(failure) = pending_failure(&graph, &stream_facts, phase) {
                if announced {
                    shared.fail(failure);
                    break;
                }
                return Err(failure);
            }
            bind_pending(&registry, &graph, &mut nodes, &mut clients);
            let node_id = stream.node_id();
            if announced {
                let dirty = graph.borrow().dirty;
                if dirty {
                    reconcile(&core, &graph, node_id, root.process_id, &mut links);
                }
            } else {
                let connected = stream_facts.borrow().condition == StreamCondition::Ready
                    && node_id != pw::constants::ID_ANY;
                let has_inputs =
                    connected && capture_inputs(&graph.borrow().ports, node_id).is_some();
                match readiness_gap(connected, has_inputs) {
                    None => {
                        reconcile(&core, &graph, node_id, root.process_id, &mut links);
                        let info = SystemAudioCaptureInfo {
                            target_process_id: root.process_id,
                            root_source: root.source,
                            pid_excluded: root.names_electron_main(),
                            node_id,
                            start_latency: started.elapsed(),
                        };
                        // The handle is gone (start timed out, or it was
                        // dropped): stop at once instead of capturing for
                        // nobody.
                        if stop_requested(stop_rx) || startup_tx.send(Ok(info)).is_err() {
                            break;
                        }
                        stream_facts.borrow_mut().live = true;
                        announced = true;
                    }
                    Some(gap) if started.elapsed() >= READY_DEADLINE => {
                        return Err(SystemAudioFailure::StartFailed(format!(
                            "system audio was not ready within {} s: {gap}",
                            READY_DEADLINE.as_secs()
                        )));
                    }
                    Some(_) => {}
                }
            }
            mainloop
                .loop_()
                .iterate(pw::loop_::Timeout::Finite(LOOP_WAIT));
        }
        stream_facts.borrow_mut().live = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::system_audio_capture::{HostClockAnchor, system_audio_frame};

    fn facts(pairs: &[(&str, &str)]) -> ObjectFacts {
        let props: HashMap<&str, &str> = pairs.iter().copied().collect();
        ObjectFacts::from_props(|key| props.get(key).copied())
    }

    fn port(pairs: &[(&str, &str)]) -> Option<PortFacts> {
        let props: HashMap<&str, &str> = pairs.iter().copied().collect();
        PortFacts::from_props(|key| props.get(key).copied())
    }

    fn le_bytes(values: &[f32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    #[test]
    fn system_audio_linux_reads_the_parent_from_proc_stat() {
        assert_eq!(
            stat_parent_pid("4242 (paplay) S 77 4242 77 0 -1 4194304"),
            Some(77)
        );
        // A command name with spaces and parentheses.
        assert_eq!(stat_parent_pid("9 (Web Content (x)) R 1 9 9 0 -1"), Some(1));
        assert_eq!(stat_parent_pid("garbage"), None);
        assert_eq!(stat_parent_pid("9 (x) S"), None);
    }

    #[test]
    fn system_audio_linux_walks_the_ancestry_to_the_root() {
        let parents: HashMap<u32, u32> = [(500, 400), (400, 300), (300, 1), (77, 78), (78, 77)]
            .into_iter()
            .collect();
        let parent_of = |pid: u32| parents.get(&pid).copied();
        assert_eq!(descends_from(300, 300, parent_of), PidVerdict::Descends);
        assert_eq!(descends_from(500, 300, parent_of), PidVerdict::Descends);
        assert_eq!(descends_from(500, 999, parent_of), PidVerdict::Foreign);
        // A gap in /proc (the process exited mid-walk).
        assert_eq!(descends_from(600, 300, parent_of), PidVerdict::Unverified);
        // A cycle never ends the walk on its own.
        assert_eq!(descends_from(77, 300, parent_of), PidVerdict::Unverified);
    }

    #[test]
    fn system_audio_linux_matches_the_reported_binary() {
        assert!(comm_matches("paplay\n", "/usr/bin/paplay"));
        assert!(comm_matches("paplay", "paplay"));
        assert!(comm_matches("videorc-backend", "videorc-backend-long-name"));
        assert!(!comm_matches("exe\n", "videorc"));
        assert!(!comm_matches("", "videorc"));

        assert!(exe_name_matches("electron", "/opt/Videorc/electron"));
        assert!(exe_name_matches("videorc (deleted)", "videorc"));
        assert!(!exe_name_matches("paplay", "videorc"));
        assert!(!exe_name_matches("", ""));
    }

    #[test]
    fn system_audio_linux_judges_this_process() {
        let me = std::process::id();
        let exe = std::env::current_exe().expect("current exe");
        let binary = exe.file_name().and_then(|name| name.to_str()).unwrap();
        assert!(process_is(me, binary));
        assert!(!process_is(me, "definitely-not-this-binary"));
        assert_eq!(judge_process(me, Some(binary), me), PidVerdict::Descends);
        assert_eq!(judge_process(me, None, me), PidVerdict::Descends);
        assert_eq!(
            judge_process(me, Some("definitely-not-this-binary"), me),
            PidVerdict::Unverified
        );
        assert_eq!(
            judge_process(me, Some(binary), u32::MAX),
            PidVerdict::Foreign
        );
        if let Some(parent) = parent_pid() {
            assert_ne!(parent, me);
            assert_eq!(
                judge_process(me, Some(binary), parent),
                PidVerdict::Descends
            );
        }
    }

    #[test]
    fn system_audio_linux_reads_object_facts() {
        let stream = facts(&[
            ("media.class", "Stream/Output/Audio"),
            ("client.id", "45"),
            ("application.process.id", " 4242 "),
            ("application.process.binary", "paplay"),
            (APP_INSTANCE_PROP, "77"),
            ("pipewire.sec.pid", "4243"),
        ]);
        assert_eq!(
            stream,
            ObjectFacts {
                media_class: Some("Stream/Output/Audio".into()),
                client_id: Some(45),
                link_group: None,
                process: Some(ReportedProcess {
                    pid: 4242,
                    binary: Some("paplay".into()),
                }),
                marker: Some("77".into()),
                sec_pid: Some(4243),
            }
        );
        assert!(stream.is_playback());
        assert!(stream.marks(77));
        assert!(!stream.marks(78));

        let odd = facts(&[
            ("media.class", "Audio/Sink"),
            ("application.process.id", "0"),
            ("pipewire.sec.pid", "x"),
            (APP_INSTANCE_PROP, " "),
            ("node.link-group", "filter-chain-1"),
        ]);
        assert!(!odd.is_playback());
        assert_eq!(odd.process, None);
        assert_eq!(odd.sec_pid, None);
        assert_eq!(odd.marker, None);
        assert_eq!(odd.link_group.as_deref(), Some("filter-chain-1"));
    }

    const ROOT: u32 = 100;

    /// 10 and 11 descend from the root, 20 and 21 do not, anything else is
    /// unverified. Odd pids are verified only without a binary.
    fn fake_judge(pid: u32, binary: Option<&str>) -> PidVerdict {
        match (pid, binary) {
            (10, Some(_)) | (11, None) => PidVerdict::Descends,
            (20, Some(_)) | (21, None) => PidVerdict::Foreign,
            _ => PidVerdict::Unverified,
        }
    }

    fn playback(process: Option<u32>, marker: Option<&str>) -> ObjectFacts {
        ObjectFacts {
            media_class: Some(PLAYBACK_MEDIA_CLASS.into()),
            client_id: Some(5),
            process: process.map(|pid| ReportedProcess {
                pid,
                binary: Some("player".into()),
            }),
            marker: marker.map(str::to_owned),
            ..ObjectFacts::default()
        }
    }

    #[test]
    fn system_audio_linux_classifies_playback_streams() {
        use PlaybackDecision::*;
        let classify = |stream: &ObjectFacts, client: ClientView<'_>| {
            classify_playback(stream, client, ROOT, fake_judge)
        };
        let root_marker = Some("100");

        // Not an application's playback, or part of a filter chain.
        let sink = ObjectFacts {
            media_class: Some("Audio/Sink".into()),
            ..ObjectFacts::default()
        };
        assert_eq!(classify(&sink, ClientView::Absent), NotPlayback);
        let mut grouped = playback(Some(10), None);
        grouped.link_group = Some("loopback-1".into());
        assert_eq!(classify(&grouped, ClientView::Absent), NotPlayback);

        // A verified process decides at once, before the client is known.
        assert_eq!(
            classify(&playback(Some(10), None), ClientView::Pending),
            Own
        );
        assert_eq!(
            classify(&playback(Some(20), None), ClientView::Pending),
            Capture
        );
        // A verified foreign process beats a leaked marker.
        assert_eq!(
            classify(&playback(Some(20), root_marker), ClientView::Absent),
            Capture
        );
        // An unverified process waits for its client.
        assert_eq!(
            classify(&playback(Some(30), root_marker), ClientView::Pending),
            WaitForClient
        );

        // The client's verified process decides next.
        let own_client = playback(Some(10), None);
        let foreign_client = playback(Some(20), None);
        assert_eq!(
            classify(&playback(Some(30), None), ClientView::Known(&own_client)),
            Own
        );
        assert_eq!(
            classify(
                &playback(None, root_marker),
                ClientView::Known(&foreign_client)
            ),
            Capture
        );

        // Then an unverified socket pid, which only ever proves a descendant.
        let mut socket_child = playback(Some(30), None);
        socket_child.sec_pid = Some(11);
        let mut socket_foreign = playback(Some(30), None);
        socket_foreign.sec_pid = Some(21);
        assert_eq!(
            classify(&playback(None, None), ClientView::Known(&socket_child)),
            Own
        );
        assert_eq!(
            classify(&playback(None, None), ClientView::Known(&socket_foreign)),
            Capture
        );

        // Then the marker, on the stream or its client, for this root only.
        assert_eq!(
            classify(&playback(None, root_marker), ClientView::Absent),
            Own
        );
        assert_eq!(
            classify(&playback(Some(30), root_marker), ClientView::Absent),
            Own
        );
        let marked_client = playback(None, root_marker);
        assert_eq!(
            classify(&playback(None, None), ClientView::Known(&marked_client)),
            Own
        );
        assert_eq!(
            classify(&playback(None, Some("101")), ClientView::Absent),
            Capture
        );
        assert_eq!(classify(&playback(None, None), ClientView::Absent), Capture);
    }

    fn port_props<'a>(
        node: &'a str,
        direction: &'a str,
        channel: &'a str,
    ) -> Vec<(&'a str, &'a str)> {
        vec![
            ("node.id", node),
            ("port.direction", direction),
            ("audio.channel", channel),
            ("format.dsp", "32 bit float mono audio"),
        ]
    }

    #[test]
    fn system_audio_linux_reads_port_facts() {
        assert_eq!(
            port(&port_props("7", "out", "FL")),
            Some(PortFacts {
                node_id: 7,
                output: true,
                channel: Some("FL".into()),
                audio: true,
                monitor: false,
            })
        );
        let mut monitor = port_props("7", "out", "FL");
        monitor.push(("port.monitor", "true"));
        assert!(port(&monitor).unwrap().monitor);
        let midi = [
            ("node.id", "7"),
            ("port.direction", "in"),
            ("format.dsp", "8 bit raw midi"),
        ];
        assert!(!port(&midi).unwrap().audio);
        assert_eq!(port(&[("port.direction", "out")]), None);
        assert_eq!(port(&[("node.id", "7"), ("port.direction", "both")]), None);
    }

    #[test]
    fn system_audio_linux_maps_channels_to_sides() {
        for channel in ["FL", "SL", "RL", "FLC", "AUX0"] {
            assert_eq!(
                channel_side(Some(channel)),
                Some(ChannelSide::Left),
                "{channel}"
            );
        }
        for channel in ["FR", "SR", "RR", "FRC", "AUX1"] {
            assert_eq!(
                channel_side(Some(channel)),
                Some(ChannelSide::Right),
                "{channel}"
            );
        }
        for channel in ["MONO", "FC", "RC"] {
            assert_eq!(
                channel_side(Some(channel)),
                Some(ChannelSide::Both),
                "{channel}"
            );
        }
        assert_eq!(channel_side(Some("LFE")), None);
        assert_eq!(channel_side(Some("UNK")), None);
        assert_eq!(channel_side(None), None);
    }

    fn graph_ports(entries: &[(u32, &[(&str, &str)])]) -> HashMap<u32, PortFacts> {
        entries
            .iter()
            .map(|(id, props)| (*id, port(props).expect("port facts")))
            .collect()
    }

    #[test]
    fn system_audio_linux_links_playback_ports_by_channel() {
        let mut monitor = port_props("50", "out", "FL");
        monitor.push(("port.monitor", "true"));
        let ports = graph_ports(&[
            // The capture stream (node 50): two inputs, and a stray monitor.
            (52, &port_props("50", "in", "FR")),
            (51, &port_props("50", "in", "FL")),
            (53, &monitor),
            // A stereo stream (60), a mono one (70) and a 5.1 one (80).
            (61, &port_props("60", "out", "FL")),
            (62, &port_props("60", "out", "FR")),
            (71, &port_props("70", "out", "MONO")),
            (81, &port_props("80", "out", "FL")),
            (82, &port_props("80", "out", "FR")),
            (83, &port_props("80", "out", "FC")),
            (84, &port_props("80", "out", "LFE")),
            (85, &port_props("80", "out", "RL")),
            (86, &port_props("80", "out", "RR")),
            // A stream that is not captured (90).
            (91, &port_props("90", "out", "FL")),
        ]);
        let inputs = capture_inputs(&ports, 50).expect("capture inputs");
        assert_eq!(
            inputs,
            CaptureInputs {
                node: 50,
                left: 51,
                right: 52,
            }
        );
        assert_eq!(capture_inputs(&ports, 60), None);

        let captured: BTreeSet<u32> = [60, 70, 80].into_iter().collect();
        let links: Vec<(u32, u32)> = desired_links(&ports, inputs, &captured)
            .into_iter()
            .map(|link| {
                assert_eq!(link.input_node, 50);
                (link.output_port, link.input_port)
            })
            .collect();
        assert_eq!(
            links,
            vec![
                (61, 51),
                (62, 52),
                (71, 51),
                (71, 52),
                (81, 51),
                (82, 52),
                (83, 51),
                (83, 52),
                (85, 51),
                (86, 52),
            ]
        );
        let output_nodes: BTreeSet<u32> = desired_links(&ports, inputs, &captured)
            .into_iter()
            .map(|link| link.output_node)
            .collect();
        assert_eq!(output_nodes, captured);
        assert!(desired_links(&ports, inputs, &BTreeSet::new()).is_empty());
    }

    const TEN_MS: u64 = 480;

    #[test]
    fn system_audio_linux_timeline_counts_samples_through_jitter() {
        let mut timeline = DeviceTimeline::default();
        assert_eq!(timeline.place(1_000_000_000, TEN_MS), 1_000_000_000);
        // 2 ms late, then 3 ms early: still on the sample count.
        assert_eq!(timeline.place(1_012_000_000, TEN_MS), 1_010_000_000);
        assert_eq!(timeline.place(1_017_000_000, TEN_MS), 1_020_000_000);
        assert_eq!(timeline.place(1_030_000_000, TEN_MS), 1_030_000_000);
    }

    #[test]
    fn system_audio_linux_timeline_restarts_after_a_gap() {
        let mut timeline = DeviceTimeline::default();
        timeline.place(1_000_000_000, TEN_MS);
        // 500 ms of nothing (an xrun or a suspended graph).
        assert_eq!(timeline.place(1_510_000_000, TEN_MS), 1_510_000_000);
        assert_eq!(timeline.place(1_520_500_000, TEN_MS), 1_520_000_000);
    }

    #[test]
    fn system_audio_linux_timeline_never_moves_back() {
        let mut timeline = DeviceTimeline::default();
        timeline.place(1_000_000_000, TEN_MS);
        assert_eq!(timeline.place(800_000_000, TEN_MS), 1_010_000_000);
        assert_eq!(timeline.place(810_000_000, TEN_MS), 1_020_000_000);
    }

    #[test]
    fn system_audio_linux_timeline_follows_slow_drift_without_restarting() {
        // The graph clock runs 0.1% fast: 200 ms ahead after 200 s.
        let mut timeline = DeviceTimeline::default();
        for cycle in 0..20_000u64 {
            let predicted = 1_000_000_000 + cycle * 10_000_000;
            let measured = predicted + cycle * 10_000;
            assert_eq!(timeline.place(measured, TEN_MS), predicted, "cycle {cycle}");
        }
    }

    #[test]
    fn system_audio_linux_spreads_a_cycle_back_from_its_end() {
        assert_eq!(
            measured_starts(1_030_000_000, &[480, 960]),
            vec![1_000_000_000, 1_010_000_000]
        );
        assert_eq!(measured_starts(5, &[480]), vec![0], "never underflows");
        assert!(measured_starts(5, &[]).is_empty());

        let mono = 5_000_000_000;
        assert_eq!(cycle_now(Some(4_990_000_000), mono), 4_990_000_000);
        assert_eq!(cycle_now(None, mono), mono);
        assert_eq!(cycle_now(Some(0), mono), mono);
        assert_eq!(cycle_now(Some(-5), mono), mono);
        assert_eq!(cycle_now(Some(5_000_000_001), mono), mono, "future");
        assert_eq!(cycle_now(Some(3_000_000_000), mono), mono, "stale");
    }

    #[test]
    fn system_audio_linux_decodes_float_stereo_chunks() {
        let data = le_bytes(&[0.5, -0.5, 0.25, -0.25]);
        assert_eq!(
            decode_chunk(&data, 0, 16, 8, false),
            Ok(vec![0.5, -0.5, 0.25, -0.25])
        );
        assert_eq!(decode_chunk(&data, 0, 16, 0, false).unwrap().len(), 4);
        // The offset wraps in the mapped data.
        assert_eq!(
            decode_chunk(&data, 8, 16, 8, false),
            Ok(vec![0.25, -0.25, 0.5, -0.5])
        );
        assert_eq!(decode_chunk(&data, 24, 8, 8, false), Ok(vec![0.25, -0.25]));
        // A size past the data is clamped to it.
        assert_eq!(decode_chunk(&data, 0, 64, 8, false).unwrap().len(), 4);
        assert_eq!(decode_chunk(&[], 0, 0, 8, false), Ok(Vec::new()));

        assert!(decode_chunk(&data, 0, 16, 8, true).is_err());
        assert!(decode_chunk(&data, 0, 16, 4, false).is_err());
        assert!(decode_chunk(&data, 0, 16, -8, false).is_err());
        assert!(decode_chunk(&data, 0, 12, 8, false).is_err());
        assert!(decode_chunk(&[], 0, 16, 8, false).is_err());
    }

    #[test]
    fn system_audio_linux_accepts_only_the_requested_format() {
        assert_eq!(check_negotiated_format(true, 48_000, 2), Ok(()));
        let Err(SystemAudioFailure::UnsupportedFormat(message)) =
            check_negotiated_format(true, 44_100, 2)
        else {
            panic!("44.1 kHz is refused");
        };
        assert_eq!(
            message,
            "PipeWire negotiated 32-bit float at 44100 Hz with 2 channels; system audio needs 32-bit float at 48000 Hz with 2 channels"
        );
        assert!(check_negotiated_format(false, 48_000, 2).is_err());
        assert!(check_negotiated_format(true, 48_000, 6).is_err());
    }

    #[test]
    fn system_audio_linux_names_what_start_still_lacks() {
        assert_eq!(
            readiness_gap(false, false),
            Some("the capture stream did not connect")
        );
        assert_eq!(
            readiness_gap(true, false),
            Some("the capture stream exposed no left and right input ports")
        );
        assert_eq!(readiness_gap(true, true), None);
    }

    #[test]
    fn system_audio_linux_errors_classify_by_phase() {
        assert_eq!(
            core_failure(SystemAudioPhase::Starting, -libc::EPIPE, " broken "),
            SystemAudioFailure::StartFailed("PipeWire connection failed: broken".into())
        );
        assert_eq!(
            core_failure(SystemAudioPhase::Running, -libc::EPIPE, "broken"),
            SystemAudioFailure::StreamStopped("PipeWire connection lost: broken".into())
        );
        let SystemAudioFailure::StartFailed(refused) =
            core_failure(SystemAudioPhase::Starting, -libc::EACCES, "")
        else {
            panic!("a refusal is a start failure, not a permission prompt");
        };
        assert!(
            refused.starts_with("PipeWire refused access to the audio graph: "),
            "{refused}"
        );
        assert!(refused.len() > "PipeWire refused access to the audio graph: ".len());

        assert_eq!(
            stream_failure(
                SystemAudioPhase::Running,
                &StreamCondition::Error("no node".into())
            ),
            Some(SystemAudioFailure::StreamStopped(
                "the PipeWire capture stream failed: no node".into()
            ))
        );
        assert_eq!(
            stream_failure(SystemAudioPhase::Starting, &StreamCondition::Unconnected),
            Some(SystemAudioFailure::StartFailed(
                "the PipeWire capture stream disconnected".into()
            ))
        );
        assert_eq!(
            stream_failure(SystemAudioPhase::Running, &StreamCondition::Ready),
            None
        );
        assert_eq!(
            stream_failure(SystemAudioPhase::Starting, &StreamCondition::Connecting),
            None
        );
    }

    #[test]
    fn system_audio_linux_root_prefers_the_electron_main_pid() {
        let current = 9_000;
        assert_eq!(
            ExclusionRoot::resolve(Some(" 4242 "), Some(5_000), current),
            ExclusionRoot {
                process_id: 4_242,
                source: ExclusionRootSource::ElectronMain,
            }
        );
        assert!(ExclusionRoot::resolve(Some("4242"), None, current).names_electron_main());

        // Unset, garbage, init, or our own pid: the parent.
        for env in [
            None,
            Some(""),
            Some("electron"),
            Some("0"),
            Some("1"),
            Some("9000"),
        ] {
            assert_eq!(
                ExclusionRoot::resolve(env, Some(5_000), current),
                ExclusionRoot {
                    process_id: 5_000,
                    source: ExclusionRootSource::ParentProcess,
                },
                "{env:?}"
            );
        }
        assert!(!ExclusionRoot::resolve(None, Some(5_000), current).names_electron_main());

        // No usable parent either: only this process is excluded.
        for parent in [None, Some(0), Some(1), Some(current)] {
            assert_eq!(
                ExclusionRoot::resolve(None, parent, current),
                ExclusionRoot {
                    process_id: current,
                    source: ExclusionRootSource::CurrentProcess,
                },
                "{parent:?}"
            );
        }
    }

    #[test]
    fn system_audio_linux_anchor_matches_instant() {
        let anchor = sample_anchor();
        let now = Instant::now();
        let mapped = anchor.instant_for_host_nanos(monotonic_nanos());
        let skew = if mapped > now {
            mapped - now
        } else {
            now - mapped
        };
        assert!(skew < Duration::from_millis(5), "skew {skew:?}");
    }

    #[test]
    fn system_audio_linux_frame_follows_the_bus_clock_convention() {
        // A CLOCK_MONOTONIC anchor: host nanos 7 s maps to `base`.
        let base = Instant::now() + Duration::from_secs(10);
        let anchor = HostClockAnchor {
            host_nanos: 7_000_000_000,
            instant: base,
        };
        // A 10 ms cycle (480 frames) that ended 110 ms after the anchor.
        let starts = measured_starts(7_110_000_000, &[480]);
        assert_eq!(starts, vec![7_100_000_000]);
        let mut timeline = DeviceTimeline::default();
        let placed = timeline.place(starts[0], 480);
        let frame = system_audio_frame(vec![0.0; 960], placed, &anchor);
        assert_eq!(frame.sample_rate, 48_000);
        assert_eq!(frame.channels, 2);
        assert_eq!(frame.frame_count(), 480);
        assert_eq!(frame.timestamp_micros, 7_100_000);
        // `captured_at` is the END of the buffer.
        assert_eq!(frame.captured_at, base + Duration::from_millis(110));
        assert_eq!(
            frame.captured_at - frame.duration(),
            base + Duration::from_millis(100)
        );
    }
}

/// Live capture checks (plan 212). Each plays a short tone with `paplay`
/// into a null sink this test loads and unloads, so nothing reaches the
/// speakers. A player waits for a line on its stdin (the explicit trigger),
/// so capture is running before the tone starts; nothing waits on a fixed
/// sleep, and every child is killed and reaped on the way out.
///
/// Run on a Linux box with PipeWire and pipewire-pulse:
/// `VIDEORC_SYSTEM_AUDIO_SPIKE=1 cargo test -p videorc-backend
/// system_audio_linux_live -- --ignored --nocapture --test-threads=1`.
#[cfg(test)]
mod live {
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::audio::AudioFrame;
    use crate::system_audio_capture::{
        SYSTEM_AUDIO_QUEUE_CAPACITY, SystemAudioCapture, SystemAudioCaptureOptions,
    };

    const TONE_AMPLITUDE: f64 = 0.25; // -12 dBFS in the file
    const TONE_SECONDS: f64 = 1.5;
    const TONE_FADE_SECONDS: f64 = 0.02;
    /// Bound on `paplay` start plus playback.
    const PLAYER_DEADLINE: Duration = Duration::from_secs(20);
    /// Buffers captured just before the player exited are still in flight.
    const CAPTURE_TAIL: Duration = Duration::from_millis(500);

    fn spike_enabled() -> bool {
        if std::env::var("VIDEORC_SYSTEM_AUDIO_SPIKE").as_deref() == Ok("1") {
            return true;
        }
        eprintln!("VIDEORC_SYSTEM_AUDIO_SPIKE != 1; skipping the live capture test");
        false
    }

    fn write_tone_wav(path: &Path, hz: f64) {
        let rate = SYSTEM_AUDIO_SAMPLE_RATE;
        let frames = (TONE_SECONDS * f64::from(rate)) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        // Raised-cosine fades: an abrupt start or end is a broadband click
        // that would show at every frequency the tests measure.
        let fade = (TONE_FADE_SECONDS * f64::from(rate)) as usize;
        for index in 0..frames {
            let edge = index.min(frames - 1 - index);
            let gain = if edge < fade {
                0.5 - 0.5 * (std::f64::consts::PI * edge as f64 / fade as f64).cos()
            } else {
                1.0
            };
            let value = gain
                * TONE_AMPLITUDE
                * (2.0 * std::f64::consts::PI * hz * index as f64 / f64::from(rate)).sin();
            let value = (value * 32_767.0) as i16;
            samples.extend_from_slice(&[value, value]);
        }
        let data_bytes = (samples.len() * 2) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2 * 2).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, out).expect("write tone wav");
    }

    fn tone_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "videorc-system-audio-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("tone dir");
        dir
    }

    /// A null sink owned by this test, unloaded by its module id on drop.
    struct NullSink {
        name: String,
        module: String,
    }

    impl NullSink {
        fn load() -> Self {
            let name = format!("vrc_probe_sink_{}", std::process::id());
            let output = Command::new("pactl")
                .args([
                    "load-module",
                    "module-null-sink",
                    &format!("sink_name={name}"),
                ])
                .output()
                .expect("run pactl");
            assert!(
                output.status.success(),
                "pactl load-module failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let module = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            assert!(
                module.parse::<u32>().is_ok(),
                "pactl printed a module id (got {module:?})"
            );
            Self { name, module }
        }
    }

    impl Drop for NullSink {
        fn drop(&mut self) {
            let _ = Command::new("pactl")
                .args(["unload-module", &self.module])
                .status();
        }
    }

    /// An owned child that is killed and reaped on drop, panics included.
    struct OwnedChild(Child);

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A shell that becomes `paplay` into `sink` once it reads a line on
    /// stdin. `exec` keeps the pid, so the player's stream reports it.
    fn spawn_gated_player(sink: &NullSink, wav: &Path) -> OwnedChild {
        OwnedChild(
            Command::new("sh")
                .args([
                    "-c",
                    "read _ && exec paplay --device=\"$0\" \"$1\"",
                    &sink.name,
                    wav.to_str().expect("utf-8 tone path"),
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .expect("spawn the paplay tone player"),
        )
    }

    fn trigger(player: &mut OwnedChild) {
        let mut stdin = player.0.stdin.take().expect("player stdin");
        writeln!(stdin).expect("trigger the tone player");
        // Dropping `stdin` closes the pipe.
    }

    /// Starts capture excluding `root`'s tree, triggers every player, and
    /// collects frames until they all exit (plus a short tail).
    fn capture_while_playing(root: ExclusionRoot, players: &mut [OwnedChild]) -> Vec<AudioFrame> {
        // RUST_LOG=videorc_backend=debug shows each stream's decision.
        if std::env::var_os("RUST_LOG").is_some() {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
                .with_test_writer()
                .try_init();
        }
        let requested = Instant::now();
        let mut capture = SystemAudioCapture::start(SystemAudioCaptureOptions {
            root,
            queue_capacity: SYSTEM_AUDIO_QUEUE_CAPACITY,
        })
        .unwrap_or_else(|failure| panic!("system audio start failed: {failure:?}"));
        eprintln!(
            "started in {:?} (handle {:?}); {:?}",
            capture.info().start_latency,
            requested.elapsed(),
            capture.info()
        );
        let receiver = capture.take_receiver().expect("receiver");
        assert!(
            capture.take_receiver().is_none(),
            "the receiver is take-once"
        );

        for player in players.iter_mut() {
            trigger(player);
        }
        let deadline = Instant::now() + PLAYER_DEADLINE;
        let mut frames = Vec::new();
        let mut exited = vec![false; players.len()];
        let mut all_exited_at: Option<Instant> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => frames.push(frame),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            for (player, exited) in players.iter_mut().zip(exited.iter_mut()) {
                if *exited {
                    continue;
                }
                match player.0.try_wait() {
                    Ok(Some(status)) => {
                        assert!(status.success(), "the tone player failed: {status}");
                        *exited = true;
                    }
                    Ok(None) => {}
                    Err(error) => panic!("could not poll the tone player: {error}"),
                }
            }
            if all_exited_at.is_none() && exited.iter().all(|exited| *exited) {
                all_exited_at = Some(Instant::now());
            }
            if all_exited_at.is_some_and(|at| at.elapsed() >= CAPTURE_TAIL) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the tone players did not finish within {PLAYER_DEADLINE:?}"
            );
        }
        let stats = capture.stats();
        assert_eq!(capture.failure(), None, "no failure while running");
        assert!(capture.stop(), "stop finishes within the budget");
        let drained = receiver.try_iter().count();
        assert!(
            matches!(
                receiver.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Disconnected)
            ),
            "the channel disconnects after stop"
        );
        eprintln!(
            "{} buffers, stats {stats:?}, {drained} drained after stop",
            frames.len()
        );
        assert_eq!(stats.rejected_buffers, 0);
        for frame in &frames {
            assert_eq!(frame.sample_rate, 48_000);
            assert_eq!(frame.channels, 2);
            assert!(
                frame.captured_at <= Instant::now(),
                "captured_at is never in the future"
            );
        }
        assert!(
            frames
                .windows(2)
                .all(|pair| pair[1].timestamp_micros > pair[0].timestamp_micros),
            "timestamps increase"
        );
        frames
    }

    /// Amplitude of the `hz` component of `samples` (Goertzel over a Hann
    /// window, scaled by the window's sum so a full-scale tone reads 1.0).
    fn tone_amplitude(samples: &[f32], hz: f64) -> f64 {
        let n = samples.len();
        if n < 2 {
            return 0.0;
        }
        let coefficient =
            2.0 * (2.0 * std::f64::consts::PI * hz / f64::from(SYSTEM_AUDIO_SAMPLE_RATE)).cos();
        let (mut previous, mut before, mut weight) = (0.0f64, 0.0f64, 0.0f64);
        for (index, sample) in samples.iter().enumerate() {
            let hann =
                0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / (n - 1) as f64).cos();
            weight += hann;
            let current = hann * f64::from(*sample) + coefficient * previous - before;
            before = previous;
            previous = current;
        }
        let power = previous * previous + before * before - coefficient * previous * before;
        2.0 * power.max(0.0).sqrt() / weight
    }

    /// The loudest `hz` component of the left channel over 100 ms windows
    /// hopping 50 ms, in dBFS. Per buffer with no window, a tone 500 Hz away
    /// leaks into the measure at about -30 dB, which is not exclusion
    /// evidence either way; a Hann window over 100 ms keeps it far below
    /// -60 dBFS while a leaked buffer of the measured tone still shows.
    fn best_tone_dbfs(frames: &[AudioFrame], hz: f64) -> f64 {
        const WINDOW: usize = 4_800;
        const HOP: usize = 2_400;
        let left: Vec<f32> = frames
            .iter()
            .flat_map(|frame| frame.samples.chunks_exact(2).map(|pair| pair[0]))
            .collect();
        let best = if left.len() <= WINDOW {
            tone_amplitude(&left, hz)
        } else {
            (0..=left.len() - WINDOW)
                .step_by(HOP)
                .map(|start| tone_amplitude(&left[start..start + WINDOW], hz))
                .fold(0.0f64, f64::max)
        };
        if best <= 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * best.log10()
        }
    }

    #[test]
    #[ignore = "Linux box: plays a tone into a null sink, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_linux_live_tone() {
        if !spike_enabled() {
            return;
        }
        let sink = NullSink::load();
        let dir = tone_dir("tone");
        let tone = dir.join("tone-1k.wav");
        write_tone_wav(&tone, 1_000.0);
        // An idle, never-triggered player is the exclusion root, so the real
        // player (a sibling, not a descendant) is captured.
        let root_holder = spawn_gated_player(&sink, &tone);
        let mut players = [spawn_gated_player(&sink, &tone)];
        let frames = capture_while_playing(
            ExclusionRoot {
                process_id: root_holder.0.id(),
                source: ExclusionRootSource::ElectronMain,
            },
            &mut players,
        );
        drop(root_holder);
        drop(players);
        drop(sink);
        let _ = std::fs::remove_dir_all(&dir);
        let tone_dbfs = best_tone_dbfs(&frames, 1_000.0);
        eprintln!("1 kHz tone {tone_dbfs:.1} dBFS");
        assert!(
            tone_dbfs > -30.0,
            "the paplay tone reached the capture above -30 dBFS (got {tone_dbfs:.1})"
        );
    }

    #[test]
    #[ignore = "Linux box: plays a tone into a null sink, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_linux_live_excludes_the_root_tree() {
        if !spike_enabled() {
            return;
        }
        const OWN_HZ: f64 = 1_250.0;
        const FOREIGN_HZ: f64 = 1_750.0;
        let sink = NullSink::load();
        let dir = tone_dir("excluded");
        let own_tone = dir.join("tone-own.wav");
        let foreign_tone = dir.join("tone-foreign.wav");
        write_tone_wav(&own_tone, OWN_HZ);
        write_tone_wav(&foreign_tone, FOREIGN_HZ);
        // The first player IS the exclusion root, as the Electron main
        // process is for Videorc's own sounds: its tone must not reach the
        // capture, while a foreign player's tone, at the same time, does.
        let mut players = [
            spawn_gated_player(&sink, &own_tone),
            spawn_gated_player(&sink, &foreign_tone),
        ];
        let root = ExclusionRoot {
            process_id: players[0].0.id(),
            source: ExclusionRootSource::ElectronMain,
        };
        let frames = capture_while_playing(root, &mut players);
        drop(players);
        drop(sink);
        let _ = std::fs::remove_dir_all(&dir);
        let own_dbfs = best_tone_dbfs(&frames, OWN_HZ);
        let foreign_dbfs = best_tone_dbfs(&frames, FOREIGN_HZ);
        eprintln!(
            "excluded {OWN_HZ} Hz tone {own_dbfs:.1} dBFS, foreign {FOREIGN_HZ} Hz tone {foreign_dbfs:.1} dBFS"
        );
        assert!(
            foreign_dbfs > -30.0,
            "the foreign tone reached the capture above -30 dBFS (got {foreign_dbfs:.1})"
        );
        assert!(
            own_dbfs < -60.0,
            "the excluded tree's tone leaked into the capture ({own_dbfs:.1} dBFS)"
        );
    }
}
