//! The overlay item's section (`OverlayItemSection`, P589–P595), the
//! selected banner's inspector (`banner-inspector.tsx` `BannerInspector`,
//! P601–P610) and the Banners section under every selection
//! (`SceneBannersSection`, P596–P600). The views are the core's
//! (`inspector_view`'s overlay and banner, `banners_section_view`); the
//! writes are `overlays.layout.set` and the `banners.*` requests.

use gpui::{
    AnyElement, Context, ObjectFit, SharedString, Transformation, div, img, percentage, prelude::*,
    px,
};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use videorc_app_core::assets::LOADING_BANNERS;
use videorc_app_core::editor::inspector::{
    BANNER_SNAPS, InspectorSelection, InspectorView, OVERLAY_SNAPS, banner_order_after_move,
    banner_snap_rect, copy as inspector_copy, overlay_snap_rect, with_overlay_rect,
    with_overlay_switches,
};
use videorc_app_core::editor::stage::{StageRect, overlay_orientation_key};
use videorc_app_core::nav::PageId;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::label::Label;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::Select;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};

use super::controls::Knob;
use super::editor::copy;
use super::inspector::{adjust_icon, meta_line};
use super::{SceneNavigate, ScenePage};

/// A banner row's checkerboard: 4 px squares over the 36 × 20 thumbnail.
const CHECKER_SQUARE: f32 = 4.;
const THUMB_COLUMNS: u32 = 9;
const THUMB_ROWS: u32 = 5;

/// A label over a row of outline buttons (`Field` + `FieldLabel`: 14 px /
/// 500, 12 px over its control).
fn labelled(label: &'static str, body: impl IntoElement) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(Label::new(label))
        .child(body)
}

impl ScenePage {
    /// P589–P595: the overlay item's section.
    // TODO(kit): CaptionsIcon on the Live captions row.
    pub(super) fn overlay_section(
        &self,
        view: &InspectorView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(overlay) = view.overlay.clone() else {
            return div().into_any_element();
        };
        let item = overlay.item;
        let blocked = overlay.blocked.is_some();
        let mut section = PanelSection::new("scene-overlay-item")
            .icon(adjust_icon(t))
            .title(view.title.clone());
        if let Some(line) = overlay.off_line {
            section = section.description(line);
        }
        section = section
            .children(overlay.blocked.map(|reason| {
                Alert::new("scene-overlay-locked")
                    .variant(AlertVariant::Locked)
                    .title(reason)
            }))
            .child(meta_line(overlay.description, t));

        match overlay.captions_summary {
            // P594: the captions bar's outputs live in Captions (#1593).
            Some(summary) => {
                section = section.child(
                    GroupedList::new().row(
                        NavigableRow::new(
                            "scene-overlay-live-captions",
                            inspector_copy::LIVE_CAPTIONS,
                            summary,
                        )
                        .on_navigate(cx.listener(|this, _, _, cx| {
                            this.navigate(SceneNavigate::Page(PageId::Captions), cx)
                        })),
                    ),
                );
            }
            // P592, P593.
            None => {
                for (id, label, key, on) in [
                    (
                        "scene-overlay-stream",
                        copy::SHOW_ON_STREAM,
                        "showOnStream",
                        overlay.show_on_stream,
                    ),
                    (
                        "scene-overlay-recording",
                        copy::SHOW_IN_RECORDING,
                        "showInRecording",
                        overlay.show_in_recording,
                    ),
                ] {
                    let page = cx.entity().downgrade();
                    section = section.child(
                        SettingsRow::new(id, label).flush(true).child(
                            Switch::new(SharedString::from(format!("{id}-switch")))
                                .accessibility_label(label)
                                .checked(on)
                                .disabled(blocked)
                                .on_change(move |on, _, cx| {
                                    let _ = page.update(cx, |page, cx| {
                                        page.set_overlay_switch(item, key, on, cx)
                                    });
                                }),
                        ),
                    );
                }
            }
        }

        // P595: the item's default size at a place.
        let mut snaps = div()
            .id("scene-overlay-snaps")
            .role(gpui::Role::Group)
            .aria_label(copy::SNAP_OVERLAY)
            .flex()
            .flex_wrap()
            .gap(px(8.));
        for (snap, words) in OVERLAY_SNAPS {
            snaps = snaps.child(
                Button::new(SharedString::from(format!("scene-overlay-snap-{snap}")))
                    .label(words)
                    .variant(ButtonVariant::Outline)
                    .disabled(blocked)
                    .on_click(cx.listener(move |this, _, _, cx| this.snap_overlay(item, snap, cx))),
            );
        }
        section
            .child(labelled(overlay.snap_label, snaps))
            .into_any_element()
    }

    /// P601–P610: the selected banner.
    pub(super) fn banner_inspector(
        &self,
        view: &InspectorView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(banner) = view.banner.clone() else {
            return div().into_any_element();
        };
        let blocked = banner.blocked.is_some();
        let shown = banner.shown;
        let mut toggle = Button::new("scene-banner-show-toggle")
            .label(if shown { copy::HIDE } else { copy::SHOW })
            .variant(ButtonVariant::Outline)
            .disabled(!banner.show_enabled)
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_selected_banner(shown, cx)));
        if let Some(reason) = banner.show_reason {
            toggle = toggle.tooltip(reason);
        }
        let mut section = PanelSection::new("scene-banner-inspector")
            .title(banner.name.clone())
            .icon(icon(IconName::ImageSquare, 16., hsla(t.muted_foreground)))
            .description(banner.state_line)
            .action(toggle)
            .children(banner.blocked.map(|reason| {
                Alert::new("scene-banner-locked")
                    .variant(AlertVariant::Locked)
                    .title(reason)
            }));

        // P602: Place keeps the image's size and moves it.
        let mut places = div()
            .id("scene-banner-places")
            .role(gpui::Role::Group)
            .aria_label(copy::PLACE_BANNER)
            .flex()
            .flex_wrap()
            .gap(px(8.));
        for (place, words) in BANNER_SNAPS {
            places = places.child(
                Button::new(SharedString::from(format!("scene-banner-place-{place}")))
                    .label(words)
                    .variant(ButtonVariant::Outline)
                    .disabled(blocked)
                    .on_click(cx.listener(move |this, _, _, cx| this.place_banner(place, cx))),
            );
        }
        section = section.child(labelled(banner.place_label, places));

        // P603: where it is drawn largest, and whether the image is that big.
        let advice = &banner.advice;
        section = section.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .type_scale(text::META)
                .child(
                    div()
                        .text_color(hsla(t.muted_foreground))
                        .child(advice.size_line.clone()),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(hsla(t.foreground))
                        .when(!advice.sharp, |line| {
                            line.child(icon(IconName::Warning, 14., hsla(t.warning)))
                        })
                        .child(advice.verdict_line.clone()),
                ),
        );
        // P604 (an HTML banner's page status) waits for the app to read the
        // HTML overlays' statuses.

        // P605: Opacity, one update on release.
        section = section.child(self.knob_row(Knob::Opacity, copy::OPACITY, blocked, None, t, cx));

        // P606: Appears in, the switch before its words.
        let mut appears = div().flex().flex_wrap().gap_x(px(24.)).gap_y(px(8.));
        for (id, label, key, on) in [
            (
                "scene-banner-stream",
                copy::STREAM,
                "showOnStream",
                banner.on_stream,
            ),
            (
                "scene-banner-recording",
                copy::RECORDING,
                "showInRecording",
                banner.in_recording,
            ),
        ] {
            let page = cx.entity().downgrade();
            let banner_id = banner.id.clone();
            appears = appears.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        Switch::new(SharedString::from(id))
                            .accessibility_label(label)
                            .checked(on)
                            .disabled(blocked)
                            .on_change(move |on, _, cx| {
                                let id = banner_id.clone();
                                let _ = page.update(cx, |page, cx| {
                                    let mut patch = Map::new();
                                    patch.insert(key.into(), json!(on));
                                    page.patch_banner(id, patch, cx);
                                });
                            }),
                    )
                    .child(Label::new(label)),
            );
        }
        section = section.child(labelled(copy::APPEARS_IN, appears));

        // P607: Order, as the Images list draws them (later is on top).
        let mut front = Button::new("scene-banner-front")
            .label(copy::BRING_TO_FRONT)
            .variant(ButtonVariant::Outline)
            .disabled(banner.in_front || blocked)
            .on_click(cx.listener(|this, _, _, cx| this.move_selected_banner(true, cx)));
        if banner.in_front {
            front = front.tooltip(inspector_copy::BANNER_IN_FRONT_REASON);
        }
        let mut back = Button::new("scene-banner-back")
            .label(copy::SEND_TO_BACK)
            .variant(ButtonVariant::Outline)
            .disabled(banner.at_back || blocked)
            .on_click(cx.listener(|this, _, _, cx| this.move_selected_banner(false, cx)));
        if banner.at_back {
            back = back.tooltip(inspector_copy::BANNER_AT_BACK_REASON);
        }
        section = section.child(labelled(
            copy::ORDER,
            div()
                .id("scene-banner-order")
                .role(gpui::Role::Group)
                .aria_label(copy::BANNER_ORDER)
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .child(front)
                .child(back),
        ));

        // P608, P609: Timing, closed until opened for this banner.
        // TODO(kit): Collapsible; the trigger turns CaretDown by hand.
        let open = self.controls.timing_open_for.as_deref() == Some(banner.id.as_str());
        let trigger_id = banner.id.clone();
        let mut caret = icon(IconName::CaretDown, 14., hsla(t.muted_foreground));
        if open {
            caret = caret.with_transformation(Transformation::rotate(percentage(0.5)));
        }
        let mut timing = div().flex().flex_col().gap(px(8.)).child(
            div()
                .id("scene-banner-timing")
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(div().flex_none().child(Label::new(copy::TIMING)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(banner.timing_summary.clone().unwrap_or_default()),
                )
                .child(caret)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let opened =
                        this.controls.timing_open_for.as_deref() == Some(trigger_id.as_str());
                    this.controls.timing_open_for = (!opened).then(|| trigger_id.clone());
                    cx.notify();
                })),
        );
        if open {
            let mut hide_after = Select::new("scene-banner-hide-after")
                .accessibility_label(copy::HIDE_AFTER)
                .width(112.)
                .disabled(blocked)
                .value(
                    banner
                        .hide_after
                        .get(banner.hide_after_index)
                        .map(|choice| SharedString::from(choice.value.to_string())),
                );
            for choice in &banner.hide_after {
                hide_after = hide_after.option(choice.value.to_string(), choice.label.clone());
            }
            let mut repeat = Select::new("scene-banner-repeat")
                .accessibility_label(copy::SHOW_EVERY)
                .width(112.)
                .disabled(blocked)
                .value(
                    banner
                        .repeat
                        .get(banner.repeat_index)
                        .map(|choice| SharedString::from(choice.value.to_string())),
                );
            for choice in &banner.repeat {
                repeat = repeat.option(choice.value.to_string(), choice.label.clone());
            }
            let hide_page = cx.entity().downgrade();
            let hide_id = banner.id.clone();
            let repeat_page = cx.entity().downgrade();
            let repeat_id = banner.id.clone();
            timing = timing
                .child(
                    SettingsRow::new("scene-banner-hide-after-row", copy::HIDE_AFTER)
                        .flush(true)
                        .child(hide_after.on_change(move |value, _, cx| {
                            let id = hide_id.clone();
                            let _ = hide_page.update(cx, |page, cx| {
                                page.set_banner_number(id, "hideAfterSec", &value, cx)
                            });
                        })),
                )
                .child(
                    SettingsRow::new("scene-banner-repeat-row", copy::SHOW_EVERY)
                        .flush(true)
                        .description(inspector_copy::BANNER_REPEAT_DESCRIPTION)
                        .child(repeat.on_change(move |value, _, cx| {
                            let id = repeat_id.clone();
                            let _ = repeat_page.update(cx, |page, cx| {
                                page.set_banner_number(id, "repeatEveryMin", &value, cx)
                            });
                        })),
                );
        }
        section = section.child(timing);

        // P610.
        section
            .child(
                div().flex().justify_end().child(
                    Button::new("scene-banner-manage")
                        .label(inspector_copy::MANAGE_IN_IMAGES)
                        .variant(ButtonVariant::Ghost)
                        .child(icon(IconName::ArrowRight, 16., hsla(t.foreground)))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.navigate(SceneNavigate::Page(PageId::Assets), cx)
                        })),
                ),
            )
            .into_any_element()
    }

    /// P596–P600: every banner, below the selection's own sections; each
    /// row's picture is its thumbnail (`BannerThumbnail`, `aspect-video
    /// h-5`).
    pub(super) fn banners_section(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let view = self.editor.banners.clone();
        let mut section = PanelSection::new("scene-banners")
            .title(copy::BANNERS_TITLE)
            .icon(icon(IconName::ImageSquare, 16., hsla(t.muted_foreground)))
            .description(copy::BANNERS_DESCRIPTION);
        if view.offline && view.offline_alert {
            section = section.child(
                Alert::new("scene-banners-offline")
                    .variant(AlertVariant::Locked)
                    .title(inspector_copy::OFFLINE_LOCK_REASON),
            );
        }
        if !view.loaded {
            if !view.offline {
                section = section.child(meta_line(LOADING_BANNERS, t));
            }
            return section.into_any_element();
        }
        if view.rows.is_empty() {
            return section
                .child(
                    Empty::new().description(copy::NO_BANNERS).child(
                        Button::new("scene-banners-open-images")
                            .label(inspector_copy::OPEN_IMAGES)
                            .variant(ButtonVariant::Outline)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.navigate(SceneNavigate::Page(PageId::Assets), cx)
                            })),
                    ),
                )
                .into_any_element();
        }
        let mut list = GroupedList::new();
        for row in &view.rows {
            let select_id = row.id.clone();
            let toggle_id = row.id.clone();
            let shown = row.shown;
            let mut toggle = Button::new(SharedString::from(format!(
                "scene-banner-row-toggle-{}",
                row.id
            )))
            .label(if shown { copy::HIDE } else { copy::SHOW })
            .accessibility_label(copy::show_hide_name(shown, &row.name))
            .size(ButtonSize::Xs)
            .variant(ButtonVariant::Outline)
            .disabled(view.offline || row.show_reason.is_some())
            .on_click(cx.listener(move |this, _, _, cx| {
                // The row under it selects; this button only shows or hides.
                cx.stop_propagation();
                this.show_banner(toggle_id.clone(), !shown, cx);
            }));
            if let Some(reason) = row.show_reason {
                toggle = toggle.tooltip(reason);
            }
            let mut entry = ListRow::new(
                SharedString::from(format!("scene-banner-row-{}", row.id)),
                row.name.clone(),
            )
            .interactive(true)
            .selected(row.selected)
            .icon(self.banner_thumbnail(&row.id, t))
            .on_click(cx.listener(move |this, _, _, cx| this.select_banner(select_id.clone(), cx)));
            if let Some(timing) = row.timing.clone() {
                entry = entry.alias(Badge::new(timing).variant(BadgeVariant::Outline));
            }
            if shown {
                entry = entry.child(Badge::new(copy::SHOWING));
            }
            list = list.row(entry.child(toggle));
        }
        section.child(list).into_any_element()
    }

    /// A banner's thumbnail, 16:9 at 20 px high; its glyph until the file
    /// is known.
    fn banner_thumbnail(&self, id: &str, t: &Theme) -> AnyElement {
        let path = self
            .editor_state
            .banners
            .iter()
            .find(|banner| banner.id == id)
            .and_then(|banner| {
                super::stage::banner_file(&self.user_data_dir, &banner.thumbnail_file)
            });
        // `CHECKERBOARD` at the row's `bg-size-[8px_8px]`: 4 px squares of
        // the foreground at 9 %, so a banner's transparency shows the same
        // way in both themes.
        let square = hsla(with_alpha(t.foreground, 0.09));
        let checker = (0..THUMB_ROWS).flat_map(move |row| {
            (0..THUMB_COLUMNS)
                .filter(move |column| (row + column) % 2 == 1)
                .map(move |column| {
                    div()
                        .absolute()
                        .left(px(column as f32 * CHECKER_SQUARE))
                        .top(px(row as f32 * CHECKER_SQUARE))
                        .size(px(CHECKER_SQUARE))
                        .bg(square)
                })
        });
        let frame = div()
            .relative()
            .h(px(20.))
            .w(px(36.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .rounded(px(radius::CHIP))
            .bg(hsla(with_alpha(t.foreground, 0.04)))
            .children(checker);
        match path {
            Some(path) => frame
                .child(
                    div()
                        .size_full()
                        .p(px(2.))
                        .child(img(path).size_full().object_fit(ObjectFit::Contain)),
                )
                .into_any_element(),
            None => frame
                .child(icon(IconName::ImageSquare, 14., hsla(t.muted_foreground)))
                .into_any_element(),
        }
    }

    // ── Actions ───────────────────────────────────────────────────────

    fn select_banner(&mut self, id: String, cx: &mut Context<Self>) {
        self.editor_state.selection = Some(InspectorSelection::Banner(id));
        self.refresh_editor(cx);
    }

    /// `overlays.layout.set` with the whole layout; the saved one comes
    /// back and replaces the page's.
    fn write_overlay_layout(&mut self, next: Value, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let _ = done.send(studio.set_overlay_layout(next).await);
        });
        cx.spawn(async move |this, cx| {
            let Ok(Some(saved)) = answer.await else {
                return;
            };
            let _ = this.update(cx, |page, cx| {
                page.editor_state.overlay_layout = Some(saved);
                page.refresh_editor(cx);
            });
        })
        .detach();
    }

    /// P592, P593 (`withOverlaySwitches` on the saved layout).
    fn set_overlay_switch(&mut self, item: &str, key: &str, on: bool, cx: &mut Context<Self>) {
        let Some(layout) = &self.editor_state.overlay_layout else {
            return;
        };
        let next = with_overlay_switches(layout, item, key, on);
        self.write_overlay_layout(next, cx);
    }

    /// P595 (`withOverlayRect(..., overlaySnapRect(...))`).
    fn snap_overlay(&mut self, item: &str, snap: &str, cx: &mut Context<Self>) {
        let Some(layout) = &self.editor_state.overlay_layout else {
            return;
        };
        let vertical = self.editor.vertical_overlays;
        let next = with_overlay_rect(
            layout,
            item,
            vertical,
            overlay_snap_rect(item, vertical, snap),
        );
        self.write_overlay_layout(next, cx);
    }

    /// A banner request, then the list again (the answer is the truth).
    fn banner_request(
        &mut self,
        cx: &mut Context<Self>,
        job: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        let (done, answer) = oneshot::channel();
        self.run(async move {
            job.await;
            let _ = done.send(());
        });
        cx.spawn(async move |this, cx| {
            let _ = answer.await;
            let _ = this.update(cx, |page, cx| page.load_lists(cx));
        })
        .detach();
    }

    /// `updateBanner(patch)`.
    pub(super) fn patch_banner(
        &mut self,
        id: String,
        patch: Map<String, Value>,
        cx: &mut Context<Self>,
    ) {
        let studio = self.studio.clone();
        self.banner_request(cx, async move {
            studio.patch_banner(&id, patch).await;
        });
    }

    /// A timer's Select (`hideAfterSec`, `repeatEveryMin`; 0 is Off).
    fn set_banner_number(&mut self, id: String, key: &str, value: &str, cx: &mut Context<Self>) {
        let Ok(number) = value.parse::<u32>() else {
            return;
        };
        let mut patch = Map::new();
        patch.insert(key.into(), json!(number));
        self.patch_banner(id, patch, cx);
    }

    /// `showBanner` / `hideBanner`.
    fn show_banner(&mut self, id: String, show: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.banner_request(cx, async move {
            if show {
                studio.show_banner(&id).await;
            } else {
                studio.hide_banner(&id).await;
            }
        });
    }

    fn toggle_selected_banner(&mut self, shown: bool, cx: &mut Context<Self>) {
        if let Some(banner) = &self.editor.inspector.banner {
            let id = banner.id.clone();
            self.show_banner(id, !shown, cx);
        }
    }

    /// P602 (`bannerSnapRect`): the image's own size at the place, or the
    /// whole canvas, on this orientation.
    fn place_banner(&mut self, place: &str, cx: &mut Context<Self>) {
        let Some(id) = self
            .editor
            .inspector
            .banner
            .as_ref()
            .map(|banner| banner.id.clone())
        else {
            return;
        };
        let Some(banner) = self
            .editor_state
            .banners
            .iter()
            .find(|banner| banner.id == id)
            .cloned()
        else {
            return;
        };
        let vertical = self.editor.vertical_overlays;
        let rect = banner_snap_rect(&banner, vertical, self.editor.canvas_aspect, place);
        let studio = self.studio.clone();
        self.banner_request(cx, async move {
            studio
                .update_banner(
                    &id,
                    overlay_orientation_key(vertical),
                    StageRect::new(rect.x, rect.y, rect.w, rect.h),
                )
                .await;
        });
    }

    /// P607 (`bannerOrderAfterMove`): to the end (front) or the start.
    fn move_selected_banner(&mut self, to_front: bool, cx: &mut Context<Self>) {
        let Some(id) = self
            .editor
            .inspector
            .banner
            .as_ref()
            .map(|banner| banner.id.clone())
        else {
            return;
        };
        let banners = &self.editor_state.banners;
        let target = if to_front {
            banners.len().saturating_sub(1)
        } else {
            0
        };
        let Some(ids) = banner_order_after_move(banners, &id, target) else {
            return;
        };
        let studio = self.studio.clone();
        self.banner_request(cx, async move {
            studio.reorder_banners(ids).await;
        });
    }
}
