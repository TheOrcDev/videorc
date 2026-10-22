//! One live session's announcement, as a pure state machine (plan 187 S2).
//!
//! It takes what happened (a destination stayed live, YouTube went live, X
//! published, the session ended) and the time, and answers with at most one
//! request at a time: post, edit, or nothing. Every timing rule lives here:
//! the 10 s dwell for platforms that never confirm, the 2 s edit coalescing,
//! the restart reuse and "never post after the stop". The async announcer in
//! `mod.rs` only runs the requests it is given.

use chrono::{DateTime, TimeDelta, Utc};

use super::client::LinkButton;
use crate::streaming::{StreamPlatform, StreamPrivacy, StreamTargetState, StreamTargetsSnapshot};

/// Platforms with no confirmation step count once a destination has stayed
/// live this long.
pub const CONFIRM_DWELL: TimeDelta = TimeDelta::seconds(10);
/// Destinations that come up together land in one edit.
pub const EDIT_COALESCE: TimeDelta = TimeDelta::seconds(2);
/// A Go Live this soon after the last announced stream ended edits that
/// message back to live instead of posting (and pinging) again.
pub const RESTART_WINDOW: TimeDelta = TimeDelta::minutes(15);

/// How a destination proves it is watchable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confirm {
    /// `streamTargets.youtube.transition` to live succeeded for this
    /// broadcast. `None` matches the one YouTube leg still waiting.
    YouTube { broadcast_id: Option<String> },
    /// `streamTargets.x.publish` returned its share URL.
    X,
    /// Stayed `Live` in `stream.targets` for [`CONFIRM_DWELL`].
    Dwell,
}

/// One destination the post may link, resolved at session start: ticked,
/// and with a link now or one that confirmation brings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegPlan {
    pub target_id: String,
    pub platform: StreamPlatform,
    /// The button label: "YouTube", "Twitch · Vertical", a custom name.
    pub label: String,
    pub confirm: Confirm,
    /// Known now (typed or built). YouTube and X may fill it on confirm.
    pub link: Option<String>,
    /// A typed link wins over the one confirmation brings.
    pub link_typed: bool,
    /// YouTube only: the draft's privacy, used when YouTube's answer has none.
    pub draft_privacy: Option<StreamPrivacy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LegState {
    Waiting { live_since: Option<DateTime<Utc>> },
    Confirmed,
    Skipped,
}

#[derive(Debug, Clone)]
struct Leg {
    plan: LegPlan,
    state: LegState,
    link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Message {
    /// Nothing posted yet. `reuse` is the previous stream's message, inside
    /// the restart window.
    None {
        reuse: Option<String>,
    },
    Posting,
    Posted {
        message_id: String,
    },
    /// Gave up for this session (the webhook is gone, retries ran out).
    Abandoned,
}

/// What the announcer should send next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Post,
    /// `ended` is the final "Was live" edit; `revive` turns a previous
    /// stream's message back to live (restart window).
    Edit {
        message_id: String,
        ended: bool,
        revive: bool,
    },
}

/// How a request ended, fed back by the announcer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Posted {
        message_id: String,
    },
    Edited,
    /// The message is gone in Discord. A revive falls back to a fresh post.
    MessageGone,
    /// Anything else that will not succeed this session.
    Failed,
}

#[derive(Debug, Clone)]
pub struct AnnounceSession {
    session_id: String,
    started_at: DateTime<Utc>,
    legs: Vec<Leg>,
    message: Message,
    in_flight: Option<Request>,
    /// Target ids the message shows (or will, once the request lands).
    shown: Vec<String>,
    changed_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
    final_sent: bool,
}

impl AnnounceSession {
    pub fn new(
        session_id: impl Into<String>,
        started_at: DateTime<Utc>,
        legs: Vec<LegPlan>,
        reuse_message_id: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            started_at,
            legs: legs
                .into_iter()
                .map(|plan| Leg {
                    link: plan.link.clone(),
                    plan,
                    state: LegState::Waiting { live_since: None },
                })
                .collect(),
            message: Message::None {
                reuse: reuse_message_id,
            },
            in_flight: None,
            shown: Vec::new(),
            changed_at: None,
            ended_at: None,
            final_sent: false,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn started_at(&self) -> DateTime<Utc> {
        self.started_at
    }

    pub fn ended_at(&self) -> Option<DateTime<Utc>> {
        self.ended_at
    }

    pub fn message_id(&self) -> Option<&str> {
        match &self.message {
            Message::Posted { message_id } => Some(message_id),
            _ => None,
        }
    }

    /// Nothing more will ever be sent for this session.
    pub fn is_finished(&self) -> bool {
        self.in_flight.is_none()
            && match &self.message {
                Message::Abandoned => true,
                Message::None { .. } => self.ended_at.is_some(),
                Message::Posting => false,
                Message::Posted { .. } => self.final_sent,
            }
    }

    /// The links the message shows: confirmed legs, in destination order.
    pub fn links(&self) -> Vec<LinkButton> {
        self.legs
            .iter()
            .filter(|leg| leg.state == LegState::Confirmed)
            .filter_map(|leg| {
                leg.link.as_ref().map(|url| LinkButton {
                    label: leg.plan.label.clone(),
                    url: url.clone(),
                })
            })
            .collect()
    }

    /// `stream.targets` for this session: tracks how long each dwell leg has
    /// been continuously live. A dip resets the dwell; it never un-posts.
    pub fn observe_targets(&mut self, snapshot: &StreamTargetsSnapshot, now: DateTime<Utc>) {
        if snapshot.session_id != self.session_id || self.ended_at.is_some() {
            return;
        }
        for leg in &mut self.legs {
            if leg.plan.confirm != Confirm::Dwell {
                continue;
            }
            let LegState::Waiting { live_since } = &mut leg.state else {
                continue;
            };
            let live = snapshot
                .targets
                .iter()
                .find(|target| target.target_id == leg.plan.target_id)
                .is_some_and(|target| target.state == StreamTargetState::Live);
            match (live, *live_since) {
                (true, None) => *live_since = Some(now),
                (false, Some(_)) => *live_since = None,
                _ => {}
            }
        }
        self.tick(now);
    }

    /// YouTube moved a broadcast to live. `privacy` is YouTube's own answer;
    /// unknown after the draft too means skip (never assume public).
    pub fn observe_youtube_live(
        &mut self,
        broadcast_id: &str,
        privacy: Option<StreamPrivacy>,
        now: DateTime<Utc>,
    ) {
        if self.ended_at.is_some() {
            return;
        }
        let waiting = |leg: &Leg| {
            matches!(leg.state, LegState::Waiting { .. })
                && matches!(leg.plan.confirm, Confirm::YouTube { .. })
        };
        let index = self
            .legs
            .iter()
            .position(|leg| {
                waiting(leg)
                    && matches!(&leg.plan.confirm,
                        Confirm::YouTube { broadcast_id: Some(id) } if id == broadcast_id)
            })
            .or_else(|| {
                let unbound: Vec<usize> = self
                    .legs
                    .iter()
                    .enumerate()
                    .filter(|(_, leg)| {
                        waiting(leg)
                            && matches!(leg.plan.confirm, Confirm::YouTube { broadcast_id: None })
                    })
                    .map(|(index, _)| index)
                    .collect();
                (unbound.len() == 1).then(|| unbound[0])
            });
        let Some(index) = index else {
            return;
        };
        let leg = &mut self.legs[index];
        let privacy = privacy.or(leg.plan.draft_privacy);
        if privacy != Some(StreamPrivacy::Public) {
            leg.state = LegState::Skipped;
            return;
        }
        if !leg.plan.link_typed {
            leg.link = Some(format!("https://www.youtube.com/watch?v={broadcast_id}"));
        }
        self.confirm(index, now);
    }

    /// X published the broadcast. X has no unlisted or private.
    pub fn observe_x_published(&mut self, share_url: &str, now: DateTime<Utc>) {
        if self.ended_at.is_some() {
            return;
        }
        let Some(index) = self.legs.iter().position(|leg| {
            leg.plan.confirm == Confirm::X && matches!(leg.state, LegState::Waiting { .. })
        }) else {
            return;
        };
        let leg = &mut self.legs[index];
        if !leg.plan.link_typed && share_url.starts_with("https://") {
            leg.link = Some(share_url.to_string());
        }
        self.confirm(index, now);
    }

    pub fn end(&mut self, now: DateTime<Utc>) {
        if self.ended_at.is_none() {
            self.ended_at = Some(now);
        }
    }

    /// Promotes dwell legs whose time is up.
    pub fn tick(&mut self, now: DateTime<Utc>) {
        if self.ended_at.is_some() {
            return;
        }
        let due: Vec<usize> = self
            .legs
            .iter()
            .enumerate()
            .filter(|(_, leg)| {
                matches!(leg.state, LegState::Waiting { live_since: Some(since) } if now - since >= CONFIRM_DWELL)
            })
            .map(|(index, _)| index)
            .collect();
        for index in due {
            self.confirm(index, now);
        }
    }

    fn confirm(&mut self, index: usize, now: DateTime<Utc>) {
        let leg = &mut self.legs[index];
        if leg.link.is_none() {
            leg.state = LegState::Skipped;
            return;
        }
        leg.state = LegState::Confirmed;
        self.changed_at.get_or_insert(now);
    }

    /// When [`Self::tick`] or [`Self::next_request`] next has something to do.
    pub fn next_deadline(&self) -> Option<DateTime<Utc>> {
        if self.ended_at.is_some() {
            return None;
        }
        let dwell = self
            .legs
            .iter()
            .filter_map(|leg| match leg.state {
                LegState::Waiting {
                    live_since: Some(since),
                } => Some(since + CONFIRM_DWELL),
                _ => None,
            })
            .min();
        let edit = match (&self.message, self.changed_at) {
            (Message::Posted { .. }, Some(changed)) if self.in_flight.is_none() => {
                Some(changed + EDIT_COALESCE)
            }
            _ => None,
        };
        dwell.into_iter().chain(edit).min()
    }

    /// The next request, if one is due. Call [`Self::started`] when sending it.
    pub fn next_request(&self, now: DateTime<Utc>) -> Option<Request> {
        if self.in_flight.is_some() {
            return None;
        }
        let confirmed = self.confirmed_ids();
        match &self.message {
            Message::Abandoned | Message::Posting => None,
            // Never a "Live now" after the stop.
            Message::None { .. } if self.ended_at.is_some() => None,
            Message::None { reuse } => {
                if confirmed.is_empty() {
                    return None;
                }
                Some(match reuse {
                    Some(message_id) => Request::Edit {
                        message_id: message_id.clone(),
                        ended: false,
                        revive: true,
                    },
                    None => Request::Post,
                })
            }
            Message::Posted { message_id } => {
                if self.ended_at.is_some() {
                    return (!self.final_sent).then(|| Request::Edit {
                        message_id: message_id.clone(),
                        ended: true,
                        revive: false,
                    });
                }
                let due = self
                    .changed_at
                    .is_some_and(|changed| now - changed >= EDIT_COALESCE);
                (due && confirmed != self.shown).then(|| Request::Edit {
                    message_id: message_id.clone(),
                    ended: false,
                    revive: false,
                })
            }
        }
    }

    pub fn started(&mut self, request: &Request) {
        self.shown = self.confirmed_ids();
        self.changed_at = None;
        if matches!(request, Request::Post) {
            self.message = Message::Posting;
        }
        self.in_flight = Some(request.clone());
    }

    pub fn finished(&mut self, outcome: Outcome, now: DateTime<Utc>) {
        let Some(request) = self.in_flight.take() else {
            return;
        };
        match (request, outcome) {
            (Request::Post, Outcome::Posted { message_id }) => {
                self.message = Message::Posted { message_id };
            }
            (Request::Post, _) => self.message = Message::Abandoned,
            (
                Request::Edit {
                    message_id,
                    revive: true,
                    ..
                },
                Outcome::Edited,
            ) => self.message = Message::Posted { message_id },
            // The previous message is gone: post fresh, still once.
            (Request::Edit { revive: true, .. }, Outcome::MessageGone) => {
                self.message = Message::None { reuse: None };
                self.shown.clear();
            }
            (Request::Edit { revive: true, .. }, _) => self.message = Message::Abandoned,
            (Request::Edit { ended: true, .. }, _) => self.final_sent = true,
            (Request::Edit { .. }, Outcome::MessageGone) => self.message = Message::Abandoned,
            (Request::Edit { .. }, Outcome::Edited | Outcome::Posted { .. }) => {}
            // A failed live edit is not retried in a loop; the next change
            // (or the final edit) carries the full state again.
            (Request::Edit { .. }, Outcome::Failed) => {}
        }
        if self.confirmed_ids() != self.shown && self.ended_at.is_none() {
            self.changed_at.get_or_insert(now);
        }
    }

    fn confirmed_ids(&self) -> Vec<String> {
        self.legs
            .iter()
            .filter(|leg| leg.state == LegState::Confirmed)
            .map(|leg| leg.plan.target_id.clone())
            .collect()
    }
}

#[cfg(test)]
#[path = "machine_tests.rs"]
mod tests;
