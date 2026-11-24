//! The Linux desktop shell's framework-free policy (plan 260 S2.6c, L5): the
//! `.desktop` entry that registers `videorc://`, plan 257's setup alerts
//! (what this desktop is missing, in Electron's words), global shortcuts
//! through the GlobalShortcuts portal, the sleep guard's Inhibit blocker and
//! tokens in the Secret Service. The IO and D-Bus calls live in
//! `apps/videorc/src/platform/` (S2.1); here they are traits with fakes.

pub mod desktop_entry;
pub mod portal_shortcuts;
pub mod secret_store;
pub mod setup;
pub mod sleep_inhibit;
