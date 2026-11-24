//! Hide screen (plan 210 S7): the process-wide privacy gate every screen
//! capture publishes through, and the still that replaces the live picture.
//!
//! The promise is made at the capture source. While hidden, each capture path's
//! publish point drops live frames and publishes one still in its own frame
//! format, so the program, the aux stream leg, the vertical leg, the Screen ISO
//! file, Clips and the native preview, which all read the same frame store,
//! get the still and nothing else. The decision is pure
//! ([`admit_screen_frame`]) so a new capture path can't forget it, and the
//! platform glue around it stays thin.
//!
//! The still ([`hidden_still_bgra`]) is a designed picture of the frame's
//! size and nothing else: it never reads the screen. It is built once per
//! size and copied on every later hide, never per frame.
//!
//! Both edges fail closed. A frame captured before the hide edge but handed
//! over after it is held (the gate is read at the publish, after the
//! capture). A frame captured while hidden is never published, even when it
//! is handed over after Show: the gate remembers the Show instant, and a
//! capture that knows when its frame was taken holds anything older, and one
//! that doesn't holds its first delivery after the Show too
//! ([`admit_screen_frame_at`], [`ScreenFrameTime`]). A Show never puts the
//! picture held while hidden back on air by itself: on macOS it goes out only
//! once the capture proves it is still the screen after the Show (an idle
//! ScreenCaptureKit callback dated after it); everywhere else the still stays
//! until a frame arrives that can be trusted to be from after the Show.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use crate::protocol::{ScreenPrivacy, ScreenPrivacyReason};

/// The exact copy a `screen.hide` refusal carries while a legacy FFmpeg
/// session reads the display through FFmpeg itself (plan 210 S7.5).
pub const SCREEN_HIDE_UNAVAILABLE_LEGACY: &str =
    "Hide screen isn't available on this recording. Stop and record again.";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Process-wide Hide screen state, in memory only (cleared at launch, D9).
///
/// The hot path reads one atomic: bit 0 is `hidden`, the bits above it are
/// the hide span, bumped on every visible → hidden edge. A publish point
/// frosts once per span and holds every later live frame.
#[derive(Debug, Default)]
pub struct ScreenPrivacyGate {
    packed: AtomicU64,
    /// The last hidden → visible edge, in nanoseconds after
    /// [`privacy_clock_origin`] (0: never shown). Written before the edge
    /// itself, so a reader that sees the gate visible sees this show (or a
    /// later one, which only holds more).
    shown_at_nanos: AtomicU64,
    details: StdMutex<ScreenPrivacyDetails>,
}

/// The process-wide origin [`ScreenPrivacyGate`] dates its Show edge from.
fn privacy_clock_origin() -> Instant {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    *ORIGIN.get_or_init(Instant::now)
}

#[derive(Debug, Default, Clone)]
struct ScreenPrivacyDetails {
    since: Option<String>,
    reason: Option<ScreenPrivacyReason>,
}

/// What a publish point needs from the gate: two atomic loads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenPrivacyView {
    pub hidden: bool,
    pub span: u64,
    /// When the screen was last shown again (`None`: never hidden and shown).
    /// A frame captured before it was taken while the screen was hidden.
    pub shown_at: Option<Instant>,
}

impl ScreenPrivacyGate {
    pub fn view(&self) -> ScreenPrivacyView {
        let (hidden, span) = unpack(self.packed.load(Ordering::Acquire));
        let shown_at = match self.shown_at_nanos.load(Ordering::Acquire) {
            0 => None,
            nanos => Some(privacy_clock_origin() + Duration::from_nanos(nanos)),
        };
        ScreenPrivacyView {
            hidden,
            span,
            shown_at,
        }
    }

    /// Hide. A second hide while hidden changes nothing except the reason: a
    /// hide by the streamer outranks a password-manager hide (D11: "unless
    /// you hid it yourself"), and `since` keeps the first edge.
    pub fn hide(&self, reason: ScreenPrivacyReason, since: String) -> ScreenPrivacy {
        let mut details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut current = self.packed.load(Ordering::Acquire);
        loop {
            let (hidden, span) = unpack(current);
            if hidden {
                if reason == ScreenPrivacyReason::You {
                    details.reason = Some(ScreenPrivacyReason::You);
                }
                break;
            }
            let next = pack(true, span.wrapping_add(1));
            match self.packed.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    details.since = Some(since);
                    details.reason = Some(reason);
                    break;
                }
                Err(observed) => current = observed,
            }
        }
        self.snapshot_locked(&details)
    }

    pub fn show(&self) -> ScreenPrivacy {
        let mut details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut current = self.packed.load(Ordering::Acquire);
        loop {
            let (hidden, span) = unpack(current);
            if !hidden {
                break;
            }
            // Dated before the edge: a publish point that sees the gate
            // visible must also see when it opened.
            let nanos = u64::try_from(
                Instant::now()
                    .saturating_duration_since(privacy_clock_origin())
                    .as_nanos(),
            )
            .unwrap_or(u64::MAX)
            .max(1);
            self.shown_at_nanos.store(nanos, Ordering::Release);
            match self.packed.compare_exchange_weak(
                current,
                pack(false, span),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
        details.since = None;
        details.reason = None;
        self.snapshot_locked(&details)
    }

    pub fn snapshot(&self) -> ScreenPrivacy {
        let details = self
            .details
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.snapshot_locked(&details)
    }

    fn snapshot_locked(&self, details: &ScreenPrivacyDetails) -> ScreenPrivacy {
        let view = self.view();
        if view.hidden {
            ScreenPrivacy {
                hidden: true,
                generation: view.span.saturating_mul(2).saturating_sub(1),
                since: details.since.clone(),
                reason: details.reason,
                unavailable: None,
            }
        } else {
            ScreenPrivacy {
                generation: view.span.saturating_mul(2),
                ..ScreenPrivacy::default()
            }
        }
    }
}

fn pack(hidden: bool, span: u64) -> u64 {
    (span << 1) | u64::from(hidden)
}

/// `(hidden, span)` from the packed word.
fn unpack(packed: u64) -> (bool, u64) {
    (packed & 1 == 1, packed >> 1)
}

/// One publish point's memory of the gate: the span it last frosted for.
/// A new capture session starts with a fresh cursor, so a source started or
/// swapped while hidden frosts its very first frame.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScreenPrivacyCursor {
    frosted_span: Option<u64>,
    /// The Show whose first undated delivery this publish point already
    /// held back ([`ScreenFrameTime::DeliveredFrom`]).
    undated_show_held: Option<Instant>,
}

/// What a publish point knows about when its frame showed the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenFrameTime {
    /// The capture dated the frame: ScreenCaptureKit's PTS, Windows Graphics
    /// Capture's `SystemRelativeTime`, Desktop Duplication's QPC present time,
    /// the Linux portal stream's `SPA_META_Header` pts.
    Captured(Instant),
    /// The capture did not date it (a Linux portal stream whose producer
    /// sends no `SPA_META_Header`, the Windows FFmpeg pipe): only when its
    /// delivery began (the buffer dequeued, the read started). It was taken at or before then, and a frame the capture took
    /// before a Show may still be queued behind the one in flight.
    // macOS dates every frame; only its tests build this one.
    #[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
    DeliveredFrom(Instant),
}

/// What a publish point does with the live frame in its hands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenFrameAdmission {
    /// Visible: publish the live frame as always.
    Publish,
    /// Hidden and this store has no still for the current span yet: publish
    /// the hidden still at this frame's size, once.
    Frost,
    /// Hidden and the still is already published: never publish this frame.
    Hold,
}

/// The one decision every publish point makes, under the store's lock, at the
/// moment it would publish. Taking it earlier (before a copy or a readback)
/// would open a window where a hide lands between the decision and the
/// publish and a live frame covers the still, so nothing decides early.
///
/// Only for the hidden edge (a hide covering a store). A live frame from a
/// capture goes through [`admit_screen_frame_at`], which also closes the Show
/// edge.
pub fn admit_screen_frame(
    view: ScreenPrivacyView,
    cursor: &mut ScreenPrivacyCursor,
) -> ScreenFrameAdmission {
    if !view.hidden {
        return ScreenFrameAdmission::Publish;
    }
    frost_or_hold(view, cursor)
}

/// [`admit_screen_frame`] for a capture's live frame, knowing what it knows
/// about when the frame was taken. The Show edge fails closed:
///
/// - A dated frame taken before the Show shows the screen while it was
///   hidden: it holds, however late the capture hands it over
///   (ScreenCaptureKit delivers a frame a few milliseconds to a few frames
///   after it took it). So does one dated at the Show itself: `Instant`
///   ticks coarsely (about 42 ns on Apple silicon), so the same reading
///   cannot prove the frame came after the Show, and the covered frame wins.
/// - An undated frame whose delivery began before (or at) the Show holds. So does
///   the first one delivered after it, once per Show, at a publish point that
///   covered a hide: it may be a frame the capture took before the Show and
///   queued behind the one in flight. The next one is trusted.
/// - A publish point that never covered a hide (a capture started after the
///   Show) publishes as always.
pub fn admit_screen_frame_at(
    view: ScreenPrivacyView,
    cursor: &mut ScreenPrivacyCursor,
    time: ScreenFrameTime,
) -> ScreenFrameAdmission {
    if view.hidden {
        return frost_or_hold(view, cursor);
    }
    let Some(shown_at) = view.shown_at else {
        return ScreenFrameAdmission::Publish;
    };
    match time {
        ScreenFrameTime::Captured(captured_at) if captured_at <= shown_at => {
            ScreenFrameAdmission::Hold
        }
        ScreenFrameTime::Captured(_) => ScreenFrameAdmission::Publish,
        ScreenFrameTime::DeliveredFrom(began_at) if began_at <= shown_at => {
            ScreenFrameAdmission::Hold
        }
        ScreenFrameTime::DeliveredFrom(_) => {
            if cursor.frosted_span.is_some() && cursor.undated_show_held != Some(shown_at) {
                cursor.undated_show_held = Some(shown_at);
                ScreenFrameAdmission::Hold
            } else {
                ScreenFrameAdmission::Publish
            }
        }
    }
}

fn frost_or_hold(
    view: ScreenPrivacyView,
    cursor: &mut ScreenPrivacyCursor,
) -> ScreenFrameAdmission {
    if cursor.frosted_span == Some(view.span) {
        return ScreenFrameAdmission::Hold;
    }
    cursor.frosted_span = Some(view.span);
    ScreenFrameAdmission::Frost
}

// ---------------------------------------------------------------------------
// Dating capture frames on a counter clock (Windows)
// ---------------------------------------------------------------------------

/// How far ahead of the counter's own "now" a frame's time may read and still
/// be believed (the two readings are a few instructions apart).
#[cfg(any(target_os = "windows", target_os = "linux", test))]
const COUNTER_FUTURE_SLACK: Duration = Duration::from_millis(5);

/// The `Instant` a monotonic counter reading `ticks` stands for, from one
/// simultaneous reading of the counter (`now_ticks`) and of `Instant`
/// (`now`). `None` for a nonsense reading (zero or negative, an invalid rate,
/// or later than now beyond a few milliseconds), which a publish point treats
/// as undated. Pure, so every platform's tests hold it to its word.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
pub fn instant_for_counter(
    ticks: i64,
    ticks_per_second: i64,
    now_ticks: i64,
    now: Instant,
) -> Option<Instant> {
    if ticks <= 0 || ticks_per_second <= 0 || now_ticks <= 0 {
        return None;
    }
    let nanos = |delta: i64| -> Option<Duration> {
        let nanos = i128::from(delta) * 1_000_000_000 / i128::from(ticks_per_second);
        u64::try_from(nanos).ok().map(Duration::from_nanos)
    };
    if ticks <= now_ticks {
        now.checked_sub(nanos(now_ticks - ticks)?)
    } else {
        let ahead = nanos(ticks - now_ticks)?;
        (ahead <= COUNTER_FUTURE_SLACK).then(|| now + ahead)
    }
}

/// How long before its delivery a Linux portal frame's pts may say it was
/// taken and still be believed. A real capture hands a frame over within a
/// few frame intervals; a pts further back is on some other clock (a
/// stream-relative counter, a producer's own epoch), and believing it would
/// hold every frame after a Show as "taken before it" and leave the still up.
#[cfg(any(target_os = "linux", test))]
const PTS_MAX_AGE_AT_DELIVERY: Duration = Duration::from_secs(1);

/// The capture time of a Linux portal frame from its `SPA_META_Header` pts,
/// in nanoseconds of `CLOCK_MONOTONIC` (what the portals' producers stamp:
/// xdg-desktop-portal-hyprland and -wlr from the compositor's presentation
/// time, GNOME's from `g_get_monotonic_time`), given one simultaneous reading
/// of that clock (`now_nanos`) and of `Instant` (`now`), and when the buffer
/// was dequeued. `None` (undated) for a nonsense pts: zero or negative, later
/// than the delivery (beyond a few milliseconds of slack), or more than
/// [`PTS_MAX_AGE_AT_DELIVERY`] before it. Pure, so its tests run anywhere.
#[cfg(any(target_os = "linux", test))]
pub fn instant_for_monotonic_pts(
    pts_nanos: i64,
    now_nanos: i64,
    now: Instant,
    delivered_at: Instant,
) -> Option<Instant> {
    let captured_at = instant_for_counter(pts_nanos, 1_000_000_000, now_nanos, now)?;
    if captured_at > delivered_at + COUNTER_FUTURE_SLACK {
        return None;
    }
    if delivered_at.saturating_duration_since(captured_at) > PTS_MAX_AGE_AT_DELIVERY {
        return None;
    }
    Some(captured_at.min(delivered_at))
}

/// Linux capture times on `Instant`'s clock: `Instant` is `CLOCK_MONOTONIC`
/// there, the clock the portal producers stamp their pts on.
#[cfg(target_os = "linux")]
pub mod linux_clock {
    use std::time::Instant;

    /// `CLOCK_MONOTONIC` in nanoseconds and `Instant`, back to back.
    fn now() -> Option<(i64, Instant)> {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: a valid out pointer for clock_gettime.
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) } != 0 {
            return None;
        }
        // `time_t` and `c_long` are both i64 on Linux x64 (the only Linux target).
        let nanos = ts
            .tv_sec
            .checked_mul(1_000_000_000)?
            .checked_add(ts.tv_nsec)?;
        Some((nanos, Instant::now()))
    }

    /// A portal frame's `SPA_META_Header` pts, delivered at `delivered_at`.
    pub fn instant_for_pts(pts_nanos: i64, delivered_at: Instant) -> Option<Instant> {
        let (now_nanos, now) = now()?;
        super::instant_for_monotonic_pts(pts_nanos, now_nanos, now, delivered_at)
    }
}

/// Windows capture times on `Instant`'s clock. `Instant` is
/// `QueryPerformanceCounter` there, and both captures stamp frames from it:
/// Desktop Duplication's `LastPresentTime` in QPC ticks, Windows Graphics
/// Capture's `SystemRelativeTime` in 100 ns units of the same counter.
#[cfg(target_os = "windows")]
pub mod windows_clock {
    use std::time::Instant;

    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    /// One reading of the counter and of `Instant`, back to back.
    fn now() -> Option<(i64, i64, Instant)> {
        let mut frequency = 0_i64;
        // SAFETY: a valid out pointer.
        unsafe { QueryPerformanceFrequency(&mut frequency) }.ok()?;
        let mut ticks = 0_i64;
        // SAFETY: a valid out pointer.
        unsafe { QueryPerformanceCounter(&mut ticks) }.ok()?;
        Some((ticks, frequency, Instant::now()))
    }

    /// A QPC reading (Desktop Duplication's present time).
    pub fn instant_for_qpc(ticks: i64) -> Option<Instant> {
        let (now_ticks, frequency, now) = now()?;
        super::instant_for_counter(ticks, frequency, now_ticks, now)
    }

    /// A `SystemRelativeTime` (Windows Graphics Capture), 100 ns units of QPC.
    pub fn instant_for_system_relative_100ns(value: i64) -> Option<Instant> {
        let (now_ticks, frequency, now) = now()?;
        let now_100ns =
            i64::try_from(i128::from(now_ticks) * 10_000_000 / i128::from(frequency.max(1)))
                .ok()?;
        super::instant_for_counter(value, 10_000_000, now_100ns, now)
    }
}

// ---------------------------------------------------------------------------
// The hidden still
// ---------------------------------------------------------------------------
//
// Owner, live show 2026-11-20, on the frost this replaced: "Hiding is a little
// bit weird ... make it look good, nice, and like some gradients, like a
// glassy thing, but without transparency." The still is one designed picture,
// a pure function of the frame's size: a calm diagonal gradient, two soft
// glows, a glassy diagonal sheen, and a glass disc with the Hide screen eye in
// the middle. It is fully opaque and never reads the screen, so nothing of
// what was hidden shows through it.
//
// The same arithmetic, step for step, draws it in the renderer's Show stage
// (`lib/hidden-still.ts`) and on the web's program and guest pages
// (`lib/cloud/program/hidden-still.ts`); `protocol-fixtures/hidden-screen-still.json`
// pins all three to the same pixels, each within one level for its `exp`.

/// The diagonal gradient: top left, middle, bottom right (sRGB).
const STILL_TOP_LEFT: [f64; 3] = [46.0, 56.0, 88.0];
const STILL_MIDDLE: [f64; 3] = [30.0, 33.0, 54.0];
const STILL_BOTTOM_RIGHT: [f64; 3] = [38.0, 28.0, 58.0];
/// Corners darken by this much.
const STILL_VIGNETTE: f64 = 0.16;
/// (u, v, σ, colour): a cool glow at the top left, a violet one at the
/// bottom right. σ in min-side units.
const STILL_GLOWS: [(f64, f64, f64, [f64; 3]); 2] = [
    (0.22, 0.06, 0.42, [22.0, 34.0, 60.0]),
    (0.86, 0.98, 0.36, [30.0, 18.0, 46.0]),
];
/// (at, σ, amount): lightening bands across the "/" diagonal, the glass sheen.
const STILL_SHEEN: [(f64, f64, f64); 3] = [
    (-0.3, 0.16, 0.05),
    (-0.19, 0.012, 0.03),
    (0.46, 0.03, 0.018),
];
/// The glass disc, in min-side units.
const DISC_RADIUS: f64 = 0.118;
const DISC_RIM: f64 = 0.0028;
const DISC_FILL: f64 = 0.05;
const DISC_FILL_TOP: f64 = 0.035;
const DISC_RIM_BASE: f64 = 0.06;
const DISC_RIM_TOP: f64 = 0.16;
/// The eye with a slash (Hide screen's icon), in min-side units.
const EYE_HALF_WIDTH: f64 = 0.058;
const EYE_HALF_HEIGHT: f64 = 0.034;
const EYE_STROKE: f64 = 0.0085;
const PUPIL_RADIUS: f64 = 0.0155;
const SLASH_X: f64 = 0.05;
const SLASH_Y: f64 = 0.054;
const SLASH_GAP: f64 = 0.0075;
const ICON_AMOUNT: f64 = 0.3;
/// 4×4 ordered dither, against banding in the encoder.
const STILL_BAYER: [u8; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// Distance from (px, py) to the segment (ax, ay)–(bx, by).
fn segment_distance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let h = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
    let ex = px - ax - dx * h;
    let ey = py - ay - dy * h;
    (ex * ex + ey * ey).sqrt()
}

/// Signed distance to a horizontal lens (the eye's outline): two circles of
/// radius r, centres d above and below, tips at ±EYE_HALF_WIDTH.
fn eye_distance(px: f64, py: f64) -> f64 {
    let a = EYE_HALF_WIDTH;
    let b = EYE_HALF_HEIGHT;
    let r = (a * a + b * b) / (2.0 * b);
    let d = r - b;
    let qx = py.abs();
    let qy = px.abs();
    if (qy - a) * d > qx * a {
        let ex = qx;
        let ey = qy - a;
        return (ex * ex + ey * ey).sqrt();
    }
    let ex = qx + d;
    (ex * ex + qy * qy).sqrt() - r
}

fn axis_table(len: usize, value: impl Fn(f64) -> f64) -> Vec<f64> {
    (0..len).map(|i| value(i as f64)).collect()
}

/// The still at `width`×`height`: tight BGRA rows, opaque. Empty for an empty
/// size.
pub fn hidden_still_pixels(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0_u8; w * h * 4];
    if w == 0 || h == 0 {
        return out;
    }
    let (wf, hf) = (w as f64, h as f64);
    let unit = wf.min(hf);

    let tu = axis_table(w, |x| (x + 0.5) / wf / 2.0);
    let vu = axis_table(w, |x| {
        let u = (x + 0.5) / wf;
        (2.0 * u - 1.0) * (2.0 * u - 1.0)
    });
    let tv = axis_table(h, |y| (y + 0.5) / hf / 2.0);
    let vv = axis_table(h, |y| {
        let v = (y + 0.5) / hf;
        (2.0 * v - 1.0) * (2.0 * v - 1.0)
    });
    let glow_x: Vec<Vec<f64>> = STILL_GLOWS
        .iter()
        .map(|&(u, _, sigma, _)| {
            axis_table(w, |x| {
                let g = (x + 0.5 - u * wf) / unit;
                (-(g * g) / (2.0 * sigma * sigma)).exp()
            })
        })
        .collect();
    let glow_y: Vec<Vec<f64>> = STILL_GLOWS
        .iter()
        .map(|&(_, v, sigma, _)| {
            axis_table(h, |y| {
                let g = (y + 0.5 - v * hf) / unit;
                (-(g * g) / (2.0 * sigma * sigma)).exp()
            })
        })
        .collect();
    // The sheen depends on x + y only.
    let sheen = axis_table(w + h - 1, |k| {
        let s = (k + 1.0 - (wf + hf) / 2.0) / (unit * std::f64::consts::SQRT_2);
        let mut amount = 0.0;
        for &(at, sigma, band) in &STILL_SHEEN {
            let e = s - at;
            amount += band * (-(e * e) / (2.0 * sigma * sigma)).exp();
        }
        amount
    });

    let [(_, _, _, c0), (_, _, _, c1)] = STILL_GLOWS;
    let reach = DISC_RADIUS + 2.0 / unit;
    for y in 0..h {
        let py = (y as f64 + 0.5 - hf / 2.0) / unit;
        let near_y = py.abs() < reach;
        for x in 0..w {
            let t = tu[x] + tv[y];
            let low = t < 0.5;
            let f = if low { t * 2.0 } else { t * 2.0 - 1.0 };
            let vignette = 1.0 - (STILL_VIGNETTE * (vu[x] + vv[y])) / 2.0;
            let e0 = glow_x[0][x] * glow_y[0][y];
            let e1 = glow_x[1][x] * glow_y[1][y];
            let lift = sheen[x + y];
            let mut rgb = [0.0_f64; 3];
            for (c, value) in rgb.iter_mut().enumerate() {
                let base = if low {
                    STILL_TOP_LEFT[c] + (STILL_MIDDLE[c] - STILL_TOP_LEFT[c]) * f
                } else {
                    STILL_MIDDLE[c] + (STILL_BOTTOM_RIGHT[c] - STILL_MIDDLE[c]) * f
                } * vignette;
                let glowed = base + c0[c] * e0 + c1[c] * e1;
                *value = glowed + (255.0 - glowed) * lift;
            }

            let px = (x as f64 + 0.5 - wf / 2.0) / unit;
            if near_y && px.abs() < reach {
                let d = (px * px + py * py).sqrt();
                let top = clamp01(0.5 - py / (2.0 * DISC_RADIUS));
                let inside = clamp01(0.5 - (d - DISC_RADIUS) * unit);
                let rim = clamp01(0.5 - ((d - DISC_RADIUS).abs() - DISC_RIM / 2.0) * unit);
                let slash = segment_distance(px, py, -SLASH_X, -SLASH_Y, SLASH_X, SLASH_Y);
                let gap = clamp01((slash - EYE_STROKE / 2.0 - SLASH_GAP) * unit + 0.5);
                let eye = clamp01(0.5 - (eye_distance(px, py).abs() - EYE_STROKE / 2.0) * unit);
                let pupil = clamp01(0.5 - ((d - PUPIL_RADIUS).abs() - EYE_STROKE / 2.0) * unit);
                let bar = clamp01(0.5 - (slash - EYE_STROKE / 2.0) * unit);
                let icon = (eye.max(pupil) * gap).max(bar);
                for amount in [
                    (DISC_FILL + DISC_FILL_TOP * top) * inside,
                    (DISC_RIM_BASE + DISC_RIM_TOP * top) * rim,
                    ICON_AMOUNT * icon,
                ] {
                    for value in &mut rgb {
                        *value += (255.0 - *value) * amount;
                    }
                }
            }

            let dither = (f64::from(STILL_BAYER[(y & 3) * 4 + (x & 3)]) + 0.5) / 16.0 - 0.5;
            let level = |value: f64| (value + 0.5 + dither).floor().clamp(0.0, 255.0) as u8;
            let o = (y * w + x) * 4;
            out[o] = level(rgb[2]);
            out[o + 1] = level(rgb[1]);
            out[o + 2] = level(rgb[0]);
            out[o + 3] = 0xff;
        }
    }
    out
}

/// The last still built, by size: a hide repeats the size it hid last time,
/// so it costs a copy, not a render, under the capture's lock.
static HIDDEN_STILL_CACHE: StdMutex<Option<CachedStill>> = StdMutex::new(None);

/// A built still: its width, height and pixels.
type CachedStill = (u32, u32, std::sync::Arc<Vec<u8>>);

/// The still every capture path publishes while the screen is hidden, at the
/// frame's own size (tight BGRA rows, opaque). It never reads the frame.
pub fn hidden_still_bgra(width: u32, height: u32) -> Vec<u8> {
    let mut cache = HIDDEN_STILL_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((w, h, still)) = cache.as_ref()
        && (*w, *h) == (width, height)
    {
        return still.as_ref().clone();
    }
    let still = std::sync::Arc::new(hidden_still_pixels(width, height));
    *cache = Some((width, height, std::sync::Arc::clone(&still)));
    still.as_ref().clone()
}

// ---------------------------------------------------------------------------
// macOS: the still as an IOSurface, so the Metal path keeps zero-copy import
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub mod macos {
    use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFType};
    use objc2_core_video::kCVPixelFormatType_32BGRA;
    use objc2_io_surface::{
        IOSurfaceLockOptions, IOSurfaceRef, kIOSurfaceAllocSize, kIOSurfaceBytesPerElement,
        kIOSurfaceBytesPerRow, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
    };

    use crate::frame_store::RetainedIoSurface;

    /// A new BGRA IOSurface holding `bgra` (tight rows). The compositor
    /// imports it exactly like a ScreenCaptureKit surface.
    pub fn create_bgra_iosurface(
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Option<RetainedIoSurface> {
        let (w, h) = (width as usize, height as usize);
        let tight_row = w.checked_mul(4)?;
        if w == 0 || h == 0 || bgra.len() < tight_row.checked_mul(h)? {
            return None;
        }
        // SAFETY: reading extern property-key statics.
        let (key_width, key_height, key_bpe, key_bpr, key_format, key_alloc) = unsafe {
            (
                kIOSurfaceWidth,
                kIOSurfaceHeight,
                kIOSurfaceBytesPerElement,
                kIOSurfaceBytesPerRow,
                kIOSurfacePixelFormat,
                kIOSurfaceAllocSize,
            )
        };
        let bytes_per_row = IOSurfaceRef::align_property(key_bpr, tight_row);
        let alloc_size = IOSurfaceRef::align_property(key_alloc, bytes_per_row.checked_mul(h)?);
        let width_number = CFNumber::new_i64(w as i64);
        let height_number = CFNumber::new_i64(h as i64);
        let bpe_number = CFNumber::new_i64(4);
        let bpr_number = CFNumber::new_i64(bytes_per_row as i64);
        let format_number = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
        let alloc_number = CFNumber::new_i64(alloc_size as i64);
        let properties = CFDictionary::<CFType, CFType>::from_slices(
            &[
                key_width.as_ref(),
                key_height.as_ref(),
                key_bpe.as_ref(),
                key_bpr.as_ref(),
                key_format.as_ref(),
                key_alloc.as_ref(),
            ],
            &[
                width_number.as_ref(),
                height_number.as_ref(),
                bpe_number.as_ref(),
                bpr_number.as_ref(),
                format_number.as_ref(),
                alloc_number.as_ref(),
            ],
        );
        // SAFETY: a well-formed property dictionary; the result is retained.
        let surface: CFRetained<IOSurfaceRef> =
            unsafe { IOSurfaceRef::new(properties.as_opaque()) }?;
        // SAFETY: lock for writing, copy rows at the surface's own pitch, unlock.
        unsafe {
            if surface.lock(IOSurfaceLockOptions::empty(), std::ptr::null_mut()) != 0 {
                return None;
            }
            let pitch = surface.bytes_per_row();
            let base = surface.base_address().as_ptr().cast::<u8>();
            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    bgra.as_ptr().add(row * tight_row),
                    base.add(row * pitch),
                    tight_row,
                );
            }
            surface.unlock(IOSurfaceLockOptions::empty(), std::ptr::null_mut());
        }
        Some(RetainedIoSurface::new(surface))
    }

    /// The BGRA pixels of a surface, tight rows (the round-trip test's reader).
    #[cfg(test)]
    pub fn read_bgra_from_iosurface(
        surface: &RetainedIoSurface,
        width: u32,
        height: u32,
    ) -> Option<Vec<u8>> {
        let (w, h) = (width as usize, height as usize);
        let tight_row = w.checked_mul(4)?;
        let surface = surface.surface();
        if w == 0 || h == 0 || surface.width() < w || surface.height() < h {
            return None;
        }
        let mut out = vec![0_u8; tight_row * h];
        // SAFETY: a read-only lock around a bounded row copy.
        unsafe {
            if surface.lock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut()) != 0 {
                return None;
            }
            let pitch = surface.bytes_per_row();
            let base = surface.base_address().as_ptr().cast::<u8>();
            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    base.add(row * pitch),
                    out.as_mut_ptr().add(row * tight_row),
                    tight_row,
                );
            }
            surface.unlock(IOSurfaceLockOptions::ReadOnly, std::ptr::null_mut());
        }
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// Windows: the still as a D3D11 texture, on the capture texture's own device
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub mod d3d11 {
    use anyhow::{Context, Result, ensure};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    use crate::frame_store::RetainedD3D11Texture;

    /// A new default-usage BGRA8 texture holding `bgra` (tight rows), on the
    /// same device and adapter as `like`, bindable as a shader resource and a
    /// render target like a WGC frame.
    pub fn create_bgra_texture(
        like: &RetainedD3D11Texture,
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> Result<RetainedD3D11Texture> {
        ensure!(width > 0 && height > 0, "the still has no pixels");
        ensure!(
            bgra.len() >= width as usize * height as usize * 4,
            "the still's buffer is short"
        );
        // SAFETY: the device that owns the capture texture.
        let device: ID3D11Device = unsafe { like.texture().GetDevice() }?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET).0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: bgra.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        // SAFETY: `bgra` outlives the call; D3D11 copies the initial data.
        unsafe { device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture)) }
            .context("could not create the Hide screen still texture")?;
        let texture = texture.context("D3D11 returned no still texture")?;
        Ok(RetainedD3D11Texture::new(
            std::sync::Arc::new(texture),
            like.adapter_luid(),
        ))
    }

    /// The hidden still at a capture texture's size, as a texture on its
    /// device plus the still's pixels. The texture's pixels are never read.
    pub fn still_texture(
        texture: &RetainedD3D11Texture,
    ) -> Result<(u32, u32, RetainedD3D11Texture, Vec<u8>)> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: querying a live COM texture.
        unsafe { texture.texture().GetDesc(&mut desc) };
        ensure!(
            desc.Width > 0 && desc.Height > 0,
            "the screen texture is empty"
        );
        let still = super::hidden_still_bgra(desc.Width, desc.Height);
        let made = create_bgra_texture(texture, desc.Width, desc.Height, &still)?;
        Ok((desc.Width, desc.Height, made, still))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The smokes call a frame hidden when it has almost no neighbouring pixel
    /// pairs that jump by more than 200 summed over R, G and B
    /// (`SHARP_EDGE_THRESHOLD`); every pair in the still stays under this.
    const HIDDEN_STILL_EDGE_MAX: u32 = 190;

    fn gate() -> ScreenPrivacyGate {
        ScreenPrivacyGate::default()
    }

    #[test]
    fn gate_starts_visible_with_an_empty_snapshot() {
        let gate = gate();
        assert_eq!(
            gate.view(),
            ScreenPrivacyView {
                hidden: false,
                span: 0,
                shown_at: None,
            }
        );
        assert_eq!(gate.snapshot(), ScreenPrivacy::default());
    }

    #[test]
    fn hide_bumps_the_span_once_and_show_keeps_it() {
        let gate = gate();
        let hidden = gate.hide(ScreenPrivacyReason::You, "2026-10-28T10:00:00+00:00".into());
        assert!(hidden.hidden);
        assert_eq!(hidden.reason, Some(ScreenPrivacyReason::You));
        assert_eq!(hidden.since.as_deref(), Some("2026-10-28T10:00:00+00:00"));
        assert_eq!(gate.view().span, 1);
        // A second hide while hidden is not a new edge: the still stays.
        let again = gate.hide(
            ScreenPrivacyReason::PasswordManager,
            "2026-10-28T10:00:05+00:00".into(),
        );
        assert_eq!(gate.view().span, 1);
        assert_eq!(
            again.reason,
            Some(ScreenPrivacyReason::You),
            "you outrank the list"
        );
        assert_eq!(again.since.as_deref(), Some("2026-10-28T10:00:00+00:00"));
        let shown = gate.show();
        assert_eq!(
            shown,
            ScreenPrivacy {
                generation: 2,
                ..ScreenPrivacy::default()
            }
        );
        assert_eq!(hidden.generation, 1);
        assert_eq!(again.generation, 1);
        assert_eq!(gate.view().span, 1);
        gate.hide(ScreenPrivacyReason::PasswordManager, "t".into());
        assert_eq!(gate.view().span, 2);
        // The streamer's own hide outranks a password-manager hide.
        let upgraded = gate.hide(ScreenPrivacyReason::You, "later".into());
        assert_eq!(upgraded.generation, 3);
        assert_eq!(upgraded.reason, Some(ScreenPrivacyReason::You));
        assert_eq!(upgraded.since.as_deref(), Some("t"));
    }

    #[test]
    fn admission_frosts_once_per_span_and_holds_the_rest() {
        let gate = gate();
        let mut cursor = ScreenPrivacyCursor::default();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Publish
        );
        gate.hide(ScreenPrivacyReason::You, "t".into());
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Frost
        );
        for _ in 0..3 {
            assert_eq!(
                admit_screen_frame(gate.view(), &mut cursor),
                ScreenFrameAdmission::Hold
            );
        }
        // A source started while hidden has a fresh cursor: it frosts first.
        let mut fresh = ScreenPrivacyCursor::default();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut fresh),
            ScreenFrameAdmission::Frost
        );
        assert_eq!(
            admit_screen_frame(gate.view(), &mut fresh),
            ScreenFrameAdmission::Hold
        );
        gate.show();
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Publish
        );
        // Hide again: a new span, one new still.
        gate.hide(ScreenPrivacyReason::PasswordManager, "t2".into());
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Frost
        );
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Hold
        );
    }

    /// The Show edge fails closed: a frame taken while hidden, handed over
    /// after the Show, never publishes; one taken after the Show does.
    #[test]
    fn a_frame_captured_before_the_show_holds_after_it() {
        let gate = gate();
        let mut cursor = ScreenPrivacyCursor::default();
        let before_hide = Instant::now();
        assert_eq!(gate.view().shown_at, None);
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(before_hide)
            ),
            ScreenFrameAdmission::Publish,
            "never hidden: nothing is held back"
        );
        gate.hide(ScreenPrivacyReason::You, "t".into());
        // Taken before the hide edge, handed over after it: held.
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(before_hide)
            ),
            ScreenFrameAdmission::Frost
        );
        let while_hidden = Instant::now();
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(while_hidden)
            ),
            ScreenFrameAdmission::Hold
        );
        std::thread::sleep(Duration::from_millis(2));
        gate.show();
        let shown_at = gate.view().shown_at.expect("the show is dated");
        assert!(shown_at > while_hidden);
        // Handed over after the show, taken before it: still held.
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(while_hidden)
            ),
            ScreenFrameAdmission::Hold,
            "a frame of the hidden span published after the show"
        );
        // Dated at the Show's own clock reading: it cannot be proven to come
        // after the Show, so it holds (the covered frame wins).
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(shown_at)
            ),
            ScreenFrameAdmission::Hold,
            "a frame dated at the show itself published"
        );
        // Any later reading is after the Show: it publishes.
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(shown_at + Duration::from_nanos(1))
            ),
            ScreenFrameAdmission::Publish
        );
        // A publish point that cannot date its frames publishes after Show.
        assert_eq!(
            admit_screen_frame(gate.view(), &mut cursor),
            ScreenFrameAdmission::Publish
        );
        // A second show is dated again; the first one never comes back.
        gate.hide(ScreenPrivacyReason::You, "t2".into());
        std::thread::sleep(Duration::from_millis(2));
        gate.show();
        assert!(gate.view().shown_at.unwrap() > shown_at);
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                ScreenFrameTime::Captured(shown_at)
            ),
            ScreenFrameAdmission::Hold
        );
    }

    /// Plan 210 D8 for a capture that doesn't date its frames (Linux
    /// PipeWire, the Windows FFmpeg pipe): a delivery that began before the
    /// Show holds, and so does the first one after it, once per Show, since a
    /// frame taken before the Show may be queued behind the one in flight.
    #[test]
    fn an_undated_capture_holds_its_first_delivery_after_each_show() {
        let gate = gate();
        let mut cursor = ScreenPrivacyCursor::default();
        let delivered = |at| ScreenFrameTime::DeliveredFrom(at);
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
            ScreenFrameAdmission::Publish,
            "never hidden: nothing is held back"
        );
        gate.hide(ScreenPrivacyReason::You, "t".into());
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
            ScreenFrameAdmission::Frost
        );
        let in_flight = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        gate.show();
        let shown_at = gate.view().shown_at.unwrap();
        // The frame being read when the Show landed: held, and it does not
        // count as the first delivery after the Show.
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(in_flight)),
            ScreenFrameAdmission::Hold
        );
        // A delivery that began at the Show's own clock reading is not after
        // it: held, and it is not the first delivery after the Show either.
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(shown_at)),
            ScreenFrameAdmission::Hold,
            "a delivery that began at the show itself published"
        );
        // The first delivery that began after the Show: still held.
        assert_eq!(
            admit_screen_frame_at(
                gate.view(),
                &mut cursor,
                delivered(shown_at + Duration::from_nanos(1))
            ),
            ScreenFrameAdmission::Hold,
            "a frame queued before the show was published as live"
        );
        // The next one is trusted, and so is every later one.
        for _ in 0..3 {
            assert_eq!(
                admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
                ScreenFrameAdmission::Publish
            );
        }
        // A new hide and show: the first delivery after it holds again.
        gate.hide(ScreenPrivacyReason::You, "t2".into());
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
            ScreenFrameAdmission::Frost
        );
        std::thread::sleep(Duration::from_millis(2));
        gate.show();
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
            ScreenFrameAdmission::Hold
        );
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut cursor, delivered(Instant::now())),
            ScreenFrameAdmission::Publish
        );
        // A capture started after the show never covered a hide: it
        // publishes from its first frame.
        let mut fresh = ScreenPrivacyCursor::default();
        assert_eq!(
            admit_screen_frame_at(gate.view(), &mut fresh, delivered(Instant::now())),
            ScreenFrameAdmission::Publish
        );
    }

    /// Windows capture times: a counter reading becomes an `Instant` through
    /// one simultaneous reading of both clocks (QPC at 10 MHz, and WGC's
    /// 100 ns units of it).
    #[test]
    fn a_counter_reading_is_dated_on_the_instant_clock() {
        let now = Instant::now();
        let frequency = 10_000_000;
        let now_ticks = 987_654_321_000;
        // 16.7 ms before now.
        let at = instant_for_counter(now_ticks - 167_000, frequency, now_ticks, now).unwrap();
        assert_eq!(now - at, Duration::from_micros(16_700));
        // The same instant on another rate (a 24 MHz counter).
        let at = instant_for_counter(24_000_000 - 2_400, 24_000_000, 24_000_000, now).unwrap();
        assert_eq!(now - at, Duration::from_micros(100));
        // A reading a hair ahead of now is believed; far ahead is not.
        assert_eq!(
            instant_for_counter(now_ticks + 10_000, frequency, now_ticks, now),
            Some(now + Duration::from_millis(1))
        );
        assert_eq!(
            instant_for_counter(now_ticks + 1_000_000, frequency, now_ticks, now),
            None
        );
        // Nonsense readings are undated, never "now".
        assert_eq!(instant_for_counter(0, frequency, now_ticks, now), None);
        assert_eq!(instant_for_counter(-5, frequency, now_ticks, now), None);
        assert_eq!(instant_for_counter(5, 0, now_ticks, now), None);
    }

    /// W79, Linux portal frames: a `SPA_META_Header` pts in nanoseconds of
    /// `CLOCK_MONOTONIC` becomes the frame's capture time, never later than
    /// its delivery, and a pts that can't be the capture time is undated.
    #[test]
    fn a_portal_pts_is_dated_on_the_instant_clock() {
        let now = Instant::now();
        let now_nanos = 5_000_000_000_000; // 5,000 s of uptime
        let delivered_at = now - Duration::from_millis(2);
        // Taken 18 ms before now, 16 ms before its delivery.
        let at = instant_for_monotonic_pts(now_nanos - 18_000_000, now_nanos, now, delivered_at)
            .unwrap();
        assert_eq!(now - at, Duration::from_millis(18));
        assert_eq!(delivered_at - at, Duration::from_millis(16));
        // A pts a hair after the delivery (the two clock readings) is the
        // delivery itself; further after it is undated.
        let at = instant_for_monotonic_pts(now_nanos - 1_000_000, now_nanos, now, delivered_at);
        assert_eq!(at, Some(delivered_at));
        assert_eq!(
            instant_for_monotonic_pts(now_nanos + 50_000_000, now_nanos, now, delivered_at),
            None
        );
        // Older than a second at its delivery: some other clock (a
        // stream-relative counter), not a capture time.
        assert_eq!(
            instant_for_monotonic_pts(now_nanos - 1_500_000_000, now_nanos, now, delivered_at),
            None
        );
        assert_eq!(
            instant_for_monotonic_pts(33_333_333, now_nanos, now, delivered_at),
            None
        );
        // A wall-clock pts (Unix epoch nanoseconds) is far in the future.
        assert_eq!(
            instant_for_monotonic_pts(1_795_000_000_000_000_000, now_nanos, now, delivered_at),
            None
        );
        // Zero and negative (no pts) are undated.
        assert_eq!(
            instant_for_monotonic_pts(0, now_nanos, now, delivered_at),
            None
        );
        assert_eq!(
            instant_for_monotonic_pts(-1, now_nanos, now, delivered_at),
            None
        );
    }

    /// On Linux `CLOCK_MONOTONIC` really is `Instant`'s clock: a pts read
    /// from it 20 ms before a delivery lands 20 ms before it.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_monotonic_pts_lands_on_the_instant_clock() {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: a valid out pointer for clock_gettime.
        assert_eq!(
            unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) },
            0
        );
        let taken = Instant::now();
        let pts = ts.tv_sec * 1_000_000_000 + ts.tv_nsec;
        std::thread::sleep(Duration::from_millis(20));
        let delivered_at = Instant::now();
        let at = linux_clock::instant_for_pts(pts, delivered_at).unwrap();
        let error = if at > taken { at - taken } else { taken - at };
        assert!(error < Duration::from_millis(2), "{error:?}");
        assert!(delivered_at - at >= Duration::from_millis(19));
    }

    /// On Windows the counter really is `Instant`'s clock: a QPC reading and
    /// a `SystemRelativeTime` of "now" land within a few milliseconds of
    /// `Instant::now()`, and one from 50 ms ago lands 50 ms back.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_capture_times_land_on_the_instant_clock() {
        use windows::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };
        let mut frequency = 0_i64;
        // SAFETY: a valid out pointer.
        unsafe { QueryPerformanceFrequency(&mut frequency) }.unwrap();
        let mut ticks = 0_i64;
        // SAFETY: a valid out pointer.
        unsafe { QueryPerformanceCounter(&mut ticks) }.unwrap();
        let before = Instant::now();
        let fifty_ms = frequency / 20;
        let qpc = windows_clock::instant_for_qpc(ticks - fifty_ms).unwrap();
        let back = before.saturating_duration_since(qpc);
        assert!(
            back >= Duration::from_millis(45) && back <= Duration::from_millis(80),
            "a QPC reading 50 ms old landed {back:?} back"
        );
        let system_relative =
            i64::try_from(i128::from(ticks - fifty_ms) * 10_000_000 / i128::from(frequency))
                .unwrap();
        let wgc = windows_clock::instant_for_system_relative_100ns(system_relative).unwrap();
        let back = before.saturating_duration_since(wgc);
        assert!(
            back >= Duration::from_millis(45) && back <= Duration::from_millis(80),
            "a SystemRelativeTime 50 ms old landed {back:?} back"
        );
    }

    /// The largest R+G+B jump between neighbouring pixels.
    fn max_edge(bgra: &[u8], w: usize, h: usize) -> u32 {
        let jump = |a: usize, b: usize| -> u32 {
            (0..3)
                .map(|c| u32::from(bgra[a + c].abs_diff(bgra[b + c])))
                .sum()
        };
        let mut max = 0;
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 4;
                if x + 1 < w {
                    max = max.max(jump(o, o + 4));
                }
                if y + 1 < h {
                    max = max.max(jump(o, o + w * 4));
                }
            }
        }
        max
    }

    #[test]
    fn the_hidden_still_is_opaque_at_the_frames_size_and_soft() {
        for (w, h) in [
            (1920, 1080),
            (1080, 1920),
            (3840, 2160),
            (640, 360),
            (97, 55),
            (3, 2),
        ] {
            let still = hidden_still_pixels(w, h);
            assert_eq!(still.len(), (w * h * 4) as usize, "{w}x{h}");
            assert!(
                still.chunks_exact(4).all(|px| px[3] == 0xff),
                "{w}x{h} opaque"
            );
            // The smokes read a frame with hard edges as the live screen.
            let edge = max_edge(&still, w as usize, h as usize);
            assert!(edge <= HIDDEN_STILL_EDGE_MAX, "{w}x{h}: an edge of {edge}");
        }
        assert!(hidden_still_pixels(0, 4).is_empty());
        assert!(hidden_still_bgra(4, 0).is_empty());
    }

    #[test]
    fn the_hidden_still_is_designed_not_flat() {
        let (w, h) = (640_usize, 360_usize);
        let still = hidden_still_pixels(w as u32, h as u32);
        let at = |x: usize, y: usize| {
            let o = (y * w + x) * 4;
            [still[o + 2], still[o + 1], still[o]]
        };
        // A cool top left, a violet bottom right, a lighter glass disc with
        // the eye in the middle.
        let top_left = at(40, 30);
        let bottom_right = at(600, 330);
        assert!(
            top_left[2] > top_left[0] + 30,
            "blue at the top left: {top_left:?}"
        );
        assert!(
            bottom_right[0] > bottom_right[1],
            "violet at the bottom right: {bottom_right:?}"
        );
        let disc = at(320, 180 + 30);
        let outside = at(320, 180 + 60);
        assert!(
            disc.iter().zip(outside).all(|(a, b)| *a > b),
            "{disc:?} vs {outside:?}"
        );
        // Not the old grey, anywhere.
        assert!(
            still
                .chunks_exact(4)
                .all(|px| px[..3].iter().any(|c| c.abs_diff(0x80) > 6))
        );
    }

    #[test]
    fn the_hidden_still_is_cached_by_size() {
        let a = hidden_still_bgra(97, 55);
        let b = hidden_still_bgra(55, 97);
        assert_eq!(a, hidden_still_pixels(97, 55));
        assert_eq!(b, hidden_still_pixels(55, 97));
        assert_eq!(hidden_still_bgra(97, 55), a);
    }

    /// The renderer's and the web's stills match this one: the shared fixture.
    #[test]
    fn the_hidden_still_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/hidden-screen-still.json"
        ))
        .expect("protocol-fixtures/hidden-screen-still.json is valid JSON");
        let level = fixture["tolerance"]["level"].as_i64().unwrap();
        let mean_tolerance = fixture["tolerance"]["mean"].as_f64().unwrap();
        for one in fixture["stills"].as_array().unwrap() {
            let w = one["width"].as_u64().unwrap() as usize;
            let h = one["height"].as_u64().unwrap() as usize;
            let still = hidden_still_pixels(w as u32, h as u32);
            for sample in one["samples"].as_array().unwrap() {
                let v: Vec<i64> = sample
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_i64().unwrap())
                    .collect();
                let o = (v[1] as usize * w + v[0] as usize) * 4;
                let got = [still[o + 2], still[o + 1], still[o]];
                for c in 0..3 {
                    assert!(
                        (i64::from(got[c]) - v[2 + c]).abs() <= level,
                        "{w}x{h} at ({}, {}): {got:?} vs {:?}",
                        v[0],
                        v[1],
                        &v[2..]
                    );
                }
            }
            let mut sum = [0_u64; 3];
            for px in still.chunks_exact(4) {
                sum[0] += u64::from(px[2]);
                sum[1] += u64::from(px[1]);
                sum[2] += u64::from(px[0]);
            }
            for c in 0..3 {
                let mean = sum[c] as f64 / (w * h) as f64;
                let want = one["mean"][c].as_f64().unwrap();
                assert!(
                    (mean - want).abs() <= mean_tolerance,
                    "{w}x{h} channel {c}: {mean} vs {want}"
                );
            }
        }
    }

    /// The shared wire fixture: absent fields are omitted, never `null`, and
    /// the renderer's contract test reads the same file.
    #[test]
    fn screen_privacy_fixture_matches_the_backend_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/screen-privacy.json"
        ))
        .expect("protocol-fixtures/screen-privacy.json is valid JSON");
        let visible = serde_json::to_value(ScreenPrivacy::default()).unwrap();
        assert_eq!(visible, fixture["visible"]);
        assert_eq!(
            visible.to_string(),
            r#"{"generation":0,"hidden":false}"#,
            "no null fields"
        );
        let gate = gate();
        let by_you = gate.hide(ScreenPrivacyReason::You, "2026-10-28T10:15:00+00:00".into());
        assert_eq!(
            serde_json::to_value(&by_you).unwrap(),
            fixture["hiddenByYou"]
        );
        gate.show();
        let by_list = gate.hide(
            ScreenPrivacyReason::PasswordManager,
            "2026-10-28T10:16:30+00:00".into(),
        );
        assert_eq!(
            serde_json::to_value(&by_list).unwrap(),
            fixture["hiddenByPasswordManager"]
        );
        let unavailable = ScreenPrivacy {
            unavailable: Some(SCREEN_HIDE_UNAVAILABLE_LEGACY.to_string()),
            ..ScreenPrivacy::default()
        };
        assert_eq!(
            serde_json::to_value(&unavailable).unwrap(),
            fixture["unavailableOnLegacySession"]
        );
        let params: crate::protocol::ScreenHideParams =
            serde_json::from_value(fixture["hideParams"].clone()).unwrap();
        assert_eq!(params.reason, ScreenPrivacyReason::PasswordManager);
        assert!(
            serde_json::from_value::<crate::protocol::ScreenHideParams>(
                serde_json::json!({ "reason": "someone-else" })
            )
            .is_err()
        );
        // Round trip through the wire shape.
        for value in [
            &visible,
            &fixture["hiddenByYou"],
            &fixture["hiddenByPasswordManager"],
        ] {
            let parsed: ScreenPrivacy = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(&serde_json::to_value(&parsed).unwrap(), value);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn frosted_iosurface_round_trips_its_pixels() {
        let (w, h) = (70_u32, 30_u32);
        let mut bgra = vec![0_u8; (w * h * 4) as usize];
        for (i, px) in bgra.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 251) as u8;
            px[1] = (i % 241) as u8;
            px[2] = (i % 239) as u8;
            px[3] = 0xff;
        }
        let surface = macos::create_bgra_iosurface(w, h, &bgra).expect("an IOSurface");
        assert_eq!(surface.surface().width(), w as usize);
        assert_eq!(surface.surface().height(), h as usize);
        assert!(surface.surface().bytes_per_row() >= (w * 4) as usize);
        let back = macos::read_bgra_from_iosurface(&surface, w, h).expect("readback");
        assert_eq!(back, bgra);
        assert!(macos::create_bgra_iosurface(0, 4, &bgra).is_none());
        assert!(macos::create_bgra_iosurface(w, h, &bgra[..8]).is_none());
    }
}
