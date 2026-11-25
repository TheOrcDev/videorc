//! Discord announcements tab (P877–P894).

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use serde_json::json;
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::discord::{self, DiscordView, Test};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn ensure_discord_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.discord_paste.is_some() {
            return;
        }
        let paste =
            cx.new(|cx| InputState::new(window, cx).placeholder(page_copy::WEBHOOK_PLACEHOLDER));
        cx.subscribe(&paste, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.discord_memory.paste = state.read(cx).value().to_string();
                this.discord_memory.refusal = None;
                cx.notify();
            }
        })
        .detach();
        self.discord_paste = Some(paste);
    }

    pub(super) fn discord_body(
        &self,
        view: &DiscordView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().type_scale(text::LABEL).child(page_copy::DISCORD))
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(view.description.clone()),
            );

        if view.loading {
            return column
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(page_copy::LOADING_DISCORD),
                )
                .into_any_element();
        }
        if let Some(error) = &view.error {
            return column
                .child(
                    Alert::new("discord-error")
                        .variant(AlertVariant::Destructive)
                        .title(error.clone()),
                )
                .into_any_element();
        }

        let mut section = PanelSection::new("discord-settings").last(true);

        if view.paste_shown {
            if let Some(paste) = &self.discord_paste {
                let mut paste_row = div().flex().flex_col().gap(px(4.)).child(
                    SettingsRow::new("discord-webhook", view.paste_label.clone()).child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                Input::new("discord-webhook-input", paste)
                                    .accessibility_label(page_copy::WEBHOOK_URL)
                                    .disabled(self.discord_memory.paste_pending)
                                    .invalid(view.paste_error.is_some()),
                            )
                            .child(
                                Button::new("discord-webhook-connect")
                                    .label(if self.discord_memory.paste_pending {
                                        page_copy::CONNECTING
                                    } else {
                                        page_copy::CONNECT
                                    })
                                    .variant(ButtonVariant::Outline)
                                    .disabled(
                                        self.discord_memory.paste_pending
                                            || self.discord_memory.paste.trim().is_empty()
                                            || view.paste_error.is_some(),
                                    )
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |this, cx| this.connect_webhook(cx))
                                        }
                                    }),
                            ),
                    ),
                );
                paste_row = paste_row.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(page_copy::WEBHOOK_HOWTO),
                );
                if let Some(error) = &view.paste_error {
                    paste_row = paste_row.child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.destructive))
                            .child(error.clone()),
                    );
                }
                section = section.child(paste_row);
            }
        }

        if !view.webhooks.is_empty() {
            let mut list = GroupedList::new();
            for webhook in &view.webhooks {
                let id = webhook.id.clone();
                let mut row = div().child(
                    ListRow::new(
                        format!("discord-webhook-{}", webhook.id),
                        webhook.name.clone(),
                    )
                    .context(webhook.line.clone()),
                );
                let mut actions = div().flex().flex_wrap().gap(px(8.)).px(px(12.)).pb(px(8.));
                if let Some(last) = &webhook.last_post {
                    actions = actions.child(
                        div()
                            .flex_1()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(last.clone()),
                    );
                }
                for error in &webhook.errors {
                    actions = actions.child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.destructive))
                            .child(error.clone()),
                    );
                }
                if let Some(line) = &webhook.test_line {
                    actions = actions.child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(line.clone()),
                    );
                }
                actions = actions
                    .child(
                        Button::new(format!("discord-test-{id}"))
                            .label(webhook.test_label.clone())
                            .variant(ButtonVariant::Outline)
                            .disabled(!webhook.test_enabled)
                            .on_click({
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| this.test_webhook(id.clone(), cx))
                                }
                            }),
                    )
                    .child(
                        Button::new(format!("discord-remove-{id}"))
                            .label(page_copy::REMOVE)
                            .variant(ButtonVariant::Ghost)
                            .on_click({
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, _| this.remove_webhook(id.clone()))
                                }
                            }),
                    );
                if let Some(url) = &webhook.view_url {
                    let url = url.clone();
                    actions = actions.child(
                        Button::new(format!("discord-view-{id}"))
                            .label(page_copy::VIEW_IN_DISCORD)
                            .variant(ButtonVariant::Ghost)
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
                row = row.child(actions);
                list = list.item(row);
            }
            section = section.child(list);

            if view.add_enabled {
                section = section.child(
                    Button::new("discord-add-webhook")
                        .label(page_copy::ADD_WEBHOOK)
                        .variant(ButtonVariant::Outline)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.discord_memory.adding = true;
                                    cx.notify();
                                })
                            }
                        }),
                );
            } else if let Some(reason) = &view.add_reason {
                section = section.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(reason.clone()),
                );
            }

            section = section.child(
                SettingsGroup::new()
                    .row(
                        SettingsRow::new("discord-announce", page_copy::ANNOUNCE_WHEN_LIVE)
                            .description(page_copy::ANNOUNCE_DESCRIPTION)
                            .child(
                                Switch::new("discord-enabled")
                                    .accessibility_label(page_copy::ANNOUNCE_WHEN_LIVE)
                                    .checked(view.enabled)
                                    .on_change({
                                        let entity = entity.clone();
                                        move |value, _, cx| {
                                            entity.update(cx, |this, _| {
                                                this.discord_patch(json!({ "enabled": value }))
                                            })
                                        }
                                    }),
                            ),
                    )
                    .row(
                        SettingsRow::new("discord-post-as", page_copy::POST_AS)
                            .description(page_copy::POST_AS_DESCRIPTION)
                            .child({
                                let selected = view
                                    .post_as
                                    .get(view.post_as_selected.max(0) as usize)
                                    .map(|(value, _)| value.clone());
                                let mut select = Select::new("discord-post-as")
                                    .accessibility_label(page_copy::POST_AS)
                                    .width(200.0)
                                    .value(selected.map(SharedString::from))
                                    .on_change({
                                        let entity = entity.clone();
                                        move |value: SharedString, _, cx| {
                                            entity.update(cx, |this, _| {
                                                this.discord_patch(json!({
                                                    "postAs": discord::post_as_from_key(value.as_ref())
                                                }))
                                            })
                                        }
                                    });
                                for (value, label) in &view.post_as {
                                    select = select.option(value.clone(), label.clone());
                                }
                                select
                            }),
                    )
                    .row(
                        SettingsRow::new("discord-ping", page_copy::PING)
                            .description(page_copy::PING_DESCRIPTION)
                            .child({
                                let value = match view.ping {
                                    1 => "here",
                                    2 => "everyone",
                                    _ => "none",
                                };
                                SegmentedControl::new("discord-ping")
                                    .small(true)
                                    .accessibility_label(page_copy::PING)
                                    .value(Some(SharedString::from(value)))
                                    .option(Segment::new("none", page_copy::NO_PING))
                                    .option(Segment::new("here", page_copy::PING_HERE))
                                    .option(Segment::new("everyone", page_copy::PING_EVERYONE))
                                    .on_change({
                                        let entity = entity.clone();
                                        move |value, _, cx| {
                                            let ping = match value.as_ref() {
                                                "here" => "here",
                                                "everyone" => "everyone",
                                                _ => "off",
                                            };
                                            entity.update(cx, |this, _| {
                                                this.discord_patch(json!({ "ping": ping }))
                                            })
                                        }
                                    })
                            }),
                    )
                    .row(
                        SettingsRow::new("discord-footer", page_copy::VIDEORC_FOOTER)
                            .description(page_copy::FOOTER_DESCRIPTION)
                            .child(
                                Switch::new("discord-branding")
                                    .accessibility_label(page_copy::VIDEORC_FOOTER)
                                    .checked(view.branding)
                                    .on_change({
                                        let entity = entity.clone();
                                        move |value, _, cx| {
                                            entity.update(cx, |this, _| {
                                                this.discord_patch(json!({ "branding": value }))
                                            })
                                        }
                                    }),
                            ),
                    ),
            );

            if !view.links.is_empty() {
                let mut links = GroupedList::new();
                for link in &view.links {
                    let id = link.target_id.clone();
                    links = links.item(
                        ListRow::new(format!("discord-link-{id}"), link.label.clone())
                            .context(link.context.clone())
                            .child(
                                Switch::new(format!("discord-link-include-{id}"))
                                    .accessibility_label(page_copy::link_in_post(&link.label))
                                    .checked(link.included)
                                    .disabled(!link.linkable)
                                    .on_change({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |value, _, cx| {
                                            entity.update(cx, |this, _| {
                                                this.toggle_discord_link(id.clone(), value)
                                            })
                                        }
                                    }),
                            ),
                    );
                }
                section = section.child(
                    PanelSection::new("discord-links")
                        .title(page_copy::LINKS_IN_THE_POST)
                        .child(links),
                );
            }
        }

        column.child(section).into_any_element()
    }

    fn connect_webhook(&mut self, cx: &mut Context<Self>) {
        if self.discord_memory.paste_pending {
            return;
        }
        let url = self.discord_memory.paste.clone();
        self.discord_memory.paste_pending = true;
        self.discord_memory.refusal = None;
        cx.notify();
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.discord_save_webhook(&url).await });
        cx.spawn(async move |this, cx| {
            let refused = job.await.unwrap_or(None);
            let _ = this.update(cx, |this, cx| {
                this.discord_memory.paste_pending = false;
                if let Some(message) = refused {
                    this.discord_memory.refusal = Some(message);
                } else {
                    this.discord_memory.paste.clear();
                    this.discord_memory.adding = false;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn remove_webhook(&self, id: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.discord_remove_webhook(&id).await;
        });
    }

    fn test_webhook(&mut self, id: String, cx: &mut Context<Self>) {
        self.discord_memory.tests.insert(id.clone(), Test::Sending);
        cx.notify();
        let studio = self.studio.clone();
        let webhook_id = id.clone();
        let job = self
            .runtime
            .spawn(async move { studio.discord_send_test(&webhook_id).await });
        cx.spawn(async move |this, cx| {
            let result = job.await.unwrap_or_else(|_| Err("Test failed.".into()));
            let _ = this.update(cx, |this, cx| {
                this.discord_memory.tests.insert(
                    id,
                    match result {
                        Ok(url) => Test::Sent(url),
                        Err(error) => Test::Failed(error),
                    },
                );
                cx.notify();
            });
        })
        .detach();
    }

    fn discord_patch(&self, patch: serde_json::Value) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio.discord_update(patch).await;
        });
    }

    fn toggle_discord_link(&self, target_id: String, included: bool) {
        let studio = self.studio.clone();
        let details = self.studio.details_now();
        let Some(snapshot) = details.discord else {
            return;
        };
        let excluded = discord::next_excluded(&snapshot.excluded_target_ids, &target_id, included);
        self.runtime.spawn(async move {
            let _ = studio
                .discord_update(json!({ "excludedTargetIds": excluded }))
                .await;
        });
    }
}
