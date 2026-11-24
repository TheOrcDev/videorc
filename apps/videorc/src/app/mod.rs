//! The app's own modules (lane L4): the command line, the store bridge and
//! the main window's shell. The preview's GPUI side (`src/preview/`, L1), the
//! platforms (`src/platform/`) and the smoke UI driver (`src/smoke/`, L6)
//! join as their slices land.

pub mod args;
pub mod bridge;
pub mod shell;
