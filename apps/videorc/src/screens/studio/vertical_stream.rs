//! Studio dashboard Vertical stream panel (`vertical-leg-monitor.tsx`,
//! `vertical-stream-layout-control.tsx`; P273 slot, P334–P339). Shows when
//! a vertical destination is armed beside a 16:9 studio. Logic lives in
//! `videorc_app_core::studio::vertical_stream`; this draws the kit chrome.

use std::sync::Arc;

use gpui::{
    AnyElement, Context, SharedString, Window, div, linear_color_stop, linear_gradient, prelude::*,
    px,
};
use serde_json::{Map, json};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::scenes::thumb::{
    ThumbPart, ThumbSize, row_frame, thumb_areas, thumb_is_vertical,
};
use videorc_app_core::studio::scene_on_stream::{
    FramingView, copy as scene_copy, vertical_framing_line, vertical_stream_pick,
};
use videorc_app_core::studio::scenes_section::session_active;
use videorc_app_core::studio::vertical_stream::{
    VerticalLegMonitorView, VerticalStreamLayoutView, leg_copy,
};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::Select;
use videorc_kit::theme::{self, TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;

use super::transport::AppStudio;

const LAYOUT_SELECT_PX: f32 = 192.;
const FILL: &str = "fill";
const FIT: &str = "fit";

fn corner_px(corner: videorc_app_core::scenes::thumb::ThumbCorner) -> f32 {
    match corner {
        videorc_app_core::scenes::thumb::ThumbCorner::Chip => radius::CHIP,
        videorc_app_core::scenes::thumb::ThumbCorner::Area => radius::CHIP / 2.0,
        videorc_app_core::scenes::thumb::ThumbCorner::Tight => radius::CHIP / 3.0,
        videorc_app_core::scenes::thumb::ThumbCorner::Hair => radius::CHIP / 6.0,
    }
}

fn compact_thumb(preset: &str, fit: bool, t: &Theme) -> AnyElement {
    let vertical = thumb_is_vertical(preset);
    let frame = row_frame(vertical, if vertical { 20. } else { 28. * 9. / 16. });
    let areas = thumb_areas(
        preset,
        fit,
        ThumbSize::Compact,
        frame.width - 2.,
        frame.height - 2.,
    );
    let screen = hsla(with_alpha(t.foreground, 0.25));
    let camera = hsla(faded_over(t.foreground, t.glass_solid, 0.55));
    div()
        .flex_none()
        .w(px(28.))
        .flex()
        .justify_center()
        .child(
            div()
                .relative()
                .w(px(frame.width))
                .h(px(frame.height))
                .overflow_hidden()
                .rounded(px(corner_px(frame.corner)))
                .border_1()
                .border_color(hsla(with_alpha(t.foreground, 0.25)))
                .bg(linear_gradient(
                    135.,
                    linear_color_stop(hsla(with_alpha(t.muted, 0.4)), 0.),
                    linear_color_stop(hsla(with_alpha(t.muted, 0.7)), 1.),
                ))
                .children(areas.into_iter().map(|area| {
                    div()
                        .absolute()
                        .left(px(area.left))
                        .top(px(area.top))
                        .w(px(area.width))
                        .h(px(area.height))
                        .rounded(px(corner_px(area.corner)))
                        .bg(match area.part {
                            ThumbPart::Screen => screen,
                            ThumbPart::Camera => camera,
                        })
                })),
        )
        .into_any_element()
}

/// The Vertical stream section under Scenes (P273 order: Scenes, Soundboard,
/// Vertical stream). Draws nothing until simulcast is armed.
pub struct VerticalStreamSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    view: Option<VerticalLegMonitorView>,
}

impl VerticalStreamSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        cx: &mut Context<Self>,
    ) -> Self {
        let initial = snapshot.borrow().clone();
        let view = Self::compute(&studio, &initial);
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            loop {
                if snapshot.changed().await.is_err() {
                    break;
                }
                let snap = snapshot.borrow_and_update().clone();
                let next = Self::compute(&studio_watch, &snap);
                this.update(cx, |section, cx| {
                    if section.view != next {
                        section.view = next;
                        cx.notify();
                    }
                })
                .ok();
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            view,
        }
    }

    fn compute(studio: &AppStudio, snapshot: &StudioSnapshot) -> Option<VerticalLegMonitorView> {
        studio.vertical_leg_monitor(session_active(snapshot))
    }

    fn edit_layout(&mut self, key: &'static str, value: &'static str) {
        let mut patch = Map::new();
        patch.insert(key.into(), json!(value));
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.edit_vertical_stream_layout(patch).await {
                eprintln!("[videorc-app] Vertical stream: the layout wasn't saved");
            }
        });
    }

    fn layout_body(
        &self,
        layout: &VerticalStreamLayoutView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let read_only = layout.read_only_reason;
        let mut select = Select::new("vertical-stream-layout")
            .accessibility_label(leg_copy::LAYOUT_ARIA)
            .width(LAYOUT_SELECT_PX)
            .value(Some(SharedString::from(layout.preset.clone())))
            .disabled(read_only.is_some())
            .on_change({
                let entity = entity.clone();
                let view = layout.clone();
                move |value, _, cx| {
                    if let Some(preset) = vertical_stream_pick(&view, value.as_ref()) {
                        entity.update(cx, |section, _| section.edit_layout("layoutPreset", preset));
                    }
                }
            });
        for choice in layout.choices.iter().filter(|choice| !choice.disabled) {
            select = select.option(choice.preset, choice.label.clone());
        }
        let control = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(compact_thumb(&layout.preset, layout.fit, t))
            .child(select);
        let control: AnyElement = match read_only {
            Some(reason) => div()
                .id("vertical-stream-layout-reason")
                .child(control)
                .tooltip(tooltip(reason))
                .into_any_element(),
            None => control.into_any_element(),
        };

        let framing = FramingView {
            fit: layout.fit,
            line: vertical_framing_line(layout.fit),
            vertical: true,
        };
        let mut framing_control = SegmentedControl::new("vertical-stream-framing")
            .accessibility_label(scene_copy::SCREEN_FRAMING)
            .option(Segment::new(FILL, scene_copy::FILL))
            .option(Segment::new(FIT, scene_copy::FIT))
            .value(Some(if framing.fit { FIT } else { FILL }))
            .on_change({
                let entity = entity.clone();
                move |value, _, cx| {
                    entity.update(cx, |section, _| {
                        section.edit_layout(
                            "verticalScreenFraming",
                            if value.as_ref() == FIT { FIT } else { FILL },
                        )
                    });
                }
            });
        if let Some(reason) = read_only {
            framing_control = framing_control.disabled(true).disabled_reason(reason);
        }

        let muted = hsla(t.muted_foreground);
        div()
            .id("vertical-stream-layout")
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(
                                div()
                                    .type_scale(text::LABEL)
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hsla(t.foreground))
                                    .child(leg_copy::LAYOUT),
                            )
                            .child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(muted)
                                    .line_clamp(2)
                                    .child(layout.description.clone()),
                            ),
                    )
                    .child(div().flex_none().child(control)),
            )
            .children(
                layout
                    .reason
                    .clone()
                    .map(|reason| div().type_scale(text::META).text_color(muted).child(reason)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(
                                div()
                                    .type_scale(text::LABEL)
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hsla(t.foreground))
                                    .child(leg_copy::SCREEN),
                            )
                            .child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(muted)
                                    .child(framing.line),
                            ),
                    )
                    .child(div().flex_none().child(framing_control)),
            )
            .into_any_element()
    }
}

impl Render for VerticalStreamSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(view) = self.view.clone() else {
            return div().id("studio-vertical-stream").into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let badge = if view.session_active {
            Badge::new(leg_copy::ON_AIR).variant(BadgeVariant::Live)
        } else {
            Badge::new(leg_copy::READY).variant(BadgeVariant::Outline)
        };
        let description = if view.session_active {
            leg_copy::DESC_LIVE
        } else {
            leg_copy::DESC_IDLE
        };
        let mut section = PanelSection::new("studio-vertical-stream")
            .title(leg_copy::TITLE)
            .icon(icon(IconName::DeviceMobile, 16., muted))
            .action(badge)
            .description(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(description),
            );
        if let Some(layout) = &view.layout {
            section = section.child(self.layout_body(layout, &t, cx));
        }
        section.into_any_element()
    }
}
