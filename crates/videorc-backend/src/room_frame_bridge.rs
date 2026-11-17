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
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

pub const ROLE: &str = "host-camera-test";
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
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    surface_epoch: u32,
    next: u64,
    dropped: u64,
    stale_releases: u64,
    lease_stalls: u64,
    leases: [Option<(u64, u32)>; LEASE_SLOTS],
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

fn encode(header: &Header) -> Vec<u8> {
    let payload = (PACKED_WIDTH * HEIGHT * 4) as usize;
    let mut out = Vec::with_capacity(HEADER_BYTES + payload);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // flags bit 0: packed alpha
    for v in [
        header.serial,
        PACKED_WIDTH,
        HEIGHT,
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
    let stamp = stamp_bits(header.sequence);
    for y in 0..HEIGHT {
        for px in 0..PACKED_WIDTH {
            out.extend_from_slice(&packed_pixel(px, y, header.sequence, &stamp));
        }
    }
    debug_assert_eq!(out.len(), HEADER_BYTES + payload);
    out
}

impl Bridge {
    pub fn command(&mut self, command: Command, now: Instant) -> Result<Reply, &'static str> {
        if command.generation == 0
            || command.generation > MAX_SAFE_INTEGER
            || command.role != ROLE
            || command.width != WIDTH
            || command.height != HEIGHT
            || u64::from(command.fps) != FPS
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
}
