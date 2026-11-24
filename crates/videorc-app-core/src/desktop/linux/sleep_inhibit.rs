//! The display sleep guard's Linux blocker (plan 260 S2.6c): what Electron's
//! `powerSaveBlocker.start('prevent-display-sleep')` did through Chromium.
//!
//! The Inhibit portal first (`org.freedesktop.portal.Inhibit`, Idle and
//! Suspend; the handle is a request object, released by closing it), then
//! `org.freedesktop.ScreenSaver.Inhibit` where no portal backend offers
//! Inhibit, as Chromium does. [`DisplaySleepGuard`]
//! wants a `u32` blocker, so each hold gets a local id that maps to its
//! portal handle or ScreenSaver cookie. D-Bus is behind [`InhibitBus`].

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::desktop::sleep_guard::DisplaySleepGuard;

/// The reason the desktop shows for the hold (GNOME lists it).
pub const INHIBIT_REASON: &str = "Videorc is recording or streaming";

/// The application name ScreenSaver's `Inhibit` wants.
pub const INHIBIT_APP_NAME: &str = "Videorc";

/// The portal's flags: Suspend (4) and Idle (8). Idle keeps the display on
/// and unlocked; Suspend keeps the machine from sleeping under a take.
pub const PORTAL_INHIBIT_FLAGS: u32 = 4 | 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InhibitError {
    /// The interface isn't on the bus, or no backend implements it.
    NotAvailable,
    Failed(String),
}

/// The D-Bus calls the inhibitor needs.
pub trait InhibitBus {
    /// `Inhibit("", flags, {reason})`: the request handle's object path.
    fn portal_inhibit(&mut self, flags: u32, reason: &str) -> Result<String, InhibitError>;
    /// `org.freedesktop.portal.Request.Close` on that handle.
    fn portal_release(&mut self, handle: &str) -> Result<(), InhibitError>;
    /// `org.freedesktop.ScreenSaver.Inhibit(app, reason)`: the cookie.
    fn screensaver_inhibit(&mut self, app: &str, reason: &str) -> Result<u32, InhibitError>;
    fn screensaver_release(&mut self, cookie: u32) -> Result<(), InhibitError>;
}

/// Which route holds the display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InhibitHold {
    Portal(String),
    ScreenSaver(u32),
}

/// Which route the inhibitor uses, for Health and support bundles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InhibitRoute {
    /// Not asked yet.
    Unknown,
    Portal,
    ScreenSaver,
    /// Neither route answered: the display can sleep under a take.
    None,
}

pub struct LinuxSleepInhibitor<B: InhibitBus> {
    bus: B,
    /// False once the portal said it has no Inhibit; ScreenSaver from then on.
    portal_available: bool,
    route: InhibitRoute,
    holds: BTreeMap<u32, InhibitHold>,
    next_id: u32,
    last_error: Option<String>,
}

impl<B: InhibitBus> LinuxSleepInhibitor<B> {
    pub fn new(bus: B) -> Self {
        Self {
            bus,
            portal_available: true,
            route: InhibitRoute::Unknown,
            holds: BTreeMap::new(),
            next_id: 1,
            last_error: None,
        }
    }

    pub fn bus(&self) -> &B {
        &self.bus
    }

    pub fn route(&self) -> InhibitRoute {
        self.route
    }

    /// Why the last hold or release failed, for diagnostics.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn holding(&self) -> usize {
        self.holds.len()
    }

    /// The guard's `start`: a local id for the hold, or `None` when neither
    /// route would hold the display (the guard tries again next update).
    pub fn start(&mut self) -> Option<u32> {
        let hold = self.inhibit()?;
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).unwrap_or(1);
        self.holds.insert(id, hold);
        Some(id)
    }

    fn inhibit(&mut self) -> Option<InhibitHold> {
        if self.portal_available {
            match self
                .bus
                .portal_inhibit(PORTAL_INHIBIT_FLAGS, INHIBIT_REASON)
            {
                Ok(handle) => {
                    self.route = InhibitRoute::Portal;
                    self.last_error = None;
                    return Some(InhibitHold::Portal(handle));
                }
                Err(InhibitError::NotAvailable) => self.portal_available = false,
                Err(InhibitError::Failed(error)) => {
                    self.last_error = Some(format!("Inhibit portal: {error}"));
                }
            }
        }
        match self
            .bus
            .screensaver_inhibit(INHIBIT_APP_NAME, INHIBIT_REASON)
        {
            Ok(cookie) => {
                self.route = InhibitRoute::ScreenSaver;
                self.last_error = None;
                Some(InhibitHold::ScreenSaver(cookie))
            }
            Err(error) => {
                self.route = InhibitRoute::None;
                let error = match error {
                    InhibitError::NotAvailable => {
                        "no Inhibit portal and no ScreenSaver service".to_string()
                    }
                    InhibitError::Failed(error) => format!("ScreenSaver: {error}"),
                };
                self.last_error = Some(match self.last_error.take() {
                    Some(portal) => format!("{portal}; {error}"),
                    None => error,
                });
                None
            }
        }
    }

    /// The guard's `stop`. An id it never handed out is ignored.
    pub fn stop(&mut self, id: u32) {
        let Some(hold) = self.holds.remove(&id) else {
            return;
        };
        let released = match &hold {
            InhibitHold::Portal(handle) => self.bus.portal_release(handle),
            InhibitHold::ScreenSaver(cookie) => self.bus.screensaver_release(*cookie),
        };
        if let Err(error) = released {
            self.last_error = Some(match error {
                InhibitError::NotAvailable => {
                    "the inhibitor left the bus before release".to_string()
                }
                InhibitError::Failed(error) => format!("release: {error}"),
            });
        }
    }
}

/// The display sleep guard on Linux, sharing one inhibitor with the caller
/// (who reads its route and errors for Health).
#[allow(clippy::type_complexity)]
pub fn linux_sleep_guard<B: InhibitBus>(
    inhibitor: Rc<RefCell<LinuxSleepInhibitor<B>>>,
) -> DisplaySleepGuard<impl FnMut() -> Option<u32>, impl FnMut(u32)> {
    let starter = Rc::clone(&inhibitor);
    DisplaySleepGuard::new(
        move || starter.borrow_mut().start(),
        move |id| inhibitor.borrow_mut().stop(id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::capture_state::MainCaptureState;

    #[derive(Default)]
    struct FakeBus {
        no_portal: bool,
        portal_fails: bool,
        no_screensaver: bool,
        release_fails: bool,
        calls: Vec<String>,
        next: u32,
    }

    impl InhibitBus for FakeBus {
        fn portal_inhibit(&mut self, flags: u32, reason: &str) -> Result<String, InhibitError> {
            self.calls.push(format!("portal {flags} {reason}"));
            if self.no_portal {
                return Err(InhibitError::NotAvailable);
            }
            if self.portal_fails {
                return Err(InhibitError::Failed("denied".into()));
            }
            self.next += 1;
            Ok(format!("/request/{}", self.next))
        }

        fn portal_release(&mut self, handle: &str) -> Result<(), InhibitError> {
            self.calls.push(format!("close {handle}"));
            if self.release_fails {
                Err(InhibitError::Failed("gone".into()))
            } else {
                Ok(())
            }
        }

        fn screensaver_inhibit(&mut self, app: &str, _reason: &str) -> Result<u32, InhibitError> {
            self.calls.push(format!("screensaver {app}"));
            if self.no_screensaver {
                return Err(InhibitError::NotAvailable);
            }
            self.next += 1;
            Ok(100 + self.next)
        }

        fn screensaver_release(&mut self, cookie: u32) -> Result<(), InhibitError> {
            self.calls.push(format!("uninhibit {cookie}"));
            Ok(())
        }
    }

    #[test]
    fn holds_idle_and_suspend_through_the_portal_and_closes_the_request() {
        let mut inhibitor = LinuxSleepInhibitor::new(FakeBus::default());
        let id = inhibitor.start().unwrap();
        assert_eq!(inhibitor.route(), InhibitRoute::Portal);
        assert_eq!(inhibitor.holding(), 1);
        inhibitor.stop(id);
        assert_eq!(inhibitor.holding(), 0);
        assert_eq!(
            inhibitor.bus().calls,
            [
                "portal 12 Videorc is recording or streaming",
                "close /request/1"
            ]
        );
    }

    #[test]
    fn falls_back_to_screensaver_and_stops_asking_a_portal_without_inhibit() {
        let mut inhibitor = LinuxSleepInhibitor::new(FakeBus {
            no_portal: true,
            ..FakeBus::default()
        });
        let id = inhibitor.start().unwrap();
        assert_eq!(inhibitor.route(), InhibitRoute::ScreenSaver);
        inhibitor.stop(id);
        inhibitor.start().unwrap();
        assert_eq!(
            inhibitor.bus().calls,
            [
                "portal 12 Videorc is recording or streaming",
                "screensaver Videorc",
                "uninhibit 101",
                "screensaver Videorc"
            ]
        );
    }

    #[test]
    fn a_refusing_portal_falls_back_but_is_asked_again_next_time() {
        let mut inhibitor = LinuxSleepInhibitor::new(FakeBus {
            portal_fails: true,
            ..FakeBus::default()
        });
        inhibitor.start().unwrap();
        assert_eq!(inhibitor.route(), InhibitRoute::ScreenSaver);
        assert_eq!(inhibitor.last_error(), None);
        inhibitor.start().unwrap();
        let portal_calls = inhibitor
            .bus()
            .calls
            .iter()
            .filter(|call| call.starts_with("portal"))
            .count();
        assert_eq!(portal_calls, 2);
    }

    #[test]
    fn says_why_when_nothing_holds_the_display() {
        let mut inhibitor = LinuxSleepInhibitor::new(FakeBus {
            portal_fails: true,
            no_screensaver: true,
            ..FakeBus::default()
        });
        assert_eq!(inhibitor.start(), None);
        assert_eq!(inhibitor.route(), InhibitRoute::None);
        assert_eq!(
            inhibitor.last_error(),
            Some("Inhibit portal: denied; no Inhibit portal and no ScreenSaver service")
        );
    }

    #[test]
    fn keeps_a_failed_release_for_diagnostics_and_forgets_the_hold() {
        let mut inhibitor = LinuxSleepInhibitor::new(FakeBus {
            release_fails: true,
            ..FakeBus::default()
        });
        let id = inhibitor.start().unwrap();
        inhibitor.stop(id);
        assert_eq!(inhibitor.holding(), 0);
        assert_eq!(inhibitor.last_error(), Some("release: gone"));
        // An id never handed out does nothing.
        inhibitor.stop(99);
        assert_eq!(inhibitor.bus().calls.len(), 2);
    }

    #[test]
    fn the_guard_holds_while_a_session_writes_and_releases_after() {
        let inhibitor = Rc::new(RefCell::new(LinuxSleepInhibitor::new(FakeBus::default())));
        let mut guard = linux_sleep_guard(Rc::clone(&inhibitor));
        guard.update(MainCaptureState::Recording);
        guard.update(MainCaptureState::Streaming);
        assert!(guard.holding());
        assert_eq!(inhibitor.borrow().holding(), 1);
        guard.update(MainCaptureState::Idle);
        assert!(!guard.holding());
        assert_eq!(inhibitor.borrow().holding(), 0);
        guard.update(MainCaptureState::Starting);
        guard.release();
        assert_eq!(
            inhibitor.borrow().bus().calls,
            [
                "portal 12 Videorc is recording or streaming",
                "close /request/1",
                "portal 12 Videorc is recording or streaming",
                "close /request/2"
            ]
        );
    }
}
