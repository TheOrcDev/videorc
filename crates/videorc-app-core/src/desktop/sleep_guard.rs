//! The display sleep guard (plan 220 S2.6b): `main/display-sleep-guard.ts`.
//!
//! macOS stops every ScreenCaptureKit stream when the display sleeps
//! (-3815), so a take with no keyboard or mouse input past the display-sleep
//! timer froze the screen and lost System audio for the rest of the session
//! (E2E 2026-11-01). The display is kept awake while a session writes or
//! sends something: starting, recording, streaming or stopping. The Clips
//! buffer reads as idle, and an unknown state (no backend connection) never
//! holds the display.
//!
//! Pure: `start` returns the blocker the OS handed out (on macOS an
//! `IOPMAssertionID`, `videorc-app`'s `desktop::sleep_guard`), `stop`
//! releases it.

use super::capture_state::MainCaptureState;

/// Holds one blocker while the capture state is active.
pub struct DisplaySleepGuard<Start, Stop>
where
    Start: FnMut() -> Option<u32>,
    Stop: FnMut(u32),
{
    start: Start,
    stop: Stop,
    blocker: Option<u32>,
}

impl<Start, Stop> DisplaySleepGuard<Start, Stop>
where
    Start: FnMut() -> Option<u32>,
    Stop: FnMut(u32),
{
    pub fn new(start: Start, stop: Stop) -> Self {
        Self {
            start,
            stop,
            blocker: None,
        }
    }

    /// Main's capture state after a status or a lost connection. A start the
    /// OS refused (`None`) is tried again on the next active update.
    pub fn update(&mut self, state: MainCaptureState) {
        let wanted = state != MainCaptureState::Unknown && state.is_active();
        if wanted && self.blocker.is_none() {
            self.blocker = (self.start)();
        } else if !wanted && let Some(blocker) = self.blocker.take() {
            (self.stop)(blocker);
        }
    }

    pub fn holding(&self) -> bool {
        self.blocker.is_some()
    }

    /// The blocker held, for the smokes.
    pub fn blocker(&self) -> Option<u32> {
        self.blocker
    }

    /// At quit: whatever is held goes back.
    pub fn release(&mut self) {
        if let Some(blocker) = self.blocker.take() {
            (self.stop)(blocker);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use MainCaptureState::*;

    #[allow(clippy::type_complexity)]
    fn guard() -> (
        DisplaySleepGuard<impl FnMut() -> Option<u32>, impl FnMut(u32)>,
        Rc<RefCell<Vec<String>>>,
    ) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut next = 7;
        let started = calls.clone();
        let stopped = calls.clone();
        (
            DisplaySleepGuard::new(
                move || {
                    started.borrow_mut().push(format!("start:{next}"));
                    next += 1;
                    Some(next - 1)
                },
                move |id| stopped.borrow_mut().push(format!("stop:{id}")),
            ),
            calls,
        )
    }

    #[test]
    fn holds_the_display_awake_from_record_to_the_end_of_the_session_once() {
        let (mut guard, calls) = guard();
        for state in [Idle, Starting, Recording, Recording, Stopping] {
            guard.update(state);
        }
        assert!(guard.holding());
        guard.update(Idle);
        assert!(!guard.holding());
        assert_eq!(*calls.borrow(), ["start:7", "stop:7"]);
    }

    #[test]
    fn holds_it_for_a_stream_only_livestream_and_lets_go_when_it_fails() {
        let (mut guard, calls) = guard();
        guard.update(Streaming);
        guard.update(Failed);
        assert_eq!(*calls.borrow(), ["start:7", "stop:7"]);
    }

    #[test]
    fn never_holds_it_for_the_clips_buffer_which_main_reads_as_idle() {
        let (mut guard, calls) = guard();
        let clips: videorc_protocol::RecordingStatus =
            serde_json::from_value(serde_json::json!({"state": "recording", "replayOnly": true}))
                .unwrap();
        guard.update(MainCaptureState::from_status(&clips));
        assert!(!guard.holding());
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn lets_go_when_the_connection_is_lost() {
        let (mut guard, calls) = guard();
        guard.update(Recording);
        guard.update(Unknown);
        assert_eq!(*calls.borrow(), ["start:7", "stop:7"]);
        guard.update(Unknown);
        assert_eq!(*calls.borrow(), ["start:7", "stop:7"]);
    }

    #[test]
    fn a_refused_start_is_tried_again_and_quit_releases() {
        let attempts = Rc::new(RefCell::new(0));
        let counted = attempts.clone();
        let released = Rc::new(RefCell::new(Vec::new()));
        let stops = released.clone();
        let mut guard = DisplaySleepGuard::new(
            move || {
                *counted.borrow_mut() += 1;
                (*counted.borrow() > 1).then_some(42)
            },
            move |id| stops.borrow_mut().push(id),
        );
        guard.update(Recording);
        assert!(!guard.holding());
        guard.update(Recording);
        assert_eq!(guard.blocker(), Some(42));
        guard.release();
        assert_eq!(*released.borrow(), [42]);
        assert!(!guard.holding());
    }
}
