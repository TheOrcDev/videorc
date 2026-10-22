use super::*;
use crate::streaming::StreamTargetRuntime;

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-22T18:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
        + TimeDelta::seconds(seconds)
}

fn dwell_leg(id: &str, platform: StreamPlatform, url: &str) -> LegPlan {
    LegPlan {
        target_id: id.to_string(),
        platform,
        label: crate::streaming::stream_platform_label(platform).to_string(),
        confirm: Confirm::Dwell,
        link: Some(url.to_string()),
        link_typed: false,
        draft_privacy: None,
    }
}

fn youtube_leg(id: &str, broadcast: Option<&str>, draft: StreamPrivacy) -> LegPlan {
    LegPlan {
        target_id: id.to_string(),
        platform: StreamPlatform::Youtube,
        label: "YouTube".to_string(),
        confirm: Confirm::YouTube {
            broadcast_id: broadcast.map(str::to_string),
        },
        link: broadcast.map(|id| format!("https://www.youtube.com/watch?v={id}")),
        link_typed: false,
        draft_privacy: Some(draft),
    }
}

fn x_leg(id: &str) -> LegPlan {
    LegPlan {
        target_id: id.to_string(),
        platform: StreamPlatform::X,
        label: "X".to_string(),
        confirm: Confirm::X,
        link: None,
        link_typed: false,
        draft_privacy: None,
    }
}

fn snapshot(session: &str, live: &[(&str, StreamTargetState)]) -> StreamTargetsSnapshot {
    StreamTargetsSnapshot {
        session_id: session.to_string(),
        targets: live
            .iter()
            .map(|(id, state)| StreamTargetRuntime {
                target_id: id.to_string(),
                platform: StreamPlatform::Custom,
                label: id.to_string(),
                state: *state,
                message: None,
                redacted_url: None,
            })
            .collect(),
    }
}

/// Runs every due request to completion with `outcome`, returning them.
fn drain(
    session: &mut AnnounceSession,
    now: DateTime<Utc>,
    outcome: impl Fn(&Request) -> Outcome,
) -> Vec<Request> {
    let mut sent = Vec::new();
    while let Some(request) = session.next_request(now) {
        session.started(&request);
        session.finished(outcome(&request), now);
        sent.push(request);
        assert!(sent.len() < 10, "request loop");
    }
    sent
}

fn ok(request: &Request) -> Outcome {
    match request {
        Request::Post => Outcome::Posted {
            message_id: "111".to_string(),
        },
        Request::Edit { .. } => Outcome::Edited,
    }
}

fn labels(session: &AnnounceSession) -> Vec<String> {
    session.links().into_iter().map(|link| link.label).collect()
}

#[test]
fn first_ticked_leg_posts_once_and_a_second_leg_edits_once_coalesced() {
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![
            dwell_leg(
                "twitch",
                StreamPlatform::Twitch,
                "https://www.twitch.tv/orcdev",
            ),
            dwell_leg("kick", StreamPlatform::Kick, "https://kick.com/orcdev"),
        ],
        None,
    );
    use StreamTargetState::Live;
    session.observe_targets(&snapshot("s1", &[("twitch", Live)]), at(1));
    assert_eq!(session.next_request(at(5)), None, "still inside the dwell");
    assert_eq!(session.next_deadline(), Some(at(11)));
    session.tick(at(11));
    assert_eq!(drain(&mut session, at(11), ok), vec![Request::Post]);
    assert_eq!(labels(&session), vec!["Twitch"]);

    session.observe_targets(&snapshot("s1", &[("twitch", Live), ("kick", Live)]), at(12));
    session.tick(at(22));
    assert_eq!(session.next_request(at(22)), None, "coalescing");
    assert_eq!(session.next_deadline(), Some(at(24)));
    let edits = drain(&mut session, at(24), ok);
    assert_eq!(
        edits,
        vec![Request::Edit {
            message_id: "111".to_string(),
            ended: false,
            revive: false
        }]
    );
    assert_eq!(labels(&session), vec!["Twitch", "Kick"]);
    assert_eq!(drain(&mut session, at(60), ok), Vec::<Request>::new());
}

#[test]
fn a_reconnect_never_posts_again() {
    use StreamTargetState::{Live, Reconnecting};
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![dwell_leg(
            "twitch",
            StreamPlatform::Twitch,
            "https://www.twitch.tv/a",
        )],
        None,
    );
    session.observe_targets(&snapshot("s1", &[("twitch", Live)]), at(0));
    session.tick(at(10));
    assert_eq!(drain(&mut session, at(10), ok), vec![Request::Post]);
    session.observe_targets(&snapshot("s1", &[("twitch", Reconnecting)]), at(30));
    session.observe_targets(&snapshot("s1", &[("twitch", Live)]), at(40));
    session.tick(at(60));
    assert_eq!(drain(&mut session, at(60), ok), Vec::<Request>::new());
}

#[test]
fn a_dip_inside_the_dwell_restarts_it() {
    use StreamTargetState::{Live, Reconnecting};
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![dwell_leg(
            "kick",
            StreamPlatform::Kick,
            "https://kick.com/a",
        )],
        None,
    );
    session.observe_targets(&snapshot("s1", &[("kick", Live)]), at(0));
    session.observe_targets(&snapshot("s1", &[("kick", Reconnecting)]), at(8));
    session.observe_targets(&snapshot("s1", &[("kick", Live)]), at(9));
    session.tick(at(12));
    assert_eq!(session.next_request(at(12)), None);
    session.tick(at(19));
    assert_eq!(session.next_request(at(19)), Some(Request::Post));
}

#[test]
fn only_ticked_legs_trigger_the_post() {
    // The planner drops unticked legs, so an unticked platform going live is
    // simply unknown to the session.
    use StreamTargetState::Live;
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![dwell_leg(
            "twitch",
            StreamPlatform::Twitch,
            "https://www.twitch.tv/a",
        )],
        None,
    );
    session.observe_targets(&snapshot("s1", &[("youtube", Live)]), at(0));
    session.tick(at(30));
    assert_eq!(session.next_request(at(30)), None);
    session.observe_targets(
        &snapshot("s1", &[("youtube", Live), ("twitch", Live)]),
        at(31),
    );
    session.tick(at(41));
    assert_eq!(session.next_request(at(41)), Some(Request::Post));
}

#[test]
fn unlisted_or_private_youtube_is_skipped_and_nothing_left_means_no_post() {
    for privacy in [StreamPrivacy::Unlisted, StreamPrivacy::Private] {
        let mut session = AnnounceSession::new(
            "s1",
            at(0),
            vec![youtube_leg("yt", Some("abc"), StreamPrivacy::Public)],
            None,
        );
        session.observe_youtube_live("abc", Some(privacy), at(5));
        assert_eq!(session.next_request(at(60)), None);
        session.end(at(70));
        assert!(session.is_finished());
    }
}

#[test]
fn public_youtube_posts_its_watch_link() {
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![youtube_leg("yt", None, StreamPrivacy::Private)],
        None,
    );
    session.observe_youtube_live("BROADCAST1", Some(StreamPrivacy::Public), at(3));
    assert_eq!(drain(&mut session, at(3), ok), vec![Request::Post]);
    assert_eq!(
        session.links()[0].url,
        "https://www.youtube.com/watch?v=BROADCAST1"
    );
}

#[test]
fn youtube_privacy_falls_back_to_the_draft_and_unknown_is_skipped() {
    let mut public_draft = AnnounceSession::new(
        "s1",
        at(0),
        vec![youtube_leg("yt", Some("abc"), StreamPrivacy::Public)],
        None,
    );
    public_draft.observe_youtube_live("abc", None, at(1));
    assert_eq!(public_draft.next_request(at(1)), Some(Request::Post));

    let mut unknown = AnnounceSession::new(
        "s1",
        at(0),
        vec![LegPlan {
            draft_privacy: None,
            ..youtube_leg("yt", Some("abc"), StreamPrivacy::Public)
        }],
        None,
    );
    unknown.observe_youtube_live("abc", None, at(1));
    assert_eq!(unknown.next_request(at(1)), None);
}

#[test]
fn two_youtube_legs_match_by_broadcast_id() {
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![
            youtube_leg("wide", Some("H"), StreamPrivacy::Public),
            LegPlan {
                label: "YouTube · Vertical".to_string(),
                ..youtube_leg("tall", Some("V"), StreamPrivacy::Public)
            },
        ],
        None,
    );
    session.observe_youtube_live("V", Some(StreamPrivacy::Public), at(1));
    assert_eq!(labels(&session), vec!["YouTube · Vertical"]);
    session.observe_youtube_live("other", Some(StreamPrivacy::Public), at(2));
    assert_eq!(labels(&session), vec!["YouTube · Vertical"]);
}

#[test]
fn a_stop_before_any_confirmation_posts_nothing() {
    use StreamTargetState::Live;
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![dwell_leg(
            "twitch",
            StreamPlatform::Twitch,
            "https://www.twitch.tv/a",
        )],
        None,
    );
    session.observe_targets(&snapshot("s1", &[("twitch", Live)]), at(0));
    session.end(at(5));
    session.tick(at(30));
    assert_eq!(session.next_request(at(30)), None);
    assert!(session.is_finished());
}

#[test]
fn a_stop_while_the_post_retries_never_posts_live_after_the_stop() {
    let mut session = AnnounceSession::new("s1", at(0), vec![x_leg("x")], None);
    session.observe_x_published("https://x.com/i/broadcasts/1", at(1));
    let request = session.next_request(at(1)).unwrap();
    assert_eq!(request, Request::Post);
    session.started(&request);
    session.end(at(20));
    // The announcer cancels the retrying post; it reports a failure.
    session.finished(Outcome::Failed, at(21));
    assert_eq!(session.next_request(at(21)), None);
    assert!(session.is_finished());
}

#[test]
fn a_post_that_lands_after_the_stop_is_ended_at_once() {
    let mut session = AnnounceSession::new("s1", at(0), vec![x_leg("x")], None);
    session.observe_x_published("https://x.com/i/broadcasts/1", at(1));
    let request = session.next_request(at(1)).unwrap();
    session.started(&request);
    session.end(at(20));
    session.finished(
        Outcome::Posted {
            message_id: "9".to_string(),
        },
        at(21),
    );
    assert_eq!(
        drain(&mut session, at(21), ok),
        vec![Request::Edit {
            message_id: "9".to_string(),
            ended: true,
            revive: false
        }]
    );
    assert!(session.is_finished());
}

#[test]
fn the_stop_sends_one_final_edit() {
    let mut session = AnnounceSession::new("s1", at(0), vec![x_leg("x")], None);
    session.observe_x_published("https://x.com/i/broadcasts/1", at(1));
    drain(&mut session, at(1), ok);
    session.end(at(6000));
    assert_eq!(
        drain(&mut session, at(6000), ok),
        vec![Request::Edit {
            message_id: "111".to_string(),
            ended: true,
            revive: false
        }]
    );
    assert!(session.is_finished());
}

#[test]
fn a_restart_revives_the_previous_message_instead_of_posting() {
    let mut session = AnnounceSession::new("s2", at(0), vec![x_leg("x")], Some("old".to_string()));
    session.observe_x_published("https://x.com/i/broadcasts/2", at(1));
    let sent = drain(&mut session, at(1), ok);
    assert_eq!(
        sent,
        vec![Request::Edit {
            message_id: "old".to_string(),
            ended: false,
            revive: true
        }]
    );
    assert_eq!(session.message_id(), Some("old"));
}

#[test]
fn a_revive_of_a_deleted_message_posts_fresh() {
    let mut session = AnnounceSession::new("s2", at(0), vec![x_leg("x")], Some("old".to_string()));
    session.observe_x_published("https://x.com/i/broadcasts/2", at(1));
    let sent = drain(&mut session, at(1), |request| match request {
        Request::Edit { revive: true, .. } => Outcome::MessageGone,
        other => ok(other),
    });
    assert_eq!(
        sent,
        vec![
            Request::Edit {
                message_id: "old".to_string(),
                ended: false,
                revive: true
            },
            Request::Post
        ]
    );
}

#[test]
fn a_deleted_message_stops_the_edits() {
    use StreamTargetState::Live;
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![
            x_leg("x"),
            dwell_leg("kick", StreamPlatform::Kick, "https://kick.com/a"),
        ],
        None,
    );
    session.observe_x_published("https://x.com/i/broadcasts/1", at(0));
    drain(&mut session, at(0), ok);
    session.observe_targets(&snapshot("s1", &[("kick", Live)]), at(1));
    session.tick(at(11));
    let sent = drain(&mut session, at(13), |_| Outcome::MessageGone);
    assert_eq!(sent.len(), 1);
    session.end(at(20));
    assert_eq!(session.next_request(at(20)), None);
    assert!(session.is_finished());
}

#[test]
fn a_failed_post_abandons_the_session() {
    let mut session = AnnounceSession::new("s1", at(0), vec![x_leg("x")], None);
    session.observe_x_published("https://x.com/i/broadcasts/1", at(0));
    let sent = drain(&mut session, at(0), |_| Outcome::Failed);
    assert_eq!(sent, vec![Request::Post]);
    session.end(at(10));
    assert!(session.is_finished());
}

#[test]
fn an_x_share_link_must_be_https() {
    let mut session = AnnounceSession::new("s1", at(0), vec![x_leg("x")], None);
    session.observe_x_published("javascript:alert(1)", at(0));
    assert_eq!(session.next_request(at(0)), None);
}

#[test]
fn a_typed_link_wins_over_the_confirmed_one() {
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![LegPlan {
            link: Some("https://x.com/orcdev".to_string()),
            link_typed: true,
            ..x_leg("x")
        }],
        None,
    );
    session.observe_x_published("https://x.com/i/broadcasts/1", at(0));
    assert_eq!(session.links()[0].url, "https://x.com/orcdev");
}

#[test]
fn snapshots_for_another_session_are_ignored() {
    use StreamTargetState::Live;
    let mut session = AnnounceSession::new(
        "s1",
        at(0),
        vec![dwell_leg(
            "twitch",
            StreamPlatform::Twitch,
            "https://www.twitch.tv/a",
        )],
        None,
    );
    session.observe_targets(&snapshot("other", &[("twitch", Live)]), at(0));
    session.tick(at(30));
    assert_eq!(session.next_request(at(30)), None);
}
