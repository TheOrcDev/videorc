//! macOS system audio capture through ScreenCaptureKit (plan 069).
//!
//! [`SystemAudioCapture`] owns one audio-only `SCStream` on its own dispatch
//! queue and turns every audio `CMSampleBuffer` into a 48 kHz stereo
//! interleaved f32 [`AudioFrame`] on a bounded channel. S4 wraps it as the
//! session audio bus's System slot producer.
//!
//! Contract for the consumer:
//! - [`SystemAudioCapture::start`] blocks for up to [`SYSTEM_AUDIO_START_BUDGET`]
//!   (shareable-content discovery plus `startCapture`). Call it from a blocking
//!   context, never from an async task directly.
//! - Frames: `timestamp_micros` is the first sample's PTS on the host clock;
//!   `captured_at` is the `Instant` at the END of the buffer (the convention
//!   `SourceClock::new` and `trim_audio_frame_before_epoch` read).
//! - Silence is not loss (decision 11). SCK may deliver zero buffers or no
//!   buffers while nothing plays; this producer has no silence watchdog.
//! - Loss is explicit: [`SystemAudioCapture::failure`] turns `Some` when the
//!   stream stops with an error, and the frame channel then disconnects. A
//!   disconnect with no failure means the capture was stopped on purpose.
//! - [`SystemAudioCapture::stop`] and `Drop` are bounded by
//!   [`SYSTEM_AUDIO_STOP_BUDGET`]; they never block forever.
//!
//! Own-app exclusion (decision 9 as amended by S0): the filter excludes the
//! backend's parent process (the Electron main app) by pid, plus any app whose
//! bundle id is the packaged Videorc id or one of its children. That only
//! silences renderer audio because the Electron main process runs with
//! `--disable-features=AudioServiceOutOfProcess` on macOS.
//!
//! Evidence and numbers: `docs/acceptance/2026-09-27-system-audio-spike.md`.
//!
//! Windows (S8): the platform-neutral half of this module (the constants,
//! health kinds, [`SystemAudioFailure`], [`SystemAudioFailureSlot`],
//! [`SystemAudioCaptureStats`], [`HostClockAnchor`] and
//! [`system_audio_frame`]) also compiles on Windows, where
//! `system_audio_capture_windows.rs` implements the same
//! [`SystemAudioCapture`] API over WASAPI process loopback and is re-exported
//! from here, so consumers import one path on both platforms. The
//! ScreenCaptureKit half is `cfg(target_os = "macos")`.
//!
//! Linux (plan 212): the same shared half compiles on Linux, where
//! `system_audio_capture_linux.rs` implements [`SystemAudioCapture`] over a
//! PipeWire capture stream linked to every playback stream, and is
//! re-exported from here the same way.

// The ScreenCaptureKit conversion helpers stay compiled (and unit-tested) on
// Windows and Linux, where only the shared half is used.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::AudioFrame;
use crate::protocol::DeviceStatus;

/// SCK is asked for 48 kHz stereo (`setSampleRate`, `setChannelCount`) and
/// delivered exactly that in S0; the bus consumes the same shape.
pub(crate) const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;
pub(crate) const SYSTEM_AUDIO_CHANNELS: u16 = 2;

/// Frames channel depth. SCK delivers 960-frame (20 ms) buffers, so 64 is
/// 1.28 s of audio: enough to ride out S0's 665 ms startup burst.
pub(crate) const SYSTEM_AUDIO_QUEUE_CAPACITY: usize = 64;

/// How long `SCShareableContent` discovery may take before start gives up.
const SHAREABLE_CONTENT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `startCapture` may take. S0 measured 109 to 189 ms, once 737 ms.
const START_CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `stopCapture` may take before the owner stops waiting for it.
const STOP_CAPTURE_TIMEOUT: Duration = Duration::from_secs(2);
/// The caller's bound on [`SystemAudioCapture::start`].
pub(crate) const SYSTEM_AUDIO_START_BUDGET: Duration = Duration::from_secs(12);
/// The caller's bound on [`SystemAudioCapture::stop`] and `Drop`.
pub(crate) const SYSTEM_AUDIO_STOP_BUDGET: Duration = Duration::from_secs(3);

/// `health.event` kind when system audio cannot start this session (the
/// Screen Recording grant is missing, or the stream failed to start).
pub(crate) const SYSTEM_AUDIO_UNAVAILABLE_HEALTH_KIND: &str = "system-audio-unavailable";
/// `health.event` kind when a running system-audio stream stops. The session
/// keeps running on the microphone.
pub(crate) const SYSTEM_AUDIO_LOST_HEALTH_KIND: &str = "system-audio-lost";

/// Bundle id of the packaged app (`apps/desktop/electron-builder.yml`
/// `appId`). Its helpers are `dev.theorcdev.videorc.helper[.GPU|.Plugin|
/// .Renderer]`.
pub(crate) const PACKAGED_VIDEORC_BUNDLE_ID: &str = "dev.theorcdev.videorc";

/// `SCStreamErrorDomain` and the codes the classifier needs (`SCError.h`).
/// Kept local so the mapping stays pure and testable.
const SC_STREAM_ERROR_DOMAIN: &str = "com.apple.ScreenCaptureKit.SCStreamErrorDomain";
const SC_STREAM_ERROR_USER_DECLINED: isize = -3801;

// AudioStreamBasicDescription constants (CoreAudioBaseTypes.h). Kept local so
// the conversion helpers stay pure and testable without CoreAudio.
const AUDIO_FORMAT_LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
const AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN: u32 = 1 << 1;
const AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER: u32 = 1 << 2;
const AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED: u32 = 1 << 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PcmSampleKind {
    F32,
    I16,
    I32,
}

impl PcmSampleKind {
    fn bytes(self) -> usize {
        match self {
            Self::F32 | Self::I32 => 4,
            Self::I16 => 2,
        }
    }
}

/// The PCM shape of one ScreenCaptureKit audio sample buffer, taken from its
/// `AudioStreamBasicDescription`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PcmLayout {
    pub(crate) sample_rate: f64,
    pub(crate) channels: u32,
    pub(crate) kind: PcmSampleKind,
    /// `kAudioFormatFlagIsNonInterleaved`: one AudioBuffer per channel.
    pub(crate) planar: bool,
}

/// Classifies an `AudioStreamBasicDescription`. S0 measured SCK delivering
/// `lpcm`, flags `0x29` (float | packed | non-interleaved), 32 bits, 2
/// channels, 48000 Hz; other linear PCM shapes are accepted defensively.
pub(crate) fn pcm_layout_from_stream_description(
    format_id: u32,
    format_flags: u32,
    bits_per_channel: u32,
    channels: u32,
    sample_rate: f64,
) -> Result<PcmLayout, String> {
    if format_id != AUDIO_FORMAT_LINEAR_PCM {
        return Err(format!(
            "system audio format {} is not linear PCM",
            four_char_code(format_id)
        ));
    }
    if format_flags & AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN != 0 {
        return Err("system audio is big-endian PCM".to_string());
    }
    if channels == 0 {
        return Err("system audio reports zero channels".to_string());
    }
    if !(sample_rate.is_finite() && sample_rate > 0.0) {
        return Err(format!("system audio sample rate {sample_rate} is invalid"));
    }
    let is_float = format_flags & AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
    let is_signed = format_flags & AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0;
    let kind = match (is_float, is_signed, bits_per_channel) {
        (true, _, 32) => PcmSampleKind::F32,
        (false, true, 16) => PcmSampleKind::I16,
        (false, true, 32) => PcmSampleKind::I32,
        _ => {
            return Err(format!(
                "unsupported system audio PCM: flags {format_flags:#x}, {bits_per_channel} bits"
            ));
        }
    };
    Ok(PcmLayout {
        sample_rate,
        channels,
        kind,
        planar: format_flags & AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED != 0,
    })
}

/// Converts the AudioBuffers of one sample buffer (one per channel when
/// planar, one interleaved buffer otherwise) into interleaved stereo f32 at
/// the source rate. Mono is duplicated to both sides, channels past the
/// second are dropped. A rate other than 48 kHz is rejected: S0 never saw
/// one, so resampling is added only if a real device ever proves it necessary.
pub(crate) fn interleaved_stereo_f32(
    layout: &PcmLayout,
    buffers: &[&[u8]],
) -> Result<Vec<f32>, String> {
    if (layout.sample_rate - f64::from(SYSTEM_AUDIO_SAMPLE_RATE)).abs() > 0.5 {
        return Err(format!(
            "system audio arrived at {} Hz, expected {SYSTEM_AUDIO_SAMPLE_RATE}",
            layout.sample_rate
        ));
    }
    let channels = layout.channels as usize;
    let sample_bytes = layout.kind.bytes();
    let (frames, sample_at): (usize, Box<dyn Fn(usize, usize) -> f32 + '_>) = if layout.planar {
        if buffers.len() < channels {
            return Err(format!(
                "planar system audio has {} buffers for {channels} channels",
                buffers.len()
            ));
        }
        let frames = buffers[..channels]
            .iter()
            .map(|buffer| buffer.len() / sample_bytes)
            .min()
            .unwrap_or(0);
        let kind = layout.kind;
        (
            frames,
            Box::new(move |frame, channel| {
                decode_sample(kind, &buffers[channel][frame * sample_bytes..])
            }),
        )
    } else {
        let Some(buffer) = buffers.first() else {
            return Err("interleaved system audio has no buffer".to_string());
        };
        let frame_bytes = sample_bytes * channels;
        let kind = layout.kind;
        (
            buffer.len() / frame_bytes,
            Box::new(move |frame, channel| {
                decode_sample(
                    kind,
                    &buffer[frame * frame_bytes + channel * sample_bytes..],
                )
            }),
        )
    };
    let right_channel = if channels >= 2 { 1 } else { 0 };
    let mut output = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        output.push(sample_at(frame, 0));
        output.push(sample_at(frame, right_channel));
    }
    Ok(output)
}

fn decode_sample(kind: PcmSampleKind, bytes: &[u8]) -> f32 {
    match kind {
        PcmSampleKind::F32 => f32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        PcmSampleKind::I16 => f32::from(i16::from_ne_bytes([bytes[0], bytes[1]])) / 32_768.0,
        PcmSampleKind::I32 => {
            i32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0
        }
    }
}

fn four_char_code(code: u32) -> String {
    let bytes = code.to_be_bytes();
    if bytes.iter().all(|byte| byte.is_ascii_graphic()) {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        format!("{code:#x}")
    }
}

/// `mach_timebase_info` ratio. Apple Silicon reports 125/3 (24 MHz ticks);
/// Intel reports 1/1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MachTimebase {
    pub(crate) numer: u32,
    pub(crate) denom: u32,
}

impl MachTimebase {
    pub(crate) fn ticks_to_nanos(self, ticks: u64) -> u64 {
        if self.denom == 0 {
            return ticks;
        }
        let nanos = u128::from(ticks) * u128::from(self.numer) / u128::from(self.denom);
        u64::try_from(nanos).unwrap_or(u64::MAX)
    }
}

/// Host-clock nanoseconds for a CMSampleBuffer PTS. SCK stamps audio and
/// screen buffers on the CoreMedia host time clock (`CMClockGetHostTimeClock`),
/// whose seconds are `mach_absolute_time` converted through the timebase. S0
/// measured both audio and screen PTS at timescale 1_000_000_000.
/// Returns `None` for an invalid or non-positive time.
pub(crate) fn cm_time_to_host_nanos(value: i64, timescale: i32, valid: bool) -> Option<u64> {
    if !valid || timescale <= 0 || value < 0 {
        return None;
    }
    let nanos = i128::from(value) * 1_000_000_000 / i128::from(timescale);
    u64::try_from(nanos).ok()
}

/// One simultaneous reading of the host clock and `Instant`. On macOS
/// `Instant` is `CLOCK_UPTIME_RAW`, the same counter as `mach_absolute_time`,
/// so the offset between them is constant and one anchor per stream is
/// enough; the anchor only has to be read with a small bracket.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HostClockAnchor {
    pub(crate) host_nanos: u64,
    pub(crate) instant: Instant,
}

impl HostClockAnchor {
    /// The `Instant` at which the host clock read `host_nanos`.
    pub(crate) fn instant_for_host_nanos(&self, host_nanos: u64) -> Instant {
        if host_nanos >= self.host_nanos {
            self.instant + Duration::from_nanos(host_nanos - self.host_nanos)
        } else {
            let back = Duration::from_nanos(self.host_nanos - host_nanos);
            self.instant.checked_sub(back).unwrap_or(self.instant)
        }
    }

    /// `AudioFrame::captured_at` for a buffer: the bus treats `captured_at`
    /// as the END of the frame (`trim_audio_frame_before_epoch`), so this is
    /// PTS (first sample) plus the buffer duration.
    pub(crate) fn buffer_end_instant(
        &self,
        pts_host_nanos: u64,
        frames: usize,
        sample_rate: u32,
    ) -> Instant {
        let duration_nanos = if sample_rate == 0 {
            0
        } else {
            (frames as u64).saturating_mul(1_000_000_000) / u64::from(sample_rate)
        };
        self.instant_for_host_nanos(pts_host_nanos.saturating_add(duration_nanos))
    }
}

/// Builds the bus frame for one converted SCK buffer: `samples` is
/// interleaved stereo at 48 kHz, `pts_host_nanos` is the first sample's PTS.
/// `timestamp_micros` stays on the host clock (it advances by exact sample
/// counts, S0 Q7), and `captured_at` is the buffer END, like the mic path.
pub(crate) fn system_audio_frame(
    samples: Vec<f32>,
    pts_host_nanos: u64,
    anchor: &HostClockAnchor,
) -> AudioFrame {
    let frames = samples.len() / usize::from(SYSTEM_AUDIO_CHANNELS);
    AudioFrame {
        timestamp_micros: pts_host_nanos / 1_000,
        captured_at: anchor.buffer_end_instant(pts_host_nanos, frames, SYSTEM_AUDIO_SAMPLE_RATE),
        sample_rate: SYSTEM_AUDIO_SAMPLE_RATE,
        channels: SYSTEM_AUDIO_CHANNELS,
        samples,
    }
}

#[cfg(target_os = "macos")]
mod host_clock {
    use super::{HostClockAnchor, MachTimebase};
    use std::time::{Duration, Instant};

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
        fn mach_absolute_time() -> u64;
    }

    pub(crate) fn timebase() -> Option<MachTimebase> {
        let mut info = Timebase { numer: 0, denom: 0 };
        let status = unsafe { mach_timebase_info(&mut info) };
        (status == 0 && info.denom != 0).then_some(MachTimebase {
            numer: info.numer,
            denom: info.denom,
        })
    }

    pub(crate) fn host_nanos_now(timebase: MachTimebase) -> u64 {
        timebase.ticks_to_nanos(unsafe { mach_absolute_time() })
    }

    /// Reads an anchor with the host read bracketed by two `Instant`s,
    /// retrying until the bracket is under 50 µs.
    pub(crate) fn sample_anchor(timebase: MachTimebase) -> HostClockAnchor {
        let mut best: Option<(HostClockAnchor, Duration)> = None;
        for _ in 0..5 {
            let before = Instant::now();
            let host_nanos = host_nanos_now(timebase);
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
}

/// True when `bundle_id` is `prefix` or one of its dotted children:
/// `dev.theorcdev.videorc` matches itself and `dev.theorcdev.videorc.helper.GPU`
/// but not `dev.theorcdev.videorcweb`.
pub(crate) fn bundle_id_matches_prefix(bundle_id: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    bundle_id == prefix
        || bundle_id
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Which running applications the system-audio filter excludes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppExclusion {
    pub(crate) bundle_prefixes: Vec<String>,
    pub(crate) pids: Vec<i32>,
}

impl AppExclusion {
    /// Videorc's own apps: the backend's parent (the Electron main process,
    /// which spawns the backend directly; `com.github.Electron` in `pnpm
    /// dev`) by pid, plus the packaged bundle id and its children as a
    /// fallback. The dev Electron bundle id is deliberately NOT a prefix: it
    /// would mute every unrelated Electron dev app. A parent pid of 1 or less
    /// means the backend was orphaned or launched standalone; it names no app.
    pub(crate) fn videorc(parent_pid: i32) -> Self {
        Self {
            bundle_prefixes: vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()],
            pids: if parent_pid > 1 {
                vec![parent_pid]
            } else {
                Vec::new()
            },
        }
    }

    /// Indices into `applications` (bundle id, pid) to pass to
    /// `initWithDisplay:excludingApplications:exceptingWindows:`.
    pub(crate) fn matching_indices<'a>(
        &self,
        applications: impl IntoIterator<Item = (&'a str, i32)>,
    ) -> Vec<usize> {
        excluded_application_indices(applications, &self.bundle_prefixes, &self.pids)
    }
}

/// Indices of the running applications whose bundle id matches one of
/// `prefixes`, or whose pid is in `pids`.
///
/// S0 proved app exclusion only silences audio the excluded app's OWN
/// process plays. Chromium's default out-of-process audio service (a
/// `.helper` utility process that SCK does not list) escapes it, so this
/// list is only sufficient while Electron runs with
/// `--disable-features=AudioServiceOutOfProcess` (renderer audio then plays
/// from the main process).
pub(crate) fn excluded_application_indices<'a>(
    applications: impl IntoIterator<Item = (&'a str, i32)>,
    prefixes: &[String],
    pids: &[i32],
) -> Vec<usize> {
    applications
        .into_iter()
        .enumerate()
        .filter(|(_, (bundle_id, pid))| {
            pids.contains(pid)
                || prefixes
                    .iter()
                    .any(|prefix| bundle_id_matches_prefix(bundle_id, prefix))
        })
        .map(|(index, _)| index)
        .collect()
}

/// Why system audio stopped or never started. Every failure is terminal: once
/// one is recorded the producer delivers no more frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SystemAudioFailure {
    /// The Screen Recording grant is missing (preflight false, or SCK
    /// declined at start).
    PermissionDenied(String),
    /// Discovery or `startCapture` failed or timed out.
    StartFailed(String),
    /// A running stream stopped (`stream:didStopWithError:`), including a
    /// grant revoked mid-session and "Stop sharing" from the menu bar.
    StreamStopped(String),
    /// SCK delivered audio this producer cannot convert (not 48 kHz linear
    /// PCM). S0 never saw it; it is explicit rather than silent.
    UnsupportedFormat(String),
}

/// When an error was reported, for [`classify_capture_error`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemAudioPhase {
    Starting,
    Running,
}

impl SystemAudioFailure {
    /// The `health.event` kind S4 emits for this failure.
    pub(crate) fn health_kind(&self) -> &'static str {
        match self {
            Self::PermissionDenied(_) | Self::StartFailed(_) => {
                SYSTEM_AUDIO_UNAVAILABLE_HEALTH_KIND
            }
            Self::StreamStopped(_) | Self::UnsupportedFormat(_) => SYSTEM_AUDIO_LOST_HEALTH_KIND,
        }
    }

    /// What this failure proves about the system-audio device row, if
    /// anything. A stopped stream proves nothing about the device: the
    /// platform probe (`devices.rs`) stays the authority.
    pub(crate) fn device_status(&self) -> Option<DeviceStatus> {
        match self {
            Self::PermissionDenied(_) => Some(DeviceStatus::PermissionRequired),
            Self::StartFailed(_) | Self::UnsupportedFormat(_) => Some(DeviceStatus::Unavailable),
            Self::StreamStopped(_) => None,
        }
    }

    /// The technical detail for logs and Diagnostics (not user copy).
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::PermissionDenied(message)
            | Self::StartFailed(message)
            | Self::StreamStopped(message)
            | Self::UnsupportedFormat(message) => message,
        }
    }
}

impl std::fmt::Display for SystemAudioFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

/// Maps an `NSError` from ScreenCaptureKit to a failure. At start, a declined
/// grant (`SCStreamErrorUserDeclined`, or TCC wording from discovery) is a
/// permission failure; anything else is a start failure. Once running, every
/// error is a lost stream.
pub(crate) fn classify_capture_error(
    phase: SystemAudioPhase,
    domain: &str,
    code: isize,
    description: &str,
) -> SystemAudioFailure {
    let message = format!("{description} ({domain} {code})");
    match phase {
        SystemAudioPhase::Running => SystemAudioFailure::StreamStopped(message),
        SystemAudioPhase::Starting => {
            let declined =
                domain == SC_STREAM_ERROR_DOMAIN && code == SC_STREAM_ERROR_USER_DECLINED;
            if declined || mentions_permission(description) {
                SystemAudioFailure::PermissionDenied(message)
            } else {
                SystemAudioFailure::StartFailed(message)
            }
        }
    }
}

fn mentions_permission(description: &str) -> bool {
    let normalized = description.to_lowercase();
    ["permission", "denied", "not authorized", "tcc", "declined"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

/// Shared, first-wins failure record. The capture writes it from SCK
/// callbacks; the consumer polls it.
///
/// The same failure is mirrored as text into a
/// [`crate::session_audio::ProducerFailure`], the slot the session audio bus
/// polls to retire a lost system source (S4). Both are written under the
/// typed slot's lock, before the frame channel disconnects, so the bus always
/// reads the reason together with the loss.
#[derive(Debug, Clone, Default)]
pub(crate) struct SystemAudioFailureSlot {
    failure: Arc<Mutex<Option<SystemAudioFailure>>>,
    reason: crate::session_audio::ProducerFailure,
}

impl SystemAudioFailureSlot {
    pub(crate) fn get(&self) -> Option<SystemAudioFailure> {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Records `failure` unless one is already recorded. Returns whether it
    /// was recorded.
    pub(crate) fn record(&self, failure: SystemAudioFailure) -> bool {
        let mut slot = self.failure.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return false;
        }
        *self.reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(failure.to_string());
        *slot = Some(failure);
        true
    }

    /// The bus-facing view of this slot: `Some(reason)` once a failure is
    /// recorded.
    pub(crate) fn producer_failure(&self) -> crate::session_audio::ProducerFailure {
        Arc::clone(&self.reason)
    }
}

/// A single bad SCK buffer (no valid PTS, an unreadable buffer list, a format
/// that cannot convert) is counted and dropped, not a terminal loss (PR #477
/// review). Only a sustained run of bad buffers with no good one between them
/// fails the capture: this many in a row (about 1 s of 20 ms buffers), or a
/// run of at least two that has lasted [`BAD_BUFFER_LOSS_AFTER`].
pub(crate) const BAD_BUFFER_LOSS_COUNT: u32 = 50;
pub(crate) const BAD_BUFFER_LOSS_AFTER: Duration = Duration::from_secs(1);

/// The current run of consecutive bad buffers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct BadBufferRun {
    consecutive: u32,
    since: Option<Instant>,
}

impl BadBufferRun {
    /// A buffer converted (or was empty): the run is over.
    pub(crate) fn good(&mut self) {
        *self = Self::default();
    }

    /// Counts a bad buffer that arrived at `now`. Returns true once the run
    /// is sustained enough to be a loss.
    pub(crate) fn bad(&mut self, now: Instant) -> bool {
        self.consecutive = self.consecutive.saturating_add(1);
        let since = *self.since.get_or_insert(now);
        self.consecutive >= BAD_BUFFER_LOSS_COUNT
            || (self.consecutive >= 2
                && now.saturating_duration_since(since) >= BAD_BUFFER_LOSS_AFTER)
    }
}

/// What a `startCapture` completion does. The owner waits a bounded time for
/// it; once that wait gave up (the start was abandoned), a late success must
/// stop the stream itself, or it would keep capturing with nobody reading it
/// (Off must mean not captured, decision 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartCompletion {
    /// The owner is still waiting: hand it the result.
    Report,
    /// Abandoned, but the stream started: stop it.
    StopStream,
    /// Abandoned and the start failed: nothing is running.
    Ignore,
}

pub(crate) fn start_completion(abandoned: bool, started: bool) -> StartCompletion {
    match (abandoned, started) {
        (false, _) => StartCompletion::Report,
        (true, true) => StartCompletion::StopStream,
        (true, false) => StartCompletion::Ignore,
    }
}

/// Snapshot of the producer counters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SystemAudioCaptureStats {
    /// Frames (per channel) converted from SCK buffers.
    pub(crate) captured_frames: u64,
    /// Frames dropped because the consumer's channel was full.
    pub(crate) dropped_frames: u64,
    /// SCK buffers that could not be converted.
    pub(crate) rejected_buffers: u64,
}

/// The screen-capture preflight that also covers system audio ("Screen &
/// System Audio Recording"). It neither prompts nor starts a stream.
/// `devices.rs` (S1) makes the same call for the device row.
#[cfg(target_os = "macos")]
pub(crate) fn screen_recording_permission_granted() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

/// The backend's parent pid: the Electron main process in the app.
#[cfg(target_os = "macos")]
pub(crate) fn parent_pid() -> i32 {
    // SAFETY: getppid has no preconditions and cannot fail.
    unsafe { libc::getppid() }
}

#[cfg(target_os = "macos")]
pub(crate) use capture::{SystemAudioCapture, SystemAudioCaptureOptions};

#[cfg(windows)]
pub(crate) use crate::system_audio_capture_windows::{
    SystemAudioCapture, SystemAudioCaptureOptions,
};

#[cfg(target_os = "linux")]
pub(crate) use crate::system_audio_capture_linux::{SystemAudioCapture, SystemAudioCaptureOptions};

#[cfg(target_os = "macos")]
mod capture {
    use std::ptr::{self, NonNull};
    use std::slice;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use dispatch2::{DispatchQueue, DispatchRetained};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
    use objc2_core_foundation::CFRetained;
    use objc2_core_graphics::CGMainDisplayID;
    use objc2_core_media::{
        CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
        CMTimeFlags, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration,
        SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
    };

    use super::*;
    use crate::audio::{AudioCaptureStats, AudioFrame};

    /// Options for [`SystemAudioCapture::start`].
    #[derive(Debug, Clone)]
    pub(crate) struct SystemAudioCaptureOptions {
        pub(crate) exclusion: AppExclusion,
        pub(crate) queue_capacity: usize,
    }

    impl Default for SystemAudioCaptureOptions {
        fn default() -> Self {
            Self {
                exclusion: AppExclusion::videorc(parent_pid()),
                queue_capacity: SYSTEM_AUDIO_QUEUE_CAPACITY,
            }
        }
    }

    /// What the running stream excludes, for diagnostics.
    #[derive(Debug, Clone, Default)]
    pub(crate) struct SystemAudioCaptureInfo {
        /// (bundle id, pid) of every excluded application.
        pub(crate) excluded_apps: Vec<(String, i32)>,
        /// Whether a pid named by the exclusion (the Electron main process)
        /// was found and excluded. False means Videorc's own audio may leak.
        pub(crate) pid_excluded: bool,
        pub(crate) start_latency: Duration,
    }

    /// State shared by the SCK callbacks and the consumer handle.
    struct CaptureShared {
        sender: Mutex<Option<mpsc::SyncSender<AudioFrame>>>,
        stats: Arc<AudioCaptureStats>,
        rejected_buffers: AtomicU64,
        bad_buffers: Mutex<BadBufferRun>,
        failure: SystemAudioFailureSlot,
        /// Set before a deliberate stop so late callbacks are ignored and a
        /// stop error is not reported as loss.
        stopping: AtomicBool,
        anchor: HostClockAnchor,
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

        /// Records a terminal failure, stops accepting buffers, and
        /// disconnects the frame channel. The failure is stored before the
        /// disconnect, so a consumer that sees the disconnect can read it.
        fn fail(&self, failure: SystemAudioFailure) {
            if self.failure.record(failure.clone()) {
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

    struct DelegateIvars {
        shared: Arc<CaptureShared>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[name = "VideorcSystemAudioCaptureDelegate"]
        #[ivars = DelegateIvars]
        struct SystemAudioDelegate;

        unsafe impl NSObjectProtocol for SystemAudioDelegate {}

        #[allow(non_snake_case)]
        unsafe impl SCStreamOutput for SystemAudioDelegate {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_didOutputSampleBuffer_ofType(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                output_type: SCStreamOutputType,
            ) {
                let shared = &self.ivars().shared;
                if output_type != SCStreamOutputType::Audio
                    || shared.stopping.load(Ordering::Acquire)
                {
                    return;
                }
                match audio_frame_from_sample_buffer(sample_buffer, &shared.anchor) {
                    Ok(frame) => {
                        shared
                            .bad_buffers
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .good();
                        if let Some(frame) = frame {
                            shared.push(frame);
                        }
                    }
                    Err(error) => {
                        // One bad buffer is dropped and counted; only a
                        // sustained run is a loss.
                        let rejected = shared.rejected_buffers.fetch_add(1, Ordering::Relaxed);
                        let sustained = shared
                            .bad_buffers
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .bad(Instant::now());
                        if sustained {
                            shared.fail(SystemAudioFailure::UnsupportedFormat(error));
                        } else if rejected == 0 {
                            tracing::warn!(reason = %error, "System audio dropped a bad buffer");
                        }
                    }
                }
            }
        }

        #[allow(non_snake_case)]
        unsafe impl SCStreamDelegate for SystemAudioDelegate {
            #[unsafe(method(stream:didStopWithError:))]
            unsafe fn stream_didStopWithError(&self, _stream: &SCStream, error: &NSError) {
                let shared = &self.ivars().shared;
                if shared.stopping.load(Ordering::Acquire) {
                    return;
                }
                shared.fail(failure_from_ns_error(SystemAudioPhase::Running, error));
            }
        }
    );

    impl SystemAudioDelegate {
        fn new(shared: Arc<CaptureShared>) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(DelegateIvars { shared });
            unsafe { msg_send![super(delegate), init] }
        }
    }

    fn failure_from_ns_error(phase: SystemAudioPhase, error: &NSError) -> SystemAudioFailure {
        classify_capture_error(
            phase,
            &error.domain().to_string(),
            error.code(),
            &error.localizedDescription().to_string(),
        )
    }

    /// Converts one SCK audio buffer. `Ok(None)` is an empty buffer.
    fn audio_frame_from_sample_buffer(
        sample_buffer: &CMSampleBuffer,
        anchor: &HostClockAnchor,
    ) -> Result<Option<AudioFrame>, String> {
        let pts = unsafe { sample_buffer.presentation_time_stamp() };
        let pts_host_nanos = cm_time_to_host_nanos(
            pts.value,
            pts.timescale,
            pts.flags.contains(CMTimeFlags::Valid),
        )
        .ok_or("system audio buffer has no valid PTS")?;
        let description = unsafe { sample_buffer.format_description() }
            .ok_or("system audio buffer has no format description")?;
        let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description) };
        let asbd = unsafe { asbd.as_ref() }.ok_or("system audio format has no ASBD")?;
        let layout = pcm_layout_from_stream_description(
            asbd.mFormatID,
            asbd.mFormatFlags,
            asbd.mBitsPerChannel,
            asbd.mChannelsPerFrame,
            asbd.mSampleRate,
        )?;

        let mut size_needed = 0usize;
        let status = unsafe {
            sample_buffer.audio_buffer_list_with_retained_block_buffer(
                &mut size_needed,
                ptr::null_mut(),
                0,
                None,
                None,
                0,
                ptr::null_mut(),
            )
        };
        if status != 0 || size_needed == 0 {
            return Err(format!(
                "system audio buffer list size query failed: {status}"
            ));
        }
        // u64 backing keeps the AudioBufferList pointer-aligned.
        let mut storage = vec![0u64; size_needed.div_ceil(8)];
        let list = storage.as_mut_ptr().cast::<AudioBufferList>();
        let mut block: *mut CMBlockBuffer = ptr::null_mut();
        let status = unsafe {
            sample_buffer.audio_buffer_list_with_retained_block_buffer(
                ptr::null_mut(),
                list,
                size_needed,
                None,
                None,
                kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                &mut block,
            )
        };
        // Owns the retained block buffer (the sample memory) for this call.
        let _block = NonNull::new(block).map(|raw| unsafe { CFRetained::from_raw(raw) });
        if status != 0 {
            return Err(format!("system audio buffer list read failed: {status}"));
        }
        let buffer_count = unsafe { (*list).mNumberBuffers } as usize;
        let audio_buffers: &[AudioBuffer] = unsafe {
            slice::from_raw_parts(
                ptr::addr_of!((*list).mBuffers).cast::<AudioBuffer>(),
                buffer_count,
            )
        };
        let byte_slices: Vec<&[u8]> = audio_buffers
            .iter()
            .map(|buffer| {
                if buffer.mData.is_null() {
                    &[][..]
                } else {
                    unsafe {
                        slice::from_raw_parts(
                            buffer.mData.cast::<u8>(),
                            buffer.mDataByteSize as usize,
                        )
                    }
                }
            })
            .collect();
        let samples = interleaved_stereo_f32(&layout, &byte_slices)?;
        if samples.is_empty() {
            return Ok(None);
        }
        Ok(Some(system_audio_frame(samples, pts_host_nanos, anchor)))
    }

    /// A running system-audio capture. Dropping it stops the stream (bounded).
    ///
    /// All ScreenCaptureKit objects live on a dedicated owner thread, so this
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
        /// Starts an audio-only SCStream on the main display. Blocks for up to
        /// [`SYSTEM_AUDIO_START_BUDGET`]; the first frame usually arrives 100
        /// to 300 ms later (S0 saw up to ~840 ms, sometimes as a burst).
        pub(crate) fn start(
            options: SystemAudioCaptureOptions,
        ) -> Result<Self, SystemAudioFailure> {
            if !screen_recording_permission_granted() {
                return Err(SystemAudioFailure::PermissionDenied(
                    "Screen Recording (Screen & System Audio Recording) is not granted".into(),
                ));
            }
            let timebase = host_clock::timebase().ok_or_else(|| {
                SystemAudioFailure::StartFailed("mach_timebase_info is unavailable".into())
            })?;
            let (sender, receiver) = mpsc::sync_channel(options.queue_capacity.max(1));
            let shared = Arc::new(CaptureShared {
                sender: Mutex::new(Some(sender)),
                stats: Arc::new(AudioCaptureStats::default()),
                rejected_buffers: AtomicU64::new(0),
                bad_buffers: Mutex::new(BadBufferRun::default()),
                failure: SystemAudioFailureSlot::default(),
                stopping: AtomicBool::new(false),
                anchor: host_clock::sample_anchor(timebase),
            });
            let (startup_tx, startup_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (done_tx, done_rx) = mpsc::channel::<()>();
            let owner_shared = Arc::clone(&shared);
            let owner = thread::Builder::new()
                .name("system-audio-owner".into())
                .spawn(move || {
                    run_owner(&options, &owner_shared, &startup_tx, &stop_rx);
                    let _ = done_tx.send(());
                })
                .map_err(|error| {
                    SystemAudioFailure::StartFailed(format!(
                        "could not spawn the system audio owner: {error}"
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
                        excluded_apps = ?info.excluded_apps,
                        pid_excluded = info.pid_excluded,
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
            // On every Err path `capture` drops here: the owner is told to
            // stop and cleans up whatever it managed to start (bounded).
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
        /// Returns false if the owner did not finish in time (it is then
        /// left to finish on its own).
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
                // Never block forever: detach the owner; it still stops the
                // stream and releases it when SCK answers.
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

    struct Session {
        stream: Retained<SCStream>,
        delegate: Retained<SystemAudioDelegate>,
        _filter: Retained<SCContentFilter>,
        _configuration: Retained<SCStreamConfiguration>,
        _queue: DispatchRetained<DispatchQueue>,
    }

    impl Session {
        /// Stops capture (bounded) and removes the output. Runs on the owner.
        fn shutdown(self, shared: &CaptureShared) {
            shared.stopping.store(true, Ordering::Release);
            autoreleasepool(|_| {
                if let Err(error) = stop_capture(&self.stream) {
                    tracing::warn!(reason = %error, "System audio stopCapture did not complete");
                }
                unsafe {
                    let _ = self.stream.removeStreamOutput_type_error(
                        ProtocolObject::from_ref(&*self.delegate),
                        SCStreamOutputType::Audio,
                    );
                }
            });
            shared.close();
        }
    }

    fn run_owner(
        options: &SystemAudioCaptureOptions,
        shared: &Arc<CaptureShared>,
        startup_tx: &mpsc::Sender<Result<SystemAudioCaptureInfo, SystemAudioFailure>>,
        stop_rx: &mpsc::Receiver<()>,
    ) {
        let opened = autoreleasepool(|_| open_session(options, shared));
        match opened {
            Ok((session, info)) => {
                let _ = startup_tx.send(Ok(info));
                // Returns on stop, or at once when the handle is gone (a
                // start timeout or a dropped capture).
                let _ = stop_rx.recv();
                session.shutdown(shared);
            }
            Err(failure) => {
                shared.failure.record(failure.clone());
                shared.close();
                let _ = startup_tx.send(Err(failure));
            }
        }
    }

    fn open_session(
        options: &SystemAudioCaptureOptions,
        shared: &Arc<CaptureShared>,
    ) -> Result<(Session, SystemAudioCaptureInfo), SystemAudioFailure> {
        let content = shareable_content()?;
        let main_display_id = CGMainDisplayID();
        let displays = unsafe { content.displays() };
        let display = (0..displays.count())
            .map(|index| displays.objectAtIndex(index))
            .find(|display| unsafe { display.displayID() } == main_display_id)
            .or_else(|| (displays.count() > 0).then(|| displays.objectAtIndex(0)))
            .ok_or_else(|| {
                SystemAudioFailure::StartFailed("ScreenCaptureKit lists no display".into())
            })?;

        let applications = unsafe { content.applications() };
        let listed: Vec<(String, i32)> = (0..applications.count())
            .map(|index| {
                let app = applications.objectAtIndex(index);
                unsafe { (app.bundleIdentifier().to_string(), app.processID()) }
            })
            .collect();
        let indices = options
            .exclusion
            .matching_indices(listed.iter().map(|(id, pid)| (id.as_str(), *pid)));
        let excluded: Vec<Retained<SCRunningApplication>> = indices
            .iter()
            .map(|&index| applications.objectAtIndex(index))
            .collect();
        let excluded_apps: Vec<(String, i32)> =
            indices.iter().map(|&index| listed[index].clone()).collect();
        let pid_excluded = options
            .exclusion
            .pids
            .iter()
            .any(|pid| excluded_apps.iter().any(|(_, excluded)| excluded == pid));
        if !options.exclusion.pids.is_empty() && !pid_excluded {
            tracing::warn!(
                pids = ?options.exclusion.pids,
                "System audio could not find the Videorc app to exclude; its own audio may be captured"
            );
        }

        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::from_retained_slice(&excluded),
                &NSArray::<SCWindow>::new(),
            )
        };
        // Audio only: a 2x2 px, 1 fps video config and no Screen output.
        // `setCaptureMicrophone` is deliberately not called (macOS 15+ only).
        let configuration = unsafe { SCStreamConfiguration::new() };
        unsafe {
            configuration.setWidth(2);
            configuration.setHeight(2);
            configuration.setMinimumFrameInterval(CMTime::new(1, 1));
            configuration.setQueueDepth(3);
            configuration.setShowsCursor(false);
            configuration.setCapturesAudio(true);
            configuration.setExcludesCurrentProcessAudio(true);
            configuration.setSampleRate(SYSTEM_AUDIO_SAMPLE_RATE as isize);
            configuration.setChannelCount(SYSTEM_AUDIO_CHANNELS as isize);
        }
        let delegate = SystemAudioDelegate::new(Arc::clone(shared));
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(ProtocolObject::from_ref(&*delegate)),
            )
        };
        let queue = DispatchQueue::new("dev.theorcdev.videorc.system-audio", None);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*delegate),
                SCStreamOutputType::Audio,
                Some(&queue),
            )
        }
        .map_err(|error| failure_from_ns_error(SystemAudioPhase::Starting, &error))?;
        let session = Session {
            stream,
            delegate,
            _filter: filter,
            _configuration: configuration,
            _queue: queue,
        };

        let started = Instant::now();
        if let Err(failure) = start_capture(&session.stream) {
            // A timed-out start may still complete later; stop it anyway.
            session.shutdown(shared);
            return Err(failure);
        }
        Ok((
            session,
            SystemAudioCaptureInfo {
                excluded_apps,
                pid_excluded,
                start_latency: started.elapsed(),
            },
        ))
    }

    struct SendContent(Retained<SCShareableContent>);
    // SAFETY: the retained SCShareableContent is only moved from the
    // completion-handler thread to the waiting owner thread, never shared.
    unsafe impl Send for SendContent {}

    fn shareable_content() -> Result<Retained<SCShareableContent>, SystemAudioFailure> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = match unsafe { error.as_ref() } {
                    Some(error) => Err(failure_from_ns_error(SystemAudioPhase::Starting, error)),
                    None => unsafe { Retained::retain(content) }
                        .map(SendContent)
                        .ok_or_else(|| {
                            SystemAudioFailure::StartFailed(
                                "ScreenCaptureKit returned no shareable content".into(),
                            )
                        }),
                };
                let _ = tx.send(result);
            },
        );
        // All apps, not only on-screen ones: the Electron main app must be
        // listed even with every window hidden.
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false, false, &handler,
            );
        }
        rx.recv_timeout(SHAREABLE_CONTENT_TIMEOUT)
            .map_err(|_| {
                SystemAudioFailure::StartFailed("ScreenCaptureKit discovery timed out".into())
            })?
            .map(|content| content.0)
    }

    fn start_capture(stream: &Retained<SCStream>) -> Result<(), SystemAudioFailure> {
        let (tx, rx) = mpsc::channel();
        let abandoned = Arc::new(AtomicBool::new(false));
        let handler_abandoned = Arc::clone(&abandoned);
        // The handler holds its own reference, so a start that completes
        // after the owner gave up can still stop the stream it started.
        let handler_stream = Retained::clone(stream);
        let handler = RcBlock::new(move |error: *mut NSError| {
            let error = unsafe { error.as_ref() };
            match start_completion(handler_abandoned.load(Ordering::Acquire), error.is_none()) {
                StartCompletion::Report => {
                    let _ = tx.send(match error {
                        Some(error) => {
                            Err(failure_from_ns_error(SystemAudioPhase::Starting, error))
                        }
                        None => Ok(()),
                    });
                }
                StartCompletion::StopStream => {
                    tracing::warn!(
                        "System audio startCapture completed after its timeout; stopping it."
                    );
                    // Fire and forget: nothing waits on this thread, and the
                    // delegate already ignores its buffers (`stopping`).
                    unsafe { handler_stream.stopCaptureWithCompletionHandler(None) };
                }
                StartCompletion::Ignore => {}
            }
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };
        match rx.recv_timeout(START_CAPTURE_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                // Mark it before the caller's stopCapture: a completion that
                // lands after that stop (which then had nothing to stop)
                // stops the stream itself.
                abandoned.store(true, Ordering::Release);
                // A completion that raced the timeout already reported: the
                // stream is running, and the caller's stopCapture stops it.
                Err(SystemAudioFailure::StartFailed(
                    "ScreenCaptureKit startCapture timed out".into(),
                ))
            }
        }
    }

    fn stop_capture(stream: &SCStream) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(
                unsafe { error.as_ref() }
                    .map(|error| format!("{} ({})", error.localizedDescription(), error.code())),
            );
        });
        unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        match rx.recv_timeout(STOP_CAPTURE_TIMEOUT) {
            Ok(None) => Ok(()),
            Ok(Some(error)) => Err(error),
            Err(_) => Err("timed out".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_ne_bytes()).collect()
    }

    #[test]
    fn system_audio_layout_accepts_the_shape_sck_delivered_in_s0() {
        // lpcm, flags 0x29 = float | packed | non-interleaved, 32 bits.
        let layout =
            pcm_layout_from_stream_description(u32::from_be_bytes(*b"lpcm"), 0x29, 32, 2, 48_000.0)
                .expect("SCK's float planar stereo is supported");
        assert_eq!(
            layout,
            PcmLayout {
                sample_rate: 48_000.0,
                channels: 2,
                kind: PcmSampleKind::F32,
                planar: true,
            }
        );
    }

    #[test]
    fn system_audio_layout_classifies_integer_and_rejects_others() {
        let lpcm = u32::from_be_bytes(*b"lpcm");
        let i16_layout = pcm_layout_from_stream_description(lpcm, 0x0c, 16, 2, 48_000.0)
            .expect("signed 16-bit interleaved");
        assert_eq!(i16_layout.kind, PcmSampleKind::I16);
        assert!(!i16_layout.planar);
        assert_eq!(
            pcm_layout_from_stream_description(lpcm, 0x0c, 32, 1, 48_000.0)
                .expect("signed 32-bit")
                .kind,
            PcmSampleKind::I32
        );
        assert!(
            pcm_layout_from_stream_description(u32::from_be_bytes(*b"aac "), 0, 0, 2, 48_000.0)
                .is_err()
        );
        assert!(pcm_layout_from_stream_description(lpcm, 0x0e, 16, 2, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x08, 16, 2, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x29, 32, 0, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x29, 32, 2, 0.0).is_err());
    }

    #[test]
    fn system_audio_planar_float_interleaves_left_right() {
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            channels: 2,
            kind: PcmSampleKind::F32,
            planar: true,
        };
        let left = f32_bytes(&[0.1, 0.2, 0.3]);
        let right = f32_bytes(&[-0.1, -0.2, -0.3]);
        let output = interleaved_stereo_f32(&layout, &[&left, &right]).expect("converts");
        assert_eq!(output, vec![0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn system_audio_mono_is_duplicated_and_extra_channels_dropped() {
        let mono = PcmLayout {
            sample_rate: 48_000.0,
            channels: 1,
            kind: PcmSampleKind::F32,
            planar: false,
        };
        let samples = f32_bytes(&[0.5, -0.25]);
        assert_eq!(
            interleaved_stereo_f32(&mono, &[&samples]).expect("mono"),
            vec![0.5, 0.5, -0.25, -0.25]
        );

        let quad = PcmLayout {
            sample_rate: 48_000.0,
            channels: 4,
            kind: PcmSampleKind::F32,
            planar: false,
        };
        let samples = f32_bytes(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        assert_eq!(
            interleaved_stereo_f32(&quad, &[&samples]).expect("quad"),
            vec![0.1, 0.2, 0.5, 0.6]
        );
    }

    #[test]
    fn system_audio_integer_samples_scale_to_unit_float() {
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            channels: 2,
            kind: PcmSampleKind::I16,
            planar: false,
        };
        let bytes: Vec<u8> = [i16::MIN, i16::MAX, 0, 16_384]
            .iter()
            .flat_map(|s| s.to_ne_bytes())
            .collect();
        let output = interleaved_stereo_f32(&layout, &[&bytes]).expect("converts");
        assert_eq!(output[0], -1.0);
        assert!((output[1] - 1.0).abs() < 1.0e-4);
        assert_eq!(output[2], 0.0);
        assert_eq!(output[3], 0.5);
    }

    #[test]
    fn system_audio_rejects_other_rates_and_short_planar_lists() {
        let layout = PcmLayout {
            sample_rate: 44_100.0,
            channels: 2,
            kind: PcmSampleKind::F32,
            planar: true,
        };
        let left = f32_bytes(&[0.0]);
        assert!(interleaved_stereo_f32(&layout, &[&left, &left]).is_err());
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            ..layout
        };
        assert!(interleaved_stereo_f32(&layout, &[&left]).is_err());
        assert!(interleaved_stereo_f32(&layout, &[]).is_err());
    }

    #[test]
    fn system_audio_host_time_conversions() {
        let apple_silicon = MachTimebase {
            numer: 125,
            denom: 3,
        };
        assert_eq!(apple_silicon.ticks_to_nanos(24_000_000), 1_000_000_000);
        assert_eq!(MachTimebase { numer: 1, denom: 1 }.ticks_to_nanos(42), 42);

        // S0 saw timescale 1e9 for audio and screen; other timescales convert too.
        assert_eq!(
            cm_time_to_host_nanos(48_000 * 3 + 24_000, 48_000, true),
            Some(3_500_000_000)
        );
        assert_eq!(
            cm_time_to_host_nanos(1_234_567_890, 1_000_000_000, true),
            Some(1_234_567_890)
        );
        assert_eq!(cm_time_to_host_nanos(10, 48_000, false), None);
        assert_eq!(cm_time_to_host_nanos(10, 0, true), None);
        assert_eq!(cm_time_to_host_nanos(-1, 48_000, true), None);
    }

    #[test]
    fn system_audio_anchor_maps_host_time_to_instant_both_directions() {
        let base = Instant::now() + Duration::from_secs(10);
        let anchor = HostClockAnchor {
            host_nanos: 5_000_000_000,
            instant: base,
        };
        assert_eq!(
            anchor.instant_for_host_nanos(5_250_000_000),
            base + Duration::from_millis(250)
        );
        assert_eq!(
            anchor.instant_for_host_nanos(4_900_000_000),
            base - Duration::from_millis(100)
        );
        // 480 frames at 48 kHz end 10 ms after the PTS of the first sample.
        assert_eq!(
            anchor.buffer_end_instant(5_000_000_000, 480, 48_000),
            base + Duration::from_millis(10)
        );
        assert_eq!(
            anchor.buffer_end_instant(5_000_000_000, 480, 0),
            base,
            "a zero rate never panics"
        );
    }

    #[test]
    fn system_audio_frame_follows_the_bus_clock_convention() {
        let base = Instant::now() + Duration::from_secs(10);
        let anchor = HostClockAnchor {
            host_nanos: 7_000_000_000,
            instant: base,
        };
        // One S0-shaped buffer: 960 frames (20 ms), PTS 100 ms after the anchor.
        let pts = 7_100_000_000;
        let frame = system_audio_frame(vec![0.25; 960 * 2], pts, &anchor);
        assert_eq!(frame.sample_rate, 48_000);
        assert_eq!(frame.channels, 2);
        assert_eq!(frame.frame_count(), 960);
        assert_eq!(frame.timestamp_micros, 7_100_000);
        assert_eq!(frame.captured_at, base + Duration::from_millis(120));
        // `SourceClock::new` recovers the first sample's instant as
        // `captured_at - duration()`: that must be the PTS instant.
        let start = frame.captured_at - frame.duration();
        let pts_instant = anchor.instant_for_host_nanos(pts);
        let skew = if start > pts_instant {
            start - pts_instant
        } else {
            pts_instant - start
        };
        assert!(skew <= Duration::from_micros(1), "skew {skew:?}");
        // Consecutive buffers advance `timestamp_micros` by exactly 20 ms.
        let next = system_audio_frame(vec![0.0; 960 * 2], pts + 20_000_000, &anchor);
        assert_eq!(next.timestamp_micros - frame.timestamp_micros, 20_000);
        assert_eq!(
            next.captured_at - frame.captured_at,
            Duration::from_millis(20)
        );
    }

    #[test]
    fn system_audio_bundle_prefix_matches_only_dotted_children() {
        let prefix = PACKAGED_VIDEORC_BUNDLE_ID;
        assert!(bundle_id_matches_prefix("dev.theorcdev.videorc", prefix));
        assert!(bundle_id_matches_prefix(
            "dev.theorcdev.videorc.helper.Renderer",
            prefix
        ));
        assert!(!bundle_id_matches_prefix(
            "dev.theorcdev.videorcweb",
            prefix
        ));
        assert!(!bundle_id_matches_prefix("com.google.Chrome", prefix));
        assert!(!bundle_id_matches_prefix("anything", ""));
    }

    #[test]
    fn system_audio_videorc_exclusion_names_the_parent_pid_and_the_packaged_id() {
        assert_eq!(
            AppExclusion::videorc(4242),
            AppExclusion {
                bundle_prefixes: vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()],
                pids: vec![4242],
            }
        );
        // Orphaned (launchd) or unknown parents name no app.
        assert!(AppExclusion::videorc(1).pids.is_empty());
        assert!(AppExclusion::videorc(0).pids.is_empty());
    }

    #[test]
    fn system_audio_exclusion_list_matches_the_s0_fixture() {
        // S0 saw SCShareableContent list only bundle MAIN processes (Chrome's
        // and Electron's `.helper` processes were absent). Helper ids stay in
        // the fixture so a macOS that does list them is still covered.
        let running = [
            ("com.apple.finder", 501),
            ("dev.theorcdev.videorc", 1000),
            ("dev.theorcdev.videorc.helper", 1001),
            ("dev.theorcdev.videorc.helper.Renderer", 1002),
            ("dev.theorcdev.videorc.helper.GPU", 1003),
            ("com.google.Chrome", 2000),
            ("com.google.Chrome.helper", 2001),
            ("com.github.Electron", 3000),
            ("com.github.Electron.helper", 3001),
            ("dev.theorcdev.videorcweb", 4000),
            ("", 5000),
            ("com.github.Electron", 6000),
        ];
        // Packaged app: its main process is the parent; the prefix also
        // catches its helpers and any second packaged instance.
        assert_eq!(
            AppExclusion::videorc(1000).matching_indices(running),
            vec![1, 2, 3, 4]
        );
        // `pnpm dev`: the parent is the dev Electron (pid 3000). Only that
        // process is excluded, not the unrelated Electron dev app (pid 6000).
        assert_eq!(
            AppExclusion::videorc(3000).matching_indices(running),
            vec![1, 2, 3, 4, 7]
        );
        // A parent without a bundle id is still excluded by pid.
        assert_eq!(
            AppExclusion::videorc(5000).matching_indices(running),
            vec![1, 2, 3, 4, 10]
        );
        // Standalone backend: only the packaged prefix applies.
        assert_eq!(
            AppExclusion::videorc(1).matching_indices(running),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn system_audio_errors_classify_by_phase_and_permission() {
        let declined = classify_capture_error(
            SystemAudioPhase::Starting,
            SC_STREAM_ERROR_DOMAIN,
            SC_STREAM_ERROR_USER_DECLINED,
            "The user declined TCCs for application, window, display capture",
        );
        assert!(matches!(declined, SystemAudioFailure::PermissionDenied(_)));
        assert!(declined.message().contains("-3801"), "{declined}");

        // TCC wording from discovery counts as permission even off-domain.
        assert!(matches!(
            classify_capture_error(
                SystemAudioPhase::Starting,
                "NSOSStatusErrorDomain",
                -1,
                "Screen recording permission denied"
            ),
            SystemAudioFailure::PermissionDenied(_)
        ));
        assert!(matches!(
            classify_capture_error(
                SystemAudioPhase::Starting,
                SC_STREAM_ERROR_DOMAIN,
                -3818,
                "Failed to start audio capture"
            ),
            SystemAudioFailure::StartFailed(_)
        ));
        // Once running, everything is loss, a revoked grant included.
        assert!(matches!(
            classify_capture_error(
                SystemAudioPhase::Running,
                SC_STREAM_ERROR_DOMAIN,
                SC_STREAM_ERROR_USER_DECLINED,
                "The user declined"
            ),
            SystemAudioFailure::StreamStopped(_)
        ));
        assert!(matches!(
            classify_capture_error(
                SystemAudioPhase::Running,
                SC_STREAM_ERROR_DOMAIN,
                -3821,
                "System stopped the stream"
            ),
            SystemAudioFailure::StreamStopped(_)
        ));
    }

    #[test]
    fn system_audio_failures_map_to_health_kinds_and_device_status() {
        let cases = [
            (
                SystemAudioFailure::PermissionDenied("p".into()),
                "system-audio-unavailable",
                Some(DeviceStatus::PermissionRequired),
            ),
            (
                SystemAudioFailure::StartFailed("s".into()),
                "system-audio-unavailable",
                Some(DeviceStatus::Unavailable),
            ),
            (
                SystemAudioFailure::StreamStopped("x".into()),
                "system-audio-lost",
                None,
            ),
            (
                SystemAudioFailure::UnsupportedFormat("f".into()),
                "system-audio-lost",
                Some(DeviceStatus::Unavailable),
            ),
        ];
        for (failure, kind, status) in cases {
            assert_eq!(failure.health_kind(), kind, "{failure:?}");
            assert_eq!(failure.device_status(), status, "{failure:?}");
        }
    }

    #[test]
    fn system_audio_a_single_bad_buffer_is_dropped_not_a_loss() {
        let start = Instant::now();
        let mut run = BadBufferRun::default();
        // One bad buffer between good ones, over and over, for a minute.
        for index in 0..3_000_u64 {
            let now = start + Duration::from_millis(index * 20);
            if index % 10 == 0 {
                assert!(!run.bad(now), "a lone bad buffer at {index} is not a loss");
            } else {
                run.good();
            }
        }
        // A lone bad buffer followed by silence (no buffers at all) is not
        // a loss either, however long the silence lasts.
        let mut run = BadBufferRun::default();
        assert!(!run.bad(start));
        assert_eq!(run.consecutive, 1);
    }

    #[test]
    fn system_audio_sustained_bad_buffers_become_a_loss() {
        let start = Instant::now();
        let mut run = BadBufferRun::default();
        let terminal = (0..BAD_BUFFER_LOSS_COUNT)
            .map(|index| run.bad(start + Duration::from_millis(u64::from(index))))
            .collect::<Vec<_>>();
        assert!(terminal[..terminal.len() - 1].iter().all(|lost| !lost));
        assert!(
            terminal[terminal.len() - 1],
            "{BAD_BUFFER_LOSS_COUNT} in a row"
        );
        // A slower run: 20 ms buffers, all bad, lose after about 1 s.
        let mut run = BadBufferRun::default();
        let lost_at = (0..100_u64)
            .find(|index| run.bad(start + Duration::from_millis(index * 20)))
            .expect("a sustained run is a loss");
        assert_eq!(lost_at, 49, "at 980 ms the count rule fires first");
        let mut run = BadBufferRun::default();
        assert!(!run.bad(start));
        assert!(
            run.bad(start + BAD_BUFFER_LOSS_AFTER),
            "a run of two lasting 1 s is sustained"
        );
        run.good();
        assert!(
            !run.bad(start + Duration::from_secs(5)),
            "a good buffer resets it"
        );
    }

    #[test]
    fn system_audio_a_start_completing_after_its_timeout_stops_the_stream() {
        assert_eq!(start_completion(false, true), StartCompletion::Report);
        assert_eq!(start_completion(false, false), StartCompletion::Report);
        assert_eq!(
            start_completion(true, true),
            StartCompletion::StopStream,
            "an abandoned start that succeeds must not keep capturing"
        );
        assert_eq!(start_completion(true, false), StartCompletion::Ignore);
    }

    #[test]
    fn system_audio_failure_slot_keeps_the_first_failure() {
        let slot = SystemAudioFailureSlot::default();
        assert_eq!(slot.get(), None);
        assert!(slot.record(SystemAudioFailure::StreamStopped("first".into())));
        assert!(!slot.record(SystemAudioFailure::StartFailed("second".into())));
        let reader = slot.clone();
        assert_eq!(
            reader.get(),
            Some(SystemAudioFailure::StreamStopped("first".into()))
        );
        // The bus reads the same first failure as text.
        assert_eq!(
            reader.producer_failure().lock().unwrap().as_deref(),
            Some("first")
        );
    }

    #[test]
    fn system_audio_failure_slot_mirrors_nothing_until_a_failure() {
        let slot = SystemAudioFailureSlot::default();
        let bus_view = slot.producer_failure();
        assert_eq!(*bus_view.lock().unwrap(), None);
        slot.record(SystemAudioFailure::StreamStopped("revoked".into()));
        assert_eq!(bus_view.lock().unwrap().as_deref(), Some("revoked"));
    }

    #[test]
    fn system_audio_capture_handle_can_be_a_producer_owner() {
        fn assert_send<T: Send + 'static>() {}
        assert_send::<SystemAudioCapture>();
        assert_send::<SystemAudioFailureSlot>();
    }
}

/// Live capture check (plan 069 S3), promoted from the S0 spike. Needs the
/// host terminal's Screen Recording grant and plays a short 1 kHz tone
/// through the current output with `afplay`. Volume, mute and output device
/// are left alone: SCK captures before the master volume (S0 Q4).
///
/// Run: `VIDEORC_SYSTEM_AUDIO_SPIKE=1 cargo test -p videorc-backend
/// system_audio_capture_live -- --ignored --nocapture`.
#[cfg(all(test, target_os = "macos"))]
mod live {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    const TONE_HZ: f64 = 1_000.0;
    const TONE_AMPLITUDE: f64 = 0.25; // -12 dBFS in the file

    fn write_tone_wav(path: &std::path::Path, seconds: f64) {
        let rate = SYSTEM_AUDIO_SAMPLE_RATE;
        let frames = (seconds * f64::from(rate)) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for index in 0..frames {
            let value = (TONE_AMPLITUDE
                * (2.0 * std::f64::consts::PI * TONE_HZ * index as f64 / f64::from(rate)).sin())
                as f32;
            samples.extend_from_slice(&[value, value]);
        }
        let data_bytes = (samples.len() * 4) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2 * 4).to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, out).expect("write tone wav");
    }

    /// Amplitude of the `TONE_HZ` component of the left channel (Goertzel).
    /// Unlike a plain peak it ignores whatever else the Mac is playing.
    fn tone_amplitude(samples: &[f32]) -> f64 {
        let n = samples.len() / 2;
        if n == 0 {
            return 0.0;
        }
        let coefficient = 2.0
            * (2.0 * std::f64::consts::PI * TONE_HZ / f64::from(SYSTEM_AUDIO_SAMPLE_RATE)).cos();
        let (mut previous, mut before) = (0.0f64, 0.0f64);
        for frame in samples.chunks_exact(2) {
            let current = f64::from(frame[0]) + coefficient * previous - before;
            before = previous;
            previous = current;
        }
        let power = previous * previous + before * before - coefficient * previous * before;
        2.0 * power.max(0.0).sqrt() / n as f64
    }

    fn dbfs(amplitude: f64) -> f64 {
        if amplitude <= 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * amplitude.log10()
        }
    }

    #[test]
    #[ignore = "local macOS: needs Screen Recording, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_capture_live_tone() {
        if std::env::var("VIDEORC_SYSTEM_AUDIO_SPIKE").as_deref() != Ok("1") {
            eprintln!("VIDEORC_SYSTEM_AUDIO_SPIKE != 1; skipping the live capture test");
            return;
        }
        assert!(
            screen_recording_permission_granted(),
            "Screen Recording is not granted to the host app of {:?}",
            std::env::current_exe()
        );
        let dir = std::env::temp_dir().join(format!("videorc-system-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tone dir");
        let tone = dir.join("tone-1k.wav");
        write_tone_wav(&tone, 1.5);

        let requested = Instant::now();
        let mut capture = SystemAudioCapture::start(SystemAudioCaptureOptions::default())
            .unwrap_or_else(|failure| panic!("system audio start failed: {failure:?}"));
        eprintln!(
            "started in {:?} (handle {:?}); excluded {:?}",
            capture.info().start_latency,
            requested.elapsed(),
            capture.info().excluded_apps
        );
        let receiver = capture.take_receiver().expect("receiver");
        assert!(
            capture.take_receiver().is_none(),
            "the receiver is take-once"
        );

        // Wait for the first buffer, then play the tone.
        let first = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("a first system audio buffer within 3 s");
        eprintln!(
            "first buffer {:?} after start; {} frames",
            requested.elapsed(),
            first.frame_count()
        );
        let mut player = Command::new("afplay")
            .arg(&tone)
            .spawn()
            .expect("spawn afplay");

        let mut frames = vec![first];
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(frame) => frames.push(frame),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = player.wait();
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
        let _ = std::fs::remove_dir_all(&dir);

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
        let best_tone = frames
            .iter()
            .map(|frame| tone_amplitude(&frame.samples))
            .fold(0.0f64, f64::max);
        let peak = frames
            .iter()
            .flat_map(|frame| frame.samples.iter())
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        eprintln!(
            "{} buffers, stats {stats:?}, {drained} drained after stop; 1 kHz tone {:.1} dBFS, peak {:.1} dBFS",
            frames.len(),
            dbfs(best_tone),
            dbfs(f64::from(peak))
        );
        assert!(stats.captured_frames > 0);
        assert_eq!(stats.rejected_buffers, 0);
        assert!(
            dbfs(best_tone) > -30.0,
            "the afplay tone reached the capture above -30 dBFS (got {:.1})",
            dbfs(best_tone)
        );
    }
}
