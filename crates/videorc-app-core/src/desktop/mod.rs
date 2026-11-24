//! The desktop shell's framework-free policy: the menu model, macOS
//! permissions (TCC) and the relaunch after a grant, grant watching, the
//! single-instance lock, the sleep guard, system access (the macOS privacy
//! panes and the backend's checks) and Videorc Camera's activation. Each
//! GPUI call is in `apps/videorc/src/platform/`. Plan 260 S1.6s (L4), with
//! the global shortcuts (S1.6f).

pub mod accelerator;
pub mod camera_extension;
pub mod capture_protection;
pub mod capture_state;
pub mod deep_link;
pub mod global_shortcuts;
pub mod grant_watch;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod menu;
pub mod permission_restart;
pub mod permissions;
pub mod single_instance;
pub mod sleep_guard;
pub mod system_access;
