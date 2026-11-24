use super::*;
use gpui::AnyElement;
use videorc_app_core::desktop::{
    permissions::{PermissionPlatform, SystemPermissionPane},
    system_access::{
        SystemAccessAction, SystemAccessContext, SystemAccessInput, row_action, system_access_rows,
    },
};
use videorc_kit::{
    badge::Badge,
    button::{Button, ButtonVariant},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
};

impl SettingsScreen {
    fn permission_action(
        &mut self,
        pane: SystemPermissionPane,
        action: SystemAccessAction,
        cx: &mut Context<Self>,
    ) {
        if self.pending_permission.is_some() {
            return;
        }
        if action == SystemAccessAction::OpenSettings {
            self.error = self.permissions.open_settings(cx, pane).err();
            cx.notify();
            return;
        }
        self.pending_permission = Some(pane);
        let task = match action {
            SystemAccessAction::RequestMediaAccess => self.permissions.request(cx, pane),
            SystemAccessAction::Relaunch => self.permissions.relaunch(cx),
            SystemAccessAction::OpenSettings => unreachable!(),
        };
        cx.spawn(async move |entity, cx| {
            let result = task.await;
            let _ = entity.update(cx, |this, cx| {
                this.pending_permission = None;
                this.error = result.err();
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn permission_page(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let snapshot = self.studio.snapshot();
        let media = self.permissions.snapshot();
        let platform = PermissionPlatform::current();
        let model = view::permissions_view(&view::PermissionsInput {
            platform: crate::app::hotkeys::node_platform(),
            os_release: self.os_release.as_deref(),
            devices: &snapshot.sources.devices.devices,
            media_access: Some(&media),
            pending_pane: self.pending_permission,
        });
        let rows = system_access_rows(&SystemAccessInput {
            devices: &snapshot.sources.devices.devices,
            audio_meter: None,
            platform,
            os_release: self.os_release.as_deref(),
            permission_target_name: "Videorc",
            media_access: Some(&media),
            context: SystemAccessContext {
                pending_pane: self.pending_permission,
                ..Default::default()
            },
        });
        let mut list = GroupedList::new();
        for (index, row) in model.rows.iter().enumerate() {
            let action = rows
                .iter()
                .find(|raw| raw.id == row.id)
                .and_then(|raw| row_action(raw, platform, Some(&media)));
            let mut control = div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(Badge::new(row.status));
            if let (Some(pane), Some(action), Some(label)) =
                (row.pane, action, row.action_label.clone())
            {
                control = control.child(
                    Button::new(("permission-action", index))
                        .label(label)
                        .accessibility_label(row.action_name.clone().unwrap_or_default())
                        .variant(ButtonVariant::Outline)
                        .disabled(self.pending_permission.is_some())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.permission_action(pane, action, cx)
                        })),
                );
            }
            let description = row.detail.as_ref().map_or_else(
                || row.purpose.to_string(),
                |detail| format!("{} {detail}", row.purpose),
            );
            list = list.item(
                div()
                    .child(ListRow::new(("permission-row", index), row.label).child(control))
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(description),
                    ),
            );
        }
        let mut section = PanelSection::new(view::copy::SYSTEM_ACCESS)
            .title(view::copy::SYSTEM_ACCESS)
            .description(model.description)
            .action(
                Button::new("refresh-permissions")
                    .label(view::copy::REFRESH)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.refresh(cx);
                        cx.notify();
                    })),
            );
        if model.rows.is_empty() {
            section = section.child(
                div()
                    .child(ListRow::new("no-permissions", view::copy::NOTHING_TO_GRANT))
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(view::copy::NOTHING_TO_GRANT_DESCRIPTION),
                    ),
            );
        } else {
            section = section.child(list).child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("privacy-settings", view::copy::CHANGE_A_PERMISSION)
                                .child(
                                    Button::new("open-system-settings")
                                        .label(model.open_settings)
                                        .variant(ButtonVariant::Outline)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.permission_action(
                                                SystemPermissionPane::Privacy,
                                                SystemAccessAction::OpenSettings,
                                                cx,
                                            )
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(model.change_description),
                        ),
                ),
            );
        }
        section.into_any_element()
    }
}
