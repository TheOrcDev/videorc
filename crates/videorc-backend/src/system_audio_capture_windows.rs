//! Windows system audio capture through WASAPI process loopback (plan 069 S8).
//!
//! [`SystemAudioCapture`] owns one process-loopback `IAudioClient` on its own
//! MTA thread and turns every capture packet into a 48 kHz stereo interleaved
//! f32 [`AudioFrame`] on a bounded channel. It is the Windows twin of the
//! ScreenCaptureKit producer in `system_audio_capture.rs`, with the same
//! public API; that module re-exports it so consumers import one path. S8b
//! wires it into sessions as the bus's System slot producer.
//!
//! Contract for the consumer (identical to macOS):
//! - [`SystemAudioCapture::start`] blocks for up to
//!   [`SYSTEM_AUDIO_START_BUDGET`] (activation, `Initialize`, `Start`). Call it
//!   from a blocking context, never from an async task directly.
//! - Frames: `timestamp_micros` is the first sample's QPC time (the position
//!   `GetBuffer` reports, in µs); `captured_at` is the `Instant` at the END of
//!   the packet (the convention `SourceClock::new` reads).
//! - Silence is not loss (decision 11). Process loopback may deliver no
//!   packets while nothing plays; this producer has no silence watchdog.
//! - Loss is explicit: [`SystemAudioCapture::failure`] turns `Some` when the
//!   stream fails (`AUDCLNT_E_DEVICE_INVALIDATED` or any other capture
//!   error), and the frame channel then disconnects. A disconnect with no
//!   failure means the capture was stopped on purpose.
//! - [`SystemAudioCapture::stop`] and `Drop` are bounded by
//!   [`SYSTEM_AUDIO_STOP_BUDGET`]; they never block forever.
//!
//! Own-app exclusion (decision 9): the loopback client is activated in
//! `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` mode rooted at the
//! Electron main process, whose pid the app passes in
//! `VIDEORC_ELECTRON_MAIN_PID`. Chromium's audio service, the renderers and
//! this backend are all descendants of that process, so every Videorc sound
//! is excluded without the macOS `AudioServiceOutOfProcess` switch.
//!
//! Format: process loopback has no mix format (`GetMixFormat` is not
//! supported on it), so the client asks for 48 kHz stereo IEEE float with
//! `AUTOCONVERTPCM | SRC_DEFAULT_QUALITY`, and the audio engine converts from
//! whatever the endpoints run at. If the engine refuses float, 16-bit PCM at
//! the same rate and layout is tried next (the shape Microsoft's
//! ApplicationLoopback sample uses).

// The pure helpers below are unit-tested on macOS too; only Windows uses
// them at runtime.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::system_audio_capture::{
    SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_SAMPLE_RATE, SystemAudioFailure, SystemAudioPhase,
};

/// Env var the Electron main process sets to its own pid when it spawns the
/// backend (`apps/desktop/src/main/index.ts`). It roots the exclusion tree.
pub(crate) const ELECTRON_MAIN_PID_ENV: &str = "VIDEORC_ELECTRON_MAIN_PID";

// `AUDCLNT_STREAMFLAGS_*` (AudioSessionTypes.h). Kept local so the helpers
// stay testable off Windows; a Windows test pins them to windows-rs.
const STREAM_FLAG_LOOPBACK: u32 = 0x0002_0000;
const STREAM_FLAG_EVENTCALLBACK: u32 = 0x0004_0000;
const STREAM_FLAG_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
const STREAM_FLAG_AUTOCONVERTPCM: u32 = 0x8000_0000;

/// `IAudioClient::Initialize` flags for the loopback client: shared-mode
/// loopback, event-driven, with the engine converting rate and format.
pub(crate) const LOOPBACK_STREAM_FLAGS: u32 = STREAM_FLAG_LOOPBACK
    | STREAM_FLAG_EVENTCALLBACK
    | STREAM_FLAG_AUTOCONVERTPCM
    | STREAM_FLAG_SRC_DEFAULT_QUALITY;

/// Engine buffer requested at `Initialize`, in 100 ns units (100 ms). The
/// event fires per engine period (about 10 ms); the larger buffer is only
/// slack for a late wake-up and adds no latency.
pub(crate) const LOOPBACK_BUFFER_DURATION_HNS: i64 = 1_000_000;

// `_AUDCLNT_BUFFERFLAGS` (Audioclient.h).
pub(crate) const BUFFER_FLAG_DATA_DISCONTINUITY: u32 = 0x1;
pub(crate) const BUFFER_FLAG_SILENT: u32 = 0x2;
pub(crate) const BUFFER_FLAG_TIMESTAMP_ERROR: u32 = 0x4;

// HRESULTs the classifier names (Audioclient.h, winerror.h).
pub(crate) const HRESULT_AUDCLNT_E_DEVICE_INVALIDATED: i32 = 0x8889_0004_u32 as i32;
pub(crate) const HRESULT_AUDCLNT_E_UNSUPPORTED_FORMAT: i32 = 0x8889_0008_u32 as i32;
pub(crate) const HRESULT_AUDCLNT_E_SERVICE_NOT_RUNNING: i32 = 0x8889_0010_u32 as i32;
pub(crate) const HRESULT_AUDCLNT_E_RESOURCES_INVALIDATED: i32 = 0x8889_0026_u32 as i32;
pub(crate) const HRESULT_E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
pub(crate) const HRESULT_E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;
pub(crate) const HRESULT_E_NOTIMPL: i32 = 0x8000_4001_u32 as i32;

// `WAVEFORMATEX::wFormatTag` values (mmreg.h).
pub(crate) const WAVE_FORMAT_PCM_TAG: u16 = 1;
pub(crate) const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;

/// The sample format the loopback client asked the engine for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum LoopbackSampleFormat {
    /// 32-bit IEEE float, the bus's native shape.
    #[default]
    F32,
    /// 16-bit signed PCM, the fallback when the engine refuses float.
    I16,
}

impl LoopbackSampleFormat {
    pub(crate) fn bytes_per_sample(self) -> usize {
        match self {
            Self::F32 => 4,
            Self::I16 => 2,
        }
    }

    /// Bytes per interleaved stereo frame.
    pub(crate) fn block_align(self) -> usize {
        self.bytes_per_sample() * usize::from(SYSTEM_AUDIO_CHANNELS)
    }
}

/// Formats tried at `Initialize`, in order.
pub(crate) const LOOPBACK_FORMAT_LADDER: [LoopbackSampleFormat; 2] =
    [LoopbackSampleFormat::F32, LoopbackSampleFormat::I16];

/// The `WAVEFORMATEX` fields for one ladder rung, as plain values so the
/// arithmetic is testable off Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WaveFormatSpec {
    pub(crate) format_tag: u16,
    pub(crate) channels: u16,
    pub(crate) samples_per_sec: u32,
    pub(crate) avg_bytes_per_sec: u32,
    pub(crate) block_align: u16,
    pub(crate) bits_per_sample: u16,
    pub(crate) extra_bytes: u16,
}

/// 48 kHz stereo in `format`. A plain `WAVEFORMATEX` (no extensible tail):
/// with `AUTOCONVERTPCM` the engine accepts it for any endpoint layout.
pub(crate) fn loopback_wave_format(format: LoopbackSampleFormat) -> WaveFormatSpec {
    let block_align = format.block_align() as u16;
    WaveFormatSpec {
        format_tag: match format {
            LoopbackSampleFormat::F32 => WAVE_FORMAT_IEEE_FLOAT_TAG,
            LoopbackSampleFormat::I16 => WAVE_FORMAT_PCM_TAG,
        },
        channels: SYSTEM_AUDIO_CHANNELS,
        samples_per_sec: SYSTEM_AUDIO_SAMPLE_RATE,
        avg_bytes_per_sec: SYSTEM_AUDIO_SAMPLE_RATE * u32::from(block_align),
        block_align,
        bits_per_sample: (format.bytes_per_sample() * 8) as u16,
        extra_bytes: 0,
    }
}

/// Converts one capture packet of `frames` interleaved stereo frames into
/// f32 samples. `AUDCLNT_BUFFERFLAGS_SILENT` means the data must be treated
/// as silence whatever the pointer holds, so it becomes zeros; `data` may be
/// `None` then. A non-silent packet without enough data is rejected.
pub(crate) fn loopback_packet_samples(
    format: LoopbackSampleFormat,
    frames: u32,
    flags: u32,
    data: Option<&[u8]>,
) -> Result<Vec<f32>, String> {
    let sample_count = frames as usize * usize::from(SYSTEM_AUDIO_CHANNELS);
    if flags & BUFFER_FLAG_SILENT != 0 {
        return Ok(vec![0.0; sample_count]);
    }
    if frames == 0 {
        return Ok(Vec::new());
    }
    let Some(data) = data else {
        return Err(format!(
            "loopback packet of {frames} frames has no data and is not marked silent"
        ));
    };
    let needed = frames as usize * format.block_align();
    if data.len() < needed {
        return Err(format!(
            "loopback packet of {frames} frames has {} bytes, expected {needed}",
            data.len()
        ));
    }
    let bytes = format.bytes_per_sample();
    Ok(data[..needed]
        .chunks_exact(bytes)
        .map(|sample| match format {
            LoopbackSampleFormat::F32 => {
                f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])
            }
            LoopbackSampleFormat::I16 => {
                f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0
            }
        })
        .collect())
}

/// Nanoseconds for a `QueryPerformanceCounter` reading. `None` for a
/// non-positive frequency or a negative reading.
pub(crate) fn qpc_ticks_to_nanos(ticks: i64, frequency: i64) -> Option<u64> {
    if frequency <= 0 || ticks < 0 {
        return None;
    }
    let nanos = i128::from(ticks) * 1_000_000_000 / i128::from(frequency);
    u64::try_from(nanos).ok()
}

/// Host nanoseconds (the QPC clock) at which a packet's first frame was
/// captured. `GetBuffer` reports that instant as QPC in 100 ns units; when it
/// flags a timestamp error (or reports none) the packet is placed so it ends
/// at `now_host_nanos`, the moment it was read.
pub(crate) fn packet_start_host_nanos(
    flags: u32,
    qpc_position_hns: u64,
    now_host_nanos: u64,
    frames: u32,
) -> u64 {
    if flags & BUFFER_FLAG_TIMESTAMP_ERROR == 0 && qpc_position_hns != 0 {
        return qpc_position_hns.saturating_mul(100);
    }
    let duration_nanos =
        u64::from(frames).saturating_mul(1_000_000_000) / u64::from(SYSTEM_AUDIO_SAMPLE_RATE);
    now_host_nanos.saturating_sub(duration_nanos)
}

fn hresult_name(hresult: i32) -> Option<&'static str> {
    Some(match hresult {
        HRESULT_AUDCLNT_E_DEVICE_INVALIDATED => "AUDCLNT_E_DEVICE_INVALIDATED",
        HRESULT_AUDCLNT_E_UNSUPPORTED_FORMAT => "AUDCLNT_E_UNSUPPORTED_FORMAT",
        HRESULT_AUDCLNT_E_SERVICE_NOT_RUNNING => "AUDCLNT_E_SERVICE_NOT_RUNNING",
        HRESULT_AUDCLNT_E_RESOURCES_INVALIDATED => "AUDCLNT_E_RESOURCES_INVALIDATED",
        HRESULT_E_ACCESSDENIED => "E_ACCESSDENIED",
        HRESULT_E_INVALIDARG => "E_INVALIDARG",
        HRESULT_E_NOTIMPL => "E_NOTIMPL",
        _ => return None,
    })
}

/// Maps a WASAPI error to a failure. Anything before the stream runs
/// (activation, `Initialize`, `Start`) is a start failure: Windows has no
/// grant to miss, so it is never `PermissionDenied`. Once running, every
/// error, `AUDCLNT_E_DEVICE_INVALIDATED` included, is a lost stream.
pub(crate) fn classify_loopback_error(
    phase: SystemAudioPhase,
    stage: &str,
    hresult: i32,
    detail: &str,
) -> SystemAudioFailure {
    let code = match hresult_name(hresult) {
        Some(name) => format!("{name}, {:#010X}", hresult as u32),
        None => format!("{:#010X}", hresult as u32),
    };
    let detail = detail.trim();
    let message = if detail.is_empty() {
        format!("{stage} failed ({code})")
    } else {
        format!("{stage} failed: {detail} ({code})")
    };
    match phase {
        SystemAudioPhase::Starting => SystemAudioFailure::StartFailed(message),
        SystemAudioPhase::Running => SystemAudioFailure::StreamStopped(message),
    }
}

/// True when `Initialize` refused the requested format, so the next rung of
/// [`LOOPBACK_FORMAT_LADDER`] is worth a try.
pub(crate) fn is_format_rejection(hresult: i32) -> bool {
    matches!(
        hresult,
        HRESULT_AUDCLNT_E_UNSUPPORTED_FORMAT | HRESULT_E_INVALIDARG
    )
}

/// Where the exclusion root pid came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum LoopbackRootSource {
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

/// The process whose tree the loopback client excludes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoopbackRoot {
    pub(crate) process_id: u32,
    pub(crate) source: LoopbackRootSource,
}

/// Pids 0 (System Idle) and 4 (System) are never Videorc.
fn usable_root_pid(pid: u32, current_pid: u32) -> bool {
    pid > 4 && pid != current_pid
}

impl LoopbackRoot {
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
                source: LoopbackRootSource::ElectronMain,
            };
        }
        if let Some(pid) = parent_pid.filter(|pid| usable_root_pid(*pid, current_pid)) {
            return Self {
                process_id: pid,
                source: LoopbackRootSource::ParentProcess,
            };
        }
        Self {
            process_id: current_pid,
            source: LoopbackRootSource::CurrentProcess,
        }
    }

    /// Whether the root is known to be the Electron main process. False means
    /// Videorc's own audio may reach the capture.
    pub(crate) fn names_electron_main(&self) -> bool {
        self.source == LoopbackRootSource::ElectronMain
    }
}

#[cfg(windows)]
#[allow(unused_imports)] // `SystemAudioCaptureInfo` and `parent_pid` serve the tests
pub(crate) use capture::{
    SystemAudioCapture, SystemAudioCaptureInfo, SystemAudioCaptureOptions, parent_pid,
};

#[cfg(windows)]
mod capture {
    use std::mem::ManuallyDrop;
    use std::ptr;
    use std::slice;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED};
    use windows::Win32::Media::Audio::{
        AUDCLNT_SHAREMODE_SHARED, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{BLOB, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    use windows::Win32::System::Threading::{
        AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
        WaitForSingleObject,
    };
    use windows::Win32::System::Variant::VT_BLOB;
    use windows::core::{HRESULT, Interface, Ref, w};

    use super::*;
    use crate::audio::{AudioCaptureStats, AudioFrame};
    use crate::system_audio_capture::{
        HostClockAnchor, SYSTEM_AUDIO_QUEUE_CAPACITY, SYSTEM_AUDIO_START_BUDGET,
        SYSTEM_AUDIO_STOP_BUDGET, SystemAudioCaptureStats, SystemAudioFailureSlot,
        system_audio_frame,
    };

    /// How long `ActivateAudioInterfaceAsync` may take to complete.
    const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
    /// The capture thread's longest wait for the packet event, which bounds
    /// how long a stop request waits to be seen.
    const CAPTURE_EVENT_WAIT_MS: u32 = 50;

    /// The backend's parent pid, from a Toolhelp process snapshot. `None`
    /// when the snapshot fails or does not list this process.
    pub(crate) fn parent_pid() -> Option<u32> {
        let current = std::process::id();
        // SAFETY: a process snapshot has no preconditions; the handle is
        // closed by `OwnedHandle`.
        let snapshot =
            OwnedHandle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: `entry.dwSize` is set as the API requires.
        unsafe { Process32FirstW(snapshot.0, &mut entry) }.ok()?;
        loop {
            if entry.th32ProcessID == current {
                return Some(entry.th32ParentProcessID);
            }
            // SAFETY: as above; the error is the end of the list.
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                return None;
            }
        }
    }

    impl LoopbackRoot {
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
        pub(crate) root: LoopbackRoot,
        pub(crate) queue_capacity: usize,
    }

    impl Default for SystemAudioCaptureOptions {
        fn default() -> Self {
            Self {
                root: LoopbackRoot::videorc(),
                queue_capacity: SYSTEM_AUDIO_QUEUE_CAPACITY,
            }
        }
    }

    /// What the running stream excludes and negotiated, for diagnostics.
    #[derive(Debug, Clone, Default)]
    pub(crate) struct SystemAudioCaptureInfo {
        /// Root of the excluded process tree.
        pub(crate) target_process_id: u32,
        pub(crate) root_source: LoopbackRootSource,
        /// Whether the excluded tree is known to be the Electron main
        /// process's. False means Videorc's own audio may leak.
        pub(crate) pid_excluded: bool,
        pub(crate) sample_format: LoopbackSampleFormat,
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
    /// Every COM object lives on a dedicated capture thread, so this handle
    /// is `Send` and can be a session producer's owner.
    pub(crate) struct SystemAudioCapture {
        receiver: Option<mpsc::Receiver<AudioFrame>>,
        shared: Arc<CaptureShared>,
        info: SystemAudioCaptureInfo,
        stop_tx: Option<mpsc::Sender<()>>,
        done_rx: Option<mpsc::Receiver<()>>,
        owner: Option<thread::JoinHandle<()>>,
    }

    impl SystemAudioCapture {
        /// Activates and starts a process-loopback client that excludes
        /// `options.root`'s process tree. Blocks for up to
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
                .name("system-audio-wasapi".into())
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
                        format = ?info.sample_format,
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
                // releases the client when WASAPI answers.
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

    /// Closes a Win32 handle on drop.
    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                // SAFETY: this type owns the handle and closes it once.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// This thread's MTA membership, released on drop.
    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, SystemAudioFailure> {
            // SAFETY: paired with this same thread's Drop implementation.
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result.is_err() {
                return Err(classify_loopback_error(
                    SystemAudioPhase::Starting,
                    "CoInitializeEx",
                    result.0,
                    &result.message(),
                ));
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            // SAFETY: balances the successful initialization above.
            unsafe { CoUninitialize() };
        }
    }

    /// MMCSS "Audio" scheduling for the capture thread, best effort.
    struct MmcssTask(Option<HANDLE>);

    impl MmcssTask {
        fn join() -> Self {
            let mut task_index = 0u32;
            // SAFETY: a static task name and a valid out pointer.
            let handle = unsafe { AvSetMmThreadCharacteristicsW(w!("Audio"), &mut task_index) };
            Self(handle.ok())
        }
    }

    impl Drop for MmcssTask {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                // SAFETY: reverts the registration made by `join` on this thread.
                let _ = unsafe { AvRevertMmThreadCharacteristics(handle) };
            }
        }
    }

    #[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivationCompletion {
        done: mpsc::SyncSender<()>,
    }

    #[allow(non_snake_case)]
    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationCompletion_Impl {
        fn ActivateCompleted(
            &self,
            _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            // The waiting thread reads the result from the operation it
            // holds; this only signals readiness. A waiter that timed out is
            // gone, which is fine.
            let _ = self.done.try_send(());
            Ok(())
        }
    }

    fn failure_from_error(
        phase: SystemAudioPhase,
        stage: &str,
        error: &windows::core::Error,
    ) -> SystemAudioFailure {
        classify_loopback_error(phase, stage, error.code().0, &error.message())
    }

    fn waveformatex(spec: WaveFormatSpec) -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: spec.format_tag,
            nChannels: spec.channels,
            nSamplesPerSec: spec.samples_per_sec,
            nAvgBytesPerSec: spec.avg_bytes_per_sec,
            nBlockAlign: spec.block_align,
            wBitsPerSample: spec.bits_per_sample,
            cbSize: spec.extra_bytes,
        }
    }

    fn qpc_frequency() -> Option<i64> {
        let mut frequency = 0i64;
        // SAFETY: a valid out pointer.
        unsafe { QueryPerformanceFrequency(&mut frequency) }.ok()?;
        (frequency > 0).then_some(frequency)
    }

    fn qpc_now_nanos(frequency: i64) -> u64 {
        let mut ticks = 0i64;
        // SAFETY: a valid out pointer; QPC cannot fail on Windows XP+.
        let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
        qpc_ticks_to_nanos(ticks, frequency).unwrap_or(0)
    }

    /// Reads an anchor with the QPC read bracketed by two `Instant`s,
    /// retrying until the bracket is under 50 µs. `Instant` is QPC on
    /// Windows, so the offset is constant and one anchor per stream is
    /// enough.
    fn sample_anchor(frequency: i64) -> HostClockAnchor {
        let mut best: Option<(HostClockAnchor, Duration)> = None;
        for _ in 0..5 {
            let before = Instant::now();
            let host_nanos = qpc_now_nanos(frequency);
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

    /// One started loopback stream. Owned by the capture thread only.
    struct Session {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        // Declared after the clients so it closes after they are released.
        event: OwnedHandle,
        anchor: HostClockAnchor,
        qpc_frequency: i64,
        format: LoopbackSampleFormat,
    }

    impl Session {
        fn stop(&self) {
            // SAFETY: a started client; Stop on a stopped client is a no-op.
            if let Err(error) = unsafe { self.client.Stop() } {
                tracing::warn!(reason = %error, "System audio IAudioClient::Stop failed");
            }
        }
    }

    fn stop_requested(stop_rx: &mpsc::Receiver<()>) -> bool {
        !matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty))
    }

    fn run_owner(
        options: &SystemAudioCaptureOptions,
        shared: &CaptureShared,
        startup_tx: &mpsc::Sender<Result<SystemAudioCaptureInfo, SystemAudioFailure>>,
        stop_rx: &mpsc::Receiver<()>,
    ) {
        let opened = ComApartment::initialize().and_then(|apartment| {
            open_session(options).map(|(session, info)| (apartment, session, info))
        });
        let (_apartment, session, info) = match opened {
            Ok(opened) => opened,
            Err(failure) => {
                shared.failure.record(failure.clone());
                shared.close();
                let _ = startup_tx.send(Err(failure));
                return;
            }
        };
        // The handle is gone (start timed out, or it was dropped): stop at
        // once instead of capturing for nobody.
        if stop_requested(stop_rx) || startup_tx.send(Ok(info)).is_err() {
            session.stop();
            shared.close();
            return;
        }
        let _mmcss = MmcssTask::join();
        run_capture_loop(&session, shared, stop_rx);
        session.stop();
        shared.close();
        // `session` releases the clients, then `_apartment` leaves the MTA.
    }

    fn open_session(
        options: &SystemAudioCaptureOptions,
    ) -> Result<(Session, SystemAudioCaptureInfo), SystemAudioFailure> {
        let started = Instant::now();
        let frequency = qpc_frequency().ok_or_else(|| {
            SystemAudioFailure::StartFailed("QueryPerformanceFrequency is unavailable".into())
        })?;
        let root = options.root;
        if !root.names_electron_main() {
            tracing::warn!(
                target_pid = root.process_id,
                source = ?root.source,
                "System audio could not name the Videorc app to exclude ({ELECTRON_MAIN_PID_ENV} unset); its own audio may be captured"
            );
        }
        let mut rejection = None;
        for format in LOOPBACK_FORMAT_LADDER {
            let client = activate_process_loopback(root.process_id)?;
            let wave = waveformatex(loopback_wave_format(format));
            // SAFETY: `wave` outlives the call; no session GUID.
            let initialized = unsafe {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    LOOPBACK_STREAM_FLAGS,
                    LOOPBACK_BUFFER_DURATION_HNS,
                    0,
                    &wave,
                    None,
                )
            };
            match initialized {
                Ok(()) => {
                    let session = start_session(client, format, frequency)?;
                    let info = SystemAudioCaptureInfo {
                        target_process_id: root.process_id,
                        root_source: root.source,
                        pid_excluded: root.names_electron_main(),
                        sample_format: format,
                        start_latency: started.elapsed(),
                    };
                    return Ok((session, info));
                }
                Err(error) if is_format_rejection(error.code().0) => {
                    tracing::info!(
                        ?format,
                        reason = %error,
                        "System audio loopback refused a format; trying the next one"
                    );
                    rejection = Some(error);
                }
                Err(error) => {
                    return Err(failure_from_error(
                        SystemAudioPhase::Starting,
                        "IAudioClient::Initialize",
                        &error,
                    ));
                }
            }
        }
        Err(match rejection {
            Some(error) => failure_from_error(
                SystemAudioPhase::Starting,
                "IAudioClient::Initialize (every format refused)",
                &error,
            ),
            None => SystemAudioFailure::StartFailed("no loopback format was tried".into()),
        })
    }

    fn start_session(
        client: IAudioClient,
        format: LoopbackSampleFormat,
        qpc_frequency: i64,
    ) -> Result<Session, SystemAudioFailure> {
        let starting = |stage: &str, error: &windows::core::Error| {
            failure_from_error(SystemAudioPhase::Starting, stage, error)
        };
        // Auto-reset, initially unsignalled.
        // SAFETY: default security, no name.
        let event = OwnedHandle(
            unsafe { CreateEventW(None, false, false, None) }
                .map_err(|error| starting("CreateEventW", &error))?,
        );
        // SAFETY: an initialized, event-driven client and a live event.
        unsafe { client.SetEventHandle(event.0) }
            .map_err(|error| starting("IAudioClient::SetEventHandle", &error))?;
        // SAFETY: an initialized client.
        let capture: IAudioCaptureClient = unsafe { client.GetService() }
            .map_err(|error| starting("IAudioClient::GetService(IAudioCaptureClient)", &error))?;
        let anchor = sample_anchor(qpc_frequency);
        // SAFETY: an initialized client with its event set.
        unsafe { client.Start() }.map_err(|error| starting("IAudioClient::Start", &error))?;
        Ok(Session {
            client,
            capture,
            event,
            anchor,
            qpc_frequency,
            format,
        })
    }

    /// A `VT_BLOB` PROPVARIANT whose data is `value`, borrowed: the caller
    /// keeps `value` alive for as long as the variant is in use.
    ///
    /// It is never dropped. windows-rs's `PROPVARIANT` runs `PropVariantClear`
    /// on drop, and `PropVariantClear` hands a `VT_BLOB`'s data to
    /// `CoTaskMemFree`; on a borrowed value that frees memory the heap never
    /// handed out. Every Windows System audio start did exactly that, and the
    /// heap terminated the backend with 0xC0000374 (2026-11-01 field dump,
    /// 0.17.4: thread `system-audio-wasapi`, bucket
    /// `HEAP_CORRUPTION_ACTIONABLE_BlockNotBusy_DOUBLE_FREE_c0000374_combase.dll!PropVariantClearWorker`).
    fn borrowed_blob_variant<T>(value: &mut T) -> ManuallyDrop<PROPVARIANT> {
        let mut variant = ManuallyDrop::new(PROPVARIANT::default());
        // SAFETY: `variant` is zeroed (VT_EMPTY); this selects its VT_BLOB
        // arm, which is plain data (a length and a pointer).
        unsafe {
            let inner = &mut *variant.Anonymous.Anonymous;
            inner.vt = VT_BLOB;
            inner.Anonymous.blob = BLOB {
                cbSize: u32::try_from(std::mem::size_of::<T>())
                    .expect("an activation blob is a small struct"),
                pBlobData: ptr::from_mut(value).cast(),
            };
        }
        variant
    }

    /// Activates the process-loopback `IAudioClient` and waits for the
    /// completion handler (the readiness signal) for up to
    /// [`ACTIVATION_TIMEOUT`].
    fn activate_process_loopback(target_pid: u32) -> Result<IAudioClient, SystemAudioFailure> {
        let starting = |stage: &str, error: &windows::core::Error| {
            failure_from_error(SystemAudioPhase::Starting, stage, error)
        };
        // Both live on the heap: a timed-out activation may still read them
        // after this returns, so that path leaks them instead of freeing.
        let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: target_pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        let variant = Box::new(borrowed_blob_variant(&mut *params));
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler =
            ActivationCompletion { done: done_tx }.into();
        // SAFETY: a static device path, a valid IID and a PROPVARIANT whose
        // blob points at `params`; both outlive the activation (completion
        // is awaited, and a timeout leaks them).
        let operation = unsafe {
            ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(ptr::from_ref::<PROPVARIANT>(&variant)),
                &handler,
            )
        }
        .map_err(|error| starting("ActivateAudioInterfaceAsync", &error))?;
        if done_rx.recv_timeout(ACTIVATION_TIMEOUT).is_err() {
            Box::leak(params);
            Box::leak(variant);
            return Err(SystemAudioFailure::StartFailed(format!(
                "process loopback activation did not complete within {} s",
                ACTIVATION_TIMEOUT.as_secs()
            )));
        }
        let mut activate_result = HRESULT(0);
        let mut activated = None;
        // SAFETY: the operation completed; both out pointers are valid.
        unsafe { operation.GetActivateResult(&mut activate_result, &mut activated) }
            .map_err(|error| starting("GetActivateResult", &error))?;
        if activate_result.is_err() {
            return Err(classify_loopback_error(
                SystemAudioPhase::Starting,
                "process loopback activation",
                activate_result.0,
                &activate_result.message(),
            ));
        }
        activated
            .ok_or_else(|| {
                SystemAudioFailure::StartFailed(
                    "process loopback activation returned no interface".into(),
                )
            })?
            .cast::<IAudioClient>()
            .map_err(|error| starting("IUnknown::QueryInterface(IAudioClient)", &error))
    }

    fn run_capture_loop(session: &Session, shared: &CaptureShared, stop_rx: &mpsc::Receiver<()>) {
        let mut discontinuities = 0u64;
        loop {
            if stop_requested(stop_rx) || shared.stopping.load(Ordering::Acquire) {
                break;
            }
            // SAFETY: the event outlives the session.
            let wait = unsafe { WaitForSingleObject(session.event.0, CAPTURE_EVENT_WAIT_MS) };
            if wait == WAIT_FAILED {
                shared.fail(SystemAudioFailure::StreamStopped(format!(
                    "waiting for the loopback packet event failed: {}",
                    std::io::Error::last_os_error()
                )));
                break;
            }
            // Signalled or timed out, drain: a timeout drain is cheap and
            // covers a missed signal.
            if let Err(failure) = drain_packets(session, shared, &mut discontinuities) {
                shared.fail(failure);
                break;
            }
        }
        if discontinuities > 0 {
            tracing::info!(
                discontinuities,
                "System audio loopback reported data discontinuities"
            );
        }
    }

    /// Reads every pending packet. An error is terminal.
    fn drain_packets(
        session: &Session,
        shared: &CaptureShared,
        discontinuities: &mut u64,
    ) -> Result<(), SystemAudioFailure> {
        let running = |stage: &str, error: &windows::core::Error| {
            failure_from_error(SystemAudioPhase::Running, stage, error)
        };
        loop {
            // SAFETY: a started capture client, used only on this thread.
            let pending = unsafe { session.capture.GetNextPacketSize() }
                .map_err(|error| running("IAudioCaptureClient::GetNextPacketSize", &error))?;
            if pending == 0 {
                return Ok(());
            }
            let mut data: *mut u8 = ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut qpc_position = 0u64;
            // SAFETY: valid out pointers; the packet is released below.
            unsafe {
                session.capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    None,
                    Some(&mut qpc_position),
                )
            }
            .map_err(|error| running("IAudioCaptureClient::GetBuffer", &error))?;
            if frames == 0 {
                // AUDCLNT_S_BUFFER_EMPTY: nothing was acquired.
                // SAFETY: releasing zero frames is always allowed.
                let _ = unsafe { session.capture.ReleaseBuffer(0) };
                return Ok(());
            }
            let now_host_nanos = qpc_now_nanos(session.qpc_frequency);
            let bytes = if data.is_null() || flags & BUFFER_FLAG_SILENT != 0 {
                None
            } else {
                // SAFETY: GetBuffer returned `frames` frames of the
                // negotiated format at `data`, valid until ReleaseBuffer.
                Some(unsafe {
                    slice::from_raw_parts(data, frames as usize * session.format.block_align())
                })
            };
            let converted = loopback_packet_samples(session.format, frames, flags, bytes);
            // SAFETY: releases exactly the packet acquired above; `bytes` is
            // not used after this.
            unsafe { session.capture.ReleaseBuffer(frames) }
                .map_err(|error| running("IAudioCaptureClient::ReleaseBuffer", &error))?;
            if flags & BUFFER_FLAG_DATA_DISCONTINUITY != 0 {
                *discontinuities += 1;
            }
            match converted {
                Ok(samples) if samples.is_empty() => {}
                Ok(samples) => {
                    let pts = packet_start_host_nanos(flags, qpc_position, now_host_nanos, frames);
                    shared.push(system_audio_frame(samples, pts, &session.anchor));
                }
                Err(error) => {
                    shared.rejected_buffers.fetch_add(1, Ordering::Relaxed);
                    return Err(SystemAudioFailure::UnsupportedFormat(error));
                }
            }
        }
    }

    #[cfg(test)]
    mod blob_variant_tests {
        use super::*;

        /// The pre-fix construction (a plain `PROPVARIANT` over a stack
        /// value, dropped) killed the process with 0xC0000374 on the first
        /// round (reproduced 2026-11-01 with windows 0.62.2), so reaching the
        /// asserts is the regression check.
        #[test]
        fn a_borrowed_blob_variant_never_frees_the_value_it_points_at() {
            for round in 0..8_u32 {
                let mut params = [round; 3];
                let expected_data = ptr::from_mut(&mut params).cast::<u8>();
                {
                    let variant = borrowed_blob_variant(&mut params);
                    // SAFETY: reads the VT_BLOB arm `borrowed_blob_variant` wrote.
                    let (vt, blob) = unsafe {
                        let inner = &variant.Anonymous.Anonymous;
                        (inner.vt, inner.Anonymous.blob)
                    };
                    assert_eq!(vt, VT_BLOB);
                    assert_eq!(blob.cbSize, 12);
                    assert_eq!(blob.pBlobData, expected_data);
                    // `variant` leaves scope here, as it does when
                    // `activate_process_loopback` returns.
                }
                assert_eq!(params, [round; 3], "the borrowed value is untouched");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::protocol::DeviceStatus;
    use crate::system_audio_capture::{HostClockAnchor, system_audio_frame};

    #[test]
    fn system_audio_windows_stream_flags_are_event_driven_converting_loopback() {
        assert_eq!(LOOPBACK_STREAM_FLAGS, 0x8806_0000);
        assert_ne!(LOOPBACK_STREAM_FLAGS & STREAM_FLAG_LOOPBACK, 0);
        assert_ne!(LOOPBACK_STREAM_FLAGS & STREAM_FLAG_EVENTCALLBACK, 0);
        assert_ne!(LOOPBACK_STREAM_FLAGS & STREAM_FLAG_AUTOCONVERTPCM, 0);
        assert_ne!(LOOPBACK_STREAM_FLAGS & STREAM_FLAG_SRC_DEFAULT_QUALITY, 0);
        assert_eq!(
            LOOPBACK_BUFFER_DURATION_HNS, 1_000_000,
            "100 ms in 100 ns units"
        );
    }

    #[test]
    fn system_audio_windows_wave_formats_are_48k_stereo() {
        assert_eq!(
            loopback_wave_format(LoopbackSampleFormat::F32),
            WaveFormatSpec {
                format_tag: 3,
                channels: 2,
                samples_per_sec: 48_000,
                avg_bytes_per_sec: 384_000,
                block_align: 8,
                bits_per_sample: 32,
                extra_bytes: 0,
            }
        );
        assert_eq!(
            loopback_wave_format(LoopbackSampleFormat::I16),
            WaveFormatSpec {
                format_tag: 1,
                channels: 2,
                samples_per_sec: 48_000,
                avg_bytes_per_sec: 192_000,
                block_align: 4,
                bits_per_sample: 16,
                extra_bytes: 0,
            }
        );
        assert_eq!(
            LOOPBACK_FORMAT_LADDER,
            [LoopbackSampleFormat::F32, LoopbackSampleFormat::I16],
            "float first, the bus's native shape"
        );
    }

    fn f32_le(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn system_audio_windows_float_packets_convert_as_is() {
        let data = f32_le(&[0.1, -0.1, 0.2, -0.2]);
        assert_eq!(
            loopback_packet_samples(LoopbackSampleFormat::F32, 2, 0, Some(&data)).unwrap(),
            vec![0.1, -0.1, 0.2, -0.2]
        );
        // Extra trailing bytes past `frames` are ignored.
        let mut long = data.clone();
        long.extend_from_slice(&f32_le(&[0.9, 0.9]));
        assert_eq!(
            loopback_packet_samples(LoopbackSampleFormat::F32, 2, 0, Some(&long))
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn system_audio_windows_pcm16_packets_scale_to_unit_float() {
        let data: Vec<u8> = [i16::MIN, i16::MAX, 0, 16_384]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let samples =
            loopback_packet_samples(LoopbackSampleFormat::I16, 2, 0, Some(&data)).unwrap();
        assert_eq!(samples[0], -1.0);
        assert!((samples[1] - 1.0).abs() < 1.0e-4);
        assert_eq!(samples[2], 0.0);
        assert_eq!(samples[3], 0.5);
    }

    #[test]
    fn system_audio_windows_silent_packets_are_zeros_whatever_the_data() {
        let noise = f32_le(&[0.7; 8]);
        assert_eq!(
            loopback_packet_samples(
                LoopbackSampleFormat::F32,
                4,
                BUFFER_FLAG_SILENT,
                Some(&noise)
            )
            .unwrap(),
            vec![0.0; 8]
        );
        assert_eq!(
            loopback_packet_samples(
                LoopbackSampleFormat::F32,
                3,
                BUFFER_FLAG_SILENT | BUFFER_FLAG_DATA_DISCONTINUITY,
                None
            )
            .unwrap(),
            vec![0.0; 6],
            "a silent packet needs no data"
        );
    }

    #[test]
    fn system_audio_windows_rejects_packets_without_enough_data() {
        assert!(loopback_packet_samples(LoopbackSampleFormat::F32, 2, 0, None).is_err());
        let short = f32_le(&[0.1, 0.1, 0.1]);
        assert!(loopback_packet_samples(LoopbackSampleFormat::F32, 2, 0, Some(&short)).is_err());
        assert_eq!(
            loopback_packet_samples(LoopbackSampleFormat::F32, 0, 0, None).unwrap(),
            Vec::<f32>::new(),
            "an empty packet is not an error"
        );
    }

    #[test]
    fn system_audio_windows_qpc_converts_to_nanos() {
        // The usual 10 MHz QPC: one tick is 100 ns.
        assert_eq!(qpc_ticks_to_nanos(12_345, 10_000_000), Some(1_234_500));
        // 24 MHz (ARM64) and the legacy 3.579545 MHz ACPI timer.
        assert_eq!(
            qpc_ticks_to_nanos(24_000_000, 24_000_000),
            Some(1_000_000_000)
        );
        assert_eq!(
            qpc_ticks_to_nanos(3_579_545, 3_579_545),
            Some(1_000_000_000)
        );
        // Weeks of uptime do not overflow the intermediate product.
        let month = 30 * 24 * 3_600 * 10_000_000i64;
        assert_eq!(
            qpc_ticks_to_nanos(month, 10_000_000),
            Some(30 * 24 * 3_600 * 1_000_000_000)
        );
        assert_eq!(qpc_ticks_to_nanos(1, 0), None);
        assert_eq!(qpc_ticks_to_nanos(-1, 10_000_000), None);
    }

    #[test]
    fn system_audio_windows_packet_start_uses_the_qpc_position() {
        // GetBuffer's QPC position is in 100 ns units.
        assert_eq!(
            packet_start_host_nanos(0, 50_000_000, 0, 480),
            5_000_000_000
        );
        // A discontinuity does not distrust the timestamp.
        assert_eq!(
            packet_start_host_nanos(BUFFER_FLAG_DATA_DISCONTINUITY, 50_000_000, 0, 480),
            5_000_000_000
        );
        // A timestamp error (or none) places the packet to end at the read.
        let now = 9_000_000_000;
        assert_eq!(
            packet_start_host_nanos(BUFFER_FLAG_TIMESTAMP_ERROR, 50_000_000, now, 480),
            now - 10_000_000
        );
        assert_eq!(packet_start_host_nanos(0, 0, now, 960), now - 20_000_000);
        assert_eq!(packet_start_host_nanos(0, 0, 5, 960), 0, "never underflows");
    }

    #[test]
    fn system_audio_windows_frame_follows_the_bus_clock_convention() {
        // A QPC-clock anchor: host nanos 7 s maps to `base`.
        let base = Instant::now() + Duration::from_secs(10);
        let anchor = HostClockAnchor {
            host_nanos: 7_000_000_000,
            instant: base,
        };
        // A 10 ms engine packet (480 frames) whose first frame was captured
        // 100 ms after the anchor, as GetBuffer reports it.
        let qpc_position_hns = 71_000_000;
        let pts = packet_start_host_nanos(0, qpc_position_hns, 0, 480);
        let frame = system_audio_frame(
            loopback_packet_samples(LoopbackSampleFormat::F32, 480, BUFFER_FLAG_SILENT, None)
                .unwrap(),
            pts,
            &anchor,
        );
        assert_eq!(frame.sample_rate, 48_000);
        assert_eq!(frame.channels, 2);
        assert_eq!(frame.frame_count(), 480);
        assert_eq!(frame.timestamp_micros, 7_100_000);
        // `captured_at` is the END of the packet.
        assert_eq!(frame.captured_at, base + Duration::from_millis(110));
        assert_eq!(
            frame.captured_at - frame.duration(),
            base + Duration::from_millis(100)
        );
    }

    #[test]
    fn system_audio_windows_errors_classify_by_phase() {
        let starting = classify_loopback_error(
            SystemAudioPhase::Starting,
            "process loopback activation",
            HRESULT_E_NOTIMPL,
            "Not implemented",
        );
        assert!(matches!(starting, SystemAudioFailure::StartFailed(_)));
        assert_eq!(starting.health_kind(), "system-audio-unavailable");
        assert_eq!(starting.device_status(), Some(DeviceStatus::Unavailable));
        assert!(starting.message().contains("E_NOTIMPL"), "{starting}");
        assert!(starting.message().contains("0x80004001"), "{starting}");

        // Windows has no grant to miss: access denied at start is a start
        // failure, never PermissionRequired.
        assert!(matches!(
            classify_loopback_error(
                SystemAudioPhase::Starting,
                "IAudioClient::Initialize",
                HRESULT_E_ACCESSDENIED,
                "Access is denied."
            ),
            SystemAudioFailure::StartFailed(_)
        ));

        let lost = classify_loopback_error(
            SystemAudioPhase::Running,
            "IAudioCaptureClient::GetBuffer",
            HRESULT_AUDCLNT_E_DEVICE_INVALIDATED,
            "",
        );
        assert!(matches!(lost, SystemAudioFailure::StreamStopped(_)));
        assert_eq!(lost.health_kind(), "system-audio-lost");
        assert_eq!(lost.device_status(), None);
        assert_eq!(
            lost.message(),
            "IAudioCaptureClient::GetBuffer failed (AUDCLNT_E_DEVICE_INVALIDATED, 0x88890004)"
        );

        let unknown = classify_loopback_error(
            SystemAudioPhase::Running,
            "IAudioCaptureClient::GetNextPacketSize",
            0x8000_FFFF_u32 as i32,
            "Catastrophic failure",
        );
        assert!(matches!(unknown, SystemAudioFailure::StreamStopped(_)));
        assert!(unknown.message().contains("0x8000FFFF"), "{unknown}");
    }

    #[test]
    fn system_audio_windows_only_format_errors_try_the_next_format() {
        assert!(is_format_rejection(HRESULT_AUDCLNT_E_UNSUPPORTED_FORMAT));
        assert!(is_format_rejection(HRESULT_E_INVALIDARG));
        assert!(!is_format_rejection(HRESULT_AUDCLNT_E_DEVICE_INVALIDATED));
        assert!(!is_format_rejection(HRESULT_E_ACCESSDENIED));
        assert!(!is_format_rejection(0));
    }

    #[test]
    fn system_audio_windows_root_prefers_the_electron_main_pid() {
        let current = 9_000;
        assert_eq!(
            LoopbackRoot::resolve(Some(" 4242 "), Some(5_000), current),
            LoopbackRoot {
                process_id: 4_242,
                source: LoopbackRootSource::ElectronMain,
            }
        );
        assert!(LoopbackRoot::resolve(Some("4242"), None, current).names_electron_main());

        // Unset, garbage, System Idle/System, or our own pid: the parent.
        for env in [
            None,
            Some(""),
            Some("electron"),
            Some("0"),
            Some("4"),
            Some("9000"),
        ] {
            assert_eq!(
                LoopbackRoot::resolve(env, Some(5_000), current),
                LoopbackRoot {
                    process_id: 5_000,
                    source: LoopbackRootSource::ParentProcess,
                },
                "{env:?}"
            );
        }
        assert!(!LoopbackRoot::resolve(None, Some(5_000), current).names_electron_main());

        // No usable parent either: only this process is excluded.
        for parent in [None, Some(0), Some(4), Some(current)] {
            assert_eq!(
                LoopbackRoot::resolve(None, parent, current),
                LoopbackRoot {
                    process_id: current,
                    source: LoopbackRootSource::CurrentProcess,
                },
                "{parent:?}"
            );
        }
    }
}

/// Pins the local constants to the windows-rs definitions, and checks the
/// platform plumbing that needs no audio.
#[cfg(all(test, windows))]
mod windows_constants {
    use windows::Win32::Media::Audio as wasapi;
    use windows::Win32::Media::Audio::WAVEFORMATEX;

    use super::*;

    #[test]
    fn system_audio_windows_local_constants_match_the_sdk() {
        assert_eq!(STREAM_FLAG_LOOPBACK, wasapi::AUDCLNT_STREAMFLAGS_LOOPBACK);
        assert_eq!(
            STREAM_FLAG_EVENTCALLBACK,
            wasapi::AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        );
        assert_eq!(
            STREAM_FLAG_SRC_DEFAULT_QUALITY,
            wasapi::AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
        );
        assert_eq!(
            STREAM_FLAG_AUTOCONVERTPCM,
            wasapi::AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        );
        assert_eq!(
            BUFFER_FLAG_DATA_DISCONTINUITY as i32,
            wasapi::AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0
        );
        assert_eq!(
            BUFFER_FLAG_SILENT as i32,
            wasapi::AUDCLNT_BUFFERFLAGS_SILENT.0
        );
        assert_eq!(
            BUFFER_FLAG_TIMESTAMP_ERROR as i32,
            wasapi::AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0
        );
        assert_eq!(
            HRESULT_AUDCLNT_E_DEVICE_INVALIDATED,
            wasapi::AUDCLNT_E_DEVICE_INVALIDATED.0
        );
        assert_eq!(
            HRESULT_AUDCLNT_E_UNSUPPORTED_FORMAT,
            wasapi::AUDCLNT_E_UNSUPPORTED_FORMAT.0
        );
        assert_eq!(
            HRESULT_AUDCLNT_E_SERVICE_NOT_RUNNING,
            wasapi::AUDCLNT_E_SERVICE_NOT_RUNNING.0
        );
        assert_eq!(
            HRESULT_AUDCLNT_E_RESOURCES_INVALIDATED,
            wasapi::AUDCLNT_E_RESOURCES_INVALIDATED.0
        );
        assert_eq!(
            HRESULT_E_ACCESSDENIED,
            windows::Win32::Foundation::E_ACCESSDENIED.0
        );
        assert_eq!(
            HRESULT_E_INVALIDARG,
            windows::Win32::Foundation::E_INVALIDARG.0
        );
        assert_eq!(HRESULT_E_NOTIMPL, windows::Win32::Foundation::E_NOTIMPL.0);
        assert_eq!(std::mem::size_of::<WAVEFORMATEX>(), 18);
    }

    #[test]
    fn system_audio_windows_finds_this_process_parent() {
        // The test runner always has a parent (cargo or the shell).
        let parent = parent_pid().expect("a Toolhelp snapshot lists this process");
        assert_ne!(parent, std::process::id());
    }
}

/// Live capture checks (plan 069 S8). Each plays a short 1 kHz tone through
/// the default output with a PowerShell `Media.SoundPlayer`. The player waits
/// for a line on its stdin (the explicit trigger), so capture is running
/// before the tone starts; nothing waits on a fixed sleep, and every child is
/// killed and reaped on the way out.
///
/// Run on a Windows box, from PowerShell 7:
/// `$env:VIDEORC_SYSTEM_AUDIO_SPIKE=1; cargo test -p videorc-backend
/// system_audio_capture_windows_live -- --ignored --nocapture --test-threads=1`.
#[cfg(all(test, windows))]
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

    const TONE_HZ: f64 = 1_000.0;
    const TONE_AMPLITUDE: f64 = 0.25; // -12 dBFS in the file
    const TONE_SECONDS: f64 = 1.5;
    /// Bound on PowerShell start plus `PlaySync`.
    const PLAYER_DEADLINE: Duration = Duration::from_secs(20);
    /// Packets captured just before the player exited are still in flight.
    const CAPTURE_TAIL: Duration = Duration::from_millis(500);

    fn spike_enabled() -> bool {
        if std::env::var("VIDEORC_SYSTEM_AUDIO_SPIKE").as_deref() == Ok("1") {
            return true;
        }
        eprintln!("VIDEORC_SYSTEM_AUDIO_SPIKE != 1; skipping the live capture test");
        false
    }

    /// `SoundPlayer` plays PCM WAV only, so the tone is 16-bit PCM.
    fn write_tone_wav(path: &Path) {
        let rate = SYSTEM_AUDIO_SAMPLE_RATE;
        let frames = (TONE_SECONDS * f64::from(rate)) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for index in 0..frames {
            let value = TONE_AMPLITUDE
                * (2.0 * std::f64::consts::PI * TONE_HZ * index as f64 / f64::from(rate)).sin();
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

    /// An owned child that is killed and reaped on drop, panics included.
    struct OwnedChild(Child);

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A PowerShell that plays `wav` once it reads a line on stdin.
    fn spawn_gated_player(wav: &Path) -> OwnedChild {
        let script = format!(
            "$null = [Console]::In.ReadLine(); (New-Object Media.SoundPlayer '{}').PlaySync()",
            wav.display()
        );
        OwnedChild(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .expect("spawn the PowerShell tone player"),
        )
    }

    fn trigger(player: &mut OwnedChild) {
        let mut stdin = player.0.stdin.take().expect("player stdin");
        writeln!(stdin).expect("trigger the tone player");
        // Dropping `stdin` closes the pipe.
    }

    /// Starts capture excluding `root`'s tree, triggers `player`, and
    /// collects frames until the player exits (plus a short tail).
    fn capture_while_playing(root: LoopbackRoot, player: &mut OwnedChild) -> Vec<AudioFrame> {
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

        trigger(player);
        let deadline = Instant::now() + PLAYER_DEADLINE;
        let mut frames = Vec::new();
        let mut exited_at: Option<Instant> = None;
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => frames.push(frame),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if exited_at.is_none() {
                match player.0.try_wait() {
                    Ok(Some(status)) => {
                        assert!(status.success(), "the tone player failed: {status}");
                        exited_at = Some(Instant::now());
                    }
                    Ok(None) => {}
                    Err(error) => panic!("could not poll the tone player: {error}"),
                }
            }
            if exited_at.is_some_and(|at| at.elapsed() >= CAPTURE_TAIL) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the tone player did not finish within {PLAYER_DEADLINE:?}"
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
            "{} packets, stats {stats:?}, {drained} drained after stop",
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

    /// Amplitude of the `TONE_HZ` component of the left channel (Goertzel).
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

    fn best_tone_dbfs(frames: &[AudioFrame]) -> f64 {
        let best = frames
            .iter()
            .map(|frame| tone_amplitude(&frame.samples))
            .fold(0.0f64, f64::max);
        if best <= 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * best.log10()
        }
    }

    #[test]
    #[ignore = "Windows box: plays a tone, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_capture_windows_live_tone() {
        if !spike_enabled() {
            return;
        }
        let dir = tone_dir("tone");
        let tone = dir.join("tone-1k.wav");
        write_tone_wav(&tone);
        // An idle, never-triggered player is the exclusion root, so the real
        // player (a sibling, not a descendant) is captured.
        let root_holder = spawn_gated_player(&tone);
        let mut player = spawn_gated_player(&tone);
        let frames = capture_while_playing(
            LoopbackRoot {
                process_id: root_holder.0.id(),
                source: LoopbackRootSource::ElectronMain,
            },
            &mut player,
        );
        drop(root_holder);
        drop(player);
        let _ = std::fs::remove_dir_all(&dir);
        let tone_dbfs = best_tone_dbfs(&frames);
        eprintln!("1 kHz tone {tone_dbfs:.1} dBFS");
        assert!(
            tone_dbfs > -30.0,
            "the SoundPlayer tone reached the capture above -30 dBFS (got {tone_dbfs:.1})"
        );
    }

    #[test]
    #[ignore = "Windows box: plays a tone, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_capture_windows_live_excludes_the_root_tree() {
        if !spike_enabled() {
            return;
        }
        let dir = tone_dir("excluded");
        let tone = dir.join("tone-1k.wav");
        write_tone_wav(&tone);
        // The player IS the exclusion root, as the Electron main process is
        // for Videorc's own sounds: its tone must not reach the capture.
        let mut player = spawn_gated_player(&tone);
        let frames = capture_while_playing(
            LoopbackRoot {
                process_id: player.0.id(),
                source: LoopbackRootSource::ElectronMain,
            },
            &mut player,
        );
        drop(player);
        let _ = std::fs::remove_dir_all(&dir);
        let tone_dbfs = best_tone_dbfs(&frames);
        eprintln!("excluded 1 kHz tone {tone_dbfs:.1} dBFS");
        assert!(
            tone_dbfs < -60.0,
            "the excluded tree's tone leaked into the capture ({tone_dbfs:.1} dBFS)"
        );
    }
}
