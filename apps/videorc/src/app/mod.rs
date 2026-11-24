//! The app's own modules (lane L4): the command line, the store bridge, the
//! main window's shell, and S2.6a's menu bar, global shortcuts, links,
//! capture state, sleep guard, permissions, Videorc Camera, the saved
//! window frame, Hide from stream and the quit while on air. The
//! preview's GPUI side (`src/preview/`, L1) and the smoke UI driver
//! (`src/smoke/`, L6) join as their slices land. The Studio page's session
//! controls (S2.4, lane L7) drive the core's Studio.

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
pub mod session;
pub mod shell;
pub mod sleep;
