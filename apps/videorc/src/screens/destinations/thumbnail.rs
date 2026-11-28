//! Stream details thumbnail field (`ThumbnailField`, P758–P763).

use gpui::{AnyElement, Context, PathPromptOptions, Window, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::details::{self, ThumbnailField};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn thumbnail_row(
        &self,
        asset_id: Option<&str>,
        youtube_signed_in: bool,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let view = self.thumbnail_field.view(asset_id, true);
        let hint = details::thumbnail_hint(youtube_signed_in);
        let entity = cx.entity();

        let mut body = div().flex().flex_col().gap(px(6.));
        if view.preview {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(format!("Thumbnail set ({})", asset_id.unwrap_or(""))),
            );
        }
        if view.missing {
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(icon(IconName::ImageBroken, 16., hsla(t.muted_foreground)))
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(page_copy::THUMBNAIL_MISSING),
                    ),
            );
        }
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .child(
                    Button::new("thumbnail-choose")
                        .label(view.choose_label)
                        .variant(ButtonVariant::Outline)
                        .disabled(disabled)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |this, cx| this.choose_thumbnail(window, cx));
                            }
                        }),
                )
                .when(view.remove, |row| {
                    row.child(
                        Button::new("thumbnail-remove")
                            .label(page_copy::REMOVE_THUMBNAIL)
                            .variant(ButtonVariant::Outline)
                            .disabled(disabled)
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.remove_thumbnail();
                                        cx.notify();
                                    });
                                }
                            }),
                    )
                }),
        );
        if let Some(error) = &view.error {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(error.clone()),
            );
        }
        if view.not_sixteen_nine {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(page_copy::NOT_SIXTEEN_NINE),
            );
        }
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(hint),
        );

        SettingsRow::new("stream-thumbnail", page_copy::THUMBNAIL)
            .child(body)
            .into_any_element()
    }

    fn choose_thumbnail(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.thumbnail_field.choose_started();
        cx.notify();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(page_copy::CHOOSE_THUMBNAIL.into()),
        });
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let paths = picked.await;
            let Ok(Ok(Some(paths))) = paths else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let path_str = path.to_string_lossy().to_string();
            let id = studio.import_scheduled_thumbnail(&path_str).await;
            let _ = this.update(cx, |this, cx| {
                match id {
                    Some(id) => {
                        this.thumbnail_field.picked();
                        this.studio.patch_metadata_draft(|draft| {
                            draft.thumbnail_asset_id = Some(id);
                        });
                        this.details_dirty = true;
                    }
                    None => {
                        this.thumbnail_field
                            .import_failed("Couldn't import that image.");
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn remove_thumbnail(&mut self) {
        self.thumbnail_field.removed();
        self.studio.patch_metadata_draft(|draft| {
            draft.thumbnail_asset_id = None;
        });
        self.details_dirty = true;
    }
}

/// Re-export so DestinationsPanel can hold the field.
pub(super) type Field = ThumbnailField;
