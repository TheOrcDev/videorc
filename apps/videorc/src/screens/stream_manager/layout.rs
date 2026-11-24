//! The window's tiers and where each pane sits (`lib/stream-manager-layout.ts`,
//! plan 055 D1). The layout follows the window's own width:
//!
//! - Wide, 1040 px and up: Chat on the left, beside a right pane (Activity or
//!   Sidekick) clamp(340 px, 34%, 440 px) wide.
//! - Medium, 640 to 1039 px: one pane, picked by one set of tabs (Chat,
//!   Activity, Sidekick).
//! - Narrow, under 640 px (320 minimum): the same tabs under a one-line
//!   summary.
//!
//! Each pane renders once; only its placement changes.

use videorc_app_core::studio::transport::StatusTone;

pub const WIDE_MIN: f32 = 1040.;
pub const MEDIUM_MIN: f32 = 640.;
/// Below this a control's text label leaves the eye (`COMPACT_LABEL`).
pub const FULL_LABELS_MIN: f32 = 800.;
pub const MIN_WIDTH: f32 = 320.;
pub const MIN_HEIGHT: f32 = 360.;

const RIGHT_PANE_MIN: f32 = 340.;
const RIGHT_PANE_MAX: f32 = 440.;
const RIGHT_PANE_SHARE: f32 = 0.34;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Wide,
    Medium,
    Narrow,
}

impl Tier {
    pub fn of(width: f32) -> Self {
        if width >= WIDE_MIN {
            Tier::Wide
        } else if width >= MEDIUM_MIN {
            Tier::Medium
        } else {
            Tier::Narrow
        }
    }
}

/// A control's text label shows (`COMPACT_LABEL`: hidden below 800 px).
pub fn full_labels(width: f32) -> bool {
    width >= FULL_LABELS_MIN
}

/// A status bar word that shows at Wide only (`WIDE_LABEL`).
pub fn wide_labels(width: f32) -> bool {
    width >= WIDE_MIN
}

/// The right pane's width at Wide: clamp(340 px, 34%, 440 px).
pub fn right_pane_width(width: f32) -> f32 {
    (width * RIGHT_PANE_SHARE).clamp(RIGHT_PANE_MIN, RIGHT_PANE_MAX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Pane {
    Chat,
    Activity,
    Sidekick,
}

impl Pane {
    pub fn label(self) -> &'static str {
        match self {
            Pane::Chat => "Chat",
            Pane::Activity => "Activity",
            Pane::Sidekick => "Sidekick",
        }
    }
}

/// The pane the right side shows at Wide (never Chat).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RightPane {
    Activity,
    Sidekick,
}

impl RightPane {
    pub fn pane(self) -> Pane {
        match self {
            RightPane::Activity => Pane::Activity,
            RightPane::Sidekick => Pane::Sidekick,
        }
    }
}

/// Where a pane sits (`paneClasses`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Hidden,
    /// Below Wide: the one pane the tabs picked.
    Whole,
    /// At Wide: Chat, full height.
    Left,
    /// At Wide: the pane the right tabs picked.
    Right,
}

pub fn slot(pane: Pane, tier: Tier, narrow: Pane, right: RightPane) -> Slot {
    match (tier, pane) {
        (Tier::Wide, Pane::Chat) => Slot::Left,
        (Tier::Wide, pane) if right.pane() == pane => Slot::Right,
        (Tier::Wide, _) => Slot::Hidden,
        (_, pane) if narrow == pane => Slot::Whole,
        _ => Slot::Hidden,
    }
}

pub fn visible(pane: Pane, tier: Tier, narrow: Pane, right: RightPane) -> bool {
    slot(pane, tier, narrow, right) != Slot::Hidden
}

/// The tabs this tier shows: all three panes below Wide, the right pane's two
/// at Wide. Sidekick's tab is there only while Sidekick is.
pub fn tabs(tier: Tier, sidekick_present: bool) -> Vec<Pane> {
    let mut tabs = match tier {
        Tier::Wide => vec![Pane::Activity],
        Tier::Medium | Tier::Narrow => vec![Pane::Chat, Pane::Activity],
    };
    if sidekick_present {
        tabs.push(Pane::Sidekick);
    }
    tabs
}

/// What arrived in a pane behind a tab (`useUnseen`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Unseen {
    pub count: usize,
    /// The journal skipped some, so the count is a floor.
    pub incomplete: bool,
}

/// The tab's badge: "New" when the count is a floor, "99+" past 99, the
/// count otherwise; none when nothing is unseen (`PaneLabel`).
pub fn unseen_badge(unseen: Unseen) -> Option<String> {
    if unseen.incomplete {
        Some("New".into())
    } else if unseen.count > 99 {
        Some("99+".into())
    } else if unseen.count > 0 {
        Some(unseen.count.to_string())
    } else {
        None
    }
}

/// Sidekick's state, as its tab's dot reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidekickStatus {
    Listening,
    Paused,
    Error,
    Other,
}

/// Sidekick's tab dot: viewers reporting a problem outrank a healthy green
/// (`cohostTone`, plan 174 F-7).
pub fn sidekick_dot(status: Option<SidekickStatus>, alerts: usize) -> StatusTone {
    if alerts > 0 {
        return StatusTone::Warn;
    }
    match status {
        Some(SidekickStatus::Listening) => StatusTone::Good,
        Some(SidekickStatus::Paused) => StatusTone::Warn,
        Some(SidekickStatus::Error) => StatusTone::Error,
        _ => StatusTone::Neutral,
    }
}

/// The dot in words, never colour alone (`cohostDotLabel`, plan 174 H-15).
pub fn sidekick_dot_label(status: Option<SidekickStatus>) -> Option<&'static str> {
    match status {
        Some(SidekickStatus::Listening) => Some("Sidekick is listening"),
        Some(SidekickStatus::Paused) => Some("Sidekick is paused"),
        Some(SidekickStatus::Error) => Some("Sidekick has a problem"),
        _ => None,
    }
}

/// The Activity tab's "On stream" dot: something only Activity shows is on
/// stream while Activity sits behind a tab (plan 095 D1).
pub fn activity_on_stream(activity_visible: bool, activity_only_highlight: bool) -> bool {
    !activity_visible && activity_only_highlight
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_split_at_640_and_1040() {
        assert_eq!(Tier::of(320.), Tier::Narrow);
        assert_eq!(Tier::of(639.), Tier::Narrow);
        assert_eq!(Tier::of(640.), Tier::Medium);
        assert_eq!(Tier::of(1039.), Tier::Medium);
        assert_eq!(Tier::of(1040.), Tier::Wide);
        assert_eq!(Tier::of(1120.), Tier::Wide);
    }

    #[test]
    fn labels_go_compact_below_800_and_wide_words_below_1040() {
        assert!(!full_labels(799.));
        assert!(full_labels(800.));
        assert!(!wide_labels(1039.));
        assert!(wide_labels(1040.));
    }

    #[test]
    fn the_right_pane_is_a_third_clamped_to_340_and_440() {
        assert!((right_pane_width(1040.) - 353.6).abs() < 0.01);
        assert_eq!(right_pane_width(900.), 340.);
        assert_eq!(right_pane_width(2000.), 440.);
    }

    #[test]
    fn below_wide_the_tabs_pick_the_one_pane() {
        for tier in [Tier::Medium, Tier::Narrow] {
            let right = RightPane::Sidekick;
            assert_eq!(
                slot(Pane::Activity, tier, Pane::Activity, right),
                Slot::Whole
            );
            assert_eq!(slot(Pane::Chat, tier, Pane::Activity, right), Slot::Hidden);
            assert_eq!(
                slot(Pane::Sidekick, tier, Pane::Activity, right),
                Slot::Hidden
            );
        }
    }

    #[test]
    fn at_wide_chat_stays_left_and_the_right_tabs_pick_the_right_pane() {
        let tier = Tier::Wide;
        let right = RightPane::Activity;
        assert_eq!(slot(Pane::Chat, tier, Pane::Sidekick, right), Slot::Left);
        assert_eq!(
            slot(Pane::Activity, tier, Pane::Sidekick, right),
            Slot::Right
        );
        assert_eq!(
            slot(Pane::Sidekick, tier, Pane::Sidekick, right),
            Slot::Hidden
        );
    }

    #[test]
    fn every_tier_shows_each_pane_once() {
        for tier in [Tier::Wide, Tier::Medium, Tier::Narrow] {
            for narrow in [Pane::Chat, Pane::Activity, Pane::Sidekick] {
                for right in [RightPane::Activity, RightPane::Sidekick] {
                    let shown = [Pane::Chat, Pane::Activity, Pane::Sidekick]
                        .into_iter()
                        .filter(|pane| visible(*pane, tier, narrow, right))
                        .count();
                    let expected = if tier == Tier::Wide { 2 } else { 1 };
                    assert_eq!(shown, expected, "{tier:?} {narrow:?} {right:?}");
                }
            }
        }
    }

    #[test]
    fn the_tabs_follow_the_tier_and_sidekick() {
        assert_eq!(
            tabs(Tier::Medium, true),
            vec![Pane::Chat, Pane::Activity, Pane::Sidekick]
        );
        assert_eq!(tabs(Tier::Narrow, false), vec![Pane::Chat, Pane::Activity]);
        assert_eq!(tabs(Tier::Wide, true), vec![Pane::Activity, Pane::Sidekick]);
        assert_eq!(tabs(Tier::Wide, false), vec![Pane::Activity]);
        let labels: Vec<_> = tabs(Tier::Medium, true).iter().map(|p| p.label()).collect();
        assert_eq!(labels, ["Chat", "Activity", "Sidekick"]);
    }

    #[test]
    fn the_unseen_badge_reads_new_99_plus_or_the_count() {
        let unseen = |count, incomplete| Unseen { count, incomplete };
        assert_eq!(unseen_badge(unseen(0, false)), None);
        assert_eq!(unseen_badge(unseen(7, false)).as_deref(), Some("7"));
        assert_eq!(unseen_badge(unseen(99, false)).as_deref(), Some("99"));
        assert_eq!(unseen_badge(unseen(100, false)).as_deref(), Some("99+"));
        assert_eq!(unseen_badge(unseen(0, true)).as_deref(), Some("New"));
        assert_eq!(unseen_badge(unseen(250, true)).as_deref(), Some("New"));
    }

    #[test]
    fn alerts_outrank_sidekick_s_own_state() {
        use SidekickStatus::*;
        assert_eq!(sidekick_dot(Some(Listening), 0), StatusTone::Good);
        assert_eq!(sidekick_dot(Some(Listening), 2), StatusTone::Warn);
        assert_eq!(sidekick_dot(Some(Paused), 0), StatusTone::Warn);
        assert_eq!(sidekick_dot(Some(Error), 0), StatusTone::Error);
        assert_eq!(sidekick_dot(Some(Other), 0), StatusTone::Neutral);
        assert_eq!(sidekick_dot(None, 0), StatusTone::Neutral);
    }

    #[test]
    fn the_dot_is_said_in_words() {
        use SidekickStatus::*;
        assert_eq!(
            sidekick_dot_label(Some(Listening)),
            Some("Sidekick is listening")
        );
        assert_eq!(sidekick_dot_label(Some(Paused)), Some("Sidekick is paused"));
        assert_eq!(
            sidekick_dot_label(Some(Error)),
            Some("Sidekick has a problem")
        );
        assert_eq!(sidekick_dot_label(Some(Other)), None);
        assert_eq!(sidekick_dot_label(None), None);
    }

    #[test]
    fn the_on_stream_dot_shows_only_behind_a_tab() {
        assert!(activity_on_stream(false, true));
        assert!(!activity_on_stream(true, true));
        assert!(!activity_on_stream(false, false));
    }
}
