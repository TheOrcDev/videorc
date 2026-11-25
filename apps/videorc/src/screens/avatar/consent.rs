//! The account and cloud AI pieces the Avatar page's gates read
//! (`buddyAliveCreateGate`, `buddyLookCreateGate`), and the consent dialog
//! an "Allow cloud AI" action opens (`CloudAiConsentDialog`).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use serde_json::Value;
use videorc_app_core::stream_manager::buddy::{CLOUD_AI_KEEPS, cloud_ai_uses};
use videorc_app_core::studio::families;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::Dialog;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::gate::{ALLOW_CLOUD_AI, GateInput};
use super::{AvatarScreen, sync_handle};
use videorc_app_core::account::entitlements::{EntitlementGate, live_cohost_gate, read_snapshot};

impl AvatarScreen {
    /// `account.get`'s answer: signed in.
    pub(super) fn account_answered(&mut self, account: &Value) {
        self.signed_in = account.get("status").and_then(Value::as_str) == Some("signed-in");
    }

    /// `entitlements.get`'s answer: Premium (`liveCohostGate`) and, when
    /// the reason sells Premium, its page. `account.get` carries neither.
    pub(super) fn entitlements_answered(&mut self, entitlements: &Value) {
        let snapshot = read_snapshot(entitlements);
        let gate = live_cohost_gate(snapshot.as_ref());
        self.entitled = gate.allowed();
        self.upgrade_url = match gate {
            EntitlementGate::Locked {
                upgrade_url: Some(url),
                ..
            } => Some(url.to_string()),
            _ => None,
        };
    }

    /// What the create gates read.
    pub(super) fn gate_input(&self) -> GateInput<'_> {
        GateInput {
            signed_in: self.signed_in,
            entitled: self.entitled,
            upgrade_url: self.upgrade_url.as_deref(),
            consented: self.consented,
            capabilities: self.capabilities.as_ref(),
        }
    }

    /// `cohost.buddyLibrary.alive`: the web keeps imports and Alive packs.
    pub(super) fn library_alive(&self) -> bool {
        self.capabilities
            .as_ref()
            .and_then(|caps| caps.pointer("/cohost/buddyLibrary/alive"))
            .and_then(Value::as_bool)
            == Some(true)
    }

    pub(super) fn open_consent(&mut self, cx: &mut Context<Self>) {
        self.consent_want_open = true;
        cx.notify();
    }

    /// Accepting grants cloud AI; declining changes nothing.
    fn answer_consent(&mut self, accepted: bool, cx: &mut Context<Self>) {
        self.consent_want_open = false;
        if accepted {
            self.consented = true;
            let studio = self.studio.clone();
            self.runtime.spawn(async move {
                let _ = studio
                    .write_settings(vec![families::write_ai_consent(true)])
                    .await;
            });
        }
        cx.notify();
    }

    pub(super) fn sync_consent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        sync_handle(
            &self.consent_handle,
            &mut self.consent_want_open,
            &mut self.consent_was_open,
            window,
            cx,
        );
    }
}

pub(super) fn consent_dialog(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let (decline, accept) = (entity.clone(), entity);
    let mut uses = div().flex().flex_col().gap(px(4.)).pl(px(16.));
    for line in cloud_ai_uses() {
        uses = uses.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(format!("• {line}")),
        );
    }
    Dialog::new(
        "avatar-cloud-ai-consent",
        &screen.consent_handle,
        ALLOW_CLOUD_AI,
    )
    .description(CLOUD_AI_KEEPS)
    .close_button(false)
    .child(uses)
    .footer(
        Button::new("avatar-consent-not-now")
            .variant(ButtonVariant::Ghost)
            .label("Not now")
            .on_click(move |_, _, cx| {
                decline.update(cx, |screen, cx| screen.answer_consent(false, cx))
            }),
    )
    .footer(
        Button::new("avatar-consent-allow")
            .label(ALLOW_CLOUD_AI)
            .on_click(move |_, _, cx| {
                accept.update(cx, |screen, cx| screen.answer_consent(true, cx))
            }),
    )
    .into_any_element()
}
