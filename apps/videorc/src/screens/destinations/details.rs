//! Stream details basics on Setup (`MetadataEditor` title/description/privacy/save).

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::details::{self, Privacy};
use videorc_app_core::livestream::{DetailsState, details as details_mod};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::input::{Input, InputState};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

pub(super) struct DetailsInputs {
    pub title: Entity<InputState>,
    pub description: Entity<TextareaState>,
    seeded_at: Option<String>,
}

impl DestinationsPanel {
    pub(super) fn ensure_details_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.details_inputs.is_some() {
            return;
        }
        let title = cx.new(|cx| InputState::new(window, cx).placeholder(page_copy::UNTITLED));
        let description =
            cx.new(|cx| TextareaState::new(window, cx).placeholder(page_copy::OPTIONAL));
        cx.subscribe(&title, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let value = state.read(cx).value().to_string();
                this.studio.patch_metadata_draft(|draft| {
                    draft.title = value;
                });
                this.details_dirty = true;
                cx.notify();
            }
        })
        .detach();
        cx.subscribe(&description, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let value = state.read(cx).value().to_string();
                this.studio.patch_metadata_draft(|draft| {
                    draft.description = value;
                });
                this.details_dirty = true;
                cx.notify();
            }
        })
        .detach();
        self.details_inputs = Some(DetailsInputs {
            title,
            description,
            seeded_at: None,
        });
    }

    pub(super) fn sync_details_inputs(
        &mut self,
        state: &DetailsState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(inputs) = self.details_inputs.as_mut() else {
            return;
        };
        let Some(draft) = state.draft.as_ref() else {
            return;
        };
        if inputs.seeded_at.as_deref() == Some(draft.updated_at.as_str()) {
            return;
        }
        inputs.title.update(cx, |input, cx| {
            input.set_value(draft.title.clone(), window, cx);
        });
        inputs.description.update(cx, |input, cx| {
            input.set_value(draft.description.clone(), window, cx);
        });
        inputs.seeded_at = Some(draft.updated_at.clone());
        self.details_dirty = false;
    }

    pub(super) fn details_section(
        &mut self,
        state: &DetailsState,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        if state.draft.is_none() {
            return PanelSection::new("destinations-details")
                .title(page_copy::STREAM_DETAILS)
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(page_copy::LOADING_DETAILS),
                )
                .into_any_element();
        }

        let dirty = self.details_dirty;
        let status = details_mod::details_status(dirty, state.validation.as_ref());
        let mut section =
            PanelSection::new("destinations-details").title(page_copy::STREAM_DETAILS);
        if let Some((tone, label)) = status {
            let variant = match tone {
                "good" => BadgeVariant::Success,
                "warn" => BadgeVariant::Warning,
                _ => BadgeVariant::Outline,
            };
            section = section.action(Badge::new(label).variant(variant));
        }

        let Some(inputs) = &self.details_inputs else {
            return section.into_any_element();
        };

        let title_issue = state
            .validation
            .as_ref()
            .and_then(|v| v.issue("title", None))
            .map(|i| i.message.clone());
        let description_issue = state
            .validation
            .as_ref()
            .and_then(|v| v.issue("description", None))
            .map(|i| i.message.clone());

        section = section.child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("stream-title", page_copy::TITLE)
                        .description(details::title_counter(
                            &state
                                .draft
                                .as_ref()
                                .map(|d| d.title.clone())
                                .unwrap_or_default(),
                        ))
                        .child(
                            Input::new("stream-title-input", &inputs.title)
                                .accessibility_label(page_copy::TITLE)
                                .disabled(disabled || state.save_pending)
                                .invalid(title_issue.is_some()),
                        ),
                )
                .row(
                    SettingsRow::new("stream-description", page_copy::DESCRIPTION)
                        .description(page_copy::OPTIONAL)
                        .child(
                            Textarea::new("stream-description-input", &inputs.description)
                                .accessibility_label(page_copy::DESCRIPTION)
                                .disabled(disabled || state.save_pending)
                                .invalid(description_issue.is_some()),
                        ),
                )
                .row(
                    SettingsRow::new("stream-privacy", page_copy::PRIVACY)
                        .description(
                            state
                                .draft
                                .as_ref()
                                .map(|d| d.default_privacy.hint())
                                .unwrap_or(""),
                        )
                        .child({
                            let privacy = state
                                .draft
                                .as_ref()
                                .map(|d| d.default_privacy)
                                .unwrap_or_default();
                            let mut control = SegmentedControl::new("stream-privacy")
                                .small(true)
                                .accessibility_label(page_copy::PRIVACY)
                                .disabled(disabled || state.save_pending)
                                .value(Some(SharedString::from(privacy_value(privacy))))
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        let privacy = privacy_from_value(value.as_ref());
                                        entity.update(cx, |this, cx| {
                                            this.studio.patch_metadata_draft(|draft| {
                                                draft.default_privacy = privacy;
                                            });
                                            this.details_dirty = true;
                                            cx.notify();
                                        });
                                    }
                                });
                            for privacy in Privacy::ALL {
                                control = control
                                    .option(Segment::new(privacy_value(privacy), privacy.label()));
                            }
                            control
                        }),
                ),
        );

        if let Some(issue) = title_issue.or(description_issue) {
            section = section.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(issue),
            );
        }

        let youtube_signed_in = self
            .studio
            .platforms_now()
            .account("youtube")
            .is_some_and(|a| !a.account_id.is_empty());
        let draft = state.draft.as_ref();
        section = section.child(self.thumbnail_row(
            draft.and_then(|d| d.thumbnail_asset_id.as_deref()),
            youtube_signed_in,
            disabled || state.save_pending,
            window,
            cx,
        ));

        // Category pickers for Twitch / Kick when those destinations are on.
        let platforms = self.studio.platforms_now();
        let capture = self.studio.snapshot().settings.capture_doc.clone();
        let targets = videorc_app_core::livestream::targets::targets(&capture);
        for target in &targets {
            if !target.enabled {
                continue;
            }
            let platform = target.platform.as_str();
            let override_draft =
                draft.and_then(|d| d.target_overrides.iter().find(|o| o.platform == platform));
            match platform {
                "twitch" if platforms.account("twitch").is_some() => {
                    section = section.child(self.category_row(
                        "twitch",
                        page_copy::TWITCH_CATEGORY,
                        override_draft.and_then(|o| o.twitch_category_id.as_deref()),
                        override_draft.and_then(|o| o.twitch_category_name.as_deref()),
                        disabled || state.save_pending,
                        window,
                        cx,
                    ));
                }
                "kick" if platforms.account("kick").is_some() => {
                    let kick_id = override_draft
                        .and_then(|o| o.kick_category_id)
                        .map(|id| id.to_string());
                    section = section.child(self.category_row(
                        "kick",
                        page_copy::KICK_CATEGORY,
                        kick_id.as_deref(),
                        override_draft.and_then(|o| o.kick_category_name.as_deref()),
                        disabled || state.save_pending,
                        window,
                        cx,
                    ));
                }
                _ => {}
            }
        }

        section = section.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    Button::new("stream-details-save")
                        .label(if state.save_pending {
                            page_copy::SAVING
                        } else {
                            page_copy::SAVE
                        })
                        .variant(ButtonVariant::Default)
                        .disabled(disabled || state.save_pending || !dirty)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| entity.update(cx, |this, _| this.save_details())
                        }),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(page_copy::PRIVACY_NOTE),
                ),
        );

        section.into_any_element()
    }

    fn save_details(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.save_metadata_draft().await;
        });
    }
}

fn privacy_value(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Private => "private",
        Privacy::Unlisted => "unlisted",
        Privacy::Public => "public",
    }
}

fn privacy_from_value(value: &str) -> Privacy {
    match value {
        "unlisted" => Privacy::Unlisted,
        "public" => Privacy::Public,
        _ => Privacy::Private,
    }
}
