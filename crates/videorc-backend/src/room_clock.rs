//! Plan 249 S13a: the one native monotonic anchor shared by room media bridges.
//!
//! `init()` runs at process start, before any audio or video generation epoch
//! is captured. A generation's `originUs` is its epoch measured from this
//! anchor. An epoch earlier than the anchor, or a call before `init()`, has no
//! origin (`None`): it never saturates to zero. Pairing audio and video by
//! origin is valid only inside one backend process incarnation; a restart
//! makes a new incarnation and earlier origins are unrelated.
//!
//! This is not UTC, RTP time, renderer time or an archival show clock.
use std::sync::OnceLock;
use std::time::Instant;

struct Anchor {
    at: Instant,
    incarnation: u64,
}

static ANCHOR: OnceLock<Anchor> = OnceLock::new();

/// JavaScript-safe (`< 2^53`), never zero.
const SAFE_INTEGER_MASK: u64 = (1 << 53) - 1;

fn incarnation_from(bytes: [u8; 16]) -> u64 {
    let value = u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0; 8])) & SAFE_INTEGER_MASK;
    value.max(1)
}

/// Idempotent. Call first in `main`; the first caller fixes the anchor.
pub fn init() {
    let _ = ANCHOR.get_or_init(|| Anchor {
        at: Instant::now(),
        incarnation: incarnation_from(*uuid::Uuid::new_v4().as_bytes()),
    });
}

/// The process incarnation, or `None` before `init()`.
pub fn incarnation() -> Option<u64> {
    ANCHOR.get().map(|anchor| anchor.incarnation)
}

/// `epoch` measured from the anchor in microseconds. `None` before `init()`,
/// for an epoch that predates the anchor, or past the safe-integer range.
pub fn origin_us(epoch: Instant) -> Option<u64> {
    let anchor = ANCHOR.get()?;
    let elapsed = epoch.checked_duration_since(anchor.at)?;
    let micros = u64::try_from(elapsed.as_micros()).ok()?;
    (micros <= SAFE_INTEGER_MASK).then_some(micros)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn origin_is_absent_for_early_epochs_and_bound_to_one_incarnation() {
        let early = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        init();
        let first = incarnation().unwrap();
        init();
        assert_eq!(incarnation(), Some(first), "init is idempotent");
        assert!(first > 0 && first <= SAFE_INTEGER_MASK);
        // An epoch captured before the anchor exists never becomes zero.
        if ANCHOR.get().unwrap().at > early {
            assert_eq!(origin_us(early), None);
        }
        let later = Instant::now() + Duration::from_millis(5);
        let origin = origin_us(later).unwrap();
        assert!(origin >= 5_000);
    }

    #[test]
    fn incarnation_is_safe_and_non_zero() {
        assert_eq!(incarnation_from([0; 16]), 1);
        assert_eq!(incarnation_from([255; 16]), SAFE_INTEGER_MASK);
    }
}
