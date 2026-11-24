//! Plan 258 S3: the camera effect stage (D2, D6).
//!
//! The stage sits at the camera publish point (`copy_sample_buffer` on macOS,
//! `publish_bgra_frame` for the pipe cameras and the fixture camera), between
//! capture and the camera's `FrameStore`. While the camera's background is a
//! blur or a picture, every consumer of the store (each compositor and leg,
//! Clips, the Camera ISO file, Videorc Camera, the Preview, agent looks and
//! the debug routes) reads only processed frames or the cover: a raw frame
//! never enters the store while an effect is on.
//!
//! - **Arming swaps the stored frame.** Turning an effect on replaces the
//!   frame already in the depth-1 store with the cover under the store's own
//!   lock, before the call returns (D2).
//! - **Each frame gets its own matte.** The capture hands every frame to the
//!   segment worker (latest wins); the worker segments it, draws it with its
//!   own matte and publishes it. A stale matte trails a moving hand (S0).
//! - **Fail closed.** At every capture the stage asks the one-choice rule
//!   ([`camera_background_treatment`]) with the newest matte's age: past
//!   [`MAX_MASK_AGE`], before the first matte, with no engine, or after a
//!   failure, the capture itself publishes the cover (D6). Off is the only
//!   way raw frames return.
//!
//! The segmenter and renderer are traits so the privacy invariants are pinned
//! with fakes; macOS plugs in Vision and Metal (`camera_effect_metal`).
//! Until the engine has started (and on platforms without one) the cover is
//! drawn on the CPU on the camera's own thread, never the render thread.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use super::{PreviewCameraPixelFormat, PreviewCameraShared};
#[cfg(test)]
use crate::camera_background::MAX_MASK_AGE;
use crate::camera_background::{
    CameraBackgroundTreatment, StageState, SystemEffect, camera_background_treatment,
};
use crate::frame_store::{RetainedPixelBuffer, StoredFrame};
use crate::protocol::{
    CameraBackground, CameraBackgroundMode, CameraBackgroundStageState, CameraBackgroundStatus,
};

/// Strong blur's Gaussian sigma at 1080p, in pixels. S2's leak detector
/// stops reading the fixture room once the sigma is about two of its cells
/// (40 px at 1080p; measured in S3: 1 cell leaves 8 pattern tiles a frame,
/// 1.5 cells 2, 2 cells none). 48 px (2.4 cells) keeps a margin for H.264.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the macOS engine draws it
pub(crate) const STRONG_BLUR_SIGMA_AT_1080: f32 = 48.0;
/// D5: Strong blur's strength.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the macOS engine draws it
pub(crate) const STRONG_BLUR_PCT: f32 = 70.0;
/// D6: the blur cover is Strong blur plus 50 % more.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the macOS engine draws it
pub(crate) const COVER_BLUR_FACTOR: f32 = 1.5;
/// S0: EMA 0.5 on the matte cut flicker 2.5–4x.
const MATTE_EMA_WEIGHT_PREVIOUS: u16 = 128;
/// A matte value below this is background with confidence: the EMA never
/// lifts it, so a hand that just moved away never leaves a half-raw trail
/// over the room behind it.
const MATTE_EMA_BACKGROUND_FLOOR: u8 = 26;
/// The neutral ground a picture's cover shows before its picture has loaded
/// (and a later slice's pick shows until it can draw): the video ground.
pub(crate) const NEUTRAL_GROUND_BGRA: [u8; 4] = [0x1f, 0x1c, 0x1a, 0xff];
/// Timing windows for the status percentiles.
const TIMING_WINDOW: usize = 120;

/// What to draw behind the person: the camera's background as the stage
/// reads it. Built only for a pick that is an effect; Off and the green or
/// blue screen key are no look at all (raw frames, the compositor keys).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EffectLook {
    pub mode: CameraBackgroundMode,
    pub kind: EffectKind,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum EffectKind {
    /// Blur strength in percent (Slight 30, Strong 70).
    Blur { pct: u32 },
    /// A picture behind the person. `path` is the managed file the asset
    /// resolved to (absent: the cover shows the neutral ground). `mirror`
    /// pre-mirrors it, so the camera's own mirror leaves it the right way.
    Image {
        asset_id: String,
        path: Option<PathBuf>,
        mirror: bool,
    },
    /// A pick this build cannot draw yet (video is S6, Cut out S7): the
    /// stage holds the cover, never raw.
    Pending,
}

impl EffectLook {
    /// `None` for Off and for the green or blue screen (no stage work).
    pub(crate) fn from_setting(
        setting: Option<&CameraBackground>,
        image_path: Option<PathBuf>,
        mirror: bool,
    ) -> Option<Self> {
        let setting = setting?;
        let kind = match setting.mode {
            CameraBackgroundMode::Off
            | CameraBackgroundMode::Green
            | CameraBackgroundMode::Blue => {
                return None;
            }
            CameraBackgroundMode::Blur => EffectKind::Blur {
                pct: setting.blur_pct.min(100),
            },
            CameraBackgroundMode::Image => EffectKind::Image {
                asset_id: setting.asset_id.clone().unwrap_or_default(),
                path: image_path,
                mirror,
            },
            CameraBackgroundMode::Video | CameraBackgroundMode::Cutout => EffectKind::Pending,
        };
        Some(Self {
            mode: setting.mode,
            kind,
        })
    }
}

/// The blur's Gaussian sigma in pixels for a frame `height` tall at `pct`
/// strength: Strong blur is [`STRONG_BLUR_SIGMA_AT_1080`] at 1080p and it
/// scales with both. Never under 2 px for a blur that is on.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the macOS engine draws it
pub(crate) fn blur_sigma_px(pct: u32, height: u32) -> f32 {
    let scale = height.max(1) as f32 / 1080.0;
    (STRONG_BLUR_SIGMA_AT_1080 * (pct as f32 / STRONG_BLUR_PCT) * scale).max(2.0)
}

/// D6: the blur cover's sigma, Strong blur plus 50 %, whatever the strength.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the macOS engine draws it
pub(crate) fn cover_blur_sigma_px(height: u32) -> f32 {
    blur_sigma_px(STRONG_BLUR_PCT as u32, height) * COVER_BLUR_FACTOR
}

/// A camera frame handed to the stage, always BGRA.
pub(crate) enum EffectPixels {
    /// Tightly packed BGRA (`width * height * 4`).
    Bytes(Vec<u8>),
    /// The camera's own buffer (macOS, zero-copy).
    #[cfg(target_os = "macos")]
    PixelBuffer(RetainedPixelBuffer),
}

pub(crate) struct EffectFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: EffectPixels,
}

impl EffectFrame {
    /// Tight BGRA bytes for the CPU cover, read from the pixel buffer when
    /// that is all the frame has.
    fn bgra_bytes(&self) -> Option<std::borrow::Cow<'_, [u8]>> {
        let expected = self.width as usize * self.height as usize * 4;
        match &self.pixels {
            EffectPixels::Bytes(bytes) => {
                (bytes.len() == expected).then_some(std::borrow::Cow::Borrowed(bytes.as_slice()))
            }
            #[cfg(target_os = "macos")]
            EffectPixels::PixelBuffer(buffer) => {
                crate::camera_effect_metal::read_bgra(buffer.pixel_buffer())
                    .filter(|bytes| bytes.len() == expected)
                    .map(std::borrow::Cow::Owned)
            }
        }
    }
}

/// One frame's person matte: 8-bit coverage, row-major, `width * height`,
/// stretched over the whole frame (Vision's is 4:3 whatever the frame, S0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Matte {
    pub width: u32,
    pub height: u32,
    pub values: Vec<u8>,
}

impl Matte {
    fn is_valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.values.len() == self.width as usize * self.height as usize
    }
}

/// S0's EMA 0.5 with a background floor: where the new matte is confident
/// background the previous one never lifts it (no trail of the room behind a
/// moving hand); elsewhere the two average, which steadies the edge.
pub(crate) fn smooth_matte(previous: Option<&Matte>, current: Matte) -> Matte {
    let Some(previous) = previous.filter(|previous| {
        previous.width == current.width
            && previous.height == current.height
            && previous.values.len() == current.values.len()
    }) else {
        return current;
    };
    let values = current
        .values
        .iter()
        .zip(&previous.values)
        .map(|(&now, &before)| {
            if now < MATTE_EMA_BACKGROUND_FLOOR {
                now
            } else {
                let mixed = u16::from(now) * (256 - MATTE_EMA_WEIGHT_PREVIOUS)
                    + u16::from(before) * MATTE_EMA_WEIGHT_PREVIOUS;
                (mixed >> 8) as u8
            }
        })
        .collect();
    Matte { values, ..current }
}

/// What the stage publishes: BGRA bytes, a pooled IOSurface buffer, or both.
pub(crate) struct EffectOutput {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub pixel_buffer: Option<RetainedPixelBuffer>,
    /// GPU time of the pass, when the renderer measured it.
    pub gpu_ms: Option<f64>,
}

/// Finds the person in a frame.
pub(crate) trait PersonSegmenter: Send {
    fn segment(&mut self, frame: &EffectFrame) -> Result<Matte, String>;
}

/// Draws the effect, or the cover (D6), for one frame.
pub(crate) trait EffectRenderer: Send {
    fn processed(
        &mut self,
        frame: &EffectFrame,
        matte: &Matte,
        look: &EffectLook,
    ) -> Result<EffectOutput, String>;
    fn cover(&mut self, frame: &EffectFrame, look: &EffectLook) -> Result<EffectOutput, String>;
}

/// What an engine factory builds on the worker thread. A segmenter error is
/// the reason the stage is unavailable here (it then covers every frame).
pub(crate) struct EngineParts {
    pub segmenter: Result<Box<dyn PersonSegmenter>, String>,
    pub renderer: Option<Box<dyn EffectRenderer>>,
}

pub(crate) type EngineFactory = Arc<dyn Fn() -> EngineParts + Send + Sync>;

fn platform_engine_factory() -> EngineFactory {
    #[cfg(target_os = "macos")]
    {
        Arc::new(crate::camera_effect_metal::engine_parts)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(|| EngineParts {
            segmenter: Err(
                "Background effects come to this platform in a later update (plan 258 S10/S11)."
                    .to_string(),
            ),
            renderer: None,
        })
    }
}

/// Plan 258 S3: `VIDEORC_DEBUG_SEGMENTATION_STALL=1` (debug builds only)
/// holds the segment worker from the start, and `camera.background.debugStall`
/// turns the stall on and off for `pnpm smoke:camera-background`.
static DEBUG_SEGMENTATION_STALL: AtomicBool = AtomicBool::new(false);
static DEBUG_STALL_ENV_READ: std::sync::Once = std::sync::Once::new();

pub(crate) const DEBUG_SEGMENTATION_STALL_ENV: &str = "VIDEORC_DEBUG_SEGMENTATION_STALL";

fn debug_segmentation_stalled() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    DEBUG_STALL_ENV_READ.call_once(|| {
        if std::env::var(DEBUG_SEGMENTATION_STALL_ENV).is_ok_and(|value| value.trim() == "1") {
            DEBUG_SEGMENTATION_STALL.store(true, Ordering::SeqCst);
        }
    });
    DEBUG_SEGMENTATION_STALL.load(Ordering::SeqCst)
}

/// Turn the debug stall on or off. Refused in packaged (release) builds.
pub(crate) fn set_debug_segmentation_stall(stalled: bool) -> Result<(), &'static str> {
    if !cfg!(debug_assertions) {
        return Err("The segmentation stall is refused in packaged builds.");
    }
    let _ = debug_segmentation_stalled();
    DEBUG_SEGMENTATION_STALL.store(stalled, Ordering::SeqCst);
    Ok(())
}

struct Job {
    frame: Arc<EffectFrame>,
    look: EffectLook,
    generation: u64,
    sequence: u64,
    captured_at: Instant,
}

/// The worker's half: a latest-wins mailbox, the stop flag and the renderer
/// the capture thread borrows for covers.
struct Engine {
    stop: AtomicBool,
    mailbox: StdMutex<Option<Job>>,
    wake: Condvar,
    renderer: StdMutex<Option<Box<dyn EffectRenderer>>>,
}

impl Engine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stop: AtomicBool::new(false),
            mailbox: StdMutex::new(None),
            wake: Condvar::new(),
            renderer: StdMutex::new(None),
        })
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn shut_down(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake.notify_all();
    }

    /// Replace whatever is waiting: the worker always takes the newest frame.
    fn offer(&self, job: Job) {
        *self
            .mailbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(job);
        self.wake.notify_one();
    }

    /// The next job, or `None` once stopped.
    fn wait_job(&self) -> Option<Job> {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if self.stopped() {
                return None;
            }
            if let Some(job) = mailbox.take() {
                return Some(job);
            }
            mailbox = self
                .wake
                .wait_timeout(mailbox, Duration::from_millis(250))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    #[cfg(test)]
    fn take_job(&self) -> Option<Job> {
        self.mailbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

#[derive(Debug, Default)]
struct TimingRing(Vec<f64>);

impl TimingRing {
    fn push(&mut self, value: f64) {
        if self.0.len() >= TIMING_WINDOW {
            self.0.remove(0);
        }
        self.0.push(value);
    }

    fn p95(&self) -> Option<f64> {
        if self.0.is_empty() {
            return None;
        }
        let mut sorted = self.0.clone();
        sorted.sort_by(f64::total_cmp);
        let index = ((sorted.len() as f64 * 0.95).ceil() as usize).clamp(1, sorted.len()) - 1;
        Some((sorted[index] * 100.0).round() / 100.0)
    }
}

/// The stage's state, one per camera session (kept in `PreviewCameraShared`,
/// so the store's lock is the stage's lock).
pub(crate) struct CameraEffectStage {
    setting: Option<CameraBackground>,
    look: Option<EffectLook>,
    /// Bumps on every arm, disarm and engine change: a frame drawn for an
    /// older generation is dropped, never published.
    generation: u64,
    engine: Option<Arc<Engine>>,
    factory: EngineFactory,
    /// Tests drive the worker by hand.
    spawn_worker: bool,
    last_processed_capture: Option<Instant>,
    last_published_sequence: u64,
    cover_since: Option<Instant>,
    covering: bool,
    last_mask_age: Option<Duration>,
    processed_frames: u64,
    cover_frames: u64,
    dropped_late: u64,
    segment_ms: TimingRing,
    compose_ms: TimingRing,
    compose_gpu_ms: TimingRing,
    /// The newest matte's age when the cover last took over from processed
    /// frames: D6 says the first capture past 100 ms.
    cover_after_mask_age: Option<Duration>,
    unavailable: Option<String>,
    last_error: Option<String>,
}

impl std::fmt::Debug for CameraEffectStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CameraEffectStage")
            .field("look", &self.look)
            .field("generation", &self.generation)
            .field("engine", &self.engine.is_some())
            .field("processed_frames", &self.processed_frames)
            .field("cover_frames", &self.cover_frames)
            .finish_non_exhaustive()
    }
}

impl Default for CameraEffectStage {
    fn default() -> Self {
        Self::with_factory(platform_engine_factory(), true)
    }
}

impl Drop for CameraEffectStage {
    fn drop(&mut self) {
        if let Some(engine) = self.engine.take() {
            engine.shut_down();
        }
    }
}

impl CameraEffectStage {
    fn with_factory(factory: EngineFactory, spawn_worker: bool) -> Self {
        Self {
            setting: None,
            look: None,
            generation: 0,
            engine: None,
            factory,
            spawn_worker,
            last_processed_capture: None,
            last_published_sequence: 0,
            cover_since: None,
            covering: false,
            last_mask_age: None,
            processed_frames: 0,
            cover_frames: 0,
            dropped_late: 0,
            segment_ms: TimingRing::default(),
            compose_ms: TimingRing::default(),
            compose_gpu_ms: TimingRing::default(),
            cover_after_mask_age: None,
            unavailable: None,
            last_error: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_tests(factory: EngineFactory) -> Self {
        Self::with_factory(factory, false)
    }

    /// An effect is on: no raw frame may be published.
    pub(crate) fn is_armed(&self) -> bool {
        self.look.is_some()
    }

    /// Plan 258 S5: whether a frame read off the store's lock may be raw,
    /// and the arming epoch it was read in. A reader that copied a frame
    /// while the stage was off checks the epoch again after the copy: if the
    /// stage armed meanwhile, the copy may be the raw frame arming replaced,
    /// and it must not be served.
    pub(crate) fn raw_read_epoch(&self) -> Option<u64> {
        (!self.is_armed()).then_some(self.generation)
    }

    fn stage_state(&self, captured_at: Instant) -> StageState {
        if self.unavailable.is_some() {
            return StageState::Unavailable;
        }
        if self.engine.as_ref().is_none_or(|engine| engine.stopped()) {
            return StageState::Failed;
        }
        match self.last_processed_capture {
            None => StageState::Starting,
            Some(at) => StageState::Running {
                mask_age: captured_at.saturating_duration_since(at),
            },
        }
    }

    fn disarm(&mut self) {
        self.setting = None;
        self.look = None;
        self.generation = self.generation.wrapping_add(1);
        if let Some(engine) = self.engine.take() {
            engine.shut_down();
        }
        self.last_processed_capture = None;
        self.cover_since = None;
        self.covering = false;
        self.last_mask_age = None;
        self.unavailable = None;
    }

    /// Arm with a fresh engine. The first matte is cold (S0: 0.7–1.4 s), so
    /// every frame until then is the cover.
    fn arm(&mut self, shared: Weak<StdMutex<PreviewCameraShared>>) {
        self.generation = self.generation.wrapping_add(1);
        self.last_processed_capture = None;
        self.unavailable = None;
        self.last_error = None;
        self.covering = false;
        self.cover_since = None;
        let engine = Engine::new();
        if self.spawn_worker {
            let factory = Arc::clone(&self.factory);
            let worker_engine = Arc::clone(&engine);
            let generation = self.generation;
            let spawned = std::thread::Builder::new()
                .name("videorc-camera-effect".to_string())
                .spawn(move || {
                    if let Some(mut worker) =
                        Worker::start(&factory, worker_engine, shared, generation)
                    {
                        worker.run();
                    }
                });
            if let Err(error) = spawned {
                self.unavailable = Some(format!("The background effect could not start: {error}"));
            }
        }
        self.engine = Some(engine);
    }

    /// The status line for `preview.camera.status` (absent while Off or a
    /// screen key).
    pub(crate) fn status(&self, now: Instant) -> Option<CameraBackgroundStatus> {
        let look = self.look.as_ref()?;
        let state = if self.unavailable.is_some() {
            CameraBackgroundStageState::Unavailable
        } else if self.covering || self.last_processed_capture.is_none() {
            CameraBackgroundStageState::Cover
        } else {
            CameraBackgroundStageState::Running
        };
        let message = self
            .unavailable
            .clone()
            .or_else(|| {
                matches!(look.kind, EffectKind::Pending).then(|| {
                    "This background comes in a later update; viewers see a plain ground."
                        .to_string()
                })
            })
            .or_else(|| self.last_error.clone());
        Some(CameraBackgroundStatus {
            mode: look.mode,
            state,
            mask_age_ms: self.last_mask_age.map(duration_ms),
            segment_ms_p95: self.segment_ms.p95(),
            compose_ms_p95: self.compose_ms.p95(),
            compose_gpu_ms_p95: self.compose_gpu_ms.p95(),
            processed_frames: self.processed_frames,
            cover_frames: self.cover_frames,
            cover_for_ms: self
                .cover_since
                .map(|since| duration_ms(now.saturating_duration_since(since))),
            cover_after_mask_age_ms: self.cover_after_mask_age.map(duration_ms),
            message,
        })
    }

    fn note_cover(&mut self, now: Instant) {
        self.cover_frames = self.cover_frames.saturating_add(1);
        if !self.covering {
            self.covering = true;
            self.cover_since = Some(now);
            if self.last_processed_capture.is_some() {
                self.cover_after_mask_age = self.last_mask_age;
            }
        }
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn lock_shared(
    shared: &Arc<StdMutex<PreviewCameraShared>>,
) -> std::sync::MutexGuard<'_, PreviewCameraShared> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Set the camera's background on its stage. Turning an effect on swaps the
/// frame already in the store for the cover before this returns (D2);
/// turning it Off lets the next capture publish raw. Same look: nothing.
pub(crate) fn apply_look(
    shared: &Arc<StdMutex<PreviewCameraShared>>,
    setting: Option<&CameraBackground>,
    look: Option<EffectLook>,
) {
    let mut guard = lock_shared(shared);
    let guard = &mut *guard;
    if guard.effect.look == look {
        guard.effect.setting = setting.cloned().filter(|_| look.is_some());
        return;
    }
    let Some(look) = look else {
        guard.effect.disarm();
        return;
    };
    let was_armed = guard.effect.is_armed();
    guard.effect.setting = setting.cloned();
    guard.effect.look = Some(look.clone());
    if was_armed {
        // A different blur or picture: the running engine draws the new look
        // from the next frame on, and the store already holds no raw frame.
        return;
    }
    guard.effect.arm(Arc::downgrade(shared));
    // D2: the frame captured before arming must not be read again.
    if let Some(latest) = guard.frame_store.latest() {
        let output = cpu_cover_for_stored(&latest, &look);
        match output {
            Some(output) => {
                let sequence = latest.sequence;
                guard.effect.note_cover(Instant::now());
                guard.effect.last_published_sequence = sequence;
                publish_output(guard, output, sequence, Instant::now());
            }
            None => {
                // No pixels to draw a cover from: no frame beats a raw one.
                guard.frame_store.retire();
            }
        }
    }
}

/// A capture the stage must answer with the cover (drawn off the lock).
pub(crate) struct PendingCover {
    frame: Arc<EffectFrame>,
    look: EffectLook,
    generation: u64,
    sequence: u64,
    captured_at: Instant,
    engine: Option<Arc<Engine>>,
}

/// An armed capture. The caller holds the store's lock and has counted the
/// frame; it must not publish anything itself. The frame goes to the
/// segment worker, and when the rule says cover the caller finishes it with
/// [`finish_cover`] after dropping the lock.
pub(crate) fn on_armed_capture(
    guard: &mut PreviewCameraShared,
    frame: EffectFrame,
    sequence: u64,
    captured_at: Instant,
) -> Option<PendingCover> {
    let system_effect = SystemEffect::from(guard.system_effect.as_ref());
    let stage = &mut guard.effect;
    let look = stage.look.clone()?;
    let frame = Arc::new(frame);
    if let Some(engine) = stage.engine.as_ref() {
        engine.offer(Job {
            frame: Arc::clone(&frame),
            look: look.clone(),
            generation: stage.generation,
            sequence,
            captured_at,
        });
    }
    let stage_state = stage.stage_state(captured_at);
    if let StageState::Running { mask_age } = stage_state {
        stage.last_mask_age = Some(mask_age);
    }
    let treatment = camera_background_treatment(stage.setting.as_ref(), system_effect, stage_state);
    match treatment {
        // The worker publishes this frame with its own matte.
        CameraBackgroundTreatment::Processed => None,
        // Armed means an effect: Raw and Key cannot come back here, and if
        // they ever did the frame still gets the cover, never raw.
        CameraBackgroundTreatment::Cover
        | CameraBackgroundTreatment::Raw
        | CameraBackgroundTreatment::Key => Some(PendingCover {
            frame,
            look,
            generation: stage.generation,
            sequence,
            captured_at,
            engine: stage.engine.clone(),
        }),
    }
}

/// Draw the cover for an armed capture (the engine's GPU pass when it is up,
/// the CPU cover until then) and publish it, unless the stage moved on.
pub(crate) fn finish_cover(shared: &Arc<StdMutex<PreviewCameraShared>>, pending: PendingCover) {
    let drawn = pending.engine.as_ref().and_then(|engine| {
        engine
            .renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .map(|renderer| renderer.cover(&pending.frame, &pending.look))
    });
    let mut error = None;
    let output = match drawn {
        Some(Ok(output)) => output,
        Some(Err(failure)) => {
            error = Some(failure);
            cpu_cover(&pending.frame, &pending.look)
        }
        None => cpu_cover(&pending.frame, &pending.look),
    };
    let mut guard = lock_shared(shared);
    let guard = &mut *guard;
    if let Some(error) = error {
        guard.effect.last_error = Some(error);
    }
    if !guard.effect.is_armed()
        || guard.effect.generation != pending.generation
        || pending.sequence <= guard.effect.last_published_sequence
    {
        return;
    }
    guard.effect.note_cover(Instant::now());
    guard.effect.last_published_sequence = pending.sequence;
    publish_output(guard, output, pending.sequence, pending.captured_at);
}

/// Publish a processed frame or a cover into the camera store, with the
/// same bytes-or-buffer policy the raw macOS capture uses.
fn publish_output(
    guard: &mut PreviewCameraShared,
    output: EffectOutput,
    sequence: u64,
    captured_at: Instant,
) {
    let EffectOutput {
        width,
        height,
        bytes,
        pixel_buffer,
        ..
    } = output;
    #[cfg(target_os = "macos")]
    let (bytes, pixel_buffer) = {
        let mut bytes = bytes;
        let skip_bytes = super::should_skip_camera_capture_cpu_copy(pixel_buffer.is_some());
        if !skip_bytes
            && bytes.is_empty()
            && let Some(buffer) = pixel_buffer.as_ref()
        {
            bytes =
                crate::camera_effect_metal::read_bgra(buffer.pixel_buffer()).unwrap_or_default();
        }
        let pixel_buffer = pixel_buffer.filter(|_| super::source_zerocopy_enabled());
        if bytes.is_empty() && pixel_buffer.is_none() {
            // Nothing a reader could draw: keep the store's last safe frame.
            return;
        }
        (bytes, pixel_buffer)
    };
    #[cfg(not(target_os = "macos"))]
    let pixel_buffer: Option<RetainedPixelBuffer> = {
        let _ = pixel_buffer;
        None
    };
    guard.frame_store.publish_with_source_handles(
        sequence,
        width,
        height,
        PreviewCameraPixelFormat::Bgra8,
        captured_at,
        bytes,
        None,
        pixel_buffer,
    );
}

/// The CPU cover: for a blur the whole frame reduced to a 16-cell-wide grid
/// and stretched back smoothly (nothing of the room or the person survives);
/// for a picture or a later slice's pick, the neutral ground. Never fails.
pub(crate) fn cpu_cover(frame: &EffectFrame, look: &EffectLook) -> EffectOutput {
    let (width, height) = (frame.width.max(1), frame.height.max(1));
    let bytes = match look.kind {
        EffectKind::Blur { .. } => frame
            .bgra_bytes()
            .map(|bytes| grid_blur(&bytes, width as usize, height as usize))
            .unwrap_or_else(|| solid(width as usize, height as usize)),
        EffectKind::Image { .. } | EffectKind::Pending => solid(width as usize, height as usize),
    };
    EffectOutput {
        width,
        height,
        bytes,
        pixel_buffer: None,
        gpu_ms: None,
    }
}

fn cpu_cover_for_stored(
    frame: &StoredFrame<PreviewCameraPixelFormat>,
    look: &EffectLook,
) -> Option<EffectOutput> {
    let (width, height) = (frame.width, frame.height);
    if width == 0 || height == 0 {
        return None;
    }
    if !matches!(look.kind, EffectKind::Blur { .. }) {
        return Some(EffectOutput {
            width,
            height,
            bytes: solid(width as usize, height as usize),
            pixel_buffer: None,
            gpu_ms: None,
        });
    }
    let pixels = if !frame.bytes.is_empty() {
        EffectPixels::Bytes(frame.bytes.clone())
    } else {
        #[cfg(target_os = "macos")]
        {
            EffectPixels::PixelBuffer(frame.source_pixel_buffer.clone()?)
        }
        #[cfg(not(target_os = "macos"))]
        {
            return None;
        }
    };
    let effect_frame = EffectFrame {
        width,
        height,
        pixels,
    };
    Some(cpu_cover(&effect_frame, look))
}

fn solid(width: usize, height: usize) -> Vec<u8> {
    NEUTRAL_GROUND_BGRA.repeat(width * height)
}

/// Average the frame into a grid 16 cells wide, then stretch it back with
/// bilinear weights.
fn grid_blur(bytes: &[u8], width: usize, height: usize) -> Vec<u8> {
    let grid_w = 16usize.min(width).max(1);
    let grid_h = ((16 * height).div_ceil(width.max(1))).clamp(1, height.max(1));
    let mut sums = vec![[0u64; 4]; grid_w * grid_h];
    for y in 0..height {
        let gy = y * grid_h / height;
        let row = &bytes[y * width * 4..(y + 1) * width * 4];
        for x in 0..width {
            let gx = x * grid_w / width;
            let cell = &mut sums[gy * grid_w + gx];
            let pixel = &row[x * 4..x * 4 + 4];
            cell[0] += u64::from(pixel[0]);
            cell[1] += u64::from(pixel[1]);
            cell[2] += u64::from(pixel[2]);
            cell[3] += 1;
        }
    }
    let grid: Vec<[f32; 3]> = sums
        .iter()
        .map(|cell| {
            let count = cell[3].max(1) as f32;
            [
                cell[0] as f32 / count,
                cell[1] as f32 / count,
                cell[2] as f32 / count,
            ]
        })
        .collect();
    let mut out = vec![0u8; width * height * 4];
    for y in 0..height {
        let fy = ((y as f32 + 0.5) * grid_h as f32 / height as f32 - 0.5).max(0.0);
        let y0 = (fy as usize).min(grid_h - 1);
        let y1 = (y0 + 1).min(grid_h - 1);
        let ty = fy - y0 as f32;
        for x in 0..width {
            let fx = ((x as f32 + 0.5) * grid_w as f32 / width as f32 - 0.5).max(0.0);
            let x0 = (fx as usize).min(grid_w - 1);
            let x1 = (x0 + 1).min(grid_w - 1);
            let tx = fx - x0 as f32;
            let at = |gx: usize, gy: usize, c: usize| grid[gy * grid_w + gx][c];
            let index = (y * width + x) * 4;
            for c in 0..3 {
                let top = at(x0, y0, c) * (1.0 - tx) + at(x1, y0, c) * tx;
                let bottom = at(x0, y1, c) * (1.0 - tx) + at(x1, y1, c) * tx;
                out[index + c] = (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8;
            }
            out[index + 3] = 0xff;
        }
    }
    out
}

/// The segment worker: Vision (or a fake) then the effect pass, one frame at
/// a time, newest first.
struct Worker {
    engine: Arc<Engine>,
    shared: Weak<StdMutex<PreviewCameraShared>>,
    generation: u64,
    segmenter: Box<dyn PersonSegmenter>,
    previous_matte: Option<Matte>,
}

impl Worker {
    /// Build the engine's parts and hand the renderer to the capture side.
    /// `None` when this host has no segmenter: the stage is then marked
    /// unavailable and covers every frame.
    fn start(
        factory: &EngineFactory,
        engine: Arc<Engine>,
        shared: Weak<StdMutex<PreviewCameraShared>>,
        generation: u64,
    ) -> Option<Self> {
        let parts = factory();
        *engine
            .renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = parts.renderer;
        match parts.segmenter {
            Ok(segmenter) => Some(Self {
                engine,
                shared,
                generation,
                segmenter,
                previous_matte: None,
            }),
            Err(reason) => {
                if let Some(shared) = shared.upgrade() {
                    let mut guard = lock_shared(&shared);
                    if guard.effect.generation == generation {
                        guard.effect.unavailable = Some(reason);
                    }
                }
                None
            }
        }
    }

    fn run(&mut self) {
        while let Some(job) = self.engine.wait_job() {
            while debug_segmentation_stalled() && !self.engine.stopped() {
                std::thread::sleep(Duration::from_millis(5));
            }
            if self.engine.stopped() || self.shared.strong_count() == 0 {
                return;
            }
            self.step(job);
        }
    }

    fn record_error(&self, error: String) {
        if let Some(shared) = self.shared.upgrade() {
            let mut guard = lock_shared(&shared);
            if guard.effect.generation == self.generation {
                guard.effect.last_error = Some(error);
            }
        }
    }

    fn step(&mut self, job: Job) {
        let segment_started = Instant::now();
        let matte = match self.segmenter.segment(&job.frame) {
            Ok(matte) if matte.is_valid() => matte,
            Ok(_) => {
                self.record_error("The person matte came back empty.".to_string());
                return;
            }
            Err(error) => {
                self.record_error(error);
                return;
            }
        };
        let segment_ms = segment_started.elapsed().as_secs_f64() * 1000.0;
        let matte = smooth_matte(self.previous_matte.as_ref(), matte);
        let compose_started = Instant::now();
        let drawn = self
            .engine
            .renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .map(|renderer| renderer.processed(&job.frame, &matte, &job.look));
        self.previous_matte = Some(matte);
        let output = match drawn {
            Some(Ok(output)) => output,
            Some(Err(error)) => {
                self.record_error(error);
                return;
            }
            None => {
                self.record_error("The background effect has no renderer.".to_string());
                return;
            }
        };
        let compose_ms = compose_started.elapsed().as_secs_f64() * 1000.0;
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let mut guard = lock_shared(&shared);
        let guard = &mut *guard;
        let stage = &mut guard.effect;
        if !stage.is_armed() || stage.generation != job.generation {
            return;
        }
        stage.segment_ms.push(segment_ms);
        stage.compose_ms.push(compose_ms);
        if let Some(gpu_ms) = output.gpu_ms {
            stage.compose_gpu_ms.push(gpu_ms);
        }
        // Equal is this frame's own cover (the capture covered it while the
        // matte was cold or stale): the processed frame replaces it. Older
        // is a frame a newer one already superseded.
        if job.sequence < stage.last_published_sequence {
            stage.dropped_late = stage.dropped_late.saturating_add(1);
            return;
        }
        stage.last_processed_capture = Some(job.captured_at);
        stage.last_published_sequence = job.sequence;
        stage.processed_frames = stage.processed_frames.saturating_add(1);
        stage.covering = false;
        stage.cover_since = None;
        stage.last_error = None;
        publish_output(guard, output, job.sequence, job.captured_at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CameraBackgroundEdges, CameraBackgroundKey, CameraKeyEdges};
    use std::sync::atomic::AtomicUsize;

    const RAW: u8 = 0x11;
    const PROCESSED: u8 = 0xB0;
    const COVER: u8 = 0xC0;
    const W: u32 = 32;
    const H: u32 = 18;
    const FRAME: Duration = Duration::from_millis(33);

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Mode {
        Healthy,
        Error,
        Empty,
    }

    struct FakeSegmenter(Arc<StdMutex<Mode>>);

    impl PersonSegmenter for FakeSegmenter {
        fn segment(&mut self, _frame: &EffectFrame) -> Result<Matte, String> {
            match *self.0.lock().unwrap() {
                Mode::Healthy => Ok(Matte {
                    width: 4,
                    height: 3,
                    values: vec![200; 12],
                }),
                Mode::Error => Err("fake segmenter failed".to_string()),
                Mode::Empty => Ok(Matte {
                    width: 0,
                    height: 0,
                    values: Vec::new(),
                }),
            }
        }
    }

    struct FakeRenderer(Arc<AtomicUsize>);

    fn tagged(frame: &EffectFrame, tag: u8) -> EffectOutput {
        EffectOutput {
            width: frame.width,
            height: frame.height,
            bytes: vec![tag; frame.width as usize * frame.height as usize * 4],
            pixel_buffer: None,
            gpu_ms: Some(0.5),
        }
    }

    impl EffectRenderer for FakeRenderer {
        fn processed(
            &mut self,
            frame: &EffectFrame,
            _matte: &Matte,
            _look: &EffectLook,
        ) -> Result<EffectOutput, String> {
            Ok(tagged(frame, PROCESSED))
        }

        fn cover(
            &mut self,
            frame: &EffectFrame,
            _look: &EffectLook,
        ) -> Result<EffectOutput, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(tagged(frame, COVER))
        }
    }

    struct Harness {
        shared: Arc<StdMutex<PreviewCameraShared>>,
        mode: Arc<StdMutex<Mode>>,
        gpu_covers: Arc<AtomicUsize>,
        worker: Option<Worker>,
        clock: Instant,
        sequence: u64,
        factory: EngineFactory,
        unavailable: bool,
    }

    fn setting(mode: CameraBackgroundMode) -> CameraBackground {
        CameraBackground {
            mode,
            blur_pct: 70,
            edges: CameraBackgroundEdges::Balanced,
            asset_id: Some("builtin-bg-06".to_string()),
            key: Some(CameraBackgroundKey {
                similarity_pct: 40,
                smoothness_pct: 8,
                spill_pct: 10,
                hide_edges: CameraKeyEdges::default(),
            }),
        }
    }

    impl Harness {
        fn new() -> Self {
            Self::with(false)
        }

        fn with(unavailable: bool) -> Self {
            let mode = Arc::new(StdMutex::new(Mode::Healthy));
            let gpu_covers = Arc::new(AtomicUsize::new(0));
            let factory: EngineFactory = {
                let mode = Arc::clone(&mode);
                let gpu_covers = Arc::clone(&gpu_covers);
                Arc::new(move || EngineParts {
                    segmenter: if unavailable {
                        Err("no engine on this host".to_string())
                    } else {
                        Ok(Box::new(FakeSegmenter(Arc::clone(&mode))))
                    },
                    renderer: Some(Box::new(FakeRenderer(Arc::clone(&gpu_covers)))),
                })
            };
            let shared = Arc::new(StdMutex::new(PreviewCameraShared {
                effect: CameraEffectStage::for_tests(Arc::clone(&factory)),
                ..PreviewCameraShared::default()
            }));
            Self {
                shared,
                mode,
                gpu_covers,
                worker: None,
                clock: Instant::now(),
                sequence: 0,
                factory,
                unavailable,
            }
        }

        fn apply(&mut self, mode: CameraBackgroundMode) {
            let setting = setting(mode);
            let look = EffectLook::from_setting(Some(&setting), None, false);
            apply_look(&self.shared, Some(&setting), look);
            self.restart_worker();
        }

        fn off(&mut self) {
            apply_look(&self.shared, None, None);
            self.worker = None;
        }

        /// The test's stand-in for the worker thread arm() would spawn.
        fn restart_worker(&mut self) {
            let guard = self.shared.lock().unwrap();
            let Some(engine) = guard.effect.engine.clone() else {
                return;
            };
            let generation = guard.effect.generation;
            if self
                .worker
                .as_ref()
                .is_some_and(|worker| worker.generation == generation)
            {
                return;
            }
            drop(guard);
            self.worker = Worker::start(
                &self.factory,
                engine,
                Arc::downgrade(&self.shared),
                generation,
            );
            if self.unavailable {
                assert!(self.worker.is_none());
            }
        }

        /// One camera frame through the same branch the capture paths take.
        fn capture(&mut self) {
            self.sequence += 1;
            self.clock += FRAME;
            let frame = EffectFrame {
                width: W,
                height: H,
                pixels: EffectPixels::Bytes(vec![RAW; (W * H * 4) as usize]),
            };
            let mut guard = self.shared.lock().unwrap();
            if guard.effect.is_armed() {
                let pending = on_armed_capture(&mut guard, frame, self.sequence, self.clock);
                drop(guard);
                if let Some(pending) = pending {
                    finish_cover(&self.shared, pending);
                }
            } else {
                let EffectPixels::Bytes(bytes) = frame.pixels else {
                    unreachable!()
                };
                let sequence = self.sequence;
                let clock = self.clock;
                guard.frame_store.publish_with_source_handles(
                    sequence,
                    W,
                    H,
                    PreviewCameraPixelFormat::Bgra8,
                    clock,
                    bytes,
                    None,
                    None,
                );
            }
        }

        /// Let the worker take the newest frame.
        fn segment(&mut self) {
            let job = self
                .shared
                .lock()
                .unwrap()
                .effect
                .engine
                .as_ref()
                .and_then(|engine| engine.take_job());
            if let (Some(worker), Some(job)) = (self.worker.as_mut(), job) {
                worker.step(job);
            }
        }

        fn latest_tag(&self) -> Option<u8> {
            self.shared
                .lock()
                .unwrap()
                .frame_store
                .latest()
                .map(|frame| frame.bytes[3])
        }

        /// Privacy invariant 1: with an effect on, the store never holds raw.
        fn assert_never_raw(&self, step: &str) {
            let tag = self.latest_tag();
            assert_ne!(tag, Some(RAW), "{step}: the store holds a raw frame");
        }

        fn status(&self) -> CameraBackgroundStatus {
            self.shared
                .lock()
                .unwrap()
                .effect
                .status(Instant::now())
                .expect("armed stage has a status")
        }
    }

    /// Privacy invariant 1, the stalled, failing and empty-matte segmenter:
    /// every capture leaves a processed frame or the cover in the store.
    #[test]
    fn invariant_1_no_raw_frame_enters_the_store_while_an_effect_is_on() {
        for effect in [CameraBackgroundMode::Blur, CameraBackgroundMode::Image] {
            for failure in [None, Some(Mode::Error), Some(Mode::Empty)] {
                let mut harness = Harness::new();
                harness.apply(effect);
                for frame in 0..60 {
                    if frame == 20
                        && let Some(failure) = failure
                    {
                        *harness.mode.lock().unwrap() = failure;
                    }
                    harness.capture();
                    harness.assert_never_raw(&format!("{effect:?} {failure:?} frame {frame}"));
                    // Stalled segmenter: frames 40.. never reach the worker.
                    if frame < 40 {
                        harness.segment();
                        harness.assert_never_raw(&format!("{effect:?} {failure:?} seg {frame}"));
                    }
                }
                assert_eq!(harness.latest_tag(), Some(COVER), "{effect:?} {failure:?}");
            }
        }
    }

    #[test]
    fn a_healthy_segmenter_publishes_every_frame_processed_with_its_own_matte() {
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        // Before the first matte: the cover (D6's startup cover).
        harness.capture();
        assert_eq!(harness.latest_tag(), Some(COVER));
        harness.segment();
        assert_eq!(harness.latest_tag(), Some(PROCESSED));
        for _ in 0..30 {
            harness.capture();
            // The capture publishes nothing; the store keeps the last
            // processed frame until the worker draws this one.
            assert_eq!(harness.latest_tag(), Some(PROCESSED));
            harness.segment();
            assert_eq!(harness.latest_tag(), Some(PROCESSED));
        }
        let status = harness.status();
        assert_eq!(status.state, CameraBackgroundStageState::Running);
        assert_eq!(status.processed_frames, 31);
        assert_eq!(status.cover_frames, 1);
        assert!(status.mask_age_ms.unwrap() < 100);
        assert!(status.compose_gpu_ms_p95.is_some());
        // The engine's GPU cover drew the startup cover.
        assert_eq!(harness.gpu_covers.load(Ordering::SeqCst), 1);
    }

    /// Privacy invariant 2: enabling swaps the frame already stored for the
    /// cover before `apply_look` returns, so a read between activation and
    /// the next capture gets the cover; a new camera session (a camera
    /// switch, a session start or a relaunch) armed from its layout starts
    /// on the cover.
    #[test]
    fn invariant_2_the_first_frame_after_enabling_is_never_raw() {
        let mut harness = Harness::new();
        for _ in 0..3 {
            harness.capture();
        }
        assert_eq!(harness.latest_tag(), Some(RAW), "Off publishes raw");
        let raw_sequence = harness
            .shared
            .lock()
            .unwrap()
            .frame_store
            .latest()
            .unwrap()
            .sequence;
        harness.apply(CameraBackgroundMode::Blur);
        let latest = harness.shared.lock().unwrap().frame_store.latest().unwrap();
        assert_ne!(latest.bytes[3], RAW, "the stored raw frame was swapped");
        assert_eq!(latest.sequence, raw_sequence);
        assert_eq!(harness.status().state, CameraBackgroundStageState::Cover);
        harness.capture();
        harness.assert_never_raw("first capture after enabling");

        // The same for a picture: the swap draws the neutral ground.
        let mut picture = Harness::new();
        picture.capture();
        picture.apply(CameraBackgroundMode::Image);
        let latest = picture.shared.lock().unwrap().frame_store.latest().unwrap();
        assert_eq!(&latest.bytes[..4], &NEUTRAL_GROUND_BGRA);

        // A new session armed before its first frame: cover from frame one.
        let mut fresh = Harness::new();
        fresh.apply(CameraBackgroundMode::Blur);
        assert_eq!(fresh.latest_tag(), None);
        fresh.capture();
        assert_eq!(fresh.latest_tag(), Some(COVER));
    }

    /// Plan 258 S5: a reader that copied a frame while the stage was off
    /// (the Studio's "What viewers see" BMP) can tell that an effect armed
    /// during the copy, and never serves the raw frame arming replaced.
    #[test]
    fn a_raw_read_knows_when_an_effect_armed_during_it() {
        let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
        let before = shared.lock().unwrap().effect.raw_read_epoch();
        assert!(
            before.is_some(),
            "Off: a read may be raw, so it carries an epoch"
        );
        let background = setting(CameraBackgroundMode::Blur);
        apply_look(
            &shared,
            Some(&background),
            EffectLook::from_setting(Some(&background), None, false),
        );
        assert_eq!(shared.lock().unwrap().effect.raw_read_epoch(), None);
        apply_look(&shared, None, None);
        let after = shared.lock().unwrap().effect.raw_read_epoch();
        assert!(after.is_some());
        assert_ne!(after, before, "arming and disarming moved the epoch on");
    }

    #[test]
    fn the_swap_cover_blurs_the_stored_frame_on_the_cpu() {
        let mut shared = PreviewCameraShared::default();
        let (w, h) = (64u32, 36u32);
        // The fixture's room: a fine magenta/cyan checker.
        let mut bytes = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let on = (x / 2 + y / 2).is_multiple_of(2);
                bytes[i..i + 4].copy_from_slice(if on {
                    &[255, 0, 255, 255]
                } else {
                    &[255, 255, 0, 255]
                });
            }
        }
        shared.frame_store.publish_with_source_handles(
            1,
            w,
            h,
            PreviewCameraPixelFormat::Bgra8,
            Instant::now(),
            bytes,
            None,
            None,
        );
        let shared = Arc::new(StdMutex::new(shared));
        let background = setting(CameraBackgroundMode::Blur);
        apply_look(
            &shared,
            Some(&background),
            EffectLook::from_setting(Some(&background), None, false),
        );
        let latest = shared.lock().unwrap().frame_store.latest().unwrap();
        // Every pixel sits near the checker's mean: no cell survives.
        for pixel in latest.bytes.chunks_exact(4) {
            assert!((pixel[1] as i32 - 128).abs() < 24, "{pixel:?}");
            assert!((pixel[2] as i32 - 128).abs() < 24, "{pixel:?}");
        }
    }

    /// Privacy invariant 3: a stalled or failed segmenter yields the cover
    /// at the first capture whose newest matte is 100 ms old, never raw;
    /// only Off brings raw frames back.
    #[test]
    fn invariant_3_a_stall_shows_the_cover_within_100_ms_and_only_off_returns_raw() {
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        for _ in 0..10 {
            harness.capture();
            harness.segment();
        }
        assert_eq!(harness.latest_tag(), Some(PROCESSED));
        let last_matte = harness.clock;
        let mut covered_at = None;
        for _ in 0..30 {
            harness.capture(); // stalled: the worker never runs
            harness.assert_never_raw("stall");
            if covered_at.is_none() && harness.latest_tag() == Some(COVER) {
                covered_at = Some(harness.clock);
            }
        }
        let covered_at = covered_at.expect("the cover took over");
        let age = covered_at.duration_since(last_matte);
        assert!(age >= MAX_MASK_AGE, "covered at {age:?}: too early");
        assert!(
            age < MAX_MASK_AGE + FRAME,
            "covered at {age:?}: later than one frame past 100 ms"
        );
        let status = harness.status();
        assert_eq!(status.state, CameraBackgroundStageState::Cover);
        assert_eq!(status.cover_after_mask_age_ms, Some(duration_ms(age)));

        // The worker recovers: processed again.
        harness.capture();
        harness.segment();
        assert_eq!(harness.latest_tag(), Some(PROCESSED));
        assert_eq!(harness.status().state, CameraBackgroundStageState::Running);

        // A failing segmenter: the cover, never raw, for as long as it fails.
        *harness.mode.lock().unwrap() = Mode::Error;
        for _ in 0..10 {
            harness.capture();
            harness.segment();
            harness.assert_never_raw("failing");
        }
        assert_eq!(harness.latest_tag(), Some(COVER));
        assert!(
            harness
                .status()
                .message
                .unwrap()
                .contains("fake segmenter failed")
        );

        // Off is the only way back to raw.
        harness.off();
        harness.capture();
        assert_eq!(harness.latest_tag(), Some(RAW));
    }

    #[test]
    fn no_engine_here_means_unavailable_and_the_cover_on_every_frame() {
        let mut harness = Harness::with(true);
        harness.apply(CameraBackgroundMode::Blur);
        for _ in 0..10 {
            harness.capture();
            harness.segment();
            harness.assert_never_raw("unavailable");
        }
        assert_eq!(harness.latest_tag(), Some(COVER));
        let status = harness.status();
        assert_eq!(status.state, CameraBackgroundStageState::Unavailable);
        assert_eq!(status.message.as_deref(), Some("no engine on this host"));
    }

    #[test]
    fn a_frame_drawn_for_an_older_generation_or_out_of_order_is_dropped() {
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        harness.capture();
        // Off arrives while the worker holds the frame: it must not land.
        let job = harness
            .shared
            .lock()
            .unwrap()
            .effect
            .engine
            .as_ref()
            .unwrap()
            .take_job()
            .unwrap();
        let mut worker = harness.worker.take().unwrap();
        harness.off();
        harness.capture();
        assert_eq!(harness.latest_tag(), Some(RAW));
        worker.step(job);
        assert_eq!(
            harness.latest_tag(),
            Some(RAW),
            "the stale processed frame never lands"
        );

        // Out of order: a newer cover is already published.
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        harness.capture();
        let old = harness
            .shared
            .lock()
            .unwrap()
            .effect
            .engine
            .as_ref()
            .unwrap()
            .take_job()
            .unwrap();
        harness.capture(); // cover, sequence 2
        let worker = harness.worker.as_mut().unwrap();
        worker.step(old);
        assert_eq!(harness.latest_tag(), Some(COVER));
        assert_eq!(harness.shared.lock().unwrap().effect.dropped_late, 1);
    }

    #[test]
    fn changing_the_look_keeps_the_engine_and_never_publishes_raw() {
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        harness.capture();
        harness.segment();
        let generation = harness.shared.lock().unwrap().effect.generation;
        harness.apply(CameraBackgroundMode::Image);
        assert_eq!(harness.shared.lock().unwrap().effect.generation, generation);
        harness.capture();
        harness.assert_never_raw("look change");
        harness.segment();
        assert_eq!(harness.latest_tag(), Some(PROCESSED));
        // A screen key is no stage work: raw again, keyed by the compositor.
        harness.apply(CameraBackgroundMode::Green);
        harness.capture();
        assert_eq!(harness.latest_tag(), Some(RAW));
    }

    #[test]
    fn later_slices_picks_hold_the_cover() {
        for mode in [CameraBackgroundMode::Video, CameraBackgroundMode::Cutout] {
            let mut harness = Harness::new();
            harness.apply(mode);
            for _ in 0..5 {
                harness.capture();
                harness.assert_never_raw("pending");
            }
            let look = EffectLook::from_setting(Some(&setting(mode)), None, false).unwrap();
            assert_eq!(look.kind, EffectKind::Pending);
            let frame = EffectFrame {
                width: 4,
                height: 2,
                pixels: EffectPixels::Bytes(vec![RAW; 32]),
            };
            assert_eq!(&cpu_cover(&frame, &look).bytes[..4], &NEUTRAL_GROUND_BGRA);
        }
    }

    #[test]
    fn looks_follow_the_setting() {
        for mode in [
            CameraBackgroundMode::Off,
            CameraBackgroundMode::Green,
            CameraBackgroundMode::Blue,
        ] {
            assert_eq!(
                EffectLook::from_setting(Some(&setting(mode)), None, false),
                None
            );
        }
        assert_eq!(EffectLook::from_setting(None, None, false), None);
        let image = EffectLook::from_setting(
            Some(&setting(CameraBackgroundMode::Image)),
            Some(PathBuf::from("/managed/podcast.webp")),
            true,
        )
        .unwrap();
        assert_eq!(
            image.kind,
            EffectKind::Image {
                asset_id: "builtin-bg-06".to_string(),
                path: Some(PathBuf::from("/managed/podcast.webp")),
                mirror: true,
            }
        );
    }

    #[test]
    fn blur_sigma_scales_with_strength_and_height() {
        let near = |a: f32, b: f32| (a - b).abs() < 0.01;
        assert!(near(blur_sigma_px(70, 1080), 48.0));
        assert!(near(blur_sigma_px(30, 1080), 20.57));
        assert!(near(blur_sigma_px(70, 720), 32.0));
        assert!(near(cover_blur_sigma_px(1080), 72.0));
        assert!(near(blur_sigma_px(0, 1080), 2.0));
        // Strong blur clears the S2 detector's two-cell bar at every size
        // (the fixture room has 54 cells per frame height).
        for height in [360, 720, 1080, 2160] {
            let cell = height as f32 / 54.0;
            assert!(blur_sigma_px(70, height) >= 2.0 * cell, "{height}");
        }
    }

    #[test]
    fn the_matte_ema_never_lifts_confident_background() {
        let previous = Matte {
            width: 3,
            height: 1,
            values: vec![255, 255, 0],
        };
        let current = Matte {
            width: 3,
            height: 1,
            values: vec![0, 200, 255],
        };
        let smoothed = smooth_matte(Some(&previous), current.clone());
        // The hand moved away: background now, background out.
        assert_eq!(smoothed.values[0], 0);
        assert_eq!(smoothed.values[1], 227);
        assert_eq!(smoothed.values[2], 127);
        // A size change starts over.
        let other = Matte {
            width: 1,
            height: 1,
            values: vec![9],
        };
        assert_eq!(smooth_matte(Some(&other), current.clone()), current);
    }

    /// The stage's status survives serde field for field on the camera
    /// status, as the strict TypeScript contract reads it.
    #[test]
    fn camera_background_status_fixture_round_trips() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-background-status.json"
        ))
        .unwrap();
        for name in ["running", "cover", "unavailable"] {
            let wire = fixture[name].clone();
            let status: crate::protocol::PreviewCameraStatus = serde_json::from_value(wire.clone())
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(status.camera_background.is_some(), "{name}");
            assert_eq!(serde_json::to_value(&status).unwrap(), wire, "{name}");
        }
        // And what the stage itself builds parses back.
        let mut harness = Harness::new();
        harness.apply(CameraBackgroundMode::Blur);
        harness.capture();
        let built = serde_json::to_value(harness.status()).unwrap();
        let back: CameraBackgroundStatus = serde_json::from_value(built.clone()).unwrap();
        assert_eq!(serde_json::to_value(back).unwrap(), built);
        assert_eq!(built["state"], "cover");
    }

    #[test]
    fn the_debug_stall_is_refused_in_release() {
        if cfg!(debug_assertions) {
            set_debug_segmentation_stall(false).unwrap();
        } else {
            assert!(set_debug_segmentation_stall(true).is_err());
        }
    }
}
