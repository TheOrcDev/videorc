//! Electron's update rules in Rust, on today's feed format (plan 220 P5-D3),
//! for the GPUI app's second feed (P5-D6).
//!
//! Lifted from the plan 220 port (`videorc-rust:crates/videorc-updater`,
//! last changed 2026-11-15; Electron's updater files have not changed
//! since) with its tests, plus the sidebar chip's rules and the second
//! feed's addresses. Like the port, the crate has no network, no clock and
//! no window of its own: the app gives it the requests, the timer and the
//! helper's executable (`videorc_app_core::updater::feed` and the app's
//! `app/updater.rs`, plan 260 S5.2).
//!
//! - [`status`]: the status a streamer sees, and when the app checks again
//!   (`updater-status.ts`).
//! - [`install`]: an update installs only when nothing records or streams,
//!   and only under the backend's interruption lease (`updater-install.ts`).
//! - [`mirror`]: the feed's two routes and which failures are tried again
//!   on the second (`updater-mirror.ts`, by kind of failure).
//! - [`second_feed`]: where the GPUI app's own feed is (P5-D6), so an old
//!   Electron install can never skip the bridge release.
//! - [`feed`]: the update-info file (`latest-mac.yml`, `latest.yml`),
//!   which file to take, whether a version is newer, and the size and
//!   SHA-512 check of what was downloaded.
//! - [`flow`]: one check and one download in the order `updater.ts` does
//!   them, with the mirror fallback and, on Windows, the pilot feed after
//!   the public one, over a [`flow::Transport`] that makes the requests.
//! - `signature` (macOS): whether a downloaded bundle is signed as this one
//!   is, by the same team for the same bundle id.
//! - `macos_install` (macOS): whether this copy of the app can be replaced
//!   where it is, the unpacking of the update's zip, the version the
//!   unpacked app says it is, and the swap, with its way back.
//! - `macos_apply` (macOS): what the helper does once the app has quit: it
//!   waits for the app to be gone, checks the unpacked app once more, swaps
//!   it in and opens the app again.
//! - [`linux_notice`]: Linux never updates itself; it learns from the
//!   public changelog that a newer release is out
//!   (`linux-update-notice.ts`).
//! - [`windows_pilot`]: who may read the Windows pilot feed, and when it is
//!   asked (`windows-pilot-update.ts`).
//! - [`windows_signature`]: whether a downloaded installer is signed by
//!   Videorc's publisher (`updater-signature.ts`); the run through
//!   PowerShell itself is compiled on Windows only.
//! - [`log`]: the updater's last lines, for the support bundle
//!   (`updater-log.ts`).
//! - [`launch`]: when the updater checks by itself, and what each request
//!   from Settings may do (the decisions of `updater.ts`).
//! - [`about_view`]: Settings → About's update row in each state
//!   (`about-update-view.ts`, P1430, P1431, P1555).
//! - [`chip`]: the sidebar's update chip (`update-ui.ts`, P021).
//!
//! `updater-config-file.ts` is not ported: it reads a file
//! `electron-builder` writes; the GPUI app's feed address is compiled in
//! ([`second_feed`]). The map of calls is `README.md` beside this crate.

pub mod about_view;
pub mod chip;
pub mod feed;
pub mod flow;
pub mod install;
pub mod launch;
pub mod linux_notice;
pub mod log;
#[cfg(target_os = "macos")]
pub mod macos_apply;
#[cfg(target_os = "macos")]
pub mod macos_install;
pub mod mirror;
pub mod second_feed;
#[cfg(target_os = "macos")]
pub mod signature;
pub mod status;
pub mod windows_pilot;
pub mod windows_signature;
