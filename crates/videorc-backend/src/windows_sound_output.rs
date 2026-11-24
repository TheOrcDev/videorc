//! The sound monitor's Windows output (plan 260 S1.3): one WASAPI
//! shared-mode render stream to the default output, filled from the
//! monitor's mix on its own thread, as CoreAudio's render callback fills it
//! on macOS and PipeWire's on Linux (`linux_sound_output.rs`).
//!
//! Never into the room, the program or a recording: nothing here touches the
//! session bus, and Windows' System audio capture is process loopback in
//! `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` mode rooted at the
//! app (`system_audio_capture_windows.rs`). This backend is in that tree (or
//! is its root when the app's pid is unknown), so its own render stream is
//! left out, as ScreenCaptureKit leaves this process out on macOS.
//!
//! The stream runs on a thread of its own in the MTA, event-driven, with
//! MMCSS "Audio" scheduling. When the default output goes away
//! (`AUDCLNT_E_DEVICE_INVALIDATED`: a headset unplugged, the default
//! changed), it reopens on the new default, as Chromium's Web Audio did.
//! Dropping the [`PlaybackStream`] stops the stream and joins the thread.

// The pure helpers are unit-tested on every platform; only Windows plays.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::Duration;

const CHANNELS: usize = 2;
/// `WAVE_FORMAT_IEEE_FLOAT`.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// `AUDCLNT_STREAMFLAGS_EVENTCALLBACK | SRC_DEFAULT_QUALITY | AUTOCONVERTPCM`:
/// event-driven, with the engine converting to the endpoint's own format.
const RENDER_STREAM_FLAGS: u32 = 0x0004_0000 | 0x0800_0000 | 0x8000_0000;
/// The shared-mode buffer asked for, in 100 ns units: 20 ms (the engine
/// rounds it to its period).
const RENDER_BUFFER_HNS: i64 = 200_000;
/// How long `open` waits for the first stream to start.
const OPEN_WAIT: Duration = Duration::from_secs(3);
/// How long the render loop waits for the engine's event before it looks at
/// its stop flag again.
const EVENT_WAIT_MS: u32 = 50;
/// How long it waits before reopening after the output went away.
const REOPEN_DELAY: Duration = Duration::from_millis(500);

/// What fills each period: interleaved stereo f32 at the asked rate.
pub(crate) type Render = Box<dyn FnMut(&mut [f32]) + Send + 'static>;

/// The 48 kHz stereo float format the stream asks for (the engine converts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RenderFormat {
    pub format_tag: u16,
    pub channels: u16,
    pub samples_per_sec: u32,
    pub avg_bytes_per_sec: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
}

pub(crate) fn render_format(sample_rate: u32) -> RenderFormat {
    let block_align = (CHANNELS * std::mem::size_of::<f32>()) as u16;
    RenderFormat {
        format_tag: WAVE_FORMAT_IEEE_FLOAT,
        channels: CHANNELS as u16,
        samples_per_sec: sample_rate,
        avg_bytes_per_sec: sample_rate * u32::from(block_align),
        block_align,
        bits_per_sample: 32,
    }
}

/// The frames to write this period: the buffer's free room.
pub(crate) fn frames_free(buffer_frames: u32, padding_frames: u32) -> u32 {
    buffer_frames.saturating_sub(padding_frames)
}

/// `AUDCLNT_E_DEVICE_INVALIDATED`: the output went away; reopen.
pub(crate) const DEVICE_INVALIDATED: i32 = 0x8889_0004_u32 as i32;

#[cfg(windows)]
pub(crate) use playback::PlaybackStream;

#[cfg(windows)]
mod playback {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, mpsc};
    use std::thread;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Media::Audio::{
        AUDCLNT_SHAREMODE_SHARED, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, WAVEFORMATEX, eConsole, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::Threading::{
        AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
        WaitForSingleObject,
    };
    use windows::core::w;

    use super::*;

    /// A playing stream. Dropping it stops the stream and its thread.
    pub(crate) struct PlaybackStream {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl PlaybackStream {
        /// Opens a render stream on the default output and starts pulling
        /// periods from `render`.
        pub(crate) fn open(sample_rate: u32, render: Render) -> anyhow::Result<Self> {
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let thread = thread::Builder::new()
                .name("videorc-sound-monitor-wasapi".into())
                .spawn(move || run(sample_rate, render, &thread_stop, &ready_tx))?;
            match ready_rx.recv_timeout(OPEN_WAIT) {
                Ok(Ok(())) => Ok(Self {
                    stop,
                    thread: Some(thread),
                }),
                Ok(Err(error)) => {
                    stop.store(true, Ordering::SeqCst);
                    let _ = thread.join();
                    anyhow::bail!(error)
                }
                Err(_) => {
                    // The thread never answered: it stops at its next look
                    // at the flag, and is left to finish on its own.
                    stop.store(true, Ordering::SeqCst);
                    anyhow::bail!("WASAPI did not open the output in time")
                }
            }
        }
    }

    impl Drop for PlaybackStream {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// This thread's MTA membership, released on drop.
    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            // SAFETY: paired with this same thread's Drop implementation.
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result.is_err() {
                return Err(format!("CoInitializeEx: {}", result.message()));
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

    /// MMCSS "Audio" scheduling for the render thread, best effort.
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

    /// One open stream on the default output.
    struct Stream {
        client: IAudioClient,
        render_client: IAudioRenderClient,
        event: OwnedHandle,
        buffer_frames: u32,
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            // SAFETY: a started (or initialized) client; Stop on a stopped
            // one is harmless.
            let _ = unsafe { self.client.Stop() };
        }
    }

    fn wave_format(sample_rate: u32) -> WAVEFORMATEX {
        let spec = render_format(sample_rate);
        WAVEFORMATEX {
            wFormatTag: spec.format_tag,
            nChannels: spec.channels,
            nSamplesPerSec: spec.samples_per_sec,
            nAvgBytesPerSec: spec.avg_bytes_per_sec,
            nBlockAlign: spec.block_align,
            wBitsPerSample: spec.bits_per_sample,
            cbSize: 0,
        }
    }

    fn open_stream(sample_rate: u32) -> windows::core::Result<Stream> {
        // SAFETY: COM is initialized on this thread (MTA).
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        // SAFETY: a live enumerator.
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole)? };
        // SAFETY: a live device.
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };
        let wave = wave_format(sample_rate);
        // SAFETY: `wave` outlives the call; no session GUID.
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                RENDER_STREAM_FLAGS,
                RENDER_BUFFER_HNS,
                0,
                &wave,
                None,
            )?
        };
        // Auto-reset, initially unsignalled.
        // SAFETY: default security, no name.
        let event = OwnedHandle(unsafe { CreateEventW(None, false, false, None)? });
        // SAFETY: an initialized, event-driven client and a live event.
        unsafe { client.SetEventHandle(event.0)? };
        // SAFETY: an initialized client.
        let render_client: IAudioRenderClient = unsafe { client.GetService()? };
        // SAFETY: an initialized client.
        let buffer_frames = unsafe { client.GetBufferSize()? };
        let stream = Stream {
            client,
            render_client,
            event,
            buffer_frames,
        };
        // Silence first, so the engine has a period before Start.
        // SAFETY: an initialized client and its render service.
        unsafe {
            stream.render_client.GetBuffer(buffer_frames)?;
            stream.render_client.ReleaseBuffer(
                buffer_frames,
                windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
            )?;
            stream.client.Start()?;
        }
        Ok(stream)
    }

    /// Writes one period's free room from `render`.
    fn fill(
        stream: &Stream,
        render: &mut Render,
        scratch: &mut Vec<f32>,
    ) -> windows::core::Result<()> {
        // SAFETY: a started client.
        let padding = unsafe { stream.client.GetCurrentPadding()? };
        let frames = frames_free(stream.buffer_frames, padding);
        if frames == 0 {
            return Ok(());
        }
        scratch.resize(frames as usize * CHANNELS, 0.0);
        render(scratch.as_mut_slice());
        // SAFETY: GetBuffer hands `frames` frames of the negotiated format
        // (stereo f32) at `data`, valid until ReleaseBuffer.
        unsafe {
            let data = stream.render_client.GetBuffer(frames)?;
            std::ptr::copy_nonoverlapping(scratch.as_ptr(), data.cast::<f32>(), scratch.len());
            stream.render_client.ReleaseBuffer(frames, 0)?;
        }
        Ok(())
    }

    fn run(
        sample_rate: u32,
        mut render: Render,
        stop: &AtomicBool,
        ready: &mpsc::Sender<Result<(), String>>,
    ) {
        let _com = match ComApartment::initialize() {
            Ok(com) => com,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        let _mmcss = MmcssTask::join();
        let mut scratch = Vec::new();
        let mut announced = false;
        while !stop.load(Ordering::SeqCst) {
            let stream = match open_stream(sample_rate) {
                Ok(stream) => stream,
                Err(error) => {
                    if !announced {
                        let _ = ready.send(Err(format!("WASAPI output: {}", error.message())));
                        return;
                    }
                    tracing::warn!(%error, "sound monitor: the output did not reopen; trying again");
                    thread::sleep(REOPEN_DELAY);
                    continue;
                }
            };
            if !announced {
                let _ = ready.send(Ok(()));
                announced = true;
            }
            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                // SAFETY: a live event handle.
                let _ = unsafe { WaitForSingleObject(stream.event.0, EVENT_WAIT_MS) };
                if let Err(error) = fill(&stream, &mut render, &mut scratch) {
                    if error.code().0 == DEVICE_INVALIDATED {
                        tracing::info!(
                            "sound monitor: the output went away; reopening on the new default"
                        );
                    } else {
                        tracing::warn!(%error, "sound monitor: the output failed; reopening");
                    }
                    break;
                }
            }
            drop(stream);
            thread::sleep(REOPEN_DELAY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_48k_stereo_float() {
        let format = render_format(48_000);
        assert_eq!(format.format_tag, 3);
        assert_eq!(format.channels, 2);
        assert_eq!(format.block_align, 8);
        assert_eq!(format.avg_bytes_per_sec, 384_000);
        assert_eq!(format.bits_per_sample, 32);
    }

    #[test]
    fn writes_only_the_buffers_free_room() {
        assert_eq!(frames_free(960, 480), 480);
        assert_eq!(frames_free(960, 960), 0);
        assert_eq!(frames_free(960, 1_000), 0);
    }

    #[test]
    fn the_flags_are_event_driven_with_conversion() {
        assert_eq!(RENDER_STREAM_FLAGS, 0x8804_0000);
        assert_eq!(DEVICE_INVALIDATED as u32, 0x8889_0004);
    }

    /// The flags are windows-rs's.
    #[cfg(windows)]
    #[test]
    fn the_flags_match_windows_rs() {
        use windows::Win32::Media::Audio as wasapi;
        assert_eq!(
            RENDER_STREAM_FLAGS,
            wasapi::AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | wasapi::AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
                | wasapi::AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        );
    }
}
