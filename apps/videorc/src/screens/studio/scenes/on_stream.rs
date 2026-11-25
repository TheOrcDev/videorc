//! The scene on stream's own fields under the cards (plan 231 D8,
//! `scene-on-stream.tsx`, `screen-privacy-control.tsx`; P318–P328,
//! P330–P333): "On stream: {name}", Screen with Hide screen, Layout,
//! Framing and, with a vertical stream armed beside a 16:9 studio, the
//! scene's 9:16 layout. Every edit saves into the scene on stream. Words
//! and states are app-core's (`studio::scene_on_stream`); this module draws
//! them and calls the Studio.
//!
//! Hide screen is the backend's one state: read on every connection
//! (`screen.privacy.get`), heard on every change (`screen.privacy.changed`)
//! and changed with `screen.hide` / `screen.show`. Change screen… waits for
//! the scene picker, as on the Scene page; until it lands a layout that
//! asks for a screen first (D19) isn't offered. The Retro LCD rows (P329)
//! wait for the kit's LCD panel.

use gpui::{
    AnyElement, Context, Div, Role, SharedString, Window, div, linear_color_stop, linear_gradient,
    prelude::*, px,
};
use serde_json::{Map, Value, json};
use tokio::sync::broadcast::error::RecvError;
use videorc_app_core::BackendEvent;
use videorc_app_core::desktop::accelerator::accelerator_display_keys;
use videorc_app_core::desktop::permissions::SystemPermissionPane;
use videorc_app_core::scenes::thumb::{
    ThumbPart, ThumbSize, row_frame, thumb_areas, thumb_is_vertical,
};
use videorc_app_core::studio::live_sources::copy as live_copy;
use videorc_app_core::studio::scene_on_stream::{
    FramingView, SCREEN_PRIVACY_CHANGED_EVENT, SCREEN_PRIVACY_GET_METHOD, copy,
    screen_privacy_outcome, screen_privacy_request, vertical_framing_line, vertical_stream_pick,
};
use videorc_app_core::studio::sources_page::GrantAction;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::select::Select;
use videorc_kit::theme::{TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Theme, text};
use videorc_kit::tooltip::tooltip;
use videorc_kit::{
    Alert, AlertVariant, Badge, BadgeVariant, Button, ButtonVariant, Kbd, Segment,
    SegmentedControl, kbd_group,
};
use videorc_protocol::ScreenPrivacy;

use super::{ScenesSection, corner_px};
use crate::app::hotkeys::node_platform;

/// The Layout select's width (`w-48`).
const LAYOUT_SELECT_PX: f32 = 192.;
/// From this width the fields' Hide screen carries its key
/// (`@lg/scene-fields`, 32 rem).
const KEY_IN_BUTTON_PX: f32 = 512.;
const FILL: &str = "fill";
const FIT: &str = "fit";

/// A layout's icon-size diagram (`LayoutChoice inTrigger`, `compact`): a
/// 16:9 one 28 px wide, a 9:16 one 20 px tall, never a picture.
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
    // The stronger fills at icon size: screen foreground/25, the camera's
    // plate foreground/55 over the solid.
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

/// One field (`SceneField`): its name, a status chip, its value and note on
/// the left, its control on the right.
fn field(
    id: &'static str,
    label: &'static str,
    status: Option<AnyElement>,
    description: impl Into<SharedString>,
    note: Option<String>,
    control: AnyElement,
    t: &Theme,
) -> Div {
    let muted = hsla(t.muted_foreground);
    div().flex().flex_col().gap(px(8.)).child(
        div()
            .id(id)
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
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .type_scale(text::LABEL)
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hsla(t.foreground))
                                    .child(label),
                            )
                            .children(status),
                    )
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(muted)
                            .line_clamp(2)
                            .child(description.into()),
                    )
                    .children(
                        note.map(|note| div().type_scale(text::META).text_color(muted).child(note)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .child(control),
            ),
    )
}

/// A quiet line under a field (`text-xs text-muted-foreground`).
fn quiet_line(words: impl Into<SharedString>, t: &Theme) -> Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(words.into())
}

/// Fill or Fit (`ScreenFramingControl`): its name and line, the two
/// segments; a reason disables it.
fn framing_row(
    id: &'static str,
    view: FramingView,
    reason: Option<&'static str>,
    on_change: impl Fn(bool, &mut gpui::App) + 'static,
    t: &Theme,
) -> AnyElement {
    let mut control = SegmentedControl::new(id)
        .accessibility_label(copy::SCREEN_FRAMING)
        .option(Segment::new(FILL, copy::FILL))
        .option(Segment::new(FIT, copy::FIT))
        .value(Some(if view.fit { FIT } else { FILL }))
        .on_change(move |value, _, cx| on_change(value.as_ref() == FIT, cx));
    if let Some(reason) = reason {
        control = control.disabled(true).disabled_reason(reason);
    }
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
                        .child(copy::FRAMING),
                )
                .child(quiet_line(view.line, t)),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}

impl ScenesSection {
    /// Hide screen's state: read now and on every connection, heard on
    /// every change (`useScreenPrivacy`).
    pub(super) fn watch_privacy(&mut self, cx: &mut Context<Self>) {
        let mut events = self.studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => Some(event),
                    // Fell behind: read the state again.
                    Err(RecvError::Lagged(_)) => None,
                    Err(RecvError::Closed) => break,
                };
                let alive = this.update(cx, |section, cx| match event {
                    None
                    | Some(BackendEvent::Ready(_))
                    | Some(BackendEvent::EventsLagged(_))
                    | Some(BackendEvent::ClientLagged { .. }) => section.read_privacy(cx),
                    Some(BackendEvent::Untyped { event, payload })
                        if event == SCREEN_PRIVACY_CHANGED_EVENT =>
                    {
                        if let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(payload) {
                            section.privacy_changed(privacy, cx);
                        }
                        section.read_privacy(cx);
                    }
                    Some(_) => {}
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        self.read_privacy(cx);
    }

    /// `screen.privacy.get`; a change heard meanwhile wins over the answer.
    fn read_privacy(&mut self, cx: &mut Context<Self>) {
        self.privacy_revision += 1;
        let expected = self.privacy_revision;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .backend()
                .request(SCREEN_PRIVACY_GET_METHOD, Value::Null)
                .await
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(value)) = job.await else {
                return;
            };
            let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(value) else {
                return;
            };
            this.update(cx, |section, cx| {
                if section.privacy_revision == expected {
                    section.privacy = privacy;
                    section.refresh(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn privacy_changed(&mut self, privacy: ScreenPrivacy, cx: &mut Context<Self>) {
        self.privacy_revision += 1;
        self.privacy = privacy;
        self.refresh(cx);
    }

    /// Hide screen / Show screen (P320, P330): a refused hide warns, a
    /// failure says what failed, success is silent (the chip says it).
    fn toggle_privacy(&mut self, cx: &mut Context<Self>) {
        let Some(view) = &self.on_stream else {
            return;
        };
        if view.privacy.disabled_reason.is_some() {
            return;
        }
        let hidden = view.privacy.hidden;
        let (method, params) = screen_privacy_request(hidden);
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.backend().request(method, params).await });
        cx.spawn(async move |this, cx| {
            let Ok(answer) = job.await else {
                return;
            };
            this.update(cx, |section, cx| {
                let outcome = screen_privacy_outcome(!hidden, answer);
                if let Some(notice) = outcome.notice {
                    section.studio.post_notices(vec![notice]);
                }
                if let Some(privacy) = outcome.privacy {
                    section.privacy_changed(privacy, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// The Layout field's pick (`chooseLayout`).
    fn choose_layout(&mut self, preset: &str) {
        let Some(preset) = self
            .on_stream
            .as_ref()
            .and_then(|view| view.layout.pick(preset))
        else {
            return;
        };
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.apply_layout_preset(preset).await {
                eprintln!("[videorc-app] Scenes: the layout didn't change");
            }
        });
    }

    /// Fill or Fit (`applyCameraPreset({verticalScreenFraming})` or its
    /// landscape twin).
    fn set_framing(&mut self, vertical: bool, fit: bool) {
        let mut patch = Map::new();
        let key = if vertical {
            "verticalScreenFraming"
        } else {
            "horizontalScreenFraming"
        };
        patch.insert(key.into(), json!(if fit { FIT } else { FILL }));
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.apply_camera_preset(patch, false).await {
                eprintln!("[videorc-app] Scenes: the framing didn't change");
            }
        });
    }

    /// The Vertical stream's pick, saved into the scene on stream's 9:16
    /// layout (`editVerticalStreamLayout`).
    fn edit_vertical_stream(&mut self, key: &'static str, value: &'static str) {
        let mut patch = Map::new();
        patch.insert(key.into(), json!(value));
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.edit_vertical_stream_layout(patch).await {
                eprintln!("[videorc-app] Scenes: the vertical stream's layout wasn't saved");
            }
        });
    }

    /// The capture line's Check again.
    fn retry_capture_status(&mut self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.retry_source_status().await;
        });
    }

    /// The Screen Recording alert's one action (as the Sources page runs it).
    fn run_screen_alert(&mut self, cx: &mut Context<Self>) {
        let Some(alert) = &self.screen_alert else {
            return;
        };
        let pane = SystemPermissionPane::ScreenRecording;
        match alert.action {
            GrantAction::RequestMediaAccess | GrantAction::Relaunch => {
                let task = if alert.action == GrantAction::Relaunch {
                    self.permissions.relaunch(cx)
                } else {
                    self.permissions.request(cx, pane)
                };
                self.alert_pending = true;
                cx.notify();
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    if let Err(error) = &result {
                        eprintln!("[videorc-app] Scenes: Screen Recording: {error}");
                    }
                    this.update(cx, |section, cx| {
                        section.alert_pending = false;
                        section.refresh(cx);
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
            GrantAction::OpenSettings => {
                if let Err(error) = self.permissions.open_settings(cx, pane) {
                    eprintln!("[videorc-app] Scenes: Screen Recording: {error}");
                }
            }
        }
    }

    /// The fields (`SceneOnStreamFields`), or none while no scene is on
    /// stream.
    pub(super) fn on_stream_fields(
        &mut self,
        t: &Theme,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view = self.on_stream.clone()?;
        let entity = cx.entity();
        let muted = hsla(t.muted_foreground);
        let platform = Some(node_platform());

        // P318: the header, a nested section's heading.
        let header = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .min_w_0()
            .child(
                div()
                    .id("scene-on-stream-name")
                    .role(Role::Heading)
                    .aria_level(3)
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .min_w_0()
                    .type_scale(text::SECTION)
                    .text_color(hsla(t.foreground))
                    .child(div().flex_none().text_color(muted).child(copy::ON_STREAM))
                    .child(div().min_w_0().truncate().child(view.name.clone())),
            )
            .child(quiet_line(copy::SAVES_HERE, t));

        // P320, P330–P332: Hide screen / Show screen, its key inside it
        // while the row has room, its reason on hover while it can't run.
        let privacy = &view.privacy;
        let mut hide = Button::new("scene-hide-screen")
            .variant(ButtonVariant::Outline)
            .label(privacy.action_label)
            .disabled(privacy.disabled_reason.is_some())
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| entity.update(cx, |section, cx| section.toggle_privacy(cx))
            });
        if self.width >= KEY_IN_BUTTON_PX
            && let Some(accelerator) = &privacy.accelerator
        {
            hide = hide.child(
                div().ml(px(4.)).child(kbd_group(
                    accelerator_display_keys(Some(accelerator.as_str()), platform)
                        .into_iter()
                        .map(Kbd::new),
                )),
            );
        }
        let hide: AnyElement = match privacy.disabled_reason.clone() {
            Some(reason) => div()
                .id("scene-hide-screen-reason")
                .child(hide)
                .tooltip(tooltip(reason))
                .into_any_element(),
            None => hide.tooltip(privacy.action_label).into_any_element(),
        };
        // P321, P333: the chip while it holds; a room's confirmation on hover.
        let chip = privacy.chip.clone().map(|chip| {
            div()
                .id("scene-screen-hidden")
                .child(Badge::new(chip).variant(BadgeVariant::Warning))
                .when_some(privacy.chip_detail.clone(), |chip, detail| {
                    chip.tooltip(tooltip(detail))
                })
                .into_any_element()
        });
        // P323: the capture switch's line and Check again, a stand-in's line.
        let status = view.switch_status.clone().map(|line| {
            div()
                .id("scene-capture-status")
                .role(Role::Status)
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.))
                .type_scale(text::META)
                .text_color(muted)
                .child(line.message)
                .when(line.check_again, |status| {
                    status.child(
                        Button::new("scene-capture-check-again")
                            .variant(ButtonVariant::Outline)
                            .label(live_copy::CHECK_AGAIN)
                            .on_click(
                                cx.listener(|section, _, _, _| section.retry_capture_status()),
                            ),
                    )
                })
        });
        // P324: Screen Recording's alert, in the Sources page's words.
        let alert = self.screen_alert.clone().map(|alert| {
            Alert::new("scene-screen-recording-alert")
                .variant(AlertVariant::Warning)
                .title(alert.alert.title)
                .description(div().child(alert.alert.description))
                .action(
                    Button::new("scene-screen-recording-action")
                        .variant(ButtonVariant::Outline)
                        .label(alert.alert.action_label)
                        .disabled(self.alert_pending)
                        .on_click(cx.listener(|section, _, _, cx| section.run_screen_alert(cx))),
                )
        });
        let screen = field(
            "scene-screen-field",
            copy::SCREEN,
            chip,
            view.screen_words.clone(),
            view.screen_note.clone(),
            hide,
            t,
        )
        .children(status)
        .children(view.stand_in.clone().map(|line| quiet_line(line, t)))
        .children(alert);

        // P325, P326: the studio's layouts (the kit's Select lists words, so
        // the chosen one's diagram stands before it).
        let layout = &view.layout;
        let mut select = Select::new("scene-layout")
            .accessibility_label(copy::LAYOUT)
            .width(LAYOUT_SELECT_PX)
            .value((!layout.freeform).then(|| SharedString::from(layout.preset.clone())))
            .placeholder(layout.trigger.clone())
            .on_change({
                let entity = entity.clone();
                move |value, _, cx| {
                    entity.update(cx, |section, _| section.choose_layout(value.as_ref()))
                }
            });
        // The kit's Select has no disabled option: a layout that is off (or
        // that waits for Change screen…) is left out; the camera's line says
        // why.
        for choice in layout.choices.iter().filter(|choice| {
            choice.value == layout.preset || (!choice.disabled && !choice.asks_for_screen)
        }) {
            select = select.option(choice.value, choice.label.clone());
        }
        let layout_control = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .when(!layout.freeform, |control| {
                control.child(compact_thumb(&layout.preset, layout.fit, t))
            })
            .child(select)
            .into_any_element();
        let layout_field = field(
            "scene-layout-field",
            copy::LAYOUT,
            None,
            layout.description.clone(),
            None,
            layout_control,
            t,
        )
        .children(layout.camera_line.clone().map(|line| quiet_line(line, t)));

        // P327: Fill or Fit.
        let framing = view.framing.map(|framing| {
            let entity = entity.clone();
            framing_row(
                "scene-screen-framing",
                framing,
                None,
                move |fit, cx| {
                    entity.update(cx, |section, _| section.set_framing(framing.vertical, fit))
                },
                t,
            )
        });

        // P328: the scene's 9:16 layout beside a 16:9 studio.
        let vertical = view.vertical_stream.clone().map(|vertical| {
            let read_only = vertical.read_only_reason;
            let mut select = Select::new("scene-vertical-stream-layout")
                .accessibility_label(copy::VERTICAL_STREAM_LAYOUT)
                .width(LAYOUT_SELECT_PX)
                .value(Some(SharedString::from(vertical.preset.clone())))
                .disabled(read_only.is_some())
                .on_change({
                    let entity = entity.clone();
                    let view = vertical.clone();
                    move |value, _, cx| {
                        if let Some(preset) = vertical_stream_pick(&view, value.as_ref()) {
                            entity.update(cx, |section, _| {
                                section.edit_vertical_stream("layoutPreset", preset)
                            });
                        }
                    }
                });
            for choice in vertical.choices.iter().filter(|choice| !choice.disabled) {
                select = select.option(choice.preset, choice.label.clone());
            }
            let control = div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(compact_thumb(&vertical.preset, vertical.fit, t))
                .child(select);
            let control: AnyElement = match read_only {
                Some(reason) => div()
                    .id("scene-vertical-stream-reason")
                    .child(control)
                    .tooltip(tooltip(reason))
                    .into_any_element(),
                None => control.into_any_element(),
            };
            let framing = FramingView {
                fit: vertical.fit,
                line: vertical_framing_line(vertical.fit),
                vertical: true,
            };
            let framing_entity = entity.clone();
            div()
                .mt(px(4.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .border_t_1()
                .border_color(hsla(t.border))
                .pt(px(16.))
                .child(SectionLabel::new(copy::VERTICAL_STREAM))
                .child(
                    field(
                        "scene-vertical-stream-field",
                        copy::LAYOUT,
                        None,
                        vertical.description.clone(),
                        None,
                        control,
                        t,
                    )
                    .children(vertical.reason.clone().map(|reason| quiet_line(reason, t))),
                )
                .child(framing_row(
                    "scene-vertical-stream-framing",
                    framing,
                    read_only,
                    move |fit, cx| {
                        framing_entity.update(cx, |section, _| {
                            section.edit_vertical_stream(
                                "verticalScreenFraming",
                                if fit { FIT } else { FILL },
                            )
                        })
                    },
                    t,
                ))
        });

        // A nested section under the cards: a hairline, 16 px, the heading,
        // then the fields.
        Some(
            div()
                .id("scene-on-stream")
                .mt(px(4.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .border_t_1()
                .border_color(hsla(t.border))
                .pt(px(16.))
                .child(header)
                .child(screen)
                .child(layout_field)
                .children(framing)
                .children(vertical)
                .into_any_element(),
        )
    }
}
