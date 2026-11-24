//! The Notes window (plan 260 Phase 3, lane L7): the private teleprompter
//! (`components/notes-window.tsx`) on GPUI.
//!
//! - `frame`: the saved frame and open bit in `notes-window.json`.
//! - `document`: text, font scale and save words (Electron's
//!   `notes-persistence.ts`).
//! - `window`: WindowFrame, the textarea, status bar, Keep on top.

pub mod document;
pub mod frame;
pub mod window;
