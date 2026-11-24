//! Wire types from `videorc-backend`'s `community` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

/// A regular chatted in at least this many streams in the last
/// [`REGULAR_WINDOW_DAYS`] (D7); the streamer may set 2 to 10.
pub const REGULAR_STREAMS_DEFAULT: u32 = 3;

pub const REGULAR_STREAMS_MIN: u32 = 2;

pub const REGULAR_STREAMS_MAX: u32 = 10;

/// Which milestone an arrival celebrates (D8).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ViewerMilestoneKind {
    Streams,
    Row,
    Anniversary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ViewerMilestone {
    pub kind: ViewerMilestoneKind,
    /// The stream count, the run, or the anniversary's year.
    pub value: u32,
}

impl ViewerMilestone {
    /// The key kept in `milestones_json` ("streams-10", "row-5",
    /// "year-2027"), so each is celebrated once per person.
    pub fn key(&self) -> String {
        match self.kind {
            ViewerMilestoneKind::Streams => format!("streams-{}", self.value),
            ViewerMilestoneKind::Row => format!("row-{}", self.value),
            ViewerMilestoneKind::Anniversary => format!("year-{}", self.value),
        }
    }

    /// The chip and the card ("10th stream", "5 in a row", "One year").
    pub fn label(&self) -> String {
        match self.kind {
            ViewerMilestoneKind::Streams => format!("{} stream", ordinal(self.value)),
            ViewerMilestoneKind::Row => format!("{} in a row", self.value),
            ViewerMilestoneKind::Anniversary => "One year".to_string(),
        }
    }
}

/// `cohostSettings.community` (Wire shape), every field with a default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySettings {
    /// Remember my community (the master switch, default ON).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Regular after N streams (2 to 10, default 3).
    #[serde(default = "default_regular_streams")]
    pub regular_streams: u32,
    /// Welcome regulars on stream (the regular, comeback and milestone
    /// welcomes; default ON).
    #[serde(default = "default_true")]
    pub welcome_on_stream: bool,
    /// Show milestone cards automatically (default OFF).
    #[serde(default)]
    pub milestone_cards: bool,
    /// Buddy remembers (Premium, D10, default OFF).
    #[serde(default)]
    pub remember: bool,
    /// D10: the "Let Buddy remember…" card was answered (Turn on or Not
    /// now), so it is never offered twice.
    #[serde(default)]
    pub remember_offered: bool,
    /// Community sync (Premium, D5, default OFF).
    #[serde(default)]
    pub sync: bool,
}

fn default_true() -> bool {
    true
}

fn default_regular_streams() -> u32 {
    REGULAR_STREAMS_DEFAULT
}

impl Default for CommunitySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            regular_streams: REGULAR_STREAMS_DEFAULT,
            welcome_on_stream: true,
            milestone_cards: false,
            remember: false,
            remember_offered: false,
            sync: false,
        }
    }
}

impl CommunitySettings {
    /// The threshold within D7's bounds, whatever was stored or patched.
    pub fn normalized(mut self) -> Self {
        self.regular_streams = self
            .regular_streams
            .clamp(REGULAR_STREAMS_MIN, REGULAR_STREAMS_MAX);
        self
    }
}

/// "10th", "21st", "112th".
pub fn ordinal(value: u32) -> String {
    let suffix = match (value % 10, value % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{value}{suffix}")
}
