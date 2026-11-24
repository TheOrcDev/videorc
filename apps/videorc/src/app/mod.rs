//! The app's own modules (lane L4): the command line, the store bridge, the
//! main window's shell, and S2.6a's menu bar, links and sleep guard. The
//! preview's GPUI side (`src/preview/`, L1) and the smoke UI driver
//! (`src/smoke/`, L6) join as their slices land.

pub mod args;
pub mod bridge;
pub mod links;
pub mod menus;
pub mod shell;
pub mod sleep;
