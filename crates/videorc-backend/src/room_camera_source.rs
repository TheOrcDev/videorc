//! Plan 249 S13b: the processed camera role's native producer.
//!
//! One camera owner. While a room publishes the processed camera, the native
//! preview camera keeps the device (the room does not borrow it: see
//! `KEPT_FOR_ROOM`), its frames go through the compositor's own camera-source
//! processing (`compositor::camera_role_rgba`: key, speck cleanup, despill,
//! look) and reach the room through `room_frame_bridge`'s processed role.
//! Low-light compensation is a device setting the owner applied on open.
//! Scene crop, fit, mirror and mask stay the cloud scene renderer's.
//!
//! Disabled and unqualified: a debug backend with smoke RPC and
//! `VIDEORC_ROOM_PROCESSED_CAMERA=1` only. `VIDEORC_ROOM_PROCESSED_CAMERA_FIXTURE`
//! (`WxH`) substitutes the device ONLY with `room_frame_bridge`'s fixture
//! pattern for acceptance; processing, transport and consumers stay production.
use crate::room_frame_bridge::{ProcessedFrame, fixture_camera_bgra, logical_size_for};
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub(crate) const ENABLE_ENV: &str = "VIDEORC_ROOM_PROCESSED_CAMERA";
pub(crate) const FIXTURE_ENV: &str = "VIDEORC_ROOM_PROCESSED_CAMERA_FIXTURE";
const FIXTURE_FPS: u64 = 30;

/// True while an open room keeps the native camera for the processed role
/// instead of borrowing it (plan 224 D6's lend is skipped, never doubled).
static KEPT_FOR_ROOM: AtomicBool = AtomicBool::new(false);

pub(crate) fn kept_for_room() -> bool {
    KEPT_FOR_ROOM.load(Ordering::SeqCst)
}
pub(crate) fn set_kept_for_room(kept: bool) {
    KEPT_FOR_ROOM.store(kept, Ordering::SeqCst);
}

/// Every gate: debug build, smoke RPC opt-in, explicit environment opt-in.
pub(crate) fn enabled(smoke_rpc_enabled: bool) -> bool {
    cfg!(debug_assertions)
        && smoke_rpc_enabled
        && std::env::var(ENABLE_ENV).ok().as_deref() == Some("1")
}

/// The debug fixture's source size, e.g. `1280x720` (even, at most 4096).
pub(crate) fn fixture_size() -> Option<(u32, u32)> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var(FIXTURE_ENV).ok()?;
    let (w, h) = value.split_once('x')?;
    let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
    ((2..=4096).contains(&w) && (2..=4096).contains(&h) && w % 2 == 0 && h % 2 == 0)
        .then_some((w, h))
}

/// Connection-owned producer state (the fixture's own clock and "device").
pub(crate) struct Producer {
    started: Instant,
    fixture_generation: u64,
    fixture_unplugged: bool,
    /// The first time this producer saw each camera sequence (pts upper bound).
    last_seen: Option<(u64, Instant)>,
}

impl Default for Producer {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            fixture_generation: 1,
            fixture_unplugged: false,
            last_seen: None,
        }
    }
}

impl Producer {
    /// Fixture "device switch": a new camera generation (debug fixture only).
    pub(crate) fn fixture_switch(&mut self) -> Result<u64, &'static str> {
        fixture_size().ok_or("No fixture camera")?;
        self.fixture_generation += 1;
        self.fixture_unplugged = false;
        Ok(self.fixture_generation)
    }
    /// Fixture "unplug": the camera stops giving frames (debug fixture only).
    pub(crate) fn fixture_unplug(&mut self) -> Result<(), &'static str> {
        fixture_size().ok_or("No fixture camera")?;
        self.fixture_unplugged = true;
        Ok(())
    }

    fn observed(&mut self, sequence: u64) -> Instant {
        match self.last_seen {
            Some((seen, at)) if seen == sequence => at,
            _ => {
                let now = Instant::now();
                self.last_seen = Some((sequence, now));
                now
            }
        }
    }

    fn unavailable(
        &mut self,
        reason: &'static str,
    ) -> Result<Option<ProcessedFrame>, &'static str> {
        // The client sees `camera-unavailable` and decides when to pause.
        tracing::debug!(reason, "processed camera unavailable");
        Ok(None)
    }

    /// The latest processed camera frame at `logical`, or `None` (the reason is logged). A source whose size no longer fits `logical`
    /// (a different camera mode) is an error: the client opens a new generation.
    pub(crate) async fn latest(
        &mut self,
        state: &AppState,
        logical: (u32, u32),
    ) -> Result<Option<ProcessedFrame>, &'static str> {
        // The app's current scene layout: the key and look the compositor
        // itself applies to this camera.
        let layout = state
            .compositor
            .lock()
            .await
            .status
            .scene_layout
            .clone()
            .unwrap_or_else(crate::protocol::default_layout_settings);
        let (bytes, width, height, camera_generation, camera_sequence, layout) =
            if let Some((width, height)) = fixture_size() {
                if self.fixture_unplugged {
                    return self.unavailable("fixture-camera-unplugged");
                }
                let elapsed = self.started.elapsed().as_micros() as u64;
                let sequence = elapsed * FIXTURE_FPS / 1_000_000;
                (
                    fixture_camera_bgra(sequence, width, height),
                    width,
                    height,
                    self.fixture_generation,
                    sequence,
                    layout,
                )
            } else {
                if crate::preview_camera::camera_lent_to_talk_show(state).await {
                    return self.unavailable("camera-lent-to-browser-room");
                }
                let Some(source) = crate::preview_camera::preview_camera_frame_source(state).await
                else {
                    return self.unavailable("native-camera-not-running");
                };
                let Some((frame, _)) = source.latest_frame_blocking() else {
                    return self.unavailable("native-camera-no-frame-yet");
                };
                if frame.bytes.is_empty() {
                    // Zero-copy capture: no CPU bytes to process. Never guessed.
                    return self.unavailable("native-camera-zero-copy-no-cpu-bytes");
                }
                (
                    frame.bytes.clone(),
                    frame.width,
                    frame.height,
                    source.generation(),
                    frame.sequence,
                    layout,
                )
            };
        if logical_size_for(width, height) != Some(logical) {
            return Err("Camera size changed; open a new frame generation");
        }
        let observed_at = self.observed(camera_sequence);
        let (lw, lh) = logical;
        let rgba = tokio::task::spawn_blocking(move || {
            crate::compositor::camera_role_rgba(&bytes, width, height, true, &layout, lw, lh)
        })
        .await
        .map_err(|_| "Camera processing failed")?
        .ok_or("Camera processing refused the frame")?;
        Ok(Some(ProcessedFrame {
            camera_generation,
            camera_sequence,
            observed_at,
            width: lw,
            height: lh,
            rgba,
        }))
    }
}

/// The logical size the producer would publish now (open needs it).
pub(crate) async fn current_logical(state: &AppState) -> Result<(u32, u32), &'static str> {
    if let Some((w, h)) = fixture_size() {
        return logical_size_for(w, h).ok_or("Fixture size outside S10 limits");
    }
    let source = crate::preview_camera::preview_camera_frame_source(state)
        .await
        .ok_or("Native camera is not running")?;
    let (frame, _) = source
        .latest_frame_blocking()
        .ok_or("Native camera has no frame yet")?;
    logical_size_for(frame.width, frame.height).ok_or("Camera size outside S10 limits")
}
