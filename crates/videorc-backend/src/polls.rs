//! Polls across every chat (plan 188).
//!
//! The streamer asks a question with 2–5 answers; viewers vote by typing the
//! answer's number in any platform's chat, and every vote lands in one tally.
//! This module owns the wire shape (pinned by the `poll` key of
//! `protocol-fixtures/high-risk-contracts.json`) and the vote grammar (pinned
//! by `protocol-fixtures/poll-votes.json`, which the desktop's
//! `shared/poll-votes.ts` runs too).

use serde::{Deserialize, Serialize};

use crate::streaming::StreamPlatform;

/// A poll has 2–5 answers (D10, Twitch's own limits).
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 5;
/// Characters, counted as Unicode scalar values after trimming (D10).
pub const QUESTION_MAX_CHARS: usize = 60;
pub const OPTION_MAX_CHARS: usize = 25;

/// `polls.start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollStartParams {
    pub question: String,
    pub options: Vec<String>,
    /// `None` is No timer: the poll ends on End now (D10).
    #[serde(default)]
    pub duration_seconds: Option<u32>,
    pub post_in_chat: bool,
}

/// `polls.end`, `polls.cancel` and `polls.reshow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollIdParams {
    pub poll_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PollState {
    /// Votes count; the card shows a countdown (or none with No timer).
    Open,
    /// The timer ended (or End now): votes stamped up to `acceptUntil` still
    /// count (D8).
    Counting,
    /// The tally is frozen.
    Final,
    /// Discarded: no result, no post, the card cleared.
    Cancelled,
}

/// Whether the poll card should be on the picture. The backend owns it: it
/// hides the card `RESULT_HOLD` after final and on cancel (D7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PollCardVisibility {
    Shown,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollOptionTally {
    pub label: String,
    pub votes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollPlatformTally {
    pub platform: StreamPlatform,
    pub votes: u32,
}

/// Which legs draw the card (D13): the primary canvas always; the auxiliary
/// (vertical or split stream) leg only when one of its destinations has a
/// chat Videorc counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollCardLegs {
    pub primary: bool,
    pub auxiliary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PollPostPhase {
    Sending,
    Sent,
    Partial,
    Failed,
}

/// One chat post (the start or the result) across every chat (D6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollPostSummary {
    pub phase: PollPostPhase,
    pub failed_platforms: Vec<StreamPlatform>,
}

/// The poll as every surface sees it: `polls.status` events, `polls.current`
/// and the `polls.start/end/cancel/reshow` results. Optional fields are
/// omitted when absent, never null (the serde-null contract trap).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollStatus {
    pub poll_id: String,
    pub session_id: String,
    pub question: String,
    pub options: Vec<PollOptionTally>,
    pub total_votes: u32,
    /// Votes per platform, platforms with at least one vote only.
    pub by_platform: Vec<PollPlatformTally>,
    pub state: PollState,
    /// RFC 3339, the backend's clock.
    pub opened_at: String,
    /// When the timer runs out; absent with No timer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closes_at: Option<String>,
    /// When the poll stopped taking new votes (timer, End now or session end).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// The latest platform time a vote may carry: `endedAt` + the late-vote
    /// grace (D8). The Stream Manager folds vote messages up to here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    pub post_in_chat: bool,
    pub card: PollCardVisibility,
    pub card_legs: PollCardLegs,
    /// False on paths with no live text slot (4K60 legacy FFmpeg, direct
    /// D3D11 recording): the poll still runs, the card can't draw (D14).
    pub card_available: bool,
    /// Indexes (0-based) of the option(s) with the most votes; several on a
    /// tie, none with zero votes.
    pub winners: Vec<u32>,
    /// Platforms whose chat is being read, so their votes count.
    pub counting_platforms: Vec<StreamPlatform>,
    /// Platforms whose chat is connected but not reading right now (e.g.
    /// YouTube under the quota breaker): their votes aren't counting.
    pub paused_platforms: Vec<StreamPlatform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_post: Option<PollPostSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_post: Option<PollPostSummary>,
}

/// The `polls.status` event. `poll: null` (no poll this session, or the last
/// one was cleared) is the one deliberate null on this wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollStatusEvent {
    pub poll: Option<PollStatus>,
}

/// Whether `poll_id`'s card is up right now. `polls.overlay.set` refuses a push
/// for any other poll (or a hidden card), so a raster that was in flight when
/// the card hid can't bring it back. Placeholder until S1 wires the engine.
pub(crate) fn card_shown_for(_state: &crate::state::AppState, _poll_id: &str) -> bool {
    true
}

fn is_vote_trim(c: char) -> bool {
    // Rust's White_Space plus U+FEFF, which JavaScript's `trim` also strips;
    // the TS twin adds U+0085, which Rust has and JavaScript's `\s` lacks.
    c.is_whitespace() || c == '\u{feff}'
}

/// The vote grammar (D2): the whole message, trimmed, is one ASCII digit
/// `1..=option_count`, optionally followed by U+FE0F and/or U+20E3 (the keycap
/// emoji). Returns the 1-based option number; anything else is chat.
pub fn classify_vote(text: &str, option_count: usize) -> Option<u8> {
    let mut chars = text.trim_matches(is_vote_trim).chars();
    let digit = chars.next()?.to_digit(10)?;
    let rest: Vec<char> = chars.collect();
    let suffix_ok = matches!(
        rest.as_slice(),
        [] | ['\u{fe0f}'] | ['\u{20e3}'] | ['\u{fe0f}', '\u{20e3}']
    );
    if !suffix_ok || digit == 0 || digit as usize > option_count.min(MAX_OPTIONS) {
        return None;
    }
    Some(digit as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn high_risk_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .unwrap()
    }

    #[test]
    fn vote_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol-fixtures/poll-votes.json"))
                .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 30);
        for case in cases {
            let text = case["text"].as_str().unwrap();
            let option_count = case["optionCount"].as_u64().unwrap() as usize;
            let expected = case["expected"].as_u64().map(|value| value as u8);
            assert_eq!(
                classify_vote(text, option_count),
                expected,
                "{text:?} with {option_count} options"
            );
        }
    }

    #[test]
    fn poll_wire_shapes_round_trip_the_pinned_fixture() {
        let fixture = high_risk_fixture();
        let poll = &fixture["poll"];
        for key in ["open", "final", "untimed"] {
            let status: PollStatus = serde_json::from_value(poll[key].clone())
                .unwrap_or_else(|error| panic!("{key}: {error}"));
            assert_eq!(serde_json::to_value(&status).unwrap(), poll[key], "{key}");
        }
        let untimed: PollStatus = serde_json::from_value(poll["untimed"].clone()).unwrap();
        let wire = serde_json::to_value(&untimed).unwrap();
        for absent in [
            "closesAt",
            "endedAt",
            "acceptUntil",
            "finalAt",
            "durationSeconds",
            "startPost",
            "resultPost",
        ] {
            assert!(wire.get(absent).is_none(), "{absent} must be omitted, never null");
        }

        let none: PollStatusEvent = serde_json::from_value(poll["eventNone"].clone()).unwrap();
        assert_eq!(none.poll, None);
        assert_eq!(serde_json::to_value(&none).unwrap(), poll["eventNone"]);
        let open: PollStatus = serde_json::from_value(poll["open"].clone()).unwrap();
        let event = PollStatusEvent { poll: Some(open) };
        assert_eq!(serde_json::to_value(&event).unwrap()["poll"], poll["open"]);

        let start: PollStartParams = serde_json::from_value(poll["startParams"].clone()).unwrap();
        assert_eq!(start.duration_seconds, Some(60));
        let untimed: PollStartParams =
            serde_json::from_value(poll["startParamsNoTimer"].clone()).unwrap();
        assert_eq!(untimed.duration_seconds, None);
        let id: PollIdParams = serde_json::from_value(poll["idParams"].clone()).unwrap();
        assert_eq!(id.poll_id, "7b0e6c1a-3f2d-4c8e-9a51-2d6f0b8c4e17");
        assert!(
            serde_json::from_value::<PollIdParams>(serde_json::json!({ "pollId": "a", "x": 1 }))
                .is_err()
        );
    }
}
