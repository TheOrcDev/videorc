//! The Studio Audio section's segmented level meter (`level-meter.tsx`):
//! 24 segments on −60…0 dB, amber from −20, red from −9, with a held peak.

use gpui::{IntoElement, SharedString, div, prelude::*, px};
use videorc_app_core::studio::audio_mixer::{
    LcdMeterView, METER_SEGMENTS, MeterView, segment_zone,
};
use videorc_kit::theme::{TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};

/// One Mixer-scale meter from [`MeterView`].
pub fn segmented_meter(meter: MeterView, muted: bool, theme: &Theme) -> impl IntoElement {
    let track = hsla(theme.border);
    let ok = hsla(theme.success);
    let warn = hsla(theme.warning);
    let clip = hsla(theme.destructive);
    let hold = hsla(theme.muted_foreground);
    let mut row = div()
        .w_full()
        .h(px(8.))
        .flex()
        .items_center()
        .gap(px(1.))
        .opacity(if muted { 0.5 } else { 1.0 });
    for index in 0..METER_SEGMENTS {
        let lit = index < meter.lit;
        let is_hold = meter.hold > 0 && index + 1 == meter.hold;
        let color = if is_hold && !lit {
            hold
        } else if lit {
            match segment_zone(index) {
                "clip" => clip,
                "warn" => warn,
                _ => ok,
            }
        } else {
            track
        };
        row = row.child(div().flex_1().h_full().rounded(px(1.)).bg(color));
    }
    row
}

/// Retro LCD meter: segments plus the readout digits and CLIP flag.
pub fn lcd_meter(
    meter: MeterView,
    lcd: &LcdMeterView,
    muted: bool,
    theme: &Theme,
) -> impl IntoElement {
    let lit_ink = hsla(theme.foreground);
    let dim_ink = hsla(theme.muted_foreground);
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .opacity(if muted { 0.5 } else { 1.0 })
        .child(segmented_meter(meter, false, theme))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .type_scale(text::META)
                .child(div().text_color(lit_ink).child(lcd.readout.clone()))
                .child(
                    div()
                        .text_color(if lcd.clipping { lit_ink } else { dim_ink })
                        .child(if lcd.clipping {
                            SharedString::from("CLIP")
                        } else {
                            SharedString::from("clip")
                        }),
                ),
        )
}

/// A quiet secondary line under a meter or picker.
pub fn meta_line(theme: &Theme, text_value: impl Into<SharedString>) -> impl IntoElement {
    div()
        .type_scale(text::META)
        .text_color(hsla(theme.muted_foreground))
        .child(text_value.into())
}
