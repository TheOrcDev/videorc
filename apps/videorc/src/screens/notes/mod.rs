//! The Notes window (plan 260 Phase 3, lane L7): the private teleprompter
//! (`components/notes-window.tsx`) on GPUI, drawn from
//! `videorc_app_core::notes` and the kit.
//!
//! - `frame`: the saved frame and open bit in `notes-window.json`.
//! - `window`: WindowFrame, kit Textarea, status bar, Keep on top.

pub mod frame;
pub mod window;
