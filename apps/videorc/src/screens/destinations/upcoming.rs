//! Upcoming tab (`scheduled` sections, P841–P859). Edit opens the schedule dialog.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::livestream::scheduled::{self, Chip, Event, Section};
use videorc_app_core::livestream::scheduled_copy as copy;
use videorc_app_core::studio::scheduled::ScheduledState;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::empty::Empty;
use videorc_kit::kebab_menu::{KebabMenu, KebabMenuItem};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn upcoming_body(
        &self,
        state: &ScheduledState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let now = chrono::Utc::now();

        let mut header = div().flex().items_center().justify_between().gap(px(8.));
        if let Some(line) = scheduled::last_checked_label(state.last_checked_at.as_deref(), now) {
            header = header.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(line),
            );
        } else {
            header = header.child(div());
        }
        header = header.child(
            Button::new("upcoming-refresh")
                .label(if state.refreshing {
                    copy::REFRESHING
                } else {
                    copy::REFRESH
                })
                .variant(ButtonVariant::Outline)
                .disabled(state.refreshing)
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, _| this.refresh_scheduled());
                }),
        );

        if let Some(error) = &state.error {
            return div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(header)
                .child(
                    Alert::new("upcoming-error")
                        .variant(AlertVariant::Destructive)
                        .title(error.clone()),
                )
                .into_any_element();
        }

        if !state.loaded {
            return div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(header)
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Loading upcoming streams…"),
                )
                .into_any_element();
        }

        let upcoming = scheduled::sections(&state.events, state.capabilities.as_ref(), false);
        let past = scheduled::sections(&state.events, state.capabilities.as_ref(), true);

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(header)
            .child(self.provider_sections(
                copy::UPCOMING_TITLE,
                copy::UPCOMING_DESCRIPTION,
                &upcoming,
                false,
                t,
                cx,
            ))
            .child(self.provider_sections(
                copy::PAST_TITLE,
                copy::PAST_DESCRIPTION,
                &past,
                true,
                t,
                cx,
            ))
            .into_any_element()
    }

    fn refresh_scheduled(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.refresh_scheduled().await;
        });
    }

    fn provider_sections(
        &self,
        title: &str,
        description: &str,
        sections: &[Section],
        past: bool,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(8.)).child(
            PanelSection::new(if past {
                "upcoming-past"
            } else {
                "upcoming-list"
            })
            .title(title)
            .description(description)
            .last(past),
        );
        for section in sections {
            column = column.child(self.provider_section(section, past, t, cx));
        }
        column.into_any_element()
    }

    fn provider_section(
        &self,
        section: &Section,
        past: bool,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = scheduled::provider_label(&section.provider);
        let noun = scheduled::provider_noun(&section.provider);
        let entity = cx.entity();
        let mut panel = PanelSection::new(format!(
            "upcoming-{}-{}",
            section.provider,
            if past { "past" } else { "up" }
        ))
        .title(label);

        if !past && section.available {
            let provider = section.provider.clone();
            panel = panel.action(
                Button::new(format!("schedule-on-{}", section.provider))
                    .label(copy::schedule_on(label))
                    .variant(ButtonVariant::Outline)
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |this, cx| {
                            this.open_schedule(provider.clone(), None, window, cx);
                        });
                    }),
            );
        }

        if !section.available {
            let reason = section
                .reason
                .clone()
                .unwrap_or_else(|| format!("{label} scheduling isn’t available."));
            return panel
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(reason),
                )
                .into_any_element();
        }

        if section.events.is_empty() {
            let empty = if past {
                copy::none_past(&section.provider, noun)
            } else {
                copy::none_upcoming(&section.provider, noun)
            };
            return panel
                .child(Empty::new().description(empty))
                .into_any_element();
        }

        let mut list = GroupedList::new();
        for event in &section.events {
            list = list.item(self.event_row(event, past, t, cx));
        }
        panel.child(list).into_any_element()
    }

    fn event_row(
        &self,
        event: &Event,
        past: bool,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> ListRow {
        let title = if event.requested.title.trim().is_empty() {
            "Untitled".to_string()
        } else {
            event.requested.title.clone()
        };
        let when = scheduled::when_label(event);
        let chip = match scheduled::lifecycle_chip(event) {
            Chip::Tag(label) | Chip::Live(label) => {
                Badge::new(label).variant(BadgeVariant::Outline)
            }
            Chip::Status(label, "good") => Badge::new(label).variant(BadgeVariant::Success),
            Chip::Status(label, "warn") => Badge::new(label).variant(BadgeVariant::Warning),
            Chip::Status(label, _) => Badge::new(label).variant(BadgeVariant::Outline),
        };
        let privacy = scheduled::privacy_label(event).unwrap_or("");
        let context = if privacy.is_empty() {
            when
        } else {
            format!("{when} · {privacy}")
        };
        let entity = cx.entity();
        let mut row = ListRow::new(format!("event-{}", event.id), title)
            .context(context)
            .child(chip);

        if !past {
            let mut items = Vec::new();
            if scheduled::can_edit(event) {
                let event = event.clone();
                let provider = event.provider().to_string();
                let entity = entity.clone();
                items.push(KebabMenuItem::new(
                    copy::EDIT,
                    copy::EDIT,
                    move |window, cx| {
                        entity.update(cx, |this, cx| {
                            this.open_schedule(provider.clone(), Some(event.clone()), window, cx);
                        });
                    },
                ));
            }
            if scheduled::needs_recovery(event) {
                let id = event.id.clone();
                let revision = event.revision.clone();
                let entity = entity.clone();
                items.push(KebabMenuItem::new(
                    copy::RECOVER,
                    copy::RECOVER,
                    move |_, cx| {
                        entity.update(cx, |this, _| {
                            this.scheduled_action(
                                "recover",
                                serde_json::json!({
                                    "eventId": id,
                                    "expectedRevision": revision,
                                }),
                            );
                        });
                    },
                ));
            }
            {
                let id = event.id.clone();
                let revision = event.revision.clone();
                let entity = entity.clone();
                items.push(KebabMenuItem::new(
                    "duplicate",
                    copy::DUPLICATE,
                    move |_, cx| {
                        entity.update(cx, |this, _| {
                            this.scheduled_action(
                                "duplicate",
                                serde_json::json!({
                                    "eventId": id,
                                    "expectedRevision": revision,
                                }),
                            );
                        });
                    },
                ));
            }
            {
                let id = event.id.clone();
                let revision = event.revision.clone();
                let entity = entity.clone();
                let noun = scheduled::provider_noun(event.provider());
                items.push(
                    KebabMenuItem::new("cancel", copy::cancel_noun(noun), move |_, cx| {
                        entity.update(cx, |this, _| {
                            this.scheduled_action(
                                "cancel",
                                serde_json::json!({
                                    "eventId": id,
                                    "expectedRevision": revision,
                                }),
                            );
                        });
                    })
                    .destructive(true),
                );
            }
            if !items.is_empty() {
                let _ = t;
                row = row.child(KebabMenu::new(
                    SharedString::from(format!("event-menu-{}", event.id)),
                    items,
                ));
            }
        }
        row
    }

    fn scheduled_action(&self, action: &str, params: serde_json::Value) {
        let studio = self.studio.clone();
        let action = action.to_string();
        self.runtime.spawn(async move {
            let _ = studio.scheduled_mutate(&action, params).await;
        });
    }
}
