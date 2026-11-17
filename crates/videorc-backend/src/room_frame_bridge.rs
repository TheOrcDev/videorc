//! Plan 249 S13a: disabled native camera-role frame/clock test source.
//!
//! No device, compositor, recording or preview surface is touched. A debug
//! build with smoke RPC opt-in renders a synthetic packed color+alpha frame
//! (`rgb-left-alpha-right`, 8 px gutter: the S10 packing) carrying a sequence
//! stamp, a once-per-second flash and solid/half/transparent alpha patches.
//!
//! Ownership is bounded: at most `LEASE_SLOTS` frames of one generation are
//! leased to the client at a time. A pull may release one lease of the current
//! surface epoch; `reset` (a GPU/surface loss) bumps the epoch and revokes
//! every outstanding lease, so a late release cannot free a newer frame. The
//! source, its leases and their counters are connection-owned: dropping the
//! socket drops them. Every replacement or reconnect opens a new generation.
//!
//! Clock: `ptsUs` is the frame's capture time relative to the generation's
//! epoch; `observedAtUs` is the actual native pull time relative to that same
//! epoch; `originUs` is the epoch measured from the process anchor in
//! `room_clock` (absent, never zero, when unavailable) and `incarnation`
//! names the backend process the origin belongs to.
//!
//! Plan 249 S13b adds the processed camera role (`host-camera`): frames come
//! from the native camera owner after the compositor's own camera-source
//! processing (key, speck cleanup, despill, look; never scene geometry), at a
//! logical size fitted to the source aspect within the S10 limits. The camera
//! frame store keeps no per-frame capture time, so these frames carry
//! `PTS_OBSERVED`: `ptsUs` is when the native side first observed the camera
//! frame, an upper bound on capture time, never presented as capture time. A
//! camera generation change (device switch, restart) refuses the bridge
//! generation; the client opens a new one.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

pub const ROLE: &str = "host-camera-test";
pub const PROCESSED_ROLE: &str = "host-camera";
/// Header flags: bit 0 packed alpha; bit 1 `ptsUs` is native observation time.
pub const FLAG_PACKED: u16 = 1;
pub const FLAG_PTS_OBSERVED: u16 = 2;
/// S10 logical limits (mirrors `alphaDimensions` in `shared/cloud-alpha.ts`).
pub const MAX_LOGICAL_SIDE: u32 = 640;
pub const MIN_LOGICAL_SIDE: u32 = 64;
pub const MAX_LOGICAL_PIXELS: u32 = 640 * 360;
pub const PACKING: &str = "rgb-left-alpha-right";
pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 360;
pub const GUTTER: u32 = 8;
pub const PACKED_WIDTH: u32 = WIDTH * 2 + GUTTER;
pub const FPS: u64 = 30;
pub const LEASE_SLOTS: usize = 2;
pub const HEADER_BYTES: usize = 96;
pub const MAGIC: u32 = u32::from_le_bytes(*b"VRCF");
pub const STAMP_ROWS: u32 = 12;
pub const STAMP_BITS: u32 = 32;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ABSENT: u64 = u64::MAX;

static ACTIVE_SOURCES: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_LEASES: AtomicUsize = AtomicUsize::new(0);

pub fn active_sources() -> usize {
    ACTIVE_SOURCES.load(Ordering::SeqCst)
}
pub fn active_leases() -> usize {
    ACTIVE_LEASES.load(Ordering::SeqCst)
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    sequence: u64,
    surface_epoch: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub action: String,
    pub generation: u64,
    role: String,
    width: u32,
    height: u32,
    fps: u32,
    packing: String,
    serial: u32,
    #[serde(default)]
    release: Option<Release>,
}

impl Command {
    /// True for the processed camera role (`host-camera`).
    pub fn is_processed(&self) -> bool {
        self.role == PROCESSED_ROLE
    }
    /// The logical size this command names.
    pub fn logical(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    generation: u64,
    surface_epoch: u32,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reset {
    generation: u64,
    surface_epoch: u32,
    revoked_leases: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Idle {
    frame: Option<()>,
    reason: &'static str,
    stale_releases: u64,
    lease_stalls: u64,
}

/// One processed camera-role frame: logical straight-alpha RGBA, full source
/// (no crop, mirror or mask), and the camera generation/sequence it came from.
#[derive(Debug, Clone)]
pub struct ProcessedFrame {
    pub camera_generation: u64,
    pub camera_sequence: u64,
    pub observed_at: Instant,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug)]
pub enum Reply {
    Opened(Opened),
    Reset(Reset),
    Idle(Idle),
    Frame(Vec<u8>),
    Closed,
}

#[derive(Default)]
pub struct Bridge {
    last_generation: u64,
    active: Option<Source>,
}

struct Source {
    generation: u64,
    start: Instant,
    /// Logical (unpacked) size of every frame of this generation.
    logical: (u32, u32),
    /// `Some` for the processed camera role: the camera generation bound at
    /// the first frame and the last camera sequence delivered.
    processed: Option<ProcessedState>,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    surface_epoch: u32,
    next: u64,
    dropped: u64,
    stale_releases: u64,
    lease_stalls: u64,
    leases: [Option<(u64, u32)>; LEASE_SLOTS],
}

#[derive(Default)]
struct ProcessedState {
    camera_generation: Option<u64>,
    last_camera_sequence: Option<u64>,
}

impl Source {
    fn revoke_all(&mut self) -> u32 {
        let mut revoked = 0;
        for slot in self.leases.iter_mut() {
            if slot.take().is_some() {
                ACTIVE_LEASES.fetch_sub(1, Ordering::SeqCst);
                revoked += 1;
            }
        }
        revoked
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        self.revoke_all();
        ACTIVE_SOURCES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 24-bit sequence plus an 8-bit check, least significant bit first.
pub fn stamp_bits(sequence: u64) -> [bool; STAMP_BITS as usize] {
    let n = (sequence % 0x100_0000) as u32;
    let check = ((n >> 16) ^ (n >> 8) ^ n) & 255;
    let mut bits = [false; STAMP_BITS as usize];
    for (i, bit) in bits.iter_mut().enumerate() {
        *bit = if i < 24 {
            (n >> i) & 1 == 1
        } else {
            (check >> (i - 24)) & 1 == 1
        };
    }
    bits
}

/// S10's logical-dimension rule: even sides 64..=640, at most 640x360 pixels.
pub fn alpha_dimensions(width: u32, height: u32) -> bool {
    width.is_multiple_of(2)
        && height.is_multiple_of(2)
        && (MIN_LOGICAL_SIDE..=MAX_LOGICAL_SIDE).contains(&width)
        && (MIN_LOGICAL_SIDE..=MAX_LOGICAL_SIDE).contains(&height)
        && width * height <= MAX_LOGICAL_PIXELS
}

/// The largest even logical size with the source's aspect within the S10
/// limits. The whole source is kept (never cropped); only scaled down.
pub fn logical_size_for(source_width: u32, source_height: u32) -> Option<(u32, u32)> {
    if source_width == 0 || source_height == 0 {
        return None;
    }
    let (w, h) = (f64::from(source_width), f64::from(source_height));
    let scale = (f64::from(MAX_LOGICAL_SIDE) / w)
        .min(f64::from(MAX_LOGICAL_SIDE) / h)
        .min((f64::from(MAX_LOGICAL_PIXELS) / (w * h)).sqrt())
        .min(1.0);
    // A tiny epsilon keeps 1920 x (640 / 1920) from flooring to 638.
    let even = |value: f64| (((value + 1e-6) / 2.0).floor() as u32) * 2;
    let size = (even(w * scale), even(h * scale));
    alpha_dimensions(size.0, size.1).then_some(size)
}

/// Debug fixture camera (S13b acceptance): a BGRA frame standing in for the
/// device only. Key-green ground; a warm subject with a green-spill fringe; a
/// grey look patch; a red mirror marker on the source's LEFT; a sequence stamp
/// in the bottom rows. Every zone is a fraction of the frame, so any source
/// size or aspect works.
pub fn fixture_camera_bgra(sequence: u64, width: u32, height: u32) -> Vec<u8> {
    let stamp = stamp_bits(sequence);
    let mut out = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let [r, g, b] = fixture_camera_rgb(x, y, width, height, &stamp);
            out.extend_from_slice(&[b, g, r, 255]);
        }
    }
    out
}

/// The fixture camera's RGB at one source pixel (shared with the harness
/// through `protocol-fixtures/room-camera.json`).
pub fn fixture_camera_rgb(x: u32, y: u32, width: u32, height: u32, stamp: &[bool; 32]) -> [u8; 3] {
    let (fx, fy) = (
        (f64::from(x) + 0.5) / f64::from(width),
        (f64::from(y) + 0.5) / f64::from(height),
    );
    if fy >= 0.94 {
        let cell = ((fx * 32.0) as usize).min(31);
        return if stamp[cell] {
            [255, 255, 255]
        } else {
            [0, 0, 0]
        };
    }
    if (0.05..0.20).contains(&fx) && (0.05..0.20).contains(&fy) {
        return [128, 128, 128];
    }
    if (0.30..0.70).contains(&fx) && (0.25..0.85).contains(&fy) {
        if (0.32..0.40).contains(&fx) && (0.70..0.80).contains(&fy) {
            return [220, 30, 30];
        }
        let edge = (fx - 0.30).min(0.70 - fx).min(fy - 0.25).min(0.85 - fy);
        return if edge < 0.03 {
            [150, 200, 110]
        } else {
            [200, 150, 120]
        };
    }
    [0, 255, 0]
}

pub fn pts_us(sequence: u64) -> u64 {
    sequence.saturating_mul(1_000_000) / FPS
}

/// The logical straight-alpha RGBA pixel the camera role carries. Shared with
/// `apps/desktop/src/shared/room-frame.ts` through `protocol-fixtures/room-frame.json`.
pub fn fixture_pixel(x: u32, y: u32, sequence: u64, stamp: &[bool; 32]) -> [u8; 4] {
    if y >= HEIGHT - STAMP_ROWS {
        let cell = (x * STAMP_BITS / WIDTH).min(STAMP_BITS - 1) as usize;
        let v = if stamp[cell] { 255 } else { 0 };
        return [v, v, v, 255];
    }
    if y < HEIGHT / 4 {
        return if x < WIDTH / 4 {
            [255, 0, 255, 255]
        } else if x < WIDTH / 2 {
            [0, 255, 0, 128]
        } else if x < WIDTH * 3 / 4 {
            [0, 0, 0, 0]
        } else if sequence.is_multiple_of(FPS) {
            [255, 255, 255, 255]
        } else {
            [0, 0, 0, 255]
        };
    }
    let bar = (sequence.wrapping_mul(8) % WIDTH as u64) as u32;
    if (x + WIDTH - bar) % WIDTH < 16 {
        [255, 255, 0, 255]
    } else {
        [64, 64, 64, 255]
    }
}

/// Packed opaque transport pixel: color left, gutter, alpha as gray right.
pub fn packed_pixel(px: u32, y: u32, sequence: u64, stamp: &[bool; 32]) -> [u8; 4] {
    if px < WIDTH {
        let [r, g, b, _] = fixture_pixel(px, y, sequence, stamp);
        [r, g, b, 255]
    } else if px < WIDTH + GUTTER {
        [0, 0, 0, 255]
    } else {
        let a = fixture_pixel(px - WIDTH - GUTTER, y, sequence, stamp)[3];
        [a, a, a, 255]
    }
}

struct Header {
    serial: u32,
    surface_epoch: u32,
    lease_slot: u32,
    generation: u64,
    sequence: u64,
    pts_us: u64,
    observed_at_us: u64,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    dropped_frames: u64,
    lease_stalls: u64,
}

fn encode_header(header: &Header, packed_width: u32, height: u32, flags: u16) -> Vec<u8> {
    let payload = (packed_width * height * 4) as usize;
    let mut out = Vec::with_capacity(HEADER_BYTES + payload);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    for v in [
        header.serial,
        packed_width,
        height,
        header.surface_epoch,
        header.lease_slot,
        0,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in [
        header.generation,
        header.sequence,
        header.pts_us,
        header.observed_at_us,
        header.origin_us.unwrap_or(ABSENT),
        header.incarnation.unwrap_or(0),
        header.dropped_frames,
        header.lease_stalls,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    debug_assert_eq!(out.len(), HEADER_BYTES);
    out
}

fn encode(header: &Header) -> Vec<u8> {
    let payload = (PACKED_WIDTH * HEIGHT * 4) as usize;
    let mut out = encode_header(header, PACKED_WIDTH, HEIGHT, FLAG_PACKED);
    let stamp = stamp_bits(header.sequence);
    for y in 0..HEIGHT {
        for px in 0..PACKED_WIDTH {
            out.extend_from_slice(&packed_pixel(px, y, header.sequence, &stamp));
        }
    }
    debug_assert_eq!(out.len(), HEADER_BYTES + payload);
    out
}

/// Pack logical straight-alpha RGBA: colour left (opaque), gutter, alpha as grey.
fn encode_processed(header: &Header, width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let packed_width = width * 2 + GUTTER;
    let mut out = encode_header(
        header,
        packed_width,
        height,
        FLAG_PACKED | FLAG_PTS_OBSERVED,
    );
    for y in 0..height as usize {
        let row = &rgba[y * width as usize * 4..(y + 1) * width as usize * 4];
        let (pixels, _) = row.as_chunks::<4>();
        for [r, g, b, _] in pixels {
            out.extend_from_slice(&[*r, *g, *b, 255]);
        }
        for _ in 0..GUTTER {
            out.extend_from_slice(&[0, 0, 0, 255]);
        }
        for [_, _, _, a] in pixels {
            out.extend_from_slice(&[*a, *a, *a, 255]);
        }
    }
    debug_assert_eq!(
        out.len(),
        HEADER_BYTES + (packed_width * height * 4) as usize
    );
    out
}

impl Bridge {
    pub fn command(&mut self, command: Command, now: Instant) -> Result<Reply, &'static str> {
        if command.role != ROLE {
            return Err("Invalid frame contract");
        }
        self.command_with(command, now, None)
    }

    /// The processed camera role's entry: `frame` is the latest processed
    /// camera frame (or `None` when the camera has none to give).
    pub fn command_with(
        &mut self,
        command: Command,
        now: Instant,
        frame: Option<ProcessedFrame>,
    ) -> Result<Reply, &'static str> {
        let processed = command.role == PROCESSED_ROLE;
        let size_ok = if processed {
            alpha_dimensions(command.width, command.height) && (1..=30).contains(&command.fps)
        } else {
            command.role == ROLE
                && command.width == WIDTH
                && command.height == HEIGHT
                && u64::from(command.fps) == FPS
        };
        if command.generation == 0
            || command.generation > MAX_SAFE_INTEGER
            || !size_ok
            || command.packing != PACKING
            || command
                .release
                .is_some_and(|r| r.sequence > MAX_SAFE_INTEGER)
            || (command.release.is_some() && command.action != "pull")
        {
            return Err("Invalid frame contract");
        }
        match command.action.as_str() {
            "open" => {
                if self.active.is_some() || command.generation <= self.last_generation {
                    return Err("Stale or already open frame generation");
                }
                self.last_generation = command.generation;
                ACTIVE_SOURCES.fetch_add(1, Ordering::SeqCst);
                let source = Source {
                    generation: command.generation,
                    start: now,
                    logical: (command.width, command.height),
                    processed: processed.then(ProcessedState::default),
                    origin_us: crate::room_clock::origin_us(now),
                    incarnation: crate::room_clock::incarnation(),
                    surface_epoch: 1,
                    next: 0,
                    dropped: 0,
                    stale_releases: 0,
                    lease_stalls: 0,
                    leases: [None; LEASE_SLOTS],
                };
                let opened = Opened {
                    generation: source.generation,
                    surface_epoch: source.surface_epoch,
                    origin_us: source.origin_us,
                    incarnation: source.incarnation,
                };
                self.active = Some(source);
                Ok(Reply::Opened(opened))
            }
            "close" => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.generation != command.generation)
                {
                    return Err("Stale frame generation");
                }
                self.active = None;
                Ok(Reply::Closed)
            }
            "reset" => {
                let source = self.active.as_mut().ok_or("Frame source closed")?;
                if source.generation != command.generation {
                    return Err("Stale frame generation");
                }
                let revoked = source.revoke_all();
                source.surface_epoch = source
                    .surface_epoch
                    .checked_add(1)
                    .ok_or("Surface epoch exhausted")?;
                Ok(Reply::Reset(Reset {
                    generation: source.generation,
                    surface_epoch: source.surface_epoch,
                    revoked_leases: revoked,
                }))
            }
            "pull" => {
                let source = self.active.as_mut().ok_or("Frame source closed")?;
                if source.generation != command.generation {
                    return Err("Stale frame generation");
                }
                if source.processed.is_some() != processed {
                    return Err("Frame role changed within a generation");
                }
                if let Some(release) = command.release {
                    let slot = source.leases.iter_mut().find(|slot| {
                        **slot == Some((release.sequence, release.surface_epoch))
                            && release.surface_epoch == source.surface_epoch
                    });
                    match slot {
                        Some(slot) => {
                            *slot = None;
                            ACTIVE_LEASES.fetch_sub(1, Ordering::SeqCst);
                        }
                        None => source.stale_releases += 1,
                    }
                }
                let elapsed =
                    u64::try_from(now.saturating_duration_since(source.start).as_micros())
                        .unwrap_or(u64::MAX)
                        .min(MAX_SAFE_INTEGER);
                if processed {
                    return Self::pull_processed(source, command.serial, elapsed, frame);
                }
                let due = elapsed.saturating_mul(FPS) / 1_000_000 + 1;
                let idle = |source: &Source, reason| {
                    Reply::Idle(Idle {
                        frame: None,
                        reason,
                        stale_releases: source.stale_releases,
                        lease_stalls: source.lease_stalls,
                    })
                };
                if due <= source.next {
                    return Ok(idle(source, "not-due"));
                }
                let Some(slot_index) = source.leases.iter().position(Option::is_none) else {
                    source.lease_stalls += 1;
                    return Ok(idle(source, "lease-stalled"));
                };
                // Video keeps the latest due frame: older due frames are counted, not queued.
                if due - source.next > 1 {
                    source.dropped += due - source.next - 1;
                    source.next = due - 1;
                }
                let sequence = source.next;
                source.next += 1;
                let pts = pts_us(sequence);
                let observed = elapsed.max(pts);
                if source.origin_us.is_some_and(|origin| {
                    origin
                        .checked_add(observed)
                        .is_none_or(|sum| sum > MAX_SAFE_INTEGER)
                }) {
                    return Err("Frame clock exceeds its bound");
                }
                source.leases[slot_index] = Some((sequence, source.surface_epoch));
                ACTIVE_LEASES.fetch_add(1, Ordering::SeqCst);
                Ok(Reply::Frame(encode(&Header {
                    serial: command.serial,
                    surface_epoch: source.surface_epoch,
                    lease_slot: slot_index as u32,
                    generation: source.generation,
                    sequence,
                    pts_us: pts,
                    observed_at_us: observed,
                    origin_us: source.origin_us,
                    incarnation: source.incarnation,
                    dropped_frames: source.dropped,
                    lease_stalls: source.lease_stalls,
                })))
            }
            _ => Err("Invalid frame action"),
        }
    }

    fn pull_processed(
        source: &mut Source,
        serial: u32,
        elapsed: u64,
        frame: Option<ProcessedFrame>,
    ) -> Result<Reply, &'static str> {
        let idle = |source: &Source, reason| {
            Reply::Idle(Idle {
                frame: None,
                reason,
                stale_releases: source.stale_releases,
                lease_stalls: source.lease_stalls,
            })
        };
        let Some(frame) = frame else {
            return Ok(idle(source, "camera-unavailable"));
        };
        let (width, height) = source.logical;
        if frame.width != width
            || frame.height != height
            || frame.rgba.len() != (width * height * 4) as usize
        {
            return Err("Processed frame size does not match its generation");
        }
        let state = source.processed.as_mut().ok_or("Not a processed source")?;
        match state.camera_generation {
            Some(bound) if bound != frame.camera_generation => {
                return Err("Camera source replaced; open a new frame generation");
            }
            None => state.camera_generation = Some(frame.camera_generation),
            _ => {}
        }
        if state.last_camera_sequence == Some(frame.camera_sequence) {
            return Ok(idle(source, "not-due"));
        }
        let Some(slot_index) = source.leases.iter().position(Option::is_none) else {
            source.lease_stalls += 1;
            return Ok(idle(source, "lease-stalled"));
        };
        let state = source.processed.as_mut().ok_or("Not a processed source")?;
        if let Some(last) = state.last_camera_sequence {
            if frame.camera_sequence < last {
                return Err("Camera sequence went backwards");
            }
            source.dropped += frame.camera_sequence - last - 1;
        }
        state.last_camera_sequence = Some(frame.camera_sequence);
        // Observation time relative to the generation epoch (an upper bound on
        // capture time); a frame first observed before the epoch counts as 0.
        let pts = u64::try_from(
            frame
                .observed_at
                .saturating_duration_since(source.start)
                .as_micros(),
        )
        .unwrap_or(u64::MAX)
        .min(elapsed);
        let observed = elapsed.max(pts);
        if source.origin_us.is_some_and(|origin| {
            origin
                .checked_add(observed)
                .is_none_or(|sum| sum > MAX_SAFE_INTEGER)
        }) {
            return Err("Frame clock exceeds its bound");
        }
        let sequence = source.next;
        source.next += 1;
        source.leases[slot_index] = Some((sequence, source.surface_epoch));
        ACTIVE_LEASES.fetch_add(1, Ordering::SeqCst);
        Ok(Reply::Frame(encode_processed(
            &Header {
                serial,
                surface_epoch: source.surface_epoch,
                lease_slot: slot_index as u32,
                generation: source.generation,
                sequence,
                pts_us: pts,
                observed_at_us: observed,
                origin_us: source.origin_us,
                incarnation: source.incarnation,
                dropped_frames: source.dropped,
                lease_stalls: source.lease_stalls,
            },
            width,
            height,
            &frame.rgba,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn command(action: &str, generation: u64, release: Option<(u64, u32)>) -> Command {
        Command {
            action: action.into(),
            generation,
            role: ROLE.into(),
            width: WIDTH,
            height: HEIGHT,
            fps: FPS as u32,
            packing: PACKING.into(),
            serial: 7,
            release: release.map(|(sequence, surface_epoch)| Release {
                sequence,
                surface_epoch,
            }),
        }
    }
    fn u64_at(bytes: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
    }
    fn frame(reply: Reply) -> Vec<u8> {
        match reply {
            Reply::Frame(bytes) => bytes,
            other => panic!("expected frame, got {other:?}"),
        }
    }

    #[test]
    fn leases_bound_frames_and_reset_revokes_them() {
        let now = Instant::now();
        let mut bridge = Bridge::default();
        bridge.command(command("open", 1, None), now).unwrap();
        let first = frame(bridge.command(command("pull", 1, None), now).unwrap());
        assert_eq!(
            first.len(),
            HEADER_BYTES + (PACKED_WIDTH * HEIGHT * 4) as usize
        );
        assert_eq!(u64_at(&first, 40), 0);
        assert!(matches!(
            bridge.command(command("pull", 1, None), now).unwrap(),
            Reply::Idle(Idle {
                reason: "not-due",
                ..
            })
        ));
        let at = now + Duration::from_millis(40);
        frame(bridge.command(command("pull", 1, None), at).unwrap());
        // Both slots leased: the third due frame waits rather than queueing.
        let later = now + Duration::from_millis(100);
        assert!(matches!(
            bridge.command(command("pull", 1, None), later).unwrap(),
            Reply::Idle(Idle {
                reason: "lease-stalled",
                lease_stalls: 1,
                ..
            })
        ));
        // A reset revokes both; a release from the old surface epoch is stale.
        let Reply::Reset(reset) = bridge.command(command("reset", 1, None), later).unwrap() else {
            panic!("reset");
        };
        assert_eq!(reset.revoked_leases, 2);
        assert_eq!(reset.surface_epoch, 2);
        let next = frame(
            bridge
                .command(command("pull", 1, Some((0, 1))), later)
                .unwrap(),
        );
        assert_eq!(u32::from_le_bytes(next[20..24].try_into().unwrap()), 2);
        // Latest-wins: frame 3 (due by 100 ms) is delivered; frame 2 is counted, not queued.
        assert_eq!(u64_at(&next, 40), 3);
        assert_eq!(u64_at(&next, 80), 1);
        bridge.command(command("close", 1, None), later).unwrap();
        assert!(bridge.active.is_none());
        assert!(bridge.command(command("open", 1, None), later).is_err());
    }

    #[test]
    fn shared_fixture_matches_native_wire_and_pixels() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol-fixtures/room-frame.json"))
                .unwrap();
        assert_eq!(fixture["role"], ROLE);
        assert_eq!(fixture["packing"], PACKING);
        assert_eq!(fixture["width"], WIDTH);
        assert_eq!(fixture["height"], HEIGHT);
        assert_eq!(fixture["gutter"], GUTTER);
        assert_eq!(fixture["packedWidth"], PACKED_WIDTH);
        assert_eq!(fixture["fps"], FPS);
        assert_eq!(fixture["leaseSlots"], LEASE_SLOTS);
        assert_eq!(fixture["headerBytes"], HEADER_BYTES);
        assert_eq!(fixture["magic"], MAGIC);
        assert_eq!(fixture["productionQualified"], false);
        for vector in fixture["pixels"].as_array().unwrap() {
            let sequence = vector["sequence"].as_u64().unwrap();
            let stamp = stamp_bits(sequence);
            let px = vector["px"].as_u64().unwrap() as u32;
            let y = vector["y"].as_u64().unwrap() as u32;
            let expected: Vec<u8> = vector["rgba"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(packed_pixel(px, y, sequence, &stamp).to_vec(), expected);
        }
        for vector in fixture["pts"].as_array().unwrap() {
            assert_eq!(
                pts_us(vector["sequence"].as_u64().unwrap()),
                vector["ptsUs"].as_u64().unwrap()
            );
        }
    }

    #[test]
    fn invalid_contract_never_opens() {
        let mut bridge = Bridge::default();
        let mut request = command("open", 1, None);
        request.width = 4096;
        assert!(bridge.command(request, Instant::now()).is_err());
        let mut released_open = command("open", 1, Some((0, 1)));
        released_open.serial = 1;
        assert!(bridge.command(released_open, Instant::now()).is_err());
        assert!(bridge.active.is_none());
        assert!(
            bridge
                .command(command("open", MAX_SAFE_INTEGER + 1, None), Instant::now())
                .is_err()
        );
    }

    fn processed(action: &str, generation: u64, width: u32, height: u32) -> Command {
        Command {
            role: PROCESSED_ROLE.into(),
            width,
            height,
            ..command(action, generation, None)
        }
    }
    fn camera_frame(generation: u64, sequence: u64, at: Instant, w: u32, h: u32) -> ProcessedFrame {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for (i, pixel) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            *pixel = [10, 20, 30, (i % 256) as u8];
        }
        ProcessedFrame {
            camera_generation: generation,
            camera_sequence: sequence,
            observed_at: at,
            width: w,
            height: h,
            rgba,
        }
    }

    #[test]
    fn logical_size_keeps_the_source_aspect_within_s10_limits() {
        assert_eq!(logical_size_for(1920, 1080), Some((640, 360)));
        assert_eq!(logical_size_for(1280, 720), Some((640, 360)));
        assert_eq!(logical_size_for(640, 480), Some((554, 414)));
        assert_eq!(logical_size_for(1080, 1920), Some((360, 640)));
        assert_eq!(logical_size_for(4096, 2160), Some((640, 336)));
        assert_eq!(logical_size_for(320, 180), Some((320, 180)));
        assert_eq!(logical_size_for(0, 10), None);
        assert!(
            alpha_dimensions(640, 360) && !alpha_dimensions(640, 362) && !alpha_dimensions(63, 64)
        );
        for (w, h) in [(1920, 1080), (640, 480), (1080, 1920), (4096, 2160)] {
            let (lw, lh) = logical_size_for(w, h).unwrap();
            assert!(alpha_dimensions(lw, lh));
        }
    }

    #[test]
    fn processed_frames_pack_logical_alpha_and_flag_observation_time() {
        let now = Instant::now();
        let mut bridge = Bridge::default();
        let (w, h) = (554, 414);
        bridge
            .command_with(processed("open", 3, w, h), now, None)
            .unwrap();
        assert!(matches!(
            bridge
                .command_with(processed("pull", 3, w, h), now, None)
                .unwrap(),
            Reply::Idle(Idle {
                reason: "camera-unavailable",
                ..
            })
        ));
        let at = now + Duration::from_millis(5);
        let bytes = frame(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now + Duration::from_millis(9),
                    Some(camera_frame(1, 10, at, w, h)),
                )
                .unwrap(),
        );
        let packed = w * 2 + GUTTER;
        assert_eq!(bytes.len(), HEADER_BYTES + (packed * h * 4) as usize);
        assert_eq!(
            u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
            FLAG_PACKED | FLAG_PTS_OBSERVED
        );
        assert_eq!(
            u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            packed
        );
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), h);
        assert_eq!(u64_at(&bytes, 48), 5_000, "pts is observation time");
        assert!(u64_at(&bytes, 56) >= 9_000);
        // Colour left (opaque), gutter black, alpha as grey.
        let px = |x: u32, y: u32| {
            let i = HEADER_BYTES + ((y * packed + x) * 4) as usize;
            [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
        };
        assert_eq!(px(1, 0), [10, 20, 30, 255]);
        assert_eq!(px(w + 1, 0), [0, 0, 0, 255]);
        assert_eq!(px(w + GUTTER + 1, 0), [1, 1, 1, 255]);
        // The same camera frame again is not due; a gap counts dropped frames.
        assert!(matches!(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now,
                    Some(camera_frame(1, 10, at, w, h))
                )
                .unwrap(),
            Reply::Idle(Idle {
                reason: "not-due",
                ..
            })
        ));
        let next = frame(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now,
                    Some(camera_frame(1, 13, at, w, h)),
                )
                .unwrap(),
        );
        assert_eq!(u64_at(&next, 80), 2);
        // A device switch (new camera generation) refuses this generation.
        let _ = bridge
            .command_with(processed("reset", 3, w, h), now, None)
            .unwrap();
        assert!(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now,
                    Some(camera_frame(2, 14, at, w, h))
                )
                .is_err()
        );
        // Backwards camera sequences and size mismatches are refused.
        assert!(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now,
                    Some(camera_frame(1, 12, at, w, h))
                )
                .is_err()
        );
        assert!(
            bridge
                .command_with(
                    processed("pull", 3, w, h),
                    now,
                    Some(camera_frame(1, 20, at, 640, 360))
                )
                .is_err()
        );
    }

    #[test]
    fn roles_and_sizes_cannot_be_mixed() {
        let now = Instant::now();
        let mut bridge = Bridge::default();
        // The synthetic entry never accepts the processed role, and vice versa sizes.
        assert!(bridge.command(processed("open", 1, 640, 360), now).is_err());
        assert!(
            bridge
                .command_with(processed("open", 1, 640, 362), now, None)
                .is_err()
        );
        assert!(
            bridge
                .command_with(processed("open", 1, 640, 360), now, None)
                .is_ok()
        );
        assert!(
            bridge
                .command_with(command("pull", 1, None), now, None)
                .is_err()
        );
    }

    #[test]
    fn fixture_camera_zones_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol-fixtures/room-camera.json"))
                .unwrap();
        for vector in fixture["pixels"].as_array().unwrap() {
            let get = |k: &str| vector[k].as_u64().unwrap() as u32;
            let stamp = stamp_bits(vector["sequence"].as_u64().unwrap());
            let expected: Vec<u8> = vector["rgb"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(
                fixture_camera_rgb(get("x"), get("y"), get("width"), get("height"), &stamp)
                    .to_vec(),
                expected,
                "{vector}"
            );
        }
        for size in fixture["logicalSizes"].as_array().unwrap() {
            let get = |k: &str| size[k].as_u64().unwrap() as u32;
            assert_eq!(
                logical_size_for(get("sourceWidth"), get("sourceHeight")),
                Some((get("width"), get("height")))
            );
        }
        let bgra = fixture_camera_bgra(5, 64, 36);
        assert_eq!(bgra.len(), 64 * 36 * 4);
        assert_eq!(&bgra[..4], &[0, 255, 0, 255], "key-green ground in BGRA");
    }
}
