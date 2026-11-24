use super::*;
use gpui::{AnyElement, AppContext};
use videorc_app_core::settings_page::remote::{
    PHONE_NAME_MAX_CHARS, RemoteLanDevice, renamed_phone_name,
};
use videorc_kit::{
    button::{Button, ButtonVariant},
    dialog::{Dialog, DialogSize},
    input::{Input, InputState},
};

impl SettingsScreen {
    pub(super) fn rename_phone(
        &mut self,
        phone: RemoteLanDevice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
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
}
