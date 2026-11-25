//! The stats bar (P945–P951): session chip, Clock / Viewers / Followers
//! cells from [`LiveDashboard`], and Wide-only sparklines.

use gpui::{AnyElement, FontWeight, IntoElement, div, prelude::*, px};
use videorc_app_core::stream_manager::copy::{
    HISTORY_CHIP, ON_AIR_CHIP, RECORDING_CHIP, STATS_REGION,
};
use videorc_app_core::stream_manager::dashboard::{LiveDashboard, SessionChatTotals, SessionState};
use videorc_app_core::stream_manager::format::{group_thousands, parse_time};
use videorc_app_core::studio::timecode::format_timecode;
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
    fn from_session(session: SessionState) -> Self {
        match session {
            SessionState::OffAir => Self::OffAir,
            SessionState::Live => Self::OnAir,
            SessionState::Recording => Self::Recording,
        }
    }

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
#[derive(Clone, Debug, PartialEq)]
pub struct StatCell {
    pub label: &'static str,
    pub value: String,
    pub spark: Vec<f32>,
}

/// What the stats bar reads from the live dashboard.
#[derive(Clone, Debug, PartialEq)]
pub struct StatsView {
    pub chip: SessionChip,
    pub cells: [StatCell; 6],
}

impl Default for StatsView {
    fn default() -> Self {
        Self::from_dashboard(
            &LiveDashboard::default(),
            chrono::Utc::now().timestamp_millis(),
        )
    }
}

impl StatsView {
    /// Map the core's [`LiveDashboard`] at `now_ms` (for the ON AIR clock).
    pub fn from_dashboard(board: &LiveDashboard, now_ms: i64) -> Self {
        let chip = SessionChip::from_session(board.session);
        let clock = clock_value(board, now_ms);
        let (viewers, viewer_spark) = viewers_value(board);
        let followers = followers_value(board);
        let subs = subs_value(board);
        let tips = tips_value(board);
        let (pace, pace_spark) = chat_pace_value(board);
        Self {
            chip,
            cells: [
                StatCell {
                    label: "Clock",
                    value: clock,
                    spark: Vec::new(),
                },
                StatCell {
                    label: "Viewers",
                    value: viewers,
                    spark: viewer_spark,
                },
                StatCell {
                    label: "Followers",
                    value: followers,
                    spark: Vec::new(),
                },
                StatCell {
                    label: "Subs and members",
                    value: subs,
                    spark: Vec::new(),
                },
                StatCell {
                    label: "Tips",
                    value: tips,
                    spark: Vec::new(),
                },
                StatCell {
                    label: "Chat pace",
                    value: pace,
                    spark: pace_spark,
                },
            ],
        }
    }
}

fn clock_value(board: &LiveDashboard, now_ms: i64) -> String {
    let Some(started) = board.started_at.as_deref().and_then(parse_time) else {
        return "–".into();
    };
    if matches!(board.session, SessionState::OffAir) {
        return "–".into();
    }
    let elapsed = now_ms - started.timestamp_millis();
    format_timecode(elapsed.max(0))
}

fn viewers_value(board: &LiveDashboard) -> (String, Vec<f32>) {
    let spark: Vec<f32> = board
        .viewer_history
        .iter()
        .map(|(_, total)| *total as f32)
        .collect();
    let value = match &board.latest_viewers {
        Some(sample) => group_thousands(sample.total as i64),
        None if matches!(board.session, SessionState::Live) => "–".into(),
        None => "–".into(),
    };
    (value, spark)
}

fn followers_value(board: &LiveDashboard) -> String {
    let Some(audience) = &board.audience else {
        return "–".into();
    };
    let delta: i64 = audience
        .platforms
        .iter()
        .filter(|p| p.metric == "followers")
        .filter_map(|p| p.delta)
        .sum();
    if delta == 0 && audience.platforms.iter().all(|p| p.delta.is_none()) {
        return "–".into();
    }
    if delta > 0 {
        format!("+{}", group_thousands(delta))
    } else if delta < 0 {
        format!("−{}", group_thousands(-delta))
    } else {
        "0".into()
    }
}

fn subs_value(board: &LiveDashboard) -> String {
    let Some(audience) = &board.audience else {
        return "–".into();
    };
    let total: u64 = audience
        .platforms
        .iter()
        .filter_map(|p| {
            p.subscribers
                .or(p.total.filter(|_| p.metric == "subscribers"))
        })
        .sum();
    if total == 0 {
        "–".into()
    } else {
        group_thousands(total as i64)
    }
}

fn tips_value(board: &LiveDashboard) -> String {
    match &board.chat_totals {
        Some(SessionChatTotals::Available { tips, .. }) if !tips.is_empty() => {
            let micros: u64 = tips.iter().map(|t| t.amount_micros).sum();
            let amount = micros as f64 / 1_000_000.0;
            if micros % 1_000_000 == 0 {
                format!("${}", group_thousands(amount as i64))
            } else {
                format!("${amount:.2}")
            }
        }
        _ => "–".into(),
    }
}

fn chat_pace_value(board: &LiveDashboard) -> (String, Vec<f32>) {
    match &board.chat_totals {
        Some(SessionChatTotals::Available { message_count, .. }) => {
            (group_thousands(*message_count as i64), Vec::new())
        }
        _ => ("–".into(), Vec::new()),
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
pub fn stats_bar(t: &Theme, view: &StatsView, width: f32) -> AnyElement {
    let wide = width >= WIDE_MIN;
    let muted = hsla(t.muted_foreground);
    let chip = view.chip;
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
        .children(view.cells.clone().into_iter().map(move |cell| {
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
