//! The inspector column (`layout-tab.tsx` 1150-1442; P543–P555): the
//! selection's own sections, then the Banners section, always last. The
//! view is the core's `inspector_view`; the camera's sections are in
//! `camera.rs`, the overlay item's and the banners' in `banners.rs`.

use gpui::{AnyElement, ClickEvent, Context, Window, div, prelude::*, px};
use videorc_app_core::desktop::accelerator::accelerator_display_keys;
use videorc_app_core::editor::inspector::{
    CROP_FIELDS, InspectorKind, InspectorView, TRANSFORM_FIELDS, TransformFieldsView,
    copy as inspector_copy,
};
use videorc_app_core::editor::stage::StageCrop;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::{Kbd, kbd_group};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, faded_over, hsla};
use videorc_kit::tokens::{Theme, text};
use videorc_kit::tooltip::tooltip;

use super::ScenePage;
use super::controls::{Field, Knob};
use super::editor::copy;

/// A line in secondary text under a control.
pub(super) fn meta_line(line: impl IntoElement, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line)
}

/// The inspector titles' icon (`AdjustIcon`, 16 px, muted).
pub(super) fn adjust_icon(t: &Theme) -> gpui::Svg {
    icon(IconName::SlidersHorizontal, 16., hsla(t.muted_foreground))
}

/// The nudge arrow for a step (`ArrowUpIcon` and the rest).
fn nudge_icon(dx: i8, dy: i8) -> IconName {
    match (dx, dy) {
        (0, -1) => IconName::ArrowUp,
        (0, 1) => IconName::ArrowDown,
        (-1, 0) => IconName::ArrowLeft,
        _ => IconName::ArrowRight,
    }
}

impl ScenePage {
    /// The column: the selection's sections, then Banners.
    pub(super) fn inspector_column(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let view = self.editor.inspector.clone();
        let mut column = div().id("scene-inspector").flex().flex_col().min_w_0();
        match view.kind {
            // P543: nothing selected (an empty scene).
            InspectorKind::Empty => {
                column = column.child(
                    PanelSection::new("scene-inspector-empty")
                        .icon(adjust_icon(t))
                        .title(view.title.clone())
                        .description(view.description.clone().unwrap_or_default()),
                );
            }
            InspectorKind::FullCanvas | InspectorKind::Source => {
                column = column.child(self.source_section(&view, t, cx));
                if view.kind == InspectorKind::Source {
                    column = column.child(self.placement_section(&view, t, cx));
                }
            }
            InspectorKind::Camera => {
                column = column.children(self.camera_sections(&view, window, cx));
            }
            InspectorKind::Overlay => {
                column = column.child(self.overlay_section(&view, t, cx));
            }
            InspectorKind::Banner => {
                column = column.child(self.banner_inspector(&view, t, cx));
            }
        }
        column.child(self.banners_section(t, cx)).into_any_element()
    }

    /// P544: "Visible in scene", locked while a session runs.
    pub(super) fn visibility_row(
        &self,
        view: &InspectorView,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (on, enabled, reason) = view.visibility?;
        let id = view.source_id.clone()?;
        let page = cx.entity().downgrade();
        let row = SettingsRow::new("scene-source-visible", copy::VISIBLE_IN_SCENE)
            .flush(true)
            .child(
                Switch::new("scene-source-visible-switch")
                    .accessibility_label(copy::VISIBLE_IN_SCENE)
                    .checked(on)
                    .disabled(!enabled)
                    .on_change(move |visible, _, cx| {
                        let id = id.clone();
                        let _ = page.update(cx, |page, _| {
                            let studio = page.studio.clone();
                            page.run(async move {
                                studio.set_source_visible(&id, visible).await;
                            });
                        });
                    }),
            );
        Some(match reason {
            Some(reason) => div()
                .id("scene-source-visible-reason")
                .tooltip(tooltip(reason))
                .child(row)
                .into_any_element(),
            None => row.into_any_element(),
        })
    }

    /// P546: Screen size, where the screen is (the background's Visibility).
    fn screen_size_row(
        &self,
        view: &InspectorView,
        t: &Theme,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        let (_, reason) = view.screen_size?;
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(self.knob_row(
                    Knob::ScreenSize,
                    copy::SCREEN_SIZE,
                    reason.is_some(),
                    reason,
                    cx,
                ))
                .child(meta_line(inspector_copy::SCREEN_SIZE_HINT, t))
                .into_any_element(),
        )
    }

    /// The source's name section: Visible in scene and Screen size (P545
    /// compact for a full-canvas source in a preset).
    fn source_section(
        &self,
        view: &InspectorView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut section = PanelSection::new("scene-source-section")
            .icon(adjust_icon(t))
            .title(view.title.clone());
        if let Some(description) = &view.description {
            section = section.description(description.clone());
        }
        section
            .children(self.visibility_row(view, cx))
            .children(self.screen_size_row(view, t, cx))
            .into_any_element()
    }

    /// P547–P555: a source's Placement.
    fn placement_section(
        &self,
        view: &InspectorView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(placement) = view.placement.clone() else {
            return div().into_any_element();
        };
        let mut section = PanelSection::new("scene-placement")
            .title(copy::PLACEMENT)
            .heading_level(3);
        if let Some(description) = placement.description.clone() {
            section = section.description(description);
        }
        if let Some(enabled) = placement.reset {
            section = section.action(
                Button::new("scene-placement-reset")
                    .label(copy::RESET)
                    .variant(ButtonVariant::Outline)
                    .disabled(!enabled)
                    .on_click(cx.listener(|this, _, _, _| this.reset_selected_source())),
            );
        }
        if let Some(fields) = &placement.fields {
            section = section.child(self.transform_fields(fields, t, cx));
        }
        if let Some((_, enabled)) = placement.zoom {
            let reason = placement
                .fields
                .as_ref()
                .and_then(|fields| fields.disabled_line);
            section = section.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(self.knob_row(Knob::ScreenZoom, copy::ZOOM, !enabled, reason, cx))
                    .child(meta_line(inspector_copy::SCREEN_ZOOM_HINT, t)),
            );
        }
        if let Some(crop) = &placement.crop {
            section = section.child(self.crop_fields(crop.enabled, crop.cropped, t, cx));
        }
        if let Some(enabled) = placement.nudge {
            section = section.child(self.nudge_pad(enabled, t, cx));
        }
        section.into_any_element()
    }

    /// P549–P551: Position and size, its aspect lock and the pixels.
    pub(super) fn transform_fields(
        &self,
        fields: &TransformFieldsView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locked = fields.aspect_locked;
        let ink = if fields.lock_enabled {
            t.foreground
        } else {
            faded_over(t.foreground, t.glass_solid, 0.5)
        };
        let lock = Button::new("scene-aspect-lock")
            .size(ButtonSize::IconXs)
            .variant(if locked {
                ButtonVariant::Secondary
            } else {
                ButtonVariant::Ghost
            })
            .accessibility_label(if locked {
                inspector_copy::UNLOCK_ASPECT
            } else {
                inspector_copy::LOCK_ASPECT
            })
            .tooltip(fields.lock_tip.clone())
            .disabled(!fields.lock_enabled)
            .child(icon(
                if locked {
                    IconName::LockFill
                } else {
                    IconName::LockKey
                },
                12.,
                hsla(ink),
            ))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_aspect_lock(cx)));
        let mut grid = div().flex().flex_wrap().gap(px(8.));
        for (index, (_, label)) in TRANSFORM_FIELDS.into_iter().enumerate() {
            grid = grid.child(self.percent_field(
                Field::Transform(index),
                label,
                copy::transform_field_name(label),
                fields.enabled,
                t,
            ));
        }
        div()
            .id("scene-transform-fields")
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(SectionLabel::new(copy::POSITION_AND_SIZE))
                    .child(lock),
            )
            .child(grid)
            .child(meta_line(fields.pixel_line.clone(), t))
            .children(fields.forced_line.map(|line| meta_line(line, t)))
            .children(fields.disabled_line.map(|line| meta_line(line, t)))
            .into_any_element()
    }

    /// P553, P554: a Freeform screen's crop.
    fn crop_fields(
        &self,
        enabled: bool,
        cropped: bool,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut grid = div().flex().flex_wrap().gap(px(8.));
        for (index, (_, label)) in CROP_FIELDS.into_iter().enumerate() {
            grid = grid.child(self.percent_field(
                Field::Crop(index),
                label,
                copy::crop_field_name(label),
                enabled,
                t,
            ));
        }
        let alt = accelerator_display_keys(Some("Alt"), self.model.platform);
        div()
            .id("scene-crop-fields")
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(SectionLabel::new(copy::CROP))
            .child(grid)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(copy::CROP_HELP_LEAD)
                    .child(kbd_group(alt.into_iter().map(Kbd::new)))
                    .child(copy::CROP_HELP_TAIL),
            )
            .child(
                Button::new("scene-crop-reset")
                    .icon(IconName::ArrowCounterClockwise)
                    .label(copy::RESET_CROP)
                    .size(ButtonSize::Xs)
                    .variant(ButtonVariant::Ghost)
                    .disabled(!enabled)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !cropped {
                            return;
                        }
                        if let Some(edit) = this.editor.edit.clone() {
                            this.commit_crop_to(&edit, StageCrop::default(), "", cx);
                        }
                    })),
            )
            .into_any_element()
    }

    /// P555: the d-pad (Shift takes the bigger step).
    fn nudge_pad(&self, enabled: bool, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let ink = if enabled {
            t.foreground
        } else {
            faded_over(t.foreground, t.glass_solid, 0.5)
        };
        let arrow = |id: &'static str, name: &'static str, dx: i8, dy: i8| {
            Button::new(id)
                .size(ButtonSize::Icon)
                .variant(ButtonVariant::Outline)
                .accessibility_label(name)
                .disabled(!enabled)
                .child(icon(nudge_icon(dx, dy), 16., hsla(ink)))
                .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                    this.nudge(dx, dy, event.modifiers().shift, cx)
                }))
        };
        let up = arrow("scene-nudge-up", copy::NUDGE_UP, 0, -1);
        let left = arrow("scene-nudge-left", copy::NUDGE_LEFT, -1, 0);
        let down = arrow("scene-nudge-down", copy::NUDGE_DOWN, 0, 1);
        let right = arrow("scene-nudge-right", copy::NUDGE_RIGHT, 1, 0);
        div()
            .id("scene-nudge")
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .w_full()
            .max_w(px(100.))
            .child(up)
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(left)
                    .child(down)
                    .child(right),
            )
            .into_any_element()
    }

    fn reset_selected_source(&self) {
        let Some(id) = self.editor.inspector.source_id.clone() else {
            return;
        };
        let studio = self.studio.clone();
        self.run(async move {
            studio.reset_source(&id).await;
        });
    }

    fn toggle_aspect_lock(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.editor.inspector.source_id.clone() else {
            return;
        };
        let choice = self
            .editor_state
            .aspect_locks
            .get(&id)
            .copied()
            .unwrap_or(true);
        self.editor_state.aspect_locks.insert(id, !choice);
        self.refresh_editor(cx);
    }

    fn nudge(&mut self, dx: i8, dy: i8, large: bool, cx: &mut Context<Self>) {
        let Some(id) = self.editor.inspector.source_id.clone() else {
            return;
        };
        let studio = self.studio.clone();
        self.precise(cx, async move {
            studio.nudge_source(&id, dx, dy, large).await;
        });
    }
}
