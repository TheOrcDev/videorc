//! The Linux desktop shell's framework-free policy (plan 260 S2.6c, L5): the
//! `.desktop` entry that registers `videorc://`, and plan 257's setup alerts
//! (what this desktop is missing, in Electron's words). The IO and D-Bus
//! calls live in `apps/videorc/src/platform/` (S2.1).

pub mod desktop_entry;
pub mod setup;
