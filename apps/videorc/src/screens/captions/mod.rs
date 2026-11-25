//! Captions ⌘4 and the Captions reader (plan 260 Phase 3, L2): the page,
//! the reader window, and the caption feed both read.
//!
//! - `feed`: the lines, the plan's lock, and captions starting and
//!   stopping with a session.
//! - `burn`: the caption bar on the stream and the recording.
//! - `page`: the caption preview, Live captions and the host transcript.
//! - `reader`: the ⇧⌘C window.

pub mod burn;
pub mod feed;
pub mod page;
pub mod reader;

use gpui::{App, AppContext, Entity, Global};

/// The backend events the caption feed reads: the main client's include
/// list must carry them, or the page, the reader and the caption bar on the
/// outputs never hear a line (`overlays.layout` rides with the chat's list).
pub const EVENTS: [&str; 3] = [
    videorc_app_core::captions::methods::UPDATE_EVENT,
    videorc_app_core::captions::methods::CLEARED_EVENT,
    videorc_app_core::captions::methods::ENTITLEMENTS_EVENT,
];
use std::sync::Arc;

/// The page, built once with the feed, for the main window's shell.
pub struct PageGlobal(pub Entity<page::CaptionsPanel>);

impl Global for PageGlobal {}

/// The feed and the page. Call once, before the main window opens.
pub fn install(studio: Arc<feed::AppStudio>, runtime: tokio::runtime::Handle, cx: &mut App) {
    let feed = feed::install(studio, runtime.clone(), cx);
    let page = cx.new(|cx| page::CaptionsPanel::new(feed, runtime, cx));
    cx.set_global(PageGlobal(page));
}

/// The page, once [`install`] ran.
pub fn page(cx: &App) -> Option<Entity<page::CaptionsPanel>> {
    cx.try_global::<PageGlobal>().map(|global| global.0.clone())
}
