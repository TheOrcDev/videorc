use super::*;
use gpui::AnyElement;
use videorc_app_core::desktop::{
    permissions::{PermissionPlatform, SystemPermissionPane},
    system_access::{
        SystemAccessAction, SystemAccessContext, SystemAccessInput, row_action, system_access_rows,
    },
};
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonVariant},
    empty::Empty,
    icon::{IconName, icon},
    list_row::GroupedList,
    panel_section::PanelSection,
    settings_row::SettingsRow,
    spinner::Spinner,
};

/// `StatusBadge`'s tone: the colour lives in the dot.
fn status_variant(tone: &str) -> BadgeVariant {
    match tone {
        "good" => BadgeVariant::Success,
        "warn" => BadgeVariant::Warning,
        "neutral" => BadgeVariant::Neutral,
        "bad" | "error" => BadgeVariant::Destructive,
        _ => BadgeVariant::Outline,
    }
}

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
        let muted = hsla(t.muted_foreground);
        let mut list = GroupedList::new();
        for (index, row) in model.rows.iter().enumerate() {
            let action = rows
                .iter()
                .find(|raw| raw.id == row.id)
                .and_then(|raw| row_action(raw, platform, Some(&media)));
            // `system-access-list.tsx`: the label and its status badge on one
            // line, the purpose and the detail under it, the action on the
            // right (`flex items-start gap-3 px-3 py-2.5`).
            let mut heading = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child(row.label),
                )
                .child(Badge::new(row.status).variant(status_variant(row.tone)));
            if row.spinning {
                heading = heading.child(
                    Spinner::new(("permission-checking", index))
                        .accessibility_label("Checking permission…"),
                );
            }
            let mut line = div()
                .id(("permission-row", index))
                .flex()
                .items_start()
                .gap(px(12.))
                .px(px(12.))
                .py(px(10.))
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w(px(0.))
                        .flex_col()
                        .gap(px(2.))
                        .child(heading)
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(muted)
                                .child(row.purpose),
                        )
                        .children(row.detail.clone().map(|detail| {
                            div().type_scale(text::META).text_color(muted).child(detail)
                        })),
                );
            if let (Some(pane), Some(action), Some(label)) =
                (row.pane, action, row.action_label.clone())
            {
                line = line.child(
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
            list = list.item(line);
        }
        // Leading RefreshIcon, then the words.
        let mut section = PanelSection::new(view::copy::SYSTEM_ACCESS)
            .title(view::copy::SYSTEM_ACCESS)
            .description(model.description)
            .last(true)
            .action(
                Button::new("refresh-permissions")
                    .accessibility_label(view::copy::REFRESH)
                    .variant(ButtonVariant::Ghost)
                    .child(icon(IconName::ArrowsClockwise, 16., hsla(t.foreground)))
                    .child(view::copy::REFRESH)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.refresh(cx);
                        cx.notify();
                    })),
            );
        if model.rows.is_empty() {
            section = section.child(
                Empty::new()
                    .title(view::copy::NOTHING_TO_GRANT)
                    .description(view::copy::NOTHING_TO_GRANT_DESCRIPTION),
            );
        } else {
            section = section.child(list).child(
                div().pt(px(12.)).child(
                    GroupedList::new().item(
                        SettingsRow::new("privacy-settings", view::copy::CHANGE_A_PERMISSION)
                            .description(model.change_description)
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
                    ),
                ),
            );
        }
        section.into_any_element()
    }
}
