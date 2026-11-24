//! Shell-hosted dialogs (plan 260 Phase 3, L3): End livestream, ConfirmDialog
//! delete/remove questions, and start-blocked refusals. Built on the kit's
//! Dialog. Go Live stays with Destinations (G23h6).
//!
//! Mounted by the shell over every page, as Electron's `EndLivestreamDialog`
//! and the confirm recipe are.

mod confirm;
pub mod copy;
mod end_livestream;
mod start_blocked;

use std::sync::Arc;

use gpui::{Context, Entity, EventEmitter, Window, div, prelude::*};
use videorc_app_core::nav::PageId;
use videorc_kit::dialog::DialogHandle;

use crate::app::bridge::Mirror;
use crate::screens::studio::transport::{AppStudio, SessionControls};

/// Opens a page from a dialog jump (start-blocked → Destinations).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPage(pub PageId);

impl EventEmitter<OpenPage> for DialogsHost {}

/// ConfirmDialog's destructive vs consequential (replace) answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmVariant {
    Destructive,
    Default,
}

/// One ConfirmDialog question (exact Electron props).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmRequest {
    pub title: String,
    pub description: String,
    pub cancel_label: String,
    pub confirm_label: String,
    pub confirm_variant: ConfirmVariant,
    /// While the action runs (`"Deleting…"`); falls back to `confirm_label`.
    pub pending_label: Option<String>,
}

/// A jump beside OK on a start-blocked dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartBlockedJump {
    pub label: &'static str,
    pub page: PageId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartBlocked {
    pub title: String,
    pub description: Option<String>,
    pub jump: Option<StartBlockedJump>,
}

type ConfirmAction = Box<dyn FnOnce(&mut DialogsHost, &mut Window, &mut Context<DialogsHost>)>;

/// The shell's dialog host: End livestream, Confirm, start-blocked.
pub struct DialogsHost {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    controls: Entity<Mirror<SessionControls>>,
    end: DialogHandle,
    end_was_open: bool,
    confirm: DialogHandle,
    confirm_was_open: bool,
    confirm_question: Option<ConfirmRequest>,
    confirm_pending: bool,
    confirm_action: Option<ConfirmAction>,
    blocked: DialogHandle,
    blocked_was_open: bool,
    start_blocked: Option<StartBlocked>,
    /// Set from an async refusal; [`sync_start_blocked`] opens it with a window.
    pending_start_blocked: Option<String>,
}

impl DialogsHost {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        controls: Entity<Mirror<SessionControls>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&controls, |_, _, cx| cx.notify()).detach();
        Self {
            studio,
            runtime,
            controls,
            end: DialogHandle::new(false),
            end_was_open: false,
            confirm: DialogHandle::new(false),
            confirm_was_open: false,
            confirm_question: None,
            confirm_pending: false,
            confirm_action: None,
            blocked: DialogHandle::new(false),
            blocked_was_open: false,
            start_blocked: None,
            pending_start_blocked: None,
        }
    }
}

impl Render for DialogsHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_end_livestream(window, cx);
        self.sync_confirm(window, cx);
        self.sync_start_blocked(window, cx);
        div()
            .child(self.end_livestream_dialog(cx))
            .child(self.confirm_dialog(cx))
            .child(self.start_blocked_dialog(cx))
    }
}
