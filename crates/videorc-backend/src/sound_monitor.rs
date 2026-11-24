//! The soundboard monitor, "Hear sounds yourself" (plan 189 D2; plan 220
//! S1.3b): the backend plays each voice the streamer should hear to the
//! default output device, from the same decoded PCM the session bus mixes and
//! at the same gain (level + trim + board), ahead of the bus by its playout
//! delay. Off air every press is heard; on air only with the monitor on. The
//! player (`sound_player.rs`) decides which voices those are and hands them
//! here after every change; this module only plays them.
//!
//! Never doubled (plan 069 decision 9): the monitor is its own mix and its own
//! output, and nothing here reaches the session bus. Its sound leaves this
//! process through CoreAudio, and the System audio capture runs in this same
//! process with `setExcludesCurrentProcessAudio(true)`
//! (`system_audio_capture.rs`), so ScreenCaptureKit drops it. `pnpm
//! smoke:soundboard` proves it: an on-air press with System audio on lands in
//! the file once, and a monitor-only voice playing through a System-audio
//! recording leaves nothing at 1 kHz while an afplay control tone does.
//!
//! The output opens on the first voice and closes after
//! [`MONITOR_IDLE_CLOSE`] with nothing playing, so an idle Videorc holds no
//! output device. It follows the system's default output (the device Chromium's
//! Web Audio monitor used).
//!
//! macOS only (S1.3b fence): Windows and Linux keep the renderer's Web Audio
//! monitor (`renderer/src/lib/sound-monitor.ts`) until S1.3d gives the
//! backend an output there, and [`SoundMonitor`] is inert on them.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::mpsc;
use std::time::Duration;

use crate::sound_mix::SOUND_RAMP_FRAMES;

/// The monitor renders the bus's format: 48 kHz interleaved stereo; CoreAudio
/// converts to the device.
pub(crate) const MONITOR_SAMPLE_RATE: u32 = 48_000;
/// A voice whose press is older than this when the monitor starts it (the
/// monitor turned on mid-sound, the session ended under an unheard voice, a
/// slow first load) joins where the bus is instead of playing from the top.
pub(crate) const MONITOR_LATE_JOIN_MS: u64 = 300;
/// With nothing playing this long, the output closes and lets the device go.
pub(crate) const MONITOR_IDLE_CLOSE: Duration = Duration::from_secs(5);
/// A stop or a restart fades the old voice out over 5 ms, like the bus.
const STOP_RAMP_FRAMES: u32 = SOUND_RAMP_FRAMES as u32;
/// A level, trim or board change glides over 10 ms: no zipper.
const GAIN_GLIDE_FRAMES: u32 = MONITOR_SAMPLE_RATE / 100;
/// Room for the reports of a burst of ended voices without allocating in the
/// render callback (eight voices, each restarted a few times between drains).
const REPORT_CAPACITY: usize = 64;

/// A voice the player wants heard.
#[derive(Debug, Clone)]
pub(crate) struct MonitorVoice {
    pub key: u64,
    /// Interleaved stereo s16 at 48 kHz: the library's PCM, shared with the bus.
    pub pcm: Arc<[i16]>,
    /// Linear `levelDb + volumeDb + board volumeDb`.
    pub gain: f32,
    pub looping: bool,
    /// Where a new voice starts in its sound (a late join; at or past the
    /// end, a one-shot never starts); ignored for a voice already playing.
    pub offset_frames: usize,
}

/// A voice that left the monitor's mix, for the log (`smoke:soundboard`
/// reads it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VoiceReport {
    pub key: u64,
    /// Frames rendered to the output.
    pub rendered: u64,
    /// The sound's length in frames.
    pub frames: usize,
    /// The first frame it played (a late join starts past zero).
    pub offset: usize,
    /// Stopped (faded out) rather than played to its end.
    pub stopped: bool,
}

// Read only by `render`, which plays on macOS alone (S1.8d d3 made the
// device callback generic).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug)]
struct MixVoice {
    key: u64,
    pcm: Arc<[i16]>,
    /// The next source frame.
    frame: usize,
    offset: usize,
    looping: bool,
    gain: f32,
    target: f32,
    /// Frames left in the glide toward `target`.
    glide: u32,
    /// Frames left in the stop ramp; `None` while playing.
    stop: Option<u32>,
    rendered: u64,
    finished: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl MixVoice {
    fn frames(&self) -> usize {
        self.pcm.len() / 2
    }

    fn report(&self) -> VoiceReport {
        VoiceReport {
            key: self.key,
            rendered: self.rendered,
            frames: self.frames(),
            offset: self.offset,
            stopped: self.stop.is_some(),
        }
    }
}

/// The monitor's voices: a pure renderer over pre-decoded PCM, shared between
/// the player's thread (start, stop, gain) and the output's render callback.
/// Every method takes the lock briefly; `render` never allocates unless more
/// than [`REPORT_CAPACITY`] voices end between two drains.
#[derive(Debug)]
pub(crate) struct MonitorMix {
    voices: Vec<MixVoice>,
    reports: Vec<VoiceReport>,
}

impl Default for MonitorMix {
    fn default() -> Self {
        Self {
            voices: Vec::new(),
            reports: Vec::with_capacity(REPORT_CAPACITY),
        }
    }
}

impl MonitorMix {
    /// Adds a voice at `offset_frames` into its sound. A one-shot whose
    /// offset is past its end, or an empty sound, never starts.
    pub(crate) fn start(&mut self, voice: &MonitorVoice) -> bool {
        let frames = voice.pcm.len() / 2;
        if frames == 0 {
            return false;
        }
        let offset = if voice.looping {
            voice.offset_frames % frames
        } else if voice.offset_frames < frames {
            voice.offset_frames
        } else {
            return false;
        };
        self.voices.push(MixVoice {
            key: voice.key,
            pcm: voice.pcm.clone(),
            frame: offset,
            offset,
            looping: voice.looping,
            gain: voice.gain,
            target: voice.gain,
            glide: 0,
            stop: None,
            rendered: 0,
            finished: false,
        });
        true
    }

    /// Fades the voice out over 5 ms from the next rendered frame.
    pub(crate) fn stop(&mut self, key: u64) {
        for voice in self.voices.iter_mut().filter(|voice| voice.key == key) {
            if voice.stop.is_none() {
                voice.stop = Some(STOP_RAMP_FRAMES);
            }
        }
    }

    /// Glides a playing voice to `gain` over 10 ms.
    pub(crate) fn set_gain(&mut self, key: u64, gain: f32) {
        for voice in self.voices.iter_mut().filter(|voice| voice.key == key) {
            if (voice.target - gain).abs() > f32::EPSILON {
                voice.target = gain;
                voice.glide = GAIN_GLIDE_FRAMES;
            }
        }
    }

    /// The output could not open: nothing here can be heard.
    pub(crate) fn clear(&mut self) {
        self.voices.clear();
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.voices.is_empty()
    }

    /// The reports of the voices that left since the last call.
    pub(crate) fn take_reports(&mut self) -> Vec<VoiceReport> {
        if self.reports.is_empty() {
            return Vec::new();
        }
        std::mem::replace(&mut self.reports, Vec::with_capacity(REPORT_CAPACITY))
    }

    /// Writes every voice, summed, into `out` (interleaved stereo; a trailing
    /// odd sample is silence). Voices that end leave the mix with a report.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn render(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        for voice in self.voices.iter_mut() {
            let frames = voice.frames();
            for slot in out.chunks_exact_mut(2) {
                if voice.frame >= frames {
                    if voice.looping && frames > 0 {
                        voice.frame = 0;
                    } else {
                        voice.finished = true;
                        break;
                    }
                }
                let ramp = match voice.stop.as_mut() {
                    Some(0) => {
                        voice.finished = true;
                        break;
                    }
                    Some(left) => {
                        *left -= 1;
                        *left as f32 / STOP_RAMP_FRAMES as f32
                    }
                    None => 1.0,
                };
                if voice.glide > 0 {
                    voice.gain += (voice.target - voice.gain) / voice.glide as f32;
                    voice.glide -= 1;
                    if voice.glide == 0 {
                        voice.gain = voice.target;
                    }
                }
                let gain = voice.gain * ramp;
                let index = voice.frame * 2;
                slot[0] += f32::from(voice.pcm[index]) / 32_768.0 * gain;
                slot[1] += f32::from(voice.pcm[index + 1]) / 32_768.0 * gain;
                voice.frame += 1;
                voice.rendered += 1;
            }
            if voice.stop == Some(0) || (!voice.looping && voice.frame >= frames) {
                voice.finished = true;
            }
        }
        if self.voices.iter().any(|voice| voice.finished) {
            for voice in self.voices.iter().filter(|voice| voice.finished) {
                self.reports.push(voice.report());
            }
            self.voices.retain(|voice| !voice.finished);
        }
    }

    #[cfg(test)]
    fn voice(&self, key: u64) -> Option<&MixVoice> {
        self.voices.iter().find(|voice| voice.key == key)
    }
}

/// Where a voice starts in its sound when the monitor first hears it:
/// from the top within [`MONITOR_LATE_JOIN_MS`] of its press, else where the
/// bus is. `None` for a one-shot already over (or an empty sound).
pub(crate) fn late_join_offset(
    started_at_ms: u64,
    now_ms: u64,
    frames: usize,
    looping: bool,
) -> Option<usize> {
    if frames == 0 {
        return None;
    }
    let age_ms = now_ms.saturating_sub(started_at_ms);
    if age_ms <= MONITOR_LATE_JOIN_MS {
        return Some(0);
    }
    let offset = usize::try_from(age_ms.saturating_mul(u64::from(MONITOR_SAMPLE_RATE)) / 1000)
        .unwrap_or(usize::MAX);
    if looping {
        Some(offset % frames)
    } else {
        (offset < frames).then_some(offset)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonitorMode {
    /// Windows and Linux: the renderer plays previews (S1.3b fence).
    Inert,
    /// Tests: the mix is kept and driven by hand; no device ever opens.
    Detached,
    /// macOS: the default output device.
    Device,
}

#[derive(Default)]
struct MonitorControl {
    /// What the mix was last told to play: key → gain.
    playing: HashMap<u64, f32>,
    /// The output thread's wake-up, spawned on the first voice.
    wake: Option<mpsc::Sender<()>>,
}

/// Owned by the player (`SoundPlayer`); shared through `AppState`.
pub(crate) struct SoundMonitor {
    mode: MonitorMode,
    mix: Arc<StdMutex<MonitorMix>>,
    control: StdMutex<MonitorControl>,
}

impl Default for SoundMonitor {
    fn default() -> Self {
        let mode = if cfg!(test) {
            MonitorMode::Detached
        } else if cfg!(target_os = "macos") {
            MonitorMode::Device
        } else {
            MonitorMode::Inert
        };
        Self {
            mode,
            mix: Arc::default(),
            control: StdMutex::default(),
        }
    }
}

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SoundMonitor {
    /// Plays exactly `wanted`: a new voice starts (at its offset), one no
    /// longer wanted fades out, and a playing one glides to its new gain.
    pub(crate) fn sync(&self, wanted: &[MonitorVoice]) {
        if self.mode == MonitorMode::Inert {
            return;
        }
        let mut control = lock(&self.control);
        let mut started = false;
        {
            let mut mix = lock(&self.mix);
            for key in control.playing.keys() {
                if !wanted.iter().any(|voice| voice.key == *key) {
                    mix.stop(*key);
                }
            }
            for voice in wanted {
                match control.playing.get(&voice.key) {
                    Some(gain) => {
                        if (gain - voice.gain).abs() > f32::EPSILON {
                            mix.set_gain(voice.key, voice.gain);
                        }
                    }
                    None => started |= mix.start(voice),
                }
            }
        }
        control.playing = wanted.iter().map(|voice| (voice.key, voice.gain)).collect();
        if started {
            self.wake(&mut control);
        }
    }

    /// Plays a short cue once (plan 260 S1.3c, the join chime) beside the
    /// player's voices, under a key the player never uses, so `sync` leaves
    /// it to play out. Whether the monitor has an output to play it on.
    pub(crate) fn play_cue(&self, key: u64, pcm: Arc<[i16]>) -> bool {
        if self.mode == MonitorMode::Inert {
            return false;
        }
        let mut control = lock(&self.control);
        let started = lock(&self.mix).start(&MonitorVoice {
            key,
            pcm,
            gain: 1.0,
            looping: false,
            offset_frames: 0,
        });
        if started {
            self.wake(&mut control);
        }
        started
    }

    /// A one-shot's end timer fired: the monitor lets it play out instead of
    /// fading it (it started a little after the press, so it ends a little
    /// after the timer).
    pub(crate) fn release(&self, key: u64) {
        lock(&self.control).playing.remove(&key);
    }

    fn wake(&self, control: &mut MonitorControl) {
        if self.mode != MonitorMode::Device {
            return;
        }
        if let Some(wake) = control.wake.as_ref()
            && wake.send(()).is_ok()
        {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        let mix = self.mix.clone();
        match std::thread::Builder::new()
            .name("videorc-sound-monitor".into())
            .spawn(move || output_loop(&mix, &receiver))
        {
            Ok(_) => {
                let _ = sender.send(());
                control.wake = Some(sender);
            }
            Err(error) => {
                lock(&self.mix).clear();
                tracing::warn!(
                    "Sound monitor could not start its output thread ({error}); sound previews stay silent on this computer. Recordings and streams are not affected."
                );
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn render_for_test(&self, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames * 2];
        lock(&self.mix).render(&mut out);
        out
    }

    /// Each voice in the mix: key, target gain, next frame, fading out.
    #[cfg(test)]
    pub(crate) fn voices_for_test(&self) -> Vec<(u64, f32, usize, bool)> {
        lock(&self.mix)
            .voices
            .iter()
            .map(|voice| (voice.key, voice.target, voice.frame, voice.stop.is_some()))
            .collect()
    }
}

/// While the output is open: how often ended voices are logged and idleness
/// is checked.
const OUTPUT_TICK: Duration = Duration::from_millis(250);

/// The output thread: opens the default output when a voice arrives, closes
/// it after [`MONITOR_IDLE_CLOSE`] of silence, logs every voice that left.
fn output_loop(mix: &Arc<StdMutex<MonitorMix>>, wake: &mpsc::Receiver<()>) {
    let mut output: Option<DeviceOutput> = None;
    let mut idle_for = Duration::ZERO;
    let mut failing = false;
    loop {
        let woke = if output.is_some() {
            match wake.recv_timeout(OUTPUT_TICK) {
                Ok(()) => true,
                Err(mpsc::RecvTimeoutError::Timeout) => false,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else if wake.recv().is_ok() {
            true
        } else {
            break;
        };
        while wake.try_recv().is_ok() {}
        log_reports(mix);
        if lock(mix).is_idle() {
            if output.is_some() && !woke {
                idle_for += OUTPUT_TICK;
                if idle_for >= MONITOR_IDLE_CLOSE {
                    // Dropping the unit stops its callback; never under the
                    // mix lock, which the callback takes.
                    output = None;
                    idle_for = Duration::ZERO;
                    log_reports(mix);
                    tracing::debug!("Sound monitor closed the output after 5 s of silence.");
                }
            }
            continue;
        }
        idle_for = Duration::ZERO;
        if output.is_none() {
            match DeviceOutput::open(mix.clone()) {
                Ok(opened) => {
                    tracing::info!("Sound monitor plays to {}.", opened.device_name);
                    output = Some(opened);
                    failing = false;
                }
                Err(error) => {
                    lock(mix).clear();
                    if !failing {
                        tracing::warn!(
                            "Sound monitor could not open the default output ({error:#}); sound previews stay silent on this computer. Recordings and streams are not affected."
                        );
                    }
                    failing = true;
                }
            }
        }
    }
}

fn log_reports(mix: &StdMutex<MonitorMix>) {
    let reports = lock(mix).take_reports();
    for report in reports {
        tracing::info!(
            "Sound monitor played voice v-{} for {} of {} frames from frame {}{}.",
            report.key,
            report.rendered,
            report.frames,
            report.offset,
            if report.stopped {
                ", then faded out"
            } else {
                ""
            }
        );
    }
}

/// The default output device, playing a 48 kHz interleaved stereo render.
/// Shared with the backend room's guest playout (plan 260 S1.8d d3).
pub(crate) struct DeviceOutput {
    #[cfg(target_os = "macos")]
    _unit: coreaudio::audio_unit::AudioUnit,
    pub(crate) device_name: String,
}

impl DeviceOutput {
    #[cfg(target_os = "macos")]
    fn open(mix: Arc<StdMutex<MonitorMix>>) -> anyhow::Result<Self> {
        Self::open_with(move |buffer| lock(&mix).render(buffer))
    }

    /// Opens the default output and plays `render`'s 48 kHz interleaved
    /// stereo, called on CoreAudio's thread for each buffer. A panic in it
    /// plays silence; it never unwinds into CoreAudio.
    #[cfg(target_os = "macos")]
    pub(crate) fn open_with(
        mut render: impl FnMut(&mut [f32]) + Send + 'static,
    ) -> anyhow::Result<Self> {
        use anyhow::Context;
        use coreaudio::audio_unit::audio_format::LinearPcmFlags;
        use coreaudio::audio_unit::macos_helpers::{get_default_device_id, get_device_name};
        use coreaudio::audio_unit::render_callback::{self, data};
        use coreaudio::audio_unit::{
            AudioUnit, Element, IOType, SampleFormat, Scope, StreamFormat,
        };

        let device_name = get_default_device_id(false)
            .and_then(|device| get_device_name(device).ok())
            .unwrap_or_else(|| "the default output".to_string());
        // DefaultOutput follows the system's default device and converts the
        // 48 kHz client format to whatever the device runs at.
        let mut unit = AudioUnit::new_uninitialized(IOType::DefaultOutput)
            .context("the default output unit is unavailable")?;
        unit.set_stream_format(
            StreamFormat {
                sample_rate: f64::from(MONITOR_SAMPLE_RATE),
                sample_format: SampleFormat::F32,
                flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
                channels: 2,
            },
            Scope::Input,
            Element::Output,
        )
        .context("the 48 kHz stereo format was refused")?;
        type Args = render_callback::Args<data::Interleaved<f32>>;
        unit.set_render_callback(move |args: Args| {
            render_callback_into(&mut render, args.data.buffer, args.data.channels);
            Ok(())
        })
        .context("the render callback was refused")?;
        unit.initialize()
            .context("the output unit did not initialize")?;
        unit.start().context("the output unit did not start")?;
        Ok(Self {
            _unit: unit,
            device_name,
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn open(_mix: Arc<StdMutex<MonitorMix>>) -> anyhow::Result<Self> {
        anyhow::bail!("this platform's renderer plays sound previews")
    }
}

/// The real-time side: render (the monitor's under its mix lock), and never
/// unwind into CoreAudio (a panic plays silence instead).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn render_callback_into(render: &mut impl FnMut(&mut [f32]), buffer: &mut [f32], channels: usize) {
    if channels != 2 {
        buffer.fill(0.0);
        return;
    }
    let rendered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        render(buffer);
    }));
    if rendered.is_err() {
        buffer.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK: usize = 512;

    /// A stereo sound whose left sample is `value` and right is `-value`.
    fn flat(frames: usize, value: i16) -> Arc<[i16]> {
        (0..frames).flat_map(|_| [value, -value]).collect()
    }

    /// A stereo ramp whose left sample is `frame + 1`.
    fn ramp(frames: usize) -> Arc<[i16]> {
        (0..frames)
            .flat_map(|frame| [(frame + 1) as i16, -((frame + 1) as i16)])
            .collect()
    }

    fn voice(key: u64, pcm: Arc<[i16]>) -> MonitorVoice {
        MonitorVoice {
            key,
            pcm,
            gain: 1.0,
            looping: false,
            offset_frames: 0,
        }
    }

    fn render(mix: &mut MonitorMix, frames: usize) -> Vec<f32> {
        let mut out = vec![1.0; frames * 2];
        mix.render(&mut out);
        out
    }

    fn left(samples: &[f32], frame: usize) -> f32 {
        samples[frame * 2]
    }

    fn expected(value: i32) -> f32 {
        value as f32 / 32_768.0
    }

    #[test]
    fn an_idle_mix_renders_silence_over_whatever_the_buffer_held() {
        let mut mix = MonitorMix::default();
        assert!(mix.is_idle());
        assert!(render(&mut mix, CHUNK).iter().all(|sample| *sample == 0.0));
        assert!(mix.take_reports().is_empty());
    }

    #[test]
    fn a_voice_plays_from_the_top_to_its_end_and_reports_once() {
        let mut mix = MonitorMix::default();
        assert!(mix.start(&voice(3, ramp(700))));
        let first = render(&mut mix, CHUNK);
        assert_eq!(left(&first, 0), expected(1));
        assert_eq!(first[1], -expected(1));
        assert_eq!(left(&first, 511), expected(512));
        let second = render(&mut mix, CHUNK);
        assert_eq!(left(&second, 187), expected(700));
        assert!(second[188 * 2..].iter().all(|sample| *sample == 0.0));
        assert!(mix.is_idle());
        assert_eq!(
            mix.take_reports(),
            vec![VoiceReport {
                key: 3,
                rendered: 700,
                frames: 700,
                offset: 0,
                stopped: false,
            }]
        );
        assert!(mix.take_reports().is_empty());
    }

    #[test]
    fn a_late_join_starts_where_the_bus_is_and_a_loop_wraps() {
        let mut mix = MonitorMix::default();
        assert!(mix.start(&MonitorVoice {
            offset_frames: 100,
            ..voice(1, ramp(300))
        }));
        let chunk = render(&mut mix, 250);
        assert_eq!(left(&chunk, 0), expected(101));
        assert_eq!(left(&chunk, 199), expected(300));
        assert_eq!(left(&chunk, 200), 0.0);
        assert_eq!(mix.take_reports()[0].offset, 100);

        // A loop's offset wraps; it never ends on its own.
        assert!(mix.start(&MonitorVoice {
            looping: true,
            offset_frames: 650,
            ..voice(2, ramp(300))
        }));
        let looped = render(&mut mix, 400);
        assert_eq!(left(&looped, 0), expected(51));
        assert_eq!(left(&looped, 249), expected(300));
        assert_eq!(left(&looped, 250), expected(1));
        assert!(!mix.is_idle());

        // A one-shot already over never starts.
        assert!(!mix.start(&MonitorVoice {
            offset_frames: 300,
            ..voice(4, ramp(300))
        }));
        assert!(!mix.start(&voice(5, Arc::from(Vec::new()))));
    }

    #[test]
    fn a_stop_fades_out_over_exactly_240_frames_and_reports_it() {
        let mut mix = MonitorMix::default();
        mix.start(&voice(7, flat(5_000, 16_384)));
        assert!(
            render(&mut mix, CHUNK)
                .chunks_exact(2)
                .all(|frame| frame[0] == 0.5)
        );
        mix.stop(7);
        mix.stop(8);
        let faded = render(&mut mix, CHUNK);
        assert!((left(&faded, 0) - 0.5 * 239.0 / 240.0).abs() < 1.0e-6);
        assert!((left(&faded, 120) - 0.5 * 119.0 / 240.0).abs() < 1.0e-6);
        assert_eq!(left(&faded, 239), 0.0);
        assert!(faded[240 * 2..].iter().all(|sample| *sample == 0.0));
        assert!(mix.is_idle());
        let report = mix.take_reports()[0];
        assert!(report.stopped);
        assert_eq!(report.rendered, 512 + 240);
    }

    #[test]
    fn a_gain_change_glides_over_ten_ms_and_voices_sum() {
        let mut mix = MonitorMix::default();
        mix.start(&MonitorVoice {
            gain: 0.5,
            ..voice(1, flat(10_000, 16_384))
        });
        mix.start(&MonitorVoice {
            gain: 0.5,
            ..voice(2, flat(10_000, 16_384))
        });
        // 0.5 × 0.5, twice.
        assert!(
            render(&mut mix, CHUNK)
                .chunks_exact(2)
                .all(|frame| frame[0] == 0.5 && frame[1] == -0.5)
        );
        mix.set_gain(1, 1.0);
        let glide = render(&mut mix, CHUNK);
        assert!(left(&glide, 0) > 0.5 && left(&glide, 0) < 0.51);
        assert!(left(&glide, 200) < left(&glide, 400));
        // Reached exactly on its 480th frame, steady after.
        assert_eq!(left(&glide, 479), 0.75);
        assert_eq!(left(&glide, 511), 0.75);
        // The same gain again changes nothing.
        mix.set_gain(1, 1.0);
        assert_eq!(mix.voice(1).unwrap().glide, 0);
    }

    #[test]
    fn a_trailing_odd_sample_and_a_cleared_mix_stay_silent() {
        let mut mix = MonitorMix::default();
        mix.start(&voice(1, flat(100, 16_384)));
        let mut out = vec![1.0; 5];
        mix.render(&mut out);
        assert_eq!(out, vec![0.5, -0.5, 0.5, -0.5, 0.0]);
        mix.clear();
        assert!(mix.is_idle());
    }

    #[test]
    fn the_late_join_rule_matches_the_renderer_monitor() {
        // Within 300 ms of the press: from the top.
        assert_eq!(late_join_offset(1_000, 1_300, 48_000, false), Some(0));
        // Later: where the bus is.
        assert_eq!(late_join_offset(1_000, 1_500, 48_000, false), Some(24_000));
        // A one-shot already over is not played; a loop wraps.
        assert_eq!(late_join_offset(1_000, 2_000, 48_000, false), None);
        assert_eq!(late_join_offset(1_000, 2_500, 48_000, true), Some(24_000));
        // A clock that went back is a fresh press.
        assert_eq!(late_join_offset(5_000, 1_000, 48_000, false), Some(0));
        assert_eq!(late_join_offset(1_000, 1_000, 0, true), None);
    }

    #[test]
    fn sync_starts_fades_and_glides_and_a_released_voice_plays_out() {
        let monitor = SoundMonitor::default();
        let pcm = flat(48_000, 16_384);
        let wanted = |key: u64, gain: f32| MonitorVoice {
            gain,
            ..voice(key, pcm.clone())
        };
        monitor.sync(&[wanted(1, 1.0), wanted(2, 0.5)]);
        assert_eq!(
            monitor.voices_for_test(),
            vec![(1, 1.0, 0, false), (2, 0.5, 0, false)]
        );
        monitor.render_for_test(CHUNK);
        // Voice 1 no longer wanted: it fades; voice 2 glides; voice 3 starts
        // at its offset.
        monitor.sync(&[
            wanted(2, 0.25),
            MonitorVoice {
                offset_frames: 9_000,
                ..wanted(3, 1.0)
            },
        ]);
        assert_eq!(
            monitor.voices_for_test(),
            vec![
                (1, 1.0, 512, true),
                (2, 0.25, 512, false),
                (3, 1.0, 9_000, false)
            ]
        );
        // The same plan twice changes nothing.
        monitor.sync(&[wanted(2, 0.25), wanted(3, 1.0)]);
        assert_eq!(monitor.voices_for_test().len(), 3);
        monitor.render_for_test(CHUNK);
        assert_eq!(monitor.voices_for_test().len(), 2, "voice 1 faded out");
        // A released voice is no longer the monitor's to stop: a plan
        // without it leaves it playing.
        monitor.release(3);
        monitor.sync(&[wanted(2, 0.25)]);
        assert_eq!(
            monitor
                .voices_for_test()
                .iter()
                .map(|(key, _, _, stopping)| (*key, *stopping))
                .collect::<Vec<_>>(),
            vec![(2, false), (3, false)]
        );
        monitor.sync(&[]);
        monitor.render_for_test(CHUNK);
        assert_eq!(
            monitor
                .voices_for_test()
                .iter()
                .map(|(key, ..)| *key)
                .collect::<Vec<_>>(),
            vec![3]
        );
    }

    #[test]
    fn an_inert_monitor_plays_nothing() {
        let monitor = SoundMonitor {
            mode: MonitorMode::Inert,
            ..SoundMonitor::default()
        };
        monitor.sync(&[voice(1, flat(100, 1))]);
        assert!(monitor.voices_for_test().is_empty());
    }

    #[test]
    fn the_callback_plays_silence_for_a_layout_it_does_not_render() {
        let mix = StdMutex::new(MonitorMix::default());
        lock(&mix).start(&voice(1, flat(100, 16_384)));
        let mut render = |buffer: &mut [f32]| lock(&mix).render(buffer);
        let mut mono = vec![1.0; 64];
        render_callback_into(&mut render, &mut mono, 1);
        assert!(mono.iter().all(|sample| *sample == 0.0));
        let mut stereo = vec![0.0; 64];
        render_callback_into(&mut render, &mut stereo, 2);
        assert_eq!(stereo[0], 0.5);
    }
}
