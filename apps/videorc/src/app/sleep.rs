//! The display sleep guard (plan 260 S2.6a/b): the core's policy
//! (`desktop::sleep_guard`, Electron's `display-sleep-guard.ts`) on main's
//! capture state ([`super::capture`]), the OS call behind [`crate::platform`].
//! macOS stops every ScreenCaptureKit stream when the display sleeps, so the
//! display is kept awake while a session writes or sends something; a lost
//! connection is unknown, which never holds it.

use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use videorc_app_core::Logger;
use videorc_app_core::desktop::capture_state::MainCaptureState;
use videorc_app_core::desktop::sleep_guard::DisplaySleepGuard;

use crate::platform;

/// The reason the OS lists the blocker under (`pmset -g assertions`).
const REASON: &str = "Videorc is recording or streaming";

type Start = Box<dyn FnMut() -> Option<u32> + Send>;
type Stop = Box<dyn FnMut(u32) + Send>;

pub type Guard = Arc<Mutex<DisplaySleepGuard<Start, Stop>>>;

/// Follows the session on the core's runtime; the guard is released at quit
/// ([`release`]).
pub fn follow(
    runtime: &tokio::runtime::Handle,
    mut capture: watch::Receiver<MainCaptureState>,
    logger: Logger,
) -> Guard {
    let start_logger = logger.clone();
    let start: Start = Box::new(
        move || match platform::current().keep_display_awake(REASON) {
            Ok(blocker) => {
                start_logger.info(format!("display sleep guard on ({blocker})"));
                Some(blocker)
            }
            Err(error) => {
                start_logger.warn(format!("display sleep guard refused: {error}"));
                None
            }
        },
    );
    let stop: Stop = Box::new(
        move |blocker| match platform::current().release_display(blocker) {
            Ok(()) => logger.info(format!("display sleep guard off ({blocker})")),
            Err(error) => logger.warn(format!("display sleep guard release failed: {error}")),
        },
    );
    let guard: Guard = Arc::new(Mutex::new(DisplaySleepGuard::new(start, stop)));
    let follower = guard.clone();
    runtime.spawn(async move {
        loop {
            let state = *capture.borrow_and_update();
            follower
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .update(state);
            if capture.changed().await.is_err() {
                break;
            }
        }
    });
    guard
}

/// At quit: whatever is held goes back.
pub fn release(guard: &Guard) {
    guard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .release();
}
