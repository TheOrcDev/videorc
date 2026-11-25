//! The Stream Manager (plan 260 Phase 3, lane L7): the live dashboard's
//! window, `components/stream-manager/stream-manager.tsx` on GPUI.
//!
//! - `layout`: the tiers and where each pane sits (`stream-manager-layout.ts`).
//! - `panes`: the tabs' picks and what moves them (⌘J, ⌘F, ⌘L, Sidekick's
//!   cards).
//! - `frame`: the saved frame in `comments-window.json`.
//! - `window`: the window and its view.
//! - `stats` / `chat` / `activity` / `sidekick` / `status`: the kit-drawn
//!   regions (header via `WindowHeader`, stats bar, panes, status bar).
//!
//! The core's views (`videorc_app_core::stream_manager`) hold the rows, the
//! filters and the copy; the kit draws them.

use std::sync::Arc;

use videorc_app_core::{BackendClient, Studio};

pub mod activity;
pub mod chat;
pub mod frame;
pub mod layout;
pub mod panes;
pub mod rows;
pub mod sidekick;
pub mod stats;
pub mod status;
pub mod window;

pub type AppStudio = Studio<BackendClient>;

pub type SharedStudio = Arc<AppStudio>;
