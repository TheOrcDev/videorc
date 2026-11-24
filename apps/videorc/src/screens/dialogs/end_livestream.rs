//! End livestream on the kit's Dialog (P1436–P1439). Hosted by the shell so
//! a stop from any page asks the same question. "Keep streaming" is Escape;
//! no close button. A managed cloud show may offer the hand-off answer.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use videorc_app_core::livestream::cloud_show::{
    hand_off_label, hand_off_question_body, offers_hand_off,
};
use videorc_app_core::studio::session::{
    KEEP_STREAMING_LABEL, end_livestream_body, end_livestream_confirm_label, end_livestream_title,
};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};

use super::DialogsHost;

impl DialogsHost {
    pub(super) fn end_livestream_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(question) = self.controls.read(cx).value().stop_question.clone() else {
            return div().into_any_element();
        };
        let hand_off = offers_hand_off(self.studio.cloud_now().status.as_ref());
        let title = end_livestream_title(question.origin);
        let body = if hand_off {
            hand_off_question_body(&question)
        } else {
            end_livestream_body(&question)
        };
        let confirm = end_livestream_confirm_label(question.origin);
        let size = if hand_off {
            DialogSize::Lg
        } else {
            DialogSize::Md
        };

        let mut dialog = Dialog::new("end-livestream", &self.end, title)
            .description(body)
            .size(size)
            .close_button(false)
            .footer(
                Button::new("end-livestream-cancel")
                    .label(KEEP_STREAMING_LABEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.keep_streaming(window, cx);
                    })),
            );
        if hand_off {
            dialog = dialog.footer(
                Button::new("end-livestream-hand-off")
                    .label(hand_off_label(question.origin))
                    .variant(ButtonVariant::Secondary)
                    .on_click(cx.listener(|this, _, window, cx| this.hand_off(window, cx))),
            );
        }
        dialog
            .footer(
                Button::new("end-livestream-confirm")
                    .label(confirm)
                    .variant(ButtonVariant::Destructive)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.end_livestream(window, cx);
                    })),
            )
            .into_any_element()
    }

    pub(super) fn keep_streaming(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.end_was_open = false;
        if self.end.is_open() {
            self.end.close(window, cx);
        }
        self.studio.cancel_stop();
        cx.notify();
    }

    pub(super) fn end_livestream(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.end_was_open = false;
        if self.end.is_open() {
            self.end.close(window, cx);
        }
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let (answered, _) = studio.confirm_stop().await;
            eprintln!("[videorc-app] End livestream: answered {answered}");
        });
        cx.notify();
    }

    pub(super) fn hand_off(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.end_was_open = false;
        if self.end.is_open() {
            self.end.close(window, cx);
        }
        // Clear the question without ending; the hand-off stops the feed.
        self.studio.cancel_stop();
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let ok = studio.hand_off_cloud_show().await;
            eprintln!("[videorc-app] Hand off livestream: confirmed={ok}");
        });
        cx.notify();
    }

    /// Opens when the core asks; Escape / backdrop keeps streaming.
    pub(super) fn sync_end_livestream(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let waiting = self.controls.read(cx).value().stop_question.is_some();
        let open = self.end.is_open();
        match (waiting, open, self.end_was_open) {
            (true, false, false) => {
                self.end.open(window, cx);
                self.end_was_open = true;
            }
            (true, false, true) => {
                // Dismissed without an answer button.
                self.end_was_open = false;
                self.studio.cancel_stop();
            }
            (false, true, _) => {
                self.end.close(window, cx);
                self.end_was_open = false;
            }
            (true, true, _) => self.end_was_open = true,
            (false, false, _) => self.end_was_open = false,
        }
    }
}
