//! The Canvas section (`layout-tab.tsx` 977-1134; P512–P514): its title and
//! line, "Overlays on" while a vertical stream is armed, and the stage's
//! "Scene sources" toolbar, which is the inspector's selection. The stage
//! itself (the drawing, the gestures, the footer) is batch B; its slot is
//! left empty here.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::editor::inspector::InspectorSelection;
use videorc_app_core::editor::stage::{banner_id_from_stage_id, overlay_item_from_stage_id};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::toggle_group::{ToggleGroup, ToggleItem};
use videorc_kit::tokens::text;

use super::ScenePage;
use super::editor::{ChipKind, copy};

const HORIZONTAL: &str = "horizontal";
const VERTICAL: &str = "vertical";

impl ScenePage {
    pub(super) fn canvas_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let page = cx.entity().downgrade();
        let editor = &self.editor;

        let mut section = PanelSection::new("scene-canvas")
            .title(copy::CANVAS_TITLE)
            .description(editor.canvas_description.clone());

        // P513: which stream's overlays the canvas places.
        if let Some(vertical) = editor.overlays_on {
            let orientation_page = page.clone();
            section = section.child(
                div()
                    .id("scene-overlays-on")
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .type_scale(text::LABEL)
                            .text_color(hsla(t.foreground))
                            .child(copy::OVERLAYS_ON),
                    )
                    .child(
                        SegmentedControl::new("scene-overlay-orientation")
                            .accessibility_label(copy::OVERLAYS_ON)
                            .small(true)
                            .option(Segment::new(HORIZONTAL, copy::HORIZONTAL))
                            .option(Segment::new(VERTICAL, copy::VERTICAL))
                            .value(Some(if vertical { VERTICAL } else { HORIZONTAL }))
                            .on_change(move |value, _, cx| {
                                let vertical = value.as_ref() == VERTICAL;
                                let _ = orientation_page.update(cx, |page, cx| {
                                    page.editor_state.overlays_vertical = vertical;
                                    page.refresh_editor(cx);
                                });
                            }),
                    ),
            );
        }

        // P514, P515: the sources, the overlay items and the banners on
        // the stage; a chip's badge in secondary text after its name.
        // TODO(kit): VideoCamera (the camera), ChatCircle (Highlight, Chat),
        // ClosedCaptioning (Captions) and the Avatar's own mark; until then
        // those chips carry no icon.
        let mut toolbar = ToggleGroup::new("scene-sources")
            .accessibility_label(copy::SCENE_SOURCES)
            .disabled(!editor.chips_enabled)
            .value(editor.selected_stage_id.clone());
        for chip in &editor.chips {
            let mark = match chip.kind {
                ChipKind::Source => Some(IconName::Monitor),
                ChipKind::Banner => Some(IconName::ImageSquare),
                ChipKind::Camera | ChipKind::Overlay => None,
            };
            let body = div()
                .flex()
                .items_center()
                .gap(px(4.))
                .max_w(px(176.))
                .children(mark.map(|mark| icon(mark, 14., muted)))
                .child(div().truncate().child(chip.label.clone()))
                .children(chip.badge.map(|badge| {
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(badge.label())
                }));
            toolbar = toolbar.item(ToggleItem::new(chip.stage_id.clone(), chip.name()).child(body));
        }
        let select_page = page;
        toolbar = toolbar.on_change(move |values, _, cx| {
            // A chip can't be un-pressed (`ToggleGroup` ignores an empty value).
            let Some(stage_id) = values.into_iter().next() else {
                return;
            };
            let _ = select_page.update(cx, |page, cx| page.select_stage(&stage_id, cx));
        });
        section = section.child(div().id("scene-stage-toolbar").child(toolbar));

        // Batch B: the stage (`SceneStage`: the canvas, its handles, the
        // footer's hints and buttons) goes in this slot. Nothing is drawn
        // here until it does.
        section = section.child(div().id("scene-stage-slot"));
        section.into_any_element()
    }

    /// A toolbar chip (`onSelectSource` / `overlays.onSelect`): a source
    /// opens the scene editor (`sceneEditMode`), an overlay item or a banner
    /// takes the selection alone.
    fn select_stage(&mut self, stage_id: &SharedString, cx: &mut Context<Self>) {
        let selection = if let Some(id) = banner_id_from_stage_id(stage_id) {
            InspectorSelection::Banner(id.to_string())
        } else if let Some(item) = overlay_item_from_stage_id(stage_id) {
            InspectorSelection::Overlay(item)
        } else {
            self.studio.set_scene_edit_mode(true);
            InspectorSelection::Source(stage_id.to_string())
        };
        self.editor_state.selection = Some(selection);
        self.refresh_editor(cx);
    }
}
