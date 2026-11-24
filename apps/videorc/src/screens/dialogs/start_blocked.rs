//! Start-blocked questions on the kit's Dialog. Electron shows these as the
//! `session-start-blocked` toast (and the Go Live "no destination" toast with
//! an Open Destinations action). The shell hosts the same words as a dialog
//! so a palette or hotkey refusal has a place to land over any page.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use videorc_app_core::livestream::go_live_copy::{
    GO_LIVE_NO_DESTINATION_TITLE, OPEN_DESTINATIONS_LABEL,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::start_blocked_copy;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::Dialog;

use super::{DialogsHost, OpenPage, StartBlocked};

impl DialogsHost {
    pub(super) fn start_blocked_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(blocked) = self.start_blocked.clone() else {
            return div().into_any_element();
        };
        let mut dialog =
            Dialog::new("start-blocked", &self.blocked, blocked.title.clone()).close_button(false);
        if let Some(description) = blocked.description.clone() {
            dialog = dialog.description(description);
        }
        if let Some(jump) = blocked.jump {
            dialog = dialog.footer(
                Button::new("start-blocked-jump")
                    .label(jump.label)
                    .variant(ButtonVariant::Secondary)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.dismiss_start_blocked(window, cx);
                        cx.emit(OpenPage(jump.page));
                    })),
            );
        }
        dialog
            .footer(
                Button::new("start-blocked-ok")
                    .label("OK")
                    .variant(ButtonVariant::Default)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dismiss_start_blocked(window, cx);
                    })),
            )
            .into_any_element()
    }

    /// Opens the start-blocked dialog with the given reason (exact Electron
    /// `START_BLOCKED_COPY` / connection / Go Live words).
    pub fn ask_start_blocked(
        &mut self,
        reason: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let reason = reason.into();
        let blocked = start_blocked_from_reason(&reason);
        self.pending_start_blocked = None;
        self.start_blocked = Some(blocked);
        self.blocked_was_open = false;
        self.blocked.open(window, cx);
        self.blocked_was_open = true;
        cx.notify();
    }

    /// Queues a start-blocked dialog for the next frame (async callers that
    /// have no `Window` yet: the palette, a hotkey).
    pub fn queue_start_blocked(&mut self, reason: impl Into<String>, cx: &mut Context<Self>) {
        self.pending_start_blocked = Some(reason.into());
        cx.notify();
    }

    pub fn dismiss_start_blocked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start_blocked = None;
        self.pending_start_blocked = None;
        self.blocked_was_open = false;
        if self.blocked.is_open() {
            self.blocked.close(window, cx);
        }
        cx.notify();
    }

    pub(super) fn sync_start_blocked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reason) = self.pending_start_blocked.take() {
            self.ask_start_blocked(reason, window, cx);
            return;
        }
        let open = self.blocked.is_open();
        if self.blocked_was_open && !open {
            self.blocked_was_open = false;
            self.start_blocked = None;
            cx.notify();
        } else if open {
            self.blocked_was_open = true;
        }
    }
}

/// Maps a refused-start reason to the dialog's title, optional body, and jump.
fn start_blocked_from_reason(reason: &str) -> StartBlocked {
    if reason == GO_LIVE_NO_DESTINATION_TITLE
        || reason == start_blocked_copy::NO_DESTINATION
        || reason == start_blocked_copy::DESTINATION_SETUP
    {
        return StartBlocked {
            title: reason.into(),
            description: None,
            jump: Some(super::StartBlockedJump {
                label: OPEN_DESTINATIONS_LABEL,
                page: PageId::Live,
            }),
        };
    }
    StartBlocked {
        title: reason.into(),
        description: None,
        jump: None,
    }
}
