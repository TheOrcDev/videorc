//! Sound pads for Studio → Soundboard.
//!
//! KIT PLACEHOLDER: audiocn's `SoundPad` / `SoundPadGrid` are not in
//! `videorc-kit` yet (requested under Kit in plan 260 `queues.md`). Until
//! they land, each pad is an Outline button with its name, optional key
//! chip, and a playing ring via border colour. Progress for non-loop voices
//! is omitted (the kit pad owns that).

use gpui::{AnyElement, SharedString, Window, div, prelude::*, px};
use videorc_app_core::protocol::{Sound, SoundMode, SoundVoice};
use videorc_app_core::soundboard::{self, press_stops};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::kbd::Kbd;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{radius, text};

/// Most pads in a row (`SoundPadBoard columns={6}`).
pub const COLUMNS: usize = 6;
/// Minimum pad width so six columns still read on a narrow pane.
const PAD_MIN_PX: f32 = 88.;
const PAD_GAP_PX: f32 = 8.;

/// How many columns fit in `width`.
pub fn columns(width: f32) -> usize {
    if width <= PAD_MIN_PX {
        return 1;
    }
    (((width + PAD_GAP_PX) / (PAD_MIN_PX + PAD_GAP_PX)).floor() as usize).clamp(1, COLUMNS)
}

/// Six-column (or fewer) pad grid.
pub fn grid(
    sounds: &[Sound],
    voices: &std::collections::BTreeMap<String, SoundVoice>,
    width: f32,
    disabled: bool,
    entity: gpui::WeakEntity<super::SoundboardSection>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let cols = columns(width);
    let pad_w = ((width - PAD_GAP_PX * (cols.saturating_sub(1)) as f32) / cols as f32)
        .floor()
        .max(PAD_MIN_PX);
    let mut row = div()
        .id("sound-pad-board")
        .flex()
        .flex_wrap()
        .gap(px(PAD_GAP_PX))
        .w_full();
    for sound in sounds {
        let playing = voices.contains_key(&sound.id);
        let stops = press_stops(sound.mode, playing);
        let click_stops = stops || (playing && sound.mode == SoundMode::Hold);
        let label = soundboard::pad_label(&sound.name, click_stops || stops);
        let border = if playing {
            hsla(theme.foreground)
        } else {
            hsla(theme.border)
        };
        let play_entity = entity.clone();
        let stop_entity = entity.clone();
        let play_id = sound.id.clone();
        let stop_id = sound.id.clone();
        let mut button = Button::new(("sound-pad", sound.id.clone()))
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .disabled(disabled)
            .tooltip(label.clone())
            .accessibility_label(label)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(4.))
                    .w_full()
                    .child(
                        div()
                            .w_full()
                            .overflow_hidden()
                            .type_scale(text::META)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(SharedString::from(sound.name.clone())),
                    )
                    .when_some(sound.hotkey.clone(), |el, key| el.child(Kbd::new(key))),
            );
        if click_stops {
            button = button.on_click(move |_, _, cx| {
                let _ = stop_entity.update(cx, |section, cx| section.stop(stop_id.clone(), cx));
            });
        } else {
            button = button.on_click(move |_, _, cx| {
                let _ = play_entity.update(cx, |section, cx| section.play(play_id.clone(), cx));
            });
        }
        row = row.child(
            div()
                .id(("sound-pad-wrap", sound.id.clone()))
                .flex_grow()
                .flex_shrink_0()
                .min_w(px(PAD_MIN_PX))
                .w(px(pad_w))
                // PLACEHOLDER chrome for the missing SoundPad playing ring.
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(border)
                .when(playing, |el| el.border_2())
                .child(button),
        );
    }
    row.into_any_element()
}
