//! The stats bar (P945–P951): session chip and the Clock / Viewers /
//! Followers cells. Sparklines and drag reorder wait on later slices.

use gpui::{AnyElement, FontWeight, IntoElement, div, prelude::*, px};
use videorc_app_core::stream_manager::copy::{
    HISTORY_CHIP, ON_AIR_CHIP, RECORDING_CHIP, STATS_REGION,
};
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    theme::hsla,
    tokens::Theme,
};

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

/// The six stat cells, left to right as Electron orders them by default.
const CELLS: [&str; 6] = [
    "Clock",
    "Viewers",
    "Followers",
    "Subs and members",
    "Tips",
    "Chat pace",
];

/// The bar under the header.
pub fn stats_bar(t: &Theme, chip: SessionChip) -> AnyElement {
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
        .children(CELLS.into_iter().map(|label| {
            div()
                .flex()
                .flex_col()
                .justify_center()
                .min_w(px(0.))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(hsla(t.muted_foreground))
                        .child(label),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child("–"),
                )
        }))
        .into_any_element()
}
