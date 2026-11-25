use super::*;
use gpui::{SharedString, div, px};
use videorc_app_core::library::copy;
use videorc_kit::{
    alert::Alert,
    button::{Button, ButtonSize, ButtonVariant},
    dialog::{Dialog, DialogSize},
    dropdown_menu::DropdownMenu,
    empty::Empty,
    input::Input,
    kebab_menu::{KebabMenuItem, kebab_menu},
    list_row::{GroupedList, ListRow},
    slider::Slider,
    theme::{self, TypeScale, hsla},
    tokens::text,
};
impl Player {
    fn pins(
        &self,
        pins: Vec<p::PinView>,
        cx: &Context<Self>,
        ink: videorc_kit::tokens::Color,
    ) -> gpui::AnyElement {
        let width = f64::from(self.slider.read(cx).bounds().size.width).max(p::PLAYHEAD_THUMB_PX);
        let mut timeline = div()
            .id("marker-timeline")
            .role(gpui::Role::Group)
            .aria_label(p::MARKER_TIMELINE)
            .relative()
            .h(px(24.))
            .w_full();
        for pin in pins {
            let left = p::marker_pin_centre_px(pin.fraction, width) - 12.;
            let tick = div()
                .h(px(12.))
                .w(px(if pin.several { 4. } else { 2. }))
                .rounded_full()
                .bg(hsla(ink));
            let button = Button::new(SharedString::from(format!("pin-{}", pin.id)))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::IconXs)
                .accessibility_label(pin.label)
                .tooltip(pin.tooltip)
                .child(tick);
            let content = if pin.several {
                let items = pin
                    .entries
                    .into_iter()
                    .map(|(id, time, name)| {
                        let weak = cx.entity().downgrade();
                        let target = id.clone();
                        KebabMenuItem::new(id, format!("{time} · {name}"), move |_, cx| {
                            let _ = weak.update(cx, |this, cx| this.select_marker(&target, cx));
                        })
                    })
                    .collect::<Vec<_>>();
                DropdownMenu::new(SharedString::from(format!("pin-menu-{}", pin.id)))
                    .trigger(button)
                    .menu(move |_, _| kebab_menu(&items))
                    .into_any_element()
            } else {
                let id = pin.id;
                button
                    .on_click(cx.listener(move |this, _, _, cx| this.select_marker(&id, cx)))
                    .into_any_element()
            };
            timeline = timeline.child(
                div()
                    .absolute()
                    .top_0()
                    .left(px(left as f32))
                    .child(content),
            );
        }
        timeline.into_any_element()
    }
    fn keys(&mut self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Only the video slot's focus owns player keys. Child buttons,
        // editable marker titles and the slider keep their own keys.
        if !self.focus.is_focused(window) {
            return;
        }
        let key = match event.keystroke.key.as_str() {
            "space" => " ",
            "left" => "ArrowLeft",
            "right" => "ArrowRight",
            "home" => "Home",
            "end" => "End",
            other => other,
        };
        let m = event.keystroke.modifiers;
        let Some(action) = p::player_key_action(
            key,
            p::PlayerKeyTarget::default(),
            m.platform || m.control || m.alt,
        ) else {
            return;
        };
        if let Some(ms) = p::player_key_target_ms(
            action,
            self.status.position_ms as f64,
            self.status.duration_ms as f64,
        ) {
            self.seek(ms);
        } else {
            match action {
                p::PlayerKeyAction::Toggle => self.toggle(),
                p::PlayerKeyAction::Mute => self.mute(),
                _ => {}
            }
        }
        cx.stop_propagation();
    }
}
impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let marker_view = self.markers.as_ref().map(|m| {
            m.view(
                &self.core.data().sessions,
                &self.studio.snapshot().session.status,
                self.core.data().online,
            )
        });
        let title = marker_view
            .as_ref()
            .map(|v| v.title.clone())
            .unwrap_or_else(|| p::RECORDING_PLAYER.into());
        let markers = self
            .markers
            .as_ref()
            .map(|m| m.markers.as_slice())
            .unwrap_or(&[]);
        let view = p::player_view(&p::PlayerInput {
            status: &self.status,
            connected: self.connected,
            markers,
            scrub_ms: self.scrub,
            track_width_px: f64::from(self.slider.read(cx).bounds().size.width),
            // Every platform plays now: macOS natively, Windows and Linux
            // from the backend's playback ring.
            available: true,
        });
        if self.scrub.is_none() {
            let percent = if self.status.duration_ms > 0 {
                100. * self.status.position_ms as f32 / self.status.duration_ms as f32
            } else {
                0.
            };
            if self.slider.read(cx).value() != SliderValue::Single(percent) {
                self.slider
                    .update(cx, |state, cx| state.set_value(percent, window, cx));
            }
        }
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .type_scale(text::LABEL)
            .text_color(hsla(t.foreground));
        if self.active {
            let slot = self.slot(cx);
            body = body.child(
                div()
                    .id("recording-player-video")
                    .role(gpui::Role::Group)
                    .aria_label(p::RECORDING_PLAYER)
                    .track_focus(&self.focus)
                    .on_key_down(cx.listener(Self::keys))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|this, _, window, cx| this.focus.focus(window, cx)),
                    )
                    .child(slot),
            );
        }
        if let Some(line) = marker_view.as_ref().and_then(|v| v.line) {
            body = body.child(Alert::new("player-no-video").title(line));
        } else if let Some(error) = &self.error {
            body = body.child(
                Alert::new("player-error").title(error.clone()).action(
                    Button::new("player-retry-error")
                        .label(p::TRY_AGAIN)
                        .on_click(cx.listener(|this, _, window, cx| this.retry(window, cx))),
                ),
            );
        } else if view.loading {
            body = body.child(
                videorc_kit::spinner::Spinner::new("player-loading")
                    .accessibility_label(p::LOADING_RECORDING),
            );
        } else if !view.status_title.is_empty() {
            body = body.child(
                Alert::new("player-status")
                    .title(view.status_title)
                    .description(view.status_description),
            );
        }
        let mut controls = div()
            .flex()
            .gap(px(8.))
            .items_center()
            .child(
                Button::new("player-toggle")
                    .label(view.toggle_label)
                    .disabled(!view.ready)
                    .tooltip(if view.ready {
                        view.toggle_label
                    } else {
                        p::LOADING_RECORDING
                    })
                    .on_click(cx.listener(|this, _, _, _| this.toggle())),
            )
            .child(view.position_text)
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        Slider::new(&self.slider)
                            .disabled(!view.ready)
                            .accessibility_label(format!(
                                "{}: {}",
                                p::PLAYHEAD,
                                view.playhead_value
                            )),
                    )
                    .child(self.pins(view.pins, cx, t.foreground)),
            )
            .child(view.duration_text)
            .child(
                Button::new("player-mute")
                    .label(view.mute_label)
                    .disabled(!view.ready)
                    .on_click(cx.listener(|this, _, _, _| this.mute())),
            );
        if view.retry {
            controls = controls.child(
                Button::new("player-retry")
                    .label(p::TRY_AGAIN)
                    .on_click(cx.listener(|this, _, window, cx| this.retry(window, cx))),
            );
        }
        body = body.child(controls);
        if let Some(view) = marker_view {
            let mut list = GroupedList::new().label(copy::SAVED_MARKERS);
            for row in view.rows {
                let id = row.id.clone();
                let mut line = ListRow::new(SharedString::from(format!("marker-{id}")), row.name)
                    .context(row.context)
                    .meta(row.time)
                    .selected(row.selected);
                if row.editing {
                    line = line
                        .child(
                            Input::new("marker-title", &self.input)
                                .accessibility_label(copy::MARKER_TITLE_LABEL),
                        )
                        .child(
                            Button::new("marker-save")
                                .label(copy::SAVE)
                                .disabled(!view.save_enabled)
                                .on_click(cx.listener(|this, _, _, cx| this.rename_marker(cx))),
                        )
                        .child(Button::new("marker-cancel").label(copy::CANCEL).on_click(
                            cx.listener(|this, _, _, cx| {
                                if let Some(markers) = this.markers.as_mut() {
                                    markers.editing = None;
                                }
                                cx.notify();
                            }),
                        ));
                } else {
                    let edit = id.clone();
                    let delete = id.clone();
                    let deleting = self.deleting.contains_key(&id);
                    line = line
                        .child(
                            Button::new(SharedString::from(format!("marker-edit-{id}")))
                                .label(copy::RENAME_ELLIPSIS)
                                .accessibility_label(row.rename_label)
                                .disabled(!view.actions_enabled || deleting)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.edit_marker(&edit, window, cx)
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("marker-delete-{id}")))
                                .label(copy::DELETE)
                                .accessibility_label(row.delete_label)
                                .disabled(!view.actions_enabled || deleting)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.remove_marker(&delete, cx)
                                })),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.select_marker(&id, cx)));
                }
                list = list.row(line);
            }
            body = body.child(list);
            if view.loading_line {
                body = body.child(
                    videorc_kit::spinner::Spinner::new("markers-loading")
                        .accessibility_label(copy::LOADING_MARKERS),
                );
            }
            if view.empty {
                body = body.child(
                    Empty::new()
                        .title(copy::NO_MARKERS_TITLE)
                        .description(copy::NO_MARKERS_DESCRIPTION),
                );
            }
            if let Some((title, detail)) = view.failure {
                body =
                    body.child(
                        Alert::new("markers-error")
                            .title(title)
                            .description(detail)
                            .action(Button::new("markers-retry").label(p::TRY_AGAIN).on_click(
                                cx.listener(|this, _, _, cx| this.load_markers(false, cx)),
                            )),
                    );
            }
            if let Some(label) = view.load_more {
                body = body.child(
                    Button::new("markers-more")
                        .label(label)
                        .disabled(!view.load_more_enabled)
                        .on_click(cx.listener(|this, _, _, cx| this.load_markers(true, cx))),
                );
            }
        }
        let weak = cx.entity().downgrade();
        Dialog::new("recording-player", &self.dialog, title)
            .description(copy::MARKERS_DESCRIPTION)
            .size(DialogSize::Xl)
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let weak = weak.clone();
                    cx.defer(move |cx| {
                        let _ = weak.update(cx, |this, cx| this.stop_playback(cx));
                    });
                }
            })
            .child(body)
            .footer(
                Button::new("player-external")
                    .label(p::OPEN_IN_DEFAULT_PLAYER)
                    .on_click(cx.listener(|this, _, _, cx| this.external(false, cx))),
            )
            .footer(
                Button::new("player-reveal")
                    .label(videorc_app_core::library::page::reveal_in_file_manager_label())
                    .on_click(cx.listener(|this, _, _, cx| this.external(true, cx))),
            )
            .footer(
                Button::new("player-close")
                    .label("Close")
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
            )
    }
}
