//! Prepared banner bitmaps (plan 186 S3). Every render path draws a banner as
//! a 1:1 blit of a bitmap that was decoded and scaled once, off the render
//! thread, to the exact contained size the banner has on a canvas
//! (`banners::banner_draw_rect`), with its opacity baked in. Steady state is
//! zero decodes, zero scales and zero texture uploads per frame.
//!
//! The worker never holds the compositor lock and never holds this module's
//! mutexes across a decode: a tick that asks for a bitmap that is not ready
//! gets the last prepared bitmap of that banner (or nothing) at once, and the
//! prepare lands on a later tick.
//!
//! Budget: `BANNER_BITMAP_BUDGET_BYTES` for every prepared bitmap together
//! (four 4K full frames plus their vertical twins fit). Entries a tick used
//! within the last second are in use and never evicted; the rest go in LRU
//! order. There is no decoded-source cache: a prepare decodes the stored PNG
//! again.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::banners::{banner_draw_rect, resize_straight_alpha};
use crate::overlay_layout::OverlayRect;
use crate::protocol::Banner;

/// The prepared cache's ceiling (plan 186 "Prepared bitmaps").
pub(crate) const BANNER_BITMAP_BUDGET_BYTES: u64 = 160 * 1024 * 1024;
/// The key-addressed Metal namespace banners draw from (`metal_compositor`
/// asserts it is keyed, with four slots).
pub(crate) const BANNER_METAL_NAMESPACE: u64 = 9;
/// An entry a tick touched this recently is in use.
const BITMAP_HOT_FOR: Duration = Duration::from_secs(1);
/// The stored copy is at most 3840 px a side; a PNG far larger is not ours.
const BANNER_FILE_READ_CAP: u64 = 96 * 1024 * 1024;
const BANNER_DECODE_MAX_ALLOC: u64 = 192 * 1024 * 1024;

static NEXT_BITMAP_REVISION: AtomicU64 = AtomicU64::new(1);

fn next_bitmap_revision() -> u64 {
    NEXT_BITMAP_REVISION.fetch_add(1, Ordering::Relaxed)
}

/// Identity of a stored banner file: an overwritten file re-prepares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct BannerFileRevision {
    pub size: u64,
    pub modified_nanos: u128,
}

pub(crate) fn banner_file_revision(path: &Path) -> Option<BannerFileRevision> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|since_epoch| since_epoch.as_nanos())
        .unwrap_or(0);
    Some(BannerFileRevision {
        size: metadata.len(),
        modified_nanos,
    })
}

/// What one prepared bitmap is for: `(banner id, file revision, canvas, rect,
/// opacity)`. Any change re-prepares; a fade does not (it is a layer factor).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct BannerBitmapKey {
    pub banner_id: String,
    pub file_revision: BannerFileRevision,
    pub canvas: (u32, u32),
    rect_bits: [u64; 4],
    opacity_permille: u16,
}

impl BannerBitmapKey {
    pub(crate) fn new(
        banner_id: &str,
        file_revision: BannerFileRevision,
        canvas: (u32, u32),
        rect: OverlayRect,
        opacity: f64,
    ) -> Self {
        Self {
            banner_id: banner_id.to_string(),
            file_revision,
            canvas: (canvas.0.max(1), canvas.1.max(1)),
            rect_bits: [
                rect.x.to_bits(),
                rect.y.to_bits(),
                rect.w.to_bits(),
                rect.h.to_bits(),
            ],
            opacity_permille: opacity_permille(opacity),
        }
    }
}

fn opacity_permille(opacity: f64) -> u16 {
    (opacity.clamp(0.0, 1.0) * 1000.0).round() as u16
}

/// Everything a prepare needs, and what a tick hands the service to look up.
#[derive(Debug, Clone)]
pub(crate) struct BannerPrepareRequest {
    pub key: BannerBitmapKey,
    pub path: Arc<Path>,
    pub rect: OverlayRect,
    pub opacity: f64,
}

/// A prepared bitmap: straight-alpha BGRA at its exact draw size, opacity
/// baked into the alpha channel. `revision` is its Metal content key.
#[derive(Debug)]
pub(crate) struct BannerBitmap {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    pub revision: u64,
}

impl BannerBitmap {
    pub(crate) fn bytes(&self) -> u64 {
        self.bgra.len() as u64
    }
}

/// Scale `image` to exactly `width` × `height` (premultiplied Lanczos3, then
/// straight alpha again) and bake `opacity` into the alpha channel. Pure.
pub(crate) fn prepare_banner_bitmap(
    image: &image::RgbaImage,
    width: u32,
    height: u32,
    opacity: f64,
) -> BannerBitmap {
    let scaled = resize_straight_alpha(image, width, height);
    let permille = u32::from(opacity_permille(opacity));
    let mut bgra = Vec::with_capacity(scaled.as_raw().len());
    for pixel in scaled.as_raw().chunks_exact(4) {
        let alpha = ((u32::from(pixel[3]) * permille + 500) / 1000).min(255) as u8;
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
    }
    BannerBitmap {
        width: scaled.width(),
        height: scaled.height(),
        bgra,
        revision: next_bitmap_revision(),
    }
}

// --- Budget ------------------------------------------------------------------

/// Bytes one banner's prepared bitmap takes on `canvas` (BGRA at its
/// contained draw size; the orientation picks the rect).
fn banner_prepared_bytes_on(banner: &Banner, canvas: (u32, u32)) -> u64 {
    let rect = match crate::overlay_layout::OverlayOrientation::for_canvas(canvas.0, canvas.1) {
        crate::overlay_layout::OverlayOrientation::Horizontal => banner.horizontal,
        crate::overlay_layout::OverlayOrientation::Vertical => banner.vertical,
    };
    let (_, _, width, height) = banner_draw_rect(
        banner.width,
        banner.height,
        canvas.0 as usize,
        canvas.1 as usize,
        rect,
    );
    width as u64 * height as u64 * 4
}

/// Bytes the prepared cache needs to hold `banners` on every canvas in
/// `canvases` at once. Pure: the estimator behind the Show refusal.
pub(crate) fn estimated_prepared_bytes<'a>(
    banners: impl IntoIterator<Item = &'a Banner>,
    canvases: &[(u32, u32)],
) -> u64 {
    banners
        .into_iter()
        .map(|banner| {
            canvases
                .iter()
                .map(|canvas| banner_prepared_bytes_on(banner, *canvas))
                .sum::<u64>()
        })
        .sum()
}

/// Whether showing `candidate` beside `shown` would push the prepared bitmaps
/// for `canvases` over `budget_bytes` ("Four banners are showing. Hide one
/// first.", the budget arm).
pub(crate) fn show_exceeds_budget(
    shown: &[Banner],
    candidate: &Banner,
    canvases: &[(u32, u32)],
    budget_bytes: u64,
) -> bool {
    estimated_prepared_bytes(shown.iter().chain(std::iter::once(candidate)), canvases)
        > budget_bytes
}

// --- Cache -------------------------------------------------------------------

struct CacheEntry {
    key: BannerBitmapKey,
    bitmap: Arc<BannerBitmap>,
    last_used: Instant,
}

/// The prepared bitmaps, LRU under a byte budget.
pub(crate) struct BannerBitmapCache {
    entries: Vec<CacheEntry>,
    budget_bytes: u64,
    /// Warned once per excursion over the budget while every entry is in use.
    over_budget_warned: bool,
}

impl BannerBitmapCache {
    pub(crate) fn new(budget_bytes: u64) -> Self {
        Self {
            entries: Vec::new(),
            budget_bytes,
            over_budget_warned: false,
        }
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.entries.iter().map(|entry| entry.bitmap.bytes()).sum()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn contains(&self, key: &BannerBitmapKey) -> bool {
        self.entries.iter().any(|entry| &entry.key == key)
    }

    /// The bitmap for `key`, touched as used at `now`.
    pub(crate) fn get(&mut self, key: &BannerBitmapKey, now: Instant) -> Option<Arc<BannerBitmap>> {
        let entry = self.entries.iter_mut().find(|entry| &entry.key == key)?;
        entry.last_used = now;
        Some(Arc::clone(&entry.bitmap))
    }

    /// The most recently used bitmap prepared for `banner_id`, whatever its
    /// canvas, rect or opacity: what a leg draws until its own prepare lands.
    pub(crate) fn latest_for(&self, banner_id: &str) -> Option<Arc<BannerBitmap>> {
        self.entries
            .iter()
            .filter(|entry| entry.key.banner_id == banner_id)
            .max_by_key(|entry| entry.last_used)
            .map(|entry| Arc::clone(&entry.bitmap))
    }

    /// Insert (or replace) `key`, then evict least recently used entries that
    /// are not in use until the budget holds. When every entry is in use the
    /// cache runs over its budget and says so once.
    pub(crate) fn insert(&mut self, key: BannerBitmapKey, bitmap: Arc<BannerBitmap>, now: Instant) {
        self.entries.retain(|entry| entry.key != key);
        self.entries.push(CacheEntry {
            key,
            bitmap,
            last_used: now,
        });
        while self.bytes() > self.budget_bytes {
            let victim = self
                .entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| {
                    now.saturating_duration_since(entry.last_used) > BITMAP_HOT_FOR
                })
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(index, _)| index);
            match victim {
                Some(index) => {
                    self.entries.swap_remove(index);
                }
                None => {
                    if !self.over_budget_warned {
                        tracing::warn!(
                            bytes = self.bytes(),
                            budget = self.budget_bytes,
                            "Prepared banner bitmaps exceed their budget; every bitmap is in use"
                        );
                        self.over_budget_warned = true;
                    }
                    return;
                }
            }
        }
        self.over_budget_warned = false;
    }
}

// --- Service -----------------------------------------------------------------

/// What a tick gets for one draw: the exact bitmap, or the banner's last
/// prepared one while the exact prepare is in flight.
pub(crate) struct BannerBitmapLookup {
    pub exact: Option<Arc<BannerBitmap>>,
    pub fallback: Option<Arc<BannerBitmap>>,
}

impl BannerBitmapLookup {
    pub(crate) fn bitmap(&self) -> Option<&Arc<BannerBitmap>> {
        self.exact.as_ref().or(self.fallback.as_ref())
    }

    pub(crate) fn is_exact(&self) -> bool {
        self.exact.is_some()
    }
}

/// Decodes a stored banner file. Replaced in tests to make a prepare slow.
pub(crate) type BannerDecoder =
    Arc<dyn Fn(&Path) -> Result<image::RgbaImage, String> + Send + Sync>;

struct PrepareQueue {
    pending: VecDeque<BannerPrepareRequest>,
    /// Keys queued or in flight, so a tick asking every frame queues once.
    queued: HashSet<BannerBitmapKey>,
    worker_running: bool,
}

struct ServiceInner {
    cache: Mutex<BannerBitmapCache>,
    queue: Mutex<PrepareQueue>,
    decoder: BannerDecoder,
    /// The process runtime's blocking pool, captured at construction so a
    /// prepare never rides a compositor run's own runtime (whose drop would
    /// wait for it). `None` outside a runtime: a named thread instead.
    runtime: Option<tokio::runtime::Handle>,
    prepares_completed: AtomicU64,
    prepares_failed: AtomicU64,
}

impl ServiceInner {
    fn cache(&self) -> MutexGuard<'_, BannerBitmapCache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn queue(&self) -> MutexGuard<'_, PrepareQueue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The prepare worker and its cache (one per process, on `AppState`).
#[derive(Clone)]
pub(crate) struct BannerPrepareService {
    inner: Arc<ServiceInner>,
}

impl std::fmt::Debug for BannerPrepareService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BannerPrepareService")
            .field("cache_bytes", &self.inner.cache().bytes())
            .finish_non_exhaustive()
    }
}

impl Default for BannerPrepareService {
    fn default() -> Self {
        Self::new()
    }
}

impl BannerPrepareService {
    pub(crate) fn new() -> Self {
        Self::with_decoder(Arc::new(decode_banner_file), BANNER_BITMAP_BUDGET_BYTES)
    }

    pub(crate) fn with_decoder(decoder: BannerDecoder, budget_bytes: u64) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                cache: Mutex::new(BannerBitmapCache::new(budget_bytes)),
                queue: Mutex::new(PrepareQueue {
                    pending: VecDeque::new(),
                    queued: HashSet::new(),
                    worker_running: false,
                }),
                decoder,
                runtime: tokio::runtime::Handle::try_current().ok(),
                prepares_completed: AtomicU64::new(0),
                prepares_failed: AtomicU64::new(0),
            }),
        }
    }

    /// The render tick's lookup for one draw. Never blocks beyond two short
    /// mutexes: the exact bitmap when prepared, else the banner's last one,
    /// and a prepare queued for the exact key when it is missing.
    pub(crate) fn lookup(
        &self,
        request: &BannerPrepareRequest,
        now: Instant,
    ) -> BannerBitmapLookup {
        let (exact, fallback) = {
            let mut cache = self.inner.cache();
            match cache.get(&request.key, now) {
                Some(bitmap) => (Some(bitmap), None),
                None => (None, cache.latest_for(&request.key.banner_id)),
            }
        };
        if exact.is_none() {
            self.request(request.clone());
        }
        BannerBitmapLookup { exact, fallback }
    }

    /// Queue a prepare (once per key) and make sure a worker runs.
    pub(crate) fn request(&self, request: BannerPrepareRequest) {
        let spawn = {
            let mut queue = self.inner.queue();
            if !queue.queued.insert(request.key.clone()) {
                return;
            }
            queue.pending.push_back(request);
            if queue.worker_running {
                false
            } else {
                queue.worker_running = true;
                true
            }
        };
        if spawn {
            spawn_worker(Arc::clone(&self.inner));
        }
    }

    pub(crate) fn cache_bytes(&self) -> u64 {
        self.inner.cache().bytes()
    }

    pub(crate) fn prepares_completed(&self) -> u64 {
        self.inner.prepares_completed.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn prepares_failed(&self) -> u64 {
        self.inner.prepares_failed.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn cache_len(&self) -> usize {
        self.inner.cache().len()
    }

    /// Put a bitmap in the cache directly (tests of the draw paths).
    #[cfg(test)]
    pub(crate) fn insert_for_test(
        &self,
        key: BannerBitmapKey,
        bitmap: BannerBitmap,
    ) -> Arc<BannerBitmap> {
        let bitmap = Arc::new(bitmap);
        self.inner
            .cache()
            .insert(key, Arc::clone(&bitmap), Instant::now());
        bitmap
    }

    /// Block until `prepares_completed` reaches `count` or `timeout` passes.
    #[cfg(test)]
    pub(crate) fn wait_for_prepares(&self, count: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.prepares_completed() + self.inner.prepares_failed.load(Ordering::Acquire) < count
        {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }
}

/// Off the async workers and off every lock: a blocking thread of the
/// process runtime when the service was built inside one, a named thread
/// otherwise (tests without a runtime).
fn spawn_worker(inner: Arc<ServiceInner>) {
    let runtime = inner.runtime.clone();
    let run = move || worker_loop(&inner);
    match runtime {
        Some(handle) => {
            handle.spawn_blocking(run);
        }
        None => {
            if let Err(error) = std::thread::Builder::new()
                .name("banner-prepare".to_string())
                .spawn(run)
            {
                tracing::warn!("Could not start the banner prepare worker: {error}");
            }
        }
    }
}

fn worker_loop(inner: &ServiceInner) {
    loop {
        let request = {
            let mut queue = inner.queue();
            match queue.pending.pop_front() {
                Some(request) => request,
                None => {
                    queue.worker_running = false;
                    return;
                }
            }
        };
        // Another prepare may have landed this key meanwhile; never decode twice.
        let already_prepared = inner.cache().contains(&request.key);
        let outcome = if already_prepared {
            Ok(None)
        } else {
            prepare_request(inner, &request).map(Some)
        };
        inner.queue().queued.remove(&request.key);
        match outcome {
            Ok(Some(bitmap)) => {
                inner
                    .cache()
                    .insert(request.key.clone(), Arc::new(bitmap), Instant::now());
                inner.prepares_completed.fetch_add(1, Ordering::AcqRel);
            }
            Ok(None) => {}
            Err(reason) => {
                inner.prepares_failed.fetch_add(1, Ordering::AcqRel);
                tracing::warn!(
                    banner = %request.key.banner_id,
                    path = %request.path.display(),
                    "Could not prepare a banner bitmap: {reason}"
                );
            }
        }
    }
}

/// Decode, size for the canvas and bake: the only place pixels are touched,
/// and it holds no lock.
fn prepare_request(
    inner: &ServiceInner,
    request: &BannerPrepareRequest,
) -> Result<BannerBitmap, String> {
    let started_at = Instant::now();
    let image = (inner.decoder)(&request.path)?;
    let (canvas_width, canvas_height) = request.key.canvas;
    let (_, _, width, height) = banner_draw_rect(
        image.width(),
        image.height(),
        canvas_width as usize,
        canvas_height as usize,
        request.rect,
    );
    let bitmap = prepare_banner_bitmap(&image, width as u32, height as u32, request.opacity);
    tracing::debug!(
        banner = %request.key.banner_id,
        canvas = ?request.key.canvas,
        size = ?(bitmap.width, bitmap.height),
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        "Prepared a banner bitmap"
    );
    Ok(bitmap)
}

/// The production decoder: the stored PNG (any format `image` guesses is
/// accepted) under an allocation limit, as straight-alpha RGBA.
fn decode_banner_file(path: &Path) -> Result<image::RgbaImage, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|error| format!("open: {error}"))?;
    let mut bytes = Vec::new();
    file.take(BANNER_FILE_READ_CAP)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read: {error}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(BANNER_DECODE_MAX_ALLOC);
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("format: {error}"))?;
    reader.limits(limits);
    reader
        .decode()
        .map(|decoded| decoded.into_rgba8())
        .map_err(|error| format!("decode: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn revision(size: u64) -> BannerFileRevision {
        BannerFileRevision {
            size,
            modified_nanos: 1,
        }
    }

    fn key(id: &str, canvas: (u32, u32), rect: OverlayRect, opacity: f64) -> BannerBitmapKey {
        BannerBitmapKey::new(id, revision(10), canvas, rect, opacity)
    }

    fn bitmap(width: u32, height: u32) -> BannerBitmap {
        BannerBitmap {
            width,
            height,
            bgra: vec![0; (width * height * 4) as usize],
            revision: next_bitmap_revision(),
        }
    }

    fn banner(width: u32, height: u32, horizontal: OverlayRect, vertical: OverlayRect) -> Banner {
        Banner {
            id: format!("b-{width}x{height}-{}", horizontal.w),
            name: "b".to_string(),
            image_file: "b.png".to_string(),
            thumbnail_file: "b.thumb.png".to_string(),
            width,
            height,
            has_alpha: true,
            sort_order: 0,
            shown: true,
            horizontal,
            vertical,
            show_on_stream: true,
            show_in_recording: true,
            opacity: 1.0,
            hide_after_sec: None,
            repeat_every_min: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn full_frame() -> Banner {
        let (horizontal, vertical) = crate::banners::banner_default_places(3840, 2160);
        banner(3840, 2160, horizontal, vertical)
    }

    #[test]
    fn the_key_changes_with_rect_opacity_canvas_and_file_but_not_with_a_fade() {
        let rect = OverlayRect::new(0.1, 0.2, 0.3, 0.4);
        let base = key("a", (1920, 1080), rect, 1.0);
        assert_eq!(base, key("a", (1920, 1080), rect, 1.0));
        assert_ne!(base, key("a", (1920, 1080), rect, 0.5));
        assert_ne!(base, key("a", (1280, 720), rect, 1.0));
        assert_ne!(
            base,
            key(
                "a",
                (1920, 1080),
                OverlayRect::new(0.1, 0.2, 0.3, 0.41),
                1.0
            )
        );
        assert_ne!(
            base,
            BannerBitmapKey::new("a", revision(11), (1920, 1080), rect, 1.0)
        );
        assert_ne!(base, key("b", (1920, 1080), rect, 1.0));
    }

    #[test]
    fn prepare_scales_through_premultiplied_pixels_and_bakes_the_opacity() {
        // A 16x16 image, red and opaque on the left half, transparent black
        // on the right, downscaled 2x: the pixels across the boundary are
        // partly transparent, and premultiplied scaling keeps the red and
        // alpha planes identical, so every one of them un-premultiplies to
        // exactly red (a straight-alpha scale would darken them toward the
        // black pixels: no dark halo).
        let image = image::RgbaImage::from_fn(16, 16, |x, _| {
            if x < 8 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        });
        let full = prepare_banner_bitmap(&image, 8, 8, 1.0);
        let half = prepare_banner_bitmap(&image, 8, 8, 0.5);
        assert_eq!((half.width, half.height), (8, 8));
        let pixel = |bitmap: &BannerBitmap, x: usize, y: usize| {
            let index = (y * 8 + x) * 4;
            [
                bitmap.bgra[index],
                bitmap.bgra[index + 1],
                bitmap.bgra[index + 2],
                bitmap.bgra[index + 3],
            ]
        };
        let mut partial = 0;
        for y in 0..8 {
            for x in 0..8 {
                let [b, g, r, a] = pixel(&full, x, y);
                if a > 0 {
                    assert_eq!((r, g, b), (255, 0, 0), "halo at {x},{y} (alpha {a})");
                }
                partial += usize::from(a > 0 && a < 255);
            }
        }
        assert!(partial >= 8, "{partial} partly transparent pixels");
        assert_eq!(pixel(&full, 0, 0)[3], 255, "left stays opaque");
        assert_eq!(pixel(&full, 7, 0)[3], 0, "right stays clear");
        // Opacity 0.5 halves every alpha (rounded) and touches no colour.
        for y in 0..8 {
            for x in 0..8 {
                let (a, b) = (pixel(&full, x, y), pixel(&half, x, y));
                assert_eq!(b[3], ((u32::from(a[3]) * 500 + 500) / 1000) as u8);
                assert_eq!(&b[..3], &a[..3]);
            }
        }
        // Full opacity and the same size leave the pixels untouched.
        let same = prepare_banner_bitmap(&image, 16, 16, 1.0);
        assert_eq!(same.bgra[..4], [0, 0, 255, 255]);
        assert_ne!(same.revision, half.revision);
    }

    #[test]
    fn the_estimator_counts_each_banner_on_each_canvas_and_four_full_frames_fit() {
        let frame = full_frame();
        let canvases = [(3840_u32, 2160_u32), (1080, 1920)];
        let one = estimated_prepared_bytes([&frame], &canvases);
        // 3840x2160 on the horizontal canvas, 1080 wide (608 tall) contained
        // on the vertical one.
        assert_eq!(one, 3840 * 2160 * 4 + 1080 * 608 * 4);
        let four = vec![frame.clone(), frame.clone(), frame.clone(), frame.clone()];
        assert!(estimated_prepared_bytes(four.iter(), &canvases) <= BANNER_BITMAP_BUDGET_BYTES);
        assert!(!show_exceeds_budget(
            &four[..3],
            &frame,
            &canvases,
            BANNER_BITMAP_BUDGET_BYTES
        ));
        // The refusal arm: a budget three frames fill.
        assert!(show_exceeds_budget(&four[..3], &frame, &canvases, one * 3));
        // No canvases (no compositor run): nothing to refuse on.
        assert!(!show_exceeds_budget(&four, &frame, &[], 1));
    }

    #[test]
    fn the_cache_evicts_least_recently_used_cold_entries_and_keeps_hot_ones() {
        let now = Instant::now();
        let rect = OverlayRect::new(0.0, 0.0, 0.5, 0.5);
        let mut cache = BannerBitmapCache::new(3 * 16 * 16 * 4);
        let long_ago = now - Duration::from_secs(10);
        cache.insert(
            key("a", (64, 64), rect, 1.0),
            Arc::new(bitmap(16, 16)),
            long_ago,
        );
        cache.insert(
            key("b", (64, 64), rect, 1.0),
            Arc::new(bitmap(16, 16)),
            long_ago + Duration::from_secs(1),
        );
        cache.insert(key("c", (64, 64), rect, 1.0), Arc::new(bitmap(16, 16)), now);
        assert_eq!(cache.len(), 3);
        // A fourth goes over: the oldest cold entry (a) goes, c is hot.
        cache.insert(key("d", (64, 64), rect, 1.0), Arc::new(bitmap(16, 16)), now);
        assert_eq!(cache.len(), 3);
        assert!(!cache.contains(&key("a", (64, 64), rect, 1.0)));
        assert!(cache.contains(&key("c", (64, 64), rect, 1.0)));
        // A touch makes b recent; the next eviction takes nothing hot, so the
        // cache runs over budget rather than dropping a bitmap in use.
        assert!(cache.get(&key("b", (64, 64), rect, 1.0), now).is_some());
        cache.insert(key("e", (64, 64), rect, 1.0), Arc::new(bitmap(16, 16)), now);
        assert_eq!(cache.len(), 4);
        assert!(cache.bytes() > 3 * 16 * 16 * 4);
        // The fallback is the banner's most recently used bitmap.
        cache.insert(
            key("b", (32, 32), rect, 1.0),
            Arc::new(bitmap(8, 8)),
            now + Duration::from_secs(1),
        );
        assert_eq!(cache.latest_for("b").map(|b| b.width), Some(8));
        assert!(cache.latest_for("zz").is_none());
    }

    /// A slow prepare never delays a tick: lookups return at once with the
    /// fallback (or nothing), and the exact bitmap lands when the decode ends.
    #[test]
    fn a_slow_prepare_never_blocks_a_lookup() {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let decoder: BannerDecoder = Arc::new(move |_path: &Path| {
            let _ = release_rx.lock().unwrap().recv();
            Ok(image::RgbaImage::from_pixel(
                64,
                32,
                image::Rgba([10, 20, 30, 255]),
            ))
        });
        let service = BannerPrepareService::with_decoder(decoder, BANNER_BITMAP_BUDGET_BYTES);
        let rect = OverlayRect::new(0.0, 0.0, 0.5, 0.5);
        let request = BannerPrepareRequest {
            key: key("a", (128, 128), rect, 1.0),
            path: Arc::from(Path::new("/nonexistent/a.png")),
            rect,
            opacity: 1.0,
        };
        // An older bitmap of the same banner stands in meanwhile.
        let old_key = key("a", (64, 64), rect, 1.0);
        service.insert_for_test(old_key, bitmap(32, 16));
        for _ in 0..50 {
            let started = Instant::now();
            let lookup = service.lookup(&request, Instant::now());
            assert!(!lookup.is_exact());
            assert_eq!(
                lookup.bitmap().map(|b| b.width),
                Some(32),
                "the fallback draws"
            );
            assert!(
                started.elapsed() < Duration::from_millis(50),
                "a lookup waited on the prepare"
            );
        }
        assert_eq!(service.prepares_completed(), 0);
        release_tx.send(()).unwrap();
        assert!(service.wait_for_prepares(1, Duration::from_secs(5)));
        let lookup = service.lookup(&request, Instant::now());
        assert!(lookup.is_exact());
        // 64x32 contained in a 64x64 rect on a 128x128 canvas: 64x32.
        let bitmap = lookup.bitmap().unwrap();
        assert_eq!((bitmap.width, bitmap.height), (64, 32));
        assert_eq!(bitmap.bgra[..4], [30, 20, 10, 255]);
        // Fifty lookups queued one prepare, not fifty.
        assert_eq!(service.prepares_completed(), 1);
        assert_eq!(service.cache_len(), 2);
    }

    #[test]
    fn a_failed_decode_is_counted_and_never_cached() {
        let decoder: BannerDecoder = Arc::new(|_path: &Path| Err("boom".to_string()));
        let service = BannerPrepareService::with_decoder(decoder, BANNER_BITMAP_BUDGET_BYTES);
        let rect = OverlayRect::new(0.0, 0.0, 0.5, 0.5);
        let request = BannerPrepareRequest {
            key: key("a", (128, 128), rect, 1.0),
            path: Arc::from(Path::new("/nonexistent/a.png")),
            rect,
            opacity: 1.0,
        };
        assert!(service.lookup(&request, Instant::now()).bitmap().is_none());
        assert!(service.wait_for_prepares(1, Duration::from_secs(5)));
        assert_eq!(service.prepares_failed(), 1);
        assert_eq!(service.cache_len(), 0);
        assert_eq!(service.cache_bytes(), 0);
    }
}
