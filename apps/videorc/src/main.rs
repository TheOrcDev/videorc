//! The `Videorc` binary on GPUI: windows, screens, the preview element's GPUI side, OS integration, the smoke UI driver. It replaces the Electron shell (`apps/desktop`) on macOS, Windows and Linux at the switch (D8).
//!
//! Empty until plan 260 S2.1. Plan 260 S1.0 created it.

// Plan 260 S2.5 (L6): the smoke command server and the UI driver. S2.1 (L4)
// starts it from the shell (`smoke::start`); until then nothing calls it.
#[allow(dead_code)]
mod smoke;

fn main() {}
