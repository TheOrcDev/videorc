//! A standby Media Foundation H.264 encoder for the next Record (#1267
//! follow-up).
//!
//! Every Windows Record used to activate and configure its hardware MFT on
//! the click path: `ActivateObject` p50 246 / p95 739 ms and configuration
//! p50 182 / p95 486 ms on an Intel UHD 620, almost all of it driver work.
//! Once the replay-only Clips ring is running (the user is idle), its bridge
//! writer arms a standby: a parked thread builds an encoder with the ring's
//! exact configuration and holds it. The next Record's writer takes it if the
//! configuration matches, and builds its own otherwise.
//!
//! Threading: the encoder is `!Send` because its drop leaves the MTA on the
//! thread that joined it. The standby thread returns its own COM reference
//! before sending the encoder ([`MediaFoundationH264Encoder::into_thread_handoff`])
//! and the taking thread joins the MTA when it adopts it, so each thread's
//! `CoInitializeEx`/`CoUninitialize` stays balanced. The MTA itself and one
//! `MFStartup` reference are held for the process lifetime
//! (`windows_com_lifetime`), so no hand-off can tear either down.
//!
//! Cost: one more idle hardware encoder session while the ring runs (NVENC
//! caps concurrent sessions per GPU), and nothing during a Record: the Record
//! uses the standby instead of opening its own. A standby that waits longer
//! than [`STANDBY_MAX_IDLE`] is released and only the ring's next start arms
//! a new one.
//!
//! `VIDEORC_MF_STANDBY=0` turns it off (A/B measurement, support).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use crate::windows_media_foundation_encoder::{
    MediaFoundationEncoderConfig, MediaFoundationH264Encoder, MediaFoundationThreadHandoff,
};

/// How long an unused standby keeps its hardware session.
const STANDBY_MAX_IDLE: Duration = Duration::from_secs(10 * 60);

/// How long a Record waits for a standby that is still being built before it
/// builds its own. A build takes 0.3-1 s warm on the UHD 620; past this the
/// fresh build is no slower than waiting.
const STANDBY_TAKE_WAIT: Duration = Duration::from_millis(1500);

enum StandbyRequest {
    Take(SyncSender<Option<MediaFoundationThreadHandoff>>),
    Release,
}

struct StandbySlot {
    generation: u64,
    config: MediaFoundationEncoderConfig,
    requests: Sender<StandbyRequest>,
}

static SLOT: Mutex<Option<StandbySlot>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// What [`take`] found, for the bridge's log and the start timeline.
pub enum StandbyTake {
    Adopted {
        encoder: MediaFoundationH264Encoder,
        waited: Duration,
    },
    /// No standby, a different profile, a failed build or a refused adoption.
    Missed(String),
}

pub fn enabled() -> bool {
    standby_enabled(std::env::var("VIDEORC_MF_STANDBY").ok().as_deref())
}

fn standby_enabled(value: Option<&str>) -> bool {
    !matches!(value.map(str::trim), Some("0" | "false" | "off" | "no"))
}

fn lock_slot() -> std::sync::MutexGuard<'static, Option<StandbySlot>> {
    SLOT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Builds a standby encoder for `config` in the background, replacing one
/// parked for another profile. A standby for the same profile is kept.
pub fn arm(config: MediaFoundationEncoderConfig) {
    if !enabled() {
        return;
    }
    let mut slot = lock_slot();
    if slot.as_ref().is_some_and(|parked| parked.config == config) {
        return;
    }
    if let Some(previous) = slot.take() {
        let _ = previous.requests.send(StandbyRequest::Release);
    }
    let (requests, receiver) = mpsc::channel();
    let thread_config = config.clone();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    match thread::Builder::new()
        .name("videorc-mf-standby".to_string())
        .spawn(move || run_standby(generation, thread_config, receiver))
    {
        Ok(_) => {
            *slot = Some(StandbySlot {
                generation,
                config,
                requests,
            });
        }
        Err(error) => tracing::warn!("Could not start the standby encoder thread: {error}"),
    }
}

/// Takes the parked standby for `config`, waiting up to [`STANDBY_TAKE_WAIT`]
/// for one still being built. A standby for another profile is released, so
/// a Record never leaves a stale encoder session open. Call this on the
/// thread that will own the encoder.
pub fn take(config: &MediaFoundationEncoderConfig) -> StandbyTake {
    if !enabled() {
        return StandbyTake::Missed("disabled (VIDEORC_MF_STANDBY=0)".to_string());
    }
    let Some(parked) = lock_slot().take() else {
        return StandbyTake::Missed("none parked".to_string());
    };
    if parked.config != *config {
        let _ = parked.requests.send(StandbyRequest::Release);
        return StandbyTake::Missed(format!(
            "parked for {}, this Record needs {}",
            parked.config.profile_label(),
            config.profile_label()
        ));
    }
    let started = Instant::now();
    let (reply, answer) = mpsc::sync_channel(1);
    if parked.requests.send(StandbyRequest::Take(reply)).is_err() {
        return StandbyTake::Missed("standby expired".to_string());
    }
    let handoff = match answer.recv_timeout(STANDBY_TAKE_WAIT) {
        Ok(Some(handoff)) => handoff,
        Ok(None) => return StandbyTake::Missed("standby build failed".to_string()),
        Err(RecvTimeoutError::Timeout) => {
            return StandbyTake::Missed(format!(
                "standby still building after {} ms",
                STANDBY_TAKE_WAIT.as_millis()
            ));
        }
        Err(RecvTimeoutError::Disconnected) => {
            return StandbyTake::Missed("standby thread ended".to_string());
        }
    };
    let waited = started.elapsed();
    match handoff.adopt_on_current_thread() {
        Ok(encoder) => StandbyTake::Adopted { encoder, waited },
        Err(error) => StandbyTake::Missed(format!("adoption refused: {error:#}")),
    }
}

fn run_standby(
    generation: u64,
    config: MediaFoundationEncoderConfig,
    requests: Receiver<StandbyRequest>,
) {
    let profile = config.profile_label();
    let started = Instant::now();
    let built = MediaFoundationH264Encoder::new(config);
    let encoder = match built {
        Ok(encoder) => {
            tracing::info!(
                "[mf-standby] built {} for {profile} in {} ms",
                encoder.identity(),
                started.elapsed().as_millis()
            );
            Some(encoder)
        }
        Err(error) => {
            tracing::warn!(
                "[mf-standby] could not build a standby encoder for {profile}: {error:#}"
            );
            None
        }
    };
    let request = requests.recv_timeout(STANDBY_MAX_IDLE);
    let Some(encoder) = encoder else {
        if let Ok(StandbyRequest::Take(reply)) = request {
            let _ = reply.send(None);
        }
        return;
    };
    match request {
        Ok(StandbyRequest::Take(reply)) => match encoder.into_thread_handoff() {
            Ok(handoff) => {
                if let Err(mpsc::SendError(Some(handoff))) = reply.send(Some(handoff)) {
                    // The Record stopped waiting: adopt it back here so its
                    // drop stays balanced on this thread.
                    drop(handoff.adopt_on_current_thread());
                }
            }
            Err(encoder) => {
                drop(encoder);
                let _ = reply.send(None);
            }
        },
        Ok(StandbyRequest::Release) | Err(RecvTimeoutError::Disconnected) => drop(encoder),
        Err(RecvTimeoutError::Timeout) => {
            // Forget the slot only if it is still this standby's.
            let mut slot = lock_slot();
            if slot
                .as_ref()
                .is_some_and(|parked| parked.generation == generation)
            {
                *slot = None;
            }
            drop(slot);
            tracing::info!(
                "[mf-standby] released the unused standby encoder for {profile} after {} s",
                STANDBY_MAX_IDLE.as_secs()
            );
            drop(encoder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_standby_is_on_unless_turned_off() {
        assert!(standby_enabled(None));
        assert!(standby_enabled(Some("1")));
        assert!(standby_enabled(Some("")));
        for off in ["0", "false", "off", "no", " 0 "] {
            assert!(!standby_enabled(Some(off)), "{off}");
        }
    }

    fn config(bitrate_kbps: u32) -> MediaFoundationEncoderConfig {
        MediaFoundationEncoderConfig {
            width: 640,
            height: 360,
            fps: 30,
            bitrate_kbps,
            low_latency: false,
            input_topology: Default::default(),
        }
    }

    /// One test, because the standby slot is process-wide. Needs a hardware
    /// H.264 MFT; a machine without one (CI runners) skips after the first
    /// build fails.
    #[test]
    fn a_standby_built_on_its_thread_encodes_on_the_taking_thread() {
        let wanted = config(1_000);
        if let Err(error) = MediaFoundationH264Encoder::new(wanted.clone()) {
            eprintln!("skipping: no hardware H.264 MFT here ({error:#})");
            return;
        }

        // Nothing parked.
        assert!(matches!(take(&wanted), StandbyTake::Missed(reason) if reason == "none parked"));

        // A different profile is released, not handed out.
        arm(config(1_500));
        match take(&wanted) {
            StandbyTake::Missed(reason) => assert!(reason.starts_with("parked for"), "{reason}"),
            StandbyTake::Adopted { .. } => panic!("adopted a standby for another profile"),
        }
        assert!(matches!(take(&wanted), StandbyTake::Missed(reason) if reason == "none parked"));

        // The matching standby moves threads and encodes on this one; the
        // take waits for a build still in flight.
        arm(wanted.clone());
        let mut encoder = match take(&wanted) {
            StandbyTake::Adopted { encoder, .. } => encoder,
            StandbyTake::Missed(reason) => panic!("standby missed: {reason}"),
        };
        assert!(
            encoder.take_startup_steps().is_empty(),
            "construction stamps from the idle period leak into the Record's timeline"
        );
        let frame_len = (wanted.width * wanted.height * 3 / 2) as usize;
        let mut frames = Vec::new();
        for frame_index in 0..6_u64 {
            let mut i420 = vec![128_u8; frame_len];
            i420[..(wanted.width * wanted.height) as usize].fill(16 + frame_index as u8 * 20);
            frames.extend(encoder.encode_frame(&i420, frame_index).expect("encode"));
        }
        frames.extend(
            encoder
                .drain(crate::windows_media_foundation_encoder::DRAIN_TIMEOUT)
                .expect("drain"),
        );
        assert!(!frames.is_empty(), "the adopted encoder produced no output");
        // Dropped here: leaves the MTA on this thread, which joined it on adoption.
        drop(encoder);
        // The slot is empty again after a take.
        assert!(matches!(take(&wanted), StandbyTake::Missed(reason) if reason == "none parked"));
    }
}
