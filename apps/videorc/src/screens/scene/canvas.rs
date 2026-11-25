//! The Canvas section (`layout-tab.tsx` 977-1134; P512–P542): its title and
//! line, "Overlays on" while a vertical stream is armed, and the stage card:
//! the "Scene sources" toolbar (the inspector's selection), the canvas with
//! its 28 px handle gutter, the empty and layout-only lines, and the footer
//! (the live hint or the key hints; Undo, Make freeform, Snap, Pop out /
//! Show preview here). On macOS the canvas is the preview's other docked
//! slot (X5): GPUI composites the native view beneath the page and the
//! stage layer paints its chrome over the video. Also here: Freeform entry
//! (X3), Edit scene (X2) and ⌘Z (P536).

use gpui::{
    AnyElement, Context, Modifiers, ObjectFit, SharedString, Window, div, img, prelude::*, px,
    relative,
};
use serde_json::{Map, Value, json};
use videorc_app_core::StudioSnapshot;
use videorc_app_core::editor::inspector::{InspectorSelection, scene_position_lock_reason};
use videorc_app_core::editor::stage::{
    HANDLE_GUTTER, banner_id_from_stage_id, overlay_item_from_stage_id,
};
use videorc_app_core::editor::stage_copy::{self, LayoutOnlyAction, layout_only_note};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::scene_editor::{
    freeform_entry_overrides, layout_orientation, source_override,
};
use videorc_app_core::studio::transport::transport_active;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::Kbd;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::shortcut_keys::{self, ShortcutKeys};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::toggle_group::{ToggleGroup, ToggleItem};
use videorc_kit::tokens::{radius, text};
use videorc_preview::lifecycle::WindowMode;
use videorc_protocol::SceneSourceKind;

use super::editor::{ChipKind, copy};
use super::model::copy as list_copy;
use super::stage::StagePhase;
use super::{SceneNavigate, ScenePage, UndoLayout};
use crate::screens::avatar::pictures;

/// The stage's own words (`scene-stage.tsx`).
mod words {
    pub const NUDGE: &str = "nudge";
    pub const CANCEL: &str = "cancel";
    pub const UNDO: &str = "Undo";
    pub const MAKE_FREEFORM: &str = "Make freeform";
    pub const SNAP: &str = "Snap";
    pub const POP_OUT: &str = "Pop out";
    pub const SHOW_HERE: &str = "Show preview here";
    pub const OPEN_PREVIEW: &str = "Open Preview";
    pub const CLOSE_PREVIEW: &str = "Close Preview";
    pub const EMPTY: &str = "No sources in the scene yet. Choose a screen or a camera in Sources.";
}

/// The canvas's height left for the page around it (`calc(100vh - 248px)`).
const PAGE_CHROME_PX: f32 = 248.;
/// `CANVAS_RADIUS_PX`, the docked preview's corner.
const CANVAS_RADIUS: f32 = crate::preview::SLOT_RADIUS as f32;

/// A key chip the platform's way (the kit spells the glyphs): a lone
/// modifier, an arrow, Esc.
fn key_chip(modifiers: Modifiers, key: &str) -> Kbd {
    let text = shortcut_keys::label([(modifiers, key)], cfg!(target_os = "macos"));
    Kbd::new(text.trim_end_matches('+').to_string())
}

/// `sceneSwitchPending`: a scene or layout switch is on its way.
fn switch_pending(snapshot: &StudioSnapshot) -> bool {
    snapshot.scenes.pending_scene_id.is_some() || snapshot.scenes.pending_layout.is_some()
}

/// A footer group: the chip(s) and their word.
fn hint(chips: Vec<Kbd>, word: &'static str) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(div().flex().items_center().gap(px(4.)).children(chips))
        .child(word)
}

fn vertical_rule(color: gpui::Hsla) -> gpui::Div {
    div().w(px(1.)).h(px(20.)).bg(color)
}

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
        // the stage; a chip's badge in secondary text after its name. The
        // Avatar's mark is its emblem (`BuddyIcon`).
        let mut toolbar = ToggleGroup::new("scene-sources")
            .accessibility_label(copy::SCENE_SOURCES)
            .disabled(!editor.chips_enabled || self.stage.phase() != StagePhase::Idle)
            .value(editor.selected_stage_id.clone());
        for chip in &editor.chips {
            let glyph = |name| Some(icon(name, 14., muted).into_any_element());
            let mark = match chip.kind {
                ChipKind::Camera => glyph(IconName::VideoCamera),
                ChipKind::Source => glyph(IconName::Monitor),
                ChipKind::Banner => glyph(IconName::ImageSquare),
                ChipKind::Overlay => match overlay_item_from_stage_id(&chip.stage_id) {
                    Some("highlight" | "chat") => glyph(IconName::ChatCircle),
                    Some("captions") => glyph(IconName::ClosedCaptioning),
                    Some("buddy") => Some(
                        img(pictures::emblem())
                            .size(px(14.))
                            .flex_none()
                            .object_fit(ObjectFit::Contain)
                            .into_any_element(),
                    ),
                    _ => None,
                },
            };
            let body = div()
                .flex()
                .items_center()
                .gap(px(4.))
                .max_w(px(176.))
                .children(mark)
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
        let border = hsla(t.border);
        let stage = self.stage_card(toolbar, window, cx);
        section = section.child(
            div()
                .id("scene-stage")
                .flex()
                .flex_col()
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(border)
                .children(stage),
        );
        section.into_any_element()
    }

    /// The stage card under the toolbar: the canvas in its gutter, the
    /// lines under it, the footer.
    fn stage_card(
        &mut self,
        toolbar: ToggleGroup,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let border = hsla(t.border);
        let snapshot = self.studio.snapshot();
        let vertical_view = self.editor.overlays_on == Some(true);
        let (live_canvas, docked, can_float, preview_open, scene_docked) = {
            let preview = self.preview.read(cx);
            (
                preview.live_canvas(),
                preview.mode() == WindowMode::Docked && !preview.is_closed(),
                preview.can_float(),
                !preview.is_closed(),
                preview.scene_hosts_docked(),
            )
        };
        // X5: the live picture under the stage, not in the vertical view
        // (it places the vertical stream's overlays on a blank 9:16).
        let live = live_canvas && !vertical_view;
        let has_sources = !vertical_view
            && snapshot
                .sources
                .scene
                .as_ref()
                .is_some_and(|scene| !scene.sources.is_empty());

        // The canvas box: the output's aspect, as wide as the column allows
        // and no taller than the window leaves (`canvasBoxStyle`); a
        // portrait canvas keeps the 16:9 footprint.
        let aspect = self.editor.canvas_aspect.max(0.01) as f32;
        let share = (aspect / (16. / 9.)).min(1.);
        let tall = (f32::from(window.viewport_size().height) - PAGE_CHROME_PX).max(120.);
        let gutter = HANDLE_GUTTER as f32;
        let mut canvas_box = div()
            .id("scene-canvas-box")
            .relative()
            .w(relative(share))
            .max_w(px(tall * aspect))
            .aspect_ratio(aspect)
            .rounded(px(CANVAS_RADIUS));
        if live {
            canvas_box = canvas_box.child(crate::preview::Preview::docked_slot(&self.preview, cx));
        }
        let layer = self.stage_layer(live, window, cx);
        canvas_box = canvas_box.child(
            div()
                .absolute()
                .top(px(-gutter))
                .left(px(-gutter))
                .right(px(-gutter))
                .bottom(px(-gutter))
                .child(layer),
        );

        let mut lines: Vec<AnyElement> = Vec::new();
        // P529: an empty scene says where sources come from.
        if !has_sources {
            lines.push(
                div()
                    .id("scene-stage-empty")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .px(px(gutter))
                    .pb(px(12.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(words::EMPTY)
                    .child(
                        Button::new("scene-stage-open-sources")
                            .label(list_copy::OPEN_SOURCES)
                            .variant(ButtonVariant::Link)
                            .size(ButtonSize::Xs)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.navigate(SceneNavigate::Page(PageId::Sources), cx)
                            })),
                    )
                    .into_any_element(),
            );
        }
        // P530: where the picture is when the canvas can't show it.
        if has_sources
            && let Some(note) = layout_only_note(scene_docked, vertical_view, preview_open, docked)
        {
            let pops = note.action == LayoutOnlyAction::PopOut;
            lines.push(
                div()
                    .id("scene-stage-layout-only")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .px(px(gutter))
                    .pb(px(12.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(note.text)
                    // Pop out Preview floats a Preview stuck to the Studio
                    // panel; Open Preview opens a closed one where it was,
                    // Show Preview brings its window up
                    // (`showPictureFromLayoutOnly`).
                    .when(can_float, |line| {
                        line.child(
                            Button::new("scene-stage-layout-only-action")
                                .label(note.action_label)
                                .variant(ButtonVariant::Link)
                                .size(ButtonSize::Xs)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.preview.update(cx, |preview, cx| {
                                        if pops {
                                            preview.toggle_floating(cx)
                                        } else {
                                            preview.open_or_show(cx)
                                        }
                                    });
                                })),
                        )
                    })
                    .into_any_element(),
            );
        }

        let footer = self.stage_footer(&snapshot, live_canvas, vertical_view, docked, window, cx);
        let mut card: Vec<AnyElement> = vec![
            div()
                .id("scene-stage-toolbar")
                .p(px(8.))
                .child(toolbar)
                .into_any_element(),
            div().h(px(1.)).bg(border).into_any_element(),
            div()
                .id("scene-stage-gutter")
                .flex()
                .flex_col()
                .items_center()
                .p(px(gutter))
                .child(canvas_box)
                .into_any_element(),
        ];
        card.extend(lines);
        card.push(div().h(px(1.)).bg(border).into_any_element());
        card.push(footer);
        card
    }

    /// The footer (P533–P541): the live hint or the key hints on the
    /// left; Undo, Make freeform, Snap and the preview's place on the right.
    fn stage_footer(
        &mut self,
        snapshot: &StudioSnapshot,
        live_canvas: bool,
        vertical_view: bool,
        docked: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let rule = hsla(t.border);
        let facts = self.stage.facts();
        let phase = self.stage.phase();

        // P533: the vertical view's line (the GPUI canvas is never hidden
        // under a window or scrolled away: GPUI clips the native view like
        // any element, so the dock's other reasons never apply here).
        let left = if live_canvas && vertical_view {
            div()
                .truncate()
                .child(stage_copy::VERTICAL_VIEW_HINT)
                .into_any_element()
        } else if facts.drag_enabled || facts.overlays_editable {
            // P534: the keys, in Electron's order.
            let none = Modifiers::default();
            let shift = Modifiers {
                shift: true,
                ..Modifiers::default()
            };
            let alt = Modifiers {
                alt: true,
                ..Modifiers::default()
            };
            let mut keys = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x(px(12.))
                .gap_y(px(4.));
            if facts.nudge {
                keys = keys.child(hint(
                    ["left", "up", "down", "right"]
                        .into_iter()
                        .map(|key| key_chip(none, key))
                        .collect(),
                    words::NUDGE,
                ));
            }
            keys = keys.child(hint(
                vec![key_chip(shift, "")],
                if facts.nudge {
                    stage_copy::SHIFT_WORDS_NUDGE
                } else {
                    stage_copy::SHIFT_WORDS
                },
            ));
            if facts.effective_snap || facts.crop_hint {
                let word = match (facts.effective_snap, facts.crop_hint) {
                    (true, true) => stage_copy::ALT_BOTH,
                    (true, false) => stage_copy::ALT_NO_SNAP,
                    _ => stage_copy::ALT_CROP,
                };
                keys = keys.child(hint(vec![key_chip(alt, "")], word));
            }
            keys = keys.child(hint(vec![key_chip(none, "escape")], words::CANCEL));
            keys.into_any_element()
        } else {
            div().into_any_element()
        };

        let mut right = div().flex().items_center().gap(px(4.)).flex_none();
        // P535: Undo, mounted while there is one, so nothing reflows.
        if self.undo_available {
            let enabled = self.undo_enabled(snapshot);
            right = right
                .child(
                    Button::new("scene-stage-undo")
                        .label(words::UNDO)
                        .variant(ButtonVariant::Ghost)
                        .disabled(!enabled)
                        .child(ShortcutKeys::for_action(&UndoLayout))
                        .on_click(cx.listener(|this, _, _, cx| this.undo(cx))),
                )
                .child(vertical_rule(rule));
        }
        // P538: a refused grab in a layout offers Freeform.
        if self.stage.freeform_hint() && !facts.freeform && !position_locked(snapshot) {
            right = right.child(
                Button::new("scene-stage-make-freeform")
                    .label(words::MAKE_FREEFORM)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| this.enter_freeform(cx))),
            );
        }
        // P539: Snap, Freeform only, off at each visit.
        if facts.freeform {
            let on = self.stage.snap_on();
            right = right
                .child(
                    Button::new("scene-stage-snap")
                        .label(words::SNAP)
                        .accessibility_label(words::SNAP)
                        .variant(ButtonVariant::Ghost)
                        .lit(on)
                        .disabled(!facts.drag_enabled || phase == StagePhase::Dragging)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.stage.set_snap(!on);
                            cx.notify();
                        })),
                )
                .child(vertical_rule(rule));
        }
        // P540: the preview docks here or floats, where the canvas hosts
        // it; elsewhere P541's plain Open / Close Preview.
        let (can_float, preview_open) = {
            let preview = self.preview.read(cx);
            (preview.can_float(), !preview.is_closed())
        };
        let scene_docked = self.preview.read(cx).scene_hosts_docked();
        if !scene_docked && can_float {
            let label = if preview_open {
                words::CLOSE_PREVIEW
            } else {
                words::OPEN_PREVIEW
            };
            right = right.child(
                Button::new("scene-stage-toggle-preview")
                    .accessibility_label(label)
                    .variant(ButtonVariant::Ghost)
                    .child(icon(IconName::ArrowSquareOut, 14., muted))
                    .child(label)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.preview
                            .update(cx, |preview, cx| preview.toggle_open(cx));
                    })),
            );
        }
        if scene_docked && can_float {
            let button = if docked {
                Button::new("scene-stage-pop-out")
                    .accessibility_label(words::POP_OUT)
                    .child(icon(IconName::ArrowSquareOut, 14., muted))
                    .child(words::POP_OUT)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.preview
                            .update(cx, |preview, cx| preview.toggle_floating(cx));
                    }))
            } else {
                // From its own window or closed, the Preview docks here.
                Button::new("scene-stage-show-live")
                    .accessibility_label(words::SHOW_HERE)
                    .child(icon(IconName::Eye, 14., muted))
                    .child(words::SHOW_HERE)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.preview
                            .update(cx, |preview, cx| preview.show_docked(cx));
                    }))
            };
            right = right.child(button.variant(ButtonVariant::Ghost));
        }

        div()
            .id("scene-stage-footer")
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .p(px(8.))
            .type_scale(text::META)
            .text_color(muted)
            .child(div().flex_1().min_w_0().child(left))
            .child(right)
            .into_any_element()
    }

    /// A toolbar chip (`onSelectSource` / `overlays.onSelect`): a source
    /// opens the scene editor (`sceneEditMode`), an overlay item or a banner
    /// takes the selection alone.
    fn select_stage(&mut self, stage_id: &SharedString, cx: &mut Context<Self>) {
        self.cancel_stage_gesture(cx);
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

/// `positionLocked`: a session runs and the backend hasn't said it takes
/// live scene edits.
fn position_locked(snapshot: &StudioSnapshot) -> bool {
    scene_position_lock_reason(
        transport_active(&snapshot.session),
        snapshot.session.status.accepts_live_scene_edits,
    )
    .is_some()
}

/// The page's stage actions: Freeform entry, Edit scene, Undo.
impl ScenePage {
    /// X3 `enterFreeform` (P505, P538): every source goes Freeform where it
    /// was left in this orientation (C-4), the rest where it shows now. The
    /// picture-box seed (plan 216 B6) waits for the pictures' sizes, so a
    /// Fit screen starts at its frame.
    pub(super) fn enter_freeform(&mut self, cx: &mut Context<Self>) {
        if self.stage.phase() != StagePhase::Idle {
            return;
        }
        let snapshot = self.studio.snapshot();
        let Some(scene) = snapshot.sources.scene.as_ref() else {
            return;
        };
        let layout = &snapshot.settings.capture_doc["layout"];
        let memory = self.studio.remembered_freeform();
        let overrides = freeform_entry_overrides(
            &memory,
            layout_orientation(layout),
            &scene.sources,
            source_override,
        );
        let mut patch = Map::new();
        patch.insert("arrangementMode".into(), json!("freeform"));
        patch.insert("sourceTransformOverrides".into(), Value::Object(overrides));
        let studio = self.studio.clone();
        self.run(async move {
            studio.apply_camera_preset(patch, false).await;
        });
        cx.notify();
    }

    /// X2 Edit scene (P452): the first unlocked camera (else the first
    /// unlocked source) takes the selection and the editor opens; an
    /// overlay item lets go either way.
    pub(super) fn edit_scene(&mut self, cx: &mut Context<Self>) {
        self.cancel_stage_gesture(cx);
        let snapshot = self.studio.snapshot();
        let sources = snapshot
            .sources
            .scene
            .as_ref()
            .map(|scene| scene.sources.as_slice())
            .unwrap_or_default();
        let target = sources
            .iter()
            .find(|source| source.kind == SceneSourceKind::Camera && !source.locked)
            .or_else(|| sources.iter().find(|source| !source.locked))
            .map(|source| source.id.clone());
        if matches!(
            self.editor_state.selection,
            Some(InspectorSelection::Overlay(_))
        ) {
            self.editor_state.selection = None;
        }
        if let Some(id) = target {
            self.editor_state.selection = Some(InspectorSelection::Source(id));
        }
        self.studio.set_scene_edit_mode(true);
        self.refresh_editor(cx);
    }

    /// Undo and ⌘Z wait for the stage, a precise edit and a switch.
    fn undo_enabled(&self, snapshot: &StudioSnapshot) -> bool {
        self.undo_available
            && self.stage.phase() == StagePhase::Idle
            && !self.editor_state.precise_pending
            && !switch_pending(snapshot)
    }

    /// P535 `undoLayoutPatch`: the single slot goes back.
    fn undo(&mut self, cx: &mut Context<Self>) {
        if !self.undo_enabled(&self.studio.snapshot()) {
            return;
        }
        let studio = self.studio.clone();
        self.run(async move {
            studio.undo_layout().await;
        });
        cx.notify();
    }

    /// P536: ⌘Z / Ctrl+Z, not while a dialog or the Add app… popover is
    /// open (a focused text field's own Undo binding wins before this).
    pub(super) fn undo_key(&mut self, cx: &mut Context<Self>) {
        if self.dialogs.read(cx).any_open()
            || self.controls.camera_reset.is_open()
            || self.add_app_open
        {
            return;
        }
        self.undo(cx);
    }
}
