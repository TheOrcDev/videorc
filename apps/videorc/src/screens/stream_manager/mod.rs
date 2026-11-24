//! The Stream Manager (plan 260 Phase 3, lane L7): the live dashboard's
//! window, `components/stream-manager/stream-manager.tsx` on GPUI.
//!
//! - `layout`: the tiers and where each pane sits (`stream-manager-layout.ts`).
//! - `panes`: the tabs' picks and what moves them (⌘J, ⌘F, ⌘L, Sidekick's
//!   cards).
//! - `frame`: the saved frame in `comments-window.json`.
//! - `window`: the window and its view.
//!
//! The core's views (`videorc_app_core::stream_manager`) hold the rows, the
//! filters and the copy; the kit draws them.

pub mod frame;
pub mod layout;
pub mod panes;
pub mod window;
