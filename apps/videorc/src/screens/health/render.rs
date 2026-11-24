use super::*;
use gpui::{AnyElement, ClipboardItem, SharedString, Window, div, prelude::*, px};
use videorc_app_core::desktop::{permissions::PermissionPlatform, system_access as access};
use videorc_app_core::studio::virtual_camera::camera_copy;
use videorc_kit::{
    Alert, AlertVariant, Button, ButtonVariant, GroupedList, ListRow, PanelSection,
    dialog::Dialog,
    scroll_area::ScrollArea,
    status_dot::{StatusDot, StatusTone},
    theme::{self, FONT, TypeScale, hsla},
    tokens::text,
};

fn tone(t: h::Tone) -> StatusTone {
    match t {
        h::Tone::Good => StatusTone::Good,
        h::Tone::Warn => StatusTone::Warn,
        h::Tone::Error => StatusTone::Error,
        _ => StatusTone::Neutral,
    }
}
impl HealthScreen {
    fn permission_warnings(&self, cx: &mut Context<Self>) -> (Vec<AnyElement>, Vec<String>) {
        let snapshot = self.studio.snapshot();
        let media = self.permissions.snapshot();
        let platform = PermissionPlatform::current();
        let rows = access::system_access_rows(&access::SystemAccessInput {
            devices: &snapshot.sources.devices.devices,
            audio_meter: None,
            platform,
            os_release: None,
            permission_target_name: "Videorc",
            media_access: Some(&media),
            context: access::SystemAccessContext {
                pending_pane: self.permission_pending,
                ..Default::default()
            },
        });
        let action_for = |pane| {
            if pane == videorc_app_core::desktop::permissions::SystemPermissionPane::Privacy {
                return access::system_access_action(
                    Some(pane),
                    None,
                    platform,
                    None,
                    self.permission_pending.is_some(),
                );
            }
            rows.iter()
                .find(|row| row.id.pane() == pane)
                .and_then(|row| access::row_action(row, platform, Some(&media)))
        };
        let warnings = h::permission_warnings(
            &snapshot.health.events,
            |pane| action_for(pane).is_some(),
            &self.dismissed,
        );
        let mut names = Vec::new();
        let elements = warnings
            .into_iter()
            .map(|warning| {
                let row = rows.iter().find(|row| row.id.pane() == warning.pane);
                let name = row.map(|row| row.label.to_string());
                if let Some(name) = &name {
                    names.push(name.clone());
                }
                let title = name
                    .map(|name| format!("{name} needs permission"))
                    .unwrap_or_else(|| "Videorc needs a permission".into());
                let detail = format!(
                    "{} Last asked at {}.",
                    row.map(|row| row.detail.as_str())
                        .unwrap_or("Allow it in your system settings."),
                    h::compact_time(&warning.created_at)
                );
                let id = format!("permission-{}", warning.pane.as_str());
                let action = action_for(warning.pane);
                let mut actions = div().flex().gap(px(8.));
                if let (Some(action), Some(label)) =
                    (action, access::system_access_action_label(action, platform))
                {
                    let pane = warning.pane;
                    actions = actions.child(
                        Button::new(SharedString::from(format!("fix-{id}")))
                            .label(label)
                            .variant(ButtonVariant::Outline)
                            .disabled(self.permission_pending.is_some())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.permission_action(pane, action, cx)
                            })),
                    );
                }
                let dismiss = warning.event_ids;
                actions = actions.child(
                    Button::new(SharedString::from(format!("dismiss-{id}")))
                        .label("Dismiss")
                        .variant(ButtonVariant::Ghost)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.dismissed.extend(dismiss.iter().cloned());
                            cx.notify();
                        })),
                );
                Alert::new(SharedString::from(id))
                    .variant(AlertVariant::Warning)
                    .title(title)
                    .description(detail)
                    .action(actions)
                    .into_any_element()
            })
            .collect();
        (elements, names)
    }
    fn metric_group(&self, group: &h::MetricGroupView, cx: &mut Context<Self>) -> AnyElement {
        let expanded = self
            .groups
            .get(group.id)
            .copied()
            .unwrap_or(group.attention);
        let id = group.id;
        let mut section = PanelSection::new(id)
            .title(group.title.clone())
            .description(group.meta.clone())
            .heading_level(3)
            .action(
                Button::new(SharedString::from(format!("toggle-{id}")))
                    .label(group.title.clone())
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.groups.insert(id.into(), !expanded);
                        cx.notify();
                    })),
            );
        if expanded {
            if !group.empty.is_empty() {
                section = section.child(group.empty.clone());
            }
            let mut metrics = GroupedList::new();
            for (index, metric) in group.metrics.iter().enumerate() {
                metrics = metrics.item(
                    ListRow::new(
                        SharedString::from(format!("{id}-{index}")),
                        metric.label.clone(),
                    )
                    .meta(metric.value.clone()),
                );
            }
            for (index, (label, detail, words)) in group.stages.iter().enumerate() {
                metrics = metrics.item(
                    div()
                        .child(
                            ListRow::new(
                                SharedString::from(format!("{id}-stage-{index}")),
                                label.clone(),
                            )
                            .child(
                                StatusDot::new(SharedString::from(format!("{id}-state-{index}")))
                                    .tone(tone(words.tone))
                                    .label(words.value.clone()),
                            ),
                        )
                        .child(detail.clone()),
                );
            }
            section = section.child(metrics);
            for warning in &group.warnings {
                section = section.child(warning.clone());
            }
            if let Some(crash) = &group.crash {
                section = section.child(
                    Alert::new("health-crash")
                        .title(crash.title.clone())
                        .description(crash.description.clone()),
                );
            }
            for log in &group.logs {
                section = section.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(format!(
                            "{} · {} · {} · {}",
                            log.time, log.level, log.code, log.source
                        ))
                        .child(log.message.clone()),
                );
            }
            if !group.note.is_empty() {
                section = section.child(group.note.clone());
            }
            if let Some(action) = &group.action {
                section = section.child(
                    Button::new("health-remove-camera")
                        .label(action.label.clone())
                        .variant(ButtonVariant::Outline)
                        .disabled(action.disabled)
                        .on_click(cx.listener(|this, _, window, cx| this.confirm.open(window, cx))),
                );
            }
        }
        section.into_any_element()
    }
}
impl Render for HealthScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let mut checks = div().flex().flex_wrap().gap(px(8.));
        for check in self
            .view
            .checks
            .iter()
            .filter(|check| self.show_all || h::check_needs_attention(check.tone))
        {
            checks = checks.child(
                StatusDot::new(check.id)
                    .tone(tone(check.tone))
                    .label(format!("{} · {}", check.label, check.value)),
            );
        }
        let (alerts, names) = self.permission_warnings(cx);
        let verdict = h::health_verdict(
            &self.view.checks,
            &names,
            self.view.verdict.description.clone(),
        );
        let (title, variant) = if self.studio.is_connected() {
            (
                verdict.title,
                match verdict.variant {
                    h::VerdictVariant::Success => AlertVariant::Success,
                    h::VerdictVariant::Warning => AlertVariant::Warning,
                    h::VerdictVariant::Destructive => AlertVariant::Destructive,
                },
            )
        } else {
            (
                "Videorc is reconnecting. Try again in a moment.".into(),
                AlertVariant::Warning,
            )
        };
        let mut summary = PanelSection::new("health-checks")
            .title(h::copy::CHECKS_TITLE)
            .description(h::copy::CHECKS_DESCRIPTION)
            .child(
                Alert::new("health-verdict")
                    .title(title)
                    .variant(variant)
                    .description(verdict.description.unwrap_or_default()),
            )
            .children(alerts)
            .child(checks)
            .child(
                Button::new("health-show-checks")
                    .label(if self.show_all {
                        h::copy::SHOW_FEWER_CHECKS.to_string()
                    } else {
                        h::copy::show_all_checks(self.view.checks.len())
                    })
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_all = !this.show_all;
                        cx.notify();
                    })),
            );
        if self.recording_log.failed {
            summary = summary.child(
                Alert::new("health-log-failed")
                    .variant(AlertVariant::Warning)
                    .title(h::copy::LOG_FAILED),
            );
        }
        if let Some(message) = self.view.ffmpeg_missing {
            summary = summary.child(
                Alert::new("ffmpeg-missing")
                    .variant(AlertVariant::Warning)
                    .title(h::copy::FFMPEG_MISSING_TITLE)
                    .description(message),
            );
        }
        let mut support = PanelSection::new("health-support")
            .title(h::copy::SUPPORT_BUNDLE_TITLE)
            .description(h::copy::SUPPORT_BUNDLE_DESCRIPTION)
            .child(
                Button::new("export-support-bundle")
                    .label(if self.export_pending {
                        h::copy::SUPPORT_BUNDLE_PENDING
                    } else {
                        h::SUPPORT_BUNDLE_LABEL
                    })
                    .variant(ButtonVariant::Outline)
                    .disabled(self.export_pending || !self.studio.is_connected())
                    .on_click(cx.listener(|this, _, _, cx| this.export(cx))),
            );
        if let Some(path) = self.exported.clone() {
            let label = if cfg!(target_os = "macos") {
                "Show in Finder"
            } else if cfg!(target_os = "windows") {
                "Show in Explorer"
            } else {
                "Show in folder"
            };
            support = support
                .child("Support bundle exported")
                .child(
                    path.file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
                .child(
                    Button::new("reveal-support-bundle")
                        .label(label)
                        .variant(ButtonVariant::Outline)
                        .on_click(cx.listener(|this, _, _, cx| this.reveal_bundle(cx))),
                )
                .child(
                    Button::new("copy-support-path")
                        .label("Copy path")
                        .variant(ButtonVariant::Ghost)
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                path.to_string_lossy().into_owned(),
                            ))
                        }),
                );
        }
        let mut details = PanelSection::new("health-details")
            .title(h::copy::TECHNICAL_DETAILS)
            .action(
                Button::new("health-details-toggle")
                    .label(h::copy::TECHNICAL_DETAILS)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.details = !this.details;
                        cx.notify();
                    })),
            );
        if self.details {
            for group in &self.view.groups {
                details = details.child(self.metric_group(group, cx));
            }
        }
        div()
            .id("health-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .type_scale(text::META)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .child(
                ScrollArea::new("health-scroll")
                    .children(
                        self.error
                            .clone()
                            .map(|message| Alert::new("health-error").title(message)),
                    )
                    .child(summary)
                    .child(support)
                    .child(details),
            )
            .child(
                Dialog::new(
                    "remove-videorc-camera",
                    &self.confirm,
                    camera_copy::REMOVE_TITLE,
                )
                .description(camera_copy::REMOVE_DESCRIPTION)
                .footer(
                    Button::new("cancel-camera-removal")
                        .label("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .on_click(
                            cx.listener(|this, _, window, cx| this.confirm.close(window, cx)),
                        ),
                )
                .footer(
                    Button::new("confirm-camera-removal")
                        .label(camera_copy::REMOVE)
                        .disabled(self.removing || !self.studio.is_connected())
                        .on_click(
                            cx.listener(|this, _, window, cx| this.remove_camera(window, cx)),
                        ),
                ),
            )
    }
}
