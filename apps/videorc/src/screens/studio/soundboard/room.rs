//! Room sounds and room audio routing under the Soundboard
//! (`room-sounds.tsx`, `room-audio-routing.tsx`).

use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use videorc_app_core::soundboard::{RoomAudioRouting, RoomAux, SystemAudio, copy as words};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::SoundboardSection;

/// System / program gain slider entities the section owns.
pub struct RoomSliders {
    pub system_gain: Entity<SliderState>,
    pub speech_gain: Entity<SliderState>,
    pub auxiliary_gain: Entity<SliderState>,
}

impl RoomSliders {
    pub fn new(cx: &mut Context<SoundboardSection>) -> Self {
        let system_gain = cx.new(|_| {
            SliderState::new()
                .min(SystemAudio::GAIN_MIN as f32)
                .max(SystemAudio::GAIN_MAX as f32)
                .step(1.)
                .default_value(0.)
        });
        let speech_gain = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(1.)
                .step(0.01)
                .default_value(1.)
        });
        let auxiliary_gain = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(1.)
                .step(0.01)
                .default_value(1.)
        });
        Self {
            system_gain,
            speech_gain,
            auxiliary_gain,
        }
    }
}

/// `RoomSounds` + `RoomAudioRoutingControls` when the room is open.
pub fn render(
    aux: &RoomAux,
    routing: &RoomAudioRouting,
    sliders: &RoomSliders,
    entity: gpui::WeakEntity<SoundboardSection>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let status = aux.status_line();
    let toggle = aux.toggle_label();
    let toggle_entity = entity.clone();

    let system_dev = cfg!(debug_assertions);
    let system_status = routing.system_status_line();
    let share_label = routing.system_share_label();
    let share_entity = entity.clone();
    let mute_sys = routing.system_mute_label();
    let mute_sys_entity = entity.clone();
    let mute_speech = routing.speech_mute_label();
    let mute_speech_entity = entity.clone();
    let mute_aux = routing.auxiliary_mute_label();
    let mute_aux_entity = entity.clone();
    let system_gain_label = routing.system_gain_label();
    let speech_gain_label = routing.speech_gain_label();
    let aux_gain_label = routing.auxiliary_gain_label();
    let footnote = routing.program_footnote();

    div()
        .id("room-sounds")
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(words::ROOM_SOUNDS_LABEL),
                )
                .child(
                    div()
                        .id("room-sounds-status")
                        .role(gpui::Role::Status)
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(status),
                )
                .child(
                    Button::new("room-sounds-toggle")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(toggle)
                        .on_click(move |_, _, cx| {
                            let _ = toggle_entity
                                .update(cx, |section, cx| section.toggle_room_sounds(cx));
                        }),
                ),
        )
        .child(
            div()
                .id("room-audio-routing")
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .type_scale(text::LABEL)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(words::SYSTEM_AUDIO_LABEL),
                        )
                        .child(
                            div()
                                .id("room-system-status")
                                .role(gpui::Role::Status)
                                .type_scale(text::META)
                                .text_color(muted)
                                .child(system_status),
                        )
                        .child(
                            Button::new("room-system-share")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(share_label)
                                .disabled(!system_dev)
                                .on_click(move |_, _, cx| {
                                    let _ = share_entity
                                        .update(cx, |section, cx| section.toggle_system_share(cx));
                                }),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(system_gain_label),
                        )
                        .child(Slider::new(&sliders.system_gain).accessibility_label("System gain"))
                        .child(
                            Button::new("room-system-mute")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(mute_sys)
                                .on_click(move |_, _, cx| {
                                    let _ = mute_sys_entity
                                        .update(cx, |section, cx| section.toggle_system_mute(cx));
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .type_scale(text::META)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(speech_gain_label),
                        )
                        .child(
                            Slider::new(&sliders.speech_gain)
                                .accessibility_label("Program speech gain"),
                        )
                        .child(
                            Button::new("room-speech-mute")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(mute_speech)
                                .on_click(move |_, _, cx| {
                                    let _ = mute_speech_entity
                                        .update(cx, |section, cx| section.toggle_speech_mute(cx));
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .type_scale(text::META)
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(aux_gain_label),
                        )
                        .child(
                            Slider::new(&sliders.auxiliary_gain)
                                .accessibility_label("Program auxiliary gain"),
                        )
                        .child(
                            Button::new("room-aux-mute")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(mute_aux)
                                .on_click(move |_, _, cx| {
                                    let _ = mute_aux_entity.update(cx, |section, cx| {
                                        section.toggle_auxiliary_mute(cx)
                                    });
                                }),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(muted)
                                .child(footnote),
                        ),
                ),
        )
        .into_any_element()
}

/// Wire slider changes back into the section.
pub fn subscribe(sliders: &RoomSliders, cx: &mut Context<SoundboardSection>) {
    cx.subscribe(&sliders.system_gain, |this, _, event: &SliderEvent, cx| {
        let value = match event {
            SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
        };
        this.set_system_gain(value.round() as i32, cx);
    })
    .detach();
    cx.subscribe(&sliders.speech_gain, |this, _, event: &SliderEvent, cx| {
        let value = match event {
            SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
        };
        this.set_speech_gain(value, cx);
    })
    .detach();
    cx.subscribe(
        &sliders.auxiliary_gain,
        |this, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            this.set_auxiliary_gain(value, cx);
        },
    )
    .detach();
}
