//! The sound monitor's Linux output (plan 260 S1.3): one PipeWire playback
//! stream to the default sink, filled from the monitor's mix on PipeWire's
//! real-time thread, as CoreAudio's render callback fills it on macOS.
//!
//! Never into the room, the program or a recording: Linux has no System audio
//! capture yet (plan 257 S8), and Videorc's microphones never list a monitor
//! source (`linux_pulse_audio.rs`). The stream carries
//! [`SOUND_MONITOR_NODE_NAME`] and [`SOUND_MONITOR_MARKER`] so S8's desktop
//! audio capture can leave this node out, as ScreenCaptureKit leaves out this
//! process on macOS.
//!
//! The stream runs on a thread of its own with its own PipeWire main loop
//! (the portal's video stream does the same, `linux_pipewire_stream.rs`).
//! Dropping the [`PlaybackStream`] quits the loop and joins the thread.
#![cfg(target_os = "linux")]

use std::sync::mpsc;
use std::time::Duration;

use pipewire as pw;
use pw::spa;
use pw::spa::pod::Pod;

/// The node's name in the PipeWire graph (`pw-top`, `wpctl status`).
pub(crate) const SOUND_MONITOR_NODE_NAME: &str = "videorc-sound-monitor";
/// A property only this stream carries: S8's capture leaves such nodes out.
pub(crate) const SOUND_MONITOR_MARKER: &str = "videorc.sound-monitor";

const CHANNELS: usize = 2;
const FRAME_BYTES: usize = CHANNELS * std::mem::size_of::<f32>();
/// 10 ms quanta at 48 kHz: the latency CoreAudio's default output gives.
const NODE_LATENCY: &str = "480/48000";
/// How long `open` waits for the loop to come up and connect the stream.
const OPEN_WAIT: Duration = Duration::from_secs(3);
/// How often the loop looks at its stop channel.
const STOP_POLL: Duration = Duration::from_millis(50);

/// What fills each quantum: interleaved stereo f32 at 48 kHz.
pub(crate) type Render = Box<dyn FnMut(&mut [f32]) + Send + 'static>;

/// A playing stream. Dropping it stops the stream and its thread.
pub(crate) struct PlaybackStream {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PlaybackStream {
    /// Connects a playback stream to the default sink and starts pulling
    /// quanta from `render`.
    pub(crate) fn open(sample_rate: u32, render: Render) -> anyhow::Result<Self> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("videorc-sound-monitor-pw".into())
            .spawn(move || {
                if let Err(error) = run(sample_rate, render, stop_rx, &ready_tx) {
                    let _ = ready_tx.send(Err(error));
                }
            })?;
        match ready_rx.recv_timeout(OPEN_WAIT) {
            Ok(Ok(())) => Ok(Self {
                stop: Some(stop_tx),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                drop(stop_tx);
                let _ = thread.join();
                anyhow::bail!(error)
            }
            Err(_) => {
                // The loop never answered: dropping the sender ends it at its
                // next poll, and the thread is left to finish on its own.
                drop(stop_tx);
                anyhow::bail!("PipeWire did not open the output in time")
            }
        }
    }
}

impl Drop for PlaybackStream {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Filler {
    render: Render,
    scratch: Vec<f32>,
}

/// The quantum to fill: what PipeWire asked for, within the buffer's room.
fn frames_to_fill(requested: u64, capacity_frames: usize) -> usize {
    match usize::try_from(requested) {
        Ok(0) | Err(_) => capacity_frames,
        Ok(requested) => requested.min(capacity_frames),
    }
}

/// Writes `samples` as little-endian f32 into `bytes`; returns the bytes written.
fn write_f32_le(samples: &[f32], bytes: &mut [u8]) -> usize {
    let mut written = 0;
    for (out, sample) in bytes.chunks_exact_mut(4).zip(samples) {
        out.copy_from_slice(&sample.to_le_bytes());
        written += 4;
    }
    written
}

fn run(
    sample_rate: u32,
    render: Render,
    stop_rx: mpsc::Receiver<()>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    pw::init();
    let mainloop =
        pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = pw::context::ContextRc::new(&mainloop, None)
        .map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context
        .connect_rc(None)
        .map_err(|e| format!("PipeWire connect: {e}"))?;

    let stream = pw::stream::StreamBox::new(
        &core,
        SOUND_MONITOR_NODE_NAME,
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Playback",
            *pw::keys::AUDIO_CHANNELS => "2",
            *pw::keys::NODE_NAME => SOUND_MONITOR_NODE_NAME,
            *pw::keys::NODE_LATENCY => NODE_LATENCY,
            *pw::keys::APP_NAME => "Videorc",
            SOUND_MONITOR_MARKER => "true",
        },
    )
    .map_err(|e| format!("PipeWire stream: {e}"))?;

    let _listener = stream
        .add_local_listener_with_user_data(Filler {
            render,
            scratch: Vec::new(),
        })
        .process(|stream, filler| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let requested = buffer.requested();
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };
            let written = match data.data() {
                Some(slice) => {
                    let frames = frames_to_fill(requested, slice.len() / FRAME_BYTES);
                    filler.scratch.resize(frames * CHANNELS, 0.0);
                    (filler.render)(&mut filler.scratch);
                    write_f32_le(&filler.scratch, slice)
                }
                None => 0,
            };
            let chunk = data.chunk_mut();
            *chunk.offset_mut() = 0;
            *chunk.stride_mut() = FRAME_BYTES as i32;
            *chunk.size_mut() = written as u32;
        })
        .register()
        .map_err(|e| format!("PipeWire stream listener: {e}"))?;

    let mut audio_info = spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
    audio_info.set_rate(sample_rate);
    audio_info.set_channels(CHANNELS as u32);
    let mut position = [0; spa::param::audio::MAX_CHANNELS];
    position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
    position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    audio_info.set_position(position);
    let values: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object {
            type_: spa::sys::SPA_TYPE_OBJECT_Format,
            id: spa::sys::SPA_PARAM_EnumFormat,
            properties: audio_info.into(),
        }),
    )
    .map_err(|e| format!("PipeWire format pod: {e:?}"))?
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&values).ok_or("PipeWire format pod is not a pod")?];
    stream
        .connect(
            spa::utils::Direction::Output,
            None,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::RT_PROCESS,
            &mut params,
        )
        .map_err(|e| format!("PipeWire stream connect: {e}"))?;

    let timer = {
        let quit_loop = mainloop.clone();
        mainloop.loop_().add_timer(move |_| {
            if matches!(
                stop_rx.try_recv(),
                Ok(()) | Err(mpsc::TryRecvError::Disconnected)
            ) {
                quit_loop.quit();
            }
        })
    };
    timer
        .update_timer(Some(STOP_POLL), Some(STOP_POLL))
        .into_result()
        .map_err(|e| format!("PipeWire stop timer: {e}"))?;

    let _ = ready.send(Ok(()));
    mainloop.run();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_what_pipewire_asked_for_within_the_buffer() {
        assert_eq!(frames_to_fill(480, 8192), 480);
        assert_eq!(
            frames_to_fill(0, 1024),
            1024,
            "no request: the whole buffer"
        );
        assert_eq!(frames_to_fill(9000, 1024), 1024);
    }

    #[test]
    fn writes_little_endian_f32_and_stops_at_the_shorter_side() {
        let mut bytes = [0u8; 12];
        assert_eq!(write_f32_le(&[1.0, -0.5], &mut bytes), 8);
        assert_eq!(&bytes[..4], &1.0_f32.to_le_bytes());
        assert_eq!(&bytes[4..8], &(-0.5_f32).to_le_bytes());
        assert_eq!(&bytes[8..], &[0, 0, 0, 0]);
        let mut short = [0u8; 4];
        assert_eq!(write_f32_le(&[0.25, 0.75], &mut short), 4);
    }
}
