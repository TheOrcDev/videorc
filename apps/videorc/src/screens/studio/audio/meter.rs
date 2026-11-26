//! The Studio Audio section's segmented level meter (`level-meter.tsx`):
//! 24 segments on −60…0 dB, amber from −20, red from −9, with a held peak.

use gpui::{IntoElement, SharedString, div, prelude::*, px};
use videorc_app_core::studio::audio_mixer::{METER_SEGMENTS, MeterView, segment_zone};
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, text};

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

/// A quiet secondary line under a meter or picker.
pub fn meta_line(theme: &Theme, text_value: impl Into<SharedString>) -> impl IntoElement {
    div()
        .type_scale(text::META)
        .text_color(hsla(theme.muted_foreground))
        .child(text_value.into())
}
