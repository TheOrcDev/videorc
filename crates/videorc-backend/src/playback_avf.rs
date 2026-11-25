//! The Library's playback on macOS (plan 260, L2): AVFoundation plays the
//! recording, so the sound, the clock and the sync are AVPlayer's own, and an
//! `AVPlayerItemVideoOutput` hands over each frame as a BGRA pixel buffer on
//! a **global** IOSurface at the slot's size. The app's native element
//! (`videorc_preview::playback`) leases the newest frame by id
//! (`playback.frame.acquire {leaseId, playbackId}`), imports the IOSurface
//! into its own Metal presenter, and releases it (`playback.frame.release
//! {leaseId}`); no pixel is copied on either side.
//!
//! - **Threads.** `AVPlayer` and `AVPlayerItem` are main-thread objects: they
//!   live in [`MainThreadBound`] and every call goes through the backend's
//!   main run loop (`run_on_main`, which main.rs keeps turning). The video
//!   output is thread-safe; a poll thread asks it for a new frame about every
//!   4 ms at the current host time, as a display link would.
//! - **Leases.** A lease keeps its pixel buffer (and so its IOSurface) alive
//!   and out of the output's pool until it is released or its socket closes
//!   (`handle_playback_frame_lease_control`, socket-owned like the preview's
//!   frame leases).
//! - **The sound** never reaches System audio capture: ScreenCaptureKit
//!   leaves out this process's audio (`excludesCurrentProcessAudio`).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dispatch2::{MainThreadBound, run_on_main};
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVPlayer, AVPlayerActionAtItemEnd, AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFType};
use objc2_core_media::CMTime;
use objc2_core_video::{
    CVPixelBufferGetIOSurface, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::{NSDictionary, NSString, NSURL};
use videorc_protocol::playback::{
    PLAYBACK_FRAME_READY_EVENT, PLAYBACK_STATUS_EVENT, PlaybackFrameReady, PlaybackState,
    PlaybackStatus,
};

use crate::state::AppState;

/// How often the poll thread asks the output for a new frame.
const POLL: Duration = Duration::from_millis(4);
/// The status event's rate while playing.
const STATUS_TICK: Duration = Duration::from_millis(250);
/// How long the open waits for the item to be ready, then for its first frame.
const READY_WAIT: Duration = Duration::from_secs(5);
/// Within this of the end, a playing item has ended.
const END_SLACK_MS: u64 = 40;

/// Keeps a pixel buffer alive; it is only ever dropped, never read.
struct Keep<T>(#[allow(dead_code)] T);
// SAFETY: a CVPixelBuffer is reference counted and may be released on any
// thread; nothing reads through this handle.
unsafe impl<T> Send for Keep<T> {}
unsafe impl<T> Sync for Keep<T> {}

/// One frame the output handed over: its global IOSurface stays valid while
/// this lives.
pub(crate) struct Frame {
    pub frame: PlaybackFrameReady,
    _buffer: Box<dyn Send + Sync>,
}

/// What the poll thread and the methods share.
struct Shared {
    status: StdMutex<PlaybackStatus>,
    latest: StdMutex<Option<Arc<Frame>>>,
    playing: AtomicBool,
    stop: AtomicBool,
    frames: AtomicU64,
}

impl Shared {
    fn status(&self) -> PlaybackStatus {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn update(&self, change: impl FnOnce(&mut PlaybackStatus)) -> PlaybackStatus {
        let mut status = self.status.lock().unwrap_or_else(|p| p.into_inner());
        change(&mut status);
        status.updated_at = chrono::Utc::now().to_rfc3339();
        status.clone()
    }
}

/// The open playback on macOS.
pub(crate) struct MacPlayer {
    pub playback_id: String,
    player: Option<MainThreadBound<Retained<AVPlayer>>>,
    item: Option<MainThreadBound<Retained<AVPlayerItem>>>,
    shared: Arc<Shared>,
    poll: Option<JoinHandle<()>>,
}

fn seconds_ms(time: CMTime) -> Option<u64> {
    // SAFETY: CMTimeGetSeconds reads the value; NaN for an invalid time.
    let seconds = unsafe { time.seconds() };
    (seconds.is_finite() && seconds >= 0.0).then(|| (seconds * 1000.0).round() as u64)
}

fn cm_time_ms(position_ms: u64) -> CMTime {
    // SAFETY: a plain constructor.
    unsafe { CMTime::with_seconds(position_ms as f64 / 1000.0, 600) }
}

fn zero() -> CMTime {
    // SAFETY: a constant CoreMedia exports.
    unsafe { objc2_core_media::kCMTimeZero }
}

/// The video output: 32BGRA at the decode size, on global IOSurfaces (the
/// app imports a frame by its IOSurface id from another process).
fn video_output(size: (u32, u32)) -> Retained<AVPlayerItemVideoOutput> {
    #[allow(deprecated)]
    let global_key = unsafe { objc2_io_surface::kIOSurfaceIsGlobal };
    let surface = CFDictionary::<CFType, CFType>::from_slices(
        &[global_key.as_ref()],
        &[CFBoolean::new(true).as_ref()],
    );
    let format = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
    let width = CFNumber::new_i32(size.0 as i32);
    let height = CFNumber::new_i32(size.1 as i32);
    // SAFETY: CoreVideo's attribute keys are constant CFStrings.
    let keys: [&CFType; 4] = unsafe {
        [
            kCVPixelBufferPixelFormatTypeKey.as_ref(),
            kCVPixelBufferWidthKey.as_ref(),
            kCVPixelBufferHeightKey.as_ref(),
            kCVPixelBufferIOSurfacePropertiesKey.as_ref(),
        ]
    };
    let dictionary = CFDictionary::<CFType, CFType>::from_slices(
        &keys,
        &[
            format.as_ref(),
            width.as_ref(),
            height.as_ref(),
            surface.as_ref(),
        ],
    );
    // SAFETY: CFDictionary is toll-free bridged to NSDictionary; its keys are
    // CFStrings (NSStrings) and its values CF objects (NSObjects).
    let attributes: &NSDictionary<NSString, AnyObject> = unsafe {
        &*(std::ptr::from_ref::<CFDictionary<CFType, CFType>>(&*dictionary)
            .cast::<NSDictionary<NSString, AnyObject>>())
    };
    // SAFETY: the dictionary lives across the call.
    unsafe {
        AVPlayerItemVideoOutput::initWithPixelBufferAttributes(
            AVPlayerItemVideoOutput::alloc(),
            Some(attributes),
        )
    }
}

impl MacPlayer {
    /// Opens `file` paused at 0:00 and waits for its first frame. Blocking:
    /// call it off the async runtime.
    pub fn open(
        state: AppState,
        file: &Path,
        base: PlaybackStatus,
        size: (u32, u32),
    ) -> Result<Self, String> {
        let playback_id = base
            .playback_id
            .clone()
            .ok_or_else(|| "The playback has no id.".to_string())?;
        let path = file.to_string_lossy().into_owned();
        let output = video_output(size);
        let output_for_item = output.clone();
        let (player, item) = run_on_main(move |mtm| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
            // SAFETY: on the main thread (mtm); the item and the output stay
            // retained by the player for as long as it lives.
            unsafe {
                let item = AVPlayerItem::playerItemWithURL(&url, mtm);
                item.addOutput(&output_for_item);
                let player = AVPlayer::playerWithPlayerItem(Some(&*item), mtm);
                player.setActionAtItemEnd(AVPlayerActionAtItemEnd::Pause);
                (
                    MainThreadBound::new(player, mtm),
                    MainThreadBound::new(item, mtm),
                )
            }
        });
        let shared = Arc::new(Shared {
            status: StdMutex::new(base),
            latest: StdMutex::new(None),
            playing: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            frames: AtomicU64::new(0),
        });
        let mut this = Self {
            playback_id: playback_id.clone(),
            player: Some(player),
            item: Some(item),
            shared: shared.clone(),
            poll: None,
        };
        // The item reads the file on its own; wait until it can play.
        let deadline = Instant::now() + READY_WAIT;
        loop {
            let item = this.item.as_ref().expect("the item is set");
            let (status, error) = run_on_main(|mtm| {
                // SAFETY: on the main thread.
                unsafe {
                    let item = item.get(mtm);
                    (
                        item.status(),
                        item.error()
                            .map(|error| error.localizedDescription().to_string()),
                    )
                }
            });
            if status == AVPlayerItemStatus::ReadyToPlay {
                break;
            }
            if status == AVPlayerItemStatus::Failed {
                this.close();
                return Err(error.unwrap_or_else(|| "The recording could not be played.".into()));
            }
            if Instant::now() >= deadline {
                this.close();
                return Err("The recording took too long to open.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // An exact seek to the top makes the output hand over the first frame
        // while paused.
        this.on_player(|player| {
            // SAFETY: on the main thread.
            unsafe { player.seekToTime_toleranceBefore_toleranceAfter(zero(), zero(), zero()) }
        });
        let poll_shared = shared.clone();
        this.poll = std::thread::Builder::new()
            .name("videorc-playback-avf".into())
            .spawn(move || poll(state, poll_shared, output, playback_id))
            .ok();
        if this.poll.is_none() {
            this.close();
            return Err("Playback did not start.".into());
        }
        let deadline = Instant::now() + READY_WAIT;
        while shared.frames.load(Ordering::Relaxed) == 0 {
            if Instant::now() >= deadline {
                this.close();
                return Err("The recording's first frame took too long to decode.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(this)
    }

    fn on_player(&self, call: impl FnOnce(&AVPlayer) + Send) {
        if let Some(player) = self.player.as_ref() {
            run_on_main(|mtm| call(player.get(mtm)));
        }
    }

    pub fn status(&self) -> PlaybackStatus {
        self.shared.status()
    }

    /// The newest frame, for a lease.
    pub fn latest(&self) -> Option<Arc<Frame>> {
        self.shared
            .latest
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Blocking (the main run loop).
    pub fn play(&self) -> PlaybackStatus {
        let ended = self.shared.status().state == PlaybackState::Ended;
        self.on_player(move |player| {
            // SAFETY: on the main thread.
            unsafe {
                if ended {
                    player.seekToTime_toleranceBefore_toleranceAfter(zero(), zero(), zero());
                }
                player.play();
            }
        });
        self.shared.playing.store(true, Ordering::Relaxed);
        self.shared.update(|status| {
            status.state = PlaybackState::Playing;
            if ended {
                status.position_ms = 0;
            }
        })
    }

    pub fn pause(&self) -> PlaybackStatus {
        self.on_player(|player| {
            // SAFETY: on the main thread.
            unsafe { player.pause() }
        });
        self.shared.playing.store(false, Ordering::Relaxed);
        self.shared.update(|status| {
            if status.state == PlaybackState::Playing {
                status.state = PlaybackState::Paused;
            }
        })
    }

    pub fn seek(&self, position_ms: u64) -> PlaybackStatus {
        let duration = self.shared.status().duration_ms;
        let position_ms = position_ms.min(duration);
        let time = cm_time_ms(position_ms);
        self.on_player(move |player| {
            // SAFETY: on the main thread; an exact seek.
            unsafe { player.seekToTime_toleranceBefore_toleranceAfter(time, zero(), zero()) }
        });
        self.shared.update(|status| {
            status.position_ms = position_ms;
            if status.state == PlaybackState::Ended {
                status.state = PlaybackState::Paused;
            }
        })
    }

    pub fn mute(&self, muted: bool) -> PlaybackStatus {
        self.on_player(move |player| {
            // SAFETY: on the main thread.
            unsafe { player.setMuted(muted) }
        });
        self.shared.update(|status| status.muted = muted)
    }

    /// Stops the poll thread and releases AVFoundation's objects on the main
    /// thread. Blocking.
    pub fn close(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(poll) = self.poll.take() {
            let _ = poll.join();
        }
        let player = self.player.take();
        let item = self.item.take();
        run_on_main(move |mtm| {
            if let Some(player) = player {
                let player = player.into_inner(mtm);
                // SAFETY: on the main thread.
                unsafe {
                    player.pause();
                    player.replaceCurrentItemWithPlayerItem(None);
                }
            }
            if let Some(item) = item {
                drop(item.into_inner(mtm));
            }
        });
        *self.shared.latest.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

impl Drop for MacPlayer {
    fn drop(&mut self) {
        if self.player.is_some() || self.poll.is_some() {
            self.close();
        }
    }
}

/// The display-link stand-in: a new frame becomes the latest and is
/// announced; the position follows the item's clock; the end is noticed.
fn poll(
    state: AppState,
    shared: Arc<Shared>,
    output: Retained<AVPlayerItemVideoOutput>,
    playback_id: String,
) {
    let mut last_status = Instant::now();
    while !shared.stop.load(Ordering::Relaxed) {
        // SAFETY: mach_absolute_time has no preconditions.
        #[allow(deprecated)]
        let now = unsafe { libc::mach_absolute_time() } as i64;
        // SAFETY: the output is thread-safe (AVFoundation's display-link use).
        let item_time = unsafe { output.itemTimeForMachAbsoluteTime(now) };
        // SAFETY: as above.
        if unsafe { output.hasNewPixelBufferForItemTime(item_time) } {
            let mut shown = item_time;
            // SAFETY: `shown` is a valid out pointer for the call.
            let buffer = unsafe {
                output.copyPixelBufferForItemTime_itemTimeForDisplay(item_time, &mut shown)
            };
            if let Some(buffer) = buffer {
                let surface = CVPixelBufferGetIOSurface(Some(&*buffer));
                if let Some(surface) = surface {
                    let id = shared.frames.fetch_add(1, Ordering::Relaxed) + 1;
                    let status = shared.status();
                    let frame = PlaybackFrameReady {
                        playback_id: playback_id.clone(),
                        frame_id: id,
                        width: status.width,
                        height: status.height,
                        position_ms: seconds_ms(shown).unwrap_or(status.position_ms),
                        iosurface_id: Some(surface.id()),
                        updated_at: chrono::Utc::now().to_rfc3339(),
                    };
                    state.emit_event(PLAYBACK_FRAME_READY_EVENT, &frame);
                    *shared.latest.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(Arc::new(Frame {
                            frame,
                            _buffer: Box::new(Keep(buffer)),
                        }));
                    shared.update(|status| status.frames_published = id);
                }
            }
        }
        if shared.playing.load(Ordering::Relaxed) {
            let position = seconds_ms(item_time);
            let status = shared.update(|status| {
                if let Some(position) = position {
                    status.position_ms = if status.duration_ms > 0 {
                        position.min(status.duration_ms)
                    } else {
                        position
                    };
                }
                if status.duration_ms > 0 && status.position_ms + END_SLACK_MS >= status.duration_ms
                {
                    status.state = PlaybackState::Ended;
                    status.position_ms = status.duration_ms;
                }
            });
            if status.state == PlaybackState::Ended {
                // AVPlayer paused itself (actionAtItemEnd).
                shared.playing.store(false, Ordering::Relaxed);
                state.emit_event(PLAYBACK_STATUS_EVENT, &status);
                last_status = Instant::now();
            } else if last_status.elapsed() >= STATUS_TICK {
                state.emit_event(PLAYBACK_STATUS_EVENT, &status);
                last_status = Instant::now();
            }
        }
        std::thread::sleep(POLL);
    }
}
