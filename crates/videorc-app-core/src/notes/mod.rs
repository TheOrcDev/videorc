//! Notes teleprompter window (⇧⌘N; Electron `notes-window.tsx`): words and
//! pure helpers for the GPUI screen. Plan 260 Phase 3: the screen draws
//! these with the kit; prefs live in `notes-window.json`.

pub mod copy;
pub mod view;

pub use copy::*;
pub use view::*;
