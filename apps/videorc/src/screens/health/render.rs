use super::*;
use gpui::{AnyElement, ClipboardItem, SharedString, Window, div, prelude::*, px};
use videorc_app_core::desktop::{permissions::PermissionPlatform, system_access as access};
use videorc_app_core::studio::cloud_program_health::{self as cloud_health, ProgramHealthTone};
use videorc_app_core::studio::virtual_camera::camera_copy;
use videorc_kit::{
    Alert, AlertVariant, Button, ButtonSize, ButtonVariant, Collapsible, GroupedList, ListRow,
    PanelSection, StatusBadge,
    dialog::Dialog,
    icon::{IconName, icon},
    scroll_area::ScrollArea,
    status_dot::StatusTone,
    theme::{self, FONT, TypeScale, hsla},
    tokens::{Theme, radius, size, text},
};

/// The chevron of a disclosure row (`ChevronDownIcon`, turned over while
/// open): down when closed, up when open.
fn chevron(open: bool) -> IconName {
    if open {
        IconName::CaretUp
    } else {
        IconName::CaretDown
    }
}

fn tone(t: h::Tone) -> StatusTone {
    match t {
        h::Tone::Good => StatusTone::Good,
        h::Tone::Warn => StatusTone::Warn,
        h::Tone::Error => StatusTone::Error,
        _ => StatusTone::Neutral,
    }
}

fn program_tone(t: ProgramHealthTone) -> StatusTone {
    match t {
        ProgramHealthTone::Good => StatusTone::Good,
        ProgramHealthTone::Warn => StatusTone::Warn,
        ProgramHealthTone::Error => StatusTone::Error,
        ProgramHealthTone::Neutral => StatusTone::Neutral,
    }
}
impl HealthScreen {
    fn permission_warnings(
        &self,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> (Vec<AnyElement>, Vec<String>) {
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
                // The fix sits under the words (`col-start-2 mt-1.5`, xs
                // outline); the corner holds only the Dismiss icon.
                let mut description = div().flex().flex_col().gap(px(6.)).child(detail);
                if let (Some(action), Some(label)) =
                    (action, access::system_access_action_label(action, platform))
                {
                    let pane = warning.pane;
                    description = description.child(
                        div().flex().child(
                            Button::new(SharedString::from(format!("fix-{id}")))
                                .label(label)
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .disabled(self.permission_pending.is_some())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.permission_action(pane, action, cx)
                                })),
                        ),
                    );
                }
                let dismiss = warning.event_ids;
                Alert::new(SharedString::from(id.clone()))
                    .variant(AlertVariant::Warning)
                    .title(title)
                    .description(description)
                    .action(
                        Button::new(SharedString::from(format!("dismiss-{id}")))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::IconXs)
                            .accessibility_label("Dismiss")
                            .child(icon(IconName::X, 12., hsla(t.foreground)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.dismissed.extend(dismiss.iter().cloned());
                                cx.notify();
                            })),
                    )
                    .into_any_element()
            })
            .collect();
        (elements, names)
    }
    /// `MetricGroup`: one theme of numbers behind a disclosure row (chevron,
    /// the title in 14 px secondary text, the warning glyph while it needs a
    /// look, the meta at the end in 12 px).
    fn metric_group(
        &self,
        group: &h::MetricGroupView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let expanded = self
            .groups
            .get(group.id)
            .copied()
            .unwrap_or(group.attention);
        let id = group.id;
        let muted = hsla(t.muted_foreground);
        let (accent, foreground) = (hsla(t.accent), hsla(t.foreground));
        // Electron's `<h3>` wraps the trigger (`heading_level`); the trigger
        // isn't plain text, so the button and its heading carry the name its
        // words give in Electron (the title, the sr-only ", needs a look",
        // the meta).
        let mut name = group.title.clone();
        if group.attention {
            name.push_str(", needs a look");
        }
        if !group.meta.is_empty() {
            name.push_str(", ");
            name.push_str(&group.meta);
        }
        let trigger = div()
            .flex()
            .items_center()
            .w_full()
            .min_w(px(0.))
            .gap(px(8.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(radius::ROW))
            .text_size(px(14.))
            .line_height(px(20.))
            .text_color(muted)
            .hover(move |style| style.bg(accent).text_color(foreground))
            .child(icon(chevron(expanded), 14., muted))
            .child(div().flex_none().child(group.title.clone()))
            .when(group.attention, |row| {
                row.child(icon(IconName::WarningFill, 14., hsla(t.warning)))
            })
            .when(!group.meta.is_empty(), |row| {
                row.child(
                    div()
                        .ml_auto()
                        .min_w(px(0.))
                        .truncate()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .child(group.meta.clone()),
                )
            });
        let entity = cx.entity();
        let mut disclosure = Collapsible::new(SharedString::from(format!("toggle-{id}")))
            .unstyled(true)
            .heading_level(3)
            // `rounded-row`: the focus ring follows the hover block.
            .header_radius(radius::ROW)
            .open(expanded)
            .accessibility_label(name)
            .trigger(trigger)
            .on_toggle(move |open, _, cx| {
                entity.update(cx, |this, cx| {
                    this.groups.insert(id.into(), open);
                    cx.notify();
                })
            });
        // Only an open group builds its content.
        if expanded {
            disclosure = disclosure.content(self.metric_body(group, t, cx));
        }
        disclosure.into_any_element()
    }

    /// The open group's content (`CollapsibleContent className="pt-2 pb-1"`).
    fn metric_body(
        &self,
        group: &h::MetricGroupView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = group.id;
        let mut section = div().flex().flex_col().gap(px(12.)).pt(px(8.)).pb(px(4.));
        if !group.empty.is_empty() {
            // "Nothing is recording." in secondary text; a log that
            // didn't load reads in primary with the warning glyph.
            section = section.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(8.))
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .text_color(hsla(if group.empty_warns {
                        t.foreground
                    } else {
                        t.muted_foreground
                    }))
                    .when(group.empty_warns, |line| {
                        line.child(icon(IconName::WarningFill, 14., hsla(t.warning)))
                    })
                    .child(group.empty.clone()),
            );
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
                        .child(StatusBadge::new(words.value.clone()).tone(tone(words.tone))),
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
        section
    }

    /// Plan 249 S26 / P070: Cloud room program-health while a room is open.
    fn cloud_room_section(&self) -> Option<PanelSection> {
        let rows = self.cloud_room.as_ref()?;
        let mut section = PanelSection::new("cloud-program-health")
            .title(cloud_health::CLOUD_ROOM_TITLE)
            .description(cloud_health::PROGRAM_PREVIEW_NOTE);
        let mut body = div().flex().flex_col().gap(px(12.));
        for (layer, rows) in cloud_health::program_health_layers(rows) {
            let mut list = GroupedList::new().label(layer.label());
            for row in rows {
                list = list.item(
                    ListRow::new(SharedString::from(row.id.clone()), row.label.clone())
                        .compact(true)
                        .context(row.detail.clone())
                        .child(StatusBadge::new(row.status.clone()).tone(program_tone(row.tone))),
                );
            }
            body = body.child(list);
        }
        Some(section.child(body))
    }
}
impl Render for HealthScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        // `CheckList`: the checks that need a look, then "Show all checks"
        // (xs ghost) at the start of the line, 8 px apart.
        let mut checks = div().flex().flex_wrap().items_center().gap(px(8.));
        let mut shown = 0;
        for check in self
            .view
            .checks
            .iter()
            .filter(|check| self.show_all || h::check_needs_attention(check.tone))
        {
            shown += 1;
            checks = checks.child(
                StatusBadge::new(check.value.clone())
                    .label(check.label)
                    .tone(tone(check.tone)),
            );
        }
        let check_list = div()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(8.))
            .when(shown > 0, |list| list.child(checks))
            .child(
                Button::new("health-show-checks")
                    .label(if self.show_all {
                        h::copy::SHOW_FEWER_CHECKS.to_string()
                    } else {
                        h::copy::show_all_checks(self.view.checks.len())
                    })
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_all = !this.show_all;
                        cx.notify();
                    })),
            );
        let (alerts, names) = self.permission_warnings(t, cx);
        let linux_alerts: Vec<_> = self
            .view
            .linux_issues
            .iter()
            .map(crate::screens::linux_setup::linux_setup_alert)
            .collect();
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
        // A verdict without a description is one line: an empty description
        // would make the title a heading over a blank line.
        let mut verdict_alert = Alert::new("health-verdict").title(title).variant(variant);
        if let Some(description) = verdict.description.filter(|d| !d.is_empty()) {
            verdict_alert = verdict_alert.description(description);
        }
        // Electron's order: the verdict, permission warnings, Linux setup,
        // the recorder line, then the checks. A log that didn't load says so
        // in its own group under Technical details.
        let mut summary = PanelSection::new("health-checks")
            .icon(icon(
                IconName::HeartbeatDuotone,
                16.,
                hsla(t.muted_foreground),
            ))
            .title(h::copy::CHECKS_TITLE)
            .description(h::copy::CHECKS_DESCRIPTION)
            .child(verdict_alert)
            .children(alerts)
            .children(linux_alerts);
        if let Some(message) = self.view.ffmpeg_missing {
            summary = summary.child(
                Alert::new("ffmpeg-missing")
                    .variant(AlertVariant::Warning)
                    .title(h::copy::FFMPEG_MISSING_TITLE)
                    .description(message),
            );
        }
        let summary = summary.child(check_list);
        // The export is the section's action, on the title line.
        let mut support = PanelSection::new("health-support")
            .title(h::copy::SUPPORT_BUNDLE_TITLE)
            .description(h::copy::SUPPORT_BUNDLE_DESCRIPTION)
            .action(
                Button::new("export-support-bundle")
                    .label(if self.export_pending {
                        h::copy::SUPPORT_BUNDLE_PENDING
                    } else {
                        h::SUPPORT_BUNDLE_LABEL
                    })
                    .icon(IconName::Bug)
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
        // `TechnicalDetails`: one disclosure row the width of the pane (an
        // h2), the chevron then the title at 13 px / 600, closed until asked.
        let details_open = self.details;
        let accent = hsla(t.accent);
        let details_trigger = div()
            .flex()
            .items_center()
            .w_full()
            .gap(px(8.))
            .px(px(size::GUTTER))
            .py(px(12.))
            .type_scale(text::SECTION)
            .text_color(hsla(t.foreground))
            .hover(move |style| style.bg(accent))
            .child(icon(chevron(details_open), 14., hsla(t.muted_foreground)))
            .child(h::copy::TECHNICAL_DETAILS);
        let mut groups = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .px(px(size::GUTTER))
            .pb(px(size::GUTTER));
        if details_open {
            for group in &self.view.groups {
                groups = groups.child(self.metric_group(group, t, cx));
            }
        }
        let details_page = cx.entity();
        let details = Collapsible::new("health-details-toggle")
            .unstyled(true)
            // Square, the pane's width: `<h2>`, no `rounded-*`.
            .heading_level(2)
            .open(details_open)
            .accessibility_label(h::copy::TECHNICAL_DETAILS)
            .trigger(details_trigger)
            .content(groups)
            .on_toggle(move |open, _, cx| {
                details_page.update(cx, |this, cx| {
                    this.details = open;
                    cx.notify();
                })
            })
            .border_b_1()
            .border_color(hsla(t.border));
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
                    .children(self.cloud_room_section())
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
