//! The Studio Audio section's segmented level meter (`level-meter.tsx`):
//! 24 segments on −60…0 dB, amber from −20, red from −9, with a held peak.

use gpui::{IntoElement, SharedString, div, prelude::*, px};
use videorc_app_core::studio::audio_mixer::{
    LcdMeterView, METER_SEGMENTS, MeterView, segment_zone,
};
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};

/// One Mixer-scale meter from [`MeterView`] (`LevelMeter variant="segmented"`):
/// a `bg-muted` 8 px track with full rounding; every segment shows its zone
/// (`--meter-ok`, `--meter-warn`, `--meter-clip`) at 20 % at rest and in
/// full where the level reaches, with 2 px between segments.
pub fn segmented_meter(meter: MeterView, muted: bool, theme: &Theme) -> impl IntoElement {
    let zone = |index: u8| match segment_zone(index) {
        "clip" => theme.meter_clip,
        "warn" => theme.meter_warn,
        _ => theme.meter_ok,
    };
    let hold = hsla(with_alpha(theme.foreground, 0.8));
    let mut row = div()
        .w_full()
        .h(px(8.))
        .flex()
        .items_center()
        .gap(px(2.))
        .rounded_full()
        .overflow_hidden()
        .bg(hsla(theme.muted))
        .opacity(if muted { 0.5 } else { 1.0 });
    for index in 0..METER_SEGMENTS {
        let lit = index < meter.lit;
        let is_hold = meter.hold > 0 && index + 1 == meter.hold;
        let color = if is_hold && !lit {
            hold
        } else if lit {
            hsla(zone(index))
        } else {
            hsla(with_alpha(zone(index), 0.2))
        };
        row = row.child(div().flex_1().h_full().bg(color));
    }
    row
}

/// Retro LCD meter (`LcdMeter`'s grid, `lcd-meter.tsx`): the track with its
/// readout at its end (`LcdMeterValue`, column 3), and under the readout the
/// CLIP flag, right-aligned (`LcdMeterClip`: `col-start-3 self-end
/// justify-self-end`). Everything is in the screen's ink: block segments lit
/// where the level reaches and dim at rest, never the default look's amber
/// and red zones (`LcdMeterBar`); the screen's dot mask draws them as dots.
pub fn lcd_meter(
    meter: MeterView,
    lcd: &LcdMeterView,
    muted: bool,
    theme: &Theme,
) -> impl IntoElement {
    let lit_ink = crate::lcd::lit(theme);
    // The flag is an unlit ghost (`--lcd-meter-unlit`) that inverts while
    // the clip hold is on (`data-clipping:bg-(--lcd-display-lit)
    // text-(--lcd-display-glass)`).
    let unlit_ink = hsla(with_alpha(theme.primary, 0.15));
    let clip = div()
        .px(px(4.))
        .py(px(2.))
        .rounded(px(radius::CHIP))
        .map(|flag| {
            if lcd.clipping {
                flag.bg(lit_ink).text_color(crate::lcd::solid(theme))
            } else {
                flag.text_color(unlit_ink)
            }
        })
        .child(SharedString::from("CLIP"));
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .opacity(if muted { 0.5 } else { 1.0 })
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().flex_1().min_w_0().child(lcd_track(meter, theme)))
                .child(
                    div()
                        .flex_none()
                        .type_scale(text::META)
                        .text_color(lit_ink)
                        .child(lcd.readout.clone()),
                ),
        )
        .child(
            div()
                .flex()
                .justify_end()
                .type_scale(text::META)
                .child(clip),
        )
}

/// `LcdMeterTrack` + `LcdMeterBar` + `LcdMeterHold`: square block segments
/// in the display's ink, lit up to the level and at the held peak, dim at
/// rest. No track fill and no rounding: the screen is the track.
fn lcd_track(meter: MeterView, theme: &Theme) -> impl IntoElement {
    let (lit_ink, dim_ink) = (crate::lcd::lit(theme), crate::lcd::dim(theme));
    let mut row = div().w_full().h(px(10.)).flex().items_center().gap(px(2.));
    for index in 0..METER_SEGMENTS {
        let held = meter.hold > 0 && index + 1 == meter.hold;
        let ink = if index < meter.lit || held {
            lit_ink
        } else {
            dim_ink
        };
        row = row.child(div().flex_1().h_full().bg(ink));
    }
    row
}

/// A quiet secondary line under a meter or picker.
pub fn meta_line(theme: &Theme, text_value: impl Into<SharedString>) -> impl IntoElement {
    div()
        .type_scale(text::META)
        .text_color(hsla(theme.muted_foreground))
        .child(text_value.into())
}
