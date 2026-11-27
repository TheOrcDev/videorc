//! Shell-hosted dialogs (plan 260 Phase 3, L3): End livestream, ConfirmDialog
//! delete/remove questions, and start-blocked refusals. Built on the kit's
//! Dialog. Go Live stays with Destinations (G23h6).
//!
//! Mounted by the shell over every page, as Electron's `EndLivestreamDialog`
//! and the confirm recipe are.

mod confirm;
#[allow(
    dead_code,
    reason = "Confirmation copy recipes retained for pending screen parity wiring"
)]
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

/// Runs a Dialog's `on_open_change` work on its owner once the current
/// update ends. The handle's `close()` calls `on_open_change` synchronously,
/// and an owner usually closes its own dialog from inside its own update (a
/// Cancel listener, a spawned job's `update_in`): updating the owner there
/// again is gpui's double-lease panic (the owner's screen-picker crash,
/// 2026-11-27). Every `on_open_change` that touches its owner goes through
/// here; `on_open_change_defers_its_owner_update` guards it.
pub fn after_open_change<T: 'static>(
    owner: &gpui::WeakEntity<T>,
    window: &Window,
    cx: &mut gpui::App,
    change: impl FnOnce(&mut T, &mut Window, &mut Context<T>) + 'static,
) {
    let owner = owner.clone();
    window.defer(cx, move |window, cx| {
        let _ = owner.update(cx, |owner, cx| change(owner, window, cx));
    });
}

/// ConfirmDialog's destructive vs consequential (replace) answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmVariant {
    Destructive,
    #[allow(
        dead_code,
        reason = "Consequential confirmation style retained beside destructive dialogs"
    )]
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

#[cfg(test)]
mod open_change_guard {
    use std::path::{Path, PathBuf};

    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// The Dialog callback: `on_open_change(` up to the first `})` that
    /// closes it, at most 16 lines.
    fn callback(lines: &[&str], start: usize) -> String {
        let indent = lines[start].len() - lines[start].trim_start().len();
        let mut body = String::new();
        for line in lines.iter().skip(start).take(16) {
            body.push_str(line);
            body.push('\n');
            let trimmed = line.trim_start();
            if body.lines().count() > 1
                && line.len() - trimmed.len() == indent
                && trimmed.starts_with("})")
            {
                break;
            }
        }
        body
    }

    /// The owner's screen-picker crash (2026-11-27): a Dialog's
    /// `on_open_change` that updates its owner in place panics with gpui's
    /// double lease when the owner closes the dialog from its own update.
    /// Each Dialog callback (four arguments: open, reason, window, cx) that
    /// updates an entity defers it ([`super::after_open_change`] or a
    /// `defer`). Popover callbacks take three and are not Dialogs.
    #[test]
    fn on_open_change_defers_its_owner_update() {
        let mut files = Vec::new();
        sources(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let dialog_callback = |text: &str| {
            text.lines().take(3).any(|line| {
                line.split('|')
                    .nth(1)
                    .is_some_and(|args| args.split(',').count() == 4)
            })
        };
        let mut checked = 0;
        let mut offenders = Vec::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if !line.trim_start().starts_with(".on_open_change(") {
                    continue;
                }
                let body = callback(&lines, index);
                if !dialog_callback(&body) {
                    continue;
                }
                checked += 1;
                if body.contains(".update(cx")
                    && !body.contains("after_open_change(")
                    && !body.contains("defer(")
                {
                    offenders.push(format!("{}:{}", file.display(), index + 1));
                }
            }
        }
        assert!(checked >= 13, "found only {checked} Dialog callbacks");
        assert!(
            offenders.is_empty(),
            "Dialog on_open_change updates its owner in place (double lease): {offenders:?}"
        );
    }
}
