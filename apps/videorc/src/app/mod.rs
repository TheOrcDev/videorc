//! The app's own modules (lane L4): the command line, the store bridge, the
//! main window's shell, and S2.6a's menu bar, global shortcuts, links,
//! capture state, sleep guard, permissions, Videorc Camera, the saved
//! window frame, Hide from stream and the quit while on air. The
//! preview's GPUI side (`src/preview/`, L1) and the smoke UI driver
//! (`src/smoke/`, L6) join as their slices land. Phase 3 screens live
//! under [`crate::screens`].

pub mod account_menu;
pub mod accounts;
pub mod args;
pub mod bridge;
pub mod camera;
pub mod capture;
pub mod exit;
pub mod frames;
pub mod hide;
pub mod hotkeys;
pub mod links;
pub mod menus;
pub mod permissions;
pub mod shell;
pub mod sleep;
#[cfg(target_os = "macos")]
pub mod speech;
