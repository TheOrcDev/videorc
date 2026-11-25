//! The camera's inspector (`layout-tab.tsx` `CameraInspector` 1462-1770;
//! P556–P573) and its Background section (`camera-background-section.tsx`;
//! P574–P585): the name section with Visible in scene and Reset camera
//! settings, Background, Placement, Lens and Camera look. The view is the
//! core's (`inspector_view`'s camera rows, `background_section_view`).

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px, relative};
use serde_json::json;
use videorc_app_core::editor::inspector::{
    InspectorView, camera_settings_defaults, camera_shape_patch, copy as inspector_copy,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::camera_background_view::{
    BLUR_MARKS, BLUR_MAX_PCT, BLUR_MIN_PCT, BLUR_STRENGTH_LABEL, BackgroundSectionView,
    CHOOSE_IMAGE_LABEL, Choice, ChoiceId, KEY_EDGES, background_for_choice, key_edges_of,
    key_edges_set,
};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, faded_over, hsla};
use videorc_kit::tokens::{Theme, radius, text};

use super::controls::{Field, Knob};
use super::editor::copy;
use super::inspector::meta_line;
use super::model::copy as list_copy;
use super::{SceneNavigate, ScenePage};

/// What a camera row's pick does.
type Pick = fn(&ScenePage, &str);

/// A labelled camera row: its options (value, words), the checked one and
/// what a pick does.
struct Row {
    id: &'static str,
    label: &'static str,
    options: &'static [(&'static str, &'static str)],
    checked: Option<usize>,
    pick: Pick,
}

/// One background tile.
struct Tile {
    id: SharedString,
    label: SharedString,
    selected: bool,
    disabled: bool,
    mark: Option<IconName>,
}

fn pick_split(page: &ScenePage, value: &str) {
    page.apply_camera_preset("sideBySideSplit", value);
}

fn pick_side(page: &ScenePage, value: &str) {
    page.apply_camera_preset("sideBySideCameraSide", value);
}

fn pick_corner(page: &ScenePage, value: &str) {
    page.apply_camera_preset("cameraCorner", value);
}

fn pick_size(page: &ScenePage, value: &str) {
    page.apply_camera_preset("cameraSize", value);
}

/// `applyLayoutPatch(cameraShapePatch(shape))`: Rounded is a rounded square.
fn pick_shape(page: &ScenePage, value: &str) {
    page.apply_layout_patch(camera_shape_patch(value));
}

fn pick_aspect(page: &ScenePage, value: &str) {
    page.patch_layout("cameraAspect", json!(value));
}

fn pick_fit(page: &ScenePage, value: &str) {
    page.patch_layout("cameraFit", json!(value));
}

impl ScenePage {
    /// A labelled `SegmentedControl` (`Field` + `FieldLabel`).
    fn camera_row(&self, row: Row, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let page = cx.entity().downgrade();
        let Row {
            id,
            label,
            options,
            checked,
            pick,
        } = row;
        let mut control = SegmentedControl::new(id)
            .accessibility_label(label)
            .value(
                checked
                    .and_then(|index| options.get(index))
                    .map(|(value, _)| *value),
            )
            .on_change(move |value, _, cx| {
                let _ = page.update(cx, |page, _| pick(page, &value));
            });
        for (value, words) in options {
            control = control.option(Segment::new(*value, *words));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .min_w_0()
            .child(
                div()
                    .type_scale(text::LABEL)
                    .text_color(hsla(t.foreground))
                    .child(label),
            )
            .child(control)
            .into_any_element()
    }

    /// The camera's sections in order: name, Background, Placement, Lens,
    /// Camera look.
    pub(super) fn camera_sections(
        &mut self,
        view: &InspectorView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let t = theme::resolve(None, window, cx);
        let mut sections = Vec::new();

        // P544, P556: the name section.
        // TODO(kit): ResetIcon (ArrowCounterClockwise) on Reset camera
        // settings; AdjustIcon on the title.
        sections.push(
            PanelSection::new("scene-camera-section")
                .title(view.title.clone())
                .children(self.visibility_row(view, cx))
                .child(
                    Button::new("scene-camera-reset")
                        .label(inspector_copy::CAMERA_RESET_LABEL)
                        .size(ButtonSize::Xs)
                        .variant(ButtonVariant::Ghost)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.controls.camera_reset.open(window, cx);
                            cx.notify();
                        })),
                )
                .into_any_element(),
        );

        // P574–P585.
        if let Some(background) = self.editor.background.clone() {
            sections.push(self.background_section(&background, t, cx));
        }

        // P557–P566: Placement.
        if let Some(placement) = view.placement.clone() {
            let rows = placement.camera.clone().unwrap_or_default();
            let mut section = PanelSection::new("scene-camera-placement")
                .title(copy::PLACEMENT)
                .heading_level(3);
            if let Some(description) = placement.description.clone() {
                section = section.description(description);
            }
            if let Some(split) = rows.split {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-split",
                        label: copy::SPLIT,
                        options: &copy::SPLITS,
                        checked: Some(split),
                        pick: pick_split,
                    },
                    t,
                    cx,
                ));
            }
            if let Some(side) = rows.side {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-side",
                        label: copy::CAMERA_SIDE,
                        options: &copy::SIDES,
                        checked: Some(side),
                        pick: pick_side,
                    },
                    t,
                    cx,
                ));
            }
            if let Some(corner) = rows.corner {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-corner",
                        label: copy::CORNER,
                        options: &copy::CORNERS,
                        checked: corner,
                        pick: pick_corner,
                    },
                    t,
                    cx,
                ));
            }
            // TODO(kit): Size and Shape side by side from 540 px of
            // inspector width (`SCENE_INSPECTOR_PAIR`).
            if let Some(size) = rows.size {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-size",
                        label: copy::SIZE,
                        options: &copy::SIZES,
                        checked: Some(size),
                        pick: pick_size,
                    },
                    t,
                    cx,
                ));
            }
            if let Some(shape) = rows.shape {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-shape",
                        label: copy::SHAPE,
                        options: &copy::SHAPES,
                        checked: Some(shape),
                        pick: pick_shape,
                    },
                    t,
                    cx,
                ));
            }
            if rows.radius.is_some() {
                section = section.child(self.knob_row(
                    Knob::CornerRadius,
                    copy::CORNER_RADIUS,
                    false,
                    None,
                    t,
                    cx,
                ));
            }
            if let Some((aspect, crops)) = rows.aspect {
                section = section
                    .child(self.camera_row(
                        Row {
                            id: "scene-camera-aspect",
                            label: copy::ASPECT,
                            options: &copy::ASPECTS,
                            checked: Some(aspect),
                            pick: pick_aspect,
                        },
                        t,
                        cx,
                    ))
                    .children(crops.then(|| meta_line(copy::ASPECT_CROPS, t)));
            }
            if rows.margin.is_some() {
                section =
                    section.child(self.knob_row(Knob::Margin, copy::MARGIN, false, None, t, cx));
            }
            if let Some(fields) = &placement.fields {
                section = section.child(self.transform_fields(fields, t, cx));
            }
            sections.push(section.into_any_element());
        }

        // P567–P573: Lens and Camera look.
        if let Some(lens) = view.lens.clone() {
            let mut section = PanelSection::new("scene-camera-lens")
                .title(copy::LENS)
                .heading_level(3);
            if let Some(description) = lens.description {
                section = section.description(description);
            }
            if let Some(fit) = lens.fit {
                section = section.child(self.camera_row(
                    Row {
                        id: "scene-camera-fit",
                        label: copy::FIT,
                        options: &copy::FITS,
                        checked: Some(fit),
                        pick: pick_fit,
                    },
                    t,
                    cx,
                ));
            }
            let mirror_page = cx.entity().downgrade();
            section = section
                .child(
                    SettingsRow::new("scene-camera-mirror", copy::MIRROR_CAMERA).child(
                        Switch::new("scene-camera-mirror-switch")
                            .accessibility_label(copy::MIRROR_CAMERA)
                            .checked(lens.mirror)
                            .on_change(move |on, _, cx| {
                                let _ = mirror_page.update(cx, |page, _| {
                                    page.patch_layout("cameraMirror", json!(on))
                                });
                            }),
                    ),
                )
                .child(self.knob_row(Knob::CameraZoom, copy::ZOOM, false, None, t, cx))
                .child(self.knob_row(Knob::PanX, copy::PAN_X, false, None, t, cx))
                .child(self.knob_row(Knob::PanY, copy::PAN_Y, false, None, t, cx));
            sections.push(section.into_any_element());

            let disabled = lens.look_reason.is_some();
            sections.push(
                PanelSection::new("scene-camera-look")
                    .title(copy::CAMERA_LOOK)
                    .heading_level(3)
                    .description(copy::CAMERA_LOOK_DESCRIPTION)
                    .action(
                        Button::new("scene-camera-look-reset")
                            .label(copy::RESET)
                            .accessibility_label(copy::RESET_CAMERA_LOOK)
                            .size(ButtonSize::Xs)
                            .variant(ButtonVariant::Ghost)
                            .disabled(!lens.look_reset_enabled)
                            .on_click(cx.listener(|this, _, _, cx| this.reset_camera_look(cx))),
                    )
                    .child(self.knob_row(
                        Knob::Brightness,
                        copy::BRIGHTNESS,
                        disabled,
                        lens.look_reason,
                        t,
                        cx,
                    ))
                    .child(self.knob_row(
                        Knob::Contrast,
                        copy::CONTRAST,
                        disabled,
                        lens.look_reason,
                        t,
                        cx,
                    ))
                    .child(self.knob_row(
                        Knob::Saturation,
                        copy::SATURATION,
                        disabled,
                        lens.look_reason,
                        t,
                        cx,
                    ))
                    .into_any_element(),
            );
        }
        sections
    }

    /// One background tile (`MediaCard` with its name under it).
    // TODO(kit): MediaCard with the Orc art (room, blur, picture, screen),
    // radio semantics and the roving focus of the tiles (Arrow keys).
    fn background_tile(
        &self,
        tile: Tile,
        t: &Theme,
        on_pick: impl Fn(&mut ScenePage, &mut Context<ScenePage>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Tile {
            id,
            label,
            selected,
            disabled,
            mark,
        } = tile;
        let ground = t.glass_solid;
        let fade = |color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let rim = if selected { t.ring } else { t.border };
        let ink = if selected {
            t.foreground
        } else {
            t.muted_foreground
        };
        let mut tile = div()
            .id(id)
            .flex()
            .flex_col()
            .gap(px(4.))
            .min_w_0()
            .child(
                div()
                    .w_full()
                    .aspect_ratio(16. / 10.)
                    .rounded(px(radius::ROW))
                    .border_1()
                    .border_color(hsla(fade(rim)))
                    .bg(hsla(fade(t.muted)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .children(mark.map(|mark| icon(mark, 16., hsla(fade(t.muted_foreground))))),
            )
            .child(
                div()
                    .type_scale(text::LABEL)
                    .text_color(hsla(fade(ink)))
                    .child(label),
            );
        if !disabled {
            tile = tile.on_click(cx.listener(move |this, _, _, cx| on_pick(this, cx)));
        }
        tile.into_any_element()
    }

    /// P574–P585: the camera's Background.
    fn background_section(
        &self,
        view: &BackgroundSectionView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Off, the blurs and the pictures; Choose image…; the screens.
        let (screens, others): (Vec<&Choice>, Vec<&Choice>) = view
            .tiles
            .iter()
            .partition(|choice| matches!(choice.id, ChoiceId::Green | ChoiceId::Blue));
        let mut grid = div().grid().grid_cols(4).gap(px(6.));
        let tile = |page: &ScenePage, choice: &Choice, cx: &mut Context<ScenePage>| {
            let id = choice.id.clone();
            page.background_tile(
                Tile {
                    id: SharedString::from(format!("scene-background-{}", choice.id.as_string())),
                    label: SharedString::from(choice.label.clone()),
                    selected: view.selected.as_ref() == Some(&choice.id),
                    disabled: choice.disabled_reason.is_some(),
                    mark: None,
                },
                t,
                move |page, cx| page.choose_background(&id, cx),
                cx,
            )
        };
        for choice in others {
            grid = grid.child(tile(self, choice, cx));
        }
        // P578 opens the image list; the app reads no background pictures
        // yet (P586's dialog waits for them), so it is the dialog's own
        // "Open Images" door for now.
        if view.choose_image {
            grid = grid.child(self.background_tile(
                Tile {
                    id: SharedString::from("scene-background-choose-image"),
                    label: SharedString::from(CHOOSE_IMAGE_LABEL),
                    selected: false,
                    disabled: false,
                    mark: Some(IconName::ImageSquare),
                },
                t,
                |page, cx| page.navigate(SceneNavigate::Page(PageId::Assets), cx),
                cx,
            ));
        }
        for choice in screens {
            grid = grid.child(tile(self, choice, cx));
        }

        let mut section = PanelSection::new("scene-camera-background")
            .title(view.label)
            .heading_level(3)
            .description(view.description)
            .child(grid)
            .children(view.reason.map(|reason| meta_line(reason, t)));

        // P581: Blur strength, its marks under the track.
        if view.blur_pct.is_some() {
            let span = (BLUR_MAX_PCT - BLUR_MIN_PCT) as f32;
            let mut marks = div().relative().h(px(16.)).w_full();
            for (at, word) in BLUR_MARKS {
                marks = marks.child(
                    div()
                        .absolute()
                        .left(relative((at - BLUR_MIN_PCT) as f32 / span))
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(word),
                );
            }
            section = section.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(self.knob_row(
                        Knob::BlurStrength,
                        BLUR_STRENGTH_LABEL,
                        false,
                        None,
                        t,
                        cx,
                    ))
                    .child(marks),
            );
        }

        // P582–P584: a screen key's tuning and Hide edges.
        if let Some(screen) = &view.screen {
            let mut edges = div().flex().flex_wrap().gap(px(8.));
            for (index, (_, label)) in KEY_EDGES.into_iter().enumerate() {
                edges = edges.child(self.percent_field(
                    Field::Edge(index),
                    label,
                    copy::hide_edge_name(label),
                    true,
                    t,
                ));
            }
            section = section
                .child(self.knob_row(Knob::Similarity, copy::SIMILARITY, false, None, t, cx))
                .child(self.knob_row(Knob::Smoothness, copy::SMOOTHNESS, false, None, t, cx))
                .child(self.knob_row(Knob::Spill, copy::SPILL_REMOVAL, false, None, t, cx))
                .child(
                    div()
                        .id("scene-key-edges")
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(SectionLabel::new(copy::HIDE_EDGES))
                        .child(edges)
                        .child(meta_line(copy::HIDE_EDGES_HELP, t))
                        // TODO(kit): ResetIcon (ArrowCounterClockwise).
                        .children(key_edges_set(&screen.hide_edges).then(|| {
                            Button::new("scene-key-edges-reset")
                                .label(copy::SHOW_ALL_EDGES)
                                .size(ButtonSize::Xs)
                                .variant(ButtonVariant::Ghost)
                                .on_click(cx.listener(|this, _, _, _| {
                                    this.set_hide_edges(key_edges_of(None))
                                }))
                        })),
                );
        }

        // P585: the hint.
        section
            .children(view.hint.clone().map(|hint| meta_line(hint, t)))
            .into_any_element()
    }

    /// `choose(id)`: the pick's background, applied at once.
    fn choose_background(&mut self, choice: &ChoiceId, cx: &mut Context<Self>) {
        let next = background_for_choice(&self.editor.camera_background, choice);
        let camera = self.editor.camera_id.clone();
        if let Some(next) = self
            .editor_state
            .background_draft
            .commit(camera.as_deref(), next)
        {
            self.apply_camera_background(next);
        }
        self.refresh_editor(cx);
    }

    /// P556: Reset camera settings? (`CameraResetButton`'s ConfirmDialog).
    pub(super) fn camera_reset_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.controls.camera_reset.is_open() {
            return div().into_any_element();
        }
        Dialog::new(
            "scene-camera-reset-dialog",
            &self.controls.camera_reset,
            inspector_copy::CAMERA_RESET_TITLE,
        )
        .size(DialogSize::Sm)
        .close_button(false)
        .description(inspector_copy::CAMERA_RESET_DESCRIPTION)
        .footer(
            Button::new("scene-camera-reset-cancel")
                .label(list_copy::CANCEL)
                .variant(ButtonVariant::Ghost)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.controls.camera_reset.close(window, cx);
                    cx.notify();
                })),
        )
        .footer(
            Button::new("scene-camera-reset-confirm")
                .label(inspector_copy::CAMERA_RESET_LABEL)
                .variant(ButtonVariant::Destructive)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.apply_layout_patch(camera_settings_defaults());
                    this.controls.camera_reset.close(window, cx);
                    cx.notify();
                })),
        )
        .into_any_element()
    }
}
