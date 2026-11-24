//! The stats bar (P945–P951): session chip, Clock / Viewers / Followers
//! cells, and Wide-only sparklines. Drag reorder waits on a later slice.

use gpui::{AnyElement, FontWeight, IntoElement, div, prelude::*, px};
use videorc_app_core::stream_manager::copy::{
    HISTORY_CHIP, ON_AIR_CHIP, RECORDING_CHIP, STATS_REGION,
};
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    theme::hsla,
    tokens::Theme,
};

use super::layout::WIDE_MIN;

/// The session chip Electron's stats bar shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionChip {
    #[default]
    OffAir,
    OnAir,
    Recording,
    History,
}

impl SessionChip {
    fn words(self) -> Option<&'static str> {
        match self {
            Self::OffAir => None,
            Self::OnAir => Some(ON_AIR_CHIP),
            Self::Recording => Some(RECORDING_CHIP),
            Self::History => Some(HISTORY_CHIP),
        }
    }

    fn badge(self) -> BadgeVariant {
        match self {
            Self::OnAir => BadgeVariant::Live,
            _ => BadgeVariant::Default,
        }
    }
}

/// One stats cell: label, value, optional Wide sparkline.
#[derive(Clone, Debug)]
pub struct StatCell {
    pub label: &'static str,
    pub value: String,
    pub spark: Vec<f32>,
}

impl StatCell {
    fn shell() -> [StatCell; 6] {
        [
            StatCell {
                label: "Clock",
                value: "–".into(),
                spark: Vec::new(),
            },
            StatCell {
                label: "Viewers",
                value: "12".into(),
                spark: vec![4., 6., 5., 9., 8., 12., 11., 14., 12.],
            },
            StatCell {
                label: "Followers",
                value: "–".into(),
                spark: Vec::new(),
            },
            StatCell {
                label: "Subs and members",
                value: "–".into(),
                spark: Vec::new(),
            },
            StatCell {
                label: "Tips",
                value: "–".into(),
                spark: Vec::new(),
            },
            StatCell {
                label: "Chat pace",
                value: "–".into(),
                spark: vec![1., 2., 1., 3., 2., 4., 3.],
            },
        ]
    }
}

/// A 48×16 bar sparkline (Wide only). Needs ≥2 points.
fn sparkline(points: &[f32], ink: gpui::Hsla) -> Option<AnyElement> {
    if points.len() < 2 {
        return None;
    }
    let min = points.iter().cloned().fold(f32::INFINITY, f32::min);
    let max = points.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let span = (max - min).max(1.0);
    let bars = points.iter().map(move |value| {
        let t = (value - min) / span;
        let height = (2.0 + t * 14.0).round();
        div()
            .w(px(3.))
            .h(px(height))
            .rounded(px(1.))
            .bg(ink)
            .into_any_element()
    });
    Some(
        div()
            .id("sparkline")
            .flex_none()
            .w(px(48.))
            .h(px(16.))
            .flex()
            .items_end()
            .gap(px(1.))
            .children(bars)
            .into_any_element(),
    )
}

/// The bar under the header.
pub fn stats_bar(t: &Theme, chip: SessionChip, width: f32) -> AnyElement {
    let wide = width >= WIDE_MIN;
    let muted = hsla(t.muted_foreground);
    let cells = StatCell::shell();
    div()
        .id("stream-stats")
        .flex_none()
        .w_full()
        .h(px(40.))
        .px(px(12.))
        .flex()
        .items_center()
        .gap(px(12.))
        .border_b_1()
        .border_color(hsla(t.border))
        .aria_label(STATS_REGION)
        .when_some(chip.words(), |bar, words| {
            bar.child(Badge::new(words).variant(chip.badge()))
        })
        .children(cells.into_iter().map(move |cell| {
            let spark = if wide {
                sparkline(&cell.spark, muted)
            } else {
                None
            };
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w(px(0.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .min_w(px(0.))
                        .child(div().text_size(px(11.)).text_color(muted).child(cell.label))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .child(cell.value),
                        ),
                )
                .children(spark)
        }))
        .into_any_element()
}
