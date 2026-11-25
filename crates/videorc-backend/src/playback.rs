//! The Library's playback family on Windows and Linux (plan 260, L2): the
//! backend decodes a finished recording with FFmpeg, publishes its frames
//! into the playback's CPU ring (`playback_cpu_ring.rs`, #2031, on #1930's
//! writer) and plays its sound on the platform output the soundboard monitor
//! uses (WASAPI, PipeWire; `sound_monitor::DeviceOutput`). macOS plays it
//! with AVFoundation instead (`playback_avf.rs`): AVPlayer's sound and clock,
//! and IOSurface frames the app leases (`playback.frame.acquire/release`).
//!
//! Methods (`videorc_protocol::playback`): `playback.open {sessionId,
//! maxWidth?, maxHeight?}`, `playback.play`, `playback.pause`,
//! `playback.seek {positionMs}`, `playback.mute {muted}`, `playback.close`
//! and `playback.status`, each answering a [`PlaybackStatus`]. One playback
//! at a time: a second open closes the first. Events: `playback.status` on
//! every change and four times a second while playing; `playback.frameReady`
//! for each frame published.
//!
//! - **The file.** The session's recording, as `resource.admin.
//!   resolve_session_path` resolves it, and only a regular `.mp4` reached
//!   without a symlink whose `moov` is written (Electron's
//!   `inspectSessionMediaFile`); every refusal is typed for the player.
//! - **The picture.** FFmpeg scales to the open's `maxWidth` × `maxHeight`
//!   (1920 × 1080 when absent; aspect kept, never enlarged, even sides) and
//!   writes constant-rate I420, so frame *n* after a seek to *t* is at
//!   *t + n / fps*. The player thread paces frames to the clock and drops the
//!   ones it is late for.
//! - **The sound.** A second FFmpeg writes 48 kHz stereo f32 into a one-second
//!   buffer the output pulls from while playing; muted pulls and plays
//!   silence, so the picture and the sound stay together.
//! - **The clock** is the wall clock from the last play, seek or open.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use videorc_protocol::playback::{
    PLAYBACK_FRAME_READY_EVENT, PLAYBACK_STATUS_EVENT, PlaybackFrameReady, PlaybackOpenParams,
    PlaybackRefusal, PlaybackState, PlaybackStatus, PlaybackSurface,
};

use crate::compositor::{CompositorFrameStore, CompositorPixelFormat};
use crate::frame_store::FrameStore;
use crate::state::AppState;

/// The decode when the open names no size.
const DEFAULT_MAX: (u32, u32) = (1920, 1080);
/// The status event's rate while playing.
const STATUS_TICK: Duration = Duration::from_millis(250);
/// How long `playback.open` waits for the first frame before it answers.
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(5);
/// The sound buffered ahead of the output (one second of 48 kHz stereo).
const AUDIO_SAMPLE_RATE: u32 = 48_000;
const AUDIO_BUFFER_SAMPLES: usize = AUDIO_SAMPLE_RATE as usize * 2;
/// Top-level MP4 boxes read while looking for `moov`.
const MAX_TOP_LEVEL_BOXES: usize = 64;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// --- the file ---

/// Walks the top-level ISO BMFF boxes (`mp4TopLevelBoxTypes`): their types
/// in order, or `None` when the bytes are not a box sequence. A box that runs
/// past the end (a recorder's open `mdat`) is included and ends the walk.
pub(crate) fn mp4_top_level_box_types(
    mut read: impl FnMut(u64, usize) -> std::io::Result<Vec<u8>>,
    size: u64,
) -> Option<Vec<String>> {
    let mut types = Vec::new();
    let mut offset = 0_u64;
    while offset + 8 <= size && types.len() < MAX_TOP_LEVEL_BOXES {
        let header = read(offset, 16).ok()?;
        if header.len() < 8 {
            return None;
        }
        let size32 = u32::from_be_bytes(header[0..4].try_into().ok()?);
        let kind = &header[4..8];
        if !kind.iter().all(|byte| (0x20..=0x7e).contains(byte)) {
            return None;
        }
        let length = match size32 {
            1 => {
                if header.len() < 16 {
                    return None;
                }
                let large = u64::from_be_bytes(header[8..16].try_into().ok()?);
                if large < 16 {
                    return None;
                }
                large
            }
            0 => size - offset,
            n if n < 8 => return None,
            n => u64::from(n),
        };
        types.push(String::from_utf8_lossy(kind).into_owned());
        if offset.saturating_add(length) > size {
            break;
        }
        offset += length;
    }
    Some(types)
}

/// `inspectSessionMediaFile`: the canonical path of a playable recording,
/// or why it is not one.
pub(crate) fn inspect_file(raw: &Path) -> Result<PathBuf, PlaybackRefusal> {
    if !raw.is_absolute() || raw.components().any(|c| c.as_os_str() == "..") {
        return Err(PlaybackRefusal::NotFound);
    }
    let is_mp4 = |path: &Path| {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
    };
    if !is_mp4(raw) {
        return Err(PlaybackRefusal::NotMp4);
    }
    let link = std::fs::symlink_metadata(raw).map_err(|_| PlaybackRefusal::NotFound)?;
    if link.file_type().is_symlink() {
        return Err(PlaybackRefusal::NotFound);
    }
    let canonical = std::fs::canonicalize(raw).map_err(|_| PlaybackRefusal::NotFound)?;
    let meta = std::fs::metadata(&canonical).map_err(|_| PlaybackRefusal::NotFound)?;
    if !meta.is_file() {
        return Err(PlaybackRefusal::NotFound);
    }
    if !is_mp4(&canonical) {
        return Err(PlaybackRefusal::NotMp4);
    }
    if meta.len() == 0 {
        return Err(PlaybackRefusal::NotReady);
    }
    let mut file = std::fs::File::open(&canonical).map_err(|_| PlaybackRefusal::NotReady)?;
    let types = mp4_top_level_box_types(
        |offset, length| {
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(offset))?;
            let mut buffer = vec![0; length];
            let mut read = 0;
            while read < length {
                let n = file.read(&mut buffer[read..])?;
                if n == 0 {
                    break;
                }
                read += n;
            }
            buffer.truncate(read);
            Ok(buffer)
        },
        meta.len(),
    );
    if !types.is_some_and(|types| types.iter().any(|kind| kind == "moov")) {
        return Err(PlaybackRefusal::NotReady);
    }
    Ok(canonical)
}

/// The decode size: the file's, fitted inside `max` with its aspect kept,
/// never enlarged, both sides even (I420).
pub(crate) fn fit_size(width: u32, height: u32, max: (u32, u32)) -> (u32, u32) {
    let (width, height) = (width.max(2), height.max(2));
    let scale = (f64::from(max.0) / f64::from(width))
        .min(f64::from(max.1) / f64::from(height))
        .min(1.0);
    let even = |value: f64| ((value.round() as u32) & !1).max(2);
    (
        even(f64::from(width) * scale),
        even(f64::from(height) * scale),
    )
}

/// The probe's facts the player needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Media {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
}

fn probe(file: &Path) -> Result<Media, String> {
    let ffprobe = crate::ffmpeg::ffprobe_path_for(&crate::ffmpeg::default_ffmpeg_path());
    let probe = crate::repair::probe_media(&ffprobe, &crate::ffmpeg::ffmpeg_file_path(file))?;
    let video = probe
        .video
        .as_ref()
        .filter(|video| video.width > 0 && video.height > 0)
        .ok_or_else(|| "The recording has no picture to play.".to_string())?;
    let fps = video
        .avg_fps
        .or(video.nominal_fps)
        .filter(|fps| fps.is_finite() && *fps >= 1.0 && *fps <= 240.0)
        .unwrap_or(30.0);
    let duration = probe
        .format_duration
        .or(video.duration)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .unwrap_or(0.0);
    Ok(Media {
        duration_ms: (duration * 1000.0).round() as u64,
        width: video.width,
        height: video.height,
        fps,
        has_audio: !probe.audio.is_empty(),
    })
}

// --- the decoders ---

fn ffmpeg_command() -> Command {
    let mut command = Command::new(crate::ffmpeg::default_ffmpeg_path());
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn seek_arg(position_ms: u64) -> String {
    format!("{}.{:03}", position_ms / 1000, position_ms % 1000)
}

/// One FFmpeg child, killed and reaped when dropped.
struct Decoder {
    child: Child,
    stdout: ChildStdout,
}

impl Decoder {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .spawn()
            .map_err(|error| format!("FFmpeg did not start: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "FFmpeg gave no output pipe.".to_string())?;
        Ok(Self { child, stdout })
    }

    /// Reads exactly `buffer.len()` bytes; false at the end of the stream.
    fn read_exact(&mut self, buffer: &mut [u8]) -> bool {
        self.stdout.read_exact(buffer).is_ok()
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The picture from `position_ms`: constant-rate I420 at `size`.
fn video_decoder(
    file: &Path,
    position_ms: u64,
    size: (u32, u32),
    fps: f64,
) -> Result<Decoder, String> {
    let mut command = ffmpeg_command();
    command
        .args(["-ss", &seek_arg(position_ms), "-i"])
        .arg(crate::ffmpeg::ffmpeg_path_arg(file))
        .args([
            "-an",
            "-sn",
            "-vf",
            &format!("scale={}:{}:flags=bilinear,format=yuv420p", size.0, size.1),
            "-r",
            &format!("{fps}"),
            "-f",
            "rawvideo",
            "pipe:1",
        ]);
    Decoder::spawn(command)
}

/// The sound from `position_ms`: 48 kHz stereo f32 little-endian.
fn audio_decoder(file: &Path, position_ms: u64) -> Result<Decoder, String> {
    let mut command = ffmpeg_command();
    command
        .args(["-ss", &seek_arg(position_ms), "-i"])
        .arg(crate::ffmpeg::ffmpeg_path_arg(file))
        .args([
            "-vn",
            "-sn",
            "-ac",
            "2",
            "-ar",
            &AUDIO_SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ]);
    Decoder::spawn(command)
}

/// The sound between its decoder and the output.
#[derive(Default)]
struct AudioBuffer {
    samples: VecDeque<f32>,
    /// Bumped by every seek: a reader from before it stops writing.
    epoch: u64,
}

/// What the player thread and the output share.
struct Shared {
    status: StdMutex<PlaybackStatus>,
    playing: AtomicBool,
    muted: AtomicBool,
    audio: StdMutex<AudioBuffer>,
    audio_frames_played: AtomicU64,
}

impl Shared {
    fn status(&self) -> PlaybackStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        status.audio_frames_played = self.audio_frames_played.load(Ordering::Relaxed);
        status.muted = self.muted.load(Ordering::Relaxed);
        status
    }

    fn update(&self, change: impl FnOnce(&mut PlaybackStatus)) -> PlaybackStatus {
        {
            let mut status = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            change(&mut status);
            status.updated_at = now();
        }
        self.status()
    }
}

/// The output's real-time side: the buffered sound while playing (silence
/// when muted, still pulled), silence while paused.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn render_into(shared: &Shared, buffer: &mut [f32]) {
    if !shared.playing.load(Ordering::Relaxed) {
        buffer.fill(0.0);
        return;
    }
    let muted = shared.muted.load(Ordering::Relaxed);
    // Never wait on the decoder from the real-time thread.
    let Ok(mut audio) = shared.audio.try_lock() else {
        buffer.fill(0.0);
        return;
    };
    for sample in buffer.iter_mut() {
        let next = audio.samples.pop_front().unwrap_or(0.0);
        *sample = if muted { 0.0 } else { next };
    }
    shared
        .audio_frames_played
        .fetch_add((buffer.len() / 2) as u64, Ordering::Relaxed);
}

/// Reads the sound decoder into the buffer until the stream ends, a seek
/// starts another, or the player closes.
fn spawn_audio_reader(
    shared: Arc<Shared>,
    mut decoder: Decoder,
    epoch: u64,
    stop: Arc<AtomicBool>,
) {
    let _ = std::thread::Builder::new()
        .name("videorc-playback-audio".into())
        .spawn(move || {
            let mut bytes = vec![0_u8; 4096 * 8];
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let full = {
                    let audio = shared.audio.lock().unwrap_or_else(|p| p.into_inner());
                    if audio.epoch != epoch {
                        return;
                    }
                    audio.samples.len() >= AUDIO_BUFFER_SAMPLES
                };
                if full {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                let Ok(read) = decoder.stdout.read(&mut bytes) else {
                    return;
                };
                if read == 0 {
                    return;
                }
                let whole = read - read % 4;
                let mut audio = shared.audio.lock().unwrap_or_else(|p| p.into_inner());
                if audio.epoch != epoch {
                    return;
                }
                audio.samples.extend(
                    bytes[..whole]
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                );
                // A partial sample (a short pipe read) is dropped; FFmpeg
                // writes whole samples, so this is rare and one sample.
            }
        });
}

// --- the player ---

enum Control {
    Play,
    Pause,
    Seek(u64),
    Close,
    /// macOS only: the FFmpeg player's mute is its shared flag.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Mute(bool),
}

/// A control and, for a request, the signal that it ran.
type Message = (Control, Option<Sender<()>>);

/// How long a control's answer waits for the player thread.
const CONTROL_WAIT: Duration = Duration::from_secs(3);

/// The sound output, where the platform has one for the backend.
#[cfg(any(target_os = "linux", windows))]
type Output = crate::sound_monitor::DeviceOutput;
#[cfg(not(any(target_os = "linux", windows)))]
type Output = ();

#[cfg(any(target_os = "linux", windows))]
fn open_output(shared: &Arc<Shared>) -> Result<Output, String> {
    let shared = shared.clone();
    crate::sound_monitor::DeviceOutput::open_with(move |buffer: &mut [f32]| {
        render_into(&shared, buffer)
    })
    .map_err(|error| format!("{error:#}"))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn open_output(_shared: &Arc<Shared>) -> Result<Output, String> {
    Err("This platform plays a recording's sound in the app.".into())
}

struct Thread {
    state: AppState,
    shared: Arc<Shared>,
    control: Receiver<Message>,
    file: PathBuf,
    media: Media,
    size: (u32, u32),
    playback_id: String,
    store: CompositorFrameStore,
    /// The clock: `base_ms` at `started` while playing, `base_ms` while not.
    base_ms: u64,
    /// Where the video decoder started: frame *n* is at
    /// `origin_ms + n / fps`.
    origin_ms: u64,
    started: Option<Instant>,
    video: Option<Decoder>,
    /// Frames read since the last (re)start of the video decoder.
    decoded: u64,
    frame_id: u64,
    audio_stop: Arc<AtomicBool>,
    output: Option<Output>,
    output_failed: bool,
    last_status: Instant,
}

impl Thread {
    fn frame_len(&self) -> usize {
        let (w, h) = (self.size.0 as usize, self.size.1 as usize);
        w * h + 2 * (w.div_ceil(2) * h.div_ceil(2))
    }

    fn clock_ms(&self) -> u64 {
        let elapsed = self
            .started
            .map_or(0, |started| started.elapsed().as_millis() as u64);
        (self.base_ms + elapsed).min(self.media.duration_ms.max(self.base_ms))
    }

    fn frame_time_ms(&self, index: u64) -> u64 {
        self.origin_ms + ((index as f64) * 1000.0 / self.media.fps).round() as u64
    }

    fn emit(&self, status: &PlaybackStatus) {
        self.state.emit_event(PLAYBACK_STATUS_EVENT, status);
    }

    fn set_state(&mut self, next: PlaybackState, message: Option<String>) {
        let position_ms = self.clock_ms();
        let status = self.shared.update(|status| {
            status.state = next;
            status.position_ms = position_ms;
            if message.is_some() {
                status.message = message;
            }
        });
        self.emit(&status);
        self.last_status = Instant::now();
    }

    /// Both decoders from `position_ms`; the buffered sound is dropped.
    fn restart(&mut self, position_ms: u64) -> Result<(), String> {
        self.video = None;
        self.audio_stop.store(true, Ordering::Relaxed);
        self.audio_stop = Arc::new(AtomicBool::new(false));
        self.base_ms = position_ms;
        self.origin_ms = position_ms;
        self.decoded = 0;
        self.video = Some(video_decoder(
            &self.file,
            position_ms,
            self.size,
            self.media.fps,
        )?);
        let epoch = {
            let mut audio = self.shared.audio.lock().unwrap_or_else(|p| p.into_inner());
            audio.epoch += 1;
            audio.samples.clear();
            audio.epoch
        };
        if self.media.has_audio {
            match audio_decoder(&self.file, position_ms) {
                Ok(decoder) => {
                    spawn_audio_reader(self.shared.clone(), decoder, epoch, self.audio_stop.clone())
                }
                Err(error) => eprintln!("[playback] the sound did not start: {error}"),
            }
        }
        Ok(())
    }

    /// The next frame from the decoder, or `None` at its end.
    fn read_frame(&mut self) -> Option<(Vec<u8>, u64)> {
        let mut bytes = vec![0_u8; self.frame_len()];
        let decoder = self.video.as_mut()?;
        if !decoder.read_exact(&mut bytes) {
            self.video = None;
            return None;
        }
        let at = self.frame_time_ms(self.decoded);
        self.decoded += 1;
        Some((bytes, at))
    }

    fn publish(&mut self, bytes: Vec<u8>, position_ms: u64) {
        self.frame_id += 1;
        self.store
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .publish_with_metadata(
                self.frame_id,
                self.size.0,
                self.size.1,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                Default::default(),
                Instant::now(),
                bytes,
            );
        crate::playback_cpu_ring::notify_frame(&self.state);
        let frames = self.frame_id;
        self.shared.update(|status| {
            status.frames_published = frames;
        });
        self.state.emit_event(
            PLAYBACK_FRAME_READY_EVENT,
            PlaybackFrameReady {
                playback_id: self.playback_id.clone(),
                frame_id: self.frame_id,
                width: self.size.0,
                height: self.size.1,
                position_ms,
                iosurface_id: None,
                updated_at: now(),
            },
        );
    }

    /// The frame at the clock now, shown at once (open, a paused seek).
    fn show_first_frame(&mut self) -> bool {
        match self.read_frame() {
            Some((bytes, at)) => {
                self.publish(bytes, at);
                true
            }
            None => false,
        }
    }

    fn play(&mut self) {
        let state = self.shared.status().state;
        if state == PlaybackState::Playing {
            return;
        }
        if state == PlaybackState::Ended || self.video.is_none() {
            // `play` after the end starts over from the top.
            let from = if state == PlaybackState::Ended {
                0
            } else {
                self.base_ms
            };
            if let Err(error) = self.restart(from) {
                self.fail(error);
                return;
            }
        }
        if self.media.has_audio && self.output.is_none() && !self.output_failed {
            match open_output(&self.shared) {
                Ok(output) => self.output = Some(output),
                Err(error) => {
                    // The picture plays on; the status says why there is no sound.
                    self.output_failed = true;
                    self.shared.update(|status| {
                        status.message = Some(format!("The sound did not start: {error}"));
                    });
                }
            }
        }
        self.started = Some(Instant::now());
        self.shared.playing.store(true, Ordering::Relaxed);
        self.set_state(PlaybackState::Playing, None);
    }

    fn pause(&mut self) {
        if self.shared.status().state != PlaybackState::Playing {
            return;
        }
        self.base_ms = self.clock_ms();
        self.started = None;
        self.shared.playing.store(false, Ordering::Relaxed);
        // The decoders keep their place: they wait behind a full pipe.
        self.set_state(PlaybackState::Paused, None);
    }

    fn seek(&mut self, position_ms: u64) {
        let position_ms = position_ms.min(self.media.duration_ms);
        let playing = self.shared.status().state == PlaybackState::Playing;
        self.shared.playing.store(false, Ordering::Relaxed);
        self.started = None;
        if let Err(error) = self.restart(position_ms) {
            self.fail(error);
            return;
        }
        self.show_first_frame();
        if playing {
            self.started = Some(Instant::now());
            self.shared.playing.store(true, Ordering::Relaxed);
            self.set_state(PlaybackState::Playing, None);
        } else {
            self.set_state(PlaybackState::Paused, None);
        }
    }

    fn fail(&mut self, message: String) {
        self.video = None;
        self.shared.playing.store(false, Ordering::Relaxed);
        self.started = None;
        self.set_state(PlaybackState::Failed, Some(message));
    }

    fn end(&mut self) {
        self.base_ms = self.media.duration_ms;
        self.started = None;
        self.shared.playing.store(false, Ordering::Relaxed);
        self.set_state(PlaybackState::Ended, None);
    }

    fn run(mut self) {
        loop {
            let playing = self.started.is_some();
            let wait = if playing {
                Duration::from_millis(2)
            } else {
                STATUS_TICK
            };
            match self.control.recv_timeout(wait) {
                Ok((control, ack)) => {
                    let close = matches!(control, Control::Close);
                    match control {
                        Control::Play => self.play(),
                        Control::Pause => self.pause(),
                        Control::Seek(position) => self.seek(position),
                        Control::Close | Control::Mute(_) => {}
                    }
                    if let Some(ack) = ack {
                        let _ = ack.send(());
                    }
                    if close {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self.started.is_none() {
                continue;
            }
            // Publish every frame the clock has reached; drop the ones it is
            // well past (a slow decode), keep the newest.
            let clock = self.clock_ms();
            let frame_ms = (1000.0 / self.media.fps).max(1.0) as u64;
            loop {
                let next_at = self.frame_time_ms(self.decoded);
                if next_at > clock {
                    break;
                }
                match self.read_frame() {
                    Some((bytes, at)) => {
                        if at + 2 * frame_ms >= clock || self.frame_time_ms(self.decoded) > clock {
                            self.publish(bytes, at);
                        }
                    }
                    None => {
                        self.end();
                        break;
                    }
                }
            }
            if self.started.is_some()
                && self.clock_ms() >= self.media.duration_ms
                && self.media.duration_ms > 0
            {
                self.end();
            }
            if self.started.is_some() && self.last_status.elapsed() >= STATUS_TICK {
                let position_ms = self.clock_ms();
                let status = self
                    .shared
                    .update(|status| status.position_ms = position_ms);
                self.emit(&status);
                self.last_status = Instant::now();
            }
        }
        self.audio_stop.store(true, Ordering::Relaxed);
        self.shared.playing.store(false, Ordering::Relaxed);
        self.video = None;
        self.output = None;
    }
}

struct Player {
    playback_id: String,
    shared: Arc<Shared>,
    control: Sender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Player {
    fn drop(&mut self) {
        let _ = self.control.send((Control::Close, None));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The one playback (on `AppState`).
#[derive(Default)]
pub struct PlaybackService {
    player: StdMutex<Option<Player>>,
    /// macOS: AVFoundation's player (`playback_avf.rs`).
    #[cfg(target_os = "macos")]
    mac: StdMutex<Option<crate::playback_avf::MacPlayer>>,
    next_id: AtomicU64,
    /// The last status after a close or a refusal, for `playback.status`.
    last: StdMutex<Option<PlaybackStatus>>,
}

impl std::fmt::Debug for PlaybackService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlaybackService")
            .finish_non_exhaustive()
    }
}

fn surface() -> PlaybackSurface {
    if cfg!(target_os = "macos") {
        PlaybackSurface::Iosurface
    } else {
        PlaybackSurface::CpuRing
    }
}

impl PlaybackService {
    fn take(&self) -> Option<Player> {
        self.player.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    fn remember(&self, status: PlaybackStatus) -> PlaybackStatus {
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(status.clone());
        status
    }

    pub fn status(&self) -> PlaybackStatus {
        #[cfg(target_os = "macos")]
        if let Some(player) = self.mac.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            return player.status();
        }
        if let Some(player) = self
            .player
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            return player.shared.status();
        }
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(|| PlaybackStatus::closed(now()))
    }

    /// Sends a control and the receiver of its signal, when a playback is
    /// open.
    fn send(&self, control: Control) -> Option<Receiver<()>> {
        let guard = self.player.lock().unwrap_or_else(|p| p.into_inner());
        let player = guard.as_ref()?;
        let (ack_tx, ack_rx) = mpsc::channel();
        player.control.send((control, Some(ack_tx))).ok()?;
        Some(ack_rx)
    }
}

/// `playback.close`: nothing open after it.
pub async fn close(state: &AppState) -> PlaybackStatus {
    let player = state.playback.take();
    if let Some(player) = player {
        // Joining waits for FFmpeg to be reaped: off the async runtime.
        let _ = tokio::task::spawn_blocking(move || drop(player)).await;
    }
    #[cfg(target_os = "macos")]
    {
        let mac = state
            .playback
            .mac
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(mut mac) = mac {
            // AVFoundation's objects go on the main run loop.
            let _ = tokio::task::spawn_blocking(move || mac.close()).await;
        }
    }
    state.playback_frames.install(None);
    let status = state.playback.remember(PlaybackStatus::closed(now()));
    state.emit_event(PLAYBACK_STATUS_EVENT, &status);
    status
}

fn refused(
    state: &AppState,
    session_id: &str,
    refusal: Option<PlaybackRefusal>,
    message: String,
) -> PlaybackStatus {
    let status = state.playback.remember(PlaybackStatus {
        state: PlaybackState::Failed,
        session_id: Some(session_id.to_string()),
        refusal,
        message: Some(message),
        ..PlaybackStatus::closed(now())
    });
    state.emit_event(PLAYBACK_STATUS_EVENT, &status);
    status
}

/// `playback.open`: closes any playback, checks the file, probes it, and
/// answers once the first frame is in the ring (paused at 0:00).
// macOS returns from its cfg block early; elsewhere FFmpeg is the tail.
#[cfg_attr(target_os = "macos", allow(clippy::needless_return))]
pub async fn open(state: &AppState, params: PlaybackOpenParams) -> PlaybackStatus {
    close(state).await;
    let session_id = params.session_id.clone();
    let path = match crate::session_recording_path(state, &session_id) {
        Ok(path) => PathBuf::from(path),
        Err(_) => {
            return refused(
                state,
                &session_id,
                Some(PlaybackRefusal::NotFound),
                "This recording's file is gone.".into(),
            );
        }
    };
    let checked = tokio::task::spawn_blocking(move || {
        let file = inspect_file(&path).map_err(|refusal| (Some(refusal), String::new()))?;
        let media = probe(&file).map_err(|message| (None, message))?;
        Ok::<_, (Option<PlaybackRefusal>, String)>((file, media))
    })
    .await;
    let (file, media) = match checked {
        Ok(Ok(found)) => found,
        Ok(Err((refusal, message))) => {
            let message = match refusal {
                Some(PlaybackRefusal::NotFound) => "This recording's file is gone.".into(),
                Some(PlaybackRefusal::NotMp4) => "Only MP4 recordings play in Videorc.".into(),
                Some(PlaybackRefusal::NotReady) => {
                    "This recording is still being saved. Try again in a moment.".into()
                }
                None => message,
            };
            return refused(state, &session_id, refusal, message);
        }
        Err(error) => return refused(state, &session_id, None, error.to_string()),
    };

    let max = (
        params
            .max_width
            .filter(|w| *w >= 2)
            .unwrap_or(DEFAULT_MAX.0),
        params
            .max_height
            .filter(|h| *h >= 2)
            .unwrap_or(DEFAULT_MAX.1),
    );
    let size = fit_size(media.width, media.height, max);
    let id = state.playback.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let playback_id = format!("playback-{id}");
    // macOS: AVFoundation plays it (sound, clock, IOSurface frames).
    #[cfg(target_os = "macos")]
    {
        let base = PlaybackStatus {
            state: PlaybackState::Opening,
            playback_id: Some(playback_id.clone()),
            session_id: Some(session_id.clone()),
            duration_ms: media.duration_ms,
            width: size.0,
            height: size.1,
            fps: media.fps,
            has_audio: media.has_audio,
            surface: surface(),
            ..PlaybackStatus::closed(now())
        };
        let owned = state.clone();
        let opened = tokio::task::spawn_blocking(move || {
            crate::playback_avf::MacPlayer::open(owned, &file, base, size)
        })
        .await;
        return match opened {
            Ok(Ok(player)) => {
                let status = player.status();
                *state.playback.mac.lock().unwrap_or_else(|p| p.into_inner()) = Some(player);
                state.emit_event(PLAYBACK_STATUS_EVENT, &status);
                status
            }
            Ok(Err(message)) => refused(state, &session_id, None, message),
            Err(error) => refused(state, &session_id, None, error.to_string()),
        };
    }
    #[cfg(not(target_os = "macos"))]
    open_ffmpeg(state, session_id, playback_id, file, media, size).await
}

/// Windows and Linux: FFmpeg decodes into the playback ring and the sound
/// plays on the platform output.
#[cfg_attr(target_os = "macos", allow(dead_code))]
async fn open_ffmpeg(
    state: &AppState,
    session_id: String,
    playback_id: String,
    file: PathBuf,
    media: Media,
    size: (u32, u32),
) -> PlaybackStatus {
    let shared = Arc::new(Shared {
        status: StdMutex::new(PlaybackStatus {
            state: PlaybackState::Opening,
            playback_id: Some(playback_id.clone()),
            session_id: Some(session_id.clone()),
            duration_ms: media.duration_ms,
            width: size.0,
            height: size.1,
            fps: media.fps,
            has_audio: media.has_audio,
            surface: surface(),
            ..PlaybackStatus::closed(now())
        }),
        playing: AtomicBool::new(false),
        muted: AtomicBool::new(false),
        audio: StdMutex::new(AudioBuffer::default()),
        audio_frames_played: AtomicU64::new(0),
    });
    let store: CompositorFrameStore = Arc::new(StdMutex::new(FrameStore::new(2)));
    if surface() == PlaybackSurface::CpuRing {
        state.playback_frames.install(Some(store.clone()));
    }
    let (control_tx, control_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let mut thread = Thread {
        state: state.clone(),
        shared: shared.clone(),
        control: control_rx,
        file,
        media,
        size,
        playback_id: playback_id.clone(),
        store,
        base_ms: 0,
        origin_ms: 0,
        started: None,
        video: None,
        decoded: 0,
        frame_id: 0,
        audio_stop: Arc::new(AtomicBool::new(false)),
        output: None,
        output_failed: false,
        last_status: Instant::now(),
    };
    let spawned = std::thread::Builder::new()
        .name("videorc-playback".into())
        .spawn(move || {
            let first = thread.restart(0).and_then(|()| {
                if thread.show_first_frame() {
                    Ok(())
                } else {
                    Err("The recording's first frame could not be decoded.".to_string())
                }
            });
            let ok = first.is_ok();
            let _ = ready_tx.send(first);
            if ok {
                thread.run();
            }
        });
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            state.playback_frames.install(None);
            return refused(
                state,
                &session_id,
                None,
                format!("Playback did not start: {error}"),
            );
        }
    };
    let ready = tokio::task::spawn_blocking(move || ready_rx.recv_timeout(FIRST_FRAME_WAIT)).await;
    match ready {
        Ok(Ok(Ok(()))) => {}
        other => {
            let message = match other {
                Ok(Ok(Err(message))) => message,
                _ => "The recording's first frame took too long to decode.".to_string(),
            };
            let _ = control_tx.send((Control::Close, None));
            let _ = tokio::task::spawn_blocking(move || handle.join()).await;
            state.playback_frames.install(None);
            return refused(state, &session_id, None, message);
        }
    }
    let status = shared.update(|status| status.state = PlaybackState::Paused);
    *state
        .playback
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(Player {
        playback_id,
        shared,
        control: control_tx,
        thread: Some(handle),
    });
    state.emit_event(PLAYBACK_STATUS_EVENT, &status);
    status
}

/// macOS: the control on AVFoundation's player, off the async runtime (it
/// waits for the main run loop). `None` when no macOS playback is open.
#[cfg(target_os = "macos")]
async fn mac_control(state: &AppState, control: Control) -> Option<PlaybackStatus> {
    let service = state.playback.clone();
    let status = tokio::task::spawn_blocking(move || {
        let guard = service.mac.lock().unwrap_or_else(|p| p.into_inner());
        let player = guard.as_ref()?;
        Some(match control {
            Control::Play => player.play(),
            Control::Pause => player.pause(),
            Control::Seek(position) => player.seek(position),
            Control::Mute(muted) => player.mute(muted),
            Control::Close => player.status(),
        })
    })
    .await
    .ok()
    .flatten()?;
    state.emit_event(PLAYBACK_STATUS_EVENT, &status);
    Some(status)
}

/// A control, answered with the status once the player thread ran it (a
/// seek's first frame is in the ring by then).
async fn control(state: &AppState, control: Control) -> PlaybackStatus {
    #[cfg(target_os = "macos")]
    let control = {
        let mac = match &control {
            Control::Play => Some(Control::Play),
            Control::Pause => Some(Control::Pause),
            Control::Seek(position) => Some(Control::Seek(*position)),
            _ => None,
        };
        if let Some(mac) = mac
            && let Some(status) = mac_control(state, mac).await
        {
            return status;
        }
        control
    };
    if let Some(ack) = state.playback.send(control) {
        let _ = tokio::task::spawn_blocking(move || ack.recv_timeout(CONTROL_WAIT)).await;
    }
    state.playback.status()
}

pub async fn play(state: &AppState) -> PlaybackStatus {
    control(state, Control::Play).await
}

pub async fn pause(state: &AppState) -> PlaybackStatus {
    control(state, Control::Pause).await
}

pub async fn seek(state: &AppState, position_ms: u64) -> PlaybackStatus {
    control(state, Control::Seek(position_ms)).await
}

/// `playback.mute`: the sound goes silent and keeps its place.
pub async fn mute(state: &AppState, muted: bool) -> PlaybackStatus {
    #[cfg(target_os = "macos")]
    if let Some(status) = mac_control(state, Control::Mute(muted)).await {
        return status;
    }
    let guard = state
        .playback
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(player) = guard.as_ref() {
        player.shared.muted.store(muted, Ordering::Relaxed);
        let status = player.shared.update(|_| {});
        drop(guard);
        state.emit_event(PLAYBACK_STATUS_EVENT, &status);
        return status;
    }
    drop(guard);
    state.playback.status()
}

/// The open playback's id, for a frame event's reader.
#[allow(dead_code)]
pub fn playback_id(state: &AppState) -> Option<String> {
    state
        .playback
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|player| player.playback_id.clone())
}

/// A leased frame on its socket: the lease id and the frame, whose
/// IOSurface stays valid until the release or the socket's end.
#[cfg(target_os = "macos")]
pub(crate) type PlaybackFrameLease = Option<(String, Arc<crate::playback_avf::Frame>)>;
#[cfg(not(target_os = "macos"))]
pub(crate) type PlaybackFrameLease = Option<(String, ())>;

/// `playback.frame.acquire` and `playback.frame.release` on the socket's
/// own task (like the preview's frame leases): `None` for every other
/// message. Main-process (admin) credential only; one lease at a time; the
/// lease ends with the socket. macOS only: elsewhere the frames are in the
/// playback ring (`playback.cpu.*`).
pub(crate) fn handle_playback_frame_lease_control(
    state: &AppState,
    role: crate::backend_authority::BackendRole,
    lease: &mut PlaybackFrameLease,
    text: &str,
) -> Option<crate::protocol::ServerResponse> {
    use crate::protocol::{ClientCommand, ServerResponse};
    use videorc_protocol::playback::{PlaybackFrameAcquireParams, PlaybackFrameReleaseParams};

    if !text.contains("playback.frame.") {
        return None;
    }
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    let acquire = match command.method.as_str() {
        "playback.frame.acquire" => true,
        "playback.frame.release" => false,
        _ => return None,
    };
    if role != crate::backend_authority::BackendRole::Admin {
        return Some(ServerResponse::error(
            command.id,
            "forbidden",
            "Playback frame leases require the main-process credential.",
        ));
    }
    if !acquire {
        return Some(
            match serde_json::from_value::<PlaybackFrameReleaseParams>(command.params) {
                Ok(params) => {
                    let matches = lease.as_ref().is_some_and(|(id, _)| *id == params.lease_id);
                    if matches {
                        *lease = None;
                    }
                    ServerResponse::ok(command.id, matches)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            },
        );
    }
    let params = match serde_json::from_value::<PlaybackFrameAcquireParams>(command.params) {
        Ok(params) => params,
        Err(error) => {
            return Some(ServerResponse::error(
                command.id,
                "invalid-params",
                error.to_string(),
            ));
        }
    };
    if lease.is_some() {
        return Some(ServerResponse::error(
            command.id,
            "playback-frame-busy",
            "Release the outstanding playback frame first.",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        let frame = state
            .playback
            .mac
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|player| player.playback_id == params.playback_id)
            .and_then(|player| player.latest());
        Some(match frame {
            Some(frame) => {
                let response = ServerResponse::ok(command.id, &frame.frame);
                *lease = Some((params.lease_id, frame));
                response
            }
            None => ServerResponse::ok(command.id, serde_json::Value::Null),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, params);
        Some(ServerResponse::error(
            command.id,
            "playback-frame-unsupported",
            "Playback frames come through the playback ring here (playback.cpu.open).",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxes(spec: &[(u32, &[u8; 4])], tail: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (size, kind) in spec {
            bytes.extend_from_slice(&size.to_be_bytes());
            bytes.extend_from_slice(*kind);
            bytes.resize(bytes.len() + (*size as usize).saturating_sub(8), 0);
        }
        bytes.resize(bytes.len() + tail, 0);
        bytes
    }

    fn walk(bytes: &[u8]) -> Option<Vec<String>> {
        mp4_top_level_box_types(
            |offset, length| {
                let start = (offset as usize).min(bytes.len());
                let end = (start + length).min(bytes.len());
                Ok(bytes[start..end].to_vec())
            },
            bytes.len() as u64,
        )
    }

    #[test]
    fn a_finished_mp4_has_its_moov() {
        let file = boxes(&[(24, b"ftyp"), (16, b"mdat"), (32, b"moov")], 0);
        assert_eq!(walk(&file).unwrap(), ["ftyp", "mdat", "moov"]);
    }

    #[test]
    fn a_recording_in_progress_has_an_open_mdat_and_no_moov() {
        let mut file = boxes(&[(24, b"ftyp")], 0);
        file.extend_from_slice(&0_u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.resize(file.len() + 100, 0);
        let types = walk(&file).unwrap();
        assert_eq!(types, ["ftyp", "mdat"]);
        assert!(!types.iter().any(|kind| kind == "moov"));
    }

    #[test]
    fn bytes_that_are_not_boxes_are_refused() {
        assert!(walk(&[0, 0, 0, 4, b'f', b't', b'y', b'p']).is_none());
        assert!(walk(&[0, 0, 0, 16, 0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]).is_none());
    }

    #[test]
    fn the_decode_fits_the_slot_and_is_never_enlarged() {
        assert_eq!(fit_size(3840, 2160, (1920, 1080)), (1920, 1080));
        assert_eq!(fit_size(1280, 720, (1920, 1080)), (1280, 720));
        assert_eq!(fit_size(1080, 1920, (1920, 1080)), (608, 1080));
        assert_eq!(fit_size(1921, 1081, (1920, 1080)).0 % 2, 0);
    }

    #[test]
    fn refusals_are_typed() {
        assert_eq!(
            inspect_file(Path::new("relative.mp4")),
            Err(PlaybackRefusal::NotFound)
        );
        let dir = std::env::temp_dir().join(format!("videorc-playback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mkv = dir.join("take.mkv");
        std::fs::write(&mkv, b"x").unwrap();
        assert_eq!(inspect_file(&mkv), Err(PlaybackRefusal::NotMp4));
        let empty = dir.join("empty.mp4");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(inspect_file(&empty), Err(PlaybackRefusal::NotReady));
        let open = dir.join("open.mp4");
        std::fs::write(&open, boxes(&[(24, b"ftyp"), (16, b"mdat")], 0)).unwrap();
        assert_eq!(inspect_file(&open), Err(PlaybackRefusal::NotReady));
        let done = dir.join("done.mp4");
        std::fs::write(
            &done,
            boxes(&[(24, b"ftyp"), (16, b"mdat"), (16, b"moov")], 0),
        )
        .unwrap();
        assert!(inspect_file(&done).is_ok());
        assert_eq!(
            inspect_file(&dir.join("missing.mp4")),
            Err(PlaybackRefusal::NotFound)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn muted_playback_still_pulls_the_sound_and_paused_does_not() {
        let shared = Shared {
            status: StdMutex::new(PlaybackStatus::closed(now())),
            playing: AtomicBool::new(true),
            muted: AtomicBool::new(true),
            audio: StdMutex::new(AudioBuffer::default()),
            audio_frames_played: AtomicU64::new(0),
        };
        shared.audio.lock().unwrap().samples.extend([0.5_f32; 8]);
        let mut out = [1.0_f32; 4];
        render_into(&shared, &mut out);
        assert_eq!(out, [0.0; 4]);
        assert_eq!(shared.audio.lock().unwrap().samples.len(), 4);
        shared.muted.store(false, Ordering::Relaxed);
        render_into(&shared, &mut out);
        assert_eq!(out, [0.5; 4]);
        shared.playing.store(false, Ordering::Relaxed);
        shared.audio.lock().unwrap().samples.extend([0.5_f32; 4]);
        render_into(&shared, &mut out);
        assert_eq!(out, [0.0; 4]);
        assert_eq!(shared.audio.lock().unwrap().samples.len(), 4);
        assert_eq!(shared.audio_frames_played.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn a_seek_argument_is_seconds_with_milliseconds() {
        assert_eq!(seek_arg(0), "0.000");
        assert_eq!(seek_arg(61_005), "61.005");
    }
}
