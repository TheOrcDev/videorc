//! The desktop shell's framework-free policy: the menu model, macOS
//! permissions (TCC) and the relaunch after a grant, grant watching, and the
//! single-instance lock. Each GPUI call is in `apps/videorc/src/platform/`.
//! Plan 260 S1.6s (L4); the rest of `videorc-rust`'s `desktop/` (deep links,
//! global shortcuts, Videorc Camera, the sleep guard, system access, and
//! capture state's protocol constructors) follows once the typed client (S1.1) and the Studio areas land.

pub mod capture_state;
pub mod grant_watch;
pub mod menu;
pub mod permission_restart;
pub mod permissions;
pub mod single_instance;
