//! Twitch / Kick category combobox (`CategoryCombobox`, P753–P757).

use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::details;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::input::{Input, InputState};
use videorc_kit::popover::Popover;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

pub(super) struct CategoryPicker {
    pub platform: String,
    pub search: Entity<InputState>,
    pub open: bool,
    pub query: String,
}

impl DestinationsPanel {
    pub(super) fn ensure_category_picker(
        &mut self,
        platform: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .category_picker
            .as_ref()
            .is_some_and(|p| p.platform == platform)
        {
            return;
        }
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(page_copy::SEARCH_CATEGORIES));
        let platform_owned = platform.to_string();
        cx.subscribe(&search, move |this, state, event: &InputEvent, cx| {
            if !matches!(event, InputEvent::Change) {
                return;
            }
            let query = state.read(cx).value().to_string();
            if let Some(picker) = this.category_picker.as_mut() {
                picker.query = query.clone();
            }
            let platform = platform_owned.clone();
            let studio = this.studio.clone();
            this.runtime.spawn(async move {
                studio.search_categories(&platform, &query).await;
            });
            cx.notify();
        })
        .detach();
        self.category_picker = Some(CategoryPicker {
            platform: platform.to_string(),
            search,
            open: false,
            query: String::new(),
        });
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Explicit screen assembly inputs keep independent view state and callbacks visible"
    )]
    pub(super) fn category_row(
        &mut self,
        platform: &str,
        label: &str,
        selected_id: Option<&str>,
        selected_name: Option<&str>,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.ensure_category_picker(platform, window, cx);
        let Some(picker) = &self.category_picker else {
            return div().into_any_element();
        };
        let state = self.studio.details_now();
        let status = details::category_status(
            &picker.query,
            state.category_pending,
            state.category_results.len(),
            state.category_searched.as_deref(),
        );
        let value_label = selected_name
            .filter(|name| !name.is_empty())
            .map(|name| name.to_string())
            .unwrap_or_else(|| page_copy::CHOOSE_CATEGORY.to_string());
        let open = picker.open;
        let entity = cx.entity();
        let platform_owned = platform.to_string();
        let results = state.category_results.clone();
        let search = picker.search.clone();
        let t = *theme::current(window, cx).theme();
        let has_selected = selected_id.is_some();
        let id = format!("category-{platform}");

        let popover = Popover::new(id)
            .open(open)
            .width(288.)
            .on_open_change({
                let entity = entity.clone();
                move |now, _, cx| {
                    entity.update(cx, |this, cx| {
                        if let Some(picker) = this.category_picker.as_mut() {
                            picker.open = now;
                        }
                        cx.notify();
                    });
                }
            })
            .trigger(
                Button::new(format!("category-trigger-{platform}"))
                    .label(value_label)
                    .variant(ButtonVariant::Outline)
                    .disabled(disabled),
            )
            .content({
                let entity = entity.clone();
                let platform = platform_owned.clone();
                move |window, _cx| {
                    let mut body = div().flex().flex_col().gap(px(6.)).child(
                        Input::new(format!("category-search-{platform}"), &search)
                            .accessibility_label(page_copy::SEARCH_CATEGORIES),
                    );
                    if let Some(status) = &status {
                        body = body.child(
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(status.clone()),
                        );
                    }
                    for (id, name) in &results {
                        let id = id.clone();
                        let name = name.clone();
                        let entity = entity.clone();
                        let platform = platform.clone();
                        body = body.child(
                            Button::new(format!("category-pick-{platform}-{id}"))
                                .label(name.clone())
                                .variant(ButtonVariant::Ghost)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.pick_category(
                                            platform.clone(),
                                            id.clone(),
                                            name.clone(),
                                        );
                                        if let Some(picker) = this.category_picker.as_mut() {
                                            picker.open = false;
                                        }
                                        cx.notify();
                                    });
                                }),
                        );
                    }
                    if has_selected {
                        let entity = entity.clone();
                        let platform = platform.clone();
                        body = body.child(
                            Button::new(format!("category-clear-{platform}"))
                                .label(page_copy::CLEAR_CATEGORY)
                                .variant(ButtonVariant::Ghost)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.clear_category(platform.clone());
                                        if let Some(picker) = this.category_picker.as_mut() {
                                            picker.open = false;
                                        }
                                        cx.notify();
                                    });
                                }),
                        );
                    }
                    let _ = window;
                    body.into_any_element()
                }
            });

        SettingsRow::new(format!("category-row-{platform}"), label.to_string())
            .child(popover)
            .into_any_element()
    }

    fn pick_category(&mut self, platform: String, id: String, name: String) {
        self.studio.patch_target_metadata_draft(&platform, |draft| {
            if platform == "kick" {
                draft.kick_category_id = id.parse().ok();
                draft.kick_category_name = Some(name);
            } else {
                draft.twitch_category_id = Some(id);
                draft.twitch_category_name = Some(name);
            }
        });
        self.details_dirty = true;
    }

    fn clear_category(&mut self, platform: String) {
        self.studio.patch_target_metadata_draft(&platform, |draft| {
            if platform == "kick" {
                draft.kick_category_id = None;
                draft.kick_category_name = None;
            } else {
                draft.twitch_category_id = None;
                draft.twitch_category_name = None;
            }
        });
        self.details_dirty = true;
    }
}
