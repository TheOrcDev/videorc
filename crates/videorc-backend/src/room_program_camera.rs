//! Plan 249 S23 (D10): the room's Program preview as Videorc Camera's picture.
//!
//! The Show stage's Program preview (S6 `program-page-report`) is the
//! desktop's reconstruction of what the program page reports drawing. The
//! Studio renderer rasterizes it at 1280x720 and Electron main uploads the
//! frames here (`POST /room-program-camera/frames?token=<admin>&generation=<n>`,
//! admin token only). Mirrors `apps/desktop/src/shared/room-program-camera.ts`
//! and `protocol-fixtures/room-program-camera.json`.
//!
//! - The upload is the owner. While one is open, Videorc Camera reads this
//!   feed instead of the compositor: the latest room frame, or a black paused
//!   still once frames stop for `STALE_AFTER`. It never falls back to the
//!   Studio program or a raw camera while the upload is open. When the upload
//!   closes (opt-out, room end, renderer or main gone), the camera returns to
//!   its Studio source on the next tick.
//! - It is never the encoded stream (`encodedOutput: false`).
//! - While the feed owns the camera the camera does not arm the native
//!   preview run (no 1080p compose for nobody), and native camera ownership is
//!   untouched: this module never opens, lends or keeps a device.
//! - Disabled in production: a debug backend with `VIDEORC_ROOM_PROGRAM_CAMERA=1`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::backend_authority::BackendRole;
use crate::color::{rgb_to_uv_video_range_bt709, rgb_to_y_video_range_bt709};
use crate::compositor::{CompositorFrameExportHandle, CompositorFrameStore, CompositorPixelFormat};
use crate::state::AppState;

pub const ENABLE_ENV: &str = "VIDEORC_ROOM_PROGRAM_CAMERA";
pub const FRAME_WIDTH: u32 = 1280;
pub const FRAME_HEIGHT: u32 = 720;
pub const HEADER_BYTES: usize = 40;
pub const FRAME_BYTES: usize = (FRAME_WIDTH * FRAME_HEIGHT * 4) as usize;
/// Frames older than this pause the camera on a black still.
pub const STALE_AFTER: Duration = Duration::from_millis(1000);
const MAGIC: &[u8; 4] = b"VRPC";
const VERSION: u8 = 1;
const FLAG_RGBA: u8 = 1;
/// Feed sequences start far above any compositor sequence, so switching the
/// camera's source never repeats a frame as if it were the same one.
const FEED_SEQUENCE_BASE: u64 = 1 << 48;
/// S6's surface label for what the frames show.
pub const VIEW_SOURCE: &str = "program-page-report";

/// Whether this backend accepts a room program upload at all.
pub(crate) fn enabled() -> bool {
    cfg!(debug_assertions) && std::env::var(ENABLE_ENV).ok().as_deref() == Some("1")
}

/// What Videorc Camera shows while a room program upload owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomProgramSource {
    /// The room's Program preview (a reconstruction, not the encoded stream).
    RoomProgramPreview,
    /// The upload is open but frames stopped: a black still.
    RoomProgramPaused,
}

/// One frame record's header (little endian): magic `VRPC`, version, flags,
/// reserved u16, width u32, height u32, generation u32, reserved u32,
/// sequence u64, drawn-at microseconds u64.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub width: u32,
    pub height: u32,
    pub generation: u32,
    pub sequence: u64,
    pub drawn_at_us: u64,
}

pub fn parse_header(bytes: &[u8]) -> Result<FrameHeader, &'static str> {
    if bytes.len() < HEADER_BYTES {
        return Err("Short frame header");
    }
    if &bytes[0..4] != MAGIC {
        return Err("Not a room program frame");
    }
    if bytes[4] != VERSION {
        return Err("Unknown frame version");
    }
    if bytes[5] != FLAG_RGBA {
        return Err("Unknown frame flags");
    }
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let u64_at = |at: usize| {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[at..at + 8]);
        u64::from_le_bytes(word)
    };
    if u16_at(6) != 0 || u32_at(20) != 0 {
        return Err("Reserved bytes are set");
    }
    let header = FrameHeader {
        width: u32_at(8),
        height: u32_at(12),
        generation: u32_at(16),
        sequence: u64_at(24),
        drawn_at_us: u64_at(32),
    };
    if header.width != FRAME_WIDTH || header.height != FRAME_HEIGHT {
        return Err("Room program frames are 1280x720");
    }
    if header.generation == 0 {
        return Err("Invalid generation");
    }
    // The TS side caps both at Number.MAX_SAFE_INTEGER.
    const MAX_SAFE: u64 = (1 << 53) - 1;
    if header.sequence == 0 || header.sequence > MAX_SAFE || header.drawn_at_us > MAX_SAFE {
        return Err("Invalid sequence or timestamp");
    }
    Ok(header)
}

/// Straight RGBA to planar I420 (Y, then U, then V; 2x2-averaged chroma) on
/// the BT.709 video-range helpers the CPU compositor uses, so the camera's
/// I420 path reads it exactly as it reads a compositor frame. Alpha is
/// ignored: the Program preview is opaque.
pub fn rgba_to_i420(rgba: &[u8], width: usize, height: usize) -> Vec<u8> {
    debug_assert_eq!(rgba.len(), width * height * 4);
    let y_size = width * height;
    let chroma_w = width / 2;
    let chroma_h = height / 2;
    let chroma_size = chroma_w * chroma_h;
    let mut out = vec![0u8; y_size + 2 * chroma_size];
    let (luma, chroma) = out.split_at_mut(y_size);
    for (pixel, y) in rgba.chunks_exact(4).zip(luma.iter_mut()) {
        *y = rgb_to_y_video_range_bt709(pixel[0], pixel[1], pixel[2]);
    }
    let (u_plane, v_plane) = chroma.split_at_mut(chroma_size);
    for cy in 0..chroma_h {
        for cx in 0..chroma_w {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for dy in 0..2 {
                let row = (cy * 2 + dy) * width;
                for dx in 0..2 {
                    let at = (row + cx * 2 + dx) * 4;
                    r += u32::from(rgba[at]);
                    g += u32::from(rgba[at + 1]);
                    b += u32::from(rgba[at + 2]);
                }
            }
            let (u, v) = rgb_to_uv_video_range_bt709(
                ((r + 2) / 4) as u8,
                ((g + 2) / 4) as u8,
                ((b + 2) / 4) as u8,
            );
            u_plane[cy * chroma_w + cx] = u;
            v_plane[cy * chroma_w + cx] = v;
        }
    }
    out
}

/// A black I420 frame in video range (Y 16, chroma 128).
fn black_i420(width: usize, height: usize) -> Vec<u8> {
    let y_size = width * height;
    let mut bytes = vec![16u8; y_size];
    bytes.resize(y_size + y_size / 2, 128);
    bytes
}

fn new_store() -> CompositorFrameStore {
    Arc::new(StdMutex::new(crate::frame_store::FrameStore::new(2)))
}

fn publish(store: &CompositorFrameStore, sequence: u64, bytes: Vec<u8>) {
    store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .publish_with_metadata(
            sequence,
            FRAME_WIDTH,
            FRAME_HEIGHT,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            CompositorFrameExportHandle::default(),
            Instant::now(),
            bytes,
        );
}

/// Which store the camera reads this tick.
#[derive(Clone)]
pub enum RoomProgramPick {
    /// No upload owns the camera: read the Studio program.
    Studio,
    Live(CompositorFrameStore),
    Paused(CompositorFrameStore),
}

struct FeedOwner {
    generation: u32,
    store: CompositorFrameStore,
    last_sequence: u64,
    last_frame_at: Option<Instant>,
    paused: bool,
}

#[derive(Default)]
struct FeedInner {
    owner: Option<FeedOwner>,
    last_generation: u32,
    next_sequence: u64,
    paused_store: Option<CompositorFrameStore>,
}

impl FeedInner {
    fn take_sequence(&mut self) -> u64 {
        self.next_sequence = self.next_sequence.max(FEED_SEQUENCE_BASE) + 1;
        self.next_sequence
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomProgramCounters {
    pub uploads_opened: u64,
    pub uploads_refused: u64,
    pub frames_accepted: u64,
    pub frames_refused: u64,
    pub pauses: u64,
}

/// One per process, inside `VirtualCameraService`.
#[derive(Default)]
pub struct RoomProgramFeed {
    inner: StdMutex<FeedInner>,
    /// Lock-free for the lease rule (`refresh_wants_lease`).
    owned: AtomicBool,
    uploads_opened: AtomicU64,
    uploads_refused: AtomicU64,
    frames_accepted: AtomicU64,
    frames_refused: AtomicU64,
    pauses: AtomicU64,
}

impl std::fmt::Debug for RoomProgramFeed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RoomProgramFeed")
            .field("owned", &self.owned.load(Ordering::Relaxed))
            .finish()
    }
}

/// Holds the feed for one generation; dropping it (the upload ended) releases it.
pub struct FeedClaim {
    feed: Arc<RoomProgramFeed>,
    generation: u32,
}

impl Drop for FeedClaim {
    fn drop(&mut self) {
        self.feed.release(self.generation);
    }
}

impl RoomProgramFeed {
    fn lock(&self) -> std::sync::MutexGuard<'_, FeedInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether an upload owns the camera now.
    pub fn owned(&self) -> bool {
        self.owned.load(Ordering::Acquire)
    }

    pub fn counters(&self) -> RoomProgramCounters {
        RoomProgramCounters {
            uploads_opened: self.uploads_opened.load(Ordering::Relaxed),
            uploads_refused: self.uploads_refused.load(Ordering::Relaxed),
            frames_accepted: self.frames_accepted.load(Ordering::Relaxed),
            frames_refused: self.frames_refused.load(Ordering::Relaxed),
            pauses: self.pauses.load(Ordering::Relaxed),
        }
    }

    /// One owner at a time, and every generation newer than the last: a
    /// reconnect opens a new generation; a stale one never takes the camera.
    pub fn claim(self: &Arc<Self>, generation: u32) -> Result<FeedClaim, &'static str> {
        let mut inner = self.lock();
        if generation == 0 || generation <= inner.last_generation {
            self.uploads_refused.fetch_add(1, Ordering::Relaxed);
            return Err("Stale generation");
        }
        if inner.owner.is_some() {
            self.uploads_refused.fetch_add(1, Ordering::Relaxed);
            return Err("Another upload owns the room program");
        }
        inner.last_generation = generation;
        inner.owner = Some(FeedOwner {
            generation,
            store: new_store(),
            last_sequence: 0,
            last_frame_at: None,
            paused: false,
        });
        self.owned.store(true, Ordering::Release);
        self.uploads_opened.fetch_add(1, Ordering::Relaxed);
        Ok(FeedClaim {
            feed: self.clone(),
            generation,
        })
    }

    fn release(&self, generation: u32) {
        let mut inner = self.lock();
        if inner
            .owner
            .as_ref()
            .is_some_and(|owner| owner.generation == generation)
        {
            inner.owner = None;
            self.owned.store(false, Ordering::Release);
        }
    }

    /// Whether a frame with this header may be converted (checked before the
    /// conversion, and again in `accept`).
    fn admits(&self, header: &FrameHeader) -> bool {
        self.lock().owner.as_ref().is_some_and(|owner| {
            owner.generation == header.generation && header.sequence > owner.last_sequence
        })
    }

    /// Publish one converted frame of the owning generation.
    pub fn accept(&self, header: &FrameHeader, i420: Vec<u8>, now: Instant) -> bool {
        let mut inner = self.lock();
        let admitted = inner.owner.as_ref().is_some_and(|owner| {
            owner.generation == header.generation && header.sequence > owner.last_sequence
        });
        if !admitted {
            self.frames_refused.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let sequence = inner.take_sequence();
        let owner = inner.owner.as_mut().expect("admitted above");
        owner.last_sequence = header.sequence;
        owner.last_frame_at = Some(now);
        owner.paused = false;
        publish(&owner.store, sequence, i420);
        self.frames_accepted.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// What the camera reads at `now`. A pause (no frame yet, or none for
    /// `STALE_AFTER`) publishes one black still with a fresh sequence.
    pub fn pick(&self, now: Instant) -> RoomProgramPick {
        let mut inner = self.lock();
        let Some(owner) = inner.owner.as_ref() else {
            return RoomProgramPick::Studio;
        };
        let live = owner
            .last_frame_at
            .is_some_and(|at| now.saturating_duration_since(at) < STALE_AFTER);
        if live {
            return RoomProgramPick::Live(owner.store.clone());
        }
        let first_pause = !owner.paused;
        if first_pause || inner.paused_store.is_none() {
            let sequence = inner.take_sequence();
            let store = inner.paused_store.get_or_insert_with(new_store).clone();
            publish(
                &store,
                sequence,
                black_i420(FRAME_WIDTH as usize, FRAME_HEIGHT as usize),
            );
            if let Some(owner) = inner.owner.as_mut() {
                owner.paused = true;
            }
            self.pauses.fetch_add(1, Ordering::Relaxed);
        }
        RoomProgramPick::Paused(
            inner
                .paused_store
                .clone()
                .expect("published above or before"),
        )
    }

    /// The status `source` while an upload owns the camera.
    pub fn source(&self, now: Instant) -> Option<RoomProgramSource> {
        let inner = self.lock();
        let owner = inner.owner.as_ref()?;
        let live = owner
            .last_frame_at
            .is_some_and(|at| now.saturating_duration_since(at) < STALE_AFTER);
        Some(if live {
            RoomProgramSource::RoomProgramPreview
        } else {
            RoomProgramSource::RoomProgramPaused
        })
    }

    pub fn inspect(&self, now: Instant) -> RoomProgramInspect {
        let (generation, last_generation, last_frame_age_ms) = {
            let inner = self.lock();
            (
                inner.owner.as_ref().map(|owner| owner.generation),
                inner.last_generation,
                inner
                    .owner
                    .as_ref()
                    .and_then(|owner| owner.last_frame_at)
                    .map(|at| now.saturating_duration_since(at).as_millis() as u64),
            )
        };
        RoomProgramInspect {
            enabled: enabled(),
            owned: generation.is_some(),
            generation,
            last_generation,
            last_frame_age_ms,
            source: self.source(now),
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            view_source: VIEW_SOURCE,
            encoded_output: false,
            counters: self.counters(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomProgramInspect {
    pub enabled: bool,
    pub owned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u32>,
    pub last_generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_frame_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RoomProgramSource>,
    pub width: u32,
    pub height: u32,
    pub view_source: &'static str,
    pub encoded_output: bool,
    pub counters: RoomProgramCounters,
}

/// Collects frame records from upload chunks. The header is checked before
/// any pixel is kept; a refused frame's pixels are skipped, never buffered.
#[derive(Default)]
struct FrameAssembler {
    header: Vec<u8>,
    current: Option<(FrameHeader, bool)>,
    pixels: Vec<u8>,
    skip_remaining: usize,
}

impl FrameAssembler {
    fn push(
        &mut self,
        mut chunk: &[u8],
        admits: &mut dyn FnMut(&FrameHeader) -> bool,
        completed: &mut dyn FnMut(FrameHeader, Vec<u8>),
    ) -> Result<(), &'static str> {
        while !chunk.is_empty() {
            match self.current {
                None => {
                    let wanted = HEADER_BYTES - self.header.len();
                    let take = wanted.min(chunk.len());
                    self.header.extend_from_slice(&chunk[..take]);
                    chunk = &chunk[take..];
                    if self.header.len() == HEADER_BYTES {
                        let header = parse_header(&self.header)?;
                        self.header.clear();
                        let keep = admits(&header);
                        self.current = Some((header, keep));
                        self.pixels.clear();
                        self.skip_remaining = if keep { 0 } else { FRAME_BYTES };
                        if keep {
                            self.pixels.reserve_exact(FRAME_BYTES);
                        }
                    }
                }
                Some((header, keep)) => {
                    if keep {
                        let take = (FRAME_BYTES - self.pixels.len()).min(chunk.len());
                        self.pixels.extend_from_slice(&chunk[..take]);
                        chunk = &chunk[take..];
                        if self.pixels.len() == FRAME_BYTES {
                            self.current = None;
                            completed(header, std::mem::take(&mut self.pixels));
                        }
                    } else {
                        let take = self.skip_remaining.min(chunk.len());
                        self.skip_remaining -= take;
                        chunk = &chunk[take..];
                        if self.skip_remaining == 0 {
                            self.current = None;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
pub(crate) struct FramesQuery {
    token: String,
    generation: u32,
}

/// `POST /room-program-camera/frames?token=<admin>&generation=<n>`: one
/// long-lived chunked upload of frame records from Electron main. Admin role
/// only. The upload owns the camera's room program until it ends.
pub(crate) async fn frames_upload_handler(
    State(state): State<AppState>,
    Query(query): Query<FramesQuery>,
    body: axum::body::Body,
) -> Response {
    if crate::http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !enabled() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let feed = state.virtual_camera.room_program().clone();
    let claim = match feed.claim(query.generation) {
        Ok(claim) => claim,
        Err(reason) => {
            tracing::warn!("Room program upload refused: {reason}");
            return StatusCode::CONFLICT.into_response();
        }
    };
    tracing::info!(
        "Videorc Camera follows the room's Program preview (generation {})",
        query.generation
    );
    let mut assembler = FrameAssembler::default();
    let mut stream = body.into_data_stream();
    let outcome = loop {
        let Some(chunk) = stream.next().await else {
            break StatusCode::NO_CONTENT;
        };
        let Ok(chunk) = chunk else {
            break StatusCode::BAD_REQUEST;
        };
        let mut completed: Vec<(FrameHeader, Vec<u8>)> = Vec::new();
        let pushed = assembler.push(
            &chunk,
            &mut |header: &FrameHeader| {
                let admitted = feed.admits(header);
                if !admitted {
                    feed.frames_refused.fetch_add(1, Ordering::Relaxed);
                }
                admitted
            },
            &mut |header: FrameHeader, pixels: Vec<u8>| completed.push((header, pixels)),
        );
        if let Err(error) = pushed {
            tracing::warn!("Room program upload ended: {error}");
            break StatusCode::BAD_REQUEST;
        }
        // Latest wins: only the newest completed frame is converted.
        if let Some((header, pixels)) = completed.pop() {
            let feed_for_convert = feed.clone();
            let converted = tokio::task::spawn_blocking(move || {
                let i420 = rgba_to_i420(&pixels, FRAME_WIDTH as usize, FRAME_HEIGHT as usize);
                feed_for_convert.accept(&header, i420, Instant::now())
            })
            .await;
            if converted.is_err() {
                break StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
        if !completed.is_empty() {
            feed.frames_refused
                .fetch_add(completed.len() as u64, Ordering::Relaxed);
        }
    };
    drop(claim);
    tracing::info!(
        "Videorc Camera left the room's Program preview (generation {})",
        query.generation
    );
    outcome.into_response()
}

#[derive(Deserialize)]
pub(crate) struct InspectQuery {
    token: String,
}

/// `GET /room-program-camera/inspect?token=<admin>`: the feed's evidence.
pub(crate) async fn inspect_handler(
    State(state): State<AppState>,
    Query(query): Query<InspectQuery>,
) -> Response {
    if crate::http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut inspect =
        serde_json::to_value(state.virtual_camera.room_program().inspect(Instant::now()))
            .unwrap_or_default();
    if let Some(object) = inspect.as_object_mut() {
        object.insert(
            "camera".to_string(),
            serde_json::to_value(state.virtual_camera.status()).unwrap_or_default(),
        );
    }
    axum::Json(inspect).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../protocol-fixtures/room-program-camera.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    fn header_bytes(header: &FrameHeader) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_BYTES];
        bytes[0..4].copy_from_slice(MAGIC);
        bytes[4] = VERSION;
        bytes[5] = FLAG_RGBA;
        bytes[8..12].copy_from_slice(&header.width.to_le_bytes());
        bytes[12..16].copy_from_slice(&header.height.to_le_bytes());
        bytes[16..20].copy_from_slice(&header.generation.to_le_bytes());
        bytes[24..32].copy_from_slice(&header.sequence.to_le_bytes());
        bytes[32..40].copy_from_slice(&header.drawn_at_us.to_le_bytes());
        bytes
    }

    fn header(generation: u32, sequence: u64) -> FrameHeader {
        FrameHeader {
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            generation,
            sequence,
            drawn_at_us: 1_000,
        }
    }

    #[test]
    fn the_fixture_header_matches_the_parser() {
        let fixture = fixture();
        assert_eq!(fixture["width"], FRAME_WIDTH);
        assert_eq!(fixture["height"], FRAME_HEIGHT);
        assert_eq!(fixture["headerBytes"], HEADER_BYTES as u64);
        assert_eq!(fixture["staleMs"], STALE_AFTER.as_millis() as u64);
        let hex = fixture["header"]["hex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect();
        let parsed = parse_header(&bytes).expect("fixture header parses");
        let expected = &fixture["header"]["fields"];
        assert_eq!(u64::from(parsed.generation), expected["generation"]);
        assert_eq!(parsed.sequence, expected["sequence"]);
        assert_eq!(parsed.drawn_at_us, expected["drawnAtUs"]);
        assert_eq!(header_bytes(&parsed), bytes);
        for refused in fixture["refusedHeaders"].as_array().unwrap() {
            let hex = refused["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
                .collect();
            assert!(
                parse_header(&bytes).is_err(),
                "{} must be refused",
                refused["why"]
            );
        }
    }

    #[test]
    fn rgba_converts_with_the_compositor_matrix() {
        for vector in fixture()["i420"].as_array().unwrap() {
            let rgb: Vec<u8> = vector["rgb"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u8)
                .collect();
            let mut rgba = Vec::new();
            for _ in 0..4 {
                rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
            let i420 = rgba_to_i420(&rgba, 2, 2);
            assert_eq!(i420.len(), 6);
            assert_eq!(u64::from(i420[0]), vector["y"], "{vector}");
            assert_eq!(u64::from(i420[4]), vector["u"], "{vector}");
            assert_eq!(u64::from(i420[5]), vector["v"], "{vector}");
        }
    }

    #[test]
    fn one_owner_newer_generations_and_release_on_drop() {
        let feed = Arc::new(RoomProgramFeed::default());
        assert!(matches!(feed.pick(Instant::now()), RoomProgramPick::Studio));
        let claim = feed.claim(2).expect("first claim");
        assert!(feed.owned());
        assert!(feed.claim(3).is_err(), "one owner at a time");
        drop(claim);
        assert!(!feed.owned());
        assert!(feed.claim(2).is_err(), "a used generation never returns");
        assert!(feed.claim(1).is_err(), "an older generation never returns");
        let _claim = feed.claim(3).expect("a newer generation");
        assert_eq!(feed.counters().uploads_refused, 3);
        assert_eq!(feed.counters().uploads_opened, 2);
    }

    #[test]
    fn frames_go_live_then_pause_on_black_and_resume() {
        let feed = Arc::new(RoomProgramFeed::default());
        let _claim = feed.claim(1).unwrap();
        let start = Instant::now();
        // No frame yet: paused, on black.
        let RoomProgramPick::Paused(paused) = feed.pick(start) else {
            panic!("paused before the first frame");
        };
        let black = paused.lock().unwrap().latest().expect("black still");
        assert_eq!((black.width, black.height), (FRAME_WIDTH, FRAME_HEIGHT));
        assert!(black.bytes[..16].iter().all(|&y| y == 16));
        assert_eq!(
            feed.source(start),
            Some(RoomProgramSource::RoomProgramPaused)
        );

        let i420 = vec![100u8; (FRAME_WIDTH * FRAME_HEIGHT * 3 / 2) as usize];
        assert!(feed.accept(&header(1, 1), i420.clone(), start));
        assert!(
            !feed.accept(&header(1, 1), i420.clone(), start),
            "same sequence"
        );
        assert!(
            !feed.accept(&header(2, 9), i420.clone(), start),
            "other generation"
        );
        let RoomProgramPick::Live(live) = feed.pick(start + Duration::from_millis(10)) else {
            panic!("live after a frame");
        };
        let frame = live.lock().unwrap().latest().unwrap();
        assert!(frame.sequence > FEED_SEQUENCE_BASE);
        assert_eq!(
            feed.source(start),
            Some(RoomProgramSource::RoomProgramPreview)
        );

        // Frames stop: one new black still, then the same one.
        let later = start + STALE_AFTER + Duration::from_millis(1);
        let RoomProgramPick::Paused(paused) = feed.pick(later) else {
            panic!("paused when frames stop");
        };
        let first = paused.lock().unwrap().latest().unwrap().sequence;
        assert!(first > frame.sequence);
        let RoomProgramPick::Paused(again) = feed.pick(later) else {
            panic!("still paused");
        };
        assert_eq!(again.lock().unwrap().latest().unwrap().sequence, first);
        assert_eq!(feed.counters().pauses, 2);

        assert!(feed.accept(&header(1, 2), i420, later));
        assert!(matches!(feed.pick(later), RoomProgramPick::Live(_)));
    }

    #[test]
    fn the_assembler_checks_headers_before_pixels_and_skips_refused_frames() {
        let mut assembler = FrameAssembler::default();
        let mut stream = header_bytes(&header(1, 1));
        stream.extend(std::iter::repeat_n(7u8, FRAME_BYTES));
        stream.extend(header_bytes(&header(1, 2)));
        stream.extend(std::iter::repeat_n(9u8, FRAME_BYTES));
        let mut seen = Vec::new();
        // Odd chunking across header and pixel boundaries.
        for chunk in stream.chunks(65_521) {
            assembler
                .push(
                    chunk,
                    &mut |header: &FrameHeader| header.sequence != 1,
                    &mut |header: FrameHeader, pixels: Vec<u8>| {
                        seen.push((header.sequence, pixels[0], pixels.len()))
                    },
                )
                .unwrap();
        }
        assert_eq!(seen, vec![(2, 9, FRAME_BYTES)]);

        let mut bad = header_bytes(&header(1, 3));
        bad[9] = 4; // width 1280 (0x500) -> 1024 (0x400)
        assert!(
            FrameAssembler::default()
                .push(
                    &bad,
                    &mut |_: &FrameHeader| true,
                    &mut |_: FrameHeader, _: Vec<u8>| {}
                )
                .is_err()
        );
    }
}
