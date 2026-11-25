//! Electron's update rules in Rust, on today's feed format (plan 220 P5-D3),
//! for the GPUI app's second feed (P5-D6).
//!
//! The rules the UI reads, lifted from the plan 220 port
//! (`videorc-rust:crates/videorc-updater`) with their tests, plus the
//! sidebar chip's:
//!
//! - [`status`]: the status a streamer sees, and when the app checks again
//!   (`updater-status.ts`).
//! - [`about_view`]: Settings → About's update row in each state
//!   (`about-update-view.ts`, P1430, P1431, P1555).
//! - [`chip`]: the sidebar's update chip (`update-ui.ts`, P021).
//! - [`install`]: an update installs only when nothing records or streams,
//!   and only under the backend's interruption lease (`updater-install.ts`).
//!
//! Not here yet (plan 260 S1.7 and S5.2, L2): the feed file and its
//! integrity check, the mirror route, the check and download flow, the
//! Windows pilot feed and signature, the macOS install and swap, the Linux
//! notice and the updater's log. The plan 220 port has them; they land with
//! the feed, which this crate must not reach until then.

pub mod about_view;
pub mod chip;
pub mod install;
pub mod status;
