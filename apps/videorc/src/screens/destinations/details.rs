//! Stream details basics on Setup (`MetadataEditor` title/description/privacy/save).

use gpui::{AnyElement, Context, Entity, Focusable, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::details;
use videorc_app_core::livestream::{DetailsState, details as details_mod};
use videorc_kit::StatusBadge;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::InputState;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::status_dot::StatusTone;
use videorc_kit::textarea::TextareaState;
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
                this.title_checked = true;
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
        // A save (a new `updatedAt`) refills both fields and is clean.
        if inputs.seeded_at.as_deref() != Some(draft.updated_at.as_str()) {
            inputs.title.update(cx, |input, cx| {
                input.set_value(draft.title.clone(), window, cx);
            });
            inputs.description.update(cx, |input, cx| {
                input.set_value(draft.description.clone(), window, cx);
            });
            inputs.seeded_at = Some(draft.updated_at.clone());
            self.details_dirty = false;
            return;
        }
        // The draft changed elsewhere (Go live's fields, then Cancel or
        // not): Electron has one draft, so a field nobody is typing in
        // follows it, and the edit is unsaved here too.
        let mut followed = false;
        let title = inputs.title.clone();
        if !title.read(cx).focus_handle(cx).is_focused(window)
            && title.read(cx).value().as_ref() != draft.title.as_str()
        {
            title.update(cx, |input, cx| {
                input.set_value(draft.title.clone(), window, cx)
            });
            followed = true;
        }
        let description = inputs.description.clone();
        if !description.read(cx).focus_handle(cx).is_focused(window)
            && description.read(cx).value().as_ref() != draft.description.as_str()
        {
            description.update(cx, |input, cx| {
                input.set_value(draft.description.clone(), window, cx)
            });
            followed = true;
        }
        if followed {
            self.details_dirty = true;
        }
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
        let mut section = PanelSection::new("destinations-details")
            .title(page_copy::STREAM_DETAILS)
            .icon(icon(IconName::TextAa, 16., hsla(t.muted_foreground)));
        // The header's end: the status, then Save (`variant="secondary"`).
        let mut action = div().flex().items_center().gap(px(8.));
        // `StatusBadge` (the tone's dot and the words).
        if let Some((tone, label)) = status {
            let tone = match tone {
                "good" => StatusTone::Good,
                "warn" => StatusTone::Warn,
                _ => StatusTone::Neutral,
            };
            action = action.child(StatusBadge::new(label).tone(tone));
        }
        action = action.child(
            Button::new("stream-details-save")
                .label(if state.save_pending {
                    page_copy::SAVING
                } else {
                    page_copy::SAVE
                })
                .variant(ButtonVariant::Secondary)
                .icon(IconName::FloppyDisk)
                .disabled(disabled || state.save_pending)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.title_checked = true;
                            this.save_details();
                            cx.notify();
                        })
                    }
                }),
        );
        section = section.action(action);

        let Some(inputs) = &self.details_inputs else {
            return section.into_any_element();
        };

        // Electron's `titleRequired={titleChecked}`: an empty title is no
        // error until the streamer has edited it or pressed Save (V-3).
        let title_empty = state
            .draft
            .as_ref()
            .is_none_or(|draft| draft.title.trim().is_empty());
        let title_issue = state
            .validation
            .as_ref()
            .and_then(|v| v.issue("title", None))
            .filter(|_| self.title_checked || !title_empty)
            .map(|i| i.message.clone());
        let description_issue = state
            .validation
            .as_ref()
            .and_then(|v| v.issue("description", None))
            .map(|i| i.message.clone());

        // `BroadcastInfoFields`: privacy is YouTube's, drawn while a YouTube
        // destination is on.
        let capture = self.studio.snapshot().settings.capture_doc.clone();
        let youtube_on = videorc_app_core::livestream::targets::targets(&capture)
            .iter()
            .any(|target| target.enabled && target.platform == "youtube");
        let draft_now = state.draft.as_ref();
        section = section.child(crate::screens::broadcast_fields::broadcast_info_fields(
            t,
            crate::screens::broadcast_fields::Fields {
                id: "stream",
                title: &inputs.title,
                title_counter: details::title_counter(
                    &draft_now.map(|d| d.title.clone()).unwrap_or_default(),
                ),
                title_error: title_issue,
                description: &inputs.description,
                description_error: description_issue,
                privacy: youtube_on
                    .then(|| draft_now.map(|d| d.default_privacy).unwrap_or_default()),
                disabled: disabled || state.save_pending,
            },
            {
                let entity = entity.clone();
                move |privacy, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.studio.patch_metadata_draft(|draft| {
                            draft.default_privacy = privacy;
                        });
                        this.details_dirty = true;
                        cx.notify();
                    });
                }
            },
        ));

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

        section.into_any_element()
    }

    fn save_details(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.save_metadata_draft().await;
        });
    }
}
