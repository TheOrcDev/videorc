//! macOS and every other platform: no ring. The macOS preview is the
//! native CAMetalLayer on the backend's IOSurface (plan 220 S2.3a); this
//! crate compiles so the layout and its tests build everywhere.

use std::sync::atomic::AtomicU32;
use std::time::Duration;

use crate::{Region, RingError, RingHandle, RingInfo};

pub(crate) struct Mapping;

impl Region for Mapping {
    fn ptr(&self) -> *mut u8 {
        std::ptr::null_mut()
    }

    fn len(&self) -> usize {
        0
    }
}

pub(crate) struct Wake;

impl Wake {
    pub(crate) fn wake(&self, _word: &AtomicU32) {}

    pub(crate) fn wait(&self, _word: &AtomicU32, _expected: u32, timeout: Duration) {
        std::thread::sleep(timeout.min(Duration::from_millis(50)));
    }
}

pub(crate) fn create(_info: &RingInfo) -> Result<(Mapping, RingHandle, Wake), RingError> {
    Err(RingError::Unsupported(
        "this platform has no shared-memory ring",
    ))
}

pub(crate) fn open(_handle: &RingHandle) -> Result<(Mapping, Wake), RingError> {
    Err(RingError::Unsupported(
        "this platform has no shared-memory ring",
    ))
}

pub(crate) fn now_micros() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_micros() as u64
}
