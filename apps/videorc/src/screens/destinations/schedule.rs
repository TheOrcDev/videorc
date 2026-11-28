//! Schedule / Edit dialog (`ScheduleStreamDialog`, P860–P876).

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::livestream::scheduled::{self, Event};
use videorc_app_core::livestream::scheduled_copy as copy;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::field::Field as KitField;
use videorc_kit::input::{Input, InputState};
use videorc_kit::select::Select;
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;
use crate::screens::dialogs::after_open_change;

pub(super) struct ScheduleEditor {
    pub provider: String,
    pub event_id: Option<String>,
    pub revision: serde_json::Value,
    pub account_id: String,
    pub title: Entity<InputState>,
    pub description: Entity<TextareaState>,
    pub start: Entity<InputState>,
    pub dialog: DialogHandle,
    pub saving: bool,
    pub error: Option<String>,
}

impl DestinationsPanel {
    pub(super) fn open_schedule(
        &mut self,
        provider: String,
        event: Option<Event>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let title = cx.new(|cx| InputState::new(window, cx).placeholder("Title"));
        let description = cx.new(|cx| TextareaState::new(window, cx));
        let start = cx.new(|cx| InputState::new(window, cx).placeholder("YYYY-MM-DDTHH:MM"));
        let default_account = self
            .studio
            .platforms_now()
            .account(&provider)
            .map(|a| a.account_id.clone())
            .unwrap_or_default();
        let (event_id, revision, account_id, title_value, description_value, start_value) =
            if let Some(event) = &event {
                (
                    Some(event.id.clone()),
                    event.revision.clone(),
                    event
                        .account_id
                        .clone()
                        .unwrap_or_else(|| default_account.clone()),
                    event.requested.title.clone(),
                    event.requested.description.clone(),
                    event.requested.local_start.clone(),
                )
            } else {
                let meta = scheduled::fresh_metadata(&provider, chrono::Utc::now(), "Etc/UTC");
                (
                    None,
                    serde_json::Value::Null,
                    default_account,
                    meta.title,
                    meta.description,
                    meta.local_start,
                )
            };
        title.update(cx, |input, cx| {
            input.set_value(title_value, window, cx);
        });
        description.update(cx, |input, cx| {
            input.set_value(description_value, window, cx);
        });
        start.update(cx, |input, cx| {
            input.set_value(start_value, window, cx);
        });
        let dialog = DialogHandle::new(false);
        dialog.open(window, cx);
        self.schedule = Some(ScheduleEditor {
            provider,
            event_id,
            revision,
            account_id,
            title,
            description,
            start,
            dialog,
            saving: false,
            error: None,
        });
        cx.notify();
    }

    pub(super) fn close_schedule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Take first so Escape/`on_open_change` re-entry is a no-op.
        let Some(editor) = self.schedule.take() else {
            return;
        };
        editor.dialog.close(window, cx);
        cx.notify();
    }

    pub(super) fn schedule_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(editor) = &self.schedule else {
            return div().into_any_element();
        };
        if !editor.dialog.is_open() {
            return div().into_any_element();
        }
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let label = scheduled::provider_label(&editor.provider);
        let noun = scheduled::provider_noun(&editor.provider);
        let heading = if editor.event_id.is_some() {
            copy::edit_title(label, noun)
        } else {
            copy::schedule_on(label)
        };
        let description = if editor.provider == "x" {
            "Your broadcast appears on X. Start it manually from Videorc."
        } else {
            "Your event appears on YouTube. Start it manually from Videorc."
        };

        let platforms = self.studio.platforms_now();
        let accounts: Vec<_> = platforms
            .accounts
            .iter()
            .filter(|a| a.platform == editor.provider)
            .map(|a| (a.account_id.clone(), a.account_label.clone()))
            .collect();

        // Electron's `ScheduleStreamDialog` is a FieldGroup of plain Fields:
        // each label above its control. As SettingsRows the inputs took the
        // dialog's width and squeezed their labels to one letter a line (the
        // Add command dialog's bug, #2563).
        let body = div().flex().flex_col().gap(px(16.)).child(
            KitField::new("schedule-account")
                .label(if editor.provider == "x" {
                    "Account"
                } else {
                    "Channel"
                })
                .child({
                    let mut select = Select::new("schedule-account")
                        .accessibility_label("Channel")
                        .disabled(editor.event_id.is_some() || accounts.is_empty())
                        .width(220.0)
                        .value(Some(SharedString::from(editor.account_id.clone())))
                        .on_change({
                            let entity = entity.clone();
                            move |value: SharedString, _, cx| {
                                entity.update(cx, |this, cx| {
                                    if let Some(editor) = this.schedule.as_mut() {
                                        editor.account_id = value.to_string();
                                    }
                                    cx.notify();
                                });
                            }
                        });
                    for (id, account_label) in &accounts {
                        select = select.option(id.clone(), account_label.clone());
                    }
                    select
                }),
        );
        let body = body
            .child(
                KitField::new("schedule-title").label("Title").child(
                    Input::new("schedule-title-input", &editor.title)
                        .accessibility_label("Title")
                        .disabled(editor.saving),
                ),
            )
            .child(
                KitField::new("schedule-description")
                    .label("Description")
                    .child(
                        Textarea::new("schedule-description-input", &editor.description)
                            .accessibility_label("Description")
                            .disabled(editor.saving),
                    ),
            )
            .child(
                KitField::new("schedule-start")
                    .label("Date and time")
                    .child(
                        Input::new("schedule-start-input", &editor.start)
                            .accessibility_label("Date and time")
                            .disabled(editor.saving),
                    ),
            );

        let mut dialog = Dialog::new("schedule-stream", &editor.dialog, heading)
            .size(DialogSize::Lg)
            .description(description)
            .child(body);
        if let Some(error) = &editor.error {
            dialog = dialog.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(error.clone()),
            );
        }
        let submit_label = if editor.event_id.is_some() {
            copy::update_noun(noun)
        } else {
            copy::schedule_on(label)
        };
        dialog
            .on_open_change({
                let entity = entity.clone();
                move |open, _, window, cx| {
                    if !open {
                        // Escape / backdrop / X — same as Cancel.
                        after_open_change(&entity.downgrade(), window, cx, |this, window, cx| {
                            this.close_schedule(window, cx)
                        });
                    }
                }
            })
            .footer(
                Button::new("schedule-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Outline)
                    .disabled(editor.saving)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.close_schedule(window, cx));
                        }
                    }),
            )
            .footer(
                Button::new("schedule-submit")
                    .label(submit_label)
                    .variant(ButtonVariant::Default)
                    .disabled(editor.saving)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.submit_schedule(window, cx));
                        }
                    }),
            )
            .into_any_element()
    }

    fn submit_schedule(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = &self.schedule else {
            return;
        };
        let provider = editor.provider.clone();
        let account_id = editor.account_id.clone();
        let title = editor.title.read(cx).value().to_string();
        let description = editor.description.read(cx).value().to_string();
        let local_start = editor.start.read(cx).value().to_string();
        let event_id = editor.event_id.clone();
        let revision = editor.revision.clone();
        if let Some(editor) = self.schedule.as_mut() {
            editor.saving = true;
            editor.error = None;
        }
        cx.notify();
        let studio = self.studio.clone();
        let action = if event_id.is_some() {
            "update"
        } else {
            "schedule"
        };
        let mut params = json!({
            "provider": provider,
            "accountId": account_id,
            "requested": {
                "title": title,
                "description": description,
                "localStart": local_start,
                "privacy": "public",
                "madeForKids": false,
            },
        });
        if let Some(id) = &event_id {
            params["eventId"] = json!(id);
            params["expectedRevision"] = revision;
        }
        let _ = window;
        cx.spawn(async move |this, cx| {
            let result = studio.scheduled_mutate(action, params).await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(_) => {
                    this.schedule = None;
                    cx.notify();
                }
                Err(error) => {
                    if let Some(editor) = this.schedule.as_mut() {
                        editor.saving = false;
                        editor.error = Some(error.message);
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }
}
