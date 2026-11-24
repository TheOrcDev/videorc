//! Images page (⇧⌘G; Electron `tabs/assets-tab.tsx`, banners and takeovers):
//! words and pure view helpers for Backgrounds, Banners and Takeovers.
//! Plan 260 Phase 3: the GPUI screen draws these; the backend owns files.

pub mod copy;
pub mod view;

pub use copy::*;
pub use view::*;
