//! ConfirmDialog on the kit's Dialog: "Verb object?", one sentence that
//! names what is lost, Ghost Cancel (Escape), and a Destructive confirm.
//! No close button — the two answers are the only way out.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::Dialog;

use super::{ConfirmRequest, ConfirmVariant, DialogsHost};

impl DialogsHost {
    pub(super) fn confirm_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(question) = self.confirm_question.clone() else {
            return div().into_any_element();
        };
        let pending = self.confirm_pending;
        let cancel = question.cancel_label.clone();
        let confirm = if pending {
            question
                .pending_label
                .clone()
                .unwrap_or_else(|| question.confirm_label.clone())
        } else {
            question.confirm_label.clone()
        };
        let variant = match question.confirm_variant {
            ConfirmVariant::Destructive => ButtonVariant::Destructive,
            ConfirmVariant::Default => ButtonVariant::Default,
        };
        Dialog::new("shell-confirm", &self.confirm, question.title)
            .description(question.description)
            .close_button(false)
            .footer(
                Button::new("shell-confirm-cancel")
                    .label(cancel)
                    .variant(ButtonVariant::Ghost)
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, window, cx| this.cancel_confirm(window, cx))),
            )
            .footer(
                Button::new("shell-confirm-action")
                    .label(confirm)
                    .variant(variant)
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, window, cx| this.run_confirm(window, cx))),
            )
            .into_any_element()
    }

    /// Opens the ConfirmDialog recipe. `on_confirm` runs once when the
    /// destructive (or default) answer is chosen. A sync action should call
    /// [`Self::finish_confirm`]; an async one calls
    /// [`Self::set_confirm_pending`]`(true)` and finishes when it settles.
    pub fn ask_confirm(
        &mut self,
        question: ConfirmRequest,
        on_confirm: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.confirm_question = Some(question);
        self.confirm_pending = false;
        self.confirm_action = Some(Box::new(on_confirm));
        self.confirm_was_open = false;
        self.confirm.open(window, cx);
        self.confirm_was_open = true;
        cx.notify();
    }

    pub fn set_confirm_pending(&mut self, pending: bool, cx: &mut Context<Self>) {
        self.confirm_pending = pending;
        cx.notify();
    }

    /// Closes the confirm after a finished action (or a cancel).
    pub fn finish_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.confirm_pending = false;
        self.confirm_question = None;
        self.confirm_action = None;
        self.confirm_was_open = false;
        if self.confirm.is_open() {
            self.confirm.close(window, cx);
        }
        cx.notify();
    }

    pub(super) fn cancel_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.confirm_pending {
            return;
        }
        self.finish_confirm(window, cx);
    }

    pub(super) fn run_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.confirm_pending || !self.confirm.is_open() {
            return;
        }
        let Some(action) = self.confirm_action.take() else {
            return;
        };
        action(self, window, cx);
        if self.confirm_pending {
            // Async: the owner finishes later.
            return;
        }
        if self.confirm_question.is_some() {
            // Sync action that did not finish: close now (Settings style).
            self.finish_confirm(window, cx);
        }
    }

    /// Escape / backdrop: same as Cancel when nothing is pending.
    pub(super) fn sync_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self.confirm.is_open();
        if self.confirm_was_open && !open {
            self.confirm_was_open = false;
            if !self.confirm_pending {
                self.confirm_question = None;
                self.confirm_action = None;
                cx.notify();
            } else {
                // Keep the sheet while the action runs.
                self.confirm.open(window, cx);
                self.confirm_was_open = true;
            }
        } else if open {
            self.confirm_was_open = true;
        }
    }
}
