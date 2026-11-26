//! The stats bar (P945–P951): session chip, Clock / Viewers / Followers
//! cells from [`LiveDashboard`], Wide-only sparklines, drag-reorder, and
//! Hide screen's chip at the trailing edge (P950).

use gpui::{
    AnyElement, App, Context, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px,
};
use videorc_app_core::stream_manager::copy::{
    HISTORY_CHIP, ON_AIR_CHIP, RECORDING_CHIP, STATS_REGION,
};
use videorc_app_core::stream_manager::dashboard::{LiveDashboard, SessionChatTotals, SessionState};
use videorc_app_core::stream_manager::format::{group_thousands, parse_time};
use videorc_app_core::studio::families::{
    DEFAULT_STAT_ORDER, StatsLayout, arranged_stat_ids, move_stat,
};
use videorc_app_core::studio::scene_on_stream::copy::SCREEN_HIDDEN;
use videorc_app_core::studio::timecode::format_timecode;
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    context_menu::ContextMenu,
    dropdown_menu::{Menu, MenuItem},
    icon::{IconName, icon},
    theme::hsla,
    tokens::Theme,
};

use super::layout::WIDE_MIN;

/// `sessionItem` off air.
const OFF_AIR: &str = "Off air";
/// A stat with no reading (`NO_VALUE`).
const NO_VALUE: &str = "–";

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

/// One stats cell: id (layout key), label, value, optional Wide sparkline.
#[derive(Clone, Debug, PartialEq)]
pub struct StatCell {
    pub id: &'static str,
    pub label: &'static str,
    pub value: String,
    pub spark: Vec<f32>,
}

/// What the stats bar reads from the live dashboard.
#[derive(Clone, Debug, PartialEq)]
pub struct StatsView {
    pub chip: SessionChip,
    pub cells: Vec<StatCell>,
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
        let by_id = [
            ("session", "Clock", clock, Vec::new()),
            ("viewers", "Viewers", viewers, viewer_spark),
            ("followers", "Followers", followers, Vec::new()),
            ("supporters", "Subs and members", subs, Vec::new()),
            ("tips", "Tips", tips, Vec::new()),
            ("chat", "Chat pace", pace, pace_spark),
        ];
        // `statItems`: a stat with nothing measured yet isn't in the bar
        // (never a run of placeholders): viewers once counted or live,
        // followers once reported, subs and tips once the session's totals
        // arrive. The clock ("Off air") and chat pace always show.
        let totals = matches!(board.chat_totals, Some(SessionChatTotals::Available { .. }));
        let viewers_known = board.latest_viewers.is_some()
            || !board.viewer_history.is_empty()
            || matches!(board.session, SessionState::Live);
        let shows = |id: &str, value: &str| match id {
            "viewers" => viewers_known,
            "followers" => value != NO_VALUE,
            "supporters" | "tips" => totals,
            _ => true,
        };
        let cells = DEFAULT_STAT_ORDER
            .iter()
            .filter(|id| {
                by_id
                    .iter()
                    .any(|(cell_id, _, value, _)| cell_id == *id && shows(cell_id, value))
            })
            .filter_map(|id| {
                by_id.iter().find(|(cell_id, _, _, _)| cell_id == id).map(
                    |(id, label, value, spark)| StatCell {
                        id,
                        label,
                        value: value.clone(),
                        spark: spark.clone(),
                    },
                )
            })
            .collect();
        Self { chip, cells }
    }

    /// Cells in the stored layout order, with hidden ones dropped.
    pub fn arranged(&self, layout: &StatsLayout) -> Vec<StatCell> {
        let by_id: std::collections::HashMap<&str, &StatCell> =
            self.cells.iter().map(|cell| (cell.id, cell)).collect();
        arranged_stat_ids(layout)
            .into_iter()
            .filter_map(|id| by_id.get(id.as_str()).cloned().cloned())
            .collect()
    }
}

/// `sessionItem`: the session's clock, else "Off air".
fn clock_value(board: &LiveDashboard, now_ms: i64) -> String {
    let Some(started) = board.started_at.as_deref().and_then(parse_time) else {
        return OFF_AIR.into();
    };
    if matches!(board.session, SessionState::OffAir) {
        return OFF_AIR.into();
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
            if micros.is_multiple_of(1_000_000) {
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
            .rounded_none()
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

/// Drag payload for reordering a stats cell.
#[derive(Clone)]
struct StatDrag {
    id: SharedString,
}

impl Render for StatDrag {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // A floating chip under the pointer: the popover's glass and ink.
        let t = videorc_kit::theme::resolve(None, window, cx);
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(videorc_kit::tokens::radius::CHIP))
            .bg(hsla(t.popover))
            .border_1()
            .border_color(hsla(t.border))
            .text_color(hsla(t.popover_foreground))
            .text_size(px(12.))
            .child(self.id.clone())
    }
}

/// The bar under the header. `on_layout` persists a new order after drag or
/// Move left / Move right.
pub fn stats_bar(
    t: &Theme,
    view: &StatsView,
    layout: &StatsLayout,
    width: f32,
    screen_hidden: bool,
    on_layout: impl Fn(StatsLayout, &mut App) + Clone + 'static,
) -> AnyElement {
    let wide = width >= WIDE_MIN;
    let muted = hsla(t.muted_foreground);
    let chip = view.chip;
    let cells = view.arranged(layout);
    let shown: Vec<SharedString> = cells
        .iter()
        .map(|cell| SharedString::from(cell.id))
        .collect();
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
        .children(cells.into_iter().enumerate().map(|(index, cell)| {
            let spark = if wide {
                sparkline(&cell.spark, muted)
            } else {
                None
            };
            let id = SharedString::from(cell.id);
            let drag = StatDrag { id: id.clone() };
            let layout_for_drop = layout.clone();
            let on_drop = on_layout.clone();
            let shown_for_menu = shown.clone();
            let layout_for_menu = layout.clone();
            let on_menu = on_layout.clone();
            let cell_id = id.clone();
            let body = div()
                .id(SharedString::from(format!("stat-{}", cell.id)))
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w(px(0.))
                .cursor_move()
                // `StatCell`: the value alone (15 px semibold, `text-subtle`
                // when there's no reading); the label names it for assistive
                // tech and its details.
                .aria_label(format!("{}: {}", cell.label, cell.value))
                .child(
                    div()
                        .text_size(px(15.))
                        .line_height(px(20.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .when(cell.value == OFF_AIR || cell.value == NO_VALUE, |value| {
                            value.text_color(muted)
                        })
                        .child(cell.value),
                )
                .children(spark)
                .on_drag(drag, |info: &StatDrag, _, _, cx| cx.new(|_| info.clone()))
                .on_drop(move |info: &StatDrag, _, app| {
                    if info.id.as_ref() == cell_id.as_ref() {
                        return;
                    }
                    let without: Vec<String> = layout_for_drop
                        .order
                        .iter()
                        .filter(|candidate| candidate.as_str() != info.id.as_ref())
                        .cloned()
                        .collect();
                    let neighbor = cell_id.as_ref();
                    let Some(neighbor_ix) = without.iter().position(|c| c == neighbor) else {
                        return;
                    };
                    let next = move_stat(&layout_for_drop, info.id.as_ref(), neighbor_ix);
                    if next != layout_for_drop {
                        on_drop(next, app);
                    }
                });
            ContextMenu::new(SharedString::from(format!("stat-menu-{}", cell.id)), body)
                .menu(move |_, _| {
                    let position = shown_for_menu
                        .iter()
                        .position(|candidate| candidate.as_ref() == id.as_ref())
                        .unwrap_or(index);
                    let can_left = position > 0;
                    let can_right = position + 1 < shown_for_menu.len();
                    let left_neighbor = can_left.then(|| shown_for_menu[position - 1].clone());
                    let right_neighbor = can_right.then(|| shown_for_menu[position + 1].clone());
                    let layout = layout_for_menu.clone();
                    let on_left = on_menu.clone();
                    let on_right = on_menu.clone();
                    let move_id = id.clone();
                    Menu::new()
                        .item(MenuItem::new("Move left").disabled(!can_left).on_select(
                            move |_, app| {
                                let Some(neighbor) = &left_neighbor else {
                                    return;
                                };
                                let without: Vec<String> = layout
                                    .order
                                    .iter()
                                    .filter(|c| c.as_str() != move_id.as_ref())
                                    .cloned()
                                    .collect();
                                let Some(ix) = without.iter().position(|c| c == neighbor.as_ref())
                                else {
                                    return;
                                };
                                let next = move_stat(&layout, move_id.as_ref(), ix);
                                if next != layout {
                                    on_left(next, app);
                                }
                            },
                        ))
                        .item(MenuItem::new("Move right").disabled(!can_right).on_select({
                            let move_id = id.clone();
                            let layout = layout_for_menu.clone();
                            move |_, app| {
                                let Some(neighbor) = &right_neighbor else {
                                    return;
                                };
                                let without: Vec<String> = layout
                                    .order
                                    .iter()
                                    .filter(|c| c.as_str() != move_id.as_ref())
                                    .cloned()
                                    .collect();
                                let Some(ix) = without.iter().position(|c| c == neighbor.as_ref())
                                else {
                                    return;
                                };
                                let next = move_stat(&layout, move_id.as_ref(), ix + 1);
                                if next != layout {
                                    on_right(next, app);
                                }
                            }
                        }))
                })
                .into_any_element()
        }))
        // P950 (plan 210 D9): Hide screen's chip at the trailing edge. It is
        // never clipped and no stat moves when it comes or goes; a warn
        // badge whose EyeSlash takes the dot's place, as the Studio's.
        .when(screen_hidden, |bar| {
            bar.child(
                div()
                    .id("stats-screen-hidden")
                    .ml_auto()
                    .flex_none()
                    .pl(px(12.))
                    .child(
                        Badge::new(SCREEN_HIDDEN)
                            .variant(BadgeVariant::Warning)
                            .icon(icon(IconName::EyeSlash, 14., hsla(t.warning))),
                    ),
            )
        })
        .into_any_element()
}
