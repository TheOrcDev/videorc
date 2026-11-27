//! The Layout section (`layout-tab.tsx`; P499–P511): the orientation, the
//! layouts of the scene on stream, the switch's status line, the hint, the
//! screen's framing and Animate scene changes, and the Freeform toggle
//! (P505). The view is the core's `layout_section_view`; the stage's phase
//! gates the layouts and Freeform as it draws.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use serde_json::{Map, json};
use videorc_app_core::editor::inspector::copy as inspector_copy;
use videorc_app_core::nav::PageId;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::label::Label;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::spinner::Spinner;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::model::copy;
use super::{SceneNavigate, ScenePage, epoch_ms};

const HORIZONTAL: &str = "horizontal";
const VERTICAL: &str = "vertical";

impl ScenePage {
    pub(super) fn layout_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let ink = hsla(t.foreground);
        let mut view = self.model.layout.clone();
        // `stageBusy`: no layout or Freeform while a gesture or its commit
        // is in flight.
        if self.stage.phase() != super::stage::StagePhase::Idle {
            view.presets_enabled = false;
            view.freeform_enabled = false;
        }
        let page = cx.entity().downgrade();

        // P499/P500: the orientation, locked while a session runs; the
        // Display and Mobile marks, named for their shape.
        let orientation_page = page.clone();
        let mut orientation = SegmentedControl::new("scene-orientation")
            .accessibility_label(copy::ORIENTATION)
            .manual(true)
            .small(true)
            .fit(true)
            .option(
                Segment::new(HORIZONTAL, copy::HORIZONTAL_NAME)
                    .child(icon(
                        IconName::Monitor,
                        14.,
                        if view.vertical { muted } else { ink },
                    ))
                    .tooltip(copy::HORIZONTAL_TIP),
            )
            .option(
                Segment::new(VERTICAL, copy::VERTICAL_NAME)
                    .child(icon(
                        IconName::DeviceMobile,
                        14.,
                        if view.vertical { ink } else { muted },
                    ))
                    .tooltip(copy::VERTICAL_TIP),
            )
            .value(Some(if view.vertical { VERTICAL } else { HORIZONTAL }))
            .on_change(move |value, _, cx| {
                let vertical = value.as_ref() == VERTICAL;
                let _ = orientation_page.update(cx, |page, _| page.switch_orientation(vertical));
            });
        if let Some(reason) = view.orientation_lock {
            orientation = orientation.disabled(true).disabled_reason(reason);
        }

        // P501–P504: the layouts. A layout that asks for a screen (D19)
        // opens Change screen… for the scene on stream, and goes on once
        // the screen does.
        let presets_page = page.clone();
        let mut presets = SegmentedControl::new("scene-layout-presets")
            .accessibility_label(copy::LAYOUT_TITLE)
            .manual(true)
            .fit(true)
            .disabled(!view.presets_enabled)
            .value(
                view.preset_index
                    .and_then(|index| view.presets.get(index))
                    .map(|option| SharedString::from(option.id)),
            )
            .on_change(move |value, window, cx| {
                let preset = value.to_string();
                let _ = presets_page.update(cx, |page, cx| page.choose_layout(&preset, window, cx));
            });
        // P503: the layout a switch is putting on keeps its name, with
        // the pending mark before it (`SceneSwitchPending label={false}`).
        for option in &view.presets {
            let mut segment =
                Segment::new(option.id, option.label.clone()).disabled(option.disabled);
            if option.pending {
                segment = segment.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            Spinner::new(SharedString::from(format!(
                                "scene-layout-pending-{}",
                                option.id
                            )))
                            .size(14.),
                        )
                        .child(option.label.clone()),
                );
            }
            presets = presets.option(segment);
        }

        // P505 / X3: Freeform. Every press enters it (pressing it again
        // re-enters; only a layout leaves it); a spinner while it lands.
        let freeform = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                Button::new("scene-layout-freeform")
                    .label(view.freeform_label)
                    .variant(ButtonVariant::Outline)
                    .lit(view.freeform)
                    .disabled(!view.freeform_enabled)
                    .on_click(cx.listener(|this, _, _, cx| this.enter_freeform(cx))),
            )
            .when(view.freeform_pending, |row| {
                row.child(Spinner::new("scene-freeform-spinner").size(14.))
            });
        let mut section = PanelSection::new("scene-layout")
            .title(copy::LAYOUT_TITLE)
            .icon(icon(IconName::Layout, 16., muted))
            .description(inspector_copy::LAYOUT_DESCRIPTION)
            .action(orientation)
            .child(
                div()
                    .id("scene-layout-row")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(presets)
                    .child(div().w(px(1.)).h(px(20.)).bg(hsla(t.border)))
                    .child(freeform),
            );

        // P506: the switch's status line, 1.5 s after it starts.
        if let Some(line) = self
            .studio
            .watch()
            .borrow()
            .scenes
            .progress_line(epoch_ms(), None)
        {
            section = section.child(
                div()
                    .id("scene-switch-status")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(Spinner::new("scene-switch-spinner").size(14.))
                    .child(div().text_color(ink).child(line.title))
                    .children(line.detail),
            );
        }

        // P507–P509: the hint, with the door to Sources.
        if let Some((hint, door)) = view.hint {
            section = section.child(
                div()
                    .id("scene-layout-hint")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(hint)
                    .when(door, |line| {
                        line.child(
                            Button::new("scene-layout-open-sources")
                                .label(copy::OPEN_SOURCES)
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.navigate(SceneNavigate::Page(PageId::Sources), cx)
                                })),
                        )
                    }),
            );
        }

        // P510: the screen's framing.
        if let Some((fit, line, vertical)) = view.framing {
            let framing_page = page.clone();
            section = section.child(
                div()
                    .id("scene-screen-framing")
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    // `ScreenFramingControl`: the name in 14 px / 500, its
                    // line 2 px under it.
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(Label::new(copy::SCREEN))
                            .child(div().type_scale(text::META).text_color(muted).child(line)),
                    )
                    .child(
                        SegmentedControl::new("scene-screen-framing-control")
                            .accessibility_label(copy::SCREEN_FRAMING)
                            .fit(true)
                            .option(Segment::new("fill", copy::FILL))
                            .option(Segment::new("fit", copy::FIT))
                            .value(Some(if fit { "fit" } else { "fill" }))
                            .on_change(move |value, _, cx| {
                                let framing = value.to_string();
                                let _ = framing_page
                                    .update(cx, |page, _| page.set_framing(vertical, &framing));
                            }),
                    ),
            );
        }

        // P511: Animate scene changes.
        let animate_page = page;
        section = section.child(
            SettingsRow::new("animate-scene-changes", copy::ANIMATE)
                .flush(true)
                .description(copy::ANIMATE_DESCRIPTION)
                .child(
                    Switch::new("animate-scene-changes-switch")
                        .accessibility_label(copy::ANIMATE)
                        .checked(view.animate)
                        .on_change(move |on, _, cx| {
                            let _ = animate_page.update(cx, |page, _| page.set_animate(on));
                        }),
                ),
        );
        section.into_any_element()
    }

    fn switch_orientation(&self, vertical: bool) {
        let studio = self.studio.clone();
        self.run(async move {
            let ok = studio.switch_orientation(vertical).await;
            eprintln!("[videorc-app] Scene orientation: {ok}");
        });
    }

    /// `chooseLayout`: D19 first, else the layout goes on.
    fn choose_layout(&mut self, preset: &str, window: &mut Window, cx: &mut Context<Self>) {
        let asks = self
            .model
            .layout
            .presets
            .iter()
            .any(|option| option.id == preset && option.asks_for_screen);
        if asks {
            let on_stream = {
                let watch = self.studio.watch();
                let snapshot = watch.borrow();
                snapshot.scenes.on_stream_id.clone().and_then(|id| {
                    snapshot
                        .scenes
                        .scenes
                        .iter()
                        .find(|scene| scene.id == id)
                        .map(|scene| (id, scene.name.clone()))
                })
            };
            if let Some((scene_id, _)) = on_stream {
                self.open_change_screen(&scene_id, Some(preset.to_string()), window, cx);
            }
            return;
        }
        self.apply_layout(preset);
    }

    fn apply_layout(&self, preset: &str) {
        let studio = self.studio.clone();
        let preset = preset.to_string();
        self.run(async move {
            let ok = studio.apply_layout_preset(&preset).await;
            eprintln!("[videorc-app] Scene layout: {ok}");
        });
    }

    /// `applyCameraPreset({verticalScreenFraming})` or its landscape twin.
    fn set_framing(&self, vertical: bool, framing: &str) {
        let studio = self.studio.clone();
        let mut patch = Map::new();
        let key = if vertical {
            "verticalScreenFraming"
        } else {
            "horizontalScreenFraming"
        };
        patch.insert(key.into(), json!(framing));
        self.run(async move {
            let ok = studio.apply_camera_preset(patch, false).await;
            eprintln!("[videorc-app] Scene framing: {ok}");
        });
    }

    fn set_animate(&self, on: bool) {
        let studio = self.studio.clone();
        self.run(async move {
            let result = studio.set_animate_scene_changes(on).await;
            eprintln!("[videorc-app] Animate scene changes: {result:?}");
        });
    }
}
