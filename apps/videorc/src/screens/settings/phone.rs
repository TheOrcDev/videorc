//! Phone remote: rename paired phones, and Pair a phone… (P1413–P1416)
//! with the kit's [`videorc_kit::qr_code::QrCode`].

use super::*;
use crate::screens::dialogs::after_open_change;
use gpui::{AnyElement, AppContext, ClipboardItem};
use videorc_app_core::settings_page::remote::{
    PAIRING_TROUBLE_HINT_AFTER_MS, PHONE_NAME_MAX_CHARS, RemoteLanDevice, RemoteLanPairing,
    format_countdown, pairing_seconds_left, renamed_phone_name,
};
use videorc_kit::{
    alert::Alert,
    button::{Button, ButtonVariant},
    dialog::{Dialog, DialogSize},
    icon::{IconName, icon},
    input::{Input, InputState},
    qr_code::QrCode,
    segmented_control::{Segment, SegmentedControl},
    theme::{self, TypeScale, hsla},
    tokens::{radius, text},
};

impl SettingsScreen {
    pub(super) fn rename_phone(
        &mut self,
        phone: RemoteLanDevice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx)
                .validate(|value, _| value.chars().count() <= PHONE_NAME_MAX_CHARS);
            input.set_value(phone.name.clone(), window, cx);
            input
        });
        // Updating the input also updates Save's empty/unchanged gate.
        cx.observe(&input, |_, _, cx| cx.notify()).detach();
        self.phone_edit = Some((phone, input));
        self.rename.open(window, cx);
        cx.notify();
    }

    pub(super) fn rename_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some((phone, input)) = &self.phone_edit else {
            return div().into_any_element();
        };
        let typed: String = input
            .read(cx)
            .value()
            .chars()
            .take(PHONE_NAME_MAX_CHARS)
            .collect();
        let next = renamed_phone_name(&phone.name, &typed);
        let id = phone.id.clone();
        Dialog::new("rename-phone-dialog", &self.rename, "Rename phone")
            .size(DialogSize::Sm)
            .description("So you can tell your phones apart.")
            .child(
                Input::new("phone-name", input)
                    .accessibility_label("Name")
                    .disabled(self.disabled()),
            )
            .footer(
                Button::new("cancel-rename")
                    .label("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| this.rename.close(window, cx))),
            )
            .footer(
                Button::new("save-phone-name")
                    .label("Save")
                    .disabled(self.disabled() || next.is_none())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if !this.rename.is_open() {
                            return;
                        }
                        let Some(name) = &next else {
                            return;
                        };
                        this.rename.close(window, cx);
                        this.request(
                            "remote.lan.devices.rename",
                            json!({"id":id, "name":name}),
                            "Couldn't rename the phone. Try again.",
                            cx,
                        );
                    })),
            )
            .into_any_element()
    }

    pub(super) fn begin_phone_pairing(&mut self, address: Option<String>, cx: &mut Context<Self>) {
        if self.busy || !self.studio.is_connected() {
            return;
        }
        self.busy = true;
        self.error = None;
        let mut params = json!({});
        if let Some(address) = address {
            params["address"] = json!(address);
        }
        let client = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { client.request("remote.lan.pairing.begin", params).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(Ok(value)) => match serde_json::from_value::<RemoteLanPairing>(value) {
                        Ok(pairing) => {
                            this.pairing = Some((pairing, chrono::Utc::now().timestamp_millis()));
                            this.pairing_revealed = false;
                            this.pairing_link_copied = false;
                            this.pair_need_open = true;
                            this.start_pair_tick(cx);
                        }
                        Err(_) => {
                            this.error = Some("Couldn't start phone pairing. Try again.".into());
                        }
                    },
                    _ => {
                        this.error = Some("Couldn't start phone pairing. Try again.".into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn start_pair_tick(&mut self, cx: &mut Context<Self>) {
        self.pair_tick_generation = self.pair_tick_generation.wrapping_add(1);
        let generation = self.pair_tick_generation;
        cx.spawn(async move |entity, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                let cont = entity
                    .update(cx, |this, cx| {
                        if this.pair_tick_generation != generation || this.pairing.is_none() {
                            return false;
                        }
                        // A successful scan drops pairingExpiresAt while the
                        // countdown is still running — close the dialog.
                        if let Some((pairing, _)) = &this.pairing {
                            let now = chrono::Utc::now().timestamp_millis();
                            let left = pairing_seconds_left(Some(&pairing.expires_at), now);
                            let consumed = this.phone.as_ref().is_some_and(|status| {
                                status.pairing_expires_at.is_none() && left > 0
                            });
                            if consumed {
                                this.pairing = None;
                                this.pairing_revealed = false;
                                this.pair_need_close = true;
                                cx.notify();
                                return false;
                            }
                        }
                        cx.notify();
                        this.pair.is_open() || this.pair_need_open
                    })
                    .unwrap_or(false);
                if !cont {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn close_phone_pairing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pairing = None;
        self.pairing_revealed = false;
        self.pairing_link_copied = false;
        self.pair_need_open = false;
        self.pair_need_close = false;
        if self.pair.is_open() {
            self.pair.close(window, cx);
        }
        if self.studio.is_connected() {
            let client = self.studio.backend().clone();
            self.runtime.spawn(async move {
                let _ = client.request("remote.lan.pairing.cancel", json!({})).await;
            });
        }
        cx.notify();
    }

    pub(super) fn flush_pair_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pair_need_open && self.pairing.is_some() && !self.pair.is_open() {
            self.pair_need_open = false;
            self.pair.open(window, cx);
        }
        if self.pair_need_close && self.pair.is_open() {
            self.pair_need_close = false;
            self.pair.close(window, cx);
        }
    }

    pub(super) fn pair_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some((pairing, since)) = &self.pairing else {
            return div().into_any_element();
        };
        let t = theme::current(window, cx).theme();
        let now = chrono::Utc::now().timestamp_millis();
        let seconds_left = pairing_seconds_left(Some(&pairing.expires_at), now);
        let expired = seconds_left == 0;
        let show_trouble = !expired && now - since > PAIRING_TROUBLE_HINT_AFTER_MS;
        let entity = cx.entity();
        let address = pairing.address.clone();
        let url = pairing.url.clone();

        let mut body = div().flex().flex_col().items_center().gap(px(16.)).w_full();

        if expired {
            body = body.child(
                div()
                    .flex()
                    .size(px(224.))
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(12.))
                    .rounded(px(radius::CHIP))
                    .border_1()
                    .border_color(hsla(t.border))
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child("This code expired."),
                    )
                    .child(
                        Button::new("pair-new-code")
                            .label("New code")
                            .variant(ButtonVariant::Outline)
                            .disabled(self.disabled())
                            .on_click({
                                let entity = entity.clone();
                                let address = address.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.begin_phone_pairing(Some(address.clone()), cx)
                                    })
                                }
                            }),
                    ),
            );
        } else if self.pairing_revealed {
            body = body
                .child(QrCode::new("pair-qr", url.clone()).accessibility_label("Pairing QR code"));
        } else {
            body = body.child(
                div()
                    .id("pair-reveal")
                    .flex()
                    .size(px(224.))
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .rounded(px(radius::CHIP))
                    .border_1()
                    .border_color(hsla(t.border))
                    .bg(hsla(t.muted))
                    .px(px(24.))
                    .cursor_pointer()
                    .child(icon(IconName::DeviceMobile, 24.0, hsla(t.muted_foreground)))
                    .child(
                        div()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(hsla(t.foreground))
                            .child("Show code"),
                    )
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .text_center()
                            .child("Hidden so it never lands on your stream by accident."),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.pairing_revealed = true;
                                cx.notify();
                            })
                        }
                    }),
            );
        }

        if !expired {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(format!("Expires in {}", format_countdown(seconds_left))),
            );
        }

        if pairing.addresses.len() > 1 {
            let mut networks = SegmentedControl::new("pair-network")
                .accessibility_label("Network")
                // Electron's default w-fit, centred (phone-remote-section.tsx).
                .fit(true)
                .small(true)
                .value(Some(pairing.address.clone()));
            for address in &pairing.addresses {
                networks = networks.option(Segment::new(address.clone(), address.clone()));
            }
            networks = networks.on_change({
                let entity = entity.clone();
                move |address, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.begin_phone_pairing(Some(address.to_string()), cx)
                    })
                }
            });
            body = body
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .text_center()
                        .child(
                            "This computer is on more than one network. Pick the one your phone is on.",
                        ),
                )
                .child(networks);
        }

        if self.pairing_revealed && !expired {
            body = body.child(
                Button::new("pair-copy-link")
                    .label(if self.pairing_link_copied {
                        "Copied"
                    } else {
                        "Copy link instead"
                    })
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        let url = url.clone();
                        move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                            entity.update(cx, |this, cx| {
                                this.pairing_link_copied = true;
                                cx.notify();
                            })
                        }
                    }),
            );
        }

        if show_trouble {
            body = body.child(
                Alert::new("pair-trouble").title(
                    "Nothing connected yet. Check that the phone is on the same Wi-Fi (guest and office networks often block devices from seeing each other), and allow incoming connections if your firewall asked.",
                ),
            );
        }

        Dialog::new("pair-phone-dialog", &self.pair, "Pair a phone")
            .size(DialogSize::Md)
            .description(
                "Scan with your phone's camera while it's on the same Wi-Fi as this computer. The code works once.",
            )
            .child(body)
            .on_open_change({
                let entity = entity.clone();
                move |open, _, window, cx| {
                    if !open {
                        after_open_change(&entity.downgrade(), window, cx, |this, window, cx| {
 this.close_phone_pairing(window, cx)
 });
                    }
                }
            })
            .into_any_element()
    }
}
