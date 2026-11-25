use super::*;
use gpui::{AnyElement, ClipboardItem};
use videorc_app_core::settings_page::{agents, remote as r};
use videorc_kit::theme::TypeScale as _;
use videorc_kit::{
    alert::Alert,
    button::{Button, ButtonVariant},
    dialog::Dialog,
    list_row::{GroupedList, ListRow},
    page::ConfigGrid,
    panel_section::PanelSection,
    section_label::SectionLabel,
    settings_row::SettingsRow,
    switch::Switch,
};

#[derive(Clone)]
pub(super) struct Confirmation {
    title: String,
    description: String,
    label: &'static str,
    method: &'static str,
    params: Value,
}

impl SettingsScreen {
    /// P1421: Connect an agent… opens the dialog (made on first use).
    fn open_connect_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let enabled = self.agents.as_ref().is_some_and(|status| status.enabled);
        let dialog = match &self.connect_agent {
            Some(dialog) => dialog.clone(),
            None => {
                let dialog = super::connect_agent::dialog(
                    self.studio.clone(),
                    self.backend.clone(),
                    self.runtime.clone(),
                    window,
                    cx,
                );
                cx.observe(&dialog, |_, _, cx| cx.notify()).detach();
                self.connect_agent = Some(dialog.clone());
                dialog
            }
        };
        dialog.update(cx, |dialog, cx| dialog.open(enabled, window, cx));
        cx.notify();
    }

    fn ask(&mut self, confirmation: Confirmation, window: &mut Window, cx: &mut Context<Self>) {
        self.confirmation = Some(confirmation);
        self.confirm.open(window, cx);
        cx.notify();
    }

    pub(super) fn confirmation_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(question) = self.confirmation.clone() else {
            return div().into_any_element();
        };
        Dialog::new("remote-confirmation", &self.confirm, question.title)
            .description(question.description)
            .footer(
                Button::new("cancel-remote-change")
                    .label("Cancel")
                    .variant(ButtonVariant::Outline)
                    .on_click(cx.listener(|this, _, window, cx| this.confirm.close(window, cx))),
            )
            .footer(
                Button::new("confirm-remote-change")
                    .label(question.label)
                    .variant(ButtonVariant::Destructive)
                    .disabled(self.disabled())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        // Close before sending. A second Enter/click cannot
                        // repeat a token rotation or remove.
                        if !this.confirm.is_open() || this.disabled() {
                            return;
                        }
                        this.confirm.close(window, cx);
                        this.request(
                            question.method,
                            question.params.clone(),
                            "Couldn't change remote control. Try again.",
                            cx,
                        );
                    })),
            )
            .into_any_element()
    }

    pub(super) fn remote_page(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let platform = crate::app::hotkeys::node_platform();
        let entity = cx.entity();
        let enabled = self.remote.as_ref().is_some_and(|status| status.enabled);
        let toggle = Switch::new("remote-control")
            .accessibility_label(r::ENABLE_REMOTE_CONTROL)
            .checked(enabled)
            .disabled(self.disabled() || self.remote.is_none() || self.phone.is_none())
            .on_change(move |enabled, window, cx| {
                entity.update(cx, |this, cx| {
                    match r::remote_toggle(enabled, r::paired_phones(this.phone.as_ref())) {
                        r::RemoteToggle::Enable => this.request(
                            "remote.control.enable",
                            json!({}),
                            "Couldn't turn on remote control.",
                            cx,
                        ),
                        r::RemoteToggle::Disable => this.request(
                            "remote.control.disable",
                            json!({}),
                            "Couldn't turn off remote control.",
                            cx,
                        ),
                        r::RemoteToggle::ConfirmOff => this.ask(
                            Confirmation {
                                title: r::OFF_TITLE.into(),
                                description: r::off_body(r::paired_phones(this.phone.as_ref())),
                                label: r::OFF_CONFIRM,
                                method: "remote.control.disable",
                                params: json!({}),
                            },
                            window,
                            cx,
                        ),
                    }
                })
            });
        // `remote-settings.tsx`: the switch is the section's action; off, a
        // hint line (`text-xs text-muted-foreground`) stands for the rows.
        let hint = |words: String| {
            div()
                .type_scale(videorc_kit::tokens::text::META)
                .text_color(hsla(t.muted_foreground))
                .child(words)
        };
        let mut controls = GroupedList::new();
        if let Some(status) = &self.remote {
            if status.enabled {
                let token = status.token.clone();
                controls = controls
                    .item(
                        div()
                            .child(
                                ListRow::new("pairing-token", r::PAIRING_TOKEN).child(
                                    div()
                                        .flex()
                                        .gap(px(8.))
                                        .items_center()
                                        .child(r::token_preview(token.as_deref()))
                                        .child(
                                            Button::new("copy-remote-token")
                                                .label(r::COPY)
                                                .variant(ButtonVariant::Outline)
                                                .disabled(token.is_none() || self.disabled())
                                                .on_click(move |_, _, cx| {
                                                    if let Some(token) = &token {
                                                        cx.write_to_clipboard(
                                                            ClipboardItem::new_string(
                                                                token.clone(),
                                                            ),
                                                        );
                                                    }
                                                }),
                                        ),
                                ),
                            )
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(r::connected_clients_line(status.connected_clients)),
                            ),
                    )
                    .item(
                        div()
                            .child(
                                ListRow::new("new-token", r::NEW_TOKEN).child(
                                    Button::new("regenerate-token")
                                        .label(r::REGENERATE)
                                        .variant(ButtonVariant::Outline)
                                        .disabled(self.disabled())
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.ask(
                                                Confirmation {
                                                    title: r::REGENERATE_TITLE.into(),
                                                    description: r::regenerate_body(platform),
                                                    label: r::REGENERATE_CONFIRM,
                                                    method: "remote.control.regenerate",
                                                    params: json!({}),
                                                },
                                                window,
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
                                    .child(r::new_token_description(platform)),
                            ),
                    );
            }
        }
        let remote = PanelSection::new(r::REMOTE_CONTROL_TITLE)
            .title(r::REMOTE_CONTROL_TITLE)
            .description(r::remote_control_description(platform))
            .action(toggle)
            .when(enabled, |section| section.child(controls))
            .when(!enabled, |section| {
                section.child(hint(r::REMOTE_CONTROL_OFF_HINT.to_string()))
            });
        let entity = cx.entity();
        let phone_enabled = self.phone.as_ref().is_some_and(|status| status.enabled);
        let phone_switch = Switch::new("phone-remote")
            .accessibility_label("Enable phone remote")
            .checked(phone_enabled)
            .disabled(self.disabled() || self.phone.is_none())
            .on_change(move |enabled, _, cx| {
                entity.update(cx, |this, cx| {
                    this.request(
                        if enabled {
                            "remote.lan.enable"
                        } else {
                            "remote.lan.disable"
                        },
                        json!({}),
                        "Couldn't change phone remote. Try again.",
                        cx,
                    );
                })
            });
        let mut phones = GroupedList::new();
        if let Some(status) = &self.phone {
            if status.enabled {
                let (tone, summary) = r::phone_remote_summary(status);
                let blocked = tone == r::SummaryTone::Warning;
                let pair_hint = if blocked {
                    "Pairing works again once the problem above is fixed.".to_string()
                } else {
                    summary.clone()
                };
                let mut pair_button = Button::new("pair-phone")
                    .label("Pair a phone…")
                    .variant(ButtonVariant::Outline)
                    .disabled(self.disabled() || blocked)
                    .on_click(cx.listener(|this, _, _, cx| this.begin_phone_pairing(None, cx)));
                if blocked {
                    pair_button = pair_button.tooltip(summary);
                }
                phones = phones.item(
                    div()
                        .child(ListRow::new("pair-phone-row", "Phones").child(pair_button))
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(pair_hint),
                        ),
                );
                let names = r::phone_display_names(&status.devices);
                for (index, phone) in status.devices.iter().enumerate() {
                    let id = phone.id.clone();
                    let name = names
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| phone.name.clone());
                    let edit = phone.clone();
                    phones = phones.item(div()
                        .child(ListRow::new(("phone", index), name.clone())
                            .child(Button::new(("rename-phone", index)).label("Rename…")
                                .variant(ButtonVariant::Ghost).disabled(self.disabled())
                                .on_click(cx.listener(move |this, _, window, cx| this.rename_phone(edit.clone(), window, cx))))
                            .child(Button::new(("remove-phone", index)).label("Remove…")
                                .variant(ButtonVariant::Ghost).disabled(self.disabled())
                                .on_click(cx.listener(move |this, _, window, cx| this.ask(Confirmation {
                                    title: format!("Remove {name}?"), description: "It's disconnected now and needs a new pairing to come back. Your Stream Deck isn't affected.".into(),
                                    label: "Remove phone", method: "remote.lan.devices.revoke", params: json!({"id":id})
                                }, window, cx)))))
                        .child(div().px(px(12.)).pb(px(8.)).type_scale(text::META).text_color(hsla(t.muted_foreground))
                            .child(r::device_activity_label(phone, chrono::Utc::now().timestamp_millis()))));
                }
            }
        }
        let phone = PanelSection::new(r::PHONE_REMOTE_TITLE)
            .title(r::PHONE_REMOTE_TITLE)
            .description(r::PHONE_REMOTE_DESCRIPTION)
            .action(phone_switch)
            .children(
                self.phone
                    .as_ref()
                    .filter(|s| s.enabled && (s.bind_error.is_some() || s.addresses.is_empty()))
                    .map(|status| {
                        Alert::new("phone-blocked").title(r::phone_remote_summary(status).1)
                    }),
            )
            .when(phone_enabled, |section| section.child(phones))
            .when(!phone_enabled, |section| {
                section.child(hint(r::PHONE_REMOTE_OFF_HINT.to_string()))
            })
            .last(true);
        // `agents-section.tsx`: the switch is the action; on, Agent apps with
        // the summary and Connect; off, a hint line. Your agents and Activity
        // show once there are any.
        let entity = cx.entity();
        let agents_on = self.agents.as_ref().is_some_and(|s| s.enabled);
        let has_agents = self.agents.as_ref().is_some_and(|s| !s.agents.is_empty());
        let has_activity = self.activity.as_ref().is_some_and(|a| !a.is_empty());
        let agents_switch = Switch::new("agents-switch")
            .accessibility_label(agents::copy::SWITCH_LABEL)
            .checked(agents_on)
            .disabled(self.disabled() || self.agents.is_none())
            .on_change(move |enabled, _, cx| {
                entity.update(cx, |this, cx| {
                    this.request(
                        if enabled {
                            "agents.enable"
                        } else {
                            "agents.disable"
                        },
                        json!({}),
                        "Couldn't change Agents. Try again.",
                        cx,
                    )
                })
            });
        let apps = GroupedList::new().item(
            SettingsRow::new("agent-apps", agents::copy::AGENT_APPS)
                .description(
                    self.agents
                        .as_ref()
                        .map(agents::summary_line)
                        .unwrap_or_default(),
                )
                .child(
                    Button::new("connect-agent")
                        .label(agents::copy::CONNECT_COMMAND)
                        .variant(ButtonVariant::Outline)
                        .disabled(self.disabled() || self.agents.is_none())
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_connect_agent(window, cx)),
                        ),
                ),
        );
        let mut agents_list = GroupedList::new().label(agents::copy::YOUR_AGENTS);
        if let Some(status) = &self.agents {
            for (index, agent) in status.agents.iter().enumerate() {
                let id = agent.id.clone();
                let name = agent.name.clone();
                agents_list = agents_list.item(
                    div()
                        .child(
                            ListRow::new(("agent", index), name.clone()).child(
                                Button::new(("remove-agent", index))
                                    .label(agents::copy::REMOVE_MENU)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(self.disabled())
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.ask(
                                            Confirmation {
                                                title: agents::copy::remove_title(Some(&name)),
                                                description: agents::copy::REMOVE_DESCRIPTION
                                                    .into(),
                                                label: agents::copy::REMOVE_CONFIRM,
                                                method: "agents.remove",
                                                params: json!({"id":id}),
                                            },
                                            window,
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
                                .child(agents::last_action(agent, chrono::Utc::now()).0),
                        ),
                );
            }
        }
        let off_words = if has_agents {
            agents::copy::OFF_WITH_AGENTS
        } else {
            agents::copy::OFF_HINT
        };
        let agents = PanelSection::new(agents::copy::AGENTS)
            .title(agents::copy::AGENTS)
            .description(agents::copy::HELP)
            .action(agents_switch)
            .last(true)
            .children(
                self.agents
                    .as_ref()
                    .and_then(|s| s.bind_error_kind.as_deref())
                    .map(|kind| Alert::new("agents-error").title(agents::bind_error_copy(kind))),
            )
            .when(agents_on, |section| section.child(apps))
            .when(!agents_on, |section| {
                section.child(hint(off_words.to_string()))
            })
            .when(has_agents, |section| section.child(agents_list));
        let entity = cx.entity();
        let mut filter = videorc_kit::select::Select::new("activity-filter")
            .accessibility_label(agents::copy::ACTIVITY_FROM)
            .option("", agents::copy::ALL_AGENTS)
            .value(Some(
                self.activity_filter.clone().unwrap_or_default().into(),
            ));
        if let Some(status) = &self.agents {
            for agent in &status.agents {
                filter = filter.option(agent.id.clone(), agent.name.clone());
            }
        }
        let filter = filter.on_change(move |id, _, cx| {
            entity.update(cx, |this, cx| {
                this.activity_filter = (!id.is_empty()).then(|| id.to_string());
                this.activity = None;
                this.revision += 1;
                this.refresh(cx);
                cx.notify();
            })
        });
        let mut activity_rows = GroupedList::new();
        if let Some(entries) = &self.activity {
            if entries.is_empty() {
                activity_rows =
                    activity_rows.item(ListRow::new("no-actions", agents::copy::NO_ACTIONS));
            }
            for (index, entry) in entries.iter().enumerate() {
                activity_rows = activity_rows
                    .row(
                        ListRow::new(("activity", index), agents::tool_title(&entry.tool))
                            .context(entry.agent_name.clone())
                            .meta(agents::outcome_view(&entry.outcome).0),
                    )
                    .item(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(agents::activity_detail(entry)),
                    );
            }
        } else {
            activity_rows = activity_rows.item(ListRow::new(
                "loading-activity",
                agents::copy::LOADING_ACTIVITY,
            ));
        }
        // Activity sits in the Agents section: its label and the "Activity
        // from" select (`w-44`) over the list.
        let agents = agents.when(has_agents || has_activity, |section| {
            section.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .px(px(4.))
                            .child(SectionLabel::new(agents::copy::ACTIVITY))
                            .child(div().flex_none().w(px(176.)).child(filter)),
                    )
                    .child(activity_rows),
            )
        });
        ConfigGrid::new("settings-remote-grid")
            .pair(true)
            .child(div().child(remote).child(phone))
            .child(div().child(agents))
            .into_any_element()
    }
}
