//! The X destination's rows in Stream details (plan 260 L2): Electron's
//! `XCategoryField` (X's own short list in its order, so a plain Select, not a
//! search) and the "Announce on X timeline" switch. Both are platform
//! settings like Twitch's and Kick's category: they apply whether or not the
//! row customizes its title.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::livestream::x_categories::{
    self as x, X_ANNOUNCE_DESCRIPTION, X_ANNOUNCE_LABEL, X_CATEGORIES_FAILED, X_CATEGORIES_LOADING,
    X_CATEGORIES_RETRY, X_CATEGORY_ACCESSIBLE_LABEL, X_NO_CATEGORY_LABEL, XLiveCategoriesStatus,
};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::label::Label;
use videorc_kit::select::Select;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn x_details_rows(
        &mut self,
        saved_id: Option<&str>,
        saved_name: Option<&str>,
        announce: Option<bool>,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = *theme::current(window, cx).theme();
        let entity = cx.entity();
        let field = self.x_category_field(&t, "x-category", saved_id, saved_name, disabled, {
            let entity = entity.clone();
            move |value, items, cx| {
                entity.update(cx, |this, cx| {
                    this.studio.patch_target_metadata_draft("x", |draft| {
                        x::apply_x_category(draft, &value, &items);
                    });
                    this.details_dirty = true;
                    cx.notify();
                });
            }
        });

        let announce_row = SettingsRow::new("x-metadata-announce", X_ANNOUNCE_LABEL)
            .description(X_ANNOUNCE_DESCRIPTION)
            .child(
                Switch::new("x-metadata-announce-switch")
                    .accessibility_label(X_ANNOUNCE_LABEL)
                    .checked(announce.unwrap_or(true))
                    .disabled(disabled)
                    .on_change(move |value, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.studio.patch_target_metadata_draft("x", |draft| {
                                draft.x_announce = Some(value);
                            });
                            this.details_dirty = true;
                            cx.notify();
                        });
                    }),
            );

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(field)
            .child(announce_row)
            .into_any_element()
    }
    /// `XCategoryField`: X's own short list in its order, so a plain Select
    /// (as Twitch's Language), not a search; the label, the control filling
    /// the column, then one quiet note. Stream details and Live on X both
    /// show it (`id` "x-category" / "x-live-category").
    pub(super) fn x_category_field(
        &self,
        t: &videorc_kit::tokens::Theme,
        id: &'static str,
        saved_id: Option<&str>,
        saved_name: Option<&str>,
        disabled: bool,
        on_change: impl Fn(String, Vec<x::XCategoryItem>, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let platforms = self.studio.platforms_now();
        let status = platforms.x_live_categories_status;
        let pick = x::x_category_pick(&platforms.x_live_categories, status, saved_id, saved_name);
        let select_disabled = disabled || pick.unavailable;

        let mut select = Select::new(id)
            .accessibility_label(X_CATEGORY_ACCESSIBLE_LABEL)
            .full_width(true)
            .disabled(select_disabled)
            .placeholder(if status == XLiveCategoriesStatus::Loading {
                X_CATEGORIES_LOADING
            } else {
                X_NO_CATEGORY_LABEL
            })
            .value(Some(SharedString::from(pick.value.clone())));
        for item in &pick.items {
            select = select.option(item.value.clone(), item.label.clone());
        }
        let items = pick.items.clone();
        let select = select.on_change(move |value, _, cx| {
            on_change(value.to_string(), items.clone(), cx);
        });

        let mut field = div()
            .id(SharedString::from(format!("{id}-field")))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(Label::new(x::X_CATEGORY_LABEL).disabled(select_disabled))
            .child(select);
        if let Some(note) = pick.note {
            let failed = note == X_CATEGORIES_FAILED;
            let mut line = div()
                .flex()
                .flex_wrap()
                .items_baseline()
                .gap(px(4.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(note);
            if failed {
                let studio = self.studio.clone();
                let runtime = self.runtime.clone();
                line = line.child(
                    Button::new(SharedString::from(format!("{id}-retry")))
                        .label(X_CATEGORIES_RETRY)
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .disabled(disabled)
                        .on_click(move |_, _, _| {
                            let studio = studio.clone();
                            runtime.spawn(async move {
                                studio.load_x_live_categories(true).await;
                            });
                        }),
                );
            }
            field = field.child(line);
        }
        field
    }
}
